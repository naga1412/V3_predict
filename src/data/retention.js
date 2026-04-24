/**
 * My Next Prediction v3.0 — Retention policies
 * --------------------------------------------
 * Per-store retention rules + daily sweeper. Keeps IDB hot-tier lean by
 * - moving old candles to OPFS cold shards
 * - deleting expired features / predictions / news
 * - honouring a hard quota budget (evict oldest cold shards when over)
 *
 * Scenarios:
 *   - #34 cap storage usage so users don't fill their disk
 *   - #41 1m candles: 30d hot, rest cold (unlimited)
 *   - #42 4h/1d candles: 5y hot
 *   - #53 predictions: 1y hot, then drop
 *   - #54 news: 30d total
 *   - #72 quota-over event: LRU-evict oldest cold shards first
 */

import * as IDB from "./idb.js";
import * as Shard from "./shardWriter.js";
import * as OPFS from "./opfs.js";

const DAY = 86_400_000;

/** Default policies — tweakable per-user later. */
export const POLICIES = {
  candles: {
    // per-TF hot window (IDB); anything older rolls to OPFS shards.
    hotByTf: {
      "1m":  30  * DAY,   // 30 days
      "5m":  90  * DAY,   // 90 days
      "15m": 180 * DAY,
      "1h":  2   * 365 * DAY,   // 2y
      "4h":  5   * 365 * DAY,   // 5y
      "1d":  10  * 365 * DAY,   // 10y
    },
    // cold retention is effectively unbounded except for the quota cap.
  },
  features:    { ttlMs: 90  * DAY },
  predictions: { ttlMs: 365 * DAY },
  validations: { ttlMs: 365 * DAY },
  trainingPool:{ ttlMs: 365 * DAY },
  regimes:     { ttlMs: 365 * DAY },
  newsCache:   { ttlMs: 30  * DAY },
  // Hard cap on total OPFS usage (bytes). When crossed, evict oldest shards.
  maxOPFSBytes: 1.5 * 1024 * 1024 * 1024, // 1.5 GB default; user can raise.
};

/** Delete items in `store` where the keyPath timestamp < cutoff. */
async function purgeOlderThan(store, cutoffMs, tsField = "t") {
  // We iterate with a cursor for memory safety on large stores. The cursor
  // lives inside withStore's tx, which resolves on tx.oncomplete.
  return IDB.withStore(store, "readwrite", (s) => new Promise((resolve, reject) => {
    let removed = 0;
    const req = s.openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { resolve(removed); return; }
      const v = cur.value;
      const t = v?.[tsField] ?? v?.t ?? v?.ts ?? v?.createdAt;
      if (typeof t === "number" && t < cutoffMs) {
        cur.delete();
        removed++;
      }
      cur.continue();
    };
  }));
}

/** Move candles older than hot window to OPFS shards, then delete from IDB. */
export async function rollCandlesToCold({ symbol, tf, now = Date.now() } = {}) {
  const window = POLICIES.candles.hotByTf[tf] ?? (30 * DAY);
  const cutoff = now - window;
  // Pull the stale window from IDB.  candles has a composite primary key
  // [symbol, tf, t], so we scan with a bound IDBKeyRange.
  const range = IDBKeyRange.bound([symbol, tf, 0], [symbol, tf, cutoff], false, false);
  const stale = await IDB.rangeByKey("candles", range);
  if (!stale.length) return { rolled: 0, shards: 0 };
  const shardMetas = await Shard.writeCandles({ symbol, tf, candles: stale });
  // Verify shards are readable before deleting from IDB.
  let verified = 0;
  for (const m of shardMetas) {
    const r = await Shard.readDayShard({ symbol, tf, day: m.day });
    if (r) verified++;
  }
  if (verified !== shardMetas.length) {
    console.warn("[retention] shard verification failed — leaving IDB intact", { verified, expected: shardMetas.length });
    return { rolled: 0, shards: shardMetas.length, verified };
  }
  // All shards verified — safe to delete from IDB.
  const removed = await purgeOlderThan("candles", cutoff, "t");
  return { rolled: removed, shards: shardMetas.length, verified };
}

/** Full retention sweep across all stores + OPFS quota enforcement. */
export async function sweep({ now = Date.now(), symbols = [], tfs = [] } = {}) {
  const report = { now, ran: [], errors: [] };

  // 1. TTL-based IDB purge for non-candle stores.
  for (const [store, cfg] of Object.entries(POLICIES)) {
    if (store === "candles" || store === "maxOPFSBytes") continue;
    try {
      const removed = await purgeOlderThan(store, now - cfg.ttlMs, "ts");
      report.ran.push({ store, removed, cutoff: now - cfg.ttlMs });
    } catch (err) {
      report.errors.push({ store, err: String(err?.message || err) });
    }
  }

  // 2. Candle rollover for each (symbol, tf).
  for (const symbol of symbols) for (const tf of tfs) {
    try {
      const r = await rollCandlesToCold({ symbol, tf, now });
      if (r.rolled || r.shards) report.ran.push({ store: "candles", symbol, tf, ...r });
    } catch (err) {
      report.errors.push({ store: "candles", symbol, tf, err: String(err?.message || err) });
    }
  }

  // 3. OPFS quota enforcement — LRU by shard day (oldest first).
  try {
    const total = await OPFS.sizeOf();
    report.ran.push({ store: "opfs", size: total, cap: POLICIES.maxOPFSBytes });
    if (total > POLICIES.maxOPFSBytes) {
      const evicted = await evictOldestShards(total - POLICIES.maxOPFSBytes);
      report.ran.push({ store: "opfs", evicted });
    }
  } catch (err) {
    report.errors.push({ store: "opfs", err: String(err?.message || err) });
  }

  return report;
}

/** Evict shards (oldest first) until we free at least `bytesTarget` bytes. */
export async function evictOldestShards(bytesTarget) {
  const idx = (await IDB.metaGet("shardIndex")) || {};
  const shards = Object.values(idx).sort((a, b) => a.day.localeCompare(b.day));
  let freed = 0;
  let count = 0;
  for (const s of shards) {
    if (freed >= bytesTarget) break;
    await Shard.deleteShard({ symbol: s.symbol, tf: s.tf, day: s.day });
    freed += s.size || 0;
    count++;
  }
  return { freed, count };
}

/** Start a daily sweeper (and run one immediately). */
let _timer = null;
export function startSweeper({ symbols = [], tfs = [], intervalMs = DAY } = {}) {
  stopSweeper();
  const tick = async () => {
    try { await sweep({ symbols, tfs }); }
    catch (err) { console.warn("[retention] sweep failed", err); }
  };
  tick();
  _timer = setInterval(tick, intervalMs);
  return () => stopSweeper();
}
export function stopSweeper() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/**
 * My Next Prediction v3.0 — Storage Manager (tiered reads)
 * --------------------------------------------------------
 * Unified candle reader: hot tier (IDB) + cold tier (OPFS shards).
 *
 *   getRange({symbol, tf, fromMs, toMs})
 *     → merges candles from both tiers, dedups by t, sorts ascending.
 *   putCandles({symbol, tf, candles})
 *     → writes to IDB (hot); retention rolls stale to cold later.
 *   stats({symbol, tf})
 *     → {hotCount, coldShards, coldBytes, hotBytes?}
 *
 * Why merge instead of "hot OR cold"?  The hot/cold boundary isn't perfectly
 * aligned with the day grain — a range query at the boundary would lose
 * candles if we chose one tier.
 */

import * as IDB from "./idb.js";
import * as Shard from "./shardWriter.js";
import { EventBus } from "../core/bus.js";

/** Read a candle range from both tiers, merged & deduplicated. */
export async function getRange({ symbol, tf, fromMs, toMs, onCorrupt }) {
  const [hot, cold] = await Promise.all([
    IDB.rangeByKey(
      "candles",
      IDBKeyRange.bound([symbol, tf, fromMs], [symbol, tf, toMs], false, false),
    ),
    Shard.readRange({ symbol, tf, fromMs, toMs, onCorrupt }),
  ]);
  return dedupeSort([...cold, ...hot]);
}

function dedupeSort(arr) {
  const map = new Map();
  for (const c of arr) map.set(c.t, c);        // hot wins by iteration order above
  return [...map.values()].sort((a, b) => a.t - b.t);
}

/** Put candles into the hot tier (IDB). */
export async function putCandles({ symbol, tf, candles }) {
  if (!candles?.length) return 0;
  const rows = candles.map((c) => ({
    symbol, tf,
    t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
    closed: c.closed !== false,
  }));
  try {
    return await IDB.putMany("candles", rows);
  } catch (err) {
    IDB.handleQuotaError(err);
    throw err;
  }
}

/** How many (symbol,tf) candles are in the hot tier. */
export async function hotCount({ symbol, tf }) {
  const rows = await IDB.rangeByKey(
    "candles",
    IDBKeyRange.bound([symbol, tf, 0], [symbol, tf, Number.MAX_SAFE_INTEGER], false, false),
    { limit: Infinity },
  );
  return rows.length;
}

/** Per-(symbol,tf) stats across both tiers. */
export async function stats({ symbol, tf }) {
  const [hc, shards] = await Promise.all([
    hotCount({ symbol, tf }),
    Shard.listShards(symbol, tf),
  ]);
  const coldCount = shards.reduce((a, s) => a + (s.count || 0), 0);
  const coldBytes = shards.reduce((a, s) => a + (s.size  || 0), 0);
  return { symbol, tf, hotCount: hc, coldShards: shards.length, coldCount, coldBytes };
}

/** Estimate global browser storage usage & quota (wrapper). */
export async function globalQuota() {
  if (!navigator?.storage?.estimate) return { usage: 0, quota: 0, ratio: 0 };
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota, ratio: quota ? usage / quota : 0 };
}

/** Hook for high-level UI: emits `storage:stats` periodically. */
let _tick = null;
export function startMonitor({ intervalMs = 30_000 } = {}) {
  stopMonitor();
  const fire = async () => {
    try {
      const q = await globalQuota();
      EventBus.emit("storage:stats", q);
      if (q.ratio > 0.9) EventBus.emit("storage:near-quota", q);
    } catch {}
  };
  fire();
  _tick = setInterval(fire, intervalMs);
  return () => stopMonitor();
}
export function stopMonitor() { if (_tick) { clearInterval(_tick); _tick = null; } }

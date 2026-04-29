/**
 * My Next Prediction v3.0 — M-SCAN · Background Scanner
 * -----------------------------------------------------
 * Walks a universe of symbols (crypto / stocks / FX / indices),
 * fetches recent candles, runs the full TA → orchestrator → meta-brain
 * pipeline on each, and persists the verdict in IDB store `scanResults`.
 *
 *   runScan({ assetClass, tf, limit, concurrency })
 *     → { rows: [{symbol, type, last, direction, bias, prob, brain, ...}], ts }
 *
 *   latestResults({ assetClass, tf, limit, sortBy })
 *     → array of saved rows from IDB, ranked.
 *
 * Bus events:
 *   scan:start    {assetClass, tf, total}
 *   scan:progress {done, total, last}
 *   scan:done     {count, ts, ms}
 *   scan:error    {symbol, err}
 *
 * Throttled with concurrent workers + per-call yield.  Re-entrant calls
 * are deduped via an in-flight singleton keyed on (assetClass, tf).
 */

import { EventBus } from "../core/bus.js";
import { searchUniverse, getSymbol, listUniverse } from "../data/universe.js";
import { ensureRecent } from "../data/gapFiller.js";
import { getStored as idbGetStored } from "../data/gapFiller.js";
import { withStore, put, req2promise } from "../data/idb.js";
import { getExchange, chain as cryptoChain, nonCryptoChain } from "../data/exchanges/index.js";

const STORE = "scanResults";

const _inflight = new Map(); // key: `${assetClass}|${tf}`
const _state = { lastRunAt: 0, lastTf: null, lastClass: null };

/* ──────────────────────── Public API ──────────────────────── */

/**
 * Run a scan over the universe.
 *
 * @param {object} opts
 * @param {"all"|"crypto"|"stock"|"etf"|"forex"|"commodity"|"index"} opts.assetClass
 * @param {string} opts.tf            timeframe like "1h"
 * @param {number} opts.limit         max symbols to scan (default 30)
 * @param {number} opts.concurrency   parallel workers (default 4)
 * @returns {Promise<{rows: Array, ts: number, ms: number}>}
 */
export async function runScan({
  assetClass = "crypto",
  tf = "1h",
  limit = 30,
  concurrency = 4,
} = {}) {
  const key = `${assetClass}|${tf}`;
  if (_inflight.has(key)) return _inflight.get(key);
  const promise = (async () => {
    const t0 = Date.now();
    let universe;
    if (assetClass === "crypto") {
      // Only USDT-M perpetual futures — what an active trader actually
      // wants.  Filters out spot, BTC-quoted altcoins, coin-margined
      // contracts, and stable-stable pairs.
      universe = listUniverse().filter((e) =>
        e.type === "crypto" &&
        e.category === "futures-linear" &&
        e.quote === "USDT"
      );
      // Rank by alphabetical so the top-N is stable; popular pairs
      // (BTC/ETH/SOL) naturally float to the top of an alpha sort.
      universe.sort((a, b) => a.id.localeCompare(b.id));
    } else if (assetClass === "all") {
      universe = searchUniverse("", "all", limit * 4);
    } else {
      universe = searchUniverse("", assetClass, limit * 2);
    }
    const symbols = universe.slice(0, limit);

    EventBus.emit("scan:start", { assetClass, tf, total: symbols.length });

    const rows = [];
    let done = 0;
    const queue = symbols.slice();

    async function worker() {
      while (queue.length) {
        const e = queue.shift();
        if (!e) return;
        try {
          const r = await scanOne(e, tf);
          if (r) rows.push(r);
        } catch (err) {
          EventBus.emit("scan:error", { symbol: e.id, err: String(err?.message || err) });
        }
        done++;
        EventBus.emit("scan:progress", {
          done, total: symbols.length,
          last: rows[rows.length - 1] || null,
        });
        await new Promise((r) => setTimeout(r, 8)); // micro-yield
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    rankRows(rows);

    const ts = Date.now();
    for (const r of rows) {
      try { await put(STORE, { ...r, scannedAt: ts, tf }); } catch {}
    }

    const ms = ts - t0;
    _state.lastRunAt = ts;
    _state.lastTf = tf;
    _state.lastClass = assetClass;
    EventBus.emit("scan:done", { count: rows.length, ts, ms, assetClass, tf });
    return { rows, ts, ms };
  })().finally(() => _inflight.delete(key));

  _inflight.set(key, promise);
  return promise;
}

/** Read the latest persisted results, optionally filtered by class+tf. */
export async function latestResults({ assetClass = "all", tf = null, limit = 50 } = {}) {
  return withStore(STORE, "readonly", async (s) => {
    const all = await req2promise(s.getAll());
    let out = all;
    if (tf) out = out.filter((r) => r.tf === tf);
    if (assetClass && assetClass !== "all") out = out.filter((r) => r.assetType === assetClass);
    rankRows(out);
    return out.slice(0, limit);
  });
}

/** Scan state for the UI status badge. */
export function status() {
  return {
    running: _inflight.size > 0,
    lastRunAt: _state.lastRunAt,
    lastTf: _state.lastTf,
    lastClass: _state.lastClass,
  };
}

/** Test helper — wipe scanResults. */
export async function _resetForTests() {
  return withStore(STORE, "readwrite", async (s) => req2promise(s.clear()));
}

/* ──────────────────────── Internals ──────────────────────── */

async function scanOne(entry, tf) {
  const M = (typeof window !== "undefined") ? window.__MNP__ : null;
  if (!M) throw new Error("MNP not ready");

  // Resolve exchange adapter — fall back to first in chain by asset type.
  const chain = (entry.type === "crypto") ? cryptoChain : nonCryptoChain;
  const exchange = (entry.exchange && getExchange(entry.exchange)) || chain[0];
  if (!exchange) throw new Error("no-exchange");

  const wireSym = entry.wsSym || entry.yahooSym || entry.id;
  const lookbackMs = lookbackFor(tf);

  // Backfill into IDB (idempotent — fast on subsequent runs).
  await ensureRecent({
    exchange, symbol: entry.id, tf, wireSymbol: wireSym, lookbackMs,
  });

  // Read the tail.  Need ≥ 50 bars for TA to be meaningful.
  const candles = await idbGetStored({ symbol: entry.id, tf, limit: 300 });
  if (!Array.isArray(candles) || candles.length < 50) {
    return {
      symbol: entry.id, assetType: entry.type, name: entry.name || null,
      status: "no-data", n: candles?.length || 0,
      bias: 0, absBias: 0, scannedAt: Date.now(), tf,
    };
  }

  // TA → orchestrator
  const ta = M.TAEngine?.compute ? M.TAEngine.compute(candles) : null;
  if (!ta) throw new Error("no-ta");
  const orch = M.Orchestrator?.runModules ? M.Orchestrator.runModules(ta, {}) : null;
  if (!orch) throw new Error("no-orch");

  // Meta-Brain decision (uses orchFallback when no model is trained).
  let brain = null;
  try {
    if (M.MetaBrain?.aggregate && M.MetaBrain?.decide) {
      const v = M.MetaBrain.aggregate({
        symbol: entry.id, tf, t: Date.now(),
        orch, ta,
        regime:  ta.regime,  wyckoff: ta.wyckoff,
        macro: null, deriv: null, stability: null, adaptive: null,
      });
      const d = await M.MetaBrain.decide(v, { orchFallback: orch });
      brain = {
        used: d.used, direction: d.direction,
        prob: d.probability, score: d.rawScore,
        version: d.modelVersion || null,
      };
    }
  } catch { /* keep brain=null on any failure */ }

  const close = ta.close;
  const last = close?.[close.length - 1] ?? null;
  const dir  = brain?.direction || orch.direction;
  const bias = brain?.score    ?? orch.rawScore;
  const prob = brain?.prob     ?? orch.probability;
  const conf = orch.confidence ?? null;
  const atr  = pickLast(ta.atr14);

  return {
    symbol: entry.id, assetType: entry.type, name: entry.name || null,
    last, atr,
    direction: dir,
    bias: numOrZero(bias),
    absBias: Math.abs(numOrZero(bias)),
    prob: numOrZero(prob),
    confidence: numOrZero(conf),
    trend: ta.trend || null,
    candles: candles.length,
    brain,
    status: "ok",
    scannedAt: Date.now(),
    tf,
  };
}

function rankRows(rows) {
  // Sort descending by |bias| × confidence × prob — strongest signals first.
  rows.sort((a, b) => {
    const aScore = (a.absBias || 0) * (a.confidence || 0.5) * (a.prob || 0.5);
    const bScore = (b.absBias || 0) * (b.confidence || 0.5) * (b.prob || 0.5);
    return bScore - aScore;
  });
}

function lookbackFor(tf) {
  const M = 60_000;
  if (tf === "1m")  return  4 * 60 * M;
  if (tf === "5m")  return 24 * 60 * M;
  if (tf === "15m") return  3 * 24 * 60 * M;
  if (tf === "1h")  return 30 * 24 * 60 * M;
  if (tf === "4h")  return 90 * 24 * 60 * M;
  if (tf === "1d")  return 365 * 24 * 60 * M;
  return 30 * 24 * 60 * M;
}

function pickLast(arr) {
  if (!Array.isArray(arr)) return Number.isFinite(arr) ? arr : null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return null;
}

function numOrZero(v) {
  return Number.isFinite(v) ? v : 0;
}

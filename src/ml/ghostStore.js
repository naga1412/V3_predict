/**
 * My Next Prediction v3.0 — Phase 11 · Ghost-candle persistence + resolution
 * --------------------------------------------------------------------------
 * IDB-backed facade over the `ghosts` object store.  The store captures
 * every forward-projected forecast emitted by `predictGhostCandles` and —
 * once the corresponding real candles close — records a per-bar verdict
 * (coverage of the ±band, absolute path error, direction hit, width).
 *
 * Row shape:
 *   {
 *     id:            <auto>,
 *     symbol:        "BTCUSDT",
 *     tf:            "1h",
 *     anchorTime:    utcSec,   // close-time of the last REAL candle
 *     anchorClose:   number,
 *     tfSec:         number,
 *     nBars:         number,   // originally requested horizon
 *     horizon:       number,   // bars actually stored (== bars.length)
 *     alpha:         number,   // target miscoverage
 *     lambda:        number,
 *     bias:          number,
 *     direction:     -1|0|+1,
 *     confidence:    number,
 *     usedConformal: boolean,
 *     atr:           number,
 *     bars:          [{ time, o, h, l, c, lo, hi, width }, …],
 *     resolved:      0|1,
 *     resolvedN:     number,   // how many bars have realized candles
 *     resolvedAt:    ms|null,
 *     verdict:       null | {
 *       n, covered, coverage,
 *       absErrorMean, absErrorFinal,
 *       widthMean, widthFinal,
 *       directionHit,    // +1 if final realized close moved same direction
 *                        //  as ghost bias, -1 if opposite, 0 if flat
 *       perBar: [{ covered, absError, realizedClose, realizedDir }, …],
 *     },
 *     version:       string,
 *     meta:          object,
 *     createdAt:     ms,
 *   }
 *
 * Persistence is keyed by `(symbol, tf, anchorTime)` via the
 * `by_anchor` unique index so a later forecast for the same anchor
 * overwrites the earlier one (prevents store bloat in fast polling loops).
 */

import {
  withStore,
  put,
  get,
  del,
  req2promise,
} from "../data/idb.js";

const STORE = "ghosts";

/* ═══════════════════════════ Normalizers ═══════════════════════════ */

function normalizeBar(b) {
  if (!b || typeof b !== "object") throw new Error("ghostStore: bar required");
  const num = (v) => (Number.isFinite(v) ? +v : null);
  const out = {
    time:  num(b.time),
    o:     num(b.o),
    h:     num(b.h),
    l:     num(b.l),
    c:     num(b.c),
    lo:    num(b.lo),
    hi:    num(b.hi),
    width: Number.isFinite(b.width) ? +b.width : (Number.isFinite(b.hi) && Number.isFinite(b.lo) ? b.hi - b.lo : null),
  };
  if (!Number.isFinite(out.time)) throw new Error("ghostStore: bar.time required");
  return out;
}

/**
 * Turn a GhostForecast (from ghostCandles.js) into a persistable row.
 * The caller supplies (symbol, tf); everything else comes from the forecast.
 */
export function forecastToRow(forecast, { symbol, tf, version = "phase11-1", meta = {} } = {}) {
  if (!forecast || typeof forecast !== "object") {
    throw new Error("ghostStore: forecast required");
  }
  if (!symbol || typeof symbol !== "string") throw new Error("ghostStore: symbol required");
  if (!tf || typeof tf !== "string")         throw new Error("ghostStore: tf required");
  if (!Array.isArray(forecast.bars) || forecast.bars.length === 0) {
    throw new Error("ghostStore: forecast.bars must be non-empty");
  }
  if (!Number.isFinite(forecast.anchorTime)) {
    throw new Error("ghostStore: forecast.anchorTime required");
  }
  const bars = forecast.bars.map(normalizeBar);
  return {
    symbol,
    tf,
    anchorTime:    forecast.anchorTime | 0,
    anchorClose:   Number.isFinite(forecast.anchorClose) ? +forecast.anchorClose : null,
    tfSec:         Number.isFinite(forecast.tfSec) ? forecast.tfSec | 0 : 60,
    nBars:         bars.length,
    horizon:       bars.length,
    alpha:         Number.isFinite(forecast.alpha)  ? +forecast.alpha  : 0.1,
    lambda:        Number.isFinite(forecast.lambda) ? +forecast.lambda : 0.18,
    bias:          Number.isFinite(forecast.bias) ? +forecast.bias : 0,
    direction:     forecast.direction === 1 || forecast.direction === -1 ? forecast.direction : 0,
    confidence:    Number.isFinite(forecast.confidence) ? +forecast.confidence : 0,
    usedConformal: !!forecast.usedConformal,
    atr:           Number.isFinite(forecast.atr) ? +forecast.atr : null,
    bars,
    resolved:      0,
    resolvedN:     0,
    resolvedAt:    null,
    verdict:       null,
    version,
    meta:          meta && typeof meta === "object" ? meta : {},
    createdAt:     Date.now(),
  };
}

/* ═══════════════════════════ CRUD ═══════════════════════════ */

/**
 * Save a ghost forecast. If a row already exists for
 * `(symbol, tf, anchorTime)` it is overwritten in-place so callers don't
 * accumulate duplicates when the engine recomputes mid-bar.
 * @returns {Promise<number>} row id
 */
export async function saveGhost(row) {
  if (!row || !row.symbol || !row.tf || !Number.isFinite(row.anchorTime)) {
    throw new Error("ghostStore.saveGhost: symbol/tf/anchorTime required");
  }
  // Find an existing row for this anchor (via by_anchor index) and reuse its id.
  const existing = await findByAnchor(row.symbol, row.tf, row.anchorTime);
  const toSave = { ...row };
  if (existing && existing.id != null) toSave.id = existing.id;
  return put(STORE, toSave);
}

/** Persist a forecast produced by `predictGhostCandles`. */
export async function saveForecast(forecast, opts = {}) {
  const row = forecastToRow(forecast, opts);
  return saveGhost(row);
}

/** Load one ghost row by primary key. */
export async function loadGhost(id) { return get(STORE, id); }

/** Delete one ghost row. */
export async function deleteGhost(id) { return del(STORE, id); }

/** Row count. */
export async function countGhosts() {
  return withStore(STORE, "readonly", (s) => req2promise(s.count()));
}

/** Raw list (use sparingly). */
export async function listAllGhosts() {
  return withStore(STORE, "readonly", (s) => req2promise(s.getAll()));
}

/**
 * Find a row for a specific anchor, or null.  Uses the unique `by_anchor`
 * index so this is O(log n) rather than O(n).
 */
export async function findByAnchor(symbol, tf, anchorTime) {
  return withStore(STORE, "readonly", (s) => {
    if (!s.indexNames.contains("by_anchor")) {
      // Fallback for test DBs built without indexes — linear scan.
      return req2promise(s.getAll()).then((rows) =>
        rows.find((r) => r.symbol === symbol && r.tf === tf && r.anchorTime === anchorTime) || null
      );
    }
    const idx = s.index("by_anchor");
    return req2promise(idx.get([symbol, tf, anchorTime]));
  });
}

/**
 * List rows matching a filter. All fields optional and AND-ed.
 * @param {{symbol?:string, tf?:string, resolved?:0|1|boolean, version?:string}} filter
 */
export async function listGhosts(filter = {}) {
  const rows = await listAllGhosts();
  return rows.filter((r) => {
    if (filter.symbol  != null && r.symbol  !== filter.symbol)  return false;
    if (filter.tf      != null && r.tf      !== filter.tf)      return false;
    if (filter.version != null && r.version !== filter.version) return false;
    if (filter.resolved != null) {
      const want = filter.resolved ? 1 : 0;
      if ((r.resolved ? 1 : 0) !== want) return false;
    }
    return true;
  });
}

/**
 * Return all *pending* ghosts whose projection endpoint is ≤ nowSec — i.e.
 * at least one bar in their horizon should have a realized candle by now.
 * `nowSec` is UTC-seconds (matches `ghostCandles.js` time units).
 */
export async function pendingGhosts({ nowSec = Math.floor(Date.now() / 1000), symbol, tf } = {}) {
  const rows = await listAllGhosts();
  return rows.filter((r) => {
    if (r.resolved) return false;
    if (symbol != null && r.symbol !== symbol) return false;
    if (tf     != null && r.tf     !== tf)     return false;
    if (!Array.isArray(r.bars) || !r.bars.length) return false;
    // At least the FIRST ghost bar's target time has passed
    return Number.isFinite(r.bars[0].time) && r.bars[0].time <= nowSec;
  });
}

/** Most-recent ghost for (symbol, tf), or null. */
export async function latestGhost({ symbol, tf } = {}) {
  const rows = await listGhosts({ symbol, tf });
  if (!rows.length) return null;
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows[0];
}

/** Clear all rows. */
export async function clearAll() {
  return withStore(STORE, "readwrite", (s) => req2promise(s.clear()));
}

/* ═══════════════════════════ Resolution / grading ═══════════════════════════ */

/**
 * Grade a persisted ghost row against a set of realized candles.  Pure —
 * does NOT write to IDB.  The caller decides whether the verdict is final
 * (writes via `markResolved`) or interim (writes via `updateResolution`).
 *
 * Match strategy: for each ghost bar we look up the realized candle whose
 * `time` is within ±tfSec/2 of the ghost bar's projected time.  The lookup
 * is provided by the caller so this module stays IDB-free.
 *
 * @param {object} ghost   Persisted ghost row
 * @param {(tSec:number) => object|null} candleLookup   Returns canonical
 *   OHLCV (ms `t` or sec `time`) or null if the bar is not yet available.
 * @returns {{
 *   verdict: object,
 *   resolvedN: number,
 *   fullyResolved: boolean,
 * }}
 */
export function gradeGhost(ghost, candleLookup) {
  if (!ghost || !Array.isArray(ghost.bars) || !ghost.bars.length) {
    throw new Error("gradeGhost: ghost row with bars required");
  }
  if (typeof candleLookup !== "function") {
    throw new Error("gradeGhost: candleLookup function required");
  }
  const tfSec = Number.isFinite(ghost.tfSec) ? ghost.tfSec : 60;
  const halfTF = Math.max(1, tfSec / 2);
  const perBar = new Array(ghost.bars.length);
  let coveredN = 0;
  let realizedN = 0;
  let sumAbs = 0;
  let sumWidth = 0;
  let lastRealizedClose = null;

  for (let i = 0; i < ghost.bars.length; i++) {
    const g = ghost.bars[i];
    const rc = candleLookup(g.time);
    if (!rc) { perBar[i] = null; continue; }
    const rClose = Number(rc.c ?? rc.close);
    if (!Number.isFinite(rClose)) { perBar[i] = null; continue; }
    const absError = Math.abs(rClose - g.c);
    const covered = rClose >= g.lo && rClose <= g.hi;
    const realizedDir = (() => {
      const o = Number(rc.o ?? rc.open);
      if (!Number.isFinite(o) || !Number.isFinite(rClose)) return "flat";
      return rClose > o ? "up" : rClose < o ? "down" : "flat";
    })();
    perBar[i] = { covered, absError, realizedClose: rClose, realizedDir };
    realizedN++;
    if (covered) coveredN++;
    sumAbs += absError;
    sumWidth += Number.isFinite(g.width) ? g.width : Math.max(0, g.hi - g.lo);
    lastRealizedClose = rClose;
  }

  const fullyResolved = realizedN === ghost.bars.length;

  // Direction-hit: compare realized move against ghost bias direction
  let directionHit = 0;
  if (Number.isFinite(lastRealizedClose) && Number.isFinite(ghost.anchorClose)) {
    const realDelta = lastRealizedClose - ghost.anchorClose;
    const ghostDir = ghost.direction || (ghost.bias > 0 ? 1 : ghost.bias < 0 ? -1 : 0);
    if (ghostDir === 0) directionHit = 0;
    else if (Math.sign(realDelta) === Math.sign(ghostDir)) directionHit = 1;
    else if (realDelta === 0) directionHit = 0;
    else directionHit = -1;
  }

  const finalBar = ghost.bars[ghost.bars.length - 1];
  const finalPB = perBar[perBar.length - 1];

  const verdict = {
    n:             realizedN,
    covered:       coveredN,
    coverage:      realizedN > 0 ? coveredN / realizedN : null,
    absErrorMean:  realizedN > 0 ? sumAbs / realizedN : null,
    absErrorFinal: finalPB ? finalPB.absError : null,
    widthMean:     realizedN > 0 ? sumWidth / realizedN : null,
    widthFinal:    Number.isFinite(finalBar?.width) ? finalBar.width : null,
    directionHit,
    perBar,
  };

  return { verdict, resolvedN: realizedN, fullyResolved };
}

/**
 * Mutate an existing ghost row with a grading result and persist.  Used
 * while the horizon is still unfolding — stores the interim verdict but
 * keeps `resolved=0` until `fullyResolved` is true.
 */
export async function updateResolution(id, { verdict, resolvedN, fullyResolved }) {
  if (!Number.isFinite(id)) throw new Error("updateResolution: id required");
  if (!verdict || typeof verdict !== "object") {
    throw new Error("updateResolution: verdict object required");
  }
  const row = await loadGhost(id);
  if (!row) return null;
  row.verdict = verdict;
  row.resolvedN = resolvedN | 0;
  if (fullyResolved) {
    row.resolved = 1;
    row.resolvedAt = Date.now();
  }
  await put(STORE, row);
  return row;
}

/**
 * Resolve all ghosts that have at least one realized candle.  Calls the
 * caller's `candleLookup` for each ghost bar time.  For each ghost that
 * receives *any* new graded bar we:
 *
 *   1. Call `gradeGhost` to produce the verdict.
 *   2. Persist via `updateResolution`.
 *   3. Optionally emit events on the provided `bus`:
 *      - `ghost:resolved`  — on each update
 *      - `ghost:verdict`   — when `fullyResolved` flips to true
 *
 * Returns a summary `{ graded, fullyResolved, untouched }`.
 *
 * @param {object} opts
 * @param {(tSec:number, row:object) => (object|null|Promise<object|null>)} opts.candleLookup
 * @param {{emit?: Function}} [opts.bus]
 * @param {number} [opts.nowSec]  filter to only grade rows whose first bar is due
 */
export async function resolveGhosts(opts = {}) {
  const { candleLookup, bus, nowSec = Math.floor(Date.now() / 1000) } = opts;
  if (typeof candleLookup !== "function") {
    throw new Error("resolveGhosts: candleLookup function required");
  }
  const due = await pendingGhosts({ nowSec });
  let graded = 0, fullyResolved = 0, untouched = 0, errors = 0;

  for (const row of due) {
    try {
      // Wrap the lookup so it can return a promise and still feed gradeGhost
      // (gradeGhost is sync — so we pre-resolve all bar times in parallel).
      const resolved = await Promise.all(
        row.bars.map((b) => Promise.resolve(candleLookup(b.time, row)).catch(() => null))
      );
      const lookup = (t) => {
        const idx = row.bars.findIndex((b) => b.time === t);
        return idx >= 0 ? resolved[idx] : null;
      };
      const r = gradeGhost(row, lookup);
      if (r.resolvedN === 0 || r.resolvedN === row.resolvedN) {
        untouched++;
        continue;
      }
      const updated = await updateResolution(row.id, r);
      graded++;
      if (r.fullyResolved) fullyResolved++;
      if (bus && typeof bus.emit === "function") {
        try {
          bus.emit("ghost:resolved", {
            id: row.id,
            symbol: row.symbol,
            tf: row.tf,
            anchorTime: row.anchorTime,
            resolvedN: r.resolvedN,
            verdict: r.verdict,
          });
          if (r.fullyResolved) {
            bus.emit("ghost:verdict", {
              id: row.id,
              symbol: row.symbol,
              tf: row.tf,
              anchorTime: row.anchorTime,
              verdict: r.verdict,
              usedConformal: row.usedConformal,
              alpha: row.alpha,
            });
          }
        } catch { /* swallow listener errors */ }
      }
    } catch (err) {
      errors++;
      if (bus && typeof bus.emit === "function") {
        try { bus.emit("ghost:error", { id: row?.id, error: err?.message || String(err) }); } catch {}
      }
    }
  }

  return { graded, fullyResolved, untouched, errors, dueN: due.length };
}

/* ═══════════════════════════ Aggregation ═══════════════════════════ */

/**
 * Roll resolved ghost verdicts into a compact KPI object.  Useful for the
 * validator UI / drift sidebar.  Returns null if no resolved rows exist.
 *
 * @param {{symbol?:string, tf?:string}} filter
 */
export async function summarizeResolved(filter = {}) {
  const rows = await listGhosts({ ...filter, resolved: 1 });
  if (!rows.length) return null;
  let n = 0, covN = 0, sumAbsFinal = 0, sumAbsMean = 0;
  let sumWidthFinal = 0, dirHits = 0, dirTotal = 0;
  for (const r of rows) {
    const v = r.verdict;
    if (!v) continue;
    n++;
    if (Number.isFinite(v.coverage)) covN += (v.covered || 0);
    if (Number.isFinite(v.absErrorFinal)) sumAbsFinal += v.absErrorFinal;
    if (Number.isFinite(v.absErrorMean))  sumAbsMean  += v.absErrorMean;
    if (Number.isFinite(v.widthFinal))    sumWidthFinal += v.widthFinal;
    if (v.directionHit === 1) { dirHits++; dirTotal++; }
    else if (v.directionHit === -1) { dirTotal++; }
  }
  if (!n) return null;
  // Coverage per bar = sum(coveredN) / sum(n)
  let totBars = 0, totCov = 0;
  for (const r of rows) {
    if (!r.verdict) continue;
    totBars += r.verdict.n || 0;
    totCov  += r.verdict.covered || 0;
  }
  return {
    rows: n,
    coveragePerBar: totBars ? totCov / totBars : null,
    absErrorFinalMean: sumAbsFinal / n,
    absErrorMeanMean:  sumAbsMean / n,
    widthFinalMean:    sumWidthFinal / n,
    directionAccuracy: dirTotal ? dirHits / dirTotal : null,
    directionN:        dirTotal,
  };
}

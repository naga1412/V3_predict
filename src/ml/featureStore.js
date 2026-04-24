/**
 * My Next Prediction v3.0 — Feature store
 * ---------------------------------------
 * Persists feature rows and labels to IDB (`features` store) and assembles
 * training-ready datasets on demand. Versioned by FEATURE_VERSION so stale
 * rows are invalidated automatically when the schema changes.
 *
 * Row schema:  { symbol, tf, t, version, vec, label }
 *   - Primary key [symbol, tf, t] (from data/schema.js)
 *   - `vec`  : number[] (per-bar feature vector)
 *   - `label`: { side:-1|0|+1, t1:number|null, ret:number, touched:string }
 *
 * Two public surfaces:
 *   writeFeatures({symbol,tf,ta,labels}) — bulk put
 *   loadDataset({symbol,tf,from,to,window=1})
 *     → { matrix, labels, t, d, names }
 *     — filters by version, applies optional window stacking.
 */

import { withStore, req2promise, putMany, metaGet, metaSet } from "../data/idb.js";
import { FEATURE_VERSION, FEATURE_NAMES, FEATURE_COUNT, buildFeatureMatrix, stackWindows } from "./features.js";

const STORE = "features";

/**
 * Write features and labels for a (symbol, tf). Existing rows at the same
 * [symbol, tf, t] are overwritten (IDB put semantics).
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {string} args.tf
 * @param {{t:number[], matrix:Float32Array, d:number, valid:Uint8Array}} args.fm
 * @param {Array<{side:number,t1:number|null,ret:number,touched:string}>} [args.labels]
 *   optional — aligned by index with fm
 * @returns {Promise<{written:number, skipped:number}>}
 */
export async function writeFeatures({ symbol, tf, fm, labels = [] }) {
  if (!symbol || !tf || !fm) throw new Error("[featureStore] symbol/tf/fm required");
  const rows = [];
  for (let i = 0; i < fm.n; i++) {
    if (!fm.valid[i]) continue;
    const vec = Array.from(fm.matrix.subarray(i * fm.d, (i + 1) * fm.d));
    rows.push({
      symbol, tf, t: fm.t[i],
      version: FEATURE_VERSION,
      vec,
      label: labels[i] ?? null,
    });
  }
  if (!rows.length) return { written: 0, skipped: fm.n };
  await putMany(STORE, rows);
  await metaSet(`features:lastWrite:${symbol}:${tf}`, { count: rows.length, at: Date.now(), version: FEATURE_VERSION });
  return { written: rows.length, skipped: fm.n - rows.length };
}

/**
 * Read features for a symbol/tf/time-range from IDB.
 *
 * @returns {Promise<Array<{symbol,tf,t,version,vec,label}>>}
 */
export async function readFeatures({ symbol, tf, from = 0, to = Infinity, minVersion = FEATURE_VERSION }) {
  return withStore(STORE, "readonly", (s) => new Promise((resolve, reject) => {
    const rows = [];
    const lo = [symbol, tf, from];
    const hi = [symbol, tf, Number.isFinite(to) ? to : 8.64e15];
    const req = s.openCursor(IDBKeyRange.bound(lo, hi));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(rows);
      const v = cur.value;
      if (v.version >= minVersion) rows.push(v);
      cur.continue();
    };
  }));
}

/**
 * Assemble a training-ready dataset from stored rows.
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {string} args.tf
 * @param {number} [args.from=0]
 * @param {number} [args.to=Infinity]
 * @param {number} [args.window=1]  stack this many consecutive rows per sample
 * @returns {Promise<{
 *   matrix: Float32Array, labels: Array, t:number[], n:number, d:number, names:string[]
 * }>}
 */
export async function loadDataset({ symbol, tf, from = 0, to = Infinity, window = 1 }) {
  const rows = await readFeatures({ symbol, tf, from, to });
  if (!rows.length) {
    return {
      matrix: new Float32Array(0), labels: [], t: [], n: 0,
      d: FEATURE_COUNT, names: [...FEATURE_NAMES],
    };
  }
  // Sort by t (IDB cursor already does, but guard).
  rows.sort((a, b) => a.t - b.t);
  const n = rows.length;
  const d = rows[0].vec.length;
  const matrix = new Float32Array(n * d);
  const labels = new Array(n);
  const t = new Array(n);
  for (let i = 0; i < n; i++) {
    const vec = rows[i].vec;
    for (let k = 0; k < d; k++) matrix[i * d + k] = vec[k];
    labels[i] = rows[i].label;
    t[i] = rows[i].t;
  }
  const valid = new Uint8Array(n).fill(1);
  const fm = { matrix, n, d, valid, t, names: [...FEATURE_NAMES] };
  if (window > 1) {
    const stacked = stackWindows(fm, window);
    // Align labels to the last bar in each window
    const lbls = new Array(stacked.n);
    for (let i = 0; i < stacked.n; i++) lbls[i] = labels[i + window - 1] ?? null;
    return {
      matrix: stacked.matrix, labels: lbls, t: stacked.t,
      n: stacked.n, d: stacked.d, names: stacked.names,
    };
  }
  return { matrix, labels, t, n, d, names: fm.names };
}

/**
 * End-to-end helper: compute features from TA, label them via triple-barrier,
 * and persist to IDB. Convenient for tests and the Phase-7 training pipeline.
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {string} args.tf
 * @param {object} args.ta         TAEngine output
 * @param {import("./labels.js")} args.Labels  the labels module namespace
 * @param {object} [args.tbOpts]   options passed to tripleBarrier
 * @param {number} [args.warmup=50]
 */
export async function computeAndStore({ symbol, tf, ta, Labels, tbOpts = {}, warmup = 50 }) {
  const fm = buildFeatureMatrix(ta, { warmup });
  const { high, low, close } = ta;
  // Prefer ATR when available for sigma; fallback to rollingReturnStd.
  let sigma = ta.atr14;
  if (!Array.isArray(sigma) || sigma.every(x => !Number.isFinite(x))) {
    sigma = Labels.rollingReturnStd(close, 20);
  }
  const tb = Labels.tripleBarrier({
    high, low, close,
    sigma,
    maxHorizon: tbOpts.maxHorizon ?? 20,
    ptSl: tbOpts.ptSl ?? [2, 2],
    minRet: tbOpts.minRet ?? 0,
  });
  const res = await writeFeatures({ symbol, tf, fm, labels: tb });
  return { ...res, n: fm.n, d: fm.d, distribution: Labels.labelDistribution(tb.map(x => x?.side || 0)) };
}

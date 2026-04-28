/**
 * My Next Prediction v3.0 — M4c · Intermarket math
 * ------------------------------------------------
 * Pure helpers for cross-asset correlation + relative strength.
 * No DOM, no IDB, no events.
 *
 *   pearson(a, b)            → -1..+1
 *   logReturns(closes)       → array of len-1
 *   alignByT(seriesA, seriesB) → returns matched closes
 *   correlationMatrix(rows)  → NxN symmetric matrix
 *   relativeStrength(asset, base, window) → +/- pct delta
 */

/** Pearson correlation of two equal-length numeric arrays. */
export function pearson(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return NaN;
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  let sa = 0, sb = 0, n2 = 0;
  for (let i = 0; i < n; i++) {
    const x = +a[i], y = +b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sa += x; sb += y; n2++;
  }
  if (n2 < 3) return NaN;
  const ma = sa / n2, mb = sb / n2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = +a[i], y = +b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dx = x - ma, dy = y - mb;
    num += dx * dy; da += dx * dx; db += dy * dy;
  }
  const denom = Math.sqrt(da * db);
  if (!Number.isFinite(denom) || denom === 0) return 0;
  return Math.max(-1, Math.min(1, num / denom));
}

/** Log-returns of a closes array.  Output length = closes.length - 1. */
export function logReturns(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return [];
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = +closes[i - 1], b = +closes[i];
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) out.push(Math.log(b / a));
    else out.push(0);
  }
  return out;
}

/**
 * Align two `[{t, c}]` series on shared timestamps and return parallel
 * close arrays.  Both inputs sorted ascending in t.
 */
export function alignByT(A, B) {
  if (!Array.isArray(A) || !Array.isArray(B)) return { a: [], b: [], t: [] };
  const mapA = new Map();
  for (const r of A) if (Number.isFinite(r?.t) && Number.isFinite(r?.c)) mapA.set(r.t, +r.c);
  const a = [], b = [], t = [];
  for (const r of B) {
    const ca = mapA.get(r?.t);
    if (Number.isFinite(ca) && Number.isFinite(r?.c)) {
      a.push(ca); b.push(+r.c); t.push(r.t);
    }
  }
  return { a, b, t };
}

/**
 * NxN correlation matrix of N return series.  `series` is an object
 * { id: closes[] }; all input arrays must be the same length.
 *
 * @returns {{ ids: string[], matrix: number[][] }}
 */
export function correlationMatrix(series) {
  const ids = Object.keys(series || {});
  const N = ids.length;
  const matrix = Array.from({ length: N }, () => Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      if (i === j) { matrix[i][j] = 1; continue; }
      const r = pearson(series[ids[i]], series[ids[j]]);
      matrix[i][j] = matrix[j][i] = Number.isFinite(r) ? r : 0;
    }
  }
  return { ids, matrix };
}

/**
 * Relative strength: % return of `asset` minus % return of `base` over
 * the last `window` bars.  Positive = asset outperforming.
 */
export function relativeStrength(assetCloses, baseCloses, window = 20) {
  if (!Array.isArray(assetCloses) || !Array.isArray(baseCloses)) return NaN;
  const tail = (arr) => arr.slice(-Math.max(2, window + 1));
  const ta = tail(assetCloses);
  const tb = tail(baseCloses);
  if (ta.length < 2 || tb.length < 2) return NaN;
  const aR = (+ta[ta.length - 1] - +ta[0]) / +ta[0];
  const bR = (+tb[tb.length - 1] - +tb[0]) / +tb[0];
  if (!Number.isFinite(aR) || !Number.isFinite(bR)) return NaN;
  return aR - bR;
}

/**
 * Simple beta of asset vs base = cov(asset, base) / var(base).
 */
export function beta(assetReturns, baseReturns) {
  const n = Math.min(assetReturns?.length || 0, baseReturns?.length || 0);
  if (n < 3) return NaN;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += +assetReturns[i]; sb += +baseReturns[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = +assetReturns[i] - ma;
    const db = +baseReturns[i] - mb;
    cov += da * db;
    varB += db * db;
  }
  return varB > 0 ? cov / varB : NaN;
}

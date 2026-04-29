/**
 * My Next Prediction v3.0 — M-LEARN-2 · Anti-pattern Discovery
 * -----------------------------------------------------------
 * Cluster Mistake-Ledger rows by their feature-vector at predict-time,
 * surface clusters where the model has been **reliably wrong**, and
 * persist them as queryable "anti-patterns" the meta-veto layer
 * (M-LEARN-3) can match against the live feature vector.
 *
 *   discoverAntiPatterns({ minSamples, badThreshold }) → { found, total }
 *   listAntiPatterns({ regime?, limit? })              → AntiPattern[]
 *   nearestAntiPattern(featureVec, { regime? })        → AntiPattern|null
 *   clearAll()
 *
 * Pure / IDB. No DOM, no events.  The clustering uses a streaming
 * mini-batch k-means approximation — adequate for the small N we'll
 * have in browser memory (≤ 500 mistakes), no library required.
 *
 * Persistence: `antiPatterns` IDB store added in DB v7.
 *
 *   AntiPattern row:
 *   {
 *     id:         autoIncrement,
 *     regime:     string|null,
 *     centroid:   number[],       // mean feature vector
 *     radius:     number,         // squared L2 cutoff for "matches this cluster"
 *     hitRate:    number,         // 0..1 — share of nearby predictions that were CORRECT
 *     sampleN:    number,         // total nearby (mistakes + correct)
 *     mistakeN:   number,
 *     direction:  "long"|"short"|"mixed", // dominant direction the model picked
 *     errorTypes: { direction:n, "interval-miss":n, magnitude:n, "set-miss":n },
 *     label:      string,         // human-readable hint
 *     createdAt:  ms,
 *     updatedAt:  ms,
 *   }
 *
 * Match semantics:
 *   featureVec is "in" the cluster when squaredDist(featureVec, centroid) <= radius.
 *   We only store clusters with hitRate < `badThreshold` (default 0.45).
 */

import { put, withStore, req2promise, count as idbCount } from "../data/idb.js";

const STORE = "antiPatterns";

const DEFAULTS = Object.freeze({
  k:              8,        // target cluster count
  minSamples:     20,       // minimum mistakes per cluster to be considered
  badThreshold:   0.45,     // clusters with hitRate < this become anti-patterns
  embargoBars:    0,        // currently unused; reserved for time-aware clustering
  maxIters:       30,       // mini-batch k-means iterations
});

/* ═══════════════════════════ Math helpers ═══════════════════════════ */

/** Cosine-style L2 squared distance.  Treats missing dims as 0. */
export function sqDist(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
  const n = Math.max(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const x = +a[i] || 0;
    const y = +b[i] || 0;
    const d = x - y;
    s += d * d;
  }
  return s;
}

/** Mean of a list of equal-length number arrays.  Returns null on empty input. */
export function mean(vecs) {
  if (!Array.isArray(vecs) || vecs.length === 0) return null;
  const dim = vecs[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) out[i] += +v[i] || 0;
  }
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

/** kth-nearest-neighbour radius — used to size cluster `radius`. */
export function clusterRadius(vecs, centroid, percentile = 0.9) {
  if (!Array.isArray(vecs) || vecs.length === 0) return 0;
  const dists = vecs.map((v) => sqDist(v, centroid)).sort((a, b) => a - b);
  const idx = Math.min(dists.length - 1, Math.max(0, Math.floor(percentile * (dists.length - 1))));
  return dists[idx];
}

/* ═══════════════════════════ Mini-batch k-means ═══════════════════════════ */

/**
 * Simple mini-batch k-means (no external deps).  Returns labels[] and centroids[].
 * Initial centroids: k points spaced from the input via reservoir sampling.
 */
export function kmeans(vecs, k = DEFAULTS.k, maxIters = DEFAULTS.maxIters) {
  if (!Array.isArray(vecs) || vecs.length === 0) return { labels: [], centroids: [] };
  const n = vecs.length;
  const K = Math.max(1, Math.min(k, n));
  // Init centroids by picking K well-spread samples.  Use indices [0, n/K, 2n/K, …]
  let centroids = [];
  for (let i = 0; i < K; i++) centroids.push(vecs[Math.floor((i * n) / K)].slice());

  const labels = new Array(n).fill(0);
  for (let iter = 0; iter < maxIters; iter++) {
    let moved = 0;
    // Assignment step
    for (let i = 0; i < n; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < K; c++) {
        const d = sqDist(vecs[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; moved++; }
    }
    if (moved === 0 && iter > 0) break;
    // Update step
    const sums = Array.from({ length: K }, () => new Array(centroids[0].length).fill(0));
    const counts = new Array(K).fill(0);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      counts[c]++;
      for (let j = 0; j < vecs[i].length; j++) sums[c][j] += +vecs[i][j] || 0;
    }
    for (let c = 0; c < K; c++) {
      if (counts[c] === 0) continue;
      for (let j = 0; j < sums[c].length; j++) sums[c][j] /= counts[c];
      centroids[c] = sums[c];
    }
  }
  return { labels, centroids };
}

/* ═══════════════════════════ Discovery pipeline ═══════════════════════════ */

/**
 * Cluster the supplied mistakes + a sample of correct predictions; for
 * each cluster compute mistake / total ratio (the "miss rate"); flag
 * clusters where miss rate >= 1 - badThreshold (i.e. the model gets
 * them wrong a lot).
 *
 * Caller passes:
 *   mistakes — array of Mistake rows from MistakeLedger.recent({})
 *   corrects — array of {context.featureVec, ...} for predictions that hit
 *
 * For now `corrects` is OPTIONAL — when omitted we treat every nearby
 * datapoint as a miss and report `hitRate = 0` (lower bound).  Once
 * Phase 10 starts persisting verdict.featureVec on hits too, the
 * caller can pass them in for proper precision.
 *
 * @returns {Promise<{added:number, updated:number, total:number}>}
 */
export async function discoverAntiPatterns({
  mistakes, corrects, k = DEFAULTS.k, minSamples = DEFAULTS.minSamples,
  badThreshold = DEFAULTS.badThreshold,
} = {}) {
  if (!Array.isArray(mistakes) || mistakes.length < minSamples) {
    return { added: 0, updated: 0, total: 0, skipped: "insufficient mistakes" };
  }
  // Pull feature vectors for mistakes that have them
  const mVecs = [];
  const mRows = [];
  for (const m of mistakes) {
    const v = m?.context?.featureVec;
    if (Array.isArray(v) && v.length > 0) {
      mVecs.push(v);
      mRows.push(m);
    }
  }
  if (mVecs.length < minSamples) {
    return { added: 0, updated: 0, total: 0, skipped: "insufficient feature vectors" };
  }
  const cVecs = [];
  const cRows = [];
  if (Array.isArray(corrects)) {
    for (const c of corrects) {
      const v = c?.context?.featureVec;
      if (Array.isArray(v) && v.length > 0) {
        cVecs.push(v); cRows.push(c);
      }
    }
  }

  // 1. Cluster the mistakes
  const { labels, centroids } = kmeans(mVecs, k);
  const allDirs = ["long","short","mixed"];
  const buckets = centroids.map(() => ({
    centroid: null, radius: 0,
    misses: [], correctsNear: 0,
    errorTypes: { direction: 0, "interval-miss": 0, magnitude: 0, "set-miss": 0 },
    dirs: { long: 0, short: 0 },
    regimes: {},
  }));

  // Assign rows to buckets + tally error types + regime + dir
  for (let i = 0; i < mVecs.length; i++) {
    const b = buckets[labels[i]];
    b.misses.push(mVecs[i]);
    const r = mRows[i];
    b.errorTypes[r.errorType] = (b.errorTypes[r.errorType] || 0) + 1;
    if (r.predicted?.direction === "long")  b.dirs.long++;
    if (r.predicted?.direction === "short") b.dirs.short++;
    const rg = r.context?.regime || "unknown";
    b.regimes[rg] = (b.regimes[rg] || 0) + 1;
  }

  // For each bucket: build centroid + radius from its misses; count
  // how many "corrects" fall inside that radius (to compute hitRate).
  const out = [];
  for (let c = 0; c < buckets.length; c++) {
    const b = buckets[c];
    if (b.misses.length < minSamples) continue;
    b.centroid = mean(b.misses);
    b.radius   = clusterRadius(b.misses, b.centroid, 0.9);
    if (Array.isArray(cVecs)) {
      for (const v of cVecs) if (sqDist(v, b.centroid) <= b.radius) b.correctsNear++;
    }
    const sampleN  = b.misses.length + b.correctsNear;
    const mistakeN = b.misses.length;
    const hitRate  = sampleN > 0 ? b.correctsNear / sampleN : 0;
    if (hitRate >= badThreshold) continue;   // not bad enough to flag
    const dominantDir = b.dirs.long > b.dirs.short * 2 ? "long"
                     : b.dirs.short > b.dirs.long * 2 ? "short"
                     : "mixed";
    const dominantRegime = Object.entries(b.regimes).sort((x, y) => y[1] - x[1])[0]?.[0] || null;
    out.push({
      regime:    dominantRegime,
      centroid:  b.centroid,
      radius:    +b.radius.toFixed(6),
      hitRate:   +hitRate.toFixed(3),
      sampleN, mistakeN,
      direction: dominantDir,
      errorTypes: b.errorTypes,
      label:     `${dominantDir} in ${dominantRegime || "any regime"} · miss ${(mistakeN)}/${sampleN} (${(hitRate*100).toFixed(0)}%)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  // Persist — replace existing anti-patterns wholesale (cheap; we
  // never have many) so retrains converge to a clean set.
  await clearAll();
  let added = 0;
  for (const ap of out) { await put(STORE, ap); added++; }

  return { added, updated: 0, total: await idbCount(STORE), skipped: null };
}

/* ═══════════════════════════ Read API ═══════════════════════════ */

export async function listAntiPatterns({ regime, limit = 100 } = {}) {
  return withStore(STORE, "readonly", async (s) => {
    const rows = await req2promise(s.getAll());
    const out = [];
    for (const r of rows) {
      if (regime != null && r.regime !== regime) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  });
}

/**
 * Find the closest anti-pattern to a feature vector.  Returns the
 * pattern + distance + a `inRadius` flag.  Returns null when the
 * store is empty or the vector is invalid.
 */
export async function nearestAntiPattern(featureVec, { regime } = {}) {
  if (!Array.isArray(featureVec) || featureVec.length === 0) return null;
  const aps = await listAntiPatterns({ regime });
  if (!aps.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const ap of aps) {
    const d = sqDist(featureVec, ap.centroid);
    if (d < bestD) { bestD = d; best = ap; }
  }
  if (!best) return null;
  return { antiPattern: best, distance: +bestD.toFixed(6), inRadius: bestD <= best.radius };
}

export async function count() { return idbCount(STORE); }

export async function clearAll() {
  return withStore(STORE, "readwrite", async (s) => req2promise(s.clear()));
}

export const _internals = { DEFAULTS };

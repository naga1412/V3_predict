/**
 * My Next Prediction v3.0 — Feature normalization
 * -----------------------------------------------
 * Fit-on-train / apply-on-val-and-test to prevent target leakage.
 *
 * Two supported modes:
 *   z-score:   x' = (x - mean) / std
 *   min-max:   x' = 2 * (x - min) / (max - min) - 1      (scaled to [-1,+1])
 *
 * Stats are per-column. Constant columns fall back to pass-through.
 */

/**
 * Compute per-column mean + std over a subset of rows.
 * @param {Float32Array} matrix  row-major, n*d
 * @param {number} d             column count
 * @param {number[]|null} rowIdx if null, use all rows
 * @param {Uint8Array|null} [valid] if given, only use rows where valid[i]=1
 */
export function fitZScore(matrix, d, rowIdx = null, valid = null) {
  const n = matrix.length / d;
  const idx = rowIdx ?? Array.from({ length: n }, (_, i) => i);
  const mean = new Float64Array(d);
  const M2   = new Float64Array(d);
  let count = 0;
  for (const i of idx) {
    if (valid && !valid[i]) continue;
    count++;
    for (let k = 0; k < d; k++) {
      const x = matrix[i * d + k];
      const delta = x - mean[k];
      mean[k] += delta / count;
      const delta2 = x - mean[k];
      M2[k] += delta * delta2;
    }
  }
  const std = new Float64Array(d);
  for (let k = 0; k < d; k++) {
    std[k] = count > 1 ? Math.sqrt(M2[k] / (count - 1)) : 0;
    if (!Number.isFinite(std[k]) || std[k] < 1e-12) std[k] = 1; // pass-through
  }
  return { type: "zscore", mean: Array.from(mean), std: Array.from(std), count };
}

/**
 * Compute per-column min + max over rows.
 */
export function fitMinMax(matrix, d, rowIdx = null, valid = null) {
  const n = matrix.length / d;
  const idx = rowIdx ?? Array.from({ length: n }, (_, i) => i);
  const mn = new Float64Array(d).fill(Infinity);
  const mx = new Float64Array(d).fill(-Infinity);
  let count = 0;
  for (const i of idx) {
    if (valid && !valid[i]) continue;
    count++;
    for (let k = 0; k < d; k++) {
      const x = matrix[i * d + k];
      if (x < mn[k]) mn[k] = x;
      if (x > mx[k]) mx[k] = x;
    }
  }
  for (let k = 0; k < d; k++) {
    if (!Number.isFinite(mn[k])) mn[k] = 0;
    if (!Number.isFinite(mx[k])) mx[k] = 0;
    if (mx[k] === mn[k]) mx[k] = mn[k] + 1; // pass-through
  }
  return { type: "minmax", min: Array.from(mn), max: Array.from(mx), count };
}

/**
 * Apply fitted stats in-place (or copy) to a matrix.
 *
 * @param {Float32Array} matrix
 * @param {number} d
 * @param {object} stats fitZScore() or fitMinMax() output
 * @param {boolean} [inPlace=false]
 * @returns {Float32Array}
 */
export function applyStats(matrix, d, stats, inPlace = false) {
  const out = inPlace ? matrix : new Float32Array(matrix);
  const n = matrix.length / d;
  if (stats.type === "zscore") {
    const { mean, std } = stats;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < d; k++) {
        out[i * d + k] = (matrix[i * d + k] - mean[k]) / std[k];
      }
    }
  } else if (stats.type === "minmax") {
    const { min, max } = stats;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < d; k++) {
        const span = max[k] - min[k];
        out[i * d + k] = span > 0
          ? 2 * (matrix[i * d + k] - min[k]) / span - 1
          : 0;
      }
    }
  } else {
    throw new Error(`[normalize] unknown stats.type=${stats.type}`);
  }
  return out;
}

/**
 * Clip values to a symmetric [-c,+c] range (robust to outliers).
 */
export function clipMatrix(matrix, d, c = 5, inPlace = true) {
  const out = inPlace ? matrix : new Float32Array(matrix);
  for (let i = 0; i < out.length; i++) {
    if (out[i] > c) out[i] = c;
    else if (out[i] < -c) out[i] = -c;
  }
  return out;
}

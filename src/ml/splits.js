/**
 * My Next Prediction v3.0 — Cross-validation splits
 * -------------------------------------------------
 * For time-series labeled data where label at bar i looks forward to t1[i],
 * standard k-fold leaks test labels into train when their windows overlap.
 *
 * "Purging" (Lopez de Prado 2018, §7):
 *   - From train, remove any sample whose [i, t1] window overlaps test.
 * "Embargo":
 *   - Remove an additional `embargo` bars of train AFTER the test window,
 *     because the serial autocorrelation of price still links them.
 *
 * Supports:
 *   - Forward-only splits (walkForward) — simpler, used for the final
 *     out-of-sample validation in the Phase-10 validator.
 *   - Purged k-fold (purgedKFold) — used for hyperparam CV in training.
 */

/**
 * Forward-only train/val/test split.
 *
 * @param {number} n total samples
 * @param {object} [opts]
 * @param {number} [opts.trainFrac=0.7]
 * @param {number} [opts.valFrac=0.15]
 *   (test gets 1 - trainFrac - valFrac)
 * @param {number} [opts.embargo=0]  bars to drop between each split
 */
export function walkForwardSplit(n, { trainFrac = 0.7, valFrac = 0.15, embargo = 0 } = {}) {
  const trainEnd = Math.floor(n * trainFrac);
  const valEnd   = Math.floor(n * (trainFrac + valFrac));
  const trainIdx = [];
  const valIdx = [];
  const testIdx = [];
  for (let i = 0; i < trainEnd - embargo; i++) trainIdx.push(i);
  for (let i = trainEnd; i < valEnd - embargo; i++) valIdx.push(i);
  for (let i = valEnd; i < n; i++) testIdx.push(i);
  return { trainIdx, valIdx, testIdx };
}

/**
 * Purged k-fold CV iterator.
 *
 * @param {number[]} t1Arr  for sample i, the bar index where its label resolves
 *                          (from tripleBarrier). Used to determine overlaps.
 * @param {object}   opts
 * @param {number}   opts.k        number of folds (default 5)
 * @param {number}   [opts.embargo=0]  bars to drop after each test fold in train
 * @returns {Array<{trainIdx:number[], testIdx:number[]}>}
 */
export function purgedKFold(t1Arr, { k = 5, embargo = 0 } = {}) {
  const n = t1Arr.length;
  if (n === 0 || k < 2) return [];
  const foldSize = Math.floor(n / k);
  const folds = [];
  for (let f = 0; f < k; f++) {
    const testStart = f * foldSize;
    const testEnd   = f === k - 1 ? n : testStart + foldSize;
    const testIdx = [];
    for (let i = testStart; i < testEnd; i++) testIdx.push(i);

    // Test window spans [testStart, testExtendedEnd] where testExtendedEnd
    // = max over i in testIdx of (t1[i] or i). This is the "contamination"
    // horizon.
    let testExtendedEnd = testEnd - 1;
    for (let i = testStart; i < testEnd; i++) {
      const e = Number.isInteger(t1Arr[i]) ? t1Arr[i] : i;
      if (e > testExtendedEnd) testExtendedEnd = e;
    }
    const embargoEnd = Math.min(n - 1, testExtendedEnd + embargo);

    const trainIdx = [];
    for (let i = 0; i < n; i++) {
      if (i >= testStart && i < testEnd) continue;          // inside test
      const ei = Number.isInteger(t1Arr[i]) ? t1Arr[i] : i;
      // Overlap: [i, ei] intersects [testStart, testEnd-1]?
      if (!(ei < testStart || i > testEnd - 1)) continue;   // purged
      // Embargo: train sample STARTING inside (testEnd, embargoEnd]?
      if (i > testEnd - 1 && i <= embargoEnd) continue;     // embargoed
      trainIdx.push(i);
    }
    folds.push({ trainIdx, testIdx });
  }
  return folds;
}

/**
 * Convenience: materialize a subset of a feature matrix.
 *
 * @param {Float32Array} matrix
 * @param {number} d
 * @param {number[]} idx
 * @returns {Float32Array}
 */
export function gatherRows(matrix, d, idx) {
  const out = new Float32Array(idx.length * d);
  for (let r = 0; r < idx.length; r++) {
    const src = idx[r] * d;
    out.set(matrix.subarray(src, src + d), r * d);
  }
  return out;
}

/**
 * Subset a label array by index.
 * @template T
 * @param {T[]|Array<T>} arr
 * @param {number[]} idx
 * @returns {T[]}
 */
export function gather(arr, idx) {
  const out = new Array(idx.length);
  for (let r = 0; r < idx.length; r++) out[r] = arr[idx[r]];
  return out;
}

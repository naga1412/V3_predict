/**
 * My Next Prediction v3.0 — Probability Calibration
 * -------------------------------------------------
 * Ensemble scores from runModules() are in [-1,+1] but not directly
 * interpretable as probabilities. Calibrators map them to P(y=1) using
 * the empirical relationship on held-out data.
 *
 * Two fit methods:
 *   Platt scaling  — logistic regression  P(y=1|s) = 1/(1+exp(-(a·s + b)))
 *   Isotonic regression — monotone piecewise-constant fit (pool adjacent
 *                         violators). Nonparametric; handles non-linear
 *                         mis-calibration.
 *
 * Plus diagnostics:
 *   brierScore, logLoss, reliabilityDiagram, ECE (expected calibration error)
 */

/* ─────────────────── Platt scaling ─────────────────── */

/**
 * Fit logistic regression (gradient descent) on (score, label) pairs.
 * labels must be 0 or 1.
 *
 * @param {number[]} scores
 * @param {number[]} labels  0/1
 * @param {object} [opts]
 * @param {number} [opts.lr=0.05]
 * @param {number} [opts.epochs=500]
 * @param {number} [opts.l2=0]   L2 regularization
 * @returns {{type:'platt', a:number, b:number}}
 */
export function fitPlatt(scores, labels, { lr = 0.05, epochs = 500, l2 = 0 } = {}) {
  const n = Math.min(scores.length, labels.length);
  if (n === 0) return { type: "platt", a: 0, b: 0 };
  let a = 1, b = 0;
  for (let ep = 0; ep < epochs; ep++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < n; i++) {
      const s = scores[i];
      const y = labels[i] ? 1 : 0;
      const p = 1 / (1 + Math.exp(-(a * s + b)));
      const err = p - y;
      ga += err * s;
      gb += err;
    }
    ga = ga / n + l2 * a;
    gb = gb / n;
    a -= lr * ga;
    b -= lr * gb;
  }
  return { type: "platt", a, b };
}

/**
 * Apply Platt calibrator.
 */
export function plattPredict(model, score) {
  return 1 / (1 + Math.exp(-(model.a * score + model.b)));
}

/* ─────────────────── Isotonic regression ─────────────────── */

/**
 * Pool-adjacent-violators algorithm. Returns piecewise-constant P(y=1)
 * over sorted (score) → (predicted probability).
 *
 * @param {number[]} scores
 * @param {number[]} labels  0/1
 * @returns {{type:'isotonic', xs:number[], ys:number[]}}
 */
export function fitIsotonic(scores, labels) {
  const n = Math.min(scores.length, labels.length);
  if (n === 0) return { type: "isotonic", xs: [], ys: [] };
  // Sort pairs by score
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => scores[i] - scores[j]);
  const sortedX = idx.map(i => scores[i]);
  const sortedY = idx.map(i => labels[i] ? 1 : 0);
  // PAV
  const w = new Array(n).fill(1);
  const y = sortedY.slice();
  const level = new Array(n).fill(1); // segment size
  let i = 0;
  while (i < y.length - 1) {
    if (y[i] > y[i + 1]) {
      // Pool
      const newW = w[i] + w[i + 1];
      const newY = (y[i] * w[i] + y[i + 1] * w[i + 1]) / newW;
      const newLevel = level[i] + level[i + 1];
      y.splice(i, 2, newY);
      w.splice(i, 2, newW);
      level.splice(i, 2, newLevel);
      // Go back to re-check previous
      if (i > 0) i--;
    } else {
      i++;
    }
  }
  // Expand pooled levels back to original positions: xs = pooled representative
  // (we keep sortedX breakpoints — first x in each pool).
  const xs = [];
  const ys = [];
  let cursor = 0;
  for (let k = 0; k < y.length; k++) {
    xs.push(sortedX[cursor]);
    ys.push(y[k]);
    cursor += level[k];
  }
  return { type: "isotonic", xs, ys };
}

/**
 * Apply isotonic calibrator: piecewise constant with linear interpolation.
 */
export function isotonicPredict(model, score) {
  const { xs, ys } = model;
  if (!xs.length) return 0.5;
  if (score <= xs[0]) return ys[0];
  if (score >= xs[xs.length - 1]) return ys[ys.length - 1];
  // Binary search for the segment
  let lo = 0, hi = xs.length - 1;
  while (lo + 1 < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= score) lo = m; else hi = m;
  }
  const x0 = xs[lo], x1 = xs[hi];
  const y0 = ys[lo], y1 = ys[hi];
  if (x1 === x0) return y0;
  return y0 + (y1 - y0) * (score - x0) / (x1 - x0);
}

/* ─────────────────── Unified predictor ─────────────────── */

/** Build a callable `{predict(score)}` wrapper around a fitted model. */
export function asPredictor(model) {
  if (!model) return { predict: (s) => 1 / (1 + Math.exp(-s * 3)) };
  if (model.type === "platt") return { predict: (s) => plattPredict(model, s), model };
  if (model.type === "isotonic") return { predict: (s) => isotonicPredict(model, s), model };
  throw new Error(`[calibration] unknown model type: ${model.type}`);
}

/* ─────────────────── Diagnostics ─────────────────── */

/** Brier score (mean squared error of probabilities vs 0/1 labels). */
export function brierScore(probs, labels) {
  const n = Math.min(probs.length, labels.length);
  if (n === 0) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const y = labels[i] ? 1 : 0;
    s += (probs[i] - y) ** 2;
  }
  return s / n;
}

/** Log loss (cross-entropy). */
export function logLoss(probs, labels, eps = 1e-12) {
  const n = Math.min(probs.length, labels.length);
  if (n === 0) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const y = labels[i] ? 1 : 0;
    const p = Math.max(eps, Math.min(1 - eps, probs[i]));
    s += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return s / n;
}

/**
 * Reliability diagram: bucket predicted probabilities into bins, return
 * per-bin { predicted, observed, count }.
 */
export function reliabilityDiagram(probs, labels, bins = 10) {
  const buckets = Array.from({ length: bins }, () => ({ sumP: 0, sumY: 0, count: 0 }));
  const n = Math.min(probs.length, labels.length);
  for (let i = 0; i < n; i++) {
    const p = probs[i];
    const b = Math.max(0, Math.min(bins - 1, Math.floor(p * bins)));
    buckets[b].sumP += p;
    buckets[b].sumY += labels[i] ? 1 : 0;
    buckets[b].count++;
  }
  return buckets.map((b, i) => ({
    bin: i,
    range: [i / bins, (i + 1) / bins],
    predicted: b.count > 0 ? b.sumP / b.count : NaN,
    observed:  b.count > 0 ? b.sumY / b.count : NaN,
    count: b.count,
  }));
}

/** Expected Calibration Error. */
export function expectedCalibrationError(probs, labels, bins = 10) {
  const diag = reliabilityDiagram(probs, labels, bins);
  const n = probs.length;
  let ece = 0;
  for (const b of diag) {
    if (b.count === 0) continue;
    ece += (b.count / n) * Math.abs(b.predicted - b.observed);
  }
  return ece;
}

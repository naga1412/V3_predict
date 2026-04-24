/**
 * My Next Prediction v3.0 — Module Contract
 * -----------------------------------------
 * Every analysis module exports:
 *
 *   export const meta = { id, name, category, description, weight };
 *   export function evaluate(ta, ctx = {}) -> Signal;
 *
 * Where `Signal` = {
 *   signal:     -1..+1,       // direction × strength (0 = neutral)
 *   confidence: 0..1,         // how sure THIS module is
 *   direction:  "long"|"short"|"neutral",
 *   reasons:    string[],     // human-readable justifications
 *   payload?:   object,       // optional module-specific detail
 * }
 *
 * The orchestrator aggregates Signals into a calibrated probability.
 */

/** Make a neutral zero-confidence signal (used when inputs are missing). */
export function neutral(reason = "insufficient data") {
  return { signal: 0, confidence: 0, direction: "neutral", reasons: [reason] };
}

/** Bound to [-1,+1] for signal, [0,1] for confidence. */
export function clampSignal(sig) {
  const s = Math.max(-1, Math.min(1, sig?.signal ?? 0));
  const c = Math.max(0,  Math.min(1, sig?.confidence ?? 0));
  const dir = s > 0.05 ? "long" : s < -0.05 ? "short" : "neutral";
  return {
    signal: s, confidence: c, direction: dir,
    reasons: Array.isArray(sig?.reasons) ? sig.reasons : [],
    payload: sig?.payload,
  };
}

/** Safe finite number (NaN-guard). */
export function num(x, fallback = NaN) {
  return Number.isFinite(x) ? x : fallback;
}

/** Get the last finite value from a series (Array or TypedArray or array-like). */
export function lastFinite(arr) {
  if (arr == null) return NaN;
  const n = arr.length;
  if (!Number.isInteger(n)) return NaN;
  for (let i = n - 1; i >= 0; i--) {
    if (Number.isFinite(arr[i])) return arr[i];
  }
  return NaN;
}

/** Percent distance (c - base) / base, guarded. */
export function pctDist(c, base) {
  return Number.isFinite(c) && Number.isFinite(base) && base !== 0
    ? (c - base) / base : 0;
}

/** Map a scalar ∈ [-1,+1] to a signed confidence split for ensembles. */
export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

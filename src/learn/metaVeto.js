/**
 * My Next Prediction v3.0 — M-LEARN-3 · Meta-Veto Layer
 * -----------------------------------------------------
 * Final gate between the orchestrator and the ghost-candle drawer.
 *
 * On every bar the live feature-vector is checked against the
 * anti-pattern store (built by M-LEARN-2).  If the vector lands
 * inside an anti-pattern's centroid radius AND that anti-pattern's
 * historical hit-rate is poor, we **suppress or soften** the
 * orchestrator's bias before it becomes a ghost candle.
 *
 *   evaluate({ orch, featureVec, regime, antiPattern? })
 *     → { signal, confidence, vetoed, reason, antiPattern }
 *
 * Decision table:
 *   inRadius  &  hitRate ≤ 0.25   → full veto: signal=0, confidence=0
 *   inRadius  &  hitRate ≤ 0.40   → soften:    signal *= 0.4, confidence *= 0.5
 *   otherwise                      → pass-through (no change)
 *
 * Pure module — same shape (sync) as the rest of the orchestrator
 * pipeline.  Async lookup of the nearest anti-pattern is the caller's
 * job (see `applyVetoToOrch` for a convenience wrapper).
 */

import * as AP from "./antiPatterns.js";

/**
 * Pure decision function — given a candidate veto match, return the
 * adjusted signal/confidence with a reason string.  No IDB reads.
 *
 * @param {{rawScore:number, probability:number, direction:string, signals?:any[]}} orch
 * @param {{antiPattern:object, distance:number, inRadius:boolean}|null} match
 * @returns {{
 *   signal: number, confidence: number, direction: string,
 *   vetoed: false | "full" | "softened",
 *   reason: string|null,
 *   antiPattern: object|null,
 *   originalScore: number,
 *   originalProb:  number,
 * }}
 */
export function evaluate(orch, match) {
  const orig = {
    signal:     Number.isFinite(orch?.rawScore)    ? +orch.rawScore    : 0,
    confidence: Number.isFinite(orch?.probability) ? Math.max(0, Math.min(1, orch.probability)) : 0.5,
    direction:  orch?.direction || "neutral",
  };
  const baseOut = {
    signal:        orig.signal,
    confidence:    orig.confidence,
    direction:     orig.direction,
    vetoed:        false,
    reason:        null,
    antiPattern:   null,
    originalScore: orig.signal,
    originalProb:  orig.confidence,
  };
  if (!match || !match.antiPattern || !match.inRadius) return baseOut;
  const ap = match.antiPattern;
  const hr = Number.isFinite(ap.hitRate) ? ap.hitRate : 1;

  if (hr <= 0.25) {
    return {
      ...baseOut,
      signal: 0,
      confidence: 0,
      direction: "neutral",
      vetoed: "full",
      antiPattern: ap,
      reason: `vetoed by anti-pattern '${ap.label}' — historical hit ${(hr*100|0)}%`,
    };
  }
  if (hr <= 0.40) {
    const sigMul = 0.4;
    const confMul = 0.5;
    return {
      ...baseOut,
      signal:     orig.signal * sigMul,
      confidence: orig.confidence * confMul,
      direction:  Math.abs(orig.signal * sigMul) < 0.05 ? "neutral" : orig.direction,
      vetoed:     "softened",
      antiPattern: ap,
      reason:     `softened by anti-pattern '${ap.label}' — historical hit ${(hr*100|0)}%`,
    };
  }
  return baseOut;
}

/**
 * Convenience: load nearest anti-pattern from IDB and return the
 * vetoed orch + diagnostics.  Use this in the React effect that
 * feeds `predictGhostCandles`.
 *
 * @param {object} orch       orchestrator output
 * @param {number[]} featureVec
 * @param {{regime?:string}} [opts]
 */
export async function applyVetoToOrch(orch, featureVec, opts = {}) {
  if (!Array.isArray(featureVec) || featureVec.length === 0) return evaluate(orch, null);
  let match = null;
  try { match = await AP.nearestAntiPattern(featureVec, { regime: opts.regime }); }
  catch { /* IDB unavailable */ }
  return evaluate(orch, match);
}

/**
 * Build a "vetoed orch" suitable for passing to `predictGhostCandles`
 * by overlaying the adjusted rawScore + probability.  Preserves the
 * rest of the orch object (signals[], featureVec, …).
 *
 * @param {object} orch original orchestration output
 * @param {ReturnType<typeof evaluate>} verdict
 */
export function applyToOrch(orch, verdict) {
  if (!verdict || verdict.vetoed === false) return orch;
  return {
    ...orch,
    rawScore:    verdict.signal,
    probability: 0.5 + 0.5 * verdict.signal,    // re-derive prob from signed score
    direction:   verdict.direction,
    metaVeto:    {
      kind:   verdict.vetoed,
      reason: verdict.reason,
      antiPatternId: verdict.antiPattern?.id ?? null,
      antiPatternLabel: verdict.antiPattern?.label ?? null,
      originalScore: verdict.originalScore,
      originalProb:  verdict.originalProb,
    },
  };
}

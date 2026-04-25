/**
 * My Next Prediction v3.0 — Phase M3 step 6 · Chart-pattern orchestrator
 * ----------------------------------------------------------------------
 * Translates the latest detected chart pattern (H&S, Triple Top, …)
 * into a portable signal.
 *
 *   bias       = sign(pattern.bias) · pattern.confidence    (broken=full, otherwise 60%)
 *   confidence = pattern.confidence                          (0.85/0.6/0.35)
 *   abstain    = no pattern OR confidence < 0.35
 */
import { neutral, clampSignal } from "./baseModule.js";

export const meta = Object.freeze({
  id: "chart-patterns",
  name: "Chart Patterns",
  category: "structure",
  description: "Geometric patterns: H&S, double/triple top/bottom, triangles",
  weight: 1.0,
});

export function evaluate(ta) {
  const cp = ta?.chartPatterns;
  if (!cp || !cp.last) return neutral("no chart pattern detected");
  const p = cp.last;
  if (!Number.isFinite(p.confidence) || p.confidence < 0.35) {
    return neutral(`pattern ${p.name} below confidence floor`);
  }

  const sign = p.bias === "bullish" ? +1 : p.bias === "bearish" ? -1 : 0;
  if (sign === 0) return neutral(`unknown pattern bias for ${p.name}`);

  const breakoutMul = p.broken ? 1.0 : 0.6;
  const signal = sign * p.confidence * breakoutMul;
  const reasons = [
    `${p.name} (${p.bias}, conf=${p.confidence.toFixed(2)})`,
    p.broken ? "Pattern confirmed (neckline/trigger broken)"
             : "Pattern formed (awaiting confirmation)",
  ];
  if (Number.isFinite(p.targetPrice))      reasons.push(`Target ≈ ${p.targetPrice.toFixed(4)}`);
  if (Number.isFinite(p.invalidationPrice)) reasons.push(`Invalidation @ ${p.invalidationPrice.toFixed(4)}`);
  return clampSignal({
    signal,
    confidence: p.confidence,
    reasons,
    payload: { pattern: p, total: cp.patterns.length },
  });
}

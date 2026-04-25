/**
 * My Next Prediction v3.0 — Phase M3 step 6 · Trendline orchestrator module
 * -------------------------------------------------------------------------
 * Translates the geometric trendline detector into a portable signal
 * for the orchestrator's ensemble.
 *
 *   bias = 0.5 · tanh(slope_norm)
 *        + 0.3 · breakoutDirection
 *        + 0.2 · positionInChannel  // +1 near lower, −1 near upper (mean-revert)
 *   confidence = best(line.score)   // r² · min(touches/4, 1)
 *   abstain    = best.score < 0.3 OR best.touches < 3
 *
 * The reasons array narrates which constituent contributed.
 */
import { neutral, clampSignal, lastFinite } from "./baseModule.js";

export const meta = Object.freeze({
  id: "trendline",
  name: "Trendlines & Channel",
  category: "structure",
  description: "Auto-fitted trendline: slope + R² · breakout · position-in-channel",
  weight: 1.0,
});

/**
 * @param {object} ta — TAEngine output (must contain `ta.trendlines`)
 */
export function evaluate(ta) {
  const tl = ta?.trendlines;
  if (!tl || (!tl.upper && !tl.lower)) return neutral("no trendline yet");

  const lastClose = lastFinite(ta.close);
  const lastBar   = (ta.close?.length || 1) - 1;
  if (!Number.isFinite(lastClose)) return neutral("no last close");

  // 1. Slope component — normalize by ATR per bar for scale-invariance.
  const atr = lastFinite(ta.atr14);
  const best = (tl.upper && tl.lower)
    ? (tl.upper.score >= tl.lower.score ? tl.upper : tl.lower)
    : (tl.upper || tl.lower);
  if (!best || best.score < 0.3 || best.touches < 3) {
    return clampSignal({
      signal: 0,
      confidence: Math.max(0, Math.min(0.3, best?.score || 0)),
      reasons: [`Trendline weak (score=${(best?.score ?? 0).toFixed(2)}, touches=${best?.touches ?? 0})`],
    });
  }
  const slopeNorm = Number.isFinite(atr) && atr > 0 ? best.slope / atr : best.slope;
  const slopeContribution = 0.5 * Math.tanh(slopeNorm * 4);   // saturates around 0.5

  // 2. Breakout component (±0.3 if confirmed).
  let breakoutContribution = 0;
  const reasons = [];
  if (tl.lastBreakout) {
    const dir = tl.lastBreakout.side === "up" ? 1 : -1;
    breakoutContribution = 0.3 * dir * Math.min(1, tl.lastBreakout.strength || 0);
    reasons.push(`Breakout ${tl.lastBreakout.side.toUpperCase()} (${tl.lastBreakout.distATR.toFixed(2)}·ATR)`);
  }

  // 3. Position-in-channel — only if we have BOTH lines.
  let positionContribution = 0;
  if (tl.upper && tl.lower) {
    const yU = tl.upper.slope * lastBar + tl.upper.intercept;
    const yL = tl.lower.slope * lastBar + tl.lower.intercept;
    if (Number.isFinite(yU) && Number.isFinite(yL) && yU > yL) {
      const t = (lastClose - yL) / (yU - yL);
      const pos = Math.max(-1, Math.min(1, 2 * t - 1));   // -1..+1
      // Mean-revert flavour: near upper line (pos≈+1) → bearish push (-0.2),
      //                     near lower line (pos≈-1) → bullish push (+0.2).
      positionContribution = -0.2 * pos;
      const where = pos > 0.66 ? "upper-band tag"
                  : pos < -0.66 ? "lower-band tag"
                  : "mid-channel";
      reasons.push(`In-channel: ${where} (pos=${pos.toFixed(2)})`);
    }
  }

  reasons.unshift(`Trendline slope=${slopeNorm.toFixed(3)}/ATR · R²=${best.r2.toFixed(2)} · touches=${best.touches}`);

  const signal = slopeContribution + breakoutContribution + positionContribution;
  const confidence = Math.max(0, Math.min(1, best.score * (tl.lastBreakout ? 1.0 : 0.85)));
  return clampSignal({ signal, confidence, reasons, payload: { trendline: tl } });
}

/**
 * Mean reversion module.
 *   long  if close below lower-BB AND RSI < 30
 *   short if close above upper-BB AND RSI > 70
 * Stronger when ADX is low (rangy market).
 */
import { neutral, clampSignal, lastFinite } from "./baseModule.js";

export const meta = Object.freeze({
  id: "mean-reversion",
  name: "Mean Reversion",
  category: "mean-reversion",
  description: "BB extreme + RSI oversold/overbought",
  weight: 1.0,
});

export function evaluate(ta) {
  const c = lastFinite(ta.close);
  const rsi = lastFinite(ta.rsi14);
  const adx = lastFinite(ta.adx14?.adx);
  const mid = lastFinite(ta.bb_20_2?.mid);
  const up  = lastFinite(ta.bb_20_2?.up);
  const lo  = lastFinite(ta.bb_20_2?.lo);
  if (![c, rsi, mid, up, lo].every(Number.isFinite)) return neutral("BB/RSI missing");

  const half = up - mid;
  const z = half !== 0 ? (c - mid) / half : 0;     // -1..+1 inside band
  const rsiCentered = (rsi - 50) / 50;
  // Range regime boost — ADX<20 makes mean reversion more reliable
  const regimeBoost = Number.isFinite(adx)
    ? (adx < 20 ? 1.0 : adx < 25 ? 0.7 : adx < 30 ? 0.4 : 0.15)
    : 0.5;

  let signal = 0, confidence = 0, reasons = [];
  if (z <= -1 && rsi < 35) {
    // Below lower band, oversold → expect bounce (long)
    signal = 0.4 + 0.4 * (Math.min(1, Math.abs(z) - 1));    // 0.4..0.8
    signal += 0.2 * Math.max(0, (35 - rsi) / 35);            // up to +0.2
    signal *= regimeBoost;
    confidence = Math.min(1, 0.4 + 0.3 * (Math.abs(z) - 1) + regimeBoost * 0.3);
    reasons.push(`Below lower BB (z=${z.toFixed(2)})`, `RSI=${rsi.toFixed(1)} (oversold)`);
  } else if (z >= 1 && rsi > 65) {
    signal = -(0.4 + 0.4 * (Math.min(1, z - 1)));
    signal -= 0.2 * Math.max(0, (rsi - 65) / 35);
    signal *= regimeBoost;
    confidence = Math.min(1, 0.4 + 0.3 * (z - 1) + regimeBoost * 0.3);
    reasons.push(`Above upper BB (z=${z.toFixed(2)})`, `RSI=${rsi.toFixed(1)} (overbought)`);
  } else {
    // Mild partial signal: if RSI is approaching extremes but price isn't there yet
    if (rsi < 30) { signal = 0.15 * regimeBoost; confidence = 0.15; reasons.push(`RSI oversold without BB touch`); }
    else if (rsi > 70) { signal = -0.15 * regimeBoost; confidence = 0.15; reasons.push(`RSI overbought without BB touch`); }
    else return clampSignal({ signal: 0, confidence: 0.05, reasons: ["no extreme detected"] });
  }
  if (reasons.length === 0) reasons.push(`ADX=${adx?.toFixed?.(1) ?? "n/a"}`);
  return clampSignal({ signal, confidence, reasons });
}

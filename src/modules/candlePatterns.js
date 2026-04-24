/**
 * Candle patterns module.
 *   Uses ta.patterns (output of detectAll) — picks the most recent pattern
 *   within the last 3 bars and scores it with trend context.
 */
import { neutral, clampSignal, lastFinite } from "./baseModule.js";

export const meta = Object.freeze({
  id: "candle-patterns",
  name: "Candle Patterns",
  category: "patterns",
  description: "Recent bullish/bearish candle pattern with trend context",
  weight: 0.7,
});

// Which patterns are bullish / bearish reversals / continuations
const BULLISH = new Set([
  "hammer", "bullEngulf", "morningStar", "piercingLine", "tweezerBottom", "insideBullBreak",
]);
const BEARISH = new Set([
  "shootingStar", "bearEngulf", "eveningStar", "darkCloudCover", "tweezerTop", "insideBearBreak",
]);

// Reversal patterns score higher when they fire AGAINST the prevailing trend
// (otherwise they're mostly noise).
function patternScore(name, trend) {
  if (BULLISH.has(name)) {
    return trend === "down" ? 0.7 : trend === "range" ? 0.45 : 0.25;
  }
  if (BEARISH.has(name)) {
    return trend === "up" ? 0.7 : trend === "range" ? 0.45 : 0.25;
  }
  return 0.2;
}

export function evaluate(ta, ctx = {}) {
  const lookback = ctx.lookback ?? 3;
  const pats = Array.isArray(ta.patterns) ? ta.patterns : [];
  if (pats.length === 0) return neutral("no patterns");
  const lastIdx = (ta.close?.length ?? 1) - 1;

  // Find the most recent pattern bar
  let recent = null;
  for (let i = pats.length - 1; i >= 0; i--) {
    const p = pats[i];
    if (!Number.isInteger(p?.i)) continue;
    if (lastIdx - p.i <= lookback) { recent = p; break; }
    break;
  }
  if (!recent || !Array.isArray(recent.patterns) || recent.patterns.length === 0) {
    return clampSignal({ signal: 0, confidence: 0.05, reasons: ["no recent patterns"] });
  }

  const trend = ta.trend || ta.summary?.trend || "range";
  // Score each pattern; pick strongest
  let bestName = recent.patterns[0];
  let bestScore = patternScore(bestName, trend);
  let bestDir = BULLISH.has(bestName) ? 1 : BEARISH.has(bestName) ? -1 : 0;
  for (const name of recent.patterns) {
    const s = patternScore(name, trend);
    if (s > bestScore) {
      bestScore = s;
      bestName = name;
      bestDir = BULLISH.has(name) ? 1 : BEARISH.has(name) ? -1 : 0;
    }
  }
  if (bestDir === 0) return neutral("pattern not directional");

  const age = lastIdx - recent.i;
  const recencyBoost = age === 0 ? 0.15 : age === 1 ? 0.08 : 0;
  const signal = bestDir * Math.min(1, bestScore + recencyBoost);
  const confidence = Math.min(1, bestScore * 0.9 + recencyBoost);
  return clampSignal({
    signal, confidence,
    reasons: [
      `${bestName} (${bestDir > 0 ? "bullish" : "bearish"})`,
      `trend=${trend}`,
      `${age} bar${age === 1 ? "" : "s"} ago`,
    ],
    payload: { pattern: bestName, at: recent.i },
  });
}

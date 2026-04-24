/**
 * Breakout module.
 *   Uses detected BoS / CHoCH from ta.breaks within the last N bars.
 *   Volume expansion confirmation (last bar > 1.5× sma(vol,20)).
 */
import { neutral, clampSignal, lastFinite, num } from "./baseModule.js";

export const meta = Object.freeze({
  id: "breakout",
  name: "Breakout",
  category: "structure",
  description: "Recent BoS/CHoCH with volume confirmation",
  weight: 1.1,
});

function smaLast(arr, period = 20) {
  if (!arr || !Number.isInteger(arr.length) || arr.length === 0) return NaN;
  const n = Math.min(period, arr.length);
  let s = 0, c = 0;
  for (let i = arr.length - n; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isFinite(v)) { s += v; c++; }
  }
  return c > 0 ? s / c : NaN;
}

export function evaluate(ta, ctx = {}) {
  const lookback = ctx.lookback ?? 10;
  const breaks = Array.isArray(ta.breaks) ? ta.breaks : [];
  if (breaks.length === 0) return neutral("no structural breaks");
  const lastIdx = (ta.close?.length ?? 1) - 1;

  // Find most recent break within lookback
  let recent = null;
  for (let i = breaks.length - 1; i >= 0; i--) {
    const b = breaks[i];
    if (!Number.isInteger(b.i)) continue;
    if (lastIdx - b.i <= lookback) { recent = b; break; }
    break;
  }
  if (!recent) return clampSignal({ signal: 0, confidence: 0.05, reasons: [`no break in last ${lookback} bars`] });

  // Direction
  const dir = (recent.dir === "up" || /up/i.test(recent.type || "")) ? 1
            : (recent.dir === "down" || /down/i.test(recent.type || "")) ? -1
            : 0;
  if (dir === 0) return neutral("break direction unknown");

  // Volume confirmation at the break bar
  const vol = ta.volume?.[recent.i];
  const vsma = smaLast(ta.volume?.slice(0, recent.i + 1) || [], 20);
  const volRel = num(vol / (vsma || 1), 1);
  const volBoost = volRel >= 2 ? 0.3 : volRel >= 1.5 ? 0.2 : volRel >= 1.2 ? 0.1 : 0;

  // Recency boost — fresher breaks more reliable
  const age = lastIdx - recent.i;
  const recencyBoost = age <= 2 ? 0.25 : age <= 5 ? 0.15 : 0.05;

  // Is it a CHoCH (reversal) or a plain BoS?
  const isChoch = /CHoCH/i.test(recent.type || "");

  const base = isChoch ? 0.4 : 0.5;
  const signal = dir * Math.min(1, base + volBoost + recencyBoost);
  const confidence = Math.min(1, base + volBoost + recencyBoost * 0.8);

  return clampSignal({
    signal, confidence,
    reasons: [
      `${recent.type || "break"} ${dir > 0 ? "up" : "down"}`,
      `${age} bar${age === 1 ? "" : "s"} ago`,
      `volume ${volRel.toFixed(2)}× avg`,
    ],
    payload: { break: recent, volRel },
  });
}

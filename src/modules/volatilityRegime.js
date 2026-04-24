/**
 * Volatility regime module.
 *   Not directional on its own — returns a small bias when:
 *     - BB squeeze detected (low vol → breakout pending): amplifies direction
 *       from MACD hist sign.
 *     - Vol expansion (BB width > rolling avg): confidence drops.
 */
import { neutral, clampSignal, lastFinite } from "./baseModule.js";

export const meta = Object.freeze({
  id: "volatility-regime",
  name: "Volatility Regime",
  category: "volatility",
  description: "BB squeeze and ATR expansion context",
  weight: 0.7,
});

function smaArr(arr, lookback = 20) {
  if (!arr || !Number.isInteger(arr.length) || arr.length < 2) return NaN;
  const n = Math.min(lookback, arr.length);
  let s = 0, c = 0;
  for (let i = arr.length - n; i < arr.length; i++) {
    if (Number.isFinite(arr[i])) { s += arr[i]; c++; }
  }
  return c > 0 ? s / c : NaN;
}

export function evaluate(ta) {
  const c = lastFinite(ta.close);
  const mid = lastFinite(ta.bb_20_2?.mid);
  const up  = lastFinite(ta.bb_20_2?.up);
  const lo  = lastFinite(ta.bb_20_2?.lo);
  const atr = lastFinite(ta.atr14);
  const histArr = ta.macd_12_26_9?.hist || [];
  const hist = lastFinite(histArr);
  if (![c, mid, up, lo].every(Number.isFinite)) return neutral("BB missing");
  const width = (up - lo) / (mid || 1);
  // Build a rolling BB-width to detect squeeze
  const widthHist = [];
  const bbMid = ta.bb_20_2?.mid, bbUp = ta.bb_20_2?.up, bbLo = ta.bb_20_2?.lo;
  if (bbMid && bbUp && bbLo && Number.isInteger(bbMid.length)) {
    const n = bbMid.length;
    for (let i = 0; i < n; i++) {
      const m = bbMid[i], u = bbUp[i], l = bbLo[i];
      if (Number.isFinite(m) && Number.isFinite(u) && Number.isFinite(l) && m !== 0) {
        widthHist.push((u - l) / m);
      }
    }
  }
  const widthAvg = smaArr(widthHist, 50);
  const squeeze = Number.isFinite(widthAvg) && width < widthAvg * 0.7;
  const expansion = Number.isFinite(widthAvg) && width > widthAvg * 1.3;

  if (squeeze) {
    const dir = Number.isFinite(hist) ? Math.sign(hist) : 0;
    return clampSignal({
      signal: dir * 0.25,
      confidence: dir !== 0 ? 0.3 : 0.1,
      reasons: [
        `BB squeeze (width ${width.toFixed(4)} vs avg ${widthAvg.toFixed(4)})`,
        dir !== 0 ? `MACD hist hints ${dir > 0 ? "bullish" : "bearish"} expansion` : "no direction hint",
      ],
      payload: { squeeze: true, width, widthAvg },
    });
  }
  if (expansion) {
    return clampSignal({
      signal: 0,
      confidence: 0.1,
      reasons: [
        `BB expansion (width ${width.toFixed(4)})`,
        "signals less reliable under high vol",
      ],
      payload: { expansion: true, width, widthAvg },
    });
  }
  return clampSignal({ signal: 0, confidence: 0.15, reasons: [`Normal volatility (BB width ${width.toFixed(4)})`] });
}

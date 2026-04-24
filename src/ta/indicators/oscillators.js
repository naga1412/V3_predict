/**
 * Oscillators: RSI (Wilder), MACD, Stochastic %K/%D, ROC.
 */
import { ema } from "./moving.js";
import { WilderState } from "../math.js";

/** Wilder RSI. Returns Float64Array aligned with input. */
export function rsi(values, period = 14) {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < 2) return out;
  const gainS = new WilderState(period);
  const lossS = new WilderState(period);
  let prev = +values[0];
  for (let i = 1; i < n; i++) {
    const ch = +values[i] - prev;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    const avgG = gainS.next(g);
    const avgL = lossS.next(l);
    if (Number.isFinite(avgG) && Number.isFinite(avgL)) {
      if (avgL === 0) out[i] = 100;
      else {
        const rs = avgG / avgL;
        out[i] = 100 - 100 / (1 + rs);
      }
    }
    prev = +values[i];
  }
  return out;
}

/**
 * MACD: returns {macd, signal, hist} each as Float64Array.
 * Classic params: 12 / 26 / 9.
 */
export function macd(values, fast = 12, slow = 26, signalP = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const n = values.length;
  const macdArr = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(ef[i]) && Number.isFinite(es[i])) macdArr[i] = ef[i] - es[i];
  }
  // Signal is EMA of MACD (only over defined region, preserving alignment).
  const sigRaw = macdArr.map(x => Number.isFinite(x) ? x : 0);
  const sig = ema(sigRaw, signalP);
  const signal = new Float64Array(n).fill(NaN);
  const hist   = new Float64Array(n).fill(NaN);
  // Signal is meaningful only after slow-1 + signalP-1 bars.
  const warm = slow - 1 + signalP - 1;
  for (let i = 0; i < n; i++) {
    if (i >= warm && Number.isFinite(sig[i]) && Number.isFinite(macdArr[i])) {
      signal[i] = sig[i];
      hist[i]   = macdArr[i] - sig[i];
    }
  }
  return { macd: macdArr, signal, hist };
}

/**
 * Stochastic oscillator.
 *   %K = (close - lowestLow) / (highestHigh - lowestLow) * 100
 *   %D = SMA(%K, dPeriod)
 * Uses naïve rolling max/min here (kPeriod is small; O(N) fine).
 */
export function stochastic(high, low, close, kPeriod = 14, dPeriod = 3) {
  const n = close.length;
  const k = new Float64Array(n).fill(NaN);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j]  < ll) ll = low[j];
    }
    const denom = hh - ll;
    k[i] = denom === 0 ? 50 : ((close[i] - ll) / denom) * 100;
  }
  // %D
  const d = new Float64Array(n).fill(NaN);
  for (let i = kPeriod + dPeriod - 2; i < n; i++) {
    let s = 0, c = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) {
      if (Number.isFinite(k[j])) { s += k[j]; c++; }
    }
    if (c === dPeriod) d[i] = s / dPeriod;
  }
  return { k, d };
}

/** Rate of change as percent: (price - price[n]) / price[n] * 100. */
export function roc(values, period = 10) {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    const a = +values[i];
    const b = +values[i - period];
    if (b !== 0) out[i] = ((a - b) / b) * 100;
  }
  return out;
}

/**
 * Commodity Channel Index (CCI).
 *   typical = (H + L + C) / 3
 *   SMA(tp, n)  — n-period simple moving average
 *   MD  = mean(|tp[i] - SMA[i]|)  over n
 *   CCI = (tp - SMA) / (0.015 * MD)
 *
 * Default period 20. Constant 0.015 per Lambert.
 */
export function cci(high, low, close, period = 20, k = 0.015) {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  if (n === 0) return out;
  const tp = new Float64Array(n);
  for (let i = 0; i < n; i++) tp[i] = (high[i] + low[i] + close[i]) / 3;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += tp[i];
    if (i >= period) sum -= tp[i - period];
    if (i >= period - 1) {
      const sma = sum / period;
      let md = 0;
      for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j] - sma);
      md /= period;
      out[i] = md === 0 ? 0 : (tp[i] - sma) / (k * md);
    }
  }
  return out;
}

/**
 * Williams %R.
 *   %R = (highestHigh - close) / (highestHigh - lowestLow) * -100
 * Oscillates in [-100, 0]; -20 = overbought, -80 = oversold.
 */
export function williamsR(high, low, close, period = 14) {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (high[j] > hh) hh = high[j];
      if (low[j]  < ll) ll = low[j];
    }
    const denom = hh - ll;
    out[i] = denom === 0 ? -50 : ((hh - close[i]) / denom) * -100;
  }
  return out;
}

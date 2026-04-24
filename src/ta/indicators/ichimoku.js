/**
 * Ichimoku Kinkō Hyō.
 *
 *   Tenkan-sen (Conversion)  = (highest high + lowest low) / 2  over  tenkan  periods
 *   Kijun-sen  (Base)        = (highest high + lowest low) / 2  over  kijun   periods
 *   Senkou A   (Lead A)      = (Tenkan + Kijun) / 2            — plotted `shift` bars ahead
 *   Senkou B   (Lead B)      = (highest high + lowest low) / 2  over  senkouB — plotted `shift` bars ahead
 *   Chikou     (Lag)         = close                            — plotted `shift` bars behind
 *
 * We align every series to the input length. Senkou A/B are *shifted forward* —
 * the value at index `i` represents the cloud for bar i (computed from data `shift` bars earlier).
 * Chikou at index `i` is the close from `i+shift` bars (NaN for the last `shift`).
 *
 * Classic params: 9 / 26 / 52 / 26.
 */
export function ichimoku(high, low, close, {
  tenkan = 9, kijun = 26, senkouB = 52, shift = 26,
} = {}) {
  const n = close.length;
  const tenkanArr  = new Float64Array(n).fill(NaN);
  const kijunArr   = new Float64Array(n).fill(NaN);
  const senkouAArr = new Float64Array(n).fill(NaN);
  const senkouBArr = new Float64Array(n).fill(NaN);
  const chikouArr  = new Float64Array(n).fill(NaN);

  const mid = (p) => {
    const out = new Float64Array(n).fill(NaN);
    for (let i = p - 1; i < n; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - p + 1; j <= i; j++) {
        if (high[j] > hh) hh = high[j];
        if (low[j]  < ll) ll = low[j];
      }
      out[i] = (hh + ll) / 2;
    }
    return out;
  };

  const t = mid(tenkan);
  const k = mid(kijun);
  const b = mid(senkouB);
  for (let i = 0; i < n; i++) {
    tenkanArr[i] = t[i];
    kijunArr[i]  = k[i];
  }
  // Senkou A/B are shifted forward: value[i] = source[i - shift]
  for (let i = shift; i < n; i++) {
    if (Number.isFinite(t[i - shift]) && Number.isFinite(k[i - shift])) {
      senkouAArr[i] = (t[i - shift] + k[i - shift]) / 2;
    }
    if (Number.isFinite(b[i - shift])) senkouBArr[i] = b[i - shift];
  }
  // Chikou is close shifted backward: value[i] = close[i + shift]
  for (let i = 0; i < n - shift; i++) chikouArr[i] = close[i + shift];

  return {
    tenkan: tenkanArr,
    kijun:  kijunArr,
    senkouA: senkouAArr,
    senkouB: senkouBArr,
    chikou: chikouArr,
  };
}

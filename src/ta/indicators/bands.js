/**
 * Bollinger Bands (SMA ± k * stdev).
 */
import { RollingWindow } from "../math.js";

export function bbands(values, period = 20, k = 2) {
  const n = values.length;
  const mid = new Float64Array(n).fill(NaN);
  const up  = new Float64Array(n).fill(NaN);
  const lo  = new Float64Array(n).fill(NaN);
  const w = new RollingWindow(period);
  for (let i = 0; i < n; i++) {
    w.push(+values[i]);
    if (w.filled) {
      const m = w.mean();
      const sd = w.stdev();
      mid[i] = m;
      up[i]  = m + k * sd;
      lo[i]  = m - k * sd;
    }
  }
  return { mid, up, lo };
}

/** Keltner Channels: EMA ± k * ATR.  Needs atr array already computed. */
export function keltner(ema, atr, k = 2) {
  const n = ema.length;
  const up = new Float64Array(n).fill(NaN);
  const lo = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(ema[i]) && Number.isFinite(atr[i])) {
      up[i] = ema[i] + k * atr[i];
      lo[i] = ema[i] - k * atr[i];
    }
  }
  return { mid: ema, up, lo };
}

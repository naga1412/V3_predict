/**
 * ATR (Average True Range) and ADX (Average Directional Index).
 * Wilder smoothing throughout.
 */
import { WilderState, trueRange } from "../math.js";

export function atr(high, low, close, period = 14) {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < 2) return out;
  const s = new WilderState(period);
  let prev = +close[0];
  for (let i = 1; i < n; i++) {
    const tr = trueRange(+high[i], +low[i], prev);
    const v = s.next(tr);
    if (Number.isFinite(v)) out[i] = v;
    prev = +close[i];
  }
  return out;
}

/**
 * ADX / +DI / -DI  (Wilder).
 * period: typical 14.
 */
export function adx(high, low, close, period = 14) {
  const n = close.length;
  const plusDI  = new Float64Array(n).fill(NaN);
  const minusDI = new Float64Array(n).fill(NaN);
  const adxOut  = new Float64Array(n).fill(NaN);
  if (n < 2) return { adx: adxOut, plusDI, minusDI };

  const trS   = new WilderState(period);
  const plusS = new WilderState(period);
  const minS  = new WilderState(period);
  const dxS   = new WilderState(period);

  let prevClose = +close[0], prevHigh = +high[0], prevLow = +low[0];

  for (let i = 1; i < n; i++) {
    const upMove   = +high[i] - prevHigh;
    const downMove = prevLow - +low[i];
    const plusDM   = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM  = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr       = trueRange(+high[i], +low[i], prevClose);

    const trV = trS.next(tr);
    const pV  = plusS.next(plusDM);
    const mV  = minS.next(minusDM);

    if (Number.isFinite(trV) && trV > 0) {
      plusDI[i]  = (pV / trV) * 100;
      minusDI[i] = (mV / trV) * 100;
      const sum = plusDI[i] + minusDI[i];
      const dx = sum === 0 ? 0 : (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100;
      const adxV = dxS.next(dx);
      if (Number.isFinite(adxV)) adxOut[i] = adxV;
    }
    prevClose = +close[i]; prevHigh = +high[i]; prevLow = +low[i];
  }
  return { adx: adxOut, plusDI, minusDI };
}

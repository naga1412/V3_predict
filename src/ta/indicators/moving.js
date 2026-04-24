/**
 * Moving averages: SMA, EMA, WMA, DEMA, TEMA.
 * Pure — returns a Float64Array aligned with input length, NaN during warm-up.
 */
import { EMAState, RollingWindow } from "../math.js";

export function sma(values, period) {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  const w = new RollingWindow(period);
  for (let i = 0; i < n; i++) {
    w.push(+values[i]);
    if (w.filled) out[i] = w.mean();
  }
  return out;
}

export function ema(values, period) {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  const s = new EMAState(period);
  for (let i = 0; i < n; i++) out[i] = s.next(+values[i]);
  return out;
}

/** Weighted moving average: weights 1..period. */
export function wma(values, period) {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i++) {
    let s = 0;
    for (let k = 0; k < period; k++) s += (+values[i - period + 1 + k]) * (k + 1);
    out[i] = s / denom;
  }
  return out;
}

export function dema(values, period) {
  const e1 = ema(values, period);
  const e2 = ema(e1.map(x => Number.isFinite(x) ? x : 0), period);
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(e1[i]) && Number.isFinite(e2[i])) out[i] = 2 * e1[i] - e2[i];
  }
  return out;
}

export function tema(values, period) {
  const e1 = ema(values, period);
  const e2 = ema(e1.map(x => Number.isFinite(x) ? x : 0), period);
  const e3 = ema(e2.map(x => Number.isFinite(x) ? x : 0), period);
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(e1[i]) && Number.isFinite(e2[i]) && Number.isFinite(e3[i])) {
      out[i] = 3 * e1[i] - 3 * e2[i] + e3[i];
    }
  }
  return out;
}

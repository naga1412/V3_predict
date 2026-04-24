/**
 * Volume-based indicators: VWAP (anchored), OBV, CMF.
 *
 * VWAP is anchored to session starts we don't really have for crypto (24/7).
 * We support two modes:
 *   - "rolling": rolling window of `period` bars   (good for intraday)
 *   - "anchored": reset at each UTC day boundary   (traditional VWAP)
 */

function typicalPrice(h, l, c) { return (h + l + c) / 3; }

export function vwap(high, low, close, volume, { mode = "rolling", period = 20, anchorMs = 86_400_000, t } = {}) {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  if (mode === "rolling") {
    let pvSum = 0, vSum = 0;
    const pvBuf = [];
    const vBuf  = [];
    for (let i = 0; i < n; i++) {
      const tp = typicalPrice(high[i], low[i], close[i]);
      const pv = tp * volume[i];
      pvBuf.push(pv); vBuf.push(volume[i]);
      pvSum += pv;    vSum += volume[i];
      if (pvBuf.length > period) {
        pvSum -= pvBuf.shift();
        vSum  -= vBuf.shift();
      }
      if (pvBuf.length === period && vSum > 0) out[i] = pvSum / vSum;
    }
    return out;
  }
  // anchored
  if (!t) throw new Error("anchored VWAP requires `t` timestamps");
  let pvAcc = 0, vAcc = 0, curAnchor = Math.floor(t[0] / anchorMs);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(t[i] / anchorMs);
    if (a !== curAnchor) { pvAcc = 0; vAcc = 0; curAnchor = a; }
    pvAcc += typicalPrice(high[i], low[i], close[i]) * volume[i];
    vAcc  += volume[i];
    if (vAcc > 0) out[i] = pvAcc / vAcc;
  }
  return out;
}

/** On-Balance Volume. Cumulative; first value = 0. */
export function obv(close, volume) {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  if (!n) return out;
  out[0] = 0;
  for (let i = 1; i < n; i++) {
    let v = out[i - 1];
    if (close[i] > close[i - 1]) v += volume[i];
    else if (close[i] < close[i - 1]) v -= volume[i];
    out[i] = v;
  }
  return out;
}

/** Chaikin Money Flow, period typically 20. */
export function cmf(high, low, close, volume, period = 20) {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  const mfvBuf = [];
  const vBuf = [];
  let mfvSum = 0, vSum = 0;
  for (let i = 0; i < n; i++) {
    const rng = high[i] - low[i];
    const mfm = rng === 0 ? 0 : ((close[i] - low[i]) - (high[i] - close[i])) / rng;
    const mfv = mfm * volume[i];
    mfvBuf.push(mfv); vBuf.push(volume[i]);
    mfvSum += mfv;    vSum += volume[i];
    if (mfvBuf.length > period) {
      mfvSum -= mfvBuf.shift();
      vSum   -= vBuf.shift();
    }
    if (mfvBuf.length === period && vSum > 0) out[i] = mfvSum / vSum;
  }
  return out;
}

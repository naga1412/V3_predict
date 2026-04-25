/**
 * My Next Prediction v3.0 — Phase 11 · Ghost Candles
 * --------------------------------------------------
 * Forward-projected candlestick forecast with conformal-derived uncertainty.
 *
 * Given the current TA snapshot and the Phase-7 orchestrator output (bias,
 * probability), we walk `nBars` steps forward.  For each step we compute:
 *
 *   drift_i     =  direction * |bias| * ATR * decay(i)
 *   uncert_i    =  conformal half-width if available, else ATR * k * sqrt(i+1)
 *   close_i     =  close_{i-1} + drift_i
 *   open_i      =  close_{i-1}
 *   high_i      =  max(open_i, close_i) + 0.45 * ATR
 *   low_i       =  min(open_i, close_i) - 0.45 * ATR
 *   lo_i / hi_i =  close_i ± uncert_i
 *
 * Drift decays with `exp(-λ·i)` so far-horizon ghosts cluster toward flat.
 * Uncertainty grows with sqrt(i+1) (Brownian-motion-style path spread).
 *
 * The module is pure (no DOM, no window), so both the UI and any worker
 * scheduler can call it.  Persistence / caching is the caller's problem.
 *
 * Consumers (App.jsx ChartPane) render each ghost as a faded candle using
 * lightweight-charts' secondary candlestick series.  The ribbon of (lo, hi)
 * values is drawn as two dashed line series.
 */

/* ═══════════════════════════ Pure helpers ═══════════════════════════ */

/**
 * Estimate the bar interval (seconds) from a candle array.
 * Falls back to 60 s on degenerate input.  Accepts candles with a `time`
 * field in **UTC seconds** or `t` in **ms**.
 */
export function inferTfSeconds(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return 60;
  const getT = (c) => {
    if (!c) return NaN;
    if (Number.isFinite(c.time)) return c.time;
    if (Number.isFinite(c.t))    return Math.floor(c.t / 1000);
    return NaN;
  };
  // Use median of last up-to-10 deltas for robustness against one-off gaps.
  const deltas = [];
  const end = candles.length - 1;
  const start = Math.max(1, end - 10);
  for (let i = start; i <= end; i++) {
    const dt = getT(candles[i]) - getT(candles[i - 1]);
    if (Number.isFinite(dt) && dt > 0) deltas.push(dt);
  }
  if (!deltas.length) return 60;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] || 60;
}

/**
 * Return the last candle's close-time in UTC seconds.
 */
export function lastCandleTime(candles) {
  if (!Array.isArray(candles) || !candles.length) return NaN;
  const c = candles[candles.length - 1];
  if (Number.isFinite(c?.time)) return c.time;
  if (Number.isFinite(c?.t))    return Math.floor(c.t / 1000);
  return NaN;
}

/* ═══════════════════════════ Core forecaster ═══════════════════════════ */

/**
 * @typedef {Object} GhostBar
 * @property {number} time   UTC seconds (projected)
 * @property {number} o      open
 * @property {number} h      high
 * @property {number} l      low
 * @property {number} c      close (point forecast)
 * @property {number} lo     conformal lower bound on close
 * @property {number} hi     conformal upper bound on close
 * @property {number} width  hi - lo
 */

/**
 * @typedef {Object} GhostForecast
 * @property {GhostBar[]} bars
 * @property {number} tfSec          bar interval used
 * @property {number} anchorTime     time of last real candle (UTC seconds)
 * @property {number} anchorClose    close of last real candle
 * @property {number} atr            ATR used for step magnitude
 * @property {number} direction      +1 long / -1 short / 0 flat
 * @property {number} bias           clamped bias in [-1, +1]
 * @property {number} confidence     orch.confidence passthrough (0..1)
 * @property {boolean} usedConformal true if a calibrated SplitConformalRegressor was used
 * @property {number} alpha          miscoverage level (0..1)
 * @property {number} lambda         drift decay used
 */

/**
 * Build `nBars` forward-projected candles.
 *
 * @param {object} ta   TAEngine snapshot (needs ta.close[] and ta.atr14[])
 * @param {object} orch Orchestrator output (uses rawScore / probability / confidence)
 * @param {object} [opts]
 * @param {number} [opts.nBars=25]    how many ghost bars to project (capped at 64)
 * @param {number} [opts.alpha=0.1]   target miscoverage (0.1 → 90% interval)
 * @param {object} [opts.conformal]   optional SplitConformalRegressor instance
 *                                    (must expose .interval(yhat) → {lo, hi})
 * @param {Array}  [opts.candles]     bar history (used for tfSec + anchor time)
 * @param {number} [opts.lambda=0.18] drift decay per step (exp(-λ·i))
 * @param {number} [opts.bandK=1.25]  fallback uncertainty = bandK * ATR * sqrt(i+1)
 * @param {number} [opts.patternBias] recent candlestick-pattern bias in [-1,+1]
 *                                    (>0 = bullish, <0 = bearish, |.| = strength).
 *                                    Boosts/dampens the FIRST ghost bar's drift
 *                                    when sign matches/conflicts with the
 *                                    orchestrator direction.  Capped at ±0.5.
 * @returns {GhostForecast|null}
 */
export function predictGhostCandles(ta, orch, opts = {}) {
  if (!ta || ta.empty) return null;
  const close = ta.close;
  if (!Array.isArray(close) && !(close instanceof Float64Array)) return null;
  if (!close || close.length < 2) return null;

  const atrArr = ta.atr14;
  const atr = Array.isArray(atrArr) || atrArr instanceof Float64Array
    ? atrArr[atrArr.length - 1]
    : atrArr;
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const {
    nBars = 25,
    alpha = 0.1,
    conformal = null,
    candles = null,
    lambda = 0.18,
    bandK = 1.25,
    patternBias = 0,
  } = opts;

  // Prefer the provided candle array's last close so that (anchorTime,
  // anchorClose) are consistent — e.g. when the caller passes a candles
  // array that includes a forming bar that the TA snapshot did not see.
  let lastClose = close[close.length - 1];
  if (Array.isArray(candles) && candles.length) {
    const lastC = candles[candles.length - 1];
    const candClose = Number(lastC?.c ?? lastC?.close);
    if (Number.isFinite(candClose)) lastClose = candClose;
  }
  if (!Number.isFinite(lastClose)) return null;

  const n = Math.max(1, Math.min(64, Math.floor(nBars)));
  const bias = Math.max(-1, Math.min(1, orch?.rawScore ?? (orch?.probability != null ? (orch.probability * 2 - 1) : 0)));
  const direction = bias > 1e-6 ? +1 : bias < -1e-6 ? -1 : 0;
  const confidence = Number.isFinite(orch?.confidence) ? orch.confidence : Math.abs(bias);

  // Pattern injection: scale the FIRST ghost bar's drift if a recent
  // candlestick pattern aligns or conflicts with the orchestrator bias.
  // - Aligned (same sign):  drift_0 *= (1 + 0.5·|patternBias|)
  // - Conflicting:           drift_0 *= max(0.4, 1 − 0.5·|patternBias|)
  // - No pattern (0) or no direction: pass-through.
  // Subsequent bars are NOT amplified — patterns lose predictive power
  // beyond the next bar.
  const pBias = Math.max(-1, Math.min(1, Number.isFinite(patternBias) ? patternBias : 0));
  let firstBarBoost = 1;
  if (direction !== 0 && Math.abs(pBias) > 1e-6) {
    const aligned = (Math.sign(pBias) === direction);
    firstBarBoost = aligned
      ? 1 + 0.5 * Math.abs(pBias)
      : Math.max(0.4, 1 - 0.5 * Math.abs(pBias));
  }

  // Infer TF + anchor from candle array if provided; else fall back to 60 s / now.
  const tfSec = inferTfSeconds(candles || []);
  const anchorTime = candles && candles.length ? lastCandleTime(candles) : Math.floor(Date.now() / 1000);

  // If a calibrated conformal regressor is available and has a finite q, use it.
  // Coverage is 1-α; we scale q by sqrt(i+1) to mimic horizon spread.
  const hasConformal = !!(conformal && typeof conformal.interval === "function" &&
                          Number.isFinite(conformal.q) && conformal.q !== Infinity);

  const bars = [];
  let prevClose = lastClose;
  for (let i = 0; i < n; i++) {
    // Per-step drift: |bias| * ATR, shrinking with horizon.  First bar
    // can be amplified/dampened by `firstBarBoost` (pattern injection).
    const decay = Math.exp(-lambda * i);
    const localBoost = i === 0 ? firstBarBoost : 1;
    const stepMag = Math.abs(bias) * atr * decay * localBoost;
    const c = prevClose + direction * stepMag;
    const o = prevClose;
    const body = 0.45 * atr * decay;
    const h = Math.max(o, c) + body;
    const l = Math.min(o, c) - body;

    let lo, hi;
    if (hasConformal) {
      // Use the calibrated interval on the point forecast, widened by √(i+1)
      const { lo: pLo, hi: pHi } = conformal.interval(c);
      const half = Math.max(0, (pHi - pLo) / 2) * Math.sqrt(i + 1);
      lo = c - half;
      hi = c + half;
    } else {
      const half = bandK * atr * Math.sqrt(i + 1);
      lo = c - half;
      hi = c + half;
    }

    bars.push({
      time: anchorTime + tfSec * (i + 1),
      o, h, l, c,
      lo, hi,
      width: hi - lo,
    });
    prevClose = c;
  }

  return {
    bars,
    tfSec,
    anchorTime,
    anchorClose: lastClose,
    atr,
    direction,
    bias,
    confidence,
    usedConformal: hasConformal,
    alpha,
    lambda,
    patternBias: pBias,
    firstBarBoost,
  };
}

/* ═══════════════════════════ Convenience serializers ═══════════════════════════ */

/**
 * Convert a GhostForecast into the arrays lightweight-charts' series expect.
 * Returns three arrays:
 *   - candleData : [{time, open, high, low, close}]
 *   - upperBand  : [{time, value}]   hi
 *   - lowerBand  : [{time, value}]   lo
 *
 * Time is already in UTC seconds; the caller just passes each array to
 * setData() on its corresponding series.
 */
export function toChartSeriesData(forecast) {
  if (!forecast || !Array.isArray(forecast.bars)) {
    return { candleData: [], upperBand: [], lowerBand: [], pointLine: [] };
  }
  const candleData = new Array(forecast.bars.length);
  const upperBand  = new Array(forecast.bars.length);
  const lowerBand  = new Array(forecast.bars.length);
  const pointLine  = new Array(forecast.bars.length);
  for (let i = 0; i < forecast.bars.length; i++) {
    const b = forecast.bars[i];
    candleData[i] = { time: b.time, open: b.o, high: b.h, low: b.l, close: b.c };
    upperBand[i]  = { time: b.time, value: b.hi };
    lowerBand[i]  = { time: b.time, value: b.lo };
    pointLine[i]  = { time: b.time, value: b.c };
  }
  return { candleData, upperBand, lowerBand, pointLine };
}

/**
 * Compact, JSON-safe summary for the sidebar/UI.
 */
export function summarizeForecast(forecast) {
  if (!forecast) return null;
  const last = forecast.bars[forecast.bars.length - 1];
  const first = forecast.bars[0];
  if (!last || !first) return null;
  return {
    horizon: forecast.bars.length,
    tfSec: forecast.tfSec,
    anchorClose: forecast.anchorClose,
    firstClose: first.c,
    finalClose: last.c,
    expectedMove: last.c - forecast.anchorClose,
    expectedMovePct: forecast.anchorClose ? (last.c - forecast.anchorClose) / forecast.anchorClose : 0,
    finalLo: last.lo,
    finalHi: last.hi,
    finalWidth: last.width,
    widthFirst: first.width,
    widthLast: last.width,
    direction: forecast.direction,
    bias: forecast.bias,
    confidence: forecast.confidence,
    usedConformal: forecast.usedConformal,
    alpha: forecast.alpha,
  };
}

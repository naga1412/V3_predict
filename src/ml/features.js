/**
 * My Next Prediction v3.0 — Feature extraction
 * --------------------------------------------
 * Turns a TAEngine snapshot into a per-bar feature vector suitable for the
 * Phase-7 NN. Feature order is fixed and versioned — any change bumps
 * FEATURE_VERSION so downstream caches (featureStore, trainingPool) can
 * invalidate.
 *
 * Design goals:
 *   - Deterministic, order-preserving
 *   - All features either dimensionless (ratios, z-scores) or near-stationary
 *   - NaN/Infinity fully sanitized to 0 at the edge
 *   - Single-pass over bars (O(n·d))
 */

export const FEATURE_VERSION = 1;

/**
 * The ordered list of feature names (the columns). Keep names snake_case.
 * Any new feature must be APPENDED (never inserted in the middle) to
 * preserve backwards-compat with cached datasets.
 */
export const FEATURE_NAMES = Object.freeze([
  // Price / returns
  "ret_1", "ret_5", "ret_20",
  "log_range",            // log((h-l)/c)
  "body_frac",            // (c-o) / (h-l)
  "upper_wick_frac",      // (h - max(o,c)) / (h-l)
  "lower_wick_frac",      // (min(o,c) - l) / (h-l)
  // Moving-average context (distance in %)
  "d_ema20", "d_ema50", "d_ema200",
  "ema20_slope",          // (ema20[i] - ema20[i-5]) / ema20[i]
  // Oscillators
  "rsi14",                // scaled to [-1,+1] as (rsi-50)/50
  "macd_hist_rel",        // macd_hist / close
  "stoch_k", "stoch_d",   // scaled to [-1,+1]
  // Bands / volatility
  "bb_pos",               // (close - mid) / (up - mid), clamped
  "bb_width_rel",         // (up-lo)/mid
  "atr_rel",              // atr14 / close
  "adx14",                // /100
  "plusDI_minusDI",       // (plusDI - minusDI) / 100
  // Volume
  "vol_rel",              // vol[i] / sma(vol,20)
  "obv_slope",            // (obv[i]-obv[i-20])/max(1,|obv[i-20]|)
  "cmf20",                // already in [-1,+1]
  "roc10",                // roc10/100
  // Structure (SMC)
  "trend_up", "trend_dn", // 0/1 one-hot of currentTrend
  "break_recent",         // 1 if a BoS/CHoCH in last 10 bars, else 0
  "fvg_open_rel",         // #open FVGs / 10, clamped [0,1]
  "ob_open_rel",          // #open OBs / 10, clamped
  "zone_premium", "zone_discount", // one-hot from premiumDiscount.lastZone
  // Sessions
  "sess_asia", "sess_london", "sess_ny_am", "sess_ny_pm",
  // Meta
  "time_of_day",          // hour/24
  "day_of_week",          // dow/6
]);

const FEATURE_COUNT = FEATURE_NAMES.length;
export { FEATURE_COUNT };

// ─── helpers ────────────────────────────────────────────────────────
function safe(x) { return Number.isFinite(x) ? x : 0; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function ema(close, prev, period) {
  // Used for slope fallback; prefer ta output when available.
  if (!Number.isFinite(close)) return prev;
  const k = 2 / (period + 1);
  if (!Number.isFinite(prev)) return close;
  return prev + k * (close - prev);
}

function sma(arr, i, period) {
  const start = Math.max(0, i - period + 1);
  let s = 0, n = 0;
  for (let k = start; k <= i; k++) {
    const v = arr[k];
    if (Number.isFinite(v)) { s += v; n++; }
  }
  return n > 0 ? s / n : NaN;
}

/**
 * Build feature matrix from a TAEngine output.
 *
 * @param {object} ta  output of TAEngine.compute(candles)
 * @param {object} [opts]
 * @param {number} [opts.warmup=50]  bars at start marked invalid (NaN features)
 * @returns {{
 *   matrix: Float32Array,     // flat row-major [n * FEATURE_COUNT]
 *   n: number,
 *   d: number,
 *   names: readonly string[],
 *   valid: Uint8Array,        // 1 if row fully finite post-warmup, else 0
 *   t: number[],              // timestamp per row
 * }}
 */
export function buildFeatureMatrix(ta, { warmup = 50 } = {}) {
  if (!ta || !Array.isArray(ta.close)) {
    return {
      matrix: new Float32Array(0), n: 0, d: FEATURE_COUNT,
      names: FEATURE_NAMES, valid: new Uint8Array(0), t: [],
    };
  }
  const { open, high, low, close, volume, t } = ta;
  const n = close.length;
  const d = FEATURE_COUNT;
  const M = new Float32Array(n * d);
  const valid = new Uint8Array(n);

  const ema20  = ta.ema20  || [];
  const ema50  = ta.ema50  || [];
  const ema200 = ta.ema200 || [];
  const rsi14  = ta.rsi14  || [];
  const macdArr = ta.macd_12_26_9 || {};
  const macdHist = macdArr.hist || [];
  const stoch = ta.stoch_14_3 || {};
  const kArr = stoch.k || [];
  const dArr = stoch.d || [];
  const bb = ta.bb_20_2 || {};
  const bbMid = bb.mid || [];
  const bbUp  = bb.up  || [];
  const bbLo  = bb.lo  || [];
  const atr14 = ta.atr14 || [];
  const adx14 = ta.adx14 || {};
  const adxArr   = adx14.adx     || [];
  const plusArr  = adx14.plusDI  || [];
  const minusArr = adx14.minusDI || [];
  const obv = ta.obv || [];
  const cmf20 = ta.cmf20 || [];
  const roc10 = ta.roc10 || [];
  const breaks = ta.breaks || [];
  const fvgOpen = ta.fvg?.open || [];
  const obsArr = ta.orderBlocks || [];
  const sessions = ta.sessions?.tags || [];

  // Precompute "break in last 10" lookup table
  const breakRecent = new Uint8Array(n);
  if (breaks.length) {
    for (const b of breaks) {
      if (!Number.isInteger(b.i)) continue;
      const start = Math.max(0, b.i);
      const end   = Math.min(n - 1, b.i + 10);
      for (let k = start; k <= end; k++) breakRecent[k] = 1;
    }
  }

  // Zone (use premiumDiscount.series if available, else fallback to lastZone)
  const zoneSeries = ta.premiumDiscount?.series || null;
  const lastZone = ta.premiumDiscount?.lastZone || null;

  const trendUp = ta.trend === "up" ? 1 : 0;
  const trendDn = ta.trend === "down" ? 1 : 0;

  for (let i = 0; i < n; i++) {
    const o = open[i], h = high[i], l = low[i], c = close[i], v = volume[i];
    const range = h - l;
    const body  = c - o;

    // Returns
    const ret1  = i >= 1  && close[i - 1]  > 0 ? (c - close[i - 1])  / close[i - 1]  : 0;
    const ret5  = i >= 5  && close[i - 5]  > 0 ? (c - close[i - 5])  / close[i - 5]  : 0;
    const ret20 = i >= 20 && close[i - 20] > 0 ? (c - close[i - 20]) / close[i - 20] : 0;

    const logRange = range > 0 && c > 0 ? Math.log(range / c) : 0;
    const bodyFrac = range > 0 ? body / range : 0;
    const upperWick = range > 0 ? (h - Math.max(o, c)) / range : 0;
    const lowerWick = range > 0 ? (Math.min(o, c) - l) / range : 0;

    const dEma20  = c > 0 && Number.isFinite(ema20[i])  ? (c - ema20[i])  / c : 0;
    const dEma50  = c > 0 && Number.isFinite(ema50[i])  ? (c - ema50[i])  / c : 0;
    const dEma200 = c > 0 && Number.isFinite(ema200[i]) ? (c - ema200[i]) / c : 0;
    const ema20s  = i >= 5 && Number.isFinite(ema20[i]) && Number.isFinite(ema20[i - 5]) && ema20[i] !== 0
      ? (ema20[i] - ema20[i - 5]) / ema20[i] : 0;

    const rsi = Number.isFinite(rsi14[i]) ? (rsi14[i] - 50) / 50 : 0;
    const macdH = Number.isFinite(macdHist[i]) && c > 0 ? macdHist[i] / c : 0;
    const sk = Number.isFinite(kArr[i]) ? (kArr[i] - 50) / 50 : 0;
    const sd = Number.isFinite(dArr[i]) ? (dArr[i] - 50) / 50 : 0;

    let bbPos = 0, bbWidth = 0;
    if (Number.isFinite(bbMid[i]) && Number.isFinite(bbUp[i]) && Number.isFinite(bbLo[i])) {
      const half = bbUp[i] - bbMid[i];
      bbPos = half !== 0 ? clamp((c - bbMid[i]) / half, -3, 3) : 0;
      bbWidth = bbMid[i] !== 0 ? (bbUp[i] - bbLo[i]) / bbMid[i] : 0;
    }
    const atrRel = Number.isFinite(atr14[i]) && c > 0 ? atr14[i] / c : 0;
    const adxV = Number.isFinite(adxArr[i]) ? adxArr[i] / 100 : 0;
    const diDelta = Number.isFinite(plusArr[i]) && Number.isFinite(minusArr[i])
      ? (plusArr[i] - minusArr[i]) / 100 : 0;

    const volSma = sma(volume, i, 20);
    const volRel = Number.isFinite(volSma) && volSma > 0 ? v / volSma : 1;
    const obvSlope = i >= 20 && Number.isFinite(obv[i]) && Number.isFinite(obv[i - 20])
      ? (obv[i] - obv[i - 20]) / Math.max(1, Math.abs(obv[i - 20])) : 0;
    const cmf = Number.isFinite(cmf20[i]) ? cmf20[i] : 0;
    const rocV = Number.isFinite(roc10[i]) ? roc10[i] / 100 : 0;

    // SMC counts (relative to 10 as a soft cap)
    let fvgOpenCnt = 0;
    for (const g of fvgOpen) { if (g?.i != null && g.i <= i && (g.filledAt == null || g.filledAt > i)) fvgOpenCnt++; }
    const obOpenCnt = obsArr.reduce((acc, b) => acc + (b.i <= i && (!b.mitigated || b.mitigatedAt > i) ? 1 : 0), 0);

    const zone = zoneSeries ? zoneSeries[i] : (i === n - 1 ? lastZone : null);
    const zonePrem = zone === "premium" ? 1 : 0;
    const zoneDisc = zone === "discount" ? 1 : 0;

    const sess = sessions[i] || "off-hours";
    const sAsia = sess === "asia" ? 1 : 0;
    const sLondon = sess === "london" ? 1 : 0;
    const sNyAm = sess === "ny-am" ? 1 : 0;
    const sNyPm = sess === "ny-pm" ? 1 : 0;

    const dt = new Date(t[i] || 0);
    const hod = Number.isFinite(dt.getUTCHours()) ? dt.getUTCHours() / 24 : 0;
    const dow = Number.isFinite(dt.getUTCDay())   ? dt.getUTCDay()   / 6  : 0;

    const row = [
      ret1, ret5, ret20,
      logRange, bodyFrac, upperWick, lowerWick,
      dEma20, dEma50, dEma200, ema20s,
      rsi, macdH, sk, sd,
      bbPos, bbWidth, atrRel, adxV, diDelta,
      volRel, obvSlope, cmf, rocV,
      trendUp, trendDn, breakRecent[i] ? 1 : 0,
      clamp(fvgOpenCnt / 10, 0, 1),
      clamp(obOpenCnt / 10, 0, 1),
      zonePrem, zoneDisc,
      sAsia, sLondon, sNyAm, sNyPm,
      hod, dow,
    ];
    let allFinite = 1;
    for (let k = 0; k < d; k++) {
      const x = safe(row[k]);
      if (!Number.isFinite(row[k])) allFinite = 0;
      M[i * d + k] = x;
    }
    valid[i] = (i >= warmup && allFinite) ? 1 : 0;
  }
  return { matrix: M, n, d, names: FEATURE_NAMES, valid, t };
}

/**
 * Slice a row out of a matrix (copy). Mostly for tests.
 * @param {{matrix:Float32Array, d:number}} fm
 * @param {number} i
 */
export function rowAt(fm, i) {
  return Array.from(fm.matrix.slice(i * fm.d, (i + 1) * fm.d));
}

/**
 * Stack k consecutive rows into a single "windowed" vector (for LSTM-free NN).
 * Returns a new matrix of shape (n - k + 1) × (k · d).
 * @param {{matrix:Float32Array, n:number, d:number, valid:Uint8Array, t:number[]}} fm
 * @param {number} k  window size
 */
export function stackWindows(fm, k) {
  if (k <= 1) return fm;
  const { matrix, n, d, valid, t } = fm;
  const outN = Math.max(0, n - k + 1);
  const outD = k * d;
  const M = new Float32Array(outN * outD);
  const v = new Uint8Array(outN);
  const ts = new Array(outN);
  for (let i = 0; i < outN; i++) {
    let ok = 1;
    for (let j = 0; j < k; j++) {
      const srcStart = (i + j) * d;
      M.set(matrix.subarray(srcStart, srcStart + d), i * outD + j * d);
      if (!valid[i + j]) ok = 0;
    }
    v[i] = ok;
    ts[i] = t[i + k - 1];
  }
  const names = [];
  for (let j = 0; j < k; j++)
    for (const name of FEATURE_NAMES)
      names.push(`t-${k - 1 - j}:${name}`);
  return { matrix: M, n: outN, d: outD, valid: v, t: ts, names };
}

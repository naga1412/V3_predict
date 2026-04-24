/**
 * My Next Prediction v3.0 — Regime Classifier
 * -------------------------------------------
 * Converts a TA snapshot into a structured regime descriptor:
 *
 *   {
 *     trend:      "up" | "down" | "range",
 *     strength:   "weak" | "moderate" | "strong",     // ADX buckets
 *     volatility: "low" | "normal" | "high",          // ATR% or BB-width buckets
 *     alignment:  "bullish-stack" | "bearish-stack" | "mixed" | "flat",
 *     momentum:   "up" | "down" | "flat",             // RSI/MACD-hist sign
 *     breakout:   "up" | "down" | "none",             // recent BoS?
 *     label:      "trending-up-strong-high-vol" ...   // combined compact string
 *     score: {
 *       trend:    -1..+1,   // signed
 *       vol:      0..1,
 *       momentum: -1..+1,
 *     }
 *   }
 *
 * Thresholds were chosen to be sensible defaults for crypto 1m–1h bars;
 * callers can override via the `thresholds` argument.
 */

export const DEFAULT_THRESHOLDS = Object.freeze({
  adx: { weak: 20, moderate: 25, strong: 40 },
  atrPct: { low: 0.003, high: 0.015 },   // 0.3% — 1.5% of price (per-bar)
  bbWidth: { low: 0.02, high: 0.10 },    // relative to mid
  rsi: { oversold: 35, overbought: 65 }, // for "flat" momentum window
  breakoutLookback: 10,                  // bars to consider a BoS "recent"
});

function safe(x) { return Number.isFinite(x) ? x : NaN; }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/**
 * Classify a regime from a TAEngine snapshot (`ta`).
 * Uses the LAST bar of every indicator series (unless `i` is passed).
 *
 * @param {object} ta
 * @param {object} [opts]
 * @param {number} [opts.i]  bar index to evaluate (default: last)
 * @param {object} [opts.thresholds]  override DEFAULT_THRESHOLDS (merged)
 */
export function classifyRegime(ta, opts = {}) {
  if (!ta || !Array.isArray(ta.close) || ta.close.length === 0) {
    return { trend: "range", strength: "weak", volatility: "normal",
             alignment: "flat", momentum: "flat", breakout: "none",
             label: "range-weak-normal-vol", score: { trend: 0, vol: 0, momentum: 0 } };
  }
  const th = Object.assign({}, DEFAULT_THRESHOLDS, opts.thresholds || {});
  const i = Number.isInteger(opts.i) ? opts.i : ta.close.length - 1;

  const c = safe(ta.close[i]);
  const ema20  = safe(ta.ema20?.[i]);
  const ema50  = safe(ta.ema50?.[i]);
  const ema200 = safe(ta.ema200?.[i]);
  const adx    = safe(ta.adx14?.adx?.[i]);
  const plusDI = safe(ta.adx14?.plusDI?.[i]);
  const minusDI = safe(ta.adx14?.minusDI?.[i]);
  const atr14 = safe(ta.atr14?.[i]);
  const bbMid = safe(ta.bb_20_2?.mid?.[i]);
  const bbUp  = safe(ta.bb_20_2?.up?.[i]);
  const bbLo  = safe(ta.bb_20_2?.lo?.[i]);
  const rsi14 = safe(ta.rsi14?.[i]);
  const macdH = safe(ta.macd_12_26_9?.hist?.[i]);

  // ─── Strength from ADX ─────────────────────────────────────────
  let strength = "weak";
  if (Number.isFinite(adx)) {
    if (adx >= th.adx.strong) strength = "strong";
    else if (adx >= th.adx.moderate) strength = "moderate";
    else if (adx >= th.adx.weak) strength = "weak";
  }

  // ─── Volatility from ATR% and BB width ─────────────────────────
  let volatility = "normal";
  let volScore = 0;
  const atrPct = (Number.isFinite(atr14) && c > 0) ? atr14 / c : NaN;
  const bbW = (Number.isFinite(bbUp) && Number.isFinite(bbLo) && bbMid)
    ? (bbUp - bbLo) / bbMid : NaN;
  if (Number.isFinite(atrPct)) {
    if (atrPct <= th.atrPct.low) volatility = "low";
    else if (atrPct >= th.atrPct.high) volatility = "high";
    volScore = clamp((atrPct - th.atrPct.low) / (th.atrPct.high - th.atrPct.low), 0, 1);
  } else if (Number.isFinite(bbW)) {
    if (bbW <= th.bbWidth.low) volatility = "low";
    else if (bbW >= th.bbWidth.high) volatility = "high";
    volScore = clamp((bbW - th.bbWidth.low) / (th.bbWidth.high - th.bbWidth.low), 0, 1);
  }

  // ─── Alignment of MA stack ──────────────────────────────────────
  let alignment = "flat";
  if (Number.isFinite(ema20) && Number.isFinite(ema50) && Number.isFinite(ema200)) {
    if (ema20 > ema50 && ema50 > ema200) alignment = "bullish-stack";
    else if (ema20 < ema50 && ema50 < ema200) alignment = "bearish-stack";
    else alignment = "mixed";
  }

  // ─── Trend decision ─────────────────────────────────────────────
  // Prefer ta.trend if computed; else fall back to alignment + ADX.
  let trend = "range";
  let trendScore = 0;
  if (strength !== "weak" && Number.isFinite(plusDI) && Number.isFinite(minusDI)) {
    const diSign = plusDI > minusDI ? 1 : -1;
    trend = diSign > 0 ? "up" : "down";
    const diMag = Math.abs(plusDI - minusDI) / Math.max(1, plusDI + minusDI);
    trendScore = diSign * diMag;
  } else if (ta.trend === "up" || ta.trend === "down") {
    trend = ta.trend;
    trendScore = ta.trend === "up" ? 0.4 : -0.4;
  } else if (alignment === "bullish-stack") {
    trend = "up"; trendScore = 0.3;
  } else if (alignment === "bearish-stack") {
    trend = "down"; trendScore = -0.3;
  }

  // ─── Momentum from RSI/MACD-hist sign ───────────────────────────
  let momentum = "flat", momScore = 0;
  if (Number.isFinite(macdH) && c > 0) {
    const macdRel = macdH / c;
    momScore = clamp(macdRel * 1000, -1, 1); // crude scale; MACD hist is tiny vs price
  }
  if (Number.isFinite(rsi14)) {
    const rsiSigned = (rsi14 - 50) / 50; // -1..+1
    momScore = clamp(momScore + rsiSigned * 0.5, -1, 1);
  }
  if (momScore > 0.15) momentum = "up";
  else if (momScore < -0.15) momentum = "down";

  // ─── Breakout from recent BoS ──────────────────────────────────
  let breakout = "none";
  const breaks = Array.isArray(ta.breaks) ? ta.breaks : [];
  for (let k = breaks.length - 1; k >= 0; k--) {
    const b = breaks[k];
    if (!Number.isInteger(b.i)) continue;
    if (i - b.i > th.breakoutLookback) break;
    if (b.dir === "up" || b.type === "BoS-up" || b.type === "CHoCH-up") { breakout = "up"; break; }
    if (b.dir === "down" || b.type === "BoS-down" || b.type === "CHoCH-down") { breakout = "down"; break; }
  }

  const label = `${trend === "range" ? "range" : `trending-${trend}`}-${strength}-${volatility}-vol`;
  return {
    trend, strength, volatility, alignment, momentum, breakout,
    label,
    score: { trend: trendScore, vol: volScore, momentum: momScore },
    inputs: {
      adx, atrPct, bbWidth: bbW, rsi14, macdHist: macdH,
      ema20, ema50, ema200, plusDI, minusDI,
    },
  };
}

/**
 * Classify every bar in a TA snapshot (O(n) — re-uses the same thresholds).
 * Returns an array of `n` regime descriptors.
 */
export function classifySeries(ta, opts = {}) {
  const n = ta?.close?.length || 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = classifyRegime(ta, { ...opts, i });
  return out;
}

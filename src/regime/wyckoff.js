/**
 * My Next Prediction v3.0 — M4b · Wyckoff phase classifier
 * --------------------------------------------------------
 * Maps a TA snapshot to one of 4 Wyckoff phases:
 *   - "accumulation"  : sideways range after downtrend, low volatility
 *   - "markup"        : uptrend, expanding range, rising volume
 *   - "distribution"  : sideways range at highs, declining volume
 *   - "markdown"      : downtrend, expanding range, rising volume
 *
 * Pure scalar function — no DOM, no IDB.  Reads ta.close / .high /
 * .low / .volume / .ema20 / .ema50 / .ema200 / .atr14 / .bb_20_2 /
 * .breaks / .pivots and returns:
 *
 *   {
 *     phase:      "accumulation" | "markup" | "distribution" | "markdown" | "neutral",
 *     bias:       "bullish" | "bearish" | "neutral",
 *     bullPct:    0..100,        // share of last `lookback` bars closing > open
 *     score:      { trend: -1..+1, vol: 0..1, momentum: -1..+1, volume: -1..+1 },
 *     reasons:    string[],
 *   }
 *
 * Implementation: bull% (porting v2 ta_logic.py:464) + the existing
 * regime classifier's outputs, blended with a tiny rule table.
 */

const DEFAULTS = Object.freeze({
  lookback: 30,                // bars used for bullPct + range / volume slope
  bullPct: { low: 38, high: 62 }, // < low → bear-leaning; > high → bull-leaning
  rangePct: 0.04,              // bb-width / mid below this is "ranging"
  volSlopeBars: 20,            // SMA window for volume slope
});

function safe(x) { return Number.isFinite(x) ? x : NaN; }
function lastFinite(arr) {
  if (!arr || !arr.length) return NaN;
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i];
  return NaN;
}

/**
 * Compute the share of the last `n` bars that closed above their open.
 * Returns 0..100, or NaN on missing data.
 */
export function bullPct(ta, n = DEFAULTS.lookback) {
  if (!ta || !Array.isArray(ta.close) || !Array.isArray(ta.open)) return NaN;
  const len = ta.close.length;
  if (len === 0) return NaN;
  const start = Math.max(0, len - n);
  let bull = 0, total = 0;
  for (let i = start; i < len; i++) {
    const o = +ta.open[i], c = +ta.close[i];
    if (!Number.isFinite(o) || !Number.isFinite(c)) continue;
    total++;
    if (c > o) bull++;
  }
  return total > 0 ? (bull / total) * 100 : NaN;
}

/**
 * Slope of SMA(volume, n) at the last bar — expressed as a relative
 * change over the last n bars.  Returns -1..+1 (clamped).
 */
export function volumeSlope(ta, n = DEFAULTS.volSlopeBars) {
  if (!ta || !Array.isArray(ta.volume)) return 0;
  const v = ta.volume;
  const len = v.length;
  if (len < n * 2) return 0;
  const sma = (i, k) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - k + 1); j <= i; j++) {
      const x = +v[j]; if (Number.isFinite(x)) { s += x; c++; }
    }
    return c > 0 ? s / c : NaN;
  };
  const cur  = sma(len - 1, n);
  const prev = sma(len - 1 - n, n);
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return 0;
  return Math.max(-1, Math.min(1, (cur - prev) / prev));
}

/**
 * Bollinger-band-width based range tightness in [0, 1].
 * 1 = wide expanding range, 0 = pinch / squeeze.
 */
export function rangePct(ta) {
  const bb = ta?.bb_20_2;
  const up  = lastFinite(bb?.up);
  const lo  = lastFinite(bb?.lo);
  const mid = lastFinite(bb?.mid);
  if (!Number.isFinite(up) || !Number.isFinite(lo) || !Number.isFinite(mid) || mid === 0) return NaN;
  return (up - lo) / mid;
}

/**
 * Classify the Wyckoff phase.
 *
 * @param {object} ta TAEngine output
 * @param {object} [opts]
 * @returns {{phase, bias, bullPct, score, reasons:string[]}}
 */
export function classifyWyckoff(ta, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  const reasons = [];

  if (!ta || !Array.isArray(ta.close) || ta.close.length < 5) {
    return {
      phase: "neutral", bias: "neutral", bullPct: NaN,
      score: { trend: 0, vol: 0, momentum: 0, volume: 0 },
      reasons: ["insufficient data"],
    };
  }

  // 1. Trend stack → uptrend / downtrend / range
  const ema20  = lastFinite(ta.ema20);
  const ema50  = lastFinite(ta.ema50);
  const ema200 = lastFinite(ta.ema200);
  let stack = "mixed";
  if (Number.isFinite(ema20) && Number.isFinite(ema50) && Number.isFinite(ema200)) {
    if (ema20 > ema50 && ema50 > ema200) stack = "bull";
    else if (ema20 < ema50 && ema50 < ema200) stack = "bear";
  }

  // 2. ADX strength
  const adx = lastFinite(ta.adx14?.adx);
  const adxStrong = Number.isFinite(adx) && adx >= 22;

  // 3. bull% — share of green bars in last `lookback`
  const bp = bullPct(ta, cfg.lookback);

  // 4. Range tightness from BB width
  const rng = rangePct(ta);

  // 5. Volume slope
  const volSlope = volumeSlope(ta, cfg.volSlopeBars);

  // 6. Decision tree (kept transparent — Wyckoff is rule-of-thumb territory)
  let phase = "neutral";
  let bias  = "neutral";

  if (stack === "bull" && adxStrong && volSlope >= 0) {
    phase = "markup"; bias = "bullish";
    reasons.push("EMA stack bull + ADX strong + rising volume → markup");
  } else if (stack === "bear" && adxStrong && volSlope >= 0) {
    phase = "markdown"; bias = "bearish";
    reasons.push("EMA stack bear + ADX strong + rising volume → markdown");
  } else if (Number.isFinite(bp) && bp >= cfg.bullPct.high && (!Number.isFinite(rng) || rng >= 0.03)) {
    // Lots of green bars but tight or flat — late mark-up or early distribution
    phase = "markup"; bias = "bullish";
    reasons.push(`bull% ${bp.toFixed(0)}% (high) → markup`);
  } else if (Number.isFinite(bp) && bp <= cfg.bullPct.low && (!Number.isFinite(rng) || rng >= 0.03)) {
    phase = "markdown"; bias = "bearish";
    reasons.push(`bull% ${bp.toFixed(0)}% (low) → markdown`);
  } else if (stack === "bull" && volSlope < 0 && Number.isFinite(rng) && rng <= cfg.rangePct) {
    phase = "distribution"; bias = "bearish";
    reasons.push("EMA bull stack but volume falling + range pinch → distribution");
  } else if (stack === "bear" && volSlope < 0 && Number.isFinite(rng) && rng <= cfg.rangePct) {
    phase = "accumulation"; bias = "bullish";
    reasons.push("EMA bear stack but volume falling + range pinch → accumulation");
  } else if (Number.isFinite(rng) && rng <= cfg.rangePct) {
    // Tight range, ambiguous trend — use bull% as tie-breaker
    if (Number.isFinite(bp) && bp >= 50) {
      phase = "accumulation"; bias = "bullish";
      reasons.push(`tight range + bull% ${bp.toFixed(0)}% → accumulation`);
    } else {
      phase = "distribution"; bias = "bearish";
      reasons.push(`tight range + bull% ${(Number.isFinite(bp) ? bp : 0).toFixed(0)}% → distribution`);
    }
  } else {
    phase = "neutral"; bias = "neutral";
    reasons.push("no decisive signal — neutral");
  }

  // Score block (consumers may visualise the 4 dimensions)
  const trendScore =
    stack === "bull" ? (adxStrong ? 0.8 : 0.4) :
    stack === "bear" ? (adxStrong ? -0.8 : -0.4) :
    0;
  const volScore = Number.isFinite(rng) ? Math.max(0, Math.min(1, rng / 0.08)) : 0;
  const momentumScore = Number.isFinite(bp) ? (bp - 50) / 50 : 0;
  const volumeScore = Number.isFinite(volSlope) ? volSlope : 0;

  return {
    phase,
    bias,
    bullPct: Number.isFinite(bp) ? +bp.toFixed(1) : NaN,
    rangePct: Number.isFinite(rng) ? +rng.toFixed(4) : NaN,
    volumeSlope: +volumeScore.toFixed(3),
    score: {
      trend: +trendScore.toFixed(3),
      vol:   +volScore.toFixed(3),
      momentum: +momentumScore.toFixed(3),
      volume: +volumeScore.toFixed(3),
    },
    reasons,
  };
}

/** Compact KPI for the chip / sidebar. */
export function summarizeWyckoff(w) {
  if (!w) return null;
  return { phase: w.phase, bias: w.bias, bullPct: w.bullPct };
}

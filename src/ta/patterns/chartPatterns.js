/**
 * My Next Prediction v3.0 — Phase M3 step 6 · Chart patterns
 * ----------------------------------------------------------
 * Geometric pattern detection on top of the swing-pivot stream.
 *
 * Initial release ships seven of the v2 families (the most predictive
 * for crypto micro-structure).  Adding the remaining four (Rising/
 * Falling Wedge, Symmetrical Triangle, Rounding Top/Cup, Bump & Run)
 * is straightforward and tracked as a follow-up.
 *
 *   - Head & Shoulders  (bearish reversal)
 *   - Inverse Head & Shoulders (bullish reversal)
 *   - Double / Triple Top   (bearish reversal)
 *   - Double / Triple Bottom (bullish reversal)
 *   - Ascending Triangle  (bullish continuation)
 *   - Descending Triangle (bearish continuation)
 *
 * Each detected pattern returns:
 *   {
 *     name: string,             // human-readable
 *     bias: "bullish"|"bearish",
 *     confidence: 0..1,         // High≈0.85, Medium≈0.6, Low≈0.35
 *     targetPrice: number|null, // measured-move target if applicable
 *     invalidationPrice: number|null,  // structural invalidation level
 *     anchorPoints: [{i,t,p}, …],
 *     atBar: number,            // detected at this candle index
 *     ageBars: number,          // bars since the last anchor
 *   }
 *
 * Pure module: takes candles + ATR + pivots; returns {patterns, last}.
 */

import { findPivots } from "../structure/swings.js";

/* ═══════════════════════════ Helpers ═══════════════════════════ */

function roughlyEqual(a, b, tol) {
  return Math.abs(a - b) <= tol;
}
function withinPct(a, b, pct) {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * pct;
}
function asAnchor(pivot) {
  return { i: pivot.i, t: pivot.t, p: pivot.price };
}
function classifyConfidence(score) {
  if (!Number.isFinite(score) || score <= 0) return null;
  if (score >= 0.75) return 0.85;   // High
  if (score >= 0.45) return 0.60;   // Medium
  if (score >= 0.20) return 0.35;   // Low
  return null;
}

/**
 * Linear-fit a list of pivots (re-implemented locally to keep this
 * file independent of trendlines.js).  Returns slope per bar-index.
 */
function slopeOf(pivots) {
  if (!Array.isArray(pivots) || pivots.length < 2) return NaN;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (const p of pivots) {
    sx += p.i; sy += p.price; sxx += p.i * p.i; sxy += p.i * p.price; n++;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

/* ═══════════════════════════ Detectors ═══════════════════════════ */

/**
 * Head & Shoulders / Inverse: 3 swing-highs (lows) where:
 *   - The MIDDLE pivot ("head") is highest (lowest);
 *   - The two outer pivots ("shoulders") are within `tolPct` of each
 *     other in price;
 *   - Neckline = line through the two intervening troughs (peaks);
 *   - Confirmed when the latest close has broken the neckline;
 *   - Invalidation = head price.
 *
 * Returns a pattern object or null.
 */
function detectHS({ pivots, candles, atr, tolPct = 0.04 }) {
  // Need 5 pivots: peak troughs alternating
  // For H&S (bearish): high-low-high-low-high (head is middle high)
  // For inverse:        low-high-low-high-low  (head is middle low)
  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx]?.c;
  const out = [];

  const tail = pivots.slice(-12);  // last 12 pivots is enough to find a 5-pivot pattern
  if (tail.length < 5) return out;

  // Walk every contiguous 5-pivot window (oldest first) and test both shapes.
  for (let i = 0; i + 4 < tail.length; i++) {
    const a = tail[i], b = tail[i + 1], c = tail[i + 2], d = tail[i + 3], e = tail[i + 4];

    // H&S (bearish reversal): high-low-high-low-high
    if (a.kind === "high" && b.kind === "low" && c.kind === "high" && d.kind === "low" && e.kind === "high") {
      const headHigher = c.price > a.price + atr * 0.3 && c.price > e.price + atr * 0.3;
      const shouldersAligned = withinPct(a.price, e.price, tolPct);
      if (headHigher && shouldersAligned) {
        const necklineSlope = (d.price - b.price) / Math.max(1, d.i - b.i);
        const necklineAt = (idx) => b.price + necklineSlope * (idx - b.i);
        const nl = necklineAt(lastIdx);
        const broken = lastClose < nl - atr * 0.1;
        const head    = c.price;
        // Measured move: pattern height projected DOWN from the neckline at break
        const measure = head - necklineAt(c.i);
        const target  = nl - measure;
        const invalid = head;
        // Confidence: stricter alignment + cleaner neckline + actual break.
        let score = 0.4
          + (1 - Math.abs(a.price - e.price) / Math.max(a.price, e.price)) * 0.25
          + (broken ? 0.25 : 0)
          + Math.min(0.1, (head - Math.max(a.price, e.price)) / Math.max(atr, 1e-9) * 0.05);
        const confidence = classifyConfidence(score);
        if (confidence) {
          out.push({
            name: "Head & Shoulders",
            bias: "bearish",
            confidence,
            targetPrice: Number.isFinite(target) ? target : null,
            invalidationPrice: Number.isFinite(invalid) ? invalid : null,
            anchorPoints: [a, b, c, d, e].map(asAnchor),
            atBar: e.i,
            ageBars: lastIdx - e.i,
            broken,
            necklinePrice: nl,
          });
        }
      }
    }

    // Inverse H&S (bullish reversal): low-high-low-high-low
    if (a.kind === "low" && b.kind === "high" && c.kind === "low" && d.kind === "high" && e.kind === "low") {
      const headLower = c.price < a.price - atr * 0.3 && c.price < e.price - atr * 0.3;
      const shouldersAligned = withinPct(a.price, e.price, tolPct);
      if (headLower && shouldersAligned) {
        const necklineSlope = (d.price - b.price) / Math.max(1, d.i - b.i);
        const necklineAt = (idx) => b.price + necklineSlope * (idx - b.i);
        const nl = necklineAt(lastIdx);
        const broken = lastClose > nl + atr * 0.1;
        const head    = c.price;
        const measure = necklineAt(c.i) - head;
        const target  = nl + measure;
        const invalid = head;
        let score = 0.4
          + (1 - Math.abs(a.price - e.price) / Math.max(a.price, e.price)) * 0.25
          + (broken ? 0.25 : 0)
          + Math.min(0.1, (Math.min(a.price, e.price) - head) / Math.max(atr, 1e-9) * 0.05);
        const confidence = classifyConfidence(score);
        if (confidence) {
          out.push({
            name: "Inverse Head & Shoulders",
            bias: "bullish",
            confidence,
            targetPrice: Number.isFinite(target) ? target : null,
            invalidationPrice: Number.isFinite(invalid) ? invalid : null,
            anchorPoints: [a, b, c, d, e].map(asAnchor),
            atBar: e.i,
            ageBars: lastIdx - e.i,
            broken,
            necklinePrice: nl,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Double / Triple Top — bearish: 2 or 3 consecutive swing-highs at
 * roughly the same price, separated by a meaningful trough.  The
 * neckline is the common low between the peaks.  Confirmed when
 * close breaks below the neckline.
 */
function detectMultiTop({ pivots, candles, atr, tolPct = 0.025 }) {
  const out = [];
  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx]?.c;
  const highs = pivots.filter((p) => p.kind === "high");
  const lows  = pivots.filter((p) => p.kind === "low");
  if (highs.length < 2) return out;

  const lastHighs = highs.slice(-3);
  const matchingPair = (a, b) =>
    withinPct(a.price, b.price, tolPct) &&
    Math.abs(a.i - b.i) >= 4;

  // Triple top
  if (lastHighs.length === 3) {
    const [a, b, c] = lastHighs;
    if (matchingPair(a, b) && matchingPair(b, c) && matchingPair(a, c)) {
      const trough1 = lows.filter((p) => p.i > a.i && p.i < b.i).reduce((m, p) => !m || p.price < m.price ? p : m, null);
      const trough2 = lows.filter((p) => p.i > b.i && p.i < c.i).reduce((m, p) => !m || p.price < m.price ? p : m, null);
      if (trough1 && trough2) {
        const neckline = Math.min(trough1.price, trough2.price);
        const broken = Number.isFinite(lastClose) && lastClose < neckline - atr * 0.1;
        const head = (a.price + b.price + c.price) / 3;
        const measure = head - neckline;
        const target = neckline - measure;
        const score = 0.5
          + (1 - Math.abs(a.price - c.price) / Math.max(a.price, c.price)) * 0.3
          + (broken ? 0.2 : 0);
        const confidence = classifyConfidence(score);
        if (confidence) {
          out.push({
            name: "Triple Top",
            bias: "bearish",
            confidence,
            targetPrice: Number.isFinite(target) ? target : null,
            invalidationPrice: head,
            anchorPoints: [a, trough1, b, trough2, c].map(asAnchor),
            atBar: c.i,
            ageBars: lastIdx - c.i,
            broken,
            necklinePrice: neckline,
          });
          return out;
        }
      }
    }
  }

  // Double top — last two highs only
  if (lastHighs.length >= 2) {
    const a = lastHighs[lastHighs.length - 2];
    const b = lastHighs[lastHighs.length - 1];
    if (matchingPair(a, b)) {
      const trough = lows.filter((p) => p.i > a.i && p.i < b.i).reduce((m, p) => !m || p.price < m.price ? p : m, null);
      if (trough) {
        const neckline = trough.price;
        const broken = Number.isFinite(lastClose) && lastClose < neckline - atr * 0.1;
        const head = (a.price + b.price) / 2;
        const measure = head - neckline;
        const target = neckline - measure;
        const score = 0.45
          + (1 - Math.abs(a.price - b.price) / Math.max(a.price, b.price)) * 0.3
          + (broken ? 0.2 : 0);
        const confidence = classifyConfidence(score);
        if (confidence) {
          out.push({
            name: "Double Top",
            bias: "bearish",
            confidence,
            targetPrice: Number.isFinite(target) ? target : null,
            invalidationPrice: head,
            anchorPoints: [a, trough, b].map(asAnchor),
            atBar: b.i,
            ageBars: lastIdx - b.i,
            broken,
            necklinePrice: neckline,
          });
        }
      }
    }
  }
  return out;
}

/** Symmetric of detectMultiTop — detects Double / Triple Bottom (bullish). */
function detectMultiBottom({ pivots, candles, atr, tolPct = 0.025 }) {
  const out = [];
  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx]?.c;
  const highs = pivots.filter((p) => p.kind === "high");
  const lows  = pivots.filter((p) => p.kind === "low");
  if (lows.length < 2) return out;

  const lastLows = lows.slice(-3);
  const matchingPair = (a, b) =>
    withinPct(a.price, b.price, tolPct) &&
    Math.abs(a.i - b.i) >= 4;

  if (lastLows.length === 3) {
    const [a, b, c] = lastLows;
    if (matchingPair(a, b) && matchingPair(b, c) && matchingPair(a, c)) {
      const peak1 = highs.filter((p) => p.i > a.i && p.i < b.i).reduce((m, p) => !m || p.price > m.price ? p : m, null);
      const peak2 = highs.filter((p) => p.i > b.i && p.i < c.i).reduce((m, p) => !m || p.price > m.price ? p : m, null);
      if (peak1 && peak2) {
        const neckline = Math.max(peak1.price, peak2.price);
        const broken = Number.isFinite(lastClose) && lastClose > neckline + atr * 0.1;
        const base = (a.price + b.price + c.price) / 3;
        const measure = neckline - base;
        const target = neckline + measure;
        const score = 0.5
          + (1 - Math.abs(a.price - c.price) / Math.max(a.price, c.price)) * 0.3
          + (broken ? 0.2 : 0);
        const confidence = classifyConfidence(score);
        if (confidence) {
          out.push({
            name: "Triple Bottom",
            bias: "bullish",
            confidence,
            targetPrice: Number.isFinite(target) ? target : null,
            invalidationPrice: base,
            anchorPoints: [a, peak1, b, peak2, c].map(asAnchor),
            atBar: c.i,
            ageBars: lastIdx - c.i,
            broken,
            necklinePrice: neckline,
          });
          return out;
        }
      }
    }
  }

  if (lastLows.length >= 2) {
    const a = lastLows[lastLows.length - 2];
    const b = lastLows[lastLows.length - 1];
    if (matchingPair(a, b)) {
      const peak = highs.filter((p) => p.i > a.i && p.i < b.i).reduce((m, p) => !m || p.price > m.price ? p : m, null);
      if (peak) {
        const neckline = peak.price;
        const broken = Number.isFinite(lastClose) && lastClose > neckline + atr * 0.1;
        const base = (a.price + b.price) / 2;
        const measure = neckline - base;
        const target = neckline + measure;
        const score = 0.45
          + (1 - Math.abs(a.price - b.price) / Math.max(a.price, b.price)) * 0.3
          + (broken ? 0.2 : 0);
        const confidence = classifyConfidence(score);
        if (confidence) {
          out.push({
            name: "Double Bottom",
            bias: "bullish",
            confidence,
            targetPrice: Number.isFinite(target) ? target : null,
            invalidationPrice: base,
            anchorPoints: [a, peak, b].map(asAnchor),
            atBar: b.i,
            ageBars: lastIdx - b.i,
            broken,
            necklinePrice: neckline,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Ascending Triangle — bullish continuation.  Flat upper resistance
 * (last 2-3 highs at the same price) + rising lows.
 */
function detectAscendingTriangle({ pivots, candles, atr, tolPct = 0.02 }) {
  const out = [];
  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx]?.c;
  const highs = pivots.filter((p) => p.kind === "high").slice(-4);
  const lows  = pivots.filter((p) => p.kind === "low").slice(-4);
  if (highs.length < 2 || lows.length < 2) return out;

  // Flat top: last two highs within tolPct
  const a = highs[highs.length - 2];
  const b = highs[highs.length - 1];
  if (!withinPct(a.price, b.price, tolPct)) return out;

  // Rising lows
  const slopeLow = slopeOf(lows);
  if (!Number.isFinite(slopeLow) || slopeLow <= 0) return out;

  const resistance = (a.price + b.price) / 2;
  const broken = Number.isFinite(lastClose) && lastClose > resistance + atr * 0.1;
  const lastLow = lows[lows.length - 1];
  const height = resistance - lastLow.price;
  const target = resistance + Math.max(0, height);
  const score = 0.45
    + Math.min(0.25, slopeLow * (lows[lows.length - 1].i - lows[0].i) / Math.max(atr, 1e-9))
    + (broken ? 0.2 : 0);
  const confidence = classifyConfidence(score);
  if (!confidence) return out;
  out.push({
    name: "Ascending Triangle",
    bias: "bullish",
    confidence,
    targetPrice: Number.isFinite(target) ? target : null,
    invalidationPrice: lastLow.price,
    anchorPoints: [a, b, ...lows.slice(-2)].map(asAnchor),
    atBar: b.i,
    ageBars: lastIdx - b.i,
    broken,
    necklinePrice: resistance,
  });
  return out;
}

/** Descending Triangle — bearish continuation: flat support + falling highs. */
function detectDescendingTriangle({ pivots, candles, atr, tolPct = 0.02 }) {
  const out = [];
  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx]?.c;
  const highs = pivots.filter((p) => p.kind === "high").slice(-4);
  const lows  = pivots.filter((p) => p.kind === "low").slice(-4);
  if (highs.length < 2 || lows.length < 2) return out;

  const a = lows[lows.length - 2];
  const b = lows[lows.length - 1];
  if (!withinPct(a.price, b.price, tolPct)) return out;

  const slopeHigh = slopeOf(highs);
  if (!Number.isFinite(slopeHigh) || slopeHigh >= 0) return out;

  const support = (a.price + b.price) / 2;
  const broken = Number.isFinite(lastClose) && lastClose < support - atr * 0.1;
  const lastHigh = highs[highs.length - 1];
  const height = lastHigh.price - support;
  const target = support - Math.max(0, height);
  const score = 0.45
    + Math.min(0.25, -slopeHigh * (highs[highs.length - 1].i - highs[0].i) / Math.max(atr, 1e-9))
    + (broken ? 0.2 : 0);
  const confidence = classifyConfidence(score);
  if (!confidence) return out;
  out.push({
    name: "Descending Triangle",
    bias: "bearish",
    confidence,
    targetPrice: Number.isFinite(target) ? target : null,
    invalidationPrice: lastHigh.price,
    anchorPoints: [a, b, ...highs.slice(-2)].map(asAnchor),
    atBar: b.i,
    ageBars: lastIdx - b.i,
    broken,
    necklinePrice: support,
  });
  return out;
}

/* ═══════════════════════════ Entry point ═══════════════════════════ */

/**
 * Run all chart-pattern detectors over a candle array.
 *
 * @param {Array<{t,o,h,l,c,v}>} candles
 * @param {object} [opts]
 * @param {number} [opts.atr]            ATR scalar (last bar) for tolerances.
 * @param {{left:number,right:number}} [opts.pivots]
 * @returns {{patterns: Array, last: object|null}}
 */
export function detectChartPatterns(candles, opts = {}) {
  if (!Array.isArray(candles) || candles.length < 8) return { patterns: [], last: null };
  const piv = findPivots(candles, opts.pivots || {});
  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx]?.c;
  let atr = Number.isFinite(opts.atr) && opts.atr > 0 ? +opts.atr : NaN;
  if (!Number.isFinite(atr)) {
    atr = Number.isFinite(lastClose) ? Math.max(1e-9, Math.abs(lastClose) * 0.005) : 1;
  }

  const patterns = [
    ...detectHS({ pivots: piv, candles, atr }),
    ...detectMultiTop({ pivots: piv, candles, atr }),
    ...detectMultiBottom({ pivots: piv, candles, atr }),
    ...detectAscendingTriangle({ pivots: piv, candles, atr }),
    ...detectDescendingTriangle({ pivots: piv, candles, atr }),
  ];

  // Sort by `atBar` descending and confidence (most-recent + highest first).
  patterns.sort((x, y) => (y.atBar - x.atBar) || (y.confidence - x.confidence));

  const last = patterns.length ? patterns[0] : null;
  return { patterns, last };
}

/** Compact summary for the sidebar / KPI strip. */
export function summarizeChartPattern(p) {
  if (!p) return null;
  return {
    name: p.name,
    bias: p.bias,
    confidence: p.confidence,
    target: p.targetPrice,
    invalidation: p.invalidationPrice,
    broken: !!p.broken,
    age: p.ageBars,
  };
}

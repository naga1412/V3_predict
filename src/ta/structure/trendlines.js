/**
 * My Next Prediction v3.0 — Phase M3 step 6 · Trendlines
 * ------------------------------------------------------
 * Auto-detected trendlines from swing pivots, with channel + breakout.
 *
 * Algorithm:
 *   1. Take the last `lookback` swing-highs / swing-lows from the
 *      pivot stream (re-uses `findPivots` from ../structure/swings.js).
 *   2. Least-squares fit of   y = m·x + b   where x = pivot index in
 *      bar-time and y = pivot price.  Returns slope, intercept, and
 *      R² for that fit.
 *   3. "Touch" count = number of pivot prices within  0.5·ATR  of the
 *      fitted line (validates that the line was actually respected by
 *      multiple swings, not just the original 2).
 *   4. Score = R² × min(touches/4, 1) — the headline confidence.
 *   5. Channel width = 2·σ of residuals; `parallel` is true when both
 *      upper- and lower-line slopes lie within ±25 % of each other.
 *   6. Breakout fires when `last close` is ≥ 0.5·ATR beyond the line
 *      at the current bar; emits `{side, atBar, strength}`.
 *
 * Pure module: takes candles + an optional ATR scalar; returns a single
 * structured object.  No DOM, no IDB, no event bus — the caller wires
 * the events.
 */

import { findPivots } from "./swings.js";

/* ═══════════════════════════ Helpers ═══════════════════════════ */

/**
 * Least-squares linear fit: minimise Σ(y − (m·x + b))².
 * Returns {slope, intercept, r2, n, sumE2}.  When all points are
 * coincident or n < 2 returns slope=0, intercept=avg(y), r²=0.
 */
export function leastSquares(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return { slope: 0, intercept: NaN, r2: 0, n: 0, sumE2: 0 };
  }
  let sx = 0, sy = 0, n = 0;
  for (const p of points) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    sx += p.x; sy += p.y; n++;
  }
  if (n < 2) return { slope: 0, intercept: NaN, r2: 0, n, sumE2: 0 };
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (sxx <= 0) {
    return { slope: 0, intercept: my, r2: 0, n, sumE2: syy };
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sumE2 = 0;
  for (const p of points) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    const e = p.y - (slope * p.x + intercept);
    sumE2 += e * e;
  }
  const r2 = syy > 0 ? Math.max(0, Math.min(1, 1 - sumE2 / syy)) : 0;
  return { slope, intercept, r2, n, sumE2 };
}

/** Evaluate the fitted line at x. */
function lineAt(line, x) { return line.slope * x + line.intercept; }

/** Residual standard deviation: sqrt(sumE2 / max(1, n-2)). */
function residualSigma(line) {
  const dof = Math.max(1, (line.n | 0) - 2);
  return Math.sqrt(line.sumE2 / dof);
}

/**
 * Count how many of the candidate pivots lie within `tolerance` of the
 * fitted line.  Tolerance is typically 0.5 · ATR.  Returns the
 * subset of points that touched the line (handy for UI rendering).
 */
export function touchPoints(line, points, tolerance) {
  if (!Number.isFinite(line?.slope) || !Number.isFinite(line?.intercept)) return [];
  const tol = Math.max(0, +tolerance);
  const out = [];
  for (const p of points) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    const yhat = line.slope * p.x + line.intercept;
    if (Math.abs(p.y - yhat) <= tol) out.push(p);
  }
  return out;
}

/* ═══════════════════════════ Core API ═══════════════════════════ */

/**
 * @typedef {Object} TLLine
 * @property {number}  slope     price-units per bar-index
 * @property {number}  intercept
 * @property {number}  r2        coefficient of determination (0..1)
 * @property {number}  touches   number of pivots within tolerance
 * @property {number}  score     r² · min(touches/4, 1)
 * @property {{i:number, t:number, p:number}[]} points  all pivots used in the fit
 * @property {{i:number, t:number, p:number}[]} touchPoints
 * @property {number}  startT    earliest pivot bar's timestamp
 * @property {number}  endT      latest pivot bar's timestamp
 * @property {number}  sigma     residual standard deviation (price units)
 *
 * @typedef {Object} TLResult
 * @property {TLLine|null} upper  fitted line through the last N swing-highs
 * @property {TLLine|null} lower  fitted line through the last N swing-lows
 * @property {{
 *   widthATR:number,    // (avg residual band size) / ATR — channel "thickness"
 *   parallel:boolean,
 * }} channel
 * @property {{ side:"up"|"down", atBar:number, distATR:number, strength:number }|null} lastBreakout
 * @property {{ lookback:number, tolerance:number, atr:number, lastBarIdx:number }} meta
 */

/**
 * Build trendlines from a candle array.
 *
 * @param {Array<{t,o,h,l,c,v}>} candles
 * @param {object} [opts]
 * @param {number} [opts.lookback=8]      how many of the most recent
 *                                        same-kind pivots to fit
 * @param {number} [opts.minPivots=3]     don't return a line if fewer
 *                                        pivots are available
 * @param {number} [opts.atr]             ATR scalar (last bar) used for
 *                                        the touch-tolerance and the
 *                                        breakout threshold.  When not
 *                                        provided we fall back to 0.5 %
 *                                        of the last close.
 * @param {number} [opts.tolerance]       absolute tolerance (price); when
 *                                        provided overrides ATR-based.
 * @param {number} [opts.toleranceATR=0.5]  multiplier on ATR (default 0.5)
 * @param {number} [opts.breakoutATR=0.5]   ATR-multiple beyond the line
 *                                          required to fire a breakout
 * @param {{left:number,right:number}} [opts.pivots] pivot config
 * @returns {TLResult}
 */
export function detectTrendlines(candles, opts = {}) {
  const out = {
    upper: null,
    lower: null,
    channel: { widthATR: 0, parallel: false },
    lastBreakout: null,
    meta: { lookback: 0, tolerance: 0, atr: 0, lastBarIdx: -1 },
  };
  if (!Array.isArray(candles) || candles.length < 6) return out;

  const lookback     = Math.max(2, Math.min(64, opts.lookback     ?? 8));
  const minPivots    = Math.max(2, opts.minPivots    ?? 3);
  const toleranceATR = Number.isFinite(opts.toleranceATR) ? +opts.toleranceATR : 0.5;
  const breakoutATR  = Number.isFinite(opts.breakoutATR)  ? +opts.breakoutATR  : 0.5;
  const piv = findPivots(candles, opts.pivots || {});
  if (!piv.length) return out;

  const lastIdx = candles.length - 1;
  const lastClose = candles[lastIdx]?.c;
  let atr = Number.isFinite(opts.atr) && opts.atr > 0 ? +opts.atr : NaN;
  if (!Number.isFinite(atr)) {
    atr = Number.isFinite(lastClose) ? Math.max(1e-9, Math.abs(lastClose) * 0.005) : 1;
  }
  const tolerance = Number.isFinite(opts.tolerance) && opts.tolerance > 0
    ? +opts.tolerance
    : atr * toleranceATR;

  out.meta = { lookback, tolerance, atr, lastBarIdx: lastIdx };

  // Take the last `lookback` swing-highs / swing-lows.
  const highs = piv.filter((p) => p.kind === "high").slice(-lookback);
  const lows  = piv.filter((p) => p.kind === "low").slice(-lookback);

  const buildLine = (raw) => {
    if (!raw || raw.length < minPivots) return null;
    const points = raw.map((p) => ({ x: p.i, y: p.price, t: p.t }));
    const fit = leastSquares(points);
    if (!Number.isFinite(fit.slope) || !Number.isFinite(fit.intercept)) return null;
    const tps = touchPoints(fit, points, tolerance);
    const sigma = residualSigma(fit);
    const score = fit.r2 * Math.min(1, tps.length / 4);
    return {
      slope: fit.slope,
      intercept: fit.intercept,
      r2: fit.r2,
      touches: tps.length,
      score,
      points: points.map((p) => ({ i: p.x, t: p.t, p: p.y })),
      touchPoints: tps.map((p) => ({ i: p.x, t: p.t, p: p.y })),
      startT: points[0].t,
      endT:   points[points.length - 1].t,
      sigma,
    };
  };

  out.upper = buildLine(highs);
  out.lower = buildLine(lows);

  // Channel geometry.
  if (out.upper && out.lower) {
    const sigBoth = (out.upper.sigma + out.lower.sigma) / 2;
    out.channel.widthATR = atr > 0 ? sigBoth / atr : 0;
    const sU = out.upper.slope, sL = out.lower.slope;
    if (Math.abs(sU) < 1e-12 && Math.abs(sL) < 1e-12) {
      out.channel.parallel = true;
    } else if (sU * sL > 0) {
      const r = Math.abs(sU) > Math.abs(sL) ? Math.abs(sL / sU) : Math.abs(sU / sL);
      out.channel.parallel = r >= 0.75;
    } else {
      out.channel.parallel = false;
    }
  }

  // Breakout: last close beyond either line by ≥ breakoutATR · ATR.
  if (Number.isFinite(lastClose)) {
    const want = atr * breakoutATR;
    let best = null;
    if (out.upper) {
      const yhat = lineAt(out.upper, lastIdx);
      const distAbs = lastClose - yhat;
      if (distAbs >= want) {
        const strength = Math.min(1, distAbs / Math.max(want, 1e-9));
        best = { side: "up", atBar: lastIdx, distATR: distAbs / atr, strength };
      }
    }
    if (out.lower) {
      const yhat = lineAt(out.lower, lastIdx);
      const distAbs = yhat - lastClose;
      if (distAbs >= want) {
        const strength = Math.min(1, distAbs / Math.max(want, 1e-9));
        const cand = { side: "down", atBar: lastIdx, distATR: distAbs / atr, strength };
        if (!best || cand.strength > best.strength) best = cand;
      }
    }
    out.lastBreakout = best;
  }

  return out;
}

/**
 * Position-in-channel: where is the latest close relative to upper / lower?
 * Returns a number in [-1, +1]:
 *   +1 ≈ pinned to the upper line, -1 ≈ pinned to the lower line, 0 ≈ midline.
 * Returns NaN when either line is missing or degenerate.
 */
export function positionInChannel(tl, lastIdx, lastClose) {
  if (!tl?.upper || !tl?.lower) return NaN;
  if (!Number.isFinite(lastIdx) || !Number.isFinite(lastClose)) return NaN;
  const u = lineAt(tl.upper, lastIdx);
  const l = lineAt(tl.lower, lastIdx);
  if (!Number.isFinite(u) || !Number.isFinite(l) || u <= l) return NaN;
  const t = (lastClose - l) / (u - l);
  return Math.max(-2, Math.min(2, 2 * t - 1));
}

/**
 * My Next Prediction v3.0 — Triple-Barrier Labeling
 * -------------------------------------------------
 * From Lopez de Prado, "Advances in Financial Machine Learning" (2018).
 *
 * For each bar i, place three barriers in forward-time:
 *   - Upper (profit):  c[i] + ptSl[0] * sigma[i]
 *   - Lower (loss):    c[i] - ptSl[1] * sigma[i]
 *   - Vertical (time): i + maxHorizon
 * Whichever is touched FIRST determines the label:
 *   +1 upper hit first   (would-be winner for long / loser for short)
 *   -1 lower hit first   (would-be loser for long / winner for short)
 *    0 vertical timeout  (neither)
 *
 * Meta-labeling: given a primary signal (direction ±1), re-label the *exit*
 * relative to that signal's direction. Used to train a secondary classifier
 * that learns when to trust the primary — a common two-stage ML pipeline.
 *
 * All functions are pure (no I/O); they operate on plain arrays of numbers
 * (high, low, close, sigma). `sigma` is typically ATR or EWM-std of returns.
 */

/**
 * Rolling standard deviation of log-returns, with Wilder-like EWMA smoothing.
 * Used as a volatility proxy (sigma) when ATR isn't available.
 *
 * @param {number[]} close
 * @param {number}   period  window size (default 20)
 * @returns {number[]} sigma[i] — NaN for the first `period` bars
 */
export function rollingReturnStd(close, period = 20) {
  const n = close.length;
  const out = new Array(n).fill(NaN);
  if (n < 2) return out;
  const rets = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const a = close[i - 1], b = close[i];
    rets[i] = a > 0 && b > 0 ? Math.log(b / a) : 0;
  }
  let sum = 0, sq = 0;
  for (let i = 1; i < n; i++) {
    sum += rets[i]; sq += rets[i] * rets[i];
    if (i >= period) {
      const drop = rets[i - period];
      sum -= drop; sq -= drop * drop;
    }
    if (i >= period) {
      const m = sum / period;
      const v = Math.max(0, sq / period - m * m);
      out[i] = Math.sqrt(v) * close[i]; // absolute-price units
    }
  }
  return out;
}

/**
 * Triple-barrier labels.
 *
 * @param {object}   args
 * @param {number[]} args.high
 * @param {number[]} args.low
 * @param {number[]} args.close
 * @param {number[]} args.sigma       volatility per bar (same units as price)
 * @param {number}   args.maxHorizon  bars to look forward before the vertical barrier
 * @param {[number,number]} [args.ptSl=[1,1]]  [upperMult, lowerMult] — barrier distance in sigma units
 * @param {number}   [args.minRet=0]  if the would-be return on a touched barrier is below this, label 0
 * @returns {Array<{
 *   i:number, t1:number|null, side:1|-1|0,
 *   upper:number, lower:number, touched:'upper'|'lower'|'time'|'nan',
 *   ret:number
 * }>}
 */
export function tripleBarrier({ high, low, close, sigma, maxHorizon, ptSl = [1, 1], minRet = 0 }) {
  const n = close.length;
  const out = new Array(n);
  const [ptMult, slMult] = ptSl;

  for (let i = 0; i < n; i++) {
    const s = sigma?.[i];
    const c = close[i];
    if (!Number.isFinite(s) || !Number.isFinite(c) || s <= 0) {
      out[i] = { i, t1: null, side: 0, upper: NaN, lower: NaN, touched: 'nan', ret: 0 };
      continue;
    }
    const upper = c + ptMult * s;
    const lower = c - slMult * s;
    const end   = Math.min(n - 1, i + maxHorizon);
    let touched = 'time';
    let t1 = end;

    // Walk forward bar-by-bar. If both barriers are touched in the same
    // bar, a conservative resolution picks whichever had the closer
    // extreme on that candle — but for OHLC we cannot know the intra-bar
    // order, so we split the difference: tie goes to the barrier closer
    // to the open/close (flat-ish bar) or the wick extreme otherwise.
    // In practice crypto 1m is granular enough that conflicts are rare.
    for (let j = i + 1; j <= end; j++) {
      const hitU = high[j] >= upper;
      const hitL = low[j]  <= lower;
      if (hitU && hitL) {
        // Tie-break: closer barrier to the bar's open wins
        const openDistU = Math.abs(close[j - 1] ?? c - upper);
        const openDistL = Math.abs(close[j - 1] ?? c - lower);
        touched = openDistU <= openDistL ? 'upper' : 'lower';
        t1 = j; break;
      }
      if (hitU) { touched = 'upper'; t1 = j; break; }
      if (hitL) { touched = 'lower'; t1 = j; break; }
    }

    let side = 0, ret = 0;
    if (touched === 'upper') { side = +1; ret = (upper - c) / c; }
    else if (touched === 'lower') { side = -1; ret = (lower - c) / c; }
    else { ret = (close[t1] - c) / c; side = 0; }

    if (Math.abs(ret) < minRet) side = 0;
    out[i] = { i, t1, side, upper, lower, touched, ret };
  }
  return out;
}

/**
 * Meta-labels: given primary directional signals (array of ±1/0, length n),
 * return +1 if the triple-barrier exit confirms the primary direction, else 0.
 *
 * Used to train a "trust the signal?" binary classifier that sits on top of
 * the primary model — cleaner precision at the cost of recall.
 *
 * @param {Array<{side:number}>} tb   output of tripleBarrier()
 * @param {Array<number>}        primary  ±1 long/short intent, 0 = no trade
 * @returns {number[]} meta[i] ∈ {0, 1}
 */
export function metaLabels(tb, primary) {
  const n = Math.min(tb.length, primary.length);
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const p = Math.sign(primary[i] || 0);
    const s = tb[i]?.side || 0;
    if (p !== 0 && p === s) out[i] = 1;
  }
  return out;
}

/**
 * Dollar-bar-style sample weights (uniqueness-weighted).
 *
 * Overlapping labels (bar i's t1 overlaps bar i+1's window) share
 * information — naively treating them as iid over-samples recent data.
 * This returns a weight ∈ (0, 1] per sample, where highly overlapping
 * samples get down-weighted. Approximation of Lopez de Prado §4.
 *
 * @param {Array<{i:number,t1:number|null}>} tb
 * @returns {number[]} weights same length as tb
 */
export function uniquenessWeights(tb) {
  const n = tb.length;
  const conc = new Array(n).fill(0);
  for (const lbl of tb) {
    if (!lbl || lbl.t1 == null) continue;
    for (let k = lbl.i; k <= lbl.t1; k++) conc[k] += 1;
  }
  const w = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const lbl = tb[i];
    if (!lbl || lbl.t1 == null) { w[i] = 0; continue; }
    let s = 0, cnt = 0;
    for (let k = lbl.i; k <= lbl.t1; k++) {
      if (conc[k] > 0) { s += 1 / conc[k]; cnt += 1; }
    }
    w[i] = cnt > 0 ? s / cnt : 0;
  }
  return w;
}

/**
 * Distribution summary for a label array (pass the `side` field).
 * @param {number[]} sides
 */
export function labelDistribution(sides) {
  let pos = 0, neg = 0, zero = 0;
  for (const s of sides) {
    if (s > 0) pos++; else if (s < 0) neg++; else zero++;
  }
  const total = sides.length || 1;
  return {
    total: sides.length,
    pos, neg, zero,
    posPct: pos / total,
    negPct: neg / total,
    zeroPct: zero / total,
    imbalance: Math.abs(pos - neg) / Math.max(1, pos + neg),
  };
}

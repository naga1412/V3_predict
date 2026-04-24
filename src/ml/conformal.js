/**
 * My Next Prediction v3.0 — Phase 9 · Conformal Prediction Intervals
 * ------------------------------------------------------------------
 * Distribution-free, model-agnostic prediction uncertainty.
 *
 * Given a calibration set (x_i, y_i) the split-conformal procedure guarantees
 * marginal coverage of (1 - α) on future exchangeable points, regardless of
 * the underlying model's quality or miscalibration.
 *
 * This module ships three conformal flavors used across the platform:
 *
 *   1. SplitConformalRegressor
 *      Non-conformity score = |y - ŷ|  (or normalized by σ).  Produces a
 *      symmetric interval [ŷ - q, ŷ + q].  Used by Phase 11 ghost candles
 *      to attach ±band around a predicted return/price.
 *
 *   2. AdaptivePredictionSet  (APS, binary)
 *      Non-conformity score = 1 - p[y_true].  Produces a prediction SET
 *      drawn from {long, short}: one of ∅, {long}, {short}, {long,short}.
 *      Used to decorate the Phase 8 ensemble probability with "is the model
 *      actually sure about direction at level (1 - α)?".  The emptiness of
 *      the set is a strong abstain signal (data point is OOD).
 *
 *   3. RollingConformal
 *      Online variant that maintains a sliding window of non-conformity
 *      scores (FIFO), rescoring the empirical quantile on each push.  Needed
 *      for a live system where the calibration distribution shifts (regime
 *      change, volatility change, exchange microstructure change).
 *
 * Guarantees only hold under exchangeability (or after CP+swap fixes like
 * ACI — out of scope for this phase).  In practice the coverage remains
 * close to target for non-stationary trading data thanks to the rolling
 * window.
 *
 * Pure, no-DOM module.  Persistence lives in `conformalStore.js`.
 */

/* ═══════════════════════════ Pure math helpers ═══════════════════════════ */

/**
 * Empirical quantile via linear interpolation ("type-7", as in numpy default).
 * Returns NaN on empty arrays.  Handles unsorted arrays (sorts a copy).
 *
 * @param {ArrayLike<number>} arr
 * @param {number} q in [0, 1]
 * @returns {number}
 */
export function quantile(arr, q) {
  if (!arr || arr.length === 0) return NaN;
  if (!Number.isFinite(q)) return NaN;
  const qc = Math.max(0, Math.min(1, q));
  // Copy + filter finite + sort ascending.
  const a = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (Number.isFinite(v)) a.push(v);
  }
  if (a.length === 0) return NaN;
  a.sort((x, y) => x - y);
  if (a.length === 1) return a[0];
  const idx = qc * (a.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  const w = idx - lo;
  return a[lo] * (1 - w) + a[hi] * w;
}

/**
 * Conformal-adjusted upper quantile: q_{⌈(n+1)(1-α)⌉/n}.
 * The (n+1)/n correction is what gives the finite-sample marginal-coverage
 * guarantee in split conformal.  Clamped to [0, 1].
 *
 * For very small n the ceiling can exceed n, in which case +∞ is returned
 * to signal "no guarantee available" — callers should check with isFinite().
 *
 * @param {ArrayLike<number>} scores  non-conformity scores (>= 0)
 * @param {number} alpha              in (0, 1), target miscoverage
 * @returns {number}                  the calibrated threshold
 */
export function conformalQuantile(scores, alpha) {
  if (!scores || scores.length === 0) return Infinity;
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) return NaN;
  // Keep only finite non-negative entries (nonconformity scores are nonneg).
  const s = [];
  for (let i = 0; i < scores.length; i++) {
    const v = scores[i];
    if (Number.isFinite(v) && v >= 0) s.push(v);
  }
  const n = s.length;
  if (n === 0) return Infinity;
  s.sort((a, b) => a - b);
  // Rank k = ⌈(n+1)(1-α)⌉; return s_(k) (1-indexed).
  const k = Math.ceil((n + 1) * (1 - alpha));
  if (k <= 0)     return s[0];
  if (k >  n)     return Infinity;   // no guarantee — return ∞
  return s[k - 1];
}

/**
 * Empirical coverage diagnostic:
 *   fraction of truths y_i that fall within the returned [lo_i, hi_i].
 *
 * @param {number[]} lows
 * @param {number[]} highs
 * @param {number[]} ys
 */
export function empiricalCoverage(lows, highs, ys) {
  const n = Math.min(lows.length, highs.length, ys.length);
  if (n === 0) return NaN;
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const l = lows[i], h = highs[i], y = ys[i];
    if (!Number.isFinite(l) || !Number.isFinite(h) || !Number.isFinite(y)) continue;
    if (y >= l && y <= h) hit++;
  }
  return hit / n;
}

/* ═══════════════════════════ Split Conformal (regression) ═══════════════════════════ */

/**
 * Non-conformity score for vanilla split-conformal regression.
 * s = |y - ŷ|
 */
export function absScore(yhat, y) { return Math.abs(y - yhat); }

/**
 * Non-conformity score for normalized split conformal regression.
 * s = |y - ŷ| / max(σ, eps)
 */
export function normalizedScore(yhat, y, sigma, eps = 1e-8) {
  const denom = Math.max(Math.abs(sigma ?? 0), eps);
  return Math.abs(y - yhat) / denom;
}

/**
 * SplitConformalRegressor
 * -----------------------
 * Use:
 *   const cp = new SplitConformalRegressor({ alpha: 0.1 });
 *   cp.fit(calibSet);                  // calibSet = [{yhat, y, sigma?}, ...]
 *   const { lo, hi } = cp.interval(12.3);          // plain
 *   const { lo, hi } = cp.interval(12.3, 0.4);     // normalized
 *
 * Throws nothing — empty calibration → quantile Infinity → interval (-∞, +∞),
 * which is the correct degenerate answer (can't guarantee coverage yet).
 */
export class SplitConformalRegressor {
  constructor(opts = {}) {
    this.alpha = Number.isFinite(opts.alpha) ? Math.max(1e-6, Math.min(1 - 1e-6, opts.alpha)) : 0.1;
    /** @type {"abs" | "normalized"} */
    this.mode = opts.mode === "normalized" ? "normalized" : "abs";
    /** @type {Float64Array | null} */
    this.scores = null;
    this.q = Infinity;
  }

  /**
   * Fit from a calibration array.
   * @param {Array<{yhat:number, y:number, sigma?:number}>} calib
   */
  fit(calib) {
    if (!Array.isArray(calib)) throw new Error("SplitConformalRegressor.fit: calib array required");
    const scores = new Float64Array(calib.length);
    let k = 0;
    for (let i = 0; i < calib.length; i++) {
      const row = calib[i];
      if (!row || !Number.isFinite(row.yhat) || !Number.isFinite(row.y)) continue;
      const s = this.mode === "normalized"
        ? normalizedScore(row.yhat, row.y, row.sigma)
        : absScore(row.yhat, row.y);
      if (!Number.isFinite(s)) continue;
      scores[k++] = s;
    }
    this.scores = scores.slice(0, k);
    this.q = conformalQuantile(this.scores, this.alpha);
    return this;
  }

  /**
   * @param {number} yhat
   * @param {number} [sigma]  only used in normalized mode
   * @returns {{lo:number, hi:number, q:number, width:number}}
   */
  interval(yhat, sigma) {
    if (!Number.isFinite(yhat)) return { lo: NaN, hi: NaN, q: this.q, width: NaN };
    let half = this.q;
    if (this.mode === "normalized") half = this.q * Math.max(Math.abs(sigma ?? 0), 1e-8);
    return {
      lo: yhat - half,
      hi: yhat + half,
      q: this.q,
      width: 2 * half,
    };
  }

  /** Recompute quantile after `.alpha` has been changed externally. */
  recompute() {
    if (!this.scores) return this;
    this.q = conformalQuantile(this.scores, this.alpha);
    return this;
  }

  /** JSON-safe snapshot for IDB persistence. */
  serialize() {
    return {
      version: 1,
      kind: "regression",
      mode: this.mode,
      alpha: this.alpha,
      q: this.q,
      scores: Array.from(this.scores || []),
    };
  }

  static deserialize(obj) {
    if (!obj || obj.version !== 1) throw new Error("SplitConformalRegressor: version mismatch");
    const cp = new SplitConformalRegressor({ alpha: obj.alpha, mode: obj.mode });
    cp.scores = Float64Array.from(obj.scores || []);
    cp.q = Number.isFinite(obj.q) ? obj.q : conformalQuantile(cp.scores, cp.alpha);
    return cp;
  }
}

/* ═══════════════════════════ APS (classification) ═══════════════════════════ */

/**
 * For a binary probability pair [p_down, p_up], return the "1 - p[y_true]"
 * non-conformity score (higher = worse).  y in {0,1}: 0=down, 1=up.
 */
export function apsScoreBinary(probs, y) {
  const p = probs[y] ?? probs[`${y}`] ?? NaN;
  if (!Number.isFinite(p)) return NaN;
  return 1 - Math.max(0, Math.min(1, p));
}

/**
 * AdaptivePredictionSet (binary)
 * ------------------------------
 * For trading we decorate the Phase 8 ensemble with a prediction SET over
 * {down, up}.  Four outcomes:
 *
 *   {up}         → confident long
 *   {down}       → confident short
 *   {up, down}   → uncertain: both labels plausible at (1-α)
 *   ∅            → abstain: neither label reaches threshold (OOD)
 *
 * The returned `classes` array is a subset of ["down", "up"].
 */
export class AdaptivePredictionSet {
  constructor(opts = {}) {
    this.alpha = Number.isFinite(opts.alpha) ? Math.max(1e-6, Math.min(1 - 1e-6, opts.alpha)) : 0.1;
    /** @type {Float64Array | null} */
    this.scores = null;
    this.q = Infinity;
  }

  /**
   * @param {Array<{probs:{0:number, 1:number}|number[], y:number}>} calib
   */
  fit(calib) {
    if (!Array.isArray(calib)) throw new Error("AdaptivePredictionSet.fit: calib array required");
    const scores = new Float64Array(calib.length);
    let k = 0;
    for (let i = 0; i < calib.length; i++) {
      const row = calib[i];
      if (!row || !row.probs) continue;
      const y = row.y;
      if (y !== 0 && y !== 1) continue;
      const s = apsScoreBinary(row.probs, y);
      if (!Number.isFinite(s)) continue;
      scores[k++] = s;
    }
    this.scores = scores.slice(0, k);
    this.q = conformalQuantile(this.scores, this.alpha);
    return this;
  }

  /**
   * Returns the prediction set for a new point given its probability pair.
   *
   * @param {{0:number, 1:number}|number[]} probs
   * @returns {{classes:string[], setSize:number, scoreUp:number, scoreDown:number, q:number, direction:"long"|"short"|"uncertain"|"abstain"}}
   */
  predictSet(probs) {
    const pDown = probs[0] ?? probs["0"] ?? 0;
    const pUp   = probs[1] ?? probs["1"] ?? 0;
    const sDown = 1 - pDown;
    const sUp   = 1 - pUp;
    const q = this.q;
    const classes = [];
    if (Number.isFinite(sDown) && sDown <= q) classes.push("down");
    if (Number.isFinite(sUp)   && sUp   <= q) classes.push("up");
    let direction = "abstain";
    if (classes.length === 2) direction = "uncertain";
    else if (classes[0] === "up")   direction = "long";
    else if (classes[0] === "down") direction = "short";
    return { classes, setSize: classes.length, scoreUp: sUp, scoreDown: sDown, q, direction };
  }

  recompute() {
    if (!this.scores) return this;
    this.q = conformalQuantile(this.scores, this.alpha);
    return this;
  }

  serialize() {
    return {
      version: 1,
      kind: "classification",
      alpha: this.alpha,
      q: this.q,
      scores: Array.from(this.scores || []),
    };
  }

  static deserialize(obj) {
    if (!obj || obj.version !== 1) throw new Error("AdaptivePredictionSet: version mismatch");
    const cp = new AdaptivePredictionSet({ alpha: obj.alpha });
    cp.scores = Float64Array.from(obj.scores || []);
    cp.q = Number.isFinite(obj.q) ? obj.q : conformalQuantile(cp.scores, cp.alpha);
    return cp;
  }
}

/* ═══════════════════════════ Rolling (online) Conformal ═══════════════════════════ */

/**
 * RollingConformal
 * ----------------
 * A FIFO ring buffer of non-conformity scores with O(1) amortized update.
 * Recomputes the (1-α) empirical quantile on demand (or on every push when
 * `autoRecompute` is true — default false to avoid O(n log n) per tick).
 *
 * Designed for the live prediction loop where ~1 score arrives per timeframe
 * bar close.  Caller does:
 *
 *   const rc = new RollingConformal({ alpha: 0.1, capacity: 500 });
 *   rc.push(Math.abs(y_true - y_pred));
 *   const q = rc.quantile();
 *   const { lo, hi } = rc.interval(y_pred);
 *
 * Capacity defaults to 500 (≈8h of 1m bars on a single symbol).
 */
export class RollingConformal {
  constructor(opts = {}) {
    this.capacity = Number.isFinite(opts.capacity) && opts.capacity > 0 ? Math.floor(opts.capacity) : 500;
    this.alpha    = Number.isFinite(opts.alpha) ? Math.max(1e-6, Math.min(1 - 1e-6, opts.alpha)) : 0.1;
    this.autoRecompute = !!opts.autoRecompute;
    /** @type {Float64Array} */
    this.buf = new Float64Array(this.capacity);
    this.head = 0;     // next write index
    this.length = 0;   // 0..capacity
    this.q = Infinity; // cached
    this.dirty = true;
  }

  /** Push a non-conformity score. Returns `this`. */
  push(score) {
    if (!Number.isFinite(score) || score < 0) return this;
    this.buf[this.head] = score;
    this.head = (this.head + 1) % this.capacity;
    if (this.length < this.capacity) this.length++;
    this.dirty = true;
    if (this.autoRecompute) this.recompute();
    return this;
  }

  /** Push multiple scores. */
  pushAll(scores) {
    for (let i = 0; i < scores.length; i++) this.push(scores[i]);
    return this;
  }

  /** Return the live quantile (recomputes lazily). */
  quantile() {
    if (this.dirty) this.recompute();
    return this.q;
  }

  recompute() {
    // Build a dense view of live samples (not ring order).
    const a = new Float64Array(this.length);
    for (let i = 0; i < this.length; i++) a[i] = this.buf[i];   // linear, insertion order
    this.q = conformalQuantile(a, this.alpha);
    this.dirty = false;
    return this;
  }

  /** Symmetric interval around ŷ using the current quantile. */
  interval(yhat) {
    const q = this.quantile();
    return { lo: yhat - q, hi: yhat + q, q, width: 2 * q };
  }

  /** Drop all stored scores (e.g., on regime break). */
  clear() {
    this.length = 0;
    this.head = 0;
    this.q = Infinity;
    this.dirty = true;
    return this;
  }

  /**
   * Live samples, ordered oldest-first.  Useful for diagnostics.
   * @returns {Float64Array}
   */
  samples() {
    const n = this.length;
    const out = new Float64Array(n);
    if (n === 0) return out;
    // When length < capacity, entries live at 0..length-1 in insertion order;
    // head points past the newest.
    if (this.length < this.capacity) {
      for (let i = 0; i < n; i++) out[i] = this.buf[i];
      return out;
    }
    // Full: oldest is at head.
    let k = 0;
    for (let i = 0; i < n; i++) out[k++] = this.buf[(this.head + i) % this.capacity];
    return out;
  }

  serialize() {
    return {
      version: 1,
      kind: "rolling",
      capacity: this.capacity,
      alpha: this.alpha,
      head: this.head,
      length: this.length,
      q: this.q,
      buf: Array.from(this.buf),
    };
  }

  static deserialize(obj) {
    if (!obj || obj.version !== 1) throw new Error("RollingConformal: version mismatch");
    const rc = new RollingConformal({ capacity: obj.capacity, alpha: obj.alpha });
    rc.buf = Float64Array.from(obj.buf || []);
    // Guard against tampered arrays — pad or trim to capacity.
    if (rc.buf.length !== rc.capacity) {
      const fixed = new Float64Array(rc.capacity);
      for (let i = 0; i < Math.min(rc.buf.length, rc.capacity); i++) fixed[i] = rc.buf[i];
      rc.buf = fixed;
    }
    rc.head = Math.max(0, Math.min(rc.capacity - 1, obj.head | 0));
    rc.length = Math.max(0, Math.min(rc.capacity, obj.length | 0));
    rc.q = Number.isFinite(obj.q) ? obj.q : Infinity;
    rc.dirty = true;
    return rc;
  }
}

/**
 * My Next Prediction v3.0 — TA math helpers
 * -----------------------------------------
 * Streaming-friendly primitives so indicators can update O(1) per new bar
 * instead of recomputing from scratch. Numerical-stability oriented:
 *   - RollingWindow keeps sum/sum² with Welford-ish bookkeeping
 *   - EMAState: classic exponential with warm-up from SMA
 *   - Rolling min/max via monotonic deques
 */

/** Fixed-length FIFO with running sum + sum of squares. */
export class RollingWindow {
  constructor(size) {
    if (!(size > 0)) throw new Error("RollingWindow size must be > 0");
    this.size = size | 0;
    this.buf = [];
    this._sum = 0;
    this._sumSq = 0;
  }
  push(x) {
    this.buf.push(x);
    this._sum += x;
    this._sumSq += x * x;
    if (this.buf.length > this.size) {
      const drop = this.buf.shift();
      this._sum   -= drop;
      this._sumSq -= drop * drop;
    }
    return this;
  }
  get filled() { return this.buf.length === this.size; }
  get length() { return this.buf.length; }
  mean() { return this.buf.length ? this._sum / this.buf.length : NaN; }
  /** Population variance (use filled window only for stability). */
  variance() {
    const n = this.buf.length;
    if (n < 2) return NaN;
    const m = this.mean();
    // avoid the naïve sum-sq minus mean² cancellation for tiny variance
    let s = 0;
    for (const x of this.buf) { const d = x - m; s += d * d; }
    return s / n;
  }
  stdev() { return Math.sqrt(this.variance()); }
  first() { return this.buf[0]; }
  last()  { return this.buf[this.buf.length - 1]; }
  /** Non-mutating snapshot for tests. */
  values() { return this.buf.slice(); }
}

/**
 * Classic EMA with SMA warm-up.  Caller pushes prices in order.
 *   state = new EMAState(period)
 *   for each price p: y = state.next(p)    // NaN during warm-up
 */
export class EMAState {
  constructor(period) {
    if (!(period > 0)) throw new Error("EMA period must be > 0");
    this.period = period | 0;
    this.k = 2 / (this.period + 1);
    this._seedSum = 0;
    this._count = 0;
    this.value = NaN;
  }
  next(x) {
    if (this._count < this.period) {
      this._seedSum += x;
      this._count++;
      if (this._count === this.period) this.value = this._seedSum / this.period;
      return this.value;
    }
    this.value = (x - this.value) * this.k + this.value;
    return this.value;
  }
}

/** Wilder smoothing (ATR, ADX, RSI use this — smoother than classic EMA). */
export class WilderState {
  constructor(period) {
    if (!(period > 0)) throw new Error("Wilder period must be > 0");
    this.period = period | 0;
    this._seedSum = 0;
    this._count = 0;
    this.value = NaN;
  }
  next(x) {
    if (this._count < this.period) {
      this._seedSum += x;
      this._count++;
      if (this._count === this.period) this.value = this._seedSum / this.period;
      return this.value;
    }
    this.value = (this.value * (this.period - 1) + x) / this.period;
    return this.value;
  }
}

/** Rolling max via monotonically-decreasing deque. O(1) amortized per push. */
export class RollingMax {
  constructor(size) { this.size = size|0; this.dq = []; this.i = 0; }
  push(x) {
    const idx = this.i++;
    while (this.dq.length && this.dq[this.dq.length - 1].v <= x) this.dq.pop();
    this.dq.push({ v: x, i: idx });
    while (this.dq.length && this.dq[0].i <= idx - this.size) this.dq.shift();
    return this.value();
  }
  value() { return this.dq.length ? this.dq[0].v : NaN; }
  get filled() { return this.i >= this.size; }
}

/** Rolling min via monotonically-increasing deque. */
export class RollingMin {
  constructor(size) { this.size = size|0; this.dq = []; this.i = 0; }
  push(x) {
    const idx = this.i++;
    while (this.dq.length && this.dq[this.dq.length - 1].v >= x) this.dq.pop();
    this.dq.push({ v: x, i: idx });
    while (this.dq.length && this.dq[0].i <= idx - this.size) this.dq.shift();
    return this.value();
  }
  value() { return this.dq.length ? this.dq[0].v : NaN; }
  get filled() { return this.i >= this.size; }
}

/** True range for an individual bar (needs prevClose). */
export function trueRange(h, l, prevClose) {
  if (!Number.isFinite(prevClose)) return h - l;
  return Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
}

/** Round to given precision without float artefacts (best-effort). */
export function round(n, dp = 8) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

/** Clamp to [lo, hi]. */
export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

/** NaN-safe last defined value. */
export function lastFinite(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i];
  return NaN;
}

/**
 * My Next Prediction v3.0 — Phase 10 · Drift detectors
 * ----------------------------------------------------
 * Pure-math, streaming-friendly distribution-shift primitives for the
 * Phase-10 monitor.  All detectors:
 *   - Zero dependencies.
 *   - Bounded memory (online / windowed).
 *   - Return plain JSON-serializable state so the monitor can persist
 *     detector snapshots to IDB without custom serializers.
 *
 * Included:
 *   • psi(baseline, live, bins)      — Population Stability Index
 *   • ksTwoSample(a, b)              — Kolmogorov-Smirnov two-sample D-stat
 *   • levelFromPSI(psi)              — traffic-light classifier
 *   • class RollingAccuracy          — online Bernoulli mean + Wilson 95% CI
 *   • class ResidualWindow           — fixed-size ring of residuals (mean/std/rmse)
 *   • class ADWINLite                — bucket-exponential change detector on scalar
 *   • class PageHinkley               — classic cumulative-mean change detector
 *
 * These are intentionally conservative defaults — the monitor wires them
 * up with tunables and decides what "shift detected" means for the app.
 *
 * Reference notes (not code):
 *   - PSI thresholds: <0.10 stable, 0.10-0.25 shift, >0.25 major shift.
 *   - KS D > critical for α=0.05 approx 1.36 * sqrt((n+m)/(n*m)).
 *   - ADWIN-lite (Bifet & Gavaldà, 2007) simplified to delta=0.002 default,
 *     exponential-bucket count-based window with mean-difference cut test.
 */

/* ═════════════════════════════ pure helpers ═════════════════════════════ */

function finiteCopy(arr) {
  if (!arr || arr.length === 0) return [];
  const out = [];
  for (let i = 0; i < arr.length; i++) if (Number.isFinite(arr[i])) out.push(arr[i]);
  return out;
}

function mean(arr) {
  if (!arr.length) return NaN;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function variance(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) { const d = arr[i] - m; s += d * d; }
  return s / (arr.length - 1);
}

/** Sort ascending copy; ignores non-finite. */
function sortedFinite(arr) {
  const a = finiteCopy(arr);
  a.sort((x, y) => x - y);
  return a;
}

/* ═════════════════════════════ PSI ═════════════════════════════ */

/**
 * Population Stability Index for continuous data.
 *
 * Bins the baseline into `bins` equal-frequency bins (quantile edges), then
 * measures how the `live` distribution's share in each bin differs from
 * baseline:
 *     PSI = Σ (p_live - p_base) * ln(p_live / p_base)
 *
 * Epsilon smoothing (`eps`) avoids log(0) when a bin is empty in one sample.
 *
 * @param {number[]} baseline
 * @param {number[]} live
 * @param {number} [bins=10]
 * @param {number} [eps=1e-6]
 * @returns {{psi:number, perBin:number[], edges:number[], baseCounts:number[], liveCounts:number[]}}
 */
export function psi(baseline, live, bins = 10, eps = 1e-6) {
  const b = sortedFinite(baseline);
  const l = finiteCopy(live);
  if (b.length === 0 || l.length === 0) {
    return { psi: NaN, perBin: [], edges: [], baseCounts: [], liveCounts: [] };
  }
  const nb = b.length;
  const B = Math.max(2, Math.floor(bins));
  // Equal-frequency edges from the baseline (quantile bin edges).
  const edges = new Array(B - 1);
  for (let i = 1; i < B; i++) {
    const q = i / B;
    const idx = Math.min(nb - 1, Math.max(0, Math.floor(q * nb)));
    edges[i - 1] = b[idx];
  }
  // Collapse adjacent duplicate edges (heavily-tied baselines).
  const uniq = [];
  for (const e of edges) if (uniq.length === 0 || e > uniq[uniq.length - 1]) uniq.push(e);
  const Buse = uniq.length + 1;

  const baseCounts = new Array(Buse).fill(0);
  const liveCounts = new Array(Buse).fill(0);
  for (const x of b) baseCounts[bucketOf(x, uniq)]++;
  for (const x of l) liveCounts[bucketOf(x, uniq)]++;

  let total = 0;
  const perBin = new Array(Buse);
  for (let i = 0; i < Buse; i++) {
    const pb = baseCounts[i] / b.length;
    const pl = liveCounts[i] / l.length;
    const pbs = pb + eps;
    const pls = pl + eps;
    const inc = (pls - pbs) * Math.log(pls / pbs);
    perBin[i] = inc;
    total += inc;
  }
  return { psi: total, perBin, edges: uniq, baseCounts, liveCounts };
}

function bucketOf(x, edges) {
  // edges sorted ascending; returns index of first bin whose upper-bound >= x.
  for (let i = 0; i < edges.length; i++) if (x <= edges[i]) return i;
  return edges.length;
}

/**
 * Map a PSI value to a coarse level.
 * @returns {"stable"|"shift"|"major"|"unknown"}
 */
export function levelFromPSI(v) {
  if (!Number.isFinite(v)) return "unknown";
  if (v < 0.10) return "stable";
  if (v < 0.25) return "shift";
  return "major";
}

/* ═════════════════════════════ KS two-sample ═════════════════════════════ */

/**
 * Kolmogorov-Smirnov two-sample D statistic.
 * Returns {d, p} where `p` is a Kolmogorov-distribution asymptotic p-value
 * (good enough for drift flagging; not meant for publication statistics).
 *
 * @param {number[]} a
 * @param {number[]} b
 */
export function ksTwoSample(a, b) {
  const A = sortedFinite(a);
  const B = sortedFinite(b);
  const n = A.length, m = B.length;
  if (n === 0 || m === 0) return { d: NaN, p: NaN, n, m };

  let i = 0, j = 0;
  let cA = 0, cB = 0;
  let d = 0;
  while (i < n && j < m) {
    const x = A[i], y = B[j];
    if (x <= y) { i++; cA = i / n; }
    if (y <= x) { j++; cB = j / m; }
    const diff = Math.abs(cA - cB);
    if (diff > d) d = diff;
  }
  // Flush remaining
  while (i < n) { i++; cA = i / n; if (Math.abs(cA - 1) > d) d = Math.abs(cA - 1); }
  while (j < m) { j++; cB = j / m; if (Math.abs(1 - cB) > d) d = Math.abs(1 - cB); }

  const en = Math.sqrt((n * m) / (n + m));
  const lam = (en + 0.12 + 0.11 / en) * d;
  const p = ksPValue(lam);
  return { d, p, n, m };
}

function ksPValue(lam) {
  // Asymptotic Kolmogorov distribution Q(λ) = 2 Σ (-1)^{j-1} exp(-2 j² λ²)
  if (!Number.isFinite(lam) || lam <= 0) return 1;
  const l2 = -2 * lam * lam;
  let sum = 0;
  let sign = 1;
  for (let j = 1; j <= 100; j++) {
    const term = sign * Math.exp(l2 * j * j);
    sum += term;
    if (Math.abs(term) < 1e-10) break;
    sign = -sign;
  }
  return Math.max(0, Math.min(1, 2 * sum));
}

/* ═════════════════════════════ RollingAccuracy ═════════════════════════════ */

/**
 * Online Bernoulli mean over a sliding window with Wilson 95% CI.
 * Stores only the ring buffer (no cumulative state) so it's bounded.
 */
export class RollingAccuracy {
  /**
   * @param {{capacity?:number}} [opts]
   */
  constructor(opts = {}) {
    const cap = Math.max(1, Math.floor(opts.capacity ?? 200));
    this.capacity = cap;
    this.buf = new Uint8Array(cap);
    this.head = 0;       // next write index
    this.length = 0;     // current fill
    this.ones = 0;       // count of 1-bits in buf
  }

  /** Push a hit/miss (truthy = 1). */
  push(hitOrMiss) {
    const v = hitOrMiss ? 1 : 0;
    if (this.length < this.capacity) {
      this.buf[this.head] = v;
      this.ones += v;
      this.head = (this.head + 1) % this.capacity;
      this.length++;
    } else {
      const old = this.buf[this.head];
      this.ones += v - old;
      this.buf[this.head] = v;
      this.head = (this.head + 1) % this.capacity;
    }
    return this;
  }

  pushAll(arr) { for (const x of arr) this.push(x); return this; }

  accuracy() { return this.length ? this.ones / this.length : NaN; }

  /** Wilson 95% CI for the current accuracy. */
  wilson95() {
    const n = this.length;
    if (!n) return { lo: NaN, hi: NaN };
    const z = 1.959963984540054;
    const phat = this.ones / n;
    const d = 1 + (z * z) / n;
    const mu = phat + (z * z) / (2 * n);
    const rad = z * Math.sqrt((phat * (1 - phat) / n) + (z * z) / (4 * n * n));
    return { lo: (mu - rad) / d, hi: (mu + rad) / d };
  }

  clear() { this.buf.fill(0); this.head = 0; this.length = 0; this.ones = 0; return this; }

  samples() {
    const out = new Array(this.length);
    const start = this.length < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.length; i++) out[i] = this.buf[(start + i) % this.capacity];
    return out;
  }

  serialize() {
    return {
      kind: "rollingAccuracy",
      capacity: this.capacity,
      length: this.length,
      head: this.head,
      ones: this.ones,
      buf: Array.from(this.buf),
    };
  }

  static deserialize(obj) {
    if (!obj || obj.kind !== "rollingAccuracy") throw new Error("RollingAccuracy.deserialize: bad payload");
    const r = new RollingAccuracy({ capacity: obj.capacity });
    const src = obj.buf || [];
    for (let i = 0; i < r.capacity; i++) r.buf[i] = src[i] ? 1 : 0;
    r.length = Math.max(0, Math.min(r.capacity, obj.length | 0));
    r.head = Math.max(0, Math.min(r.capacity - 1, obj.head | 0));
    r.ones = Math.max(0, Math.min(r.length, obj.ones | 0));
    return r;
  }
}

/* ═════════════════════════════ ResidualWindow ═════════════════════════════ */

/**
 * Sliding ring of residuals with live mean/std/RMSE.  Used to feed PSI
 * (vs. a baseline residual sample) or PageHinkley / ADWIN detectors.
 */
export class ResidualWindow {
  constructor(opts = {}) {
    const cap = Math.max(1, Math.floor(opts.capacity ?? 500));
    this.capacity = cap;
    this.buf = new Float64Array(cap);
    this.head = 0;
    this.length = 0;
  }

  push(x) {
    if (!Number.isFinite(x)) return this;
    if (this.length < this.capacity) {
      this.buf[this.head] = x;
      this.head = (this.head + 1) % this.capacity;
      this.length++;
    } else {
      this.buf[this.head] = x;
      this.head = (this.head + 1) % this.capacity;
    }
    return this;
  }

  pushAll(arr) { for (const x of arr) this.push(x); return this; }

  values() {
    const out = new Array(this.length);
    const start = this.length < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.length; i++) out[i] = this.buf[(start + i) % this.capacity];
    return out;
  }

  mean() { return mean(this.values()); }
  variance() { return variance(this.values()); }
  std() { return Math.sqrt(this.variance()); }
  rmse() {
    if (!this.length) return NaN;
    let s = 0;
    for (let i = 0; i < this.length; i++) {
      const v = this.buf[i];
      s += v * v;
    }
    // Careful: unused-slot entries beyond `length` are zeros by default;
    // during warm-up only `length` entries are valid, but we haven't written
    // past `length` yet so summing the first `length` slots works ONLY when
    // we haven't wrapped. Recompute correctly via values() to be safe.
    const arr = this.values();
    let acc = 0;
    for (const v of arr) acc += v * v;
    return Math.sqrt(acc / arr.length);
  }

  clear() { this.buf.fill(0); this.head = 0; this.length = 0; return this; }

  serialize() {
    return {
      kind: "residualWindow",
      capacity: this.capacity,
      length: this.length,
      head: this.head,
      buf: Array.from(this.buf),
    };
  }

  static deserialize(obj) {
    if (!obj || obj.kind !== "residualWindow") throw new Error("ResidualWindow.deserialize: bad payload");
    const r = new ResidualWindow({ capacity: obj.capacity });
    const src = obj.buf || [];
    for (let i = 0; i < r.capacity; i++) r.buf[i] = Number.isFinite(src[i]) ? src[i] : 0;
    r.length = Math.max(0, Math.min(r.capacity, obj.length | 0));
    r.head = Math.max(0, Math.min(r.capacity - 1, obj.head | 0));
    return r;
  }
}

/* ═════════════════════════════ ADWIN-lite ═════════════════════════════ */

/**
 * ADWIN-lite — simplified Adaptive Windowing (Bifet & Gavaldà 2007).
 *
 * Maintains a window of recent values; tries to detect a mean shift by
 * splitting the window at various cut points and comparing the two sub-means
 * with a Hoeffding-based bound.  When a shift is detected, drops the
 * older-than-cut values (so the window "forgets" pre-shift data).
 *
 * Exact ADWIN uses exponential-histogram buckets for log-memory; for our
 * scale (scalar drift on ≲ few thousand residuals) a plain ring works fine
 * and keeps the code auditable.
 *
 * Boundedness is enforced by `maxSize`.
 */
export class ADWINLite {
  /**
   * @param {{delta?:number, maxSize?:number, minSplit?:number}} [opts]
   */
  constructor(opts = {}) {
    this.delta = Number.isFinite(opts.delta) ? opts.delta : 0.002;
    this.maxSize = Math.max(32, Math.floor(opts.maxSize ?? 2048));
    this.minSplit = Math.max(4, Math.floor(opts.minSplit ?? 16));
    this.window = [];        // FIFO values
    this.lastDrift = null;   // { cut, n0, n1, mean0, mean1, ts }
    this.detectionCount = 0;
  }

  size() { return this.window.length; }

  /**
   * Push one value and test for a change.
   * Returns true if a drift was detected.
   */
  push(x) {
    if (!Number.isFinite(x)) return false;
    this.window.push(x);
    if (this.window.length > this.maxSize) this.window.shift();
    return this._detect();
  }

  pushAll(arr) {
    let any = false;
    for (const x of arr) if (this.push(x)) any = true;
    return any;
  }

  _detect() {
    const n = this.window.length;
    if (n < 2 * this.minSplit) return false;
    // Scan candidate cut points; to keep this O(n) instead of O(n²) we sweep
    // with prefix sums.
    const w = this.window;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + w[i];

    let hit = null;
    // Harmonic-mean term is the same for all cuts of a fixed n (n0+n1 = n);
    // reuse sample-range across cuts.  Bound follows the ADWIN paper:
    //     ε = R · √( (1/(2m)) · ln(4n/δ) )
    // where m = harmonic mean of n0,n1 and R is the sample range.
    const R = sampleRange(w);
    const lnTerm = Math.log((4 * n) / this.delta);
    for (let cut = this.minSplit; cut <= n - this.minSplit; cut++) {
      const n0 = cut;
      const n1 = n - cut;
      const m0 = prefix[cut] / n0;
      const m1 = (prefix[n] - prefix[cut]) / n1;
      const diff = Math.abs(m0 - m1);
      const m = 1 / (1 / n0 + 1 / n1);
      const bound = R * Math.sqrt(lnTerm / (2 * m));
      if (diff > bound) {
        hit = { cut, n0, n1, mean0: m0, mean1: m1, diff, bound };
        break; // first cut that trips the bound
      }
    }
    if (!hit) return false;
    // Drop older-than-cut values
    this.window = this.window.slice(hit.cut);
    this.lastDrift = { ...hit, ts: Date.now() };
    this.detectionCount++;
    return true;
  }

  clear() {
    this.window = [];
    this.lastDrift = null;
    this.detectionCount = 0;
    return this;
  }

  serialize() {
    return {
      kind: "adwinLite",
      delta: this.delta,
      maxSize: this.maxSize,
      minSplit: this.minSplit,
      window: this.window.slice(),
      detectionCount: this.detectionCount,
      lastDrift: this.lastDrift,
    };
  }

  static deserialize(obj) {
    if (!obj || obj.kind !== "adwinLite") throw new Error("ADWINLite.deserialize: bad payload");
    const d = new ADWINLite({ delta: obj.delta, maxSize: obj.maxSize, minSplit: obj.minSplit });
    d.window = Array.isArray(obj.window) ? obj.window.slice() : [];
    d.detectionCount = obj.detectionCount | 0;
    d.lastDrift = obj.lastDrift ?? null;
    return d;
  }
}

function sampleRange(arr) {
  if (!arr.length) return 1;
  let lo = arr[0], hi = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const r = hi - lo;
  // Guard: if all values are equal, use a small epsilon so the bound isn't 0.
  return r > 0 ? r : 1e-6;
}

/* ═════════════════════════════ Page-Hinkley ═════════════════════════════ */

/**
 * Page-Hinkley-style two-sided change detector implemented as dual CUSUM.
 * Tracks a running mean μ̂ and two one-sided statistics:
 *
 *     g_up   ← max(0, g_up   + (x - μ̂ - δ))   // detects upward drift
 *     g_down ← max(0, g_down + (μ̂ - x - δ))   // detects downward drift
 *
 * When either g exceeds `threshold` λ, a change is flagged; both statistics
 * are reset so subsequent drifts are detected independently.  This form is
 * mathematically equivalent to classical Page-Hinkley min/max bookkeeping
 * and avoids the sign mistakes easily made with running-mean subtraction.
 *
 * Good for monitoring error / loss / residual streams where the magnitude
 * of change matters more than its exact direction.
 */
export class PageHinkley {
  /**
   * @param {{delta?:number, threshold?:number, direction?:"both"|"up"|"down"}} [opts]
   */
  constructor(opts = {}) {
    this.delta = Number.isFinite(opts.delta) ? opts.delta : 0.005;
    this.threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.05;
    this.direction = opts.direction ?? "both";
    this.clear();
  }

  clear() {
    this.n = 0;
    this.mean = 0;
    this.gUp = 0;
    this.gDown = 0;
    this.detectionCount = 0;
    this.lastDrift = null;
    return this;
  }

  push(x) {
    if (!Number.isFinite(x)) return false;
    this.n++;
    // Update running mean *before* computing cumsum increments so the detector
    // measures "this sample vs. the historical mean we have so far".
    const prevMean = this.mean;
    this.mean = prevMean + (x - prevMean) / this.n;
    const devUp   = x - this.mean - this.delta;
    const devDown = this.mean - x - this.delta;
    this.gUp   = Math.max(0, this.gUp   + devUp);
    this.gDown = Math.max(0, this.gDown + devDown);

    let hit = null;
    const wantUp   = this.direction === "both" || this.direction === "up";
    const wantDown = this.direction === "both" || this.direction === "down";
    if (wantUp && this.gUp > this.threshold) {
      hit = { direction: "up", stat: this.gUp, threshold: this.threshold, n: this.n };
    } else if (wantDown && this.gDown > this.threshold) {
      hit = { direction: "down", stat: this.gDown, threshold: this.threshold, n: this.n };
    }
    if (hit) {
      const snapshot = { ...hit, ts: Date.now(), mean: this.mean };
      const keepDir = this.direction;
      const keepCount = this.detectionCount + 1;
      this.clear();
      this.direction = keepDir;
      this.detectionCount = keepCount;
      this.lastDrift = snapshot;
      return true;
    }
    return false;
  }

  pushAll(arr) {
    let any = false;
    for (const x of arr) if (this.push(x)) any = true;
    return any;
  }

  serialize() {
    return {
      kind: "pageHinkley",
      delta: this.delta,
      threshold: this.threshold,
      direction: this.direction,
      n: this.n,
      mean: this.mean,
      gUp: this.gUp,
      gDown: this.gDown,
      detectionCount: this.detectionCount,
      lastDrift: this.lastDrift,
    };
  }

  static deserialize(obj) {
    if (!obj || obj.kind !== "pageHinkley") throw new Error("PageHinkley.deserialize: bad payload");
    const p = new PageHinkley({ delta: obj.delta, threshold: obj.threshold, direction: obj.direction });
    p.n = obj.n | 0;
    p.mean = +obj.mean || 0;
    p.gUp = +obj.gUp || 0;
    p.gDown = +obj.gDown || 0;
    p.detectionCount = obj.detectionCount | 0;
    p.lastDrift = obj.lastDrift ?? null;
    return p;
  }
}

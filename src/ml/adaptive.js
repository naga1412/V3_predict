/**
 * My Next Prediction v3.0 — M5 · Adaptive module weighting
 * --------------------------------------------------------
 * Online weighting of analysis modules based on recent verdict
 * accuracy.  Each module gets an exponentially-weighted hit-rate;
 * weights renormalise so they sum to 1.
 *
 * Pure stateful object — one instance per (symbol, tf, kind).
 *
 *   const aw = new AdaptiveWeights({ alpha: 0.05, prior: 0.5 });
 *   aw.observe("trend-follow",   /direction-hit/   1);   // 1 = correct, 0 = miss
 *   aw.observe("mean-reversion", /direction-miss/  0);
 *   aw.weights();        → { "trend-follow": 0.62, "mean-reversion": 0.38 }
 *   aw.confidenceFor(id) → 0..1 EWMA hit-rate
 *
 * Used by the orchestrator to up-weight modules that have been
 * predictive in the recent regime, without retraining the NN.
 */

const DEFAULTS = Object.freeze({
  alpha: 0.05,            // EWMA smoothing coefficient
  prior: 0.5,             // initial hit-rate
  minWeight: 0.05,        // floor so a temporarily-bad module isn't zero'd out
  exponent: 1.5,          // sharpness of weight skew toward better modules
});

export class AdaptiveWeights {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    /** @type {Map<string, {ema:number, n:number}>} */
    this.scores = new Map();
  }

  /** Record one observation: hit ∈ {0,1}.  Updates EWMA in place. */
  observe(moduleId, hit) {
    if (!moduleId || (hit !== 0 && hit !== 1)) return this;
    const cur = this.scores.get(moduleId) || { ema: this.cfg.prior, n: 0 };
    const a = this.cfg.alpha;
    cur.ema = (1 - a) * cur.ema + a * hit;
    cur.n++;
    this.scores.set(moduleId, cur);
    return this;
  }

  /** EWMA hit-rate for one module (or prior if never observed). */
  confidenceFor(moduleId) {
    return this.scores.get(moduleId)?.ema ?? this.cfg.prior;
  }

  /**
   * Normalised weights.  Higher accuracy → more weight; floored at
   * `minWeight`; raised to `exponent` to amplify the lead.
   *
   * @param {string[]} [ids] subset of modules to weight (defaults to known ones)
   * @returns {Record<string, number>}
   */
  weights(ids) {
    const list = Array.isArray(ids) && ids.length ? ids : Array.from(this.scores.keys());
    if (!list.length) return {};
    const raw = {};
    let sum = 0;
    for (const id of list) {
      const ema = this.confidenceFor(id);
      // Map [0..1] EWMA → exponentiated raw weight; clamp at minWeight floor.
      const v = Math.max(this.cfg.minWeight, Math.pow(Math.max(0.001, ema), this.cfg.exponent));
      raw[id] = v;
      sum += v;
    }
    if (sum <= 0) {
      const w = 1 / list.length;
      const out = {};
      for (const id of list) out[id] = w;
      return out;
    }
    const out = {};
    for (const id of list) out[id] = +(raw[id] / sum).toFixed(4);
    return out;
  }

  /** Snapshot for serialisation. */
  toJSON() {
    return { cfg: this.cfg, scores: Array.from(this.scores.entries()) };
  }

  static fromJSON(obj) {
    const aw = new AdaptiveWeights(obj?.cfg || {});
    if (Array.isArray(obj?.scores)) {
      for (const [id, val] of obj.scores) aw.scores.set(id, { ema: val.ema, n: val.n | 0 });
    }
    return aw;
  }

  /** Plain-object view of the EMAs (for UI). */
  emaSnapshot() {
    const out = {};
    for (const [id, v] of this.scores) out[id] = +v.ema.toFixed(4);
    return out;
  }

  reset() { this.scores.clear(); return this; }
}

/**
 * Convenience: feed an aggregate orchestration result + verdict into
 * an AdaptiveWeights instance.  Each module's `signal` sign is
 * compared to the verdict's hit/miss to determine that module's
 * accuracy contribution for this bar.
 *
 * @param {AdaptiveWeights} aw
 * @param {{ signals?: Array<{moduleId?:string, signal?:number}> }} orch
 * @param {{ direction?:string, hit?:boolean }} verdict
 */
export function recordVerdict(aw, orch, verdict) {
  if (!aw || !orch || !verdict) return aw;
  const truthDir = verdict.direction === "long"  ? 1
                 : verdict.direction === "short" ? -1
                 : verdict.hit === true ? 1
                 : verdict.hit === false ? -1
                 : 0;
  if (truthDir === 0) return aw;
  for (const s of orch.signals || []) {
    const mid = s?.moduleId || s?.id;
    if (!mid) continue;
    const sigDir = Math.sign(+s?.signal || 0);
    if (sigDir === 0) continue;
    aw.observe(mid, sigDir === truthDir ? 1 : 0);
  }
  return aw;
}

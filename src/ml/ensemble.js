/**
 * My Next Prediction v3.0 — Per-regime ensemble
 * ---------------------------------------------
 * Routes prediction to the right per-regime model at inference time.
 * Regime keys are compact strings emitted by `regime/classifier.js`:
 *   "trending-up-strong-normal-vol"
 *   "range-weak-low-vol"
 *   etc.
 *
 * Two key strategies are supported, chosen per construction:
 *
 *   full     → use the full regime.label string as the key (fine-grained;
 *              lots of clusters, each with fewer training rows).
 *   trend    → coalesce on the trend axis only ("up"/"down"/"range"), so
 *              there are 3 models max (coarse; more data per model).
 *
 * A GLOBAL fallback model covers regimes that have no specialist model.
 *
 *   const ens = new RegimeEnsemble({ keyBy: "trend", fallback: globalMLP });
 *   ens.addModel("up",    upMLP);
 *   ens.addModel("range", rangeMLP);
 *   const p = ens.predict(row, regime);
 *
 * The ensemble also supports *blending* — when a regime is borderline
 * (low confidence in its category), it can average the specialist
 * output with the global fallback using a configurable weight.
 */

import { MLP } from "./nn.js";

/** @typedef {{predict:(x:Float32Array)=>Float32Array}} Predictor */

export class RegimeEnsemble {
  /**
   * @param {object} [opts]
   * @param {"full"|"trend"} [opts.keyBy="trend"]
   * @param {Predictor|null}  [opts.fallback=null]
   * @param {number} [opts.blend=0]   0 = pure specialist, 1 = pure fallback
   */
  constructor(opts = {}) {
    this.keyBy = opts.keyBy || "trend";
    this.fallback = opts.fallback || null;
    this.blend = Number.isFinite(opts.blend) ? Math.max(0, Math.min(1, opts.blend)) : 0;
    /** @type {Map<string, Predictor>} */
    this.models = new Map();
    /** @type {Map<string, object>} */
    this.meta = new Map();
  }

  /** Derive the ensemble key from a regime result (or just its label). */
  regimeKey(regime) {
    if (!regime) return null;
    const label = typeof regime === "string" ? regime : regime.label;
    if (!label) return null;
    if (this.keyBy === "full") return label;
    // "trend" strategy — first component of the dashed label.
    // "trending-up-strong-normal-vol" → "up"
    // "range-weak-low-vol"            → "range"
    // "trending-down-moderate-normal-vol" → "down"
    if (label.startsWith("trending-up"))   return "up";
    if (label.startsWith("trending-down")) return "down";
    if (label.startsWith("range"))         return "range";
    return "range";
  }

  /** Register a model under a regime key (or full label). */
  addModel(key, model, meta = {}) {
    if (typeof key !== "string" || key.length === 0) throw new Error("RegimeEnsemble.addModel: key required");
    if (!model || typeof model.predict !== "function") throw new Error("RegimeEnsemble.addModel: model must have predict()");
    this.models.set(key, model);
    this.meta.set(key, { ...meta, addedAt: Date.now() });
    return this;
  }

  setFallback(model) { this.fallback = model; return this; }

  has(key) { return this.models.has(key); }
  size()   { return this.models.size; }
  keys()   { return Array.from(this.models.keys()); }

  /** Raw predict: returns Float32Array of model outputs (typically length 1). */
  predict(x, regime) {
    const row = x instanceof Float32Array ? x : Float32Array.from(x);
    const key = this.regimeKey(regime);
    const specialist = key ? this.models.get(key) : null;
    if (!specialist && !this.fallback) {
      throw new Error(`RegimeEnsemble: no model for regime "${key}" and no fallback`);
    }
    if (!specialist) return this.fallback.predict(row);
    if (!this.fallback || this.blend <= 0) return specialist.predict(row);
    const a = specialist.predict(row);
    const b = this.fallback.predict(row);
    const out = new Float32Array(a.length);
    const w = this.blend;
    for (let i = 0; i < a.length; i++) out[i] = (1 - w) * a[i] + w * (b[i] ?? 0);
    return out;
  }

  /** Scalar shortcut (first output). */
  predictScalar(x, regime) {
    const y = this.predict(x, regime);
    return y[0];
  }

  /**
   * Batch predict, routing each row by its per-row regime.
   * @param {Float32Array} X          flat (n*d)
   * @param {number} n
   * @param {Array<string|object>} regimes  length n
   * @returns {Float32Array}
   */
  predictBatch(X, n, regimes) {
    const d = X.length / n;
    if (!Number.isInteger(d)) throw new Error("RegimeEnsemble.predictBatch: X.length not multiple of n");
    // Determine output dim from first successful predict
    const row = new Float32Array(d);
    // Peek at first row to size output
    for (let k = 0; k < d; k++) row[k] = X[k];
    const firstOut = this.predict(row, regimes[0]);
    const outDim = firstOut.length;
    const out = new Float32Array(n * outDim);
    for (let c = 0; c < outDim; c++) out[c] = firstOut[c];
    for (let i = 1; i < n; i++) {
      for (let k = 0; k < d; k++) row[k] = X[i * d + k];
      const y = this.predict(row, regimes[i]);
      for (let c = 0; c < outDim; c++) out[i * outDim + c] = y[c];
    }
    return out;
  }

  /* ───────── Serialization ───────── */

  /**
   * Serialize all models (they must be MLPs, or any model exposing
   * `.serialize()`). Returns a JSON-safe object.
   */
  serialize() {
    const models = {};
    for (const [k, m] of this.models.entries()) {
      if (typeof m.serialize !== "function") continue;
      models[k] = { weights: m.serialize(), meta: this.meta.get(k) || {} };
    }
    return {
      version: 1,
      keyBy: this.keyBy,
      blend: this.blend,
      fallback: this.fallback?.serialize?.() || null,
      models,
    };
  }

  static deserialize(obj) {
    if (!obj || obj.version !== 1) throw new Error(`RegimeEnsemble: unsupported version ${obj?.version}`);
    const ens = new RegimeEnsemble({
      keyBy: obj.keyBy,
      blend: obj.blend,
      fallback: obj.fallback ? MLP.deserialize(obj.fallback) : null,
    });
    for (const [k, v] of Object.entries(obj.models || {})) {
      ens.addModel(k, MLP.deserialize(v.weights), v.meta || {});
    }
    return ens;
  }
}

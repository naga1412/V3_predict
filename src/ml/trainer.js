/**
 * My Next Prediction v3.0 — Trainer facade
 * ----------------------------------------
 * Main-thread interface around the training worker. Handles:
 *
 *   - Worker spawn + ready gating (mirrors TAEngineProxy)
 *   - Progress callbacks bridged from worker postMessage
 *   - Main-thread fallback if Worker API unavailable or fails
 *   - Per-regime training orchestration (trainPerRegime)
 *
 *   const tr = new Trainer();
 *   await tr.ready;
 *   const { model, history } = await tr.trainOne({
 *     arch: [{in:35,out:16,act:"relu"}, {in:16,out:1,act:"sigmoid"}],
 *     loss: "bce", optimizer: "adam", lr: 0.01, seed: 42,
 *     X, Y, d: 35, outDim: 1, epochs: 30, batchSize: 32,
 *     onProgress: ({epoch, epochs, loss}) => console.log(epoch, loss),
 *   });
 *
 * For per-regime training the caller supplies a parallel `regimes` array
 * (one per training row) and the trainer partitions rows by ensemble
 * key, training one model per partition above `minRows`.
 */

import { MLP } from "./nn.js";
import { RegimeEnsemble } from "./ensemble.js";

/** Convert training-rows → {yes:long-barrier-hit, no:other} binary labels. */
export function tripleBarrierToBinary(labels) {
  // side = +1 → 1, otherwise 0
  const n = labels.length;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = labels[i]?.side === 1 ? 1 : 0;
  return Y;
}

export class Trainer {
  constructor({ workerUrl } = {}) {
    this._seq = 0;
    this._pending = new Map();
    this._fallback = false;
    this._readyResolve = null;
    this.ready = new Promise((res) => (this._readyResolve = res));
    try {
      if (typeof Worker === "undefined") throw new Error("Worker unsupported");
      const url = workerUrl || new URL("../workers/trainingWorker.js", import.meta.url).href;
      this._worker = new Worker(url, { type: "module" });
      this._worker.addEventListener("message", (ev) => this._onMessage(ev));
      this._worker.addEventListener("error", (ev) => {
        console.warn("[Trainer] worker error, falling back to main thread", ev);
        this._fallback = true;
        this._readyResolve?.();
      });
    } catch (err) {
      console.warn("[Trainer] no worker → main-thread fallback:", err.message);
      this._fallback = true;
      queueMicrotask(() => this._readyResolve?.());
    }
  }

  _onMessage(ev) {
    const { id, type } = ev.data || {};
    if (type === "ready") { this._readyResolve?.(); return; }
    const slot = this._pending.get(id);
    if (!slot) return;
    if (type === "progress") { slot.onProgress?.(ev.data); return; }
    this._pending.delete(id);
    if (type === "result") slot.resolve(ev.data);
    else if (type === "error") slot.reject(new Error(ev.data.message || "worker error"));
  }

  /**
   * Train a single model.
   * @param {object} req  see file header
   * @returns {Promise<{model: MLP, history: number[], valHistory: number[], ms: number}>}
   */
  async trainOne(req) {
    await this.ready;
    const arch = req.arch;
    if (!Array.isArray(arch) || arch.length === 0) throw new Error("trainOne: arch required");
    const payload = {
      arch,
      loss: req.loss ?? "bce",
      optimizer: req.optimizer ?? "adam",
      lr: req.lr ?? 0.01,
      l2: req.l2 ?? 0,
      seed: req.seed ?? 1,
      X: req.X,
      Y: req.Y,
      d: req.d,
      outDim: req.outDim ?? 1,
      epochs: req.epochs ?? 20,
      batchSize: req.batchSize ?? 32,
      valFrac: req.valFrac ?? 0,
    };
    if (this._fallback) {
      // Run inline
      const t0 = (typeof performance !== "undefined") ? performance.now() : Date.now();
      const mlp = new MLP({
        layers: payload.arch,
        loss: payload.loss, optimizer: payload.optimizer,
        lr: payload.lr, l2: payload.l2, seed: payload.seed,
      });
      const Xa = payload.X instanceof Float32Array ? payload.X : Float32Array.from(payload.X);
      const Ya = payload.Y instanceof Float32Array ? payload.Y : Float32Array.from(payload.Y);
      const { history, valHistory } = mlp.fit(Xa, Ya, {
        epochs: payload.epochs,
        batchSize: payload.batchSize,
        valFrac: payload.valFrac,
        onProgress: (frac, extra) => req.onProgress?.({ frac, ...extra }),
      });
      const ms = ((typeof performance !== "undefined") ? performance.now() : Date.now()) - t0;
      return { model: mlp, history, valHistory, ms };
    }
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(id, {
        resolve: (data) => {
          const model = MLP.deserialize(data.weights);
          resolve({ model, history: data.history, valHistory: data.valHistory, ms: data.ms });
        },
        reject,
        onProgress: req.onProgress,
      });
      this._worker.postMessage({ id, type: "train", ...payload });
    });
  }

  /**
   * Train a RegimeEnsemble: partitions training rows by regime key,
   * trains one model per partition (skipping partitions below `minRows`),
   * and trains a GLOBAL fallback on all rows.
   *
   * @param {object} req
   * @param {Float32Array} req.X
   * @param {Float32Array} req.Y
   * @param {number} req.d
   * @param {number} req.outDim
   * @param {Array<string|object>} req.regimes   length n
   * @param {"full"|"trend"} [req.keyBy="trend"]
   * @param {number} [req.minRows=40]
   * @param {object} req.arch  (same arch for all per-regime and global)
   * @param {object} [req.opts]  { epochs, batchSize, lr, l2, seed, loss, optimizer, valFrac }
   * @param {(key:string, data:object)=>void} [req.onProgress]
   * @returns {Promise<{ensemble: RegimeEnsemble, partitions: object}>}
   */
  async trainPerRegime(req) {
    const { X, Y, d, outDim = 1, regimes } = req;
    const n = regimes.length;
    if (n === 0) throw new Error("trainPerRegime: empty regimes");
    const keyBy = req.keyBy || "trend";
    const minRows = req.minRows ?? 40;

    // Build a temporary ensemble just for its keyRegime mapping
    const keyer = new RegimeEnsemble({ keyBy });
    const partitions = new Map();  // key -> { idx: number[] }
    for (let i = 0; i < n; i++) {
      const k = keyer.regimeKey(regimes[i]);
      if (!k) continue;
      let part = partitions.get(k);
      if (!part) { part = { idx: [] }; partitions.set(k, part); }
      part.idx.push(i);
    }
    // Prepare to train
    const ens = new RegimeEnsemble({ keyBy });
    const results = {};
    // Global first
    const gRes = await this.trainOne({
      arch: req.arch, ...(req.opts || {}),
      X, Y, d, outDim,
      onProgress: (data) => req.onProgress?.("__global__", data),
    });
    ens.setFallback(gRes.model);
    results.__global__ = { n, history: gRes.history };
    // Per-partition
    for (const [k, part] of partitions.entries()) {
      if (part.idx.length < minRows) { results[k] = { n: part.idx.length, skipped: true }; continue; }
      const Xp = new Float32Array(part.idx.length * d);
      const Yp = new Float32Array(part.idx.length * outDim);
      for (let i = 0; i < part.idx.length; i++) {
        const src = part.idx[i];
        for (let c = 0; c < d; c++) Xp[i * d + c] = X[src * d + c];
        for (let c = 0; c < outDim; c++) Yp[i * outDim + c] = Y[src * outDim + c];
      }
      const r = await this.trainOne({
        arch: req.arch, ...(req.opts || {}),
        X: Xp, Y: Yp, d, outDim,
        onProgress: (data) => req.onProgress?.(k, data),
      });
      ens.addModel(k, r.model, { rows: part.idx.length });
      results[k] = { n: part.idx.length, history: r.history, ms: r.ms };
    }
    return { ensemble: ens, partitions: results };
  }

  dispose() {
    if (this._worker) this._worker.terminate();
    this._pending.forEach(({ reject }) => reject(new Error("trainer disposed")));
    this._pending.clear();
  }
}

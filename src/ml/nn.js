/**
 * My Next Prediction v3.0 — Small MLP (pure JS)
 * ---------------------------------------------
 * A compact feed-forward neural network with backprop, mini-batch SGD,
 * and Adam. No matrix library — everything operates on Float32Array for
 * cache-friendliness and deterministic serialization.
 *
 *   const mlp = new MLP({
 *     layers: [{in: 35, out: 16, act: "relu"},
 *              {in: 16, out:  1, act: "sigmoid"}],
 *     loss: "bce",
 *     optimizer: "adam",
 *     lr: 0.01,
 *     seed: 42,
 *   });
 *   mlp.fit(X, Y, { epochs: 50, batchSize: 32, onEpoch: (ep, loss) => ... });
 *   const yHat = mlp.predict(x);
 *
 * Serialization:
 *   const blob = mlp.serialize();        // POJO, JSON-safe
 *   const m2   = MLP.deserialize(blob);  // same weights
 *
 * Scope: small NNs (input ≤ ~200, hidden ≤ ~64). This is intentional —
 * we rely on the ensemble (per-regime) + calibration for overall quality.
 */

import { mulberry32, gaussianFactory, shuffledIndices } from "./rng.js";

export const NN_VERSION = 1;

/* ─────────────────── Activations ─────────────────── */

const ACT = {
  relu: {
    fwd: (x) => (x > 0 ? x : 0),
    // derivative given pre-activation z (or post-activation a, same sign)
    dact: (a) => (a > 0 ? 1 : 0),
  },
  sigmoid: {
    fwd: (x) => 1 / (1 + Math.exp(-x)),
    dact: (a) => a * (1 - a),
  },
  tanh: {
    fwd: (x) => Math.tanh(x),
    dact: (a) => 1 - a * a,
  },
  linear: {
    fwd: (x) => x,
    dact: () => 1,
  },
};

/* ─────────────────── Weight init ─────────────────── */

function initLayer(inDim, outDim, actName, gauss) {
  // He init for relu, Xavier/Glorot for tanh/sigmoid
  const scale = (actName === "relu")
    ? Math.sqrt(2 / Math.max(1, inDim))
    : Math.sqrt(1 / Math.max(1, inDim));
  const W = new Float32Array(inDim * outDim);
  const b = new Float32Array(outDim);
  for (let i = 0; i < W.length; i++) W[i] = gauss() * scale;
  // b defaults to 0
  return { W, b };
}

/* ─────────────────── Losses ─────────────────── */

const LOSS = {
  // Binary cross-entropy; y in {0,1}, yHat in (0,1)
  bce: {
    forward: (yHat, y) => {
      const eps = 1e-7;
      const p = Math.min(1 - eps, Math.max(eps, yHat));
      return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    },
    // dL/dyHat for sigmoid+bce collapses to yHat - y
    gradOutput: (yHat, y) => yHat - y,
  },
  mse: {
    forward: (yHat, y) => 0.5 * (yHat - y) ** 2,
    gradOutput: (yHat, y) => yHat - y,
  },
};

/* ─────────────────── MLP ─────────────────── */

export class MLP {
  /**
   * @param {object} cfg
   * @param {{in:number,out:number,act:string}[]} cfg.layers
   * @param {"bce"|"mse"} [cfg.loss="bce"]
   * @param {"sgd"|"adam"} [cfg.optimizer="adam"]
   * @param {number} [cfg.lr=0.01]
   * @param {number} [cfg.l2=0]
   * @param {number} [cfg.seed=1]
   */
  constructor(cfg) {
    if (!cfg || !Array.isArray(cfg.layers) || cfg.layers.length === 0) {
      throw new Error("MLP: cfg.layers required (non-empty array)");
    }
    this.layers = cfg.layers.map(l => ({ in: l.in, out: l.out, act: l.act || "relu" }));
    this.loss = cfg.loss || "bce";
    this.optimizer = cfg.optimizer || "adam";
    this.lr = Number.isFinite(cfg.lr) ? cfg.lr : 0.01;
    this.l2 = Number.isFinite(cfg.l2) ? cfg.l2 : 0;
    this.seed = (cfg.seed >>> 0) || 1;
    this._rand = mulberry32(this.seed);
    this._gauss = gaussianFactory(this._rand);
    this.W = [];
    this.b = [];
    // Adam state
    this._mW = []; this._vW = [];
    this._mB = []; this._vB = [];
    this._step = 0;
    // Verify shapes chain
    for (let li = 0; li < this.layers.length; li++) {
      const L = this.layers[li];
      if (!(L.in > 0) || !(L.out > 0)) throw new Error(`MLP: layer ${li} invalid dims`);
      if (li > 0 && this.layers[li - 1].out !== L.in) {
        throw new Error(`MLP: layer ${li} in=${L.in} mismatches prev out=${this.layers[li-1].out}`);
      }
      if (!ACT[L.act]) throw new Error(`MLP: unknown activation "${L.act}"`);
    }
    for (const L of this.layers) {
      const { W, b } = initLayer(L.in, L.out, L.act, this._gauss);
      this.W.push(W);
      this.b.push(b);
      this._mW.push(new Float32Array(W.length));
      this._vW.push(new Float32Array(W.length));
      this._mB.push(new Float32Array(b.length));
      this._vB.push(new Float32Array(b.length));
    }
  }

  /* ────── forward pass ────── */

  _forwardStore(x) {
    // x is Float32Array of length layers[0].in
    const activations = [x];
    for (let li = 0; li < this.layers.length; li++) {
      const L = this.layers[li];
      const W = this.W[li], b = this.b[li];
      const prev = activations[li];
      const a = new Float32Array(L.out);
      const actFn = ACT[L.act].fwd;
      for (let j = 0; j < L.out; j++) {
        let z = b[j];
        // W is laid out as [inDim x outDim], index = i*outDim + j
        for (let i = 0; i < L.in; i++) z += prev[i] * W[i * L.out + j];
        a[j] = actFn(z);
      }
      activations.push(a);
    }
    return activations;
  }

  /** Single-sample prediction. Returns a Float32Array of length layers[last].out. */
  predict(x) {
    const arr = x instanceof Float32Array ? x : Float32Array.from(x);
    const acts = this._forwardStore(arr);
    return acts[acts.length - 1];
  }

  /** Scalar convenience — returns first output (useful for binary class). */
  predictScalar(x) {
    return this.predict(x)[0];
  }

  /**
   * Predict a batch. X is a flat row-major Float32Array of length n*d.
   * Returns a Float32Array of length n*outDim.
   */
  predictBatch(X, n) {
    const d = this.layers[0].in;
    const outDim = this.layers[this.layers.length - 1].out;
    const out = new Float32Array(n * outDim);
    const row = new Float32Array(d);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < d; k++) row[k] = X[i * d + k];
      const y = this.predict(row);
      for (let k = 0; k < outDim; k++) out[i * outDim + k] = y[k];
    }
    return out;
  }

  /* ────── backward pass on a single sample ────── */

  _backward(acts, y) {
    // acts[0] = input, acts[L] = output
    const L = this.layers.length;
    const outAct = acts[L];
    const outDim = outAct.length;

    // Accumulate per-layer gradients
    const gradW = this.layers.map((l) => new Float32Array(l.in * l.out));
    const gradB = this.layers.map((l) => new Float32Array(l.out));

    // Output layer: special case (assumes last act is compatible with loss)
    // For bce+sigmoid OR mse+linear we use (yHat - y) directly, then
    // propagate through earlier activations.
    let delta = new Float32Array(outDim);
    const yArr = typeof y === "number" ? [y] : y;
    for (let j = 0; j < outDim; j++) {
      delta[j] = LOSS[this.loss].gradOutput(outAct[j], yArr[j] ?? 0);
    }

    for (let li = L - 1; li >= 0; li--) {
      const layer = this.layers[li];
      const prev = acts[li];
      const curr = acts[li + 1];
      const W = this.W[li];
      // If this is not the output layer (or act isn't "pre-absorbed" into delta),
      // multiply by derivative of activation at the post-activation value.
      // For the output layer, delta was set using the combined loss-gradient
      // shortcut that ALREADY accounts for sigmoid/linear; we must NOT
      // multiply again if (loss=bce AND act=sigmoid) or (loss=mse AND act=linear).
      const isOutput = li === L - 1;
      const absorb =
        (isOutput && this.loss === "bce" && layer.act === "sigmoid") ||
        (isOutput && this.loss === "mse" && layer.act === "linear");
      if (!absorb) {
        const dact = ACT[layer.act].dact;
        for (let j = 0; j < layer.out; j++) delta[j] *= dact(curr[j]);
      }
      // Accumulate gradW[li] and gradB[li]
      const gW = gradW[li], gB = gradB[li];
      for (let j = 0; j < layer.out; j++) gB[j] += delta[j];
      for (let i = 0; i < layer.in; i++) {
        const pi = prev[i];
        const rowBase = i * layer.out;
        for (let j = 0; j < layer.out; j++) gW[rowBase + j] += pi * delta[j];
      }
      // Backprop delta to previous layer
      if (li > 0) {
        const nextDelta = new Float32Array(layer.in);
        for (let i = 0; i < layer.in; i++) {
          let s = 0;
          const rowBase = i * layer.out;
          for (let j = 0; j < layer.out; j++) s += W[rowBase + j] * delta[j];
          nextDelta[i] = s;
        }
        delta = nextDelta;
      }
    }
    return { gradW, gradB };
  }

  /* ────── optimizer step ────── */

  _applyUpdates(gradW, gradB, batchSize) {
    const invB = 1 / Math.max(1, batchSize);
    if (this.optimizer === "adam") {
      this._step++;
      const b1 = 0.9, b2 = 0.999, eps = 1e-8;
      const bc1 = 1 - Math.pow(b1, this._step);
      const bc2 = 1 - Math.pow(b2, this._step);
      for (let li = 0; li < this.layers.length; li++) {
        const W = this.W[li], b = this.b[li];
        const gW = gradW[li], gB = gradB[li];
        const mW = this._mW[li], vW = this._vW[li];
        const mB = this._mB[li], vB = this._vB[li];
        for (let k = 0; k < W.length; k++) {
          let g = gW[k] * invB + this.l2 * W[k];
          mW[k] = b1 * mW[k] + (1 - b1) * g;
          vW[k] = b2 * vW[k] + (1 - b2) * g * g;
          const mHat = mW[k] / bc1;
          const vHat = vW[k] / bc2;
          W[k] -= this.lr * mHat / (Math.sqrt(vHat) + eps);
        }
        for (let k = 0; k < b.length; k++) {
          let g = gB[k] * invB;
          mB[k] = b1 * mB[k] + (1 - b1) * g;
          vB[k] = b2 * vB[k] + (1 - b2) * g * g;
          const mHat = mB[k] / bc1;
          const vHat = vB[k] / bc2;
          b[k] -= this.lr * mHat / (Math.sqrt(vHat) + eps);
        }
      }
    } else {
      // SGD
      for (let li = 0; li < this.layers.length; li++) {
        const W = this.W[li], b = this.b[li];
        const gW = gradW[li], gB = gradB[li];
        for (let k = 0; k < W.length; k++) {
          W[k] -= this.lr * (gW[k] * invB + this.l2 * W[k]);
        }
        for (let k = 0; k < b.length; k++) {
          b[k] -= this.lr * gB[k] * invB;
        }
      }
    }
  }

  /* ────── training loop ────── */

  /**
   * @param {Float32Array|number[]} X  flat row-major, length n*d
   * @param {Float32Array|number[]} Y  flat row-major, length n*outDim
   * @param {object} opts
   * @param {number} [opts.epochs=20]
   * @param {number} [opts.batchSize=32]
   * @param {(ep:number, loss:number, extra?:object)=>void} [opts.onEpoch]
   * @param {(frac:number, extra?:object)=>void} [opts.onProgress]
   * @param {number} [opts.valFrac=0]   if >0, holds out last portion as val set
   * @returns {{history: number[], valHistory: number[]}}
   */
  fit(X, Y, opts = {}) {
    const epochs = opts.epochs ?? 20;
    const batchSize = Math.max(1, opts.batchSize ?? 32);
    const d = this.layers[0].in;
    const outDim = this.layers[this.layers.length - 1].out;
    const n = Math.floor(X.length / d);
    if (n === 0) return { history: [], valHistory: [] };
    const valFrac = Math.max(0, Math.min(0.9, opts.valFrac || 0));
    const nVal = Math.floor(n * valFrac);
    const nTrain = n - nVal;
    const history = [];
    const valHistory = [];

    const Xa = X instanceof Float32Array ? X : Float32Array.from(X);
    const Ya = Y instanceof Float32Array ? Y : Float32Array.from(Y);

    const rowX = new Float32Array(d);
    const rowY = new Float32Array(outDim);

    for (let ep = 0; ep < epochs; ep++) {
      // Shuffle training indices
      const idx = shuffledIndices(nTrain, this._rand);
      let epochLoss = 0;
      let seen = 0;
      for (let off = 0; off < nTrain; off += batchSize) {
        const bEnd = Math.min(off + batchSize, nTrain);
        const gradW = this.layers.map((l) => new Float32Array(l.in * l.out));
        const gradB = this.layers.map((l) => new Float32Array(l.out));
        let batchLoss = 0;
        for (let k = off; k < bEnd; k++) {
          const i = idx[k];
          for (let c = 0; c < d; c++) rowX[c] = Xa[i * d + c];
          for (let c = 0; c < outDim; c++) rowY[c] = Ya[i * outDim + c];
          const acts = this._forwardStore(rowX);
          // loss on this sample
          const outAct = acts[acts.length - 1];
          let sl = 0;
          for (let c = 0; c < outDim; c++) sl += LOSS[this.loss].forward(outAct[c], rowY[c]);
          batchLoss += sl;
          // backprop — accumulate into gradW/gradB
          const g = this._backward(acts, rowY);
          for (let li = 0; li < this.layers.length; li++) {
            const gw = gradW[li], gb = gradB[li];
            const gw2 = g.gradW[li], gb2 = g.gradB[li];
            for (let m = 0; m < gw.length; m++) gw[m] += gw2[m];
            for (let m = 0; m < gb.length; m++) gb[m] += gb2[m];
          }
        }
        const bn = bEnd - off;
        this._applyUpdates(gradW, gradB, bn);
        epochLoss += batchLoss;
        seen += bn;
      }
      const avgLoss = seen > 0 ? epochLoss / seen : NaN;
      history.push(avgLoss);
      // Optional validation
      let valLoss = NaN;
      if (nVal > 0) {
        let s = 0;
        for (let i = nTrain; i < n; i++) {
          for (let c = 0; c < d; c++) rowX[c] = Xa[i * d + c];
          const yHat = this.predict(rowX);
          for (let c = 0; c < outDim; c++) s += LOSS[this.loss].forward(yHat[c], Ya[i * outDim + c]);
        }
        valLoss = s / Math.max(1, nVal);
        valHistory.push(valLoss);
      }
      opts.onEpoch?.(ep + 1, avgLoss, { valLoss });
      opts.onProgress?.((ep + 1) / epochs, { epoch: ep + 1, epochs, loss: avgLoss, valLoss });
    }
    return { history, valHistory };
  }

  /* ────── serialize / deserialize ────── */

  serialize() {
    return {
      version: NN_VERSION,
      layers: this.layers.map(l => ({ ...l })),
      loss: this.loss,
      optimizer: this.optimizer,
      lr: this.lr,
      l2: this.l2,
      seed: this.seed,
      W: this.W.map(w => Array.from(w)),
      b: this.b.map(b => Array.from(b)),
      step: this._step,
    };
  }

  static deserialize(obj) {
    if (!obj || obj.version !== NN_VERSION) throw new Error(`MLP: unsupported version ${obj?.version}`);
    const m = new MLP({
      layers: obj.layers,
      loss: obj.loss,
      optimizer: obj.optimizer,
      lr: obj.lr,
      l2: obj.l2,
      seed: obj.seed,
    });
    for (let li = 0; li < obj.W.length; li++) {
      m.W[li] = Float32Array.from(obj.W[li]);
      m.b[li] = Float32Array.from(obj.b[li]);
    }
    m._step = obj.step || 0;
    return m;
  }
}

/* ─────────────────── Utility ─────────────────── */

/** Count total trainable parameters. */
export function paramCount(mlp) {
  let n = 0;
  for (let li = 0; li < mlp.layers.length; li++) {
    n += mlp.W[li].length + mlp.b[li].length;
  }
  return n;
}

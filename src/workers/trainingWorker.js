/**
 * Training worker — runs MLP.fit off the main thread.
 *
 * Protocol (postMessage):
 *   → { id, type:"train", arch, loss, optimizer, lr, l2, seed, X, Y, d, n, outDim, epochs, batchSize, valFrac }
 *   ← { id, type:"progress", epoch, epochs, loss, valLoss, frac }
 *   ← { id, type:"result", weights, history, valHistory, ms }
 *   ← { id, type:"error", message, stack }
 *
 *   (Ready) ← { id: 0, type:"ready" }
 *
 * The NaN-safety of Float32Array transfer is preserved by structured-clone
 * (we do NOT use transferables for X/Y, since the caller may want to reuse
 * them). If this becomes a bottleneck we can switch to transferring.
 */

import { MLP } from "../ml/nn.js";

self.addEventListener("message", async (ev) => {
  const req = ev.data || {};
  const { id, type } = req;
  if (type !== "train") return;
  try {
    const t0 = (typeof performance !== "undefined") ? performance.now() : Date.now();
    const mlp = new MLP({
      layers: req.arch,
      loss: req.loss,
      optimizer: req.optimizer,
      lr: req.lr,
      l2: req.l2,
      seed: req.seed,
    });
    const Xa = req.X instanceof Float32Array ? req.X : Float32Array.from(req.X || []);
    const Ya = req.Y instanceof Float32Array ? req.Y : Float32Array.from(req.Y || []);
    const { history, valHistory } = mlp.fit(Xa, Ya, {
      epochs: req.epochs ?? 20,
      batchSize: req.batchSize ?? 32,
      valFrac: req.valFrac || 0,
      onProgress: (frac, extra) => {
        try {
          self.postMessage({ id, type: "progress", frac, ...extra });
        } catch { /* best-effort */ }
      },
    });
    const ms = ((typeof performance !== "undefined") ? performance.now() : Date.now()) - t0;
    self.postMessage({
      id, type: "result",
      weights: mlp.serialize(),
      history, valHistory, ms,
    });
  } catch (err) {
    self.postMessage({ id, type: "error", message: err?.message || String(err), stack: err?.stack });
  }
});

self.postMessage({ id: 0, type: "ready" });

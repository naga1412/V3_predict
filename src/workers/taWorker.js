/**
 * TA Worker — runs TAEngine.compute off the main thread.
 *
 * Protocol (postMessage JSON):
 *   → { id, type:"compute", candles, options }
 *   ← { id, type:"result",  result }  or  { id, type:"error", message }
 *
 * The worker is a module-worker so it can `import` the engine directly.
 * Boot: `new Worker(".../taWorker.js", { type: "module" })`
 */

// Worker-side imports are relative to this file's location
import { TAEngine } from "../ta/engine.js";

self.addEventListener("message", async (ev) => {
  const { id, type, candles, options } = ev.data || {};
  if (type !== "compute") return;
  try {
    const t0 = performance.now();
    const result = TAEngine.compute(candles, options || {});
    const ms = performance.now() - t0;
    result.__workerMs = ms;
    self.postMessage({ id, type: "result", result });
  } catch (err) {
    self.postMessage({ id, type: "error", message: err?.message || String(err), stack: err?.stack });
  }
});

self.postMessage({ id: 0, type: "ready" });

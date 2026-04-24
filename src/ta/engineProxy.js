/**
 * Main-thread proxy around TA Worker.
 *
 *   const engine = new TAEngineProxy();
 *   await engine.ready;
 *   const ta = await engine.compute(candles, options);
 *   engine.dispose();
 *
 * If Workers are unavailable (caps.workers === false), falls back to
 * inline TAEngine on the main thread — caller code is unchanged.
 */

import { TAEngine } from "./engine.js";

export class TAEngineProxy {
  constructor({ workerUrl } = {}) {
    this._seq = 0;
    this._pending = new Map();
    this._fallback = false;
    this._readyResolve = null;
    this.ready = new Promise((res) => (this._readyResolve = res));
    try {
      if (typeof Worker === "undefined") throw new Error("Worker unsupported");
      // Resolve the URL so it works whether we're loaded from http:// or (theoretically) file://.
      const url = workerUrl || new URL("../workers/taWorker.js", import.meta.url).href;
      this._worker = new Worker(url, { type: "module" });
      this._worker.addEventListener("message", (ev) => this._onMessage(ev));
      this._worker.addEventListener("error", (ev) => {
        console.warn("[TAEngineProxy] worker error, falling back to main thread", ev);
        this._fallback = true;
        this._readyResolve?.();
      });
    } catch (err) {
      console.warn("[TAEngineProxy] no worker → main-thread fallback:", err.message);
      this._fallback = true;
      queueMicrotask(() => this._readyResolve?.());
    }
  }

  _onMessage(ev) {
    const { id, type, result, message } = ev.data || {};
    if (type === "ready") { this._readyResolve?.(); return; }
    const slot = this._pending.get(id);
    if (!slot) return;
    this._pending.delete(id);
    if (type === "result") slot.resolve(result);
    else if (type === "error") slot.reject(new Error(message || "worker error"));
  }

  async compute(candles, options = {}) {
    await this.ready;
    if (this._fallback) return TAEngine.compute(candles, options);
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, type: "compute", candles, options });
    });
  }

  dispose() {
    if (this._worker) this._worker.terminate();
    this._pending.forEach(({ reject }) => reject(new Error("proxy disposed")));
    this._pending.clear();
  }
}

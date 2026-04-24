/**
 * My Next Prediction v3.0 — ResilienceLayer
 * -----------------------------------------
 * Cross-cutting guard fabric every feature flows through.
 * Handles: health probes, circuit breakers, exponential backoff, graceful degrade,
 *          online/offline transitions, quota monitoring.
 * Scenarios covered: #29, #39-45, #46, #74-77, #121, #135 and more.
 */

import { EventBus } from "./bus.js";

/* ───────── Circuit breaker ───────── */

export class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {number} [opts.threshold=5]     consecutive failures to open
   * @param {number} [opts.cooldownMs=30000] time before half-open probe
   * @param {number} [opts.halfOpenMax=1]   concurrent probes when half-open
   */
  constructor({ name, threshold = 5, cooldownMs = 30_000, halfOpenMax = 1 }) {
    this.name = name;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.halfOpenMax = halfOpenMax;
    this.state = "closed";
    this.fails = 0;
    this.openedAt = 0;
    this.inflight = 0;
  }

  canPass() {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half";
        this.inflight = 0;
      } else return false;
    }
    if (this.state === "half") return this.inflight < this.halfOpenMax;
    return false;
  }

  onSuccess() {
    if (this.state === "half") EventBus.emit("circuit:close", { name: this.name });
    this.state = "closed";
    this.fails = 0;
    this.inflight = Math.max(0, this.inflight - 1);
  }

  onFailure(err) {
    this.inflight = Math.max(0, this.inflight - 1);
    this.fails++;
    if (this.state === "half" || this.fails >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
      EventBus.emit("circuit:open", { name: this.name, err: String(err?.message || err) });
    }
  }

  async run(fn) {
    if (!this.canPass()) {
      const e = new Error(`circuit[${this.name}] open`);
      e.code = "CIRCUIT_OPEN"; throw e;
    }
    this.inflight++;
    try { const r = await fn(); this.onSuccess(); return r; }
    catch (err) { this.onFailure(err); throw err; }
  }
}

/* ───────── Retry with backoff ───────── */

/**
 * Exponential backoff with jitter & optional deadline.
 * @param {() => Promise<any>} fn
 * @param {{tries?:number, baseMs?:number, maxMs?:number, signal?:AbortSignal, onAttempt?:Function}} opts
 */
export async function withRetry(fn, opts = {}) {
  const { tries = 4, baseMs = 400, maxMs = 8_000, signal, onAttempt } = opts;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    try {
      onAttempt?.(i);
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === tries - 1) break;
      const wait = Math.min(maxMs, baseMs * (2 ** i)) * (0.7 + 0.6 * Math.random());
      await sleepAbortable(wait, signal);
    }
  }
  throw lastErr;
}

export function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason || new Error("aborted")); }, { once: true });
  });
}

/* ───────── Health registry ───────── */

class HealthRegistry {
  constructor() {
    this.checks = new Map();
    this.state  = new Map(); // name → {ok, lastOk, lastErr}
    this.timer  = null;
  }

  register(name, check, { intervalMs = 30_000 } = {}) {
    this.checks.set(name, { check, intervalMs, nextAt: 0 });
    this.state.set(name, { ok: null, lastOk: 0, lastErr: null });
  }

  async runOnce(name) {
    const entry = this.checks.get(name); if (!entry) return;
    try {
      const ok = await entry.check();
      this.state.set(name, { ok: !!ok, lastOk: Date.now(), lastErr: null });
      EventBus.emit("health", { name, ok: !!ok });
    } catch (err) {
      this.state.set(name, { ok: false, lastOk: this.state.get(name)?.lastOk || 0, lastErr: String(err?.message || err) });
      EventBus.emit("health", { name, ok: false, err: String(err?.message || err) });
    }
  }

  start() {
    if (this.timer) return;
    // Run each probe per its interval
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [name, entry] of this.checks) {
        if (now >= entry.nextAt) {
          entry.nextAt = now + entry.intervalMs;
          this.runOnce(name);
        }
      }
    }, 2_000);
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  snapshot() { return Object.fromEntries(this.state); }
}

export const Health = new HealthRegistry();

/* ───────── Online/offline ───────── */

export function wireNetworkEvents() {
  const emit = () => EventBus.emit("net", { online: navigator.onLine });
  addEventListener("online", emit);
  addEventListener("offline", emit);
  emit();
}

/* ───────── Visibility ───────── */

export function wireVisibility() {
  document.addEventListener("visibilitychange", () => {
    EventBus.emit("visibility", { visible: !document.hidden });
  });
}

/* ───────── Quota watcher (#46) ───────── */

export function wireQuotaWatcher({ intervalMs = 60_000 } = {}) {
  if (!(navigator.storage && navigator.storage.estimate)) return;
  const tick = async () => {
    try {
      const e = await navigator.storage.estimate();
      const freePct = e.quota ? 1 - e.usage / e.quota : null;
      EventBus.emit("quota", { quota: e.quota || 0, usage: e.usage || 0, freePct });
      if (freePct != null && freePct < 0.1) {
        EventBus.emit("quota:low", { freePct });
      }
    } catch {}
  };
  tick();
  setInterval(tick, intervalMs);
}

/* ───────── Degrade mode ───────── */

const _flags = new Set();

export function degrade(flag, reason) {
  if (_flags.has(flag)) return;
  _flags.add(flag);
  console.warn(`[MNP] degrade: ${flag} — ${reason}`);
  EventBus.emit("degrade", { flag, reason });
}

export function restore(flag) {
  if (!_flags.delete(flag)) return;
  EventBus.emit("restore", { flag });
}

export function isDegraded(flag) { return _flags.has(flag); }
export function degradedFlags() { return [..._flags]; }

/* ───────── Fetch wrapper with timeout + circuit ───────── */

export async function fetchGuarded(url, { timeoutMs = 10_000, breaker, signal, ...init } = {}) {
  const ctl = new AbortController();
  const onExt = () => ctl.abort(signal?.reason || new Error("aborted"));
  signal?.addEventListener("abort", onExt, { once: true });
  const t = setTimeout(() => ctl.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
  const run = async () => {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return r;
  };
  try { return breaker ? await breaker.run(run) : await run(); }
  finally { clearTimeout(t); signal?.removeEventListener("abort", onExt); }
}

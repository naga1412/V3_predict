/**
 * My Next Prediction v3.0 — Tiny EventBus
 * ---------------------------------------
 * Zero-dep pub/sub for cross-module coordination. Not a replacement for
 * BroadcastChannel — that is for cross-tab; this is within a single tab.
 */

class Bus {
  constructor() { this.map = new Map(); }

  on(topic, fn) {
    if (!this.map.has(topic)) this.map.set(topic, new Set());
    this.map.get(topic).add(fn);
    return () => this.off(topic, fn);
  }

  off(topic, fn) {
    this.map.get(topic)?.delete(fn);
  }

  once(topic, fn) {
    const off = this.on(topic, (data) => { off(); fn(data); });
    return off;
  }

  emit(topic, data) {
    const subs = this.map.get(topic);
    if (!subs || !subs.size) return;
    for (const fn of subs) {
      try { fn(data); }
      catch (err) { console.error(`[bus:${topic}]`, err); }
    }
  }
}

export const EventBus = new Bus();

// Wildcard helper: subscribe to multiple topics
EventBus.onMany = function (topics, fn) {
  const offs = topics.map((t) => this.on(t, (d) => fn(t, d)));
  return () => offs.forEach((o) => o());
};

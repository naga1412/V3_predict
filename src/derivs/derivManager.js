/**
 * My Next Prediction v3.0 — M4c · Deriv Manager
 * ---------------------------------------------
 * Per-(symbol) auto-refreshing snapshot of OI / funding / L-S ratio
 * via Binance USDT-M futures.  Cached in memory for 60 s; the UI
 * subscribes via `subscribe()` for change events.
 *
 * Crypto-only (other asset classes have no comparable public derivs
 * feed).  When the symbol isn't a crypto USDT pair, the manager
 * returns null without firing any fetch.
 */

import { EventBus } from "../core/bus.js";
import { snapshot as fetchSnapshot } from "./binanceFutures.js";

const TTL_MS = 60_000;     // re-fetch at most every minute
const _cache = new Map();  // key: wire symbol → { snap, ts }
const _listeners = new Set();
const _inflight = new Map();

function fire(symbol, snap) {
  for (const fn of _listeners) try { fn({ symbol, snap }); } catch {}
  try { EventBus.emit("deriv:snapshot", { symbol, snap }); } catch {}
}

function isCryptoUSDT(symbol) {
  if (!symbol) return false;
  const s = String(symbol).toUpperCase();
  return /USDT(:.*)?$/.test(s) || /USD_PERP/.test(s);
}

/**
 * Returns the cached snapshot if fresh, else triggers a network fetch.
 * Concurrent calls coalesce.
 */
export async function getSnapshot(symbol, { signal, force = false } = {}) {
  if (!isCryptoUSDT(symbol)) return null;
  const key = String(symbol).replace(/:.*$/, "").toUpperCase();
  const cached = _cache.get(key);
  if (!force && cached && (Date.now() - cached.ts) < TTL_MS) return cached.snap;
  if (_inflight.has(key)) return _inflight.get(key);
  const p = (async () => {
    try {
      const snap = await fetchSnapshot(symbol, { signal });
      _cache.set(key, { snap, ts: Date.now() });
      fire(key, snap);
      return snap;
    } catch (err) {
      try { EventBus.emit("deriv:error", { symbol: key, error: err?.message || String(err) }); } catch {}
      return null;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

/** Subscribe to snapshot updates.  Returns off(). */
export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Drop cache — tests / settings nuke. */
export function clear() {
  _cache.clear();
  _inflight.clear();
}

/** Inspect what's in cache (UI debug). */
export function listCached() {
  return Array.from(_cache.entries()).map(([sym, { ts, snap }]) => ({ symbol: sym, ts, hasSnap: !!snap }));
}

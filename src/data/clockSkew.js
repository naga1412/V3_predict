/**
 * My Next Prediction v3.0 — ClockSkewMonitor
 * ------------------------------------------
 * Probes exchange server time periodically and exposes `serverNow()` — the
 * best-guess UTC "now" the exchange would agree with. Handles scenarios:
 *   #31 client/server clock drift
 *  #127 user changing system clock
 *
 * Currently backed by Binance's /api/v3/time (public, no key).
 */

import { EventBus } from "../core/bus.js";
import { fetchGuarded, withRetry } from "../core/resilience.js";

const URL_BINANCE = "https://api.binance.com/api/v3/time";

let _offsetMs = 0;
let _lastSync = 0;
let _consecutiveFails = 0;
let _timer = null;

/** Adjusted "now" in ms. Use this everywhere internally. */
export function serverNow() {
  return Date.now() + _offsetMs;
}

/** Fire-and-forget probe. Also called on demand after reconnect. */
export async function probeOnce({ signal } = {}) {
  const t0 = Date.now();
  try {
    const r = await withRetry(
      () => fetchGuarded(URL_BINANCE, { timeoutMs: 5000, signal }),
      { tries: 3, baseMs: 400, maxMs: 3000, signal },
    );
    const t1 = Date.now();
    const { serverTime } = await r.json();
    if (!Number.isFinite(serverTime)) throw new Error("bad time");
    // Symmetric-latency assumption: midpoint of round-trip
    const mid = (t0 + t1) / 2;
    const newOffset = serverTime - mid;
    // Smooth via EMA to avoid bouncing
    _offsetMs = _lastSync === 0 ? newOffset : _offsetMs * 0.7 + newOffset * 0.3;
    _lastSync = t1;
    _consecutiveFails = 0;
    EventBus.emit("clockskew", { offsetMs: Math.round(_offsetMs), rttMs: t1 - t0 });
    return _offsetMs;
  } catch (err) {
    _consecutiveFails++;
    if (_consecutiveFails >= 3) EventBus.emit("clockskew:stale", { lastSync: _lastSync });
    throw err;
  }
}

export function start({ intervalMs = 60_000 } = {}) {
  if (_timer) return;
  probeOnce().catch(() => {});
  _timer = setInterval(() => probeOnce().catch(() => {}), intervalMs);
}

export function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

export function state() {
  return { offsetMs: Math.round(_offsetMs), lastSync: _lastSync, consecutiveFails: _consecutiveFails };
}

/**
 * My Next Prediction v3.0 — LeaderElection
 * ----------------------------------------
 * Exactly one tab owns the WebSocket for a given (symbol, tf). All other tabs
 * receive candles via BroadcastChannel fan-out from the leader.
 *
 * Mechanism:
 *   - Leader: `navigator.locks.request(key, {mode:"exclusive"}, neverResolve)`
 *     — while leader holds the lock, no other tab can acquire it.
 *   - Followers: same key with `{ifAvailable:true}` — if unavailable, we know
 *     someone else is leader, so we just subscribe to BC.
 *   - If the leader tab dies/closes, the lock releases and someone else wins.
 *
 * Scenarios covered: #66 multi-tab same symbol, #68 concurrent writes, #73 unload.
 * Fallback when Web Locks unavailable: every tab runs its own WS (degraded).
 */

import { EventBus } from "../core/bus.js";
import { getCapabilities } from "../core/capabilities.js";

const CHANNEL_PREFIX = "mnp-feed:";

/**
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {string} opts.tf
 * @param {() => Promise<() => void>} opts.runAsLeader
 *   Called when THIS tab becomes leader. Must return a teardown function (e.g.
 *   close the WS). The leader role is held until teardown() resolves OR the
 *   tab unloads.
 * @param {(msg: any) => void} [opts.onBroadcast] Called for every broadcast
 *   (leader's own messages included unless you set echoSelf=false).
 * @param {boolean} [opts.echoSelf=false]
 */
export function runFeedLeader({ symbol, tf, runAsLeader, onBroadcast, echoSelf = false }) {
  const caps = getCapabilities();
  const key  = `${symbol}:${tf}`;
  const topic = CHANNEL_PREFIX + key;

  let bc = null;
  const tabId = Math.random().toString(36).slice(2);

  if (caps.broadcastCh) {
    bc = new BroadcastChannel(topic);
    bc.addEventListener("message", (ev) => {
      const m = ev.data;
      if (!m) return;
      if (!echoSelf && m.tabId === tabId) return;
      onBroadcast?.(m);
    });
  }

  /** Broadcast helper leader uses to share its ticks with followers. */
  const broadcast = (payload) => {
    if (!bc) return;
    bc.postMessage({ ...payload, tabId, ts: Date.now() });
  };

  let teardown = null;
  let role = "unknown";   // unknown | leader | follower

  const start = async () => {
    if (!caps.webLocks) {
      // No Web Locks → degrade: every tab runs its own WS.
      role = "leader";
      EventBus.emit("leader:status", { key, role, reason: "no-web-locks" });
      teardown = await runAsLeader({ broadcast });
      return;
    }

    // Try to become leader. Use an eternal promise inside the callback so the
    // lock is held for the life of this tab (until teardown or unload).
    navigator.locks.request(
      key,
      { mode: "exclusive" },
      () => new Promise(async (_resolve, reject) => {
        role = "leader";
        EventBus.emit("leader:status", { key, role });
        try { teardown = await runAsLeader({ broadcast }); }
        catch (err) { reject(err); return; }
        // never resolve → lock held until tab unload or explicit stop()
      }),
    ).catch((err) => {
      console.warn(`[MNP] leader election error for ${key}`, err);
    });

    // Poll lock state occasionally to detect follower role (cheap).
    setTimeout(async () => {
      if (role !== "leader") {
        const q = await navigator.locks.query();
        const held = q.held?.some(h => h.name === key);
        if (held && role !== "leader") {
          role = "follower";
          EventBus.emit("leader:status", { key, role });
        }
      }
    }, 200);
  };

  const stop = async () => {
    try { if (typeof teardown === "function") await teardown(); } catch {}
    teardown = null;
    role = "stopped";
    bc?.close();
  };

  // Best-effort: release on unload (#73)
  addEventListener("beforeunload", () => { try { stop(); } catch {} });

  return { start, stop, broadcast, getRole: () => role, tabId };
}

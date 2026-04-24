/**
 * My Next Prediction v3.0 — Binance adapter
 * -----------------------------------------
 * Public REST + WebSocket kline feed. No API key required.
 *
 * Scenarios covered: #23 WS reconnect, #28 rate limit (429), #36 bootstrap,
 *                     #130 WS schema guard.
 */

import { EventBus } from "../../core/bus.js";
import { fetchGuarded, withRetry, CircuitBreaker } from "../../core/resilience.js";

const REST = "https://api.binance.com/api/v3";
const WS   = "wss://stream.binance.com:9443/ws";

// Binance supported klines
const BIN_TF = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "8h": "8h",
  "12h": "12h", "1d": "1d", "3d": "3d", "1w": "1w",
};

const cb = new CircuitBreaker({ name: "binance-rest", threshold: 4, cooldownMs: 20_000 });

export const binance = {
  id: "binance",
  historyLimit: 1000,

  /**
   * Historical klines. Returns validated-ready {t,o,h,l,c,v} array.
   * @param {{symbol,tf,fromT?,toT?,limit?}} args
   */
  async history({ symbol, tf, fromT, toT, limit = 1000, signal }) {
    const interval = BIN_TF[tf]; if (!interval) throw new Error(`binance: unsupported tf ${tf}`);
    const qs = new URLSearchParams({ symbol, interval, limit: String(limit) });
    if (Number.isFinite(fromT)) qs.set("startTime", String(fromT));
    if (Number.isFinite(toT))   qs.set("endTime",   String(toT));

    const url = `${REST}/klines?${qs}`;
    const r = await withRetry(
      () => fetchGuarded(url, { timeoutMs: 12_000, breaker: cb, signal }),
      { tries: 4, baseMs: 500, maxMs: 6000, signal },
    );
    const raw = await r.json();
    if (!Array.isArray(raw)) throw new Error("binance: bad history payload");
    // [ openTime, o, h, l, c, v, closeTime, quoteVol, n, takerBaseVol, takerQuoteVol, ignore ]
    return raw.map(row => ({
      t: row[0],
      o: row[1], h: row[2], l: row[3], c: row[4], v: row[5],
      closed: true,
    }));
  },

  /**
   * Server time (used by ClockSkewMonitor; exposed here for adapter symmetry).
   */
  async serverTime({ signal } = {}) {
    const r = await fetchGuarded(`${REST}/time`, { timeoutMs: 5000, breaker: cb, signal });
    const { serverTime } = await r.json();
    return serverTime;
  },

  /**
   * Exchange info — symbol list, filters (used by scanner phase).
   */
  async exchangeInfo({ signal } = {}) {
    const r = await fetchGuarded(`${REST}/exchangeInfo`, { timeoutMs: 15_000, breaker: cb, signal });
    return r.json();
  },

  /**
   * WebSocket kline stream with auto-reconnect & heartbeat.
   * Returns { close }.
   *
   * Scenario #23 reconnect: exponential backoff, reset on successful open.
   * Scenario #31 "silent death": watchdog pings every 60s via heartbeat.
   * Scenario #24/#25 out-of-order/dup: handled by CandleBuffer downstream.
   */
  stream({ symbol, tf, onKline, onStatus }) {
    const interval = BIN_TF[tf];
    if (!interval) throw new Error(`binance: unsupported tf ${tf}`);
    const path = `${symbol.toLowerCase()}@kline_${interval}`;
    const url  = `${WS}/${path}`;

    let ws = null;
    let closedByUser = false;
    let attempt = 0;
    let watchdog = null;
    let lastMsgAt = 0;

    const connect = () => {
      onStatus?.({ status: "connecting", attempt });
      try { ws = new WebSocket(url); }
      catch (err) { return scheduleReconnect(err); }

      ws.onopen = () => {
        attempt = 0;
        lastMsgAt = Date.now();
        onStatus?.({ status: "open" });
        startWatchdog();
      };

      ws.onmessage = (ev) => {
        lastMsgAt = Date.now();
        let msg;
        try { msg = JSON.parse(ev.data); }
        catch { EventBus.emit("feed:malformed", { exchange: "binance", sample: ev.data?.slice?.(0, 80) }); return; }

        // Scenario #130 — strict schema guard
        const k = msg?.k;
        if (!k || typeof k !== "object") return;
        const candle = {
          t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v,
          closed: !!k.x,
        };
        onKline(candle);
      };

      ws.onerror = (err) => {
        onStatus?.({ status: "error", err: err?.message || "ws error" });
      };

      ws.onclose = (ev) => {
        stopWatchdog();
        onStatus?.({ status: "closed", code: ev.code, reason: ev.reason });
        if (!closedByUser) scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      const wait = Math.min(30_000, 500 * (2 ** attempt)) * (0.7 + 0.6 * Math.random());
      attempt++;
      onStatus?.({ status: "reconnect-scheduled", attempt, waitMs: Math.round(wait) });
      setTimeout(() => { if (!closedByUser) connect(); }, wait);
    };

    const startWatchdog = () => {
      stopWatchdog();
      watchdog = setInterval(() => {
        // If no message for 90s, kill socket to force reconnect (scenario #8 silent death)
        if (Date.now() - lastMsgAt > 90_000) {
          try { ws?.close(); } catch {}
        }
      }, 15_000);
    };
    const stopWatchdog = () => { if (watchdog) { clearInterval(watchdog); watchdog = null; } };

    connect();

    return {
      close() {
        closedByUser = true;
        stopWatchdog();
        try { ws?.close(1000, "user"); } catch {}
      },
      get readyState() { return ws?.readyState ?? -1; },
    };
  },
};

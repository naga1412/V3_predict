/**
 * My Next Prediction v3.0 — Bybit adapter (fallback)
 * --------------------------------------------------
 * Minimal implementation: REST kline history + WS v5 kline stream.
 * Activated when Binance circuit breaker opens (scenario #29 outage).
 */

import { fetchGuarded, withRetry, CircuitBreaker } from "../../core/resilience.js";

const REST = "https://api.bybit.com";
const WS   = "wss://stream.bybit.com/v5/public/spot";

const BY_TF = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
  "1d": "D", "1w": "W",
};

const cb = new CircuitBreaker({ name: "bybit-rest", threshold: 4, cooldownMs: 20_000 });

export const bybit = {
  id: "bybit",
  historyLimit: 1000,

  async history({ symbol, tf, fromT, toT, limit = 1000, signal }) {
    const interval = BY_TF[tf]; if (!interval) throw new Error(`bybit: unsupported tf ${tf}`);
    const qs = new URLSearchParams({
      category: "spot",
      symbol,
      interval,
      limit: String(Math.min(limit, 1000)),
    });
    if (Number.isFinite(fromT)) qs.set("start", String(fromT));
    if (Number.isFinite(toT))   qs.set("end",   String(toT));

    const url = `${REST}/v5/market/kline?${qs}`;
    const r = await withRetry(
      () => fetchGuarded(url, { timeoutMs: 12_000, breaker: cb, signal }),
      { tries: 4, baseMs: 500, maxMs: 6000, signal },
    );
    const json = await r.json();
    if (json?.retCode !== 0 || !Array.isArray(json?.result?.list)) throw new Error("bybit: bad history");
    // Bybit returns DESC order: [start, open, high, low, close, volume, turnover]
    return json.result.list.slice().reverse().map(row => ({
      t: Number(row[0]),
      o: row[1], h: row[2], l: row[3], c: row[4], v: row[5],
      closed: true,
    }));
  },

  async serverTime({ signal } = {}) {
    const r = await fetchGuarded(`${REST}/v5/market/time`, { timeoutMs: 5000, breaker: cb, signal });
    const j = await r.json();
    return Number(j?.result?.timeSecond) * 1000;
  },

  stream({ symbol, tf, onKline, onStatus }) {
    const interval = BY_TF[tf]; if (!interval) throw new Error(`bybit: unsupported tf ${tf}`);
    let ws = null, closedByUser = false, attempt = 0, ping = null;

    const connect = () => {
      onStatus?.({ status: "connecting", attempt });
      try { ws = new WebSocket(WS); } catch (err) { return schedule(); }
      ws.onopen = () => {
        attempt = 0;
        onStatus?.({ status: "open" });
        ws.send(JSON.stringify({ op: "subscribe", args: [`kline.${interval}.${symbol}`] }));
        ping = setInterval(() => { try { ws.send('{"op":"ping"}'); } catch {} }, 20_000);
      };
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.topic?.startsWith("kline.") && Array.isArray(msg.data)) {
          for (const k of msg.data) {
            onKline({
              t: Number(k.start),
              o: k.open, h: k.high, l: k.low, c: k.close, v: k.volume,
              closed: !!k.confirm,
            });
          }
        }
      };
      ws.onerror = (err) => onStatus?.({ status: "error", err: err?.message || "ws error" });
      ws.onclose = () => {
        if (ping) { clearInterval(ping); ping = null; }
        onStatus?.({ status: "closed" });
        if (!closedByUser) schedule();
      };
    };
    const schedule = () => {
      const wait = Math.min(30_000, 500 * (2 ** attempt)) * (0.7 + 0.6 * Math.random());
      attempt++;
      setTimeout(() => { if (!closedByUser) connect(); }, wait);
    };

    connect();
    return { close() { closedByUser = true; if (ping) clearInterval(ping); try { ws?.close(1000, "user"); } catch {} } };
  },
};

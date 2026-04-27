/**
 * My Next Prediction v3.0 — M3.5 · Stooq CSV adapter
 * --------------------------------------------------
 * End-of-day OHLCV for stocks / ETFs / commodities / indices via
 * stooq.com's free CSV endpoint.  Stooq returns rows of:
 *
 *   Date,Open,High,Low,Close,Volume[,OpenInt]
 *   2024-01-02,180.00,181.50,179.20,181.00,55000000
 *
 * Daily granularity only — no real-time stream.  We expose a poll-based
 * `stream()` so the feed manager can plug us in like any other exchange;
 * the UI shows a "static · EOD" badge.
 *
 *   GET https://stooq.com/q/d/l/?s=<sym>&d1=<YYYYMMDD>&d2=<YYYYMMDD>&i=d
 *
 * `<sym>` is Stooq's lowercased ticker.  US tickers append `.us`,
 * London tickers `.uk`, Tokyo `.jp`, etc.  The universe registry stores
 * the canonical id and a `stooqSym` override when needed.
 */

import { fetchGuarded, withRetry, CircuitBreaker } from "../../core/resilience.js";
import { getSymbol } from "../universe.js";

const REST = "https://stooq.com/q/d/l";
const cb   = new CircuitBreaker({ name: "stooq-rest", threshold: 4, cooldownMs: 30_000 });

const STOOQ_TF = { "1d": "d", "1w": "w", "1mo": "m" };

function resolveInterval(tf) { return STOOQ_TF[tf] || "d"; }

function stooqTicker(symbol) {
  const meta = getSymbol(symbol);
  if (meta?.stooqSym) return meta.stooqSym;
  const s = String(symbol).toLowerCase();
  if (/\.[a-z]+$/.test(s)) return s;
  return s + ".us";
}

function ymd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Parse Stooq CSV → array of {t,o,h,l,c,v} sorted oldest-first. */
export function parseStooqCSV(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    if (cols.length < 6) continue;
    const date = cols[0];
    const o = +cols[1], h = +cols[2], l = +cols[3], c = +cols[4], v = +cols[5];
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    const t = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(t)) continue;
    out.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return out;
}

export const stooq = {
  id: "stooq",
  historyLimit: 5000,
  realtime: false,

  /**
   * Historical klines.  When tf is sub-day Stooq downsamples to daily.
   * @param {{symbol,tf,fromT?,toT?,limit?,signal?}} args
   */
  async history({ symbol, tf, fromT, toT, limit = 1000, signal }) {
    const interval = resolveInterval(tf);
    const ticker   = stooqTicker(symbol);
    const params   = new URLSearchParams({ s: ticker, i: interval });
    if (Number.isFinite(fromT)) params.set("d1", ymd(new Date(fromT)));
    if (Number.isFinite(toT))   params.set("d2", ymd(new Date(toT)));
    const url = `${REST}/?${params}`;

    const text = await withRetry(
      () => fetchGuarded(url, { breaker: cb, signal, headers: { "Accept": "text/csv,*/*;q=0.5" } }).then((r) => r.text()),
      { tries: 3, baseMs: 250 }
    );
    if (!text || text.length < 20) return [];
    if (/no data/i.test(text) || /error/i.test(text)) return [];
    const all = parseStooqCSV(text);
    if (!Number.isFinite(limit) || limit <= 0) return all;
    return all.slice(-Math.floor(limit));
  },

  /**
   * Polling "stream" — Stooq has no live ticks, so we refresh once an
   * hour and emit any newly-closed daily bar.
   */
  stream({ symbol, tf, onKline, onStatus }) {
    const intervalMs = 60 * 60 * 1000;
    let stopped = false;
    let lastT = 0;
    const tick = async () => {
      if (stopped) return;
      try {
        const rows = await stooq.history({ symbol, tf, limit: 5 });
        if (rows.length) {
          const fresh = rows[rows.length - 1];
          if (fresh.t > lastT) {
            lastT = fresh.t;
            try { onKline?.({ ...fresh, closed: true }); } catch {}
          }
        }
      } catch (err) {
        try { onStatus?.({ status: "error", err: err?.message || String(err), source: "stooq" }); } catch {}
      }
    };
    onStatus?.({ status: "static", source: "stooq", note: "EOD daily — refreshes hourly" });
    tick();
    const timer = setInterval(tick, intervalMs);
    return {
      close() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        try { onStatus?.({ status: "stopped", source: "stooq" }); } catch {}
      },
      get readyState() { return stopped ? 3 : 1; },   // mimic WebSocket
    };
  },
};

/**
 * My Next Prediction v3.0 — M3.5 · Yahoo Finance v8 adapter
 * ---------------------------------------------------------
 * Real-time-ish OHLCV for forex (`EURUSD=X`), commodities (`GC=F`),
 * indices (`^GSPC`) and as a fallback for stocks/ETFs.  Hits the
 * public `query2.finance.yahoo.com/v8/finance/chart` endpoint:
 *
 *   GET https://query2.finance.yahoo.com/v8/finance/chart/<symbol>
 *       ?interval=1m&range=5d
 *
 * No WebSocket exists, so `stream()` polls the chart endpoint at
 * the symbol's natural cadence (every 30 s for live-ish symbols,
 * 5 min for EOD-only).  When Yahoo blocks us (rare CORS hiccups),
 * the adapter emits a `status:"error"` and the UI can switch to
 * Stooq for that symbol.
 */

import { fetchGuarded, withRetry, CircuitBreaker } from "../../core/resilience.js";

const REST = "https://query2.finance.yahoo.com/v8/finance/chart";
const cb   = new CircuitBreaker({ name: "yahoo-rest", threshold: 4, cooldownMs: 30_000 });

/** MNP TF → Yahoo (interval, range).  Yahoo caps low-TF history. */
const TF_MAP = {
  "1m":  { interval: "1m",  range: "5d"  },
  "5m":  { interval: "5m",  range: "1mo" },
  "15m": { interval: "15m", range: "1mo" },
  "30m": { interval: "30m", range: "3mo" },
  "1h":  { interval: "60m", range: "6mo" },
  "4h":  { interval: "90m", range: "1y"  },   // Yahoo has no native 4h
  "1d":  { interval: "1d",  range: "5y"  },
  "1w":  { interval: "1wk", range: "10y" },
};

/** Forex / futures / indices quote nearly continuously → real-time poll. */
function isRealtime(symbol) {
  return /=X$|=F$|^\^/.test(String(symbol || ""));
}

function pollIntervalMs(symbol, tf) {
  if (!isRealtime(symbol)) return 5 * 60_000;
  if (tf === "1d" || tf === "1w") return 60_000;
  return 30_000;
}

/** Convert a Yahoo chart response → array of {t,o,h,l,c,v} sorted oldest-first. */
export function parseYahooChart(json) {
  const r = json?.chart?.result?.[0];
  if (!r || !Array.isArray(r.timestamp)) return [];
  const ts = r.timestamp;
  const q  = r.indicators?.quote?.[0] || {};
  const o = q.open || [], h = q.high || [], l = q.low || [], c = q.close || [], v = q.volume || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    // ts[] is in unix seconds; multiply by 1000 for ms.  Don't use `| 0`
    // here — it bitwise-truncates to 32-bit and overflows post-2038.
    const t = Math.floor(Number(ts[i]) * 1000);
    if (!Number.isFinite(t)) continue;
    // Yahoo emits null entries for non-trading minutes — skip those
    // explicitly (`+null === 0`, so `+o[i]` would silently coerce).
    if (o[i] == null || h[i] == null || l[i] == null || c[i] == null) continue;
    const oi = +o[i], hi = +h[i], li = +l[i], ci = +c[i];
    if (!Number.isFinite(oi) || !Number.isFinite(hi) || !Number.isFinite(li) || !Number.isFinite(ci)) continue;
    out.push({ t, o: oi, h: hi, l: li, c: ci, v: Number.isFinite(+v[i]) ? +v[i] : 0 });
  }
  return out;
}

export const yahoo = {
  id: "yahoo",
  historyLimit: 5000,
  realtime: true,

  async history({ symbol, tf, limit = 1000, signal }) {
    const map = TF_MAP[tf] || TF_MAP["1d"];
    const params = new URLSearchParams({
      interval: map.interval,
      range:    map.range,
      includePrePost: "false",
      events:   "div,splits",
    });
    const url = `${REST}/${encodeURIComponent(symbol)}?${params}`;
    let json;
    try {
      json = await withRetry(
        () => fetchGuarded(url, { breaker: cb, signal, headers: { "Accept": "application/json,*/*;q=0.5" } }).then((r) => r.json()),
        { tries: 3, baseMs: 250 }
      );
    } catch { return []; }
    const all = parseYahooChart(json);
    if (!Number.isFinite(limit) || limit <= 0) return all;
    return all.slice(-Math.floor(limit));
  },

  /**
   * Polling stream.  Calls history every `pollIntervalMs(symbol, tf)`.
   * Emits closed bars exactly once and the forming tail bar every poll.
   */
  stream({ symbol, tf, onKline, onStatus }) {
    const intervalMs = pollIntervalMs(symbol, tf);
    let stopped = false;
    let lastClosedT = 0;

    const tick = async () => {
      if (stopped) return;
      try {
        const rows = await yahoo.history({ symbol, tf, limit: 5 });
        if (rows.length) {
          for (let i = 0; i < rows.length - 1; i++) {
            const r = rows[i];
            if (r.t > lastClosedT) {
              lastClosedT = r.t;
              try { onKline?.({ ...r, closed: true }); } catch {}
            }
          }
          const tail = rows[rows.length - 1];
          if (tail) {
            try { onKline?.({ ...tail, closed: false }); } catch {}
          }
        }
        try { onStatus?.({ status: "tick", source: "yahoo" }); } catch {}
      } catch (err) {
        try { onStatus?.({ status: "error", err: err?.message || String(err), source: "yahoo" }); } catch {}
      }
    };

    onStatus?.({ status: "polling", source: "yahoo", intervalMs });
    tick();
    const timer = setInterval(tick, intervalMs);
    return {
      close() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        try { onStatus?.({ status: "stopped", source: "yahoo" }); } catch {}
      },
      get readyState() { return stopped ? 3 : 1; },   // mimic WebSocket
    };
  },
};

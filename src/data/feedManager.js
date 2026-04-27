/**
 * My Next Prediction v3.0 — FeedManager
 * -------------------------------------
 * Top-level orchestrator for a (symbol, tf) live feed. Combines:
 *   - exchange adapter (REST history + WS stream)
 *   - CandleValidator
 *   - CandleBuffer (dedup + reorder + gap detection)
 *   - GapFiller (REST backfill on reconnect / boot)
 *   - LeaderElection (single WS per tab-set)
 *   - ClockSkew sync
 *
 * Public surface (events on EventBus):
 *   feed:bootstrap   {symbol, tf, count}       — historical seed complete
 *   feed:status      {symbol, tf, ...}         — WS status updates
 *   feed:close       {symbol, tf, candle}      — a closed candle has been persisted
 *   feed:update      {symbol, tf, candle}      — forming candle tick (leader only)
 *   feed:gap         {symbol, tf, from, to}    — gap detected
 *   feed:error       {symbol, tf, err}         — terminal failure
 */

import { EventBus } from "../core/bus.js";
import { validateCandle } from "./candleValidator.js";
import { CandleBuffer } from "./candleBuffer.js";
import { ensureRecent, getStored } from "./gapFiller.js";
import { runFeedLeader } from "./leaderElection.js";
import { putMany } from "./idb.js";
import { chain as exchangeChain, nonCryptoChain, getExchange } from "./exchanges/index.js";
import { getSymbol } from "./universe.js";
import * as ClockSkew from "./clockSkew.js";

const DEFAULT_LOOKBACK = {
  "1m": 4 * 60 * 60 * 1000,   // 4h
  "5m": 24 * 60 * 60 * 1000,  // 1d
  "15m": 3 * 24 * 60 * 60 * 1000,
  "1h": 30 * 24 * 60 * 60 * 1000,
  "4h": 90 * 24 * 60 * 60 * 1000,
  "1d": 365 * 24 * 60 * 60 * 1000,
  "1w": 5 * 365 * 24 * 60 * 60 * 1000,
};

export class FeedManager {
  constructor({ symbol, tf, preferredExchange = "binance", lookbackMs } = {}) {
    if (!symbol || !tf) throw new Error("FeedManager: symbol + tf required");
    // Don't uppercase non-crypto symbols (Yahoo's "EURUSD=X" / "^GSPC" /
    // ".L" / ".T" suffixes are case-sensitive).
    const meta = getSymbol(symbol);
    this.symbolMeta = meta || null;
    this.assetType  = meta?.type || "crypto";
    this.symbol = (this.assetType === "crypto") ? symbol.toUpperCase() : symbol;
    // Synthesised universe-ids carry a `:PERP` / `:CM` suffix to keep
    // futures separate from spot in the registry.  `wireSymbol` is the
    // raw exchange ticker we pass to REST + WS subscribe.
    this.wireSymbol = meta?.wsSym || this.symbol;
    this.tf = tf;
    this.lookbackMs = lookbackMs ?? DEFAULT_LOOKBACK[tf] ?? 24 * 60 * 60 * 1000;

    // Type-aware exchange dispatch.  Crypto follows the existing chain
    // (binance → bybit failover); other types pin to the universe's
    // declared `exchange` (yahoo for forex/commodities/indices, stooq
    // for stocks/ETFs) with the non-crypto chain as fallback.
    this.fallbackChain = (this.assetType === "crypto") ? exchangeChain : nonCryptoChain;
    this.exchange = (meta?.exchange && getExchange(meta.exchange))
                  || getExchange(preferredExchange)
                  || this.fallbackChain[0];

    this.buffer = new CandleBuffer({
      symbol: this.symbol, tf: this.tf,
      onClose:  (c) => this._onBufferClose(c),
      onUpdate: (c) => this._onBufferUpdate(c),
      onGap:    (g) => this._onBufferGap(g),
    });

    this.stream = null;
    this.leader = null;
    this.role = "unknown";
    this.started = false;
    this.lastTick = null;       // forming candle snapshot
    this.lastClosed = null;     // most recent closed candle
  }

  async start() {
    if (this.started) return;
    this.started = true;
    ClockSkew.start();  // idempotent

    // Seed buffer.lastClosedT from IDB so we don't re-emit history
    const stored = await getStored({ symbol: this.symbol, tf: this.tf, limit: 1000 });
    if (stored.length) {
      this.buffer.seed(stored[stored.length - 1].t);
      this.lastClosed = stored[stored.length - 1];
    }

    // Backfill any gap up to now
    try {
      const saved = await ensureRecent({
        exchange: this.exchange, symbol: this.symbol, tf: this.tf,
        lookbackMs: this.lookbackMs, wireSymbol: this.wireSymbol,
      });
      EventBus.emit("feed:bootstrap", { symbol: this.symbol, tf: this.tf, count: saved });
      // Re-read tail so UI has fresh data
      const latest = await getStored({ symbol: this.symbol, tf: this.tf, limit: 1 });
      if (latest.length) {
        this.buffer.seed(Math.max(this.buffer.lastClosedT, latest[0].t));
        this.lastClosed = latest[0];
      }
    } catch (err) {
      EventBus.emit("feed:error", { symbol: this.symbol, tf: this.tf, err: String(err?.message || err), phase: "bootstrap" });
      // try the next adapter in chain
      await this._tryFailover(err);
    }

    // Lead-elect WS; followers just consume broadcasts.
    this.leader = runFeedLeader({
      symbol: this.symbol, tf: this.tf,
      runAsLeader: async ({ broadcast }) => this._runLeader(broadcast),
      onBroadcast: (m) => this._onBroadcast(m),
    });
    await this.leader.start();
  }

  async stop() {
    this.started = false;
    try { await this.leader?.stop(); } catch {}
    try { this.stream?.close(); } catch {}
    this.stream = null;
  }

  getSnapshot() {
    return {
      symbol: this.symbol,
      tf: this.tf,
      exchange: this.exchange?.id,
      role: this.leader?.getRole?.() || "unknown",
      lastClosed: this.lastClosed,
      forming: this.lastTick,
      bufferStats: this.buffer.stats(),
    };
  }

  /* ───────── Leader ───────── */

  async _runLeader(broadcast) {
    this.role = "leader";
    this._broadcast = broadcast;
    EventBus.emit("feed:status", { symbol: this.symbol, tf: this.tf, role: "leader", status: "starting" });

    const connect = () => {
      this.stream = this.exchange.stream({
        symbol: this.wireSymbol, tf: this.tf,
        onStatus: (s) => {
          EventBus.emit("feed:status", { symbol: this.symbol, tf: this.tf, exchange: this.exchange.id, ...s });
          // Reconnect → fire an ensureRecent to catch any gap
          if (s.status === "open") this._backfillSinceLast().catch(() => {});
        },
        onKline: (raw) => {
          const r = validateCandle(raw, { symbol: this.symbol, tf: this.tf });
          if (!r.ok) {
            EventBus.emit("feed:invalid", { symbol: this.symbol, tf: this.tf, reason: r.reason });
            return;
          }
          const candle = r.candle;
          this.buffer.ingest(candle);
          // Broadcast to follower tabs
          broadcast?.({ kind: candle.closed ? "close" : "update", candle });
        },
      });
    };
    connect();

    // Teardown returned to leader election
    return () => {
      try { this.stream?.close(); } catch {}
      this.stream = null;
    };
  }

  async _backfillSinceLast() {
    try {
      const saved = await ensureRecent({
        exchange: this.exchange, symbol: this.symbol, tf: this.tf,
        lookbackMs: this.lookbackMs, wireSymbol: this.wireSymbol,
      });
      if (saved > 0) EventBus.emit("feed:backfill", { symbol: this.symbol, tf: this.tf, saved });
    } catch (err) {
      await this._tryFailover(err);
    }
  }

  async _tryFailover(err) {
    // Rotate through the asset-class fallback chain if primary fails
    const ch  = this.fallbackChain || exchangeChain;
    const idx = ch.indexOf(this.exchange);
    const next = ch[idx + 1];
    if (!next) { EventBus.emit("feed:error", { symbol: this.symbol, tf: this.tf, err: String(err), phase: "no-more-adapters" }); return; }
    this.exchange = next;
    EventBus.emit("feed:failover", { symbol: this.symbol, tf: this.tf, newExchange: next.id });
    // Restart stream on next adapter
    try { this.stream?.close(); } catch {}
    if (this.role === "leader" && this.started) {
      this.stream = this.exchange.stream({
        symbol: this.wireSymbol, tf: this.tf,
        onStatus: (s) => EventBus.emit("feed:status", { symbol: this.symbol, tf: this.tf, exchange: this.exchange.id, ...s }),
        onKline:  (raw) => {
          const r = validateCandle(raw, { symbol: this.symbol, tf: this.tf });
          if (r.ok) { this.buffer.ingest(r.candle); this._broadcast?.({ kind: r.candle.closed ? "close" : "update", candle: r.candle }); }
        },
      });
    }
  }

  /* ───────── Follower ───────── */

  _onBroadcast(msg) {
    if (!msg || !msg.candle) return;
    if (msg.kind === "close")  { this.buffer.ingest(msg.candle); }
    if (msg.kind === "update") { this.buffer.ingest(msg.candle); }
  }

  /* ───────── Buffer callbacks ───────── */

  async _onBufferClose(c) {
    this.lastClosed = c;
    try { await putMany("candles", [c]); }
    catch (err) { EventBus.emit("feed:persist-fail", { err: String(err?.message || err) }); }
    EventBus.emit("feed:close", { symbol: this.symbol, tf: this.tf, candle: c });
  }

  _onBufferUpdate(c) {
    this.lastTick = c;
    EventBus.emit("feed:update", { symbol: this.symbol, tf: this.tf, candle: c });
  }

  _onBufferGap(g) {
    EventBus.emit("feed:gap", g);
    // fire-and-forget REST backfill for the gap range
    this.exchange.history({ symbol: this.wireSymbol, tf: this.tf, fromT: g.from, toT: g.to })
      .then(rows => {
        const valid = rows.map(r => validateCandle(r, { symbol: this.symbol, tf: this.tf }))
                          .filter(x => x.ok)
                          .map(x => ({ ...x.candle, closed: true }));
        if (valid.length) return putMany("candles", valid);
      })
      .catch(err => EventBus.emit("feed:gap-fill-fail", { ...g, err: String(err) }));
  }
}

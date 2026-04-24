/**
 * My Next Prediction v3.0 — CandleBuffer
 * --------------------------------------
 * In-order, deduplicated stream of candles for a single (symbol, tf).
 *
 * Responsibilities:
 *   1. De-dupe by timestamp (scenario #25)
 *   2. Re-order out-of-order arrivals (scenario #24)
 *   3. Separate "forming" (partial) vs "closed" candles (scenario #38, #140)
 *   4. Emit "update" for forming candle ticks and "close" once finalised
 *   5. Detect gaps versus expected TF interval (feed to GapFiller)
 *
 * Pure — no IDB, no network. Emitters are pluggable callbacks.
 */

import { tfMs } from "./candleValidator.js";

export class CandleBuffer {
  /**
   * @param {object} opts
   * @param {string} opts.symbol
   * @param {string} opts.tf
   * @param {(c)=>void} opts.onClose - called with a closed candle exactly once per t
   * @param {(c)=>void} [opts.onUpdate] - called repeatedly for the currently forming candle
   * @param {(gap)=>void} [opts.onGap] - called when we detect missing candle(s) {from,to}
   * @param {number}  [opts.maxBuffer=120] cap on pending out-of-order entries
   */
  constructor({ symbol, tf, onClose, onUpdate, onGap, maxBuffer = 120 }) {
    this.symbol = symbol;
    this.tf = tf;
    this.step = tfMs(tf) || 60_000;
    this.onClose = onClose;
    this.onUpdate = onUpdate || (() => {});
    this.onGap = onGap || (() => {});
    this.maxBuffer = maxBuffer;

    /** @type {Map<number, Candle>} pending out-of-order closed candles keyed by t */
    this._pending = new Map();
    /** last closed t we have successfully emitted downstream */
    this._lastClosedT = -Infinity;
    /** the currently forming candle (if any) */
    this._forming = null;
  }

  /** Seed lastClosedT from storage so we don't re-emit historical closes. */
  seed(lastClosedT) {
    if (typeof lastClosedT === "number" && lastClosedT > this._lastClosedT) {
      this._lastClosedT = lastClosedT;
    }
  }

  /** Main entry point. `candle` must already be validated. */
  ingest(candle) {
    if (!candle) return;
    const t = candle.t;

    // Forming candle (kline still open)
    if (!candle.closed) {
      // Only accept a forming candle whose t is the NEXT bucket after last closed.
      const expected = this._lastClosedT + this.step;
      if (this._lastClosedT === -Infinity || t === expected) {
        this._forming = candle;
        this.onUpdate(candle);
      }
      // else drop (stale or ahead-of-time forming — happens briefly during reconnect)
      return;
    }

    // Closed candle
    if (t <= this._lastClosedT) return; // already emitted or older — drop
    this._pending.set(t, candle);

    if (this._pending.size > this.maxBuffer) {
      // drop the oldest pending beyond cap (rare; indicates pathological feed)
      const oldest = Math.min(...this._pending.keys());
      this._pending.delete(oldest);
    }
    this._drain();
  }

  _drain() {
    // Emit any contiguous closed candles from lastClosedT + step
    while (true) {
      const nextT = this._lastClosedT === -Infinity
        ? Math.min(...this._pending.keys())
        : this._lastClosedT + this.step;

      if (!Number.isFinite(nextT)) break;
      const c = this._pending.get(nextT);
      if (!c) {
        // No contiguous candle. A one-slot hole is almost always an
        // out-of-order arrival (the missing candle will show up within a
        // few ingests), so wait for it. Only treat holes of ≥ 2 steps as
        // true gaps that need backfilling.
        if (this._lastClosedT !== -Infinity && this._pending.size) {
          const first = Math.min(...this._pending.keys());
          if (first > this._lastClosedT + 2 * this.step) {
            this.onGap({
              symbol: this.symbol, tf: this.tf,
              from: this._lastClosedT + this.step,
              to:   first - this.step,
            });
            // Skip forward: trust the gap filler to backfill later.
            this._lastClosedT = first - this.step;
            continue;
          }
        }
        break;
      }
      this._pending.delete(nextT);
      this._lastClosedT = nextT;
      this.onClose(c);
    }
  }

  stats() {
    return {
      symbol: this.symbol,
      tf: this.tf,
      lastClosedT: this._lastClosedT,
      pending: this._pending.size,
      forming: !!this._forming,
    };
  }

  get forming() { return this._forming; }
  get lastClosedT() { return this._lastClosedT; }
}

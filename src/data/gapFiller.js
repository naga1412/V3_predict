/**
 * My Next Prediction v3.0 — GapFiller
 * -----------------------------------
 * Detects and fills missing candles via REST when the WebSocket reconnects or
 * when the CandleBuffer emits a "gap" event.
 *
 * Scenarios covered: #23 reconnect, #26 missing candles, #36 cold bootstrap,
 *                     #142 backtest missing history.
 */

import { rangeByKey, latestInRange, putMany } from "./idb.js";
import { validateBatch, tfMs } from "./candleValidator.js";
import { EventBus } from "../core/bus.js";
import { serverNow } from "./clockSkew.js";

/**
 * Fill the IDB `candles` store from [fromT, toT] (inclusive) using exchange.history().
 * Returns the number of candles actually persisted.
 *
 * `wireSymbol` is the raw exchange ticker passed to `exchange.history()`.
 * It defaults to `symbol`, but for synthesised universe-ids (e.g.
 * `BTCUSDT:PERP` for Binance USDT-M futures) the FeedManager passes
 * the unsuffixed wire ticker so the REST endpoint accepts it.
 */
export async function fillRange({ exchange, symbol, tf, fromT, toT, onBatch, wireSymbol }) {
  const step = tfMs(tf); if (!step) throw new Error(`unknown tf ${tf}`);
  let cur = Math.floor(fromT / step) * step;
  const end = Math.floor(toT   / step) * step;
  if (cur > end) return 0;

  let totalSaved = 0;
  const LIMIT = exchange.historyLimit || 1000;
  const wsSym = wireSymbol || symbol;

  while (cur <= end) {
    const batchEnd = Math.min(end, cur + step * (LIMIT - 1));
    const raw = await exchange.history({ symbol: wsSym, tf, fromT: cur, toT: batchEnd, limit: LIMIT });
    if (!raw || !raw.length) break;

    const { valid, reasons } = validateBatch(raw, { symbol, tf });
    if (valid.length) {
      // mark as closed (history is always closed candles)
      for (const c of valid) c.closed = true;
      await putMany("candles", valid);
      totalSaved += valid.length;
      onBatch?.(valid);
    }
    if (Object.keys(reasons).length) {
      EventBus.emit("gapfill:reject", { symbol, tf, reasons });
    }

    // advance cursor: next step after the last returned t
    const lastT = raw[raw.length - 1].t ?? (raw[raw.length - 1][0]); // adapter-agnostic fallback
    const nextT = Number.isFinite(lastT) ? lastT + step : batchEnd + step;
    if (nextT <= cur) break; // safeguard against infinite loop
    cur = nextT;
  }

  EventBus.emit("gapfill:done", { symbol, tf, fromT, toT, saved: totalSaved });
  return totalSaved;
}

/**
 * Ensure we have the last `lookbackMs` of candles locally for (symbol, tf).
 * Called on app start and on WS reconnect.  `wireSymbol` is forwarded
 * to fillRange / exchange.history (defaults to `symbol` — see fillRange).
 */
export async function ensureRecent({ exchange, symbol, tf, lookbackMs, wireSymbol }) {
  const step = tfMs(tf); if (!step) return 0;
  const now = serverNow();
  const toT = Math.floor(now / step) * step - step; // last fully closed bucket
  const fromT = toT - lookbackMs;

  // Find the last candle we already have for this (symbol, tf)
  const latest = await latestInRange("candles",
    IDBKeyRange.bound([symbol, tf, -Infinity], [symbol, tf, Infinity]));
  const haveUpTo = latest?.t ?? -Infinity;
  const start = Math.max(haveUpTo + step, fromT);
  if (start > toT) return 0;

  return fillRange({ exchange, symbol, tf, fromT: start, toT, wireSymbol });
}

/**
 * Return stored candles for a range (UI chart seed).
 */
export async function getStored({ symbol, tf, fromT = -Infinity, toT = Infinity, limit = Infinity }) {
  return rangeByKey("candles",
    IDBKeyRange.bound([symbol, tf, fromT], [symbol, tf, toT]),
    { limit });
}

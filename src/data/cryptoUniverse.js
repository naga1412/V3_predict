/**
 * My Next Prediction v3.0 — M3.5 · Dynamic Crypto Universe Loader
 * ---------------------------------------------------------------
 * Fetches the full live list of tradeable instruments from Binance
 * (spot + USDT-M futures + coin-M futures) and registers them into
 * the universe registry so the symbol picker has every coin Binance
 * lists in real-time.
 *
 *   - Binance spot      ~2,500 pairs    /api/v3/exchangeInfo
 *   - Binance futures   ~  500 USDT-M   /fapi/v1/exchangeInfo
 *   - Binance coin-M    ~  150 inverse  /dapi/v1/exchangeInfo
 *
 * Total ~3,000 symbols.  Endpoints are CORS-friendly with no API key.
 * Merged list is cached in IDB (`cryptoUniverseV1` meta key) so
 * subsequent cold-loads display every coin instantly.
 *
 * Each crypto entry registered:
 *   {
 *     id,             // raw Binance ticker (e.g. "BTCUSDT", "BTCUSD_PERP")
 *     name,           // base/quote pair (e.g. "BTC / USDT")
 *     type:    "crypto",
 *     exchange:"binance",
 *     currency,       // quote asset (USDT, USD, BTC, BUSD, …)
 *     category,       // "spot" | "futures-linear" | "futures-inverse"
 *     perp:    bool,
 *     base, quote,
 *   }
 */

import { metaGet, metaSet } from "./idb.js";
import { registerSymbols } from "./universe.js";
import { fetchGuarded, withRetry, CircuitBreaker } from "../core/resilience.js";

const META_KEY = "cryptoUniverseV1";
const TTL_MS   = 24 * 60 * 60 * 1000;

const cb = new CircuitBreaker({ name: "binance-universe", threshold: 3, cooldownMs: 60_000 });

/* ═══════════════════════════ Binance ═══════════════════════════ */

async function fetchBinanceSpot(signal) {
  const url = "https://api.binance.com/api/v3/exchangeInfo";
  const res = await withRetry(
    () => fetchGuarded(url, { breaker: cb, signal }).then((r) => r.json()),
    { tries: 3, baseMs: 250 }
  );
  if (!res?.symbols) return [];
  const out = [];
  for (const s of res.symbols) {
    if (s.status !== "TRADING") continue;
    if (!s.isSpotTradingAllowed) continue;
    const base  = String(s.baseAsset  || "");
    const quote = String(s.quoteAsset || "");
    if (!base || !quote) continue;
    out.push({
      id: s.symbol,
      name: `${base} / ${quote}`,
      type: "crypto",
      exchange: "binance",
      currency: quote,
      category: "spot",
      perp: false,
      base, quote,
    });
  }
  return out;
}

async function fetchBinanceFuturesLinear(signal) {
  const url = "https://fapi.binance.com/fapi/v1/exchangeInfo";
  let res;
  try {
    res = await withRetry(
      () => fetchGuarded(url, { breaker: cb, signal }).then((r) => r.json()),
      { tries: 2, baseMs: 250 }
    );
  } catch { return []; }
  if (!res?.symbols) return [];
  const out = [];
  for (const s of res.symbols) {
    if (s.status !== "TRADING") continue;
    if (s.contractType && s.contractType !== "PERPETUAL") continue;
    const base  = String(s.baseAsset  || "");
    const quote = String(s.quoteAsset || s.marginAsset || "USDT");
    if (!base) continue;
    // Suffix with `:PERP` so registry id doesn't collide with the spot
    // entry that has the SAME ticker.  `wsSym` keeps the raw exchange
    // ticker (used by binance.js for klines + WS subscribe).
    out.push({
      id: `${s.symbol}:PERP`,
      wsSym: s.symbol,
      name: `${base} / ${quote} (perp)`,
      type: "crypto",
      exchange: "binance",
      currency: quote,
      category: "futures-linear",
      perp: true,
      base, quote,
    });
  }
  return out;
}

async function fetchBinanceFuturesInverse(signal) {
  const url = "https://dapi.binance.com/dapi/v1/exchangeInfo";
  let res;
  try {
    res = await withRetry(
      () => fetchGuarded(url, { breaker: cb, signal }).then((r) => r.json()),
      { tries: 2, baseMs: 250 }
    );
  } catch { return []; }
  if (!res?.symbols) return [];
  const out = [];
  for (const s of res.symbols) {
    if (s.contractStatus !== "TRADING") continue;
    if (s.contractType !== "PERPETUAL") continue;
    const base  = String(s.baseAsset  || "");
    const quote = String(s.quoteAsset || "USD");
    if (!base) continue;
    out.push({
      id: `${s.symbol}:CM`,
      wsSym: s.symbol,
      name: `${base} / ${quote} (coin-M)`,
      type: "crypto",
      exchange: "binance",
      currency: quote,
      category: "futures-inverse",
      perp: true,
      base, quote,
    });
  }
  return out;
}

/* ═══════════════════════════ Public API ═══════════════════════════ */

/**
 * Pull all crypto symbols from Binance, register into the universe,
 * persist to IDB.  Failure semantics: any single endpoint can fail —
 * whatever arrives is still merged.  If all fail and the IDB cache is
 * empty, no crypto symbols are registered (caller should hint to user).
 *
 * @returns {Promise<{count:number, fromCache:boolean, sources:object}>}
 */
export async function fetchCryptoUniverse({ signal, force = false } = {}) {
  // 1. Try IDB cache first.
  if (!force) {
    try {
      const cached = await metaGet(META_KEY);
      if (cached && (Date.now() - (cached.t || 0)) < TTL_MS && Array.isArray(cached.list) && cached.list.length) {
        registerSymbols(cached.list);
        return { count: cached.list.length, fromCache: true, sources: cached.sources || {} };
      }
    } catch { /* IDB unavailable — fall through to network */ }
  }

  // 2. Fetch all three endpoints in parallel.
  const [spot, linear, inverse] = await Promise.all([
    fetchBinanceSpot(signal).catch(() => []),
    fetchBinanceFuturesLinear(signal).catch(() => []),
    fetchBinanceFuturesInverse(signal).catch(() => []),
  ]);

  // 3. Merge & dedupe (futures often share id with spot — keep both
  //    by qualifying them with category, since the WebSocket endpoint
  //    differs per category).
  const merged = [];
  const seen = new Set();
  for (const s of [...spot, ...linear, ...inverse]) {
    const key = `${s.exchange}:${s.category}:${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(s);
  }

  // 4. Register + persist.
  if (merged.length) {
    registerSymbols(merged);
    try {
      await metaSet(META_KEY, {
        t: Date.now(),
        list: merged,
        sources: {
          binance_spot:    spot.length,
          binance_linear:  linear.length,
          binance_inverse: inverse.length,
        },
      });
    } catch { /* ignore IDB errors */ }
  }

  return {
    count: merged.length,
    fromCache: false,
    sources: {
      binance_spot:    spot.length,
      binance_linear:  linear.length,
      binance_inverse: inverse.length,
    },
  };
}

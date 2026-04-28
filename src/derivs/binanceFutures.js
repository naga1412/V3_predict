/**
 * My Next Prediction v3.0 — M4c · Binance USDT-M futures derivs
 * -------------------------------------------------------------
 * CORS-friendly, key-free endpoints:
 *   /fapi/v1/openInterest        — OI snapshot
 *   /fapi/v1/premiumIndex        — funding (last) + mark / index price
 *   /futures/data/openInterestHist             — OI history (5m/15m/30m/1h/4h/1d)
 *   /futures/data/topLongShortAccountRatio     — top-trader L/S (accounts)
 *   /futures/data/topLongShortPositionRatio    — top-trader L/S (positions)
 *   /futures/data/globalLongShortAccountRatio  — global L/S accounts
 *   /fapi/v1/fundingRate                       — funding history
 *
 * Pure module: returns parsed numbers; no IDB, no events.
 */

import { fetchGuarded, withRetry, CircuitBreaker } from "../core/resilience.js";

const FAPI = "https://fapi.binance.com";
const cb   = new CircuitBreaker({ name: "binance-deriv", threshold: 4, cooldownMs: 30_000 });

const PERIOD_OK = new Set(["5m","15m","30m","1h","2h","4h","6h","12h","1d"]);

async function getJSON(url, signal) {
  return withRetry(
    () => fetchGuarded(url, { breaker: cb, signal }).then((r) => r.json()),
    { tries: 2, baseMs: 250 }
  );
}

/** Strip suffix from `BTCUSDT:PERP` → `BTCUSDT` (futures wire ticker). */
function wireSym(symbol) {
  return String(symbol || "").replace(/:.*$/, "").toUpperCase();
}

/** Latest open interest (single number, contracts). */
export async function openInterest(symbol, { signal } = {}) {
  const s = wireSym(symbol);
  if (!s) return null;
  const j = await getJSON(`${FAPI}/fapi/v1/openInterest?symbol=${s}`, signal).catch(() => null);
  if (!j || !Number.isFinite(+j.openInterest)) return null;
  return { symbol: s, openInterest: +j.openInterest, time: +j.time || Date.now() };
}

/** Premium index → funding (last 8h-realized + next-pred), mark, index. */
export async function premiumIndex(symbol, { signal } = {}) {
  const s = wireSym(symbol);
  if (!s) return null;
  const j = await getJSON(`${FAPI}/fapi/v1/premiumIndex?symbol=${s}`, signal).catch(() => null);
  if (!j) return null;
  return {
    symbol: s,
    markPrice:        +j.markPrice,
    indexPrice:       +j.indexPrice,
    lastFundingRate:  Number.isFinite(+j.lastFundingRate) ? +j.lastFundingRate : null,
    nextFundingTime:  +j.nextFundingTime || null,
    interestRate:     Number.isFinite(+j.interestRate) ? +j.interestRate : null,
    time:             +j.time || Date.now(),
  };
}

/** OI history series.  period default "1h", limit default 30. */
export async function openInterestHist(symbol, { period = "1h", limit = 30, signal } = {}) {
  const s = wireSym(symbol);
  const p = PERIOD_OK.has(period) ? period : "1h";
  const j = await getJSON(`${FAPI}/futures/data/openInterestHist?symbol=${s}&period=${p}&limit=${Math.min(500, limit | 0)}`, signal).catch(() => null);
  if (!Array.isArray(j)) return [];
  return j.map((row) => ({
    t:               +row.timestamp || 0,
    openInterest:    +row.sumOpenInterest,
    openInterestUSD: +row.sumOpenInterestValue,
  })).filter((r) => Number.isFinite(r.t) && Number.isFinite(r.openInterest));
}

/** Funding rate history. */
export async function fundingRateHist(symbol, { limit = 30, signal } = {}) {
  const s = wireSym(symbol);
  const j = await getJSON(`${FAPI}/fapi/v1/fundingRate?symbol=${s}&limit=${Math.min(1000, limit | 0)}`, signal).catch(() => null);
  if (!Array.isArray(j)) return [];
  return j.map((row) => ({
    t:           +row.fundingTime || 0,
    fundingRate: Number.isFinite(+row.fundingRate) ? +row.fundingRate : null,
  })).filter((r) => Number.isFinite(r.t));
}

/**
 * Long/short ratio.  `kind`:
 *   "topAccount"  → top-trader account ratio
 *   "topPosition" → top-trader position ratio
 *   "global"      → global account ratio
 */
export async function longShortRatio(symbol, { kind = "topAccount", period = "1h", limit = 30, signal } = {}) {
  const s = wireSym(symbol);
  const p = PERIOD_OK.has(period) ? period : "1h";
  const route = kind === "topPosition" ? "topLongShortPositionRatio"
             : kind === "global"      ? "globalLongShortAccountRatio"
             : "topLongShortAccountRatio";
  const j = await getJSON(`${FAPI}/futures/data/${route}?symbol=${s}&period=${p}&limit=${Math.min(500, limit | 0)}`, signal).catch(() => null);
  if (!Array.isArray(j)) return [];
  return j.map((row) => ({
    t:           +row.timestamp || 0,
    longAccount: Number.isFinite(+row.longAccount) ? +row.longAccount : null,
    shortAccount: Number.isFinite(+row.shortAccount) ? +row.shortAccount : null,
    longShortRatio: Number.isFinite(+row.longShortRatio) ? +row.longShortRatio : null,
  })).filter((r) => Number.isFinite(r.t));
}

/** Compact "deriv snapshot" used by the UI. */
export async function snapshot(symbol, { signal } = {}) {
  const [oi, pi, oiHist, lsTop, fundHist] = await Promise.all([
    openInterest(symbol, { signal }).catch(() => null),
    premiumIndex(symbol, { signal }).catch(() => null),
    openInterestHist(symbol, { period: "1h", limit: 24, signal }).catch(() => []),
    longShortRatio(symbol, { kind: "topAccount", period: "1h", limit: 24, signal }).catch(() => []),
    fundingRateHist(symbol, { limit: 8, signal }).catch(() => []),
  ]);
  return {
    symbol: wireSym(symbol),
    fetchedAt: Date.now(),
    oi, premiumIndex: pi,
    oiHist, lsHist: lsTop, fundingHist: fundHist,
  };
}

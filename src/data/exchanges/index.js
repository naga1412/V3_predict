/**
 * My Next Prediction v3.0 — Exchange registry
 * -------------------------------------------
 * Chooses the primary exchange; allows failover if circuit opens (scenario #29).
 */

import { binance } from "./binance.js";
import { bybit }   from "./bybit.js";
import { stooq }   from "./stooq.js";
import { yahoo }   from "./yahoo.js";
import { EventBus } from "../../core/bus.js";

export const exchanges = { binance, bybit, stooq, yahoo };

/**
 * Ordered fallback chain for CRYPTO symbols.  Feed manager tries
 * adapters in sequence when a history fetch fails, and swaps WS
 * provider if the primary circuit opens.  Non-crypto symbols pin
 * to a single source via `getExchange()` keyed by the universe entry.
 */
export const chain = [binance, bybit];

/** Fallback chain for non-crypto types — Yahoo first, Stooq second. */
export const nonCryptoChain = [yahoo, stooq];

export function getExchange(id) {
  return exchanges[id] || null;
}

/* Notify UI when a circuit flips so we can show a badge. */
EventBus.on("circuit:open",  ({ name }) => EventBus.emit("exchange:status", { name, state: "open" }));
EventBus.on("circuit:close", ({ name }) => EventBus.emit("exchange:status", { name, state: "closed" }));

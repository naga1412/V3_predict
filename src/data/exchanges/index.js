/**
 * My Next Prediction v3.0 — Exchange registry
 * -------------------------------------------
 * Chooses the primary exchange; allows failover if circuit opens (scenario #29).
 */

import { binance } from "./binance.js";
import { bybit }   from "./bybit.js";
import { EventBus } from "../../core/bus.js";

export const exchanges = { binance, bybit };

/**
 * Ordered fallback chain. Feed manager tries adapters in sequence when a
 * history fetch fails, and swaps WS provider if the primary circuit opens.
 */
export const chain = [binance, bybit];

export function getExchange(id) {
  return exchanges[id] || null;
}

/* Notify UI when a circuit flips so we can show a badge. */
EventBus.on("circuit:open",  ({ name }) => EventBus.emit("exchange:status", { name, state: "open" }));
EventBus.on("circuit:close", ({ name }) => EventBus.emit("exchange:status", { name, state: "closed" }));

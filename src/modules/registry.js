/**
 * My Next Prediction v3.0 — Module Registry
 * -----------------------------------------
 * Imports all analysis modules and exposes a map + an iterable array.
 * Weights are taken from each module's `meta.weight` but can be overridden
 * per-call by the orchestrator.
 *
 * The Phase 7 baseline ships 12 modules; Phase 7b (Q2) adds CISD as the
 * 13th — a structural Compression/Inducement/Sweep/Displacement detector.
 */

import * as trendFollow from "./trendFollow.js";
import * as meanReversion from "./meanReversion.js";
import * as momentum from "./momentum.js";
import * as breakout from "./breakout.js";
import * as supportResistance from "./supportResistance.js";
import * as volatilityRegime from "./volatilityRegime.js";
import * as volumeProfile from "./volumeProfile.js";
import * as candlePatterns from "./candlePatterns.js";
import * as orderBlocks from "./orderBlocks.js";
import * as liquidity from "./liquidity.js";
import * as premiumDiscount from "./premiumDiscount.js";
import * as sessionCalendar from "./sessionCalendar.js";
import * as cisd from "./cisd.js";

export const MODULES = Object.freeze([
  trendFollow,
  meanReversion,
  momentum,
  breakout,
  supportResistance,
  volatilityRegime,
  volumeProfile,
  candlePatterns,
  orderBlocks,
  liquidity,
  premiumDiscount,
  sessionCalendar,
  cisd,
]);

export const MODULES_BY_ID = Object.freeze(
  Object.fromEntries(MODULES.map(m => [m.meta.id, m]))
);

export function listModules() {
  return MODULES.map(m => ({ ...m.meta }));
}

export function getModule(id) {
  return MODULES_BY_ID[id] || null;
}

/**
 * Session / Event-calendar module.
 *   - During high-impact event windows → dampen confidence across the board.
 *   - At "kill zone" boundaries (NY open, London open) → slight boost to
 *     breakout/continuation signals.
 *   - Off-hours (low liquidity) → lower confidence.
 *
 * This module doesn't produce a directional signal on its own; it returns
 * a small bias + a `multiplier` in payload that the orchestrator can use
 * to adjust other modules (if it chooses). For determinism we also translate
 * into a direct (signal, confidence) pair.
 */
import { neutral, clampSignal } from "./baseModule.js";

export const meta = Object.freeze({
  id: "session-calendar",
  name: "Session / Calendar",
  category: "context",
  description: "Session bias + event-window damping",
  weight: 0.5,
});

/**
 * @param {object} ta
 * @param {object} [ctx]
 * @param {object} [ctx.calendar]  EventCalendar instance
 * @param {number} [ctx.now]       reference timestamp (default: last candle.t)
 */
export function evaluate(ta, ctx = {}) {
  const tags = ta.sessions?.tags || [];
  const lastIdx = tags.length - 1;
  const t = Number.isFinite(ctx.now) ? ctx.now : (ta.t?.[lastIdx] ?? null);
  const session = lastIdx >= 0 ? tags[lastIdx] : "unknown";
  const reasons = [`session=${session}`];
  let multiplier = 1.0;
  let signal = 0;
  let confidence = 0.1;

  // Session bias: active sessions favor trend continuation; off-hours favor
  // mean-reversion / lower confidence globally.
  if (session === "off-hours") {
    multiplier = 0.6;
    confidence = 0.1;
    reasons.push("off-hours (lower confidence)");
  } else if (session === "london" || session === "ny-am") {
    multiplier = 1.1;
    confidence = 0.25;
    reasons.push("active session (slight boost)");
  } else if (session === "ny-pm" || session === "asia") {
    multiplier = 1.0;
    confidence = 0.2;
  }

  // Event proximity
  if (ctx.calendar && Number.isFinite(t) && typeof ctx.calendar.isInEventWindow === "function") {
    const w = ctx.calendar.isInEventWindow(t, { impact: "high" });
    if (w.active) {
      multiplier *= 0.4;
      confidence = Math.max(0, confidence - 0.15);
      reasons.push(`in ${w.phase} window of "${w.event.name}"`);
    }
  }

  return clampSignal({
    signal, confidence,
    reasons,
    payload: { multiplier, session },
  });
}

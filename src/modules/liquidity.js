/**
 * Liquidity module.
 *   - A recent BEARISH sweep (stop-hunt above EQH) → long bias (trap reversal).
 *   - A recent BULLISH sweep (stop-hunt below EQL) → short bias.
 *   - Proximity to untouched EQH/EQL can add a mild bias toward those targets.
 */
import { neutral, clampSignal, lastFinite } from "./baseModule.js";

export const meta = Object.freeze({
  id: "liquidity",
  name: "Liquidity",
  category: "smc",
  description: "Post-sweep reversals and liquidity-target bias",
  weight: 0.9,
});

export function evaluate(ta, ctx = {}) {
  const lookback = ctx.lookback ?? 5;
  const c = lastFinite(ta.close);
  const liq = ta.liquidity || {};
  const lastIdx = (ta.close?.length ?? 1) - 1;
  const sweeps = Array.isArray(liq.sweeps) ? liq.sweeps : [];
  const eqh = Array.isArray(liq.eqHighs) ? liq.eqHighs : [];
  const eql = Array.isArray(liq.eqLows)  ? liq.eqLows  : [];
  if (!Number.isFinite(c)) return neutral("no close");

  // 1. Most recent sweep
  let recentSweep = null;
  for (let k = sweeps.length - 1; k >= 0; k--) {
    const s = sweeps[k];
    if (!Number.isInteger(s?.i)) continue;
    if (lastIdx - s.i <= lookback) { recentSweep = s; break; }
    break;
  }
  if (recentSweep) {
    // bearish sweep (swept EQH) → price flipped → go long (trap)
    // bullish sweep (swept EQL) → price flipped → go short
    const dir = recentSweep.kind === "bearish" ? 1 : recentSweep.kind === "bullish" ? -1 : 0;
    if (dir !== 0) {
      const age = lastIdx - recentSweep.i;
      const fresh = age === 0 ? 1 : age <= 2 ? 0.8 : 0.5;
      const confidence = 0.35 + 0.45 * fresh;
      return clampSignal({
        signal: dir * (0.4 + 0.4 * fresh),
        confidence,
        reasons: [
          `${recentSweep.kind} sweep ${age} bar${age === 1 ? "" : "s"} ago`,
          `direction ${dir > 0 ? "long (trap reversal)" : "short (trap reversal)"}`,
        ],
        payload: { sweep: recentSweep },
      });
    }
  }

  // 2. Proximity to untouched liquidity pools — mild bias toward them
  const tol = (lastFinite(ta.atr14) ?? c * 0.005) * 2;
  let nearestEQH = null, nearestEQL = null;
  for (const e of eqh) {
    if (!Number.isFinite(e.price)) continue;
    if (c < e.price && (!nearestEQH || e.price < nearestEQH.price)) nearestEQH = e;
  }
  for (const e of eql) {
    if (!Number.isFinite(e.price)) continue;
    if (c > e.price && (!nearestEQL || e.price > nearestEQL.price)) nearestEQL = e;
  }
  const distUp = nearestEQH ? nearestEQH.price - c : Infinity;
  const distDn = nearestEQL ? c - nearestEQL.price : Infinity;
  if (!Number.isFinite(distUp) && !Number.isFinite(distDn)) {
    return clampSignal({ signal: 0, confidence: 0.05, reasons: ["no liquidity pools"] });
  }
  if (distUp < distDn && distUp < tol * 4) {
    const touches = nearestEQH?.touches ?? 2;
    const strength = Math.min(1, touches / 4);
    return clampSignal({
      signal: 0.15 + 0.2 * strength,
      confidence: 0.2 + 0.2 * strength,
      reasons: [`EQH target ${nearestEQH.price.toFixed(2)} above`, `touches=${touches}`],
    });
  }
  if (distDn < distUp && distDn < tol * 4) {
    const touches = nearestEQL?.touches ?? 2;
    const strength = Math.min(1, touches / 4);
    return clampSignal({
      signal: -(0.15 + 0.2 * strength),
      confidence: 0.2 + 0.2 * strength,
      reasons: [`EQL target ${nearestEQL.price.toFixed(2)} below`, `touches=${touches}`],
    });
  }
  return clampSignal({ signal: 0, confidence: 0.05, reasons: ["liquidity pools distant"] });
}

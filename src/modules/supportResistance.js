/**
 * Support/Resistance proximity module.
 *   - Long  bias when price is at/below a strong support (bounce).
 *   - Short bias when price is at/above a strong resistance (rejection).
 *   - Neutral when price is mid-range or between weak levels.
 */
import { neutral, clampSignal, lastFinite } from "./baseModule.js";

export const meta = Object.freeze({
  id: "support-resistance",
  name: "Support / Resistance",
  category: "levels",
  description: "Proximity to clustered S/R levels weighted by strength",
  weight: 0.9,
});

export function evaluate(ta) {
  const c = lastFinite(ta.close);
  const levels = Array.isArray(ta.levels) ? ta.levels : [];
  const atr = lastFinite(ta.atr14);
  if (!Number.isFinite(c) || levels.length === 0) return neutral("no levels");
  const tol = Number.isFinite(atr) ? atr * 0.5 : c * 0.005;

  // Nearest level above and below
  let supp = null, res = null;
  for (const L of levels) {
    if (!Number.isFinite(L.price)) continue;
    if (L.price <= c && (!supp || L.price > supp.price)) supp = L;
    if (L.price >= c && (!res  || L.price < res.price))  res  = L;
  }
  if (!supp && !res) return neutral("no nearby levels");

  const distSupp = supp ? c - supp.price : Infinity;
  const distRes  = res  ? res.price - c  : Infinity;

  // Touching a level? (within 1 tolerance)
  const atSupp = distSupp <= tol;
  const atRes  = distRes  <= tol;

  if (atSupp && !atRes) {
    const strength = Math.min(1, (supp.strength ?? supp.touches ?? 1) / 5);
    return clampSignal({
      signal: 0.4 + 0.4 * strength,
      confidence: 0.4 + 0.3 * strength,
      reasons: [
        `At support ${supp.price.toFixed(2)}`,
        `strength=${(supp.strength ?? supp.touches ?? 1).toFixed(1)}`,
      ],
      payload: { support: supp, distance: distSupp },
    });
  }
  if (atRes && !atSupp) {
    const strength = Math.min(1, (res.strength ?? res.touches ?? 1) / 5);
    return clampSignal({
      signal: -(0.4 + 0.4 * strength),
      confidence: 0.4 + 0.3 * strength,
      reasons: [
        `At resistance ${res.price.toFixed(2)}`,
        `strength=${(res.strength ?? res.touches ?? 1).toFixed(1)}`,
      ],
      payload: { resistance: res, distance: distRes },
    });
  }

  // Both or neither: compute positional bias
  const total = distSupp + distRes;
  if (!Number.isFinite(total) || total === 0) return neutral("collapsed range");
  const pos = distSupp / total;   // 0 = at support, 1 = at resistance
  // Mild fade from extremes
  const bias = (0.5 - pos) * 0.5; // +0.25 near support → long; -0.25 near res
  return clampSignal({
    signal: bias,
    confidence: Math.abs(bias) * 2,
    reasons: [
      `Between ${supp?.price?.toFixed?.(2) ?? "—"} and ${res?.price?.toFixed?.(2) ?? "—"}`,
      `position ${(pos * 100).toFixed(0)}% of range`,
    ],
  });
}

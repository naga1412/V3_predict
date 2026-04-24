/**
 * Trading session / "kill zone" tagging.
 *
 * ICT identifies three primary liquidity-rich windows (all UTC):
 *   - Asia       22:00 – 02:00  (low-volatility accumulation)
 *   - London     07:00 – 10:00  (London Open KZ)
 *   - New York   12:00 – 15:00  (NY AM session KZ)
 *   - NY PM      13:30 – 16:00  (NY PM KZ)
 *
 * Given a candle's timestamp we return which session it falls in. Useful
 * for indexing trades, computing per-session volatility, or tagging OBs
 * formed inside a kill zone (higher-significance).
 *
 * Times are UTC hours. If you want local-time sessions, pass {tzOffset} in ms.
 */

const SESSIONS = [
  { name: "asia",     startH: 22, endH:  2 }, // wraps midnight
  { name: "london",   startH:  7, endH: 10 },
  { name: "ny-am",    startH: 12, endH: 15 },
  { name: "ny-pm",    startH: 13, endH: 16 },
];

export function sessionOf(t, { tzOffsetMs = 0 } = {}) {
  if (!Number.isFinite(t)) return "unknown";
  const d = new Date(t + tzOffsetMs);
  const h = d.getUTCHours();
  for (const s of SESSIONS) {
    if (s.startH <= s.endH) {
      if (h >= s.startH && h < s.endH) return s.name;
    } else {
      // Wraps midnight (e.g. Asia 22→02)
      if (h >= s.startH || h < s.endH) return s.name;
    }
  }
  return "off-hours";
}

/**
 * Tag every candle with its session. Returns an array of same length:
 *   ["asia", "asia", ..., "london", ..., "off-hours", ...]
 */
export function tagSessions(candles, opts = {}) {
  if (!Array.isArray(candles)) return [];
  return candles.map(c => sessionOf(+c.t, opts));
}

/**
 * Compute per-session statistics (avg range, mean volume) over the array.
 *   { asia: {count, avgRange, avgVol}, london: {...}, ... }
 */
export function sessionStats(candles, opts = {}) {
  const out = {};
  for (const c of candles) {
    const s = sessionOf(+c.t, opts);
    if (!out[s]) out[s] = { count: 0, sumRange: 0, sumVol: 0 };
    out[s].count++;
    out[s].sumRange += (+c.h - +c.l);
    out[s].sumVol   += +c.v;
  }
  const result = {};
  for (const [k, v] of Object.entries(out)) {
    result[k] = {
      count: v.count,
      avgRange: v.count ? v.sumRange / v.count : 0,
      avgVol:   v.count ? v.sumVol   / v.count : 0,
    };
  }
  return result;
}

export { SESSIONS };

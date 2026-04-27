/**
 * My Next Prediction v3.0 — M4b · Macro Risk-ON / Risk-OFF aggregator
 * -------------------------------------------------------------------
 * Cross-market sentiment derived from a basket of risk proxies:
 *
 *   - VIX (^VIX)        : equity volatility, falling = risk-on
 *   - DXY (DX-Y.NYB)    : dollar index, falling = risk-on
 *   - SPX (^GSPC)       : equity benchmark, rising = risk-on
 *   - 10Y yield (^TNX)  : rising = risk-off (in 2024+ regime)
 *   - GOLD (GC=F)       : rising = risk-off
 *
 * Each proxy is normalised to a -1..+1 risk-on score (positive
 * means the proxy is currently arguing for risk-on).  The aggregate
 * is a weighted sum, clamped to [-1, +1], with three labels:
 *   risk-on  ≥ +0.25
 *   risk-off ≤ -0.25
 *   mixed    otherwise
 *
 * Inputs: caller passes a `samples` map keyed by proxy id, each value
 * an array of recent closes (oldest-first).  Falls back gracefully
 * when proxies are missing — the aggregator uses whatever is present
 * with renormalised weights.
 *
 *   import { computeMacroState } from "./macro.js";
 *   const state = computeMacroState({
 *     "^VIX":  [16.1, 15.4, 14.8, 14.2],
 *     "^GSPC": [4500, 4520, 4540, 4560],
 *     "DX-Y.NYB": [104.5, 104.3, 104.1],
 *     "^TNX":  [4.30, 4.25, 4.20],
 *     "GC=F":  [2050, 2055, 2060, 2058],
 *   });
 *   //  → { score:+0.42, label:"risk-on", contributions:[...], reasons:[...] }
 */

const PROXIES = Object.freeze([
  // id          weight  // sign convention: +1 if rising = risk-on
  { id: "^VIX",     weight: 0.25, sign: -1, label: "VIX"  },
  { id: "^GSPC",    weight: 0.25, sign: +1, label: "SPX"  },
  { id: "DX-Y.NYB", weight: 0.20, sign: -1, label: "DXY"  },
  { id: "^TNX",     weight: 0.15, sign: -1, label: "10Y"  },
  { id: "GC=F",     weight: 0.15, sign: -1, label: "GOLD" },
]);

/**
 * Trend score from a series of closes.
 *   - Returns -1..+1
 *   - Uses % change of latest close vs. window-mean, then tanh-squashes
 *     so a 5 % move saturates to ~+0.65 and 10 % saturates to ~+0.95.
 */
export function trendScore(closes, windowBars = 20) {
  if (!Array.isArray(closes) || closes.length < 3) return 0;
  const tail = closes.slice(-Math.max(2, windowBars));
  let sum = 0, n = 0;
  for (const c of tail) {
    const v = +c;
    if (Number.isFinite(v) && v > 0) { sum += v; n++; }
  }
  if (n < 2) return 0;
  const avg = sum / n;
  const last = +tail[tail.length - 1];
  if (!Number.isFinite(last) || avg <= 0) return 0;
  const pct = (last - avg) / avg;
  return Math.tanh(pct * 8);   // 5% → 0.66, 10% → 0.95
}

/**
 * Aggregate a macro Risk-ON / Risk-OFF state from a `samples` map.
 *
 * @param {Record<string, number[]>} samples  per-proxy close arrays
 * @param {object} [opts]
 * @param {number} [opts.window=20]
 * @returns {{
 *   score:  number,                // -1..+1
 *   label:  "risk-on"|"risk-off"|"mixed"|"unknown",
 *   contributions: {id, label, score, weight}[],
 *   reasons: string[],
 *   coverage: number,              // fraction of proxies present
 * }}
 */
export function computeMacroState(samples, opts = {}) {
  const window = Number.isFinite(opts.window) ? opts.window : 20;
  const contributions = [];
  let total = 0, totalWeight = 0;
  const reasons = [];

  for (const px of PROXIES) {
    const series = samples?.[px.id];
    if (!Array.isArray(series) || series.length < 3) continue;
    const t = trendScore(series, window);
    const contrib = px.sign * t;          // already in -1..+1
    contributions.push({
      id: px.id, label: px.label,
      score: +contrib.toFixed(3),
      weight: px.weight,
    });
    total += contrib * px.weight;
    totalWeight += px.weight;
    if (Math.abs(contrib) >= 0.4) {
      reasons.push(`${px.label} ${contrib > 0 ? "→ risk-on" : "→ risk-off"} (${(contrib * 100).toFixed(0)})`);
    }
  }

  if (totalWeight === 0) {
    return {
      score: 0, label: "unknown",
      contributions, reasons: ["no macro proxies available"],
      coverage: 0,
    };
  }

  const score = Math.max(-1, Math.min(1, total / totalWeight));
  const label = score >= 0.15 ? "risk-on"
              : score <= -0.15 ? "risk-off"
              : "mixed";
  if (!reasons.length) reasons.push(`mixed signals (score=${score.toFixed(2)})`);

  return {
    score: +score.toFixed(3),
    label,
    contributions,
    reasons,
    coverage: +(totalWeight / 1.00).toFixed(2),   // sum of native weights
  };
}

/**
 * Convenience: a one-line UI string.
 */
export function summarizeMacro(state) {
  if (!state) return "—";
  const arrow = state.label === "risk-on" ? "▲" : state.label === "risk-off" ? "▼" : "—";
  return `${arrow} ${state.label.toUpperCase()} ${state.score >= 0 ? "+" : ""}${state.score.toFixed(2)}`;
}

export const _internals = { PROXIES };

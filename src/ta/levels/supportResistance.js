/**
 * Support / Resistance level clustering from swing pivots.
 *
 * We take pivots (from structure/swings.js) and bucket them by price with a
 * tolerance = ATR × k (volatility-aware).  Hotter buckets (more pivots) are
 * stronger levels.  Recency decays an exponential factor so older zones
 * fade unless repeatedly retested.
 *
 * Output levels are sorted by `strength` desc:
 *   { price, strength, touches, kind:"support"|"resistance"|"both", lastTouchedAt }
 */

export function clusterLevels(pivots, { tolerance, halfLifeBars = 500 } = {}) {
  if (!pivots?.length || !Number.isFinite(tolerance) || tolerance <= 0) return [];
  const sorted = pivots.slice().sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && p.price - last.last <= tolerance) {
      last.pivots.push(p);
      last.last = p.price;
    } else {
      clusters.push({ first: p.price, last: p.price, pivots: [p] });
    }
  }
  // Score each cluster
  const mostRecentI = pivots.reduce((a, p) => Math.max(a, p.i), 0);
  const out = clusters.map(cl => {
    const prices  = cl.pivots.map(p => p.price);
    const weight  = cl.pivots.reduce((a, p) => a + recency(p.i, mostRecentI, halfLifeBars), 0);
    const highs   = cl.pivots.filter(p => p.kind === "high").length;
    const lows    = cl.pivots.filter(p => p.kind === "low").length;
    const kind    = highs && lows ? "both" : highs ? "resistance" : "support";
    const price   = median(prices);
    const lastTouchedT = Math.max(...cl.pivots.map(p => p.t));
    return { price, strength: weight, touches: cl.pivots.length, kind, lastTouchedAt: lastTouchedT };
  });
  return out.sort((a, b) => b.strength - a.strength);
}

function recency(idx, newest, halfLife) {
  const age = newest - idx;
  return Math.pow(0.5, age / halfLife);
}

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

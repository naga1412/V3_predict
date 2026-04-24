/**
 * Liquidity zones — equal highs (EQH), equal lows (EQL), and sweeps.
 *
 * EQH/EQL:
 *   Two or more swing pivots at roughly the same price (within `tolerance`
 *   of each other; tolerance is normally ATR-scaled by the caller).
 *   These attract stop-losses; breaking them = "liquidity sweep".
 *
 * Sweep events:
 *   A candle's wick violates an EQH/EQL but the body closes back inside
 *   (a.k.a. "stop hunt" / "liquidity grab"). Bullish sweep: wick below EQL,
 *   close above EQL. Bearish sweep: wick above EQH, close below EQH.
 *
 * Output:
 *   { eqHighs:[{price, indices, touches, sweptAt?}],
 *     eqLows:[{price, indices, touches, sweptAt?}],
 *     sweeps:[{kind:"bullish"|"bearish", i, t, level, severity}] }
 */

export function detectLiquidity(candles, pivots = [], { tolerance = 0, minTouches = 2 } = {}) {
  if (!Array.isArray(candles) || !Number.isFinite(tolerance) || tolerance <= 0) {
    return { eqHighs: [], eqLows: [], sweeps: [] };
  }
  const highs = pivots.filter(p => p.kind === "high").slice().sort((a, b) => a.i - b.i);
  const lows  = pivots.filter(p => p.kind === "low").slice().sort((a, b) => a.i - b.i);

  const eqHighs = cluster(highs, tolerance, minTouches);
  const eqLows  = cluster(lows,  tolerance, minTouches);

  // Sweep detection — scan each bar after a level was established
  const sweeps = [];
  for (const L of eqHighs) {
    const first = Math.max(...L.indices);
    for (let j = first + 1; j < candles.length; j++) {
      const b = candles[j];
      if (+b.h > L.price && +b.c < L.price) {
        sweeps.push({
          kind: "bearish",
          i: j,
          t: +b.t,
          level: L.price,
          severity: (+b.h - L.price) / tolerance, // how far past in ATRs
        });
        L.sweptAt = +b.t;
        break;
      }
    }
  }
  for (const L of eqLows) {
    const first = Math.max(...L.indices);
    for (let j = first + 1; j < candles.length; j++) {
      const b = candles[j];
      if (+b.l < L.price && +b.c > L.price) {
        sweeps.push({
          kind: "bullish",
          i: j,
          t: +b.t,
          level: L.price,
          severity: (L.price - +b.l) / tolerance,
        });
        L.sweptAt = +b.t;
        break;
      }
    }
  }

  return { eqHighs, eqLows, sweeps };
}

function cluster(sortedPivots, tolerance, minTouches) {
  // Group pivots by price with ±tolerance window; ignore clusters smaller than minTouches.
  const byPrice = sortedPivots.slice().sort((a, b) => a.price - b.price);
  const groups = [];
  for (const p of byPrice) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(p.price - last.avg) <= tolerance) {
      last.pts.push(p);
      last.avg = last.pts.reduce((a, x) => a + x.price, 0) / last.pts.length;
    } else {
      groups.push({ pts: [p], avg: p.price });
    }
  }
  return groups
    .filter(g => g.pts.length >= minTouches)
    .map(g => ({
      price: g.avg,
      indices: g.pts.map(p => p.i),
      times:   g.pts.map(p => p.t),
      touches: g.pts.length,
      sweptAt: null,
    }))
    .sort((a, b) => a.price - b.price);
}

/**
 * Premium / Discount zones.
 *
 * ICT splits the current *structural range* [rangeLow, rangeHigh] into zones:
 *   - Discount  : 0–50 %        (cheap — bullish bias if buying)
 *   - Equilibrium: 45–55 %      (neutral — avoid)
 *   - Premium   : 50–100 %      (expensive — bearish bias if selling)
 *
 * The structural range defaults to "most-recent confirmed HH and LL" from
 * the classified pivots. Caller can override with an explicit range.
 *
 * Output:
 *   {
 *     rangeHigh, rangeLow, mid, width,
 *     zones: { discount, equilibriumLow, equilibriumHigh, premium },
 *     lastPct,   // where current close sits, 0..1 from low→high (NaN if outside)
 *     lastZone:  "discount"|"equilibrium"|"premium"|"outside"
 *   }
 */

export function premiumDiscount(candles, pivots = [], opts = {}) {
  if (!candles?.length) return null;
  const lastClose = +candles[candles.length - 1].c;

  let rangeHigh, rangeLow;
  if (Number.isFinite(opts.rangeHigh) && Number.isFinite(opts.rangeLow)) {
    rangeHigh = opts.rangeHigh;
    rangeLow  = opts.rangeLow;
  } else {
    // Walk backward through classified pivots to find the most recent swing range.
    const sorted = pivots.slice().sort((a, b) => b.i - a.i);
    let lastHigh = null, lastLow = null;
    for (const p of sorted) {
      if (!lastHigh && p.kind === "high") lastHigh = p;
      if (!lastLow  && p.kind === "low")  lastLow  = p;
      if (lastHigh && lastLow) break;
    }
    if (!lastHigh || !lastLow) {
      // Fallback: full-array high/low
      rangeHigh = Math.max(...candles.map(c => +c.h));
      rangeLow  = Math.min(...candles.map(c => +c.l));
    } else {
      rangeHigh = lastHigh.price;
      rangeLow  = lastLow.price;
    }
  }
  if (rangeHigh <= rangeLow) return null;

  const width = rangeHigh - rangeLow;
  const mid   = (rangeHigh + rangeLow) / 2;

  const zones = {
    discount:         { from: rangeLow,               to: rangeLow + width * 0.45 },
    equilibriumLow:   { from: rangeLow + width * 0.45, to: mid },
    equilibriumHigh:  { from: mid,                    to: rangeLow + width * 0.55 },
    premium:          { from: rangeLow + width * 0.55, to: rangeHigh },
  };

  const pct = (lastClose - rangeLow) / width;
  let lastZone;
  if      (pct < 0 || pct > 1) lastZone = "outside";
  else if (pct < 0.45)         lastZone = "discount";
  else if (pct <= 0.55)        lastZone = "equilibrium";
  else                         lastZone = "premium";

  return {
    rangeHigh, rangeLow, mid, width,
    zones,
    lastPct: pct,
    lastZone,
  };
}

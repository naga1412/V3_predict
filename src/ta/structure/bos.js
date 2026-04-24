/**
 * Break of Structure (BoS) and Change of Character (CHoCH).
 *
 * Given classified pivots (from `swings.classifyPivots`):
 *   - In an uptrend (HH+HL), a close below the last confirmed HL is a BoS↓
 *     and flips the prevailing trend → this is the CHoCH (first flip).
 *     Subsequent continuation breaks in the new trend direction are BoS.
 *   - Mirror in downtrend.
 *
 * We emit events aligned to candle indices, so consumers can overlay them
 * on the chart or feed them into features.
 */

export function detectBreaks(candles, pivots) {
  const events = [];
  let trend = "unknown";     // "up" | "down" | "unknown"
  let lastSwingHigh = null;
  let lastSwingLow  = null;

  // Walk candles & pivots in a single forward pass.
  let pIdx = 0;
  for (let i = 0; i < candles.length; i++) {
    // Absorb any pivots confirmed at or before i.
    while (pIdx < pivots.length && pivots[pIdx].i <= i) {
      const p = pivots[pIdx++];
      if (p.kind === "high") lastSwingHigh = p;
      else                   lastSwingLow  = p;
    }
    const c = candles[i];
    // Breakout tests (close-based — cleaner than wick-based).
    if (lastSwingHigh && c.c > lastSwingHigh.price) {
      const kind = trend === "down" ? "CHoCH" : "BoS";
      events.push({ i, t: c.t, type: kind, dir: "up", level: lastSwingHigh.price });
      trend = "up";
      lastSwingHigh = null; // invalidate — need a new pivot before next break
    } else if (lastSwingLow && c.c < lastSwingLow.price) {
      const kind = trend === "up" ? "CHoCH" : "BoS";
      events.push({ i, t: c.t, type: kind, dir: "down", level: lastSwingLow.price });
      trend = "down";
      lastSwingLow = null;
    }
  }
  return events;
}

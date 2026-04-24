/**
 * Swing / pivot detection via the "fractal" method (Bill Williams style):
 *   A high at index i is a swing-high if  high[i] >  max(high[i-L..i-1]) AND
 *                                         high[i] >= max(high[i+1..i+R])
 *   (symmetric for lows)
 *
 *   Returns [{i, t, price, kind:"high"|"low"}, ...] sorted by index.
 *
 * L/R default 2 — common "5-bar pivot". Increase for more significant swings.
 */

export function findPivots(candles, { left = 2, right = 2 } = {}) {
  const n = candles.length;
  const out = [];
  for (let i = left; i < n - right; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let k = 1; k <= left; k++) {
      if (candles[i - k].h >= c.h) { isHigh = false; }
      if (candles[i - k].l <= c.l) { isLow  = false; }
      if (!isHigh && !isLow) break;
    }
    for (let k = 1; k <= right; k++) {
      if (candles[i + k].h >  c.h) { isHigh = false; }
      if (candles[i + k].l <  c.l) { isLow  = false; }
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ i, t: c.t, price: c.h, kind: "high" });
    if (isLow)  out.push({ i, t: c.t, price: c.l, kind: "low" });
  }
  return out;
}

/**
 * Classify each pivot relative to its previous same-kind pivot:
 *   HH = higher high, LH = lower high
 *   HL = higher low,  LL = lower low
 * Adds `class` property in place and returns the array.
 */
export function classifyPivots(pivots) {
  let lastHigh = null, lastLow = null;
  for (const p of pivots) {
    if (p.kind === "high") {
      p.class = !lastHigh ? "H" : (p.price > lastHigh.price ? "HH" : "LH");
      lastHigh = p;
    } else {
      p.class = !lastLow ? "L" : (p.price > lastLow.price ? "HL" : "LL");
      lastLow = p;
    }
  }
  return pivots;
}

/**
 * Derive the instantaneous "trend" from the last few classified pivots:
 *   uptrend   = HH + HL
 *   downtrend = LH + LL
 *   range     = mixed / ambiguous
 */
export function currentTrend(pivots) {
  const last2 = pivots.slice(-4);
  const h = last2.findLast?.(p => p.kind === "high") ?? findLast(last2, p => p.kind === "high");
  const l = last2.findLast?.(p => p.kind === "low")  ?? findLast(last2, p => p.kind === "low");
  if (!h || !l) return "unknown";
  if (h.class === "HH" && l.class === "HL") return "up";
  if (h.class === "LH" && l.class === "LL") return "down";
  return "range";
}

function findLast(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
  return undefined;
}

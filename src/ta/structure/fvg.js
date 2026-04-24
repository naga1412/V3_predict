/**
 * Fair Value Gap (FVG) detector — classic 3-candle ICT pattern.
 *
 * Bullish FVG: candle[i-2].high < candle[i].low   (gap between prior high & current low)
 * Bearish FVG: candle[i-2].low  > candle[i].high
 *
 * We also track "mitigation" — an FVG is mitigated once price trades back
 * through its zone. Returns { open:[], mitigated:[] }.
 */

export function detectFVG(candles, { fromIdx = 2 } = {}) {
  const open = [];
  const mitigated = [];
  for (let i = Math.max(2, fromIdx); i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    if (a.h < c.l) {
      open.push({ i, t: c.t, kind: "bull", top: c.l, bottom: a.h, createdAtIdx: i });
    } else if (a.l > c.h) {
      open.push({ i, t: c.t, kind: "bear", top: a.l, bottom: c.h, createdAtIdx: i });
    }
    // Check existing opens for mitigation by the current candle.
    for (let j = open.length - 1; j >= 0; j--) {
      const g = open[j];
      if (g.createdAtIdx >= i) continue;
      const c2 = candles[i];
      const touched = (c2.l <= g.top && c2.h >= g.bottom);
      if (touched) {
        mitigated.push({ ...g, mitigatedAt: i, mitigatedT: c2.t });
        open.splice(j, 1);
      }
    }
  }
  return { open, mitigated };
}

/**
 * Parabolic SAR (Stop And Reverse).
 *   Wilder's classic formulation.
 *
 *   accStart  — acceleration factor at trend start  (default 0.02)
 *   accStep   — incremented each time a new extreme is made (default 0.02)
 *   accMax    — cap on acceleration factor           (default 0.2)
 *
 * Returns { psar: Float64Array, trend: Int8Array } where trend is +1 (long) or -1 (short).
 */
export function psar(high, low, { accStart = 0.02, accStep = 0.02, accMax = 0.2 } = {}) {
  const n = high.length;
  const out = new Float64Array(n).fill(NaN);
  const tr  = new Int8Array(n).fill(0);
  if (n < 2) return { psar: out, trend: tr };

  // Initial direction: assume uptrend if bar 1 closes above bar 0.
  let isUp = high[1] >= high[0];
  let ep   = isUp ? high[0] : low[0];
  let sar  = isUp ? low[0]  : high[0];
  let af   = accStart;
  out[0] = sar;
  tr[0]  = isUp ? 1 : -1;

  for (let i = 1; i < n; i++) {
    // Tentative SAR
    sar = sar + af * (ep - sar);

    // Constrain SAR to prior 2 periods' extreme (Wilder's rule)
    if (isUp) {
      const cap = Math.min(low[i - 1], i >= 2 ? low[i - 2] : low[i - 1]);
      if (sar > cap) sar = cap;
    } else {
      const cap = Math.max(high[i - 1], i >= 2 ? high[i - 2] : high[i - 1]);
      if (sar < cap) sar = cap;
    }

    // Reversal check
    let flip = false;
    if (isUp && low[i] < sar) { flip = true; isUp = false; sar = ep; ep = low[i]; af = accStart; }
    else if (!isUp && high[i] > sar) { flip = true; isUp = true;  sar = ep; ep = high[i]; af = accStart; }

    if (!flip) {
      if (isUp && high[i] > ep)  { ep = high[i]; af = Math.min(af + accStep, accMax); }
      if (!isUp && low[i]  < ep) { ep = low[i];  af = Math.min(af + accStep, accMax); }
    }

    out[i] = sar;
    tr[i]  = isUp ? 1 : -1;
  }
  return { psar: out, trend: tr };
}

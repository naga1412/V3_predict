/**
 * Order Block (OB) detector — ICT/SMC concept.
 *
 * Definition (bullish OB):
 *   The *last down-candle* before a strong impulsive up-move that breaks
 *   the prior swing high. Its range [low, high] is then treated as an
 *   institutional demand zone.
 *
 * Bearish OB is the mirror: last up-candle before a strong impulsive
 * down-move that breaks the prior swing low.
 *
 * We parameterise "impulsive" as:
 *   - subsequent move ≥ `impulseATRMult` × ATR(14) in `impulseLookahead` bars,
 *   - AND the move crosses a prior pivot (so it actually breaks structure).
 *
 * Output OBs:
 *   { kind:"bull"|"bear", i, t, top, bot, mitigated:boolean, mitigatedAt?:t }
 *
 * Mitigation: price trades back into the OB range. `mitigated` is true if
 * ANY later candle's low ≤ top AND high ≥ bot (i.e. touches the zone).
 */

import { atr } from "../indicators/volatility.js";

const DEFAULT = {
  impulseATRMult:  1.5,  // move must be ≥ 1.5 × ATR(14)
  impulseLookahead: 3,   // within next N bars
  mitigateLookahead: Infinity, // scan all future bars (capped by array length)
  atrPeriod: 14,
};

export function detectOrderBlocks(candles, pivots = [], opts = {}) {
  const { impulseATRMult, impulseLookahead, atrPeriod } = { ...DEFAULT, ...opts };
  if (!Array.isArray(candles) || candles.length < atrPeriod + impulseLookahead + 2) return [];

  const h = candles.map(c => +c.h);
  const l = candles.map(c => +c.l);
  const c = candles.map(c => +c.c);
  const o = candles.map(c => +c.o);
  const atrArr = atr(h, l, c, atrPeriod);

  const highPivots = pivots.filter(p => p.kind === "high").sort((a, b) => a.i - b.i);
  const lowPivots  = pivots.filter(p => p.kind === "low").sort((a, b) => a.i - b.i);

  const blocks = [];

  for (let i = 1; i < candles.length - impulseLookahead; i++) {
    const a = atrArr[i];
    if (!Number.isFinite(a) || a <= 0) continue;

    const isDown = c[i] < o[i];
    const isUp   = c[i] > o[i];

    // ─── Bullish OB ─────────────────────────────────────────────────
    // Current candle is down, and within next N bars price rises by ≥ threshold
    // AND breaks a prior swing high.
    if (isDown) {
      let hitHigh = -Infinity;
      for (let j = i + 1; j <= i + impulseLookahead && j < candles.length; j++) {
        if (h[j] > hitHigh) hitHigh = h[j];
      }
      const move = hitHigh - l[i];
      if (move >= impulseATRMult * a) {
        // find nearest prior high pivot strictly before i
        const prior = priorPivot(highPivots, i);
        if (prior && hitHigh > prior.price) {
          blocks.push(makeBlock("bull", candles, i, l[i], h[i]));
        }
      }
    }

    // ─── Bearish OB ─────────────────────────────────────────────────
    if (isUp) {
      let hitLow = Infinity;
      for (let j = i + 1; j <= i + impulseLookahead && j < candles.length; j++) {
        if (l[j] < hitLow) hitLow = l[j];
      }
      const move = h[i] - hitLow;
      if (move >= impulseATRMult * a) {
        const prior = priorPivot(lowPivots, i);
        if (prior && hitLow < prior.price) {
          blocks.push(makeBlock("bear", candles, i, l[i], h[i]));
        }
      }
    }
  }

  // Mitigation pass
  for (const b of blocks) {
    for (let j = b.i + 1; j < candles.length; j++) {
      if (candles[j].l <= b.top && candles[j].h >= b.bot) {
        b.mitigated = true;
        b.mitigatedAt = candles[j].t;
        break;
      }
    }
  }
  return blocks;
}

function priorPivot(list, i) {
  // largest .i < i
  let prev = null;
  for (const p of list) {
    if (p.i < i) prev = p;
    else break;
  }
  return prev;
}

function makeBlock(kind, candles, i, bot, top) {
  return {
    kind,
    i,
    t: candles[i].t,
    top,
    bot,
    mid: (top + bot) / 2,
    mitigated: false,
    mitigatedAt: null,
  };
}

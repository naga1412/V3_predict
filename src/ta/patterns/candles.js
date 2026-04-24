/**
 * Candle pattern detectors.
 *
 * All fns take (candles[], i?) — if i given, returns true/false for that bar;
 * otherwise returns an array of indices where the pattern hits.
 *
 * Tolerances are parameterised — `opts.bodyRatio`, `opts.shadowRatio` etc —
 * because crypto's wild ranges require looser thresholds than equities.
 */

const DEFAULT = {
  dojiBodyMax: 0.05,          // body < 5% of range → doji
  hammerShadowMin: 2.0,       // lower shadow ≥ 2× body
  hammerUpperMax: 1.0,        // upper shadow ≤ 1× body
  engulfingMin: 1.0,          // body engulfs previous body entirely
  hararamiOutBodyMin: 1.0,
  starBodyMax: 0.3,           // middle star bar small
};

function body(c)     { return Math.abs(c.c - c.o); }
function range(c)    { return c.h - c.l; }
function upperShadow(c) { return c.h - Math.max(c.o, c.c); }
function lowerShadow(c) { return Math.min(c.o, c.c) - c.l; }
function isBull(c)   { return c.c > c.o; }
function isBear(c)   { return c.c < c.o; }

export function isDoji(c, opts = {}) {
  const { dojiBodyMax } = { ...DEFAULT, ...opts };
  const r = range(c);
  return r > 0 && body(c) / r <= dojiBodyMax;
}

export function isHammer(c, opts = {}) {
  const { hammerShadowMin, hammerUpperMax } = { ...DEFAULT, ...opts };
  const b = body(c);
  if (b === 0) return false;
  return lowerShadow(c) >= hammerShadowMin * b && upperShadow(c) <= hammerUpperMax * b;
}

export function isInvertedHammer(c, opts = {}) {
  const { hammerShadowMin, hammerUpperMax } = { ...DEFAULT, ...opts };
  const b = body(c);
  if (b === 0) return false;
  return upperShadow(c) >= hammerShadowMin * b && lowerShadow(c) <= hammerUpperMax * b;
}

/** Shooting star = inverted hammer appearing in uptrend (we only detect shape). */
export const isShootingStar = isInvertedHammer;

/** Bullish engulfing: prev bear, curr bull, curr body engulfs prev body. */
export function isBullishEngulfing(prev, cur) {
  if (!prev || !cur) return false;
  return isBear(prev) && isBull(cur)
      && cur.c >= prev.o
      && cur.o <= prev.c;
}

export function isBearishEngulfing(prev, cur) {
  if (!prev || !cur) return false;
  return isBull(prev) && isBear(cur)
      && cur.o >= prev.c
      && cur.c <= prev.o;
}

export function isBullishHarami(prev, cur) {
  if (!prev || !cur) return false;
  return isBear(prev) && isBull(cur)
      && Math.max(cur.o, cur.c) <= Math.max(prev.o, prev.c)
      && Math.min(cur.o, cur.c) >= Math.min(prev.o, prev.c);
}

export function isBearishHarami(prev, cur) {
  if (!prev || !cur) return false;
  return isBull(prev) && isBear(cur)
      && Math.max(cur.o, cur.c) <= Math.max(prev.o, prev.c)
      && Math.min(cur.o, cur.c) >= Math.min(prev.o, prev.c);
}

/** Morning star: bear / small body / bull above midpoint of first. */
export function isMorningStar(c1, c2, c3, opts = {}) {
  const { starBodyMax } = { ...DEFAULT, ...opts };
  if (!c1 || !c2 || !c3) return false;
  if (!isBear(c1) || !isBull(c3)) return false;
  const r2 = range(c2);
  if (r2 === 0 || body(c2) / r2 > starBodyMax) return false;
  const mid1 = (c1.o + c1.c) / 2;
  return c3.c > mid1;
}

/** Evening star: bull / small body / bear below midpoint of first. */
export function isEveningStar(c1, c2, c3, opts = {}) {
  const { starBodyMax } = { ...DEFAULT, ...opts };
  if (!c1 || !c2 || !c3) return false;
  if (!isBull(c1) || !isBear(c3)) return false;
  const r2 = range(c2);
  if (r2 === 0 || body(c2) / r2 > starBodyMax) return false;
  const mid1 = (c1.o + c1.c) / 2;
  return c3.c < mid1;
}

/** Scan a candle array and return all patterns keyed by index. */
export function detectAll(candles, opts = {}) {
  const hits = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const pp = candles[i - 2];
    const list = [];
    if (isDoji(c, opts))           list.push("doji");
    if (isHammer(c, opts))         list.push("hammer");
    if (isInvertedHammer(c, opts)) list.push("invHammer");
    if (p) {
      if (isBullishEngulfing(p, c)) list.push("bullEngulf");
      if (isBearishEngulfing(p, c)) list.push("bearEngulf");
      if (isBullishHarami(p, c))    list.push("bullHarami");
      if (isBearishHarami(p, c))    list.push("bearHarami");
    }
    if (pp && p) {
      if (isMorningStar(pp, p, c, opts)) list.push("morningStar");
      if (isEveningStar(pp, p, c, opts)) list.push("eveningStar");
    }
    if (list.length) hits.push({ i, t: c.t, patterns: list });
  }
  return hits;
}

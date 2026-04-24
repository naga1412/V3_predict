/**
 * My Next Prediction v3.0 — CISD Module
 * -------------------------------------
 * Compression → Inducement → Sweep → Displacement.
 *
 * A 4-step structural setup tuned for crypto liquidity hunting. Each step is
 * detected independently; the full signal fires only when all four occur in
 * order within a bounded lookback window.
 *
 * Step 1 — Compression (The Coil)
 *   ATR(14) stays below SMA_100(ATR14) for ≥ 3 consecutive candles, AND
 *   Bollinger Band Width = (bb.up − bb.lo) / bb.mid touches a 50-period low.
 *
 * Step 2 — Inducement (The Trap)
 *   A minor break of structure (mBOS) pushes out of the compression range.
 *   "Minor" is defined by swing magnitude < 1.5 × ATR14. The direction of the
 *   inducement is the direction we expect to be trapped (i.e. the wrong way).
 *
 * Step 3 — Sweep (The Liquidity Grab)
 *   A candle's wick takes out the inducement level but the body closes back
 *   inside. Validated by:
 *     · wick-to-body ratio ≥ 1.5
 *     · sweep must arrive within `sweepWindow` bars of the inducement bar
 *     · "time-to-recovery" — the sweep bar itself must close back inside
 *       (our detection is already same-bar; time-to-recovery = 0 candles)
 *
 * Step 4 — Displacement (The Confirmation)
 *   A CHoCH (change of character) in the direction OPPOSITE to the sweep wick,
 *   validated by:
 *     · a Fair Value Gap created on or within `displaceWindow` bars after
 *       the sweep, in the same direction as the CHoCH.
 *     · volume on the displacement bar ≥ `volSpikeMult` × SMA_{volPeriod}(volume)
 *
 * Signal semantics
 *   · A bearish sweep (swept EQH / inducement-up) followed by a bearish CHoCH →
 *     long fired by "longs got trapped above, institutions reversed" → SHORT.
 *     (In SMC vernacular: sweep of buy-side liquidity → short.)
 *   · A bullish sweep (swept EQL / inducement-down) followed by a bullish CHoCH →
 *     LONG.
 *
 * Design choice — stateless
 *   Like every other Phase-7 module, `evaluate(ta, ctx)` is a pure function of
 *   the current TA snapshot. We walk the last `lookback` bars backward to
 *   find the latest qualifying sequence. This keeps the contract identical
 *   to siblings (no FSM, no side effects) and makes unit tests trivially
 *   deterministic.
 */
import { neutral, clampSignal, lastFinite } from "./baseModule.js";
import { sma } from "../ta/indicators/moving.js";

export const meta = Object.freeze({
  id: "cisd",
  name: "CISD",
  category: "smc",
  description: "Compression → Inducement → Sweep → Displacement sequence detector",
  weight: 1.1,
});

/* ───────────────────────── Defaults (crypto-tuned) ───────────────────────── */

export const DEFAULTS = Object.freeze({
  lookback:        80,   // how far back to search for a full CISD sequence
  atrPeriod:       14,
  atrSmaPeriod:    100,  // 100-period SMA of ATR14
  atrRunLen:       3,    // ATR14 below its SMA for ≥ this many consecutive bars
  bbwPeriod:       50,   // rolling window for BBW low
  bbwToleranceBin: 0,    // how many higher BBWs allowed and still call it a "new low" (0 = strict)
  mBosMaxATRMult:  1.5,  // break < 1.5 × ATR = minor BOS
  sweepWindow:     5,    // sweep must occur within N bars after inducement
  sweepWickRatio:  1.5,  // wick-to-body ratio on the sweep candle
  displaceWindow:  6,    // displacement CHoCH/FVG must occur within N bars after sweep
  volPeriod:       20,
  volSpikeMult:    1.5,  // displacement volume ≥ this × SMA_20(volume)
});

/* ───────────────────────── Small math helpers ───────────────────────── */

function bodySize(c)   { return Math.abs((+c.c) - (+c.o)); }
function upperWick(c)  { return (+c.h) - Math.max(+c.o, +c.c); }
function lowerWick(c)  { return Math.min(+c.o, +c.c) - (+c.l); }

/** Wick-to-body ratio for the relevant side of a sweep. */
function wickBodyRatio(c, side /* "upper" | "lower" */) {
  const b = bodySize(c);
  const w = side === "upper" ? upperWick(c) : lowerWick(c);
  if (!(w > 0)) return 0;
  if (b <= 1e-12) return Infinity;
  return w / b;
}

/** True if x is the min over arr[from..to] (inclusive), skipping non-finite. */
function isMinInWindow(arr, i, windowLen, tolBin = 0) {
  if (!arr || !Number.isInteger(i) || i < 0 || i >= arr.length) return false;
  const v = +arr[i];
  if (!Number.isFinite(v)) return false;
  const from = Math.max(0, i - windowLen + 1);
  let lower = 0;
  for (let k = from; k <= i; k++) {
    if (k === i) continue;
    const x = +arr[k];
    if (!Number.isFinite(x)) continue;
    if (x < v) lower++;
    if (lower > tolBin) return false;
  }
  return true;
}

/** Compute Bollinger band width series from a {up, mid, lo} BB object. */
export function bandWidthSeries(bb) {
  if (!bb || !bb.up || !bb.lo || !bb.mid) return null;
  const n = Math.min(bb.up.length, bb.mid.length, bb.lo.length);
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const u = +bb.up[i], m = +bb.mid[i], l = +bb.lo[i];
    if (Number.isFinite(u) && Number.isFinite(m) && Number.isFinite(l) && m !== 0) {
      out[i] = (u - l) / m;
    }
  }
  return out;
}

/* ───────────────────────── Sub-detectors ───────────────────────── */

/**
 * Step 1 — was the market in compression AT (or right before) `idx`?
 *   · ATR14 < SMA_100(ATR14) for ≥ atrRunLen consecutive candles ending at idx.
 *   · BBW[idx] is a new 50-period low (within tolerance).
 */
export function detectCompression(ta, idx, cfg = DEFAULTS) {
  const atrArr = ta[`atr${cfg.atrPeriod}`];
  if (!atrArr || idx < 0 || idx >= atrArr.length) return null;
  // SMA of ATR — compute on the fly (small N). Cache on `ta` so repeated calls share.
  if (!ta._cisdAtrSma) ta._cisdAtrSma = {};
  const key = `atr${cfg.atrPeriod}_sma${cfg.atrSmaPeriod}`;
  let atrSma = ta._cisdAtrSma[key];
  if (!atrSma) { atrSma = sma(atrArr, cfg.atrSmaPeriod); ta._cisdAtrSma[key] = atrSma; }
  // ATR run condition
  let runOk = true;
  for (let k = 0; k < cfg.atrRunLen; k++) {
    const j = idx - k;
    if (j < 0) { runOk = false; break; }
    const a = +atrArr[j], s = +atrSma[j];
    if (!Number.isFinite(a) || !Number.isFinite(s) || !(a < s)) { runOk = false; break; }
  }
  if (!runOk) return null;
  // BBW low condition — find any BB object on `ta` matching `bb_<period>_<k>`.
  const bbKey = Object.keys(ta).find(k => k.startsWith("bb_"));
  const bb = bbKey ? ta[bbKey] : null;
  if (!bb) return null;
  if (!ta._cisdBbw) ta._cisdBbw = bandWidthSeries(bb);
  const bbw = ta._cisdBbw;
  if (!bbw || !isMinInWindow(bbw, idx, cfg.bbwPeriod, cfg.bbwToleranceBin)) return null;
  return {
    i: idx,
    t: (ta.t && ta.t[idx]) || null,
    atr: +atrArr[idx],
    atrSma: +atrSma[idx],
    bbw: +bbw[idx],
    atrRunLen: cfg.atrRunLen,
  };
}

/**
 * Step 2 — was there a *minor* BOS shortly AFTER the compression?
 * Returns the most recent minor-BOS break whose `i > compression.i` and whose
 * magnitude (distance between close and the broken swing level) is below
 * mBosMaxATRMult × ATR14. Direction of inducement = break direction.
 */
export function detectInducement(ta, afterIdx, cfg = DEFAULTS) {
  const breaks = Array.isArray(ta.breaks) ? ta.breaks : [];
  const atrArr = ta[`atr${cfg.atrPeriod}`];
  if (!breaks.length || !atrArr) return null;
  // Most recent mBOS after afterIdx (within lookback window handled by caller)
  let best = null;
  for (let k = breaks.length - 1; k >= 0; k--) {
    const b = breaks[k];
    if (!b || b.type !== "BoS" || !Number.isInteger(b.i)) continue;
    if (b.i <= afterIdx) break;  // breaks are ordered → we've gone past the window
    const close = +ta.close[b.i];
    const a = +atrArr[b.i];
    if (!Number.isFinite(close) || !Number.isFinite(a) || a <= 0) continue;
    const mag = Math.abs(close - (+b.level));
    if (mag < cfg.mBosMaxATRMult * a) {
      best = { i: b.i, t: b.t, dir: b.dir, level: +b.level, magnitudeATR: mag / a };
      break;
    }
  }
  return best;
}

/**
 * Step 3 — was there a qualifying sweep shortly AFTER inducement?
 * We use the pre-computed `ta.liquidity.sweeps` list where possible (its wick-
 * beyond/close-back invariant already holds), then additionally validate
 * wick-to-body ratio. If no sweep is in `ta.liquidity.sweeps` at the right
 * index we also inspect raw candles for a wick-sweep of the inducement level.
 */
export function detectSweep(ta, inducement, cfg = DEFAULTS) {
  if (!inducement) return null;
  const lastBar = (ta.close?.length ?? 1) - 1;
  const windowEnd = Math.min(lastBar, inducement.i + cfg.sweepWindow);

  // Helper to validate a candidate sweep bar.
  function validate(i, kind) {
    const c = ta.close[i], o = ta.open[i], h = ta.high[i], l = ta.low[i];
    if (![c, o, h, l].every(Number.isFinite)) return null;
    const bar = { o, h, l, c };
    const side = kind === "bearish" ? "upper" : "lower";
    const ratio = wickBodyRatio(bar, side);
    if (!(ratio >= cfg.sweepWickRatio)) return null;
    // Body must close back inside the inducement level in the OPPOSITE direction
    // from the sweep wick.
    const lvl = inducement.level;
    if (kind === "bearish" && !(+h > lvl && +c < lvl)) return null;
    if (kind === "bullish" && !(+l < lvl && +c > lvl)) return null;
    return {
      i, t: (ta.t && ta.t[i]) || null,
      kind, level: lvl,
      wickRatio: ratio,
      barsAfterInducement: i - inducement.i,
    };
  }

  // Sweep direction is the OPPOSITE of inducement direction
  //   inducement.dir === "up"   → longs got trapped, wick pierces UP → bearish sweep
  //   inducement.dir === "down" → shorts got trapped, wick pierces DOWN → bullish sweep
  const kind = inducement.dir === "up" ? "bearish" : "bullish";

  // 1. Prefer any already-tagged sweep from the liquidity layer.
  const sweeps = ta.liquidity?.sweeps || [];
  for (let k = sweeps.length - 1; k >= 0; k--) {
    const s = sweeps[k];
    if (!s || s.i <= inducement.i || s.i > windowEnd) continue;
    if (s.kind !== kind) continue;
    const v = validate(s.i, kind);
    if (v) return v;
  }
  // 2. Fall back to raw-candle scan around the inducement level.
  for (let i = inducement.i + 1; i <= windowEnd; i++) {
    const v = validate(i, kind);
    if (v) return v;
  }
  return null;
}

/**
 * Step 4 — displacement: CHoCH opposite to the sweep wick, plus FVG + volume spike.
 * Returns { break, fvg, volRatio } or null.
 */
export function detectDisplacement(ta, sweep, cfg = DEFAULTS) {
  if (!sweep) return null;
  const lastBar = (ta.close?.length ?? 1) - 1;
  const windowEnd = Math.min(lastBar, sweep.i + cfg.displaceWindow);
  const breaks = Array.isArray(ta.breaks) ? ta.breaks : [];
  const fvgOpen = ta.fvg?.open || [];
  const fvgMit  = ta.fvg?.mitigated || [];
  const allFvg = fvgOpen.concat(fvgMit);

  // CHoCH direction = opposite of sweep wick.
  //   bearish sweep → expect DOWN CHoCH (price rolls over) → short
  //   bullish sweep → expect UP   CHoCH (price reverses up) → long
  const wantDir = sweep.kind === "bearish" ? "down" : "up";
  let choch = null;
  for (let k = breaks.length - 1; k >= 0; k--) {
    const b = breaks[k];
    if (!b || b.type !== "CHoCH" || !Number.isInteger(b.i)) continue;
    if (b.i <= sweep.i || b.i > windowEnd) continue;
    if (b.dir !== wantDir) continue;
    choch = b; break;
  }
  if (!choch) return null;

  // FVG with matching polarity created in the displacement window.
  const wantFvgKind = wantDir === "up" ? "bull" : "bear";
  let fvg = null;
  for (let k = allFvg.length - 1; k >= 0; k--) {
    const g = allFvg[k];
    if (!g || g.kind !== wantFvgKind) continue;
    if (!(g.createdAtIdx >= sweep.i && g.createdAtIdx <= windowEnd)) continue;
    fvg = g; break;
  }
  if (!fvg) return null;

  // Volume spike on the displacement bar (choch.i): volume ≥ mult × SMA_N(volume).
  const vol = ta.volume;
  if (!vol || vol.length <= choch.i) return null;
  if (!ta._cisdVolSma) ta._cisdVolSma = {};
  const vKey = `v${cfg.volPeriod}`;
  let vSma = ta._cisdVolSma[vKey];
  if (!vSma) { vSma = sma(vol, cfg.volPeriod); ta._cisdVolSma[vKey] = vSma; }
  const vNow = +vol[choch.i];
  const vAvg = +vSma[choch.i];
  if (!(Number.isFinite(vNow) && Number.isFinite(vAvg) && vAvg > 0)) return null;
  const volRatio = vNow / vAvg;
  if (!(volRatio >= cfg.volSpikeMult)) return null;

  return {
    break: { i: choch.i, t: choch.t, dir: choch.dir, level: +choch.level },
    fvg,
    volRatio,
  };
}

/* ───────────────────────── Main evaluator ───────────────────────── */

/**
 * Walk the last `lookback` bars backward, looking for the most recent CHoCH
 * whose preceding sequence (sweep → inducement → compression) fully qualifies.
 * Returns the calibrated module signal.
 */
export function evaluate(ta, ctx = {}) {
  const cfg = { ...DEFAULTS, ...(ctx.cisd || {}) };
  if (!ta || ta.empty) return neutral("empty TA");
  const n = ta.close?.length ?? 0;
  if (n < Math.max(cfg.atrSmaPeriod, cfg.bbwPeriod, cfg.volPeriod) + cfg.atrRunLen + cfg.displaceWindow) {
    return neutral("insufficient history for CISD");
  }

  // Search for the most recent full sequence whose displacement (CHoCH) is
  // within the lookback window. Iterate CHoCH events in reverse.
  const breaks = Array.isArray(ta.breaks) ? ta.breaks : [];
  const lastIdx = n - 1;
  let best = null;
  for (let k = breaks.length - 1; k >= 0 && !best; k--) {
    const b = breaks[k];
    if (!b || b.type !== "CHoCH") continue;
    if (lastIdx - b.i > cfg.lookback) break;

    // Work backward from this CHoCH candidate:
    //   sweep must be within `displaceWindow` bars before the CHoCH
    //   inducement must be within `sweepWindow` bars before the sweep
    //   compression must hold at the last bar of the sequence before inducement
    //
    // We scan for a matching sweep in [b.i - displaceWindow .. b.i - 1], then
    // for each such sweep we look for an inducement before it, etc.
    const sweepFrom = Math.max(0, b.i - cfg.displaceWindow);
    const wantSweepKind = b.dir === "down" ? "bearish" : "bullish";
    const sweeps = (ta.liquidity?.sweeps || []).filter(s =>
      s && s.kind === wantSweepKind && s.i >= sweepFrom && s.i < b.i);

    for (let si = sweeps.length - 1; si >= 0 && !best; si--) {
      const s = sweeps[si];
      // Find the inducement: the most recent BOS in the OPPOSITE direction
      // to the CHoCH (same direction as the trap wick) within the sweep
      // window, with magnitude < mBosMaxATRMult × ATR.
      const indDir = b.dir === "down" ? "up" : "down";
      const atrArr = ta[`atr${cfg.atrPeriod}`];
      let inducement = null;
      for (let ki = breaks.length - 1; ki >= 0; ki--) {
        const ib = breaks[ki];
        if (!ib || ib.type !== "BoS" || ib.dir !== indDir) continue;
        if (!(ib.i < s.i && s.i - ib.i <= cfg.sweepWindow)) continue;
        const close = +ta.close[ib.i];
        const a = +atrArr[ib.i];
        if (!Number.isFinite(close) || !Number.isFinite(a) || a <= 0) continue;
        const mag = Math.abs(close - (+ib.level));
        if (mag < cfg.mBosMaxATRMult * a) {
          inducement = { i: ib.i, t: ib.t, dir: ib.dir, level: +ib.level, magnitudeATR: mag / a };
          break;
        }
      }
      if (!inducement) continue;
      // Compression must hold AT OR BEFORE the inducement.
      const compression = detectCompression(ta, inducement.i - 1, cfg)
                       || detectCompression(ta, inducement.i, cfg);
      if (!compression) continue;
      // Re-validate sweep candle (wick:body, close-back).
      const sweepValid = detectSweep(ta, inducement, cfg);
      if (!sweepValid || sweepValid.i !== s.i) continue;
      // Re-validate displacement (FVG + volume on b.i window).
      const displacement = detectDisplacement(ta, sweepValid, cfg);
      if (!displacement || displacement.break.i !== b.i) continue;

      best = { compression, inducement, sweep: sweepValid, displacement, choch: b };
    }
  }

  if (!best) {
    return clampSignal({
      signal: 0,
      confidence: 0.05,
      reasons: ["no full CISD sequence in window"],
    });
  }

  // Signal = direction of the CHoCH/displacement.
  //   sweep.kind === "bearish" → short (longs trapped)
  //   sweep.kind === "bullish" → long  (shorts trapped)
  const dir = best.sweep.kind === "bullish" ? 1 : -1;

  // Confidence is a blend of setup quality:
  //   · freshness of the CHoCH (bars since displacement)
  //   · wick:body ratio of the sweep (above threshold)
  //   · volume ratio on displacement
  //   · tightness of compression (bbw rank — already a 50-bar low by construction)
  const age = lastIdx - best.choch.i;
  const fresh = age === 0 ? 1 : age <= 2 ? 0.85 : age <= 5 ? 0.65 : 0.4;
  const wickBonus = Math.min(1, (best.sweep.wickRatio - cfg.sweepWickRatio) / 2);
  const volBonus  = Math.min(1, (best.displacement.volRatio - cfg.volSpikeMult) / 2);
  const confidence = Math.max(0, Math.min(1,
    0.45 + 0.25 * fresh + 0.15 * wickBonus + 0.15 * volBonus,
  ));
  const strength = Math.max(0.4, Math.min(1,
    0.5 + 0.25 * fresh + 0.25 * (wickBonus * 0.5 + volBonus * 0.5),
  ));

  return clampSignal({
    signal: dir * strength,
    confidence,
    reasons: [
      `compression at bar ${best.compression.i} (bbw=${best.compression.bbw.toFixed(4)})`,
      `mBOS ${best.inducement.dir} at bar ${best.inducement.i} (mag=${best.inducement.magnitudeATR.toFixed(2)}×ATR)`,
      `${best.sweep.kind} sweep at bar ${best.sweep.i} (wick:body=${best.sweep.wickRatio.toFixed(2)})`,
      `displacement CHoCH ${best.choch.dir} at bar ${best.choch.i} (vol=${best.displacement.volRatio.toFixed(2)}× avg)`,
      `age=${age} bar${age === 1 ? "" : "s"}`,
    ],
    payload: {
      compression: best.compression,
      inducement:  best.inducement,
      sweep:       best.sweep,
      displacement: best.displacement,
      dir: dir > 0 ? "long" : "short",
    },
  });
}

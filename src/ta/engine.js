/**
 * My Next Prediction v3.0 — TA Engine orchestrator
 * ------------------------------------------------
 * Takes a candle array and a selection of indicators / structure / patterns
 * and returns a single feature bundle. Designed so the UI and later the
 * feature-vector stage (Phase 5) can both call the same entry point.
 *
 *   const ta = TAEngine.compute(candles, { indicators, structure, patterns });
 *   // ta = {
 *   //   close, open, high, low, volume,
 *   //   ema20, ema50, ema200, rsi14, macd:{macd,signal,hist}, bb:{mid,up,lo},
 *   //   atr14, adx14:{adx,plusDI,minusDI}, stoch:{k,d}, vwap, obv, cmf,
 *   //   pivots:[...], trend:"up|down|range", breaks:[{type:"BoS|CHoCH",...}],
 *   //   fvg:{open,mitigated},
 *   //   levels:[{price,strength,touches,kind}], // S/R
 *   //   patterns:[{i,t,patterns:["hammer","bullEngulf"]},...]
 *   // }
 */
import { sma, ema, wma } from "./indicators/moving.js";
import { rsi, macd, stochastic, roc } from "./indicators/oscillators.js";
import { bbands } from "./indicators/bands.js";
import { atr, adx } from "./indicators/volatility.js";
import { vwap, obv, cmf } from "./indicators/volume.js";
import { psar } from "./indicators/parabolic.js";
import { ichimoku } from "./indicators/ichimoku.js";
import { cci } from "./indicators/cci.js";
import { williamsR } from "./indicators/williamsr.js";
import { mfi } from "./indicators/mfi.js";
import { detectAll as detectPatterns } from "./patterns/candles.js";
import { findPivots, classifyPivots, currentTrend } from "./structure/swings.js";
import { detectBreaks } from "./structure/bos.js";
import { detectFVG } from "./structure/fvg.js";
import { detectOrderBlocks } from "./structure/orderBlocks.js";
import { detectLiquidity } from "./structure/liquidity.js";
import { premiumDiscount } from "./structure/premiumDiscount.js";
// M3 step 6 — trendlines + chart patterns
import { detectTrendlines } from "./structure/trendlines.js";
import { detectChartPatterns } from "./patterns/chartPatterns.js";
import { tagSessions, sessionStats } from "./structure/sessions.js";
import { clusterLevels } from "./levels/supportResistance.js";
import { lastFinite } from "./math.js";
import { classifyRegime } from "../regime/classifier.js";
import { classifyWyckoff } from "../regime/wyckoff.js";

const DEFAULT_INDICATORS = {
  ema: [20, 50, 200],
  rsi: [14],
  macd: [[12, 26, 9]],
  bb:   [[20, 2]],
  atr: [14],
  adx: [14],
  stoch: [[14, 3]],
  vwap: { mode: "rolling", period: 20 },
  roc: [10],
  cmf: [20],
  // Phase 10.6 — v2 parity
  psar: { accStart: 0.02, accStep: 0.02, accMax: 0.2 },
  ichimoku: { tenkan: 9, kijun: 26, senkouB: 52, shift: 26 },
  cci: [20],
  williamsR: [14],
  mfi: [14],
};

const DEFAULT_STRUCTURE = {
  pivots:  { left: 2, right: 2 },
  sr:      { atrMult: 0.5, halfLifeBars: 500, topN: 20 },
  fvg:     true,
  bos:     true,
  // Phase 4 additions
  orderBlocks:     { impulseATRMult: 1.5, impulseLookahead: 3 },
  liquidity:       { atrMult: 0.25, minTouches: 2 },
  premiumDiscount: true,
  sessions:        true,
  // Phase 6 additions
  regime:          true,
  // M3 step 6 — trendlines + chart patterns
  trendlines:      { lookback: 8, toleranceATR: 0.5, breakoutATR: 0.5 },
  chartPatterns:   true,
};

export const TAEngine = {
  compute(candles, {
    indicators = DEFAULT_INDICATORS,
    structure  = DEFAULT_STRUCTURE,
    patterns   = true,
  } = {}) {
    if (!Array.isArray(candles) || candles.length < 2) {
      return { candles: candles ?? [], empty: true };
    }
    const open  = candles.map(c => +c.o);
    const high  = candles.map(c => +c.h);
    const low   = candles.map(c => +c.l);
    const close = candles.map(c => +c.c);
    const vol   = candles.map(c => +c.v);
    const t     = candles.map(c => +c.t);

    const out = { t, open, high, low, close, volume: vol };

    // ─── Indicators ────────────────────────────────────────────────
    for (const p of indicators.ema || []) out[`ema${p}`] = ema(close, p);
    for (const p of indicators.rsi || []) out[`rsi${p}`] = rsi(close, p);
    for (const [f, s, sig] of indicators.macd || []) out[`macd_${f}_${s}_${sig}`] = macd(close, f, s, sig);
    for (const [p, k]    of indicators.bb   || []) out[`bb_${p}_${k}`] = bbands(close, p, k);
    for (const p of indicators.atr || []) out[`atr${p}`] = atr(high, low, close, p);
    for (const p of indicators.adx || []) out[`adx${p}`] = adx(high, low, close, p);
    for (const [k, d]    of indicators.stoch|| []) out[`stoch_${k}_${d}`] = stochastic(high, low, close, k, d);
    if (indicators.vwap) out.vwap = vwap(high, low, close, vol, { ...indicators.vwap, t });
    for (const p of indicators.roc || []) out[`roc${p}`] = roc(close, p);
    for (const p of indicators.cmf || []) out[`cmf${p}`] = cmf(high, low, close, vol, p);
    out.obv = obv(close, vol);
    // Phase 10.6 — v2 parity indicators
    if (indicators.psar) out.psar = psar(high, low, indicators.psar);
    if (indicators.ichimoku) out.ichimoku = ichimoku(high, low, close, indicators.ichimoku);
    for (const p of indicators.cci || []) out[`cci${p}`] = cci(high, low, close, p);
    for (const p of indicators.williamsR || []) out[`wr${p}`] = williamsR(high, low, close, p);
    for (const p of indicators.mfi || []) out[`mfi${p}`] = mfi(high, low, close, vol, p);

    // ─── Structure ─────────────────────────────────────────────────
    const piv = findPivots(candles, structure.pivots || {});
    classifyPivots(piv);
    out.pivots = piv;
    out.trend  = currentTrend(piv);
    if (structure.bos !== false) out.breaks = detectBreaks(candles, piv);
    if (structure.fvg !== false) out.fvg    = detectFVG(candles);

    // S/R tolerance = ATR(14).lastFinite × atrMult
    const atrArr = out.atr14 || atr(high, low, close, 14);
    const atrLast = lastFinite(atrArr);
    const atrMult = structure.sr?.atrMult ?? 0.5;
    const tol = Number.isFinite(atrLast) ? atrLast * atrMult : (lastFinite(close) || 1) * 0.005;
    out.levels = clusterLevels(piv, {
      tolerance: tol,
      halfLifeBars: structure.sr?.halfLifeBars ?? 500,
    }).slice(0, structure.sr?.topN ?? 20);

    // ─── Order Blocks (Phase 4) ───────────────────────────────────
    if (structure.orderBlocks !== false) {
      out.orderBlocks = detectOrderBlocks(candles, piv, structure.orderBlocks || {});
    }

    // ─── Liquidity (Phase 4) ──────────────────────────────────────
    if (structure.liquidity !== false) {
      const liqTol = Number.isFinite(atrLast)
        ? atrLast * (structure.liquidity?.atrMult ?? 0.25)
        : (lastFinite(close) || 1) * 0.0025;
      out.liquidity = detectLiquidity(candles, piv, {
        tolerance: liqTol,
        minTouches: structure.liquidity?.minTouches ?? 2,
      });
    }

    // ─── Premium / Discount (Phase 4) ─────────────────────────────
    if (structure.premiumDiscount !== false) {
      out.premiumDiscount = premiumDiscount(candles, piv, structure.premiumDiscount || {});
    }

    // ─── Sessions (Phase 4) ───────────────────────────────────────
    if (structure.sessions !== false) {
      out.sessions = {
        tags: tagSessions(candles),
        stats: sessionStats(candles),
      };
    }

    // ─── Patterns ──────────────────────────────────────────────────
    if (patterns !== false) out.patterns = detectPatterns(candles);

    // ─── Trendlines + chart patterns (M3 step 6) ───────────────────
    if (structure.trendlines !== false) {
      out.trendlines = detectTrendlines(candles, {
        atr: atrLast,
        pivots: structure.pivots || {},
        ...(typeof structure.trendlines === "object" ? structure.trendlines : {}),
      });
    }
    if (structure.chartPatterns !== false) {
      out.chartPatterns = detectChartPatterns(candles, {
        atr: atrLast,
        pivots: structure.pivots || {},
        ...(typeof structure.chartPatterns === "object" ? structure.chartPatterns : {}),
      });
    }

    // ─── Regime (Phase 6) ─────────────────────────────────────────
    if (structure.regime !== false) {
      out.regime = classifyRegime(out);
    }
    // ─── Wyckoff phase (M4b) ──────────────────────────────────────
    if (structure.wyckoff !== false) {
      out.wyckoff = classifyWyckoff(out, typeof structure.wyckoff === "object" ? structure.wyckoff : {});
    }

    // ─── Summary (cheap, useful for the UI) ───────────────────────
    const obsOpen = (out.orderBlocks || []).filter(b => !b.mitigated);
    out.summary = {
      last: {
        close: close[close.length - 1],
        ema20:  lastFinite(out.ema20),
        ema50:  lastFinite(out.ema50),
        ema200: lastFinite(out.ema200),
        rsi14:  lastFinite(out.rsi14),
        atr14:  atrLast,
        adx14:  lastFinite(out.adx14?.adx),
      },
      trend: out.trend,
      nearestResistance: out.levels.find(L => L.price >= close[close.length - 1])?.price ?? null,
      nearestSupport:    [...out.levels].reverse().find(L => L.price <= close[close.length - 1])?.price ?? null,
      breakCount: out.breaks?.length || 0,
      fvgOpenCount: out.fvg?.open?.length || 0,
      patternsLastN: (out.patterns || []).slice(-5),
      // Phase 4
      orderBlocksOpen: obsOpen.length,
      bullOBsOpen: obsOpen.filter(b => b.kind === "bull").length,
      bearOBsOpen: obsOpen.filter(b => b.kind === "bear").length,
      liquidityEQH: out.liquidity?.eqHighs?.length || 0,
      liquidityEQL: out.liquidity?.eqLows?.length  || 0,
      recentSweep:  (out.liquidity?.sweeps || []).slice(-1)[0] || null,
      zone: out.premiumDiscount?.lastZone || "unknown",
      session: out.sessions?.tags?.[out.sessions.tags.length - 1] || "unknown",
      // Phase 6
      regime: out.regime?.label || "unknown",
      regimeTrend: out.regime?.trend || "unknown",
      regimeStrength: out.regime?.strength || "unknown",
      regimeVolatility: out.regime?.volatility || "unknown",
    };
    return out;
  },
};

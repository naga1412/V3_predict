/**
 * My Next Prediction v3.0 — M7 · Walk-forward Backtest Harness
 * ------------------------------------------------------------
 * Replays historical candles through the live pipeline:
 *   TA  →  Orchestrator  →  (optional) Meta-Brain
 * generates a prediction at every bar, evaluates it `horizon` bars
 * later against the realised close, and aggregates equity / Sharpe /
 * max-drawdown / hit-rate metrics.
 *
 * Crucially, the TA snapshot at bar i is computed from candles[0..i]
 * only, so there is no look-ahead leak.  The walk-forward loop
 * advances bar-by-bar from `warmup` to `candles.length - horizon`.
 *
 * Public surface:
 *   runBacktest({ symbol, tf, horizon, useMetaBrain, sample, onProgress })
 *     → { trades, equity, metrics, params }
 *
 * Bus events:
 *   backtest:start    {symbol, tf, total}
 *   backtest:progress {done, total}
 *   backtest:done     {metrics, ms}
 *
 * Performance: TAEngine.compute is rebuilt every `sample` bars (default
 * 1) so we trade O(n²) work for accuracy.  At sample=5 a 1000-bar
 * backtest finishes in < 5 s on a modern laptop.
 */

import { EventBus } from "../core/bus.js";
import { TAEngine } from "../ta/engine.js";
import { runModules } from "../modules/orchestrator.js";
import { getStored } from "../data/gapFiller.js";

const DEFAULT_HORIZON = 5;     // bars
const DEFAULT_SAMPLE  = 1;     // every bar
const WARMUP_BARS     = 200;   // need EMA200 etc.

/**
 * Run a walk-forward backtest.
 *
 * @param {object} opts
 * @param {string} opts.symbol           e.g. "BTCUSDT"
 * @param {string} opts.tf               "1m"|"5m"|"15m"|"1h"|"4h"|"1d"
 * @param {number} [opts.horizon=5]      hold horizon in bars
 * @param {boolean} [opts.useMetaBrain]  let Meta-Brain decide vs orchestrator
 * @param {number} [opts.sample=1]       evaluate every Nth bar
 * @param {number} [opts.maxBars]        cap input candle count (latest N)
 * @param {(p:{done:number,total:number})=>void} [opts.onProgress]
 * @returns {Promise<{trades:Array, equity:Array, metrics:object, params:object}>}
 */
export async function runBacktest({
  symbol,
  tf,
  horizon = DEFAULT_HORIZON,
  useMetaBrain = false,
  sample = DEFAULT_SAMPLE,
  maxBars = 800,
  onProgress = null,
} = {}) {
  if (!symbol || !tf) throw new Error("backtest: symbol+tf required");

  const t0 = Date.now();
  const candles = await getStored({ symbol, tf, limit: maxBars });
  if (!Array.isArray(candles) || candles.length < WARMUP_BARS + horizon + 50) {
    throw new Error(`backtest: need >= ${WARMUP_BARS + horizon + 50} bars, have ${candles?.length || 0}`);
  }

  const total = Math.floor((candles.length - WARMUP_BARS - horizon) / Math.max(1, sample));
  EventBus.emit("backtest:start", { symbol, tf, total });

  const trades = [];
  const equity = [{ t: candles[WARMUP_BARS].t, value: 1.0 }];
  let cash = 1.0;
  let done = 0;
  const M = (typeof window !== "undefined") ? window.__MNP__ : null;

  for (let i = WARMUP_BARS; i + horizon < candles.length; i += sample) {
    // Causal TA snapshot — bars 0..i only.
    let ta;
    try { ta = TAEngine.compute(candles.slice(0, i + 1)); }
    catch (err) { continue; }

    // Orchestrator decision
    let decision;
    try { decision = runModules(ta, {}); }
    catch (err) { continue; }
    if (!decision || decision.direction === "neutral") {
      // neutral = no trade, but advance progress
      done++;
      onProgress?.({ done, total });
      if (done % 25 === 0) EventBus.emit("backtest:progress", { done, total });
      continue;
    }

    // Optional Meta-Brain override
    if (useMetaBrain && M?.MetaBrain?.aggregate && M?.MetaBrain?.decide) {
      try {
        const v = M.MetaBrain.aggregate({
          symbol, tf, t: candles[i].t,
          orch: decision, ta,
          regime: ta.regime, wyckoff: ta.wyckoff,
          macro: null, deriv: null, stability: null, adaptive: null,
        });
        const d = await M.MetaBrain.decide(v, { orchFallback: decision });
        if (d?.direction) {
          decision = {
            ...decision,
            direction: d.direction,
            rawScore:  d.rawScore,
            probability: d.probability,
            confidence:  d.confidence,
            metaBrain: { used: d.used, version: d.modelVersion },
          };
        }
      } catch { /* fall back to orch */ }
    }

    // Realised return over horizon
    const entryPrice = candles[i].c;
    const exitPrice  = candles[i + horizon].c;
    const ret        = (exitPrice - entryPrice) / entryPrice;

    // Direction-signed pnl (longs profit on +ret, shorts on -ret)
    const sign = decision.direction === "long" ?  1
              : decision.direction === "short" ? -1
              : 0;
    if (sign === 0) {
      done++;
      onProgress?.({ done, total });
      if (done % 25 === 0) EventBus.emit("backtest:progress", { done, total });
      continue;
    }
    const pnl = sign * ret;
    cash *= (1 + pnl);

    trades.push({
      t: candles[i].t,
      exitT: candles[i + horizon].t,
      direction: decision.direction,
      entryPrice, exitPrice,
      ret: +ret.toFixed(6),
      pnl: +pnl.toFixed(6),
      cash: +cash.toFixed(6),
      probability: decision.probability ?? null,
      confidence: decision.confidence ?? null,
      regime: ta.regime?.label || null,
      brain: decision.metaBrain?.used || null,
      hit: pnl > 0,
    });
    equity.push({ t: candles[i + horizon].t, value: +cash.toFixed(6) });

    done++;
    onProgress?.({ done, total });
    if (done % 25 === 0) EventBus.emit("backtest:progress", { done, total });
  }

  const metrics = computeMetrics(trades, equity);
  const ms = Date.now() - t0;
  EventBus.emit("backtest:done", { metrics, ms, symbol, tf });
  return {
    trades, equity, metrics,
    params: { symbol, tf, horizon, useMetaBrain, sample, maxBars, ms,
              warmup: WARMUP_BARS, totalCandles: candles.length },
  };
}

/* ───────────────────────── Metrics ───────────────────────── */

function computeMetrics(trades, equity) {
  if (!trades.length) {
    return {
      n: 0, hits: 0, hitRate: 0, totalReturn: 0,
      sharpe: 0, sortino: 0, maxDrawdown: 0,
      avgWin: 0, avgLoss: 0, profitFactor: 0,
      bestTrade: 0, worstTrade: 0,
    };
  }
  const n     = trades.length;
  const wins  = trades.filter((t) => t.hit);
  const loss  = trades.filter((t) => !t.hit);
  const hitRate = wins.length / n;

  const last  = equity[equity.length - 1].value;
  const totalReturn = last - 1.0;

  // Sharpe (annualised assuming daily-ish bars; tf-agnostic crude proxy)
  const rets  = trades.map((t) => t.pnl);
  const mean  = rets.reduce((a, b) => a + b, 0) / n;
  const sd    = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1e-9;
  const sharpe = (mean / sd) * Math.sqrt(n);

  // Sortino — downside-only volatility
  const downside = rets.filter((r) => r < 0);
  const dsd = downside.length
    ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length)
    : 1e-9;
  const sortino = (mean / dsd) * Math.sqrt(n);

  // Max drawdown
  let peak = equity[0].value, mdd = 0;
  for (const p of equity) {
    if (p.value > peak) peak = p.value;
    const dd = (peak - p.value) / peak;
    if (dd > mdd) mdd = dd;
  }

  const sumWins  = wins.reduce((a, b) => a + b.pnl, 0);
  const sumLoss  = Math.abs(loss.reduce((a, b) => a + b.pnl, 0));
  const profitFactor = sumLoss > 0 ? sumWins / sumLoss : (sumWins > 0 ? Infinity : 0);
  const avgWin   = wins.length ? sumWins / wins.length : 0;
  const avgLoss  = loss.length ? sumLoss / loss.length : 0;

  return {
    n,
    hits: wins.length,
    hitRate:    +hitRate.toFixed(4),
    totalReturn: +totalReturn.toFixed(6),
    sharpe:     +sharpe.toFixed(3),
    sortino:    +sortino.toFixed(3),
    maxDrawdown: +mdd.toFixed(4),
    avgWin:     +avgWin.toFixed(6),
    avgLoss:    +avgLoss.toFixed(6),
    profitFactor: Number.isFinite(profitFactor) ? +profitFactor.toFixed(3) : null,
    bestTrade:  +Math.max(...rets).toFixed(6),
    worstTrade: +Math.min(...rets).toFixed(6),
  };
}

/* ───────────────────────── Per-regime breakdown ───────────────────────── */

/**
 * Bucket trades by regime label and compute the same metrics per bucket.
 * Useful for spotting where the strategy works vs fails.
 */
export function metricsByRegime(trades) {
  const groups = new Map();
  for (const t of trades) {
    const k = t.regime || "unknown";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = {};
  for (const [k, ts] of groups) {
    out[k] = computeMetrics(ts, [{ value: 1 }, ...ts.map((t) => ({ value: t.cash }))]);
  }
  return out;
}

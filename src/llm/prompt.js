/**
 * My Next Prediction v3.0 — M6 · Prompt builder
 * ---------------------------------------------
 * Compose a focused trading-analyst prompt from the live runtime
 * surfaces (TA snapshot, orchestration, ghost forecast, news,
 * derivatives).  Pure: takes plain objects, returns strings.
 */

const SYSTEM_PROMPT_DEFAULT = `You are a senior crypto/equities trading analyst embedded in the My Next Prediction v3 platform.
You receive a live snapshot of multi-source signals (technical analysis, regime, ML ensemble, conformal interval, ghost-candle forecast, news sentiment, derivatives, intermarket).
Your job is to:
  1. State the probable direction over the next 5–25 bars (LONG / SHORT / NEUTRAL).
  2. Quote the 2–3 strongest pieces of evidence (cite the field names / values).
  3. Call out the single biggest invalidation risk.
  4. Suggest one concrete entry / stop / target if the setup is actionable; otherwise say "wait".
Be terse, numerical where possible, and explicitly bullish or bearish — no hedging fluff.
Never invent fields that aren't in the context.  If a field is missing, say "not available".
Format: one short paragraph then a 4-line bullet list.`;

function safe(x, d = 4) {
  if (typeof x === "number" && Number.isFinite(x)) {
    if (Math.abs(x) >= 1) return x.toFixed(d);
    return x.toFixed(d + 2);
  }
  return "—";
}
function pct(x, d = 1) { return Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "—"; }

/**
 * Build a compact context block from runtime objects.  All inputs
 * optional — missing sections are simply omitted.
 *
 * @param {{
 *   symbol?:string, tf?:string, lastPrice?:number,
 *   ta?:object, orch?:object, ghost?:object,
 *   regime?:object, wyckoff?:object, macro?:object,
 *   news?:Array, deriv?:object, stability?:object,
 * }} ctx
 */
export function buildContext(ctx = {}) {
  const lines = [];
  if (ctx.symbol || ctx.tf) lines.push(`SYMBOL: ${ctx.symbol || "—"}  TF: ${ctx.tf || "—"}  PRICE: ${safe(ctx.lastPrice)}`);

  const ta = ctx.ta;
  if (ta && !ta.empty) {
    const last = (a) => Array.isArray(a) ? a[a.length - 1] : a;
    lines.push("TA:");
    lines.push(`  trend=${ta.trend || "—"}  EMA20=${safe(last(ta.ema20))}  EMA50=${safe(last(ta.ema50))}  EMA200=${safe(last(ta.ema200))}`);
    lines.push(`  RSI14=${safe(last(ta.rsi14))}  ADX14=${safe(last(ta.adx14?.adx))}  ATR14=${safe(last(ta.atr14))}`);
    if (ta.bb_20_2) lines.push(`  BB20: up=${safe(last(ta.bb_20_2.up))} mid=${safe(last(ta.bb_20_2.mid))} lo=${safe(last(ta.bb_20_2.lo))}`);
  }

  if (ctx.orch) {
    lines.push("ORCH:");
    lines.push(`  rawScore=${safe(ctx.orch.rawScore, 3)}  prob=${pct(ctx.orch.probability, 1)}  direction=${ctx.orch.direction || "—"}  participating=${ctx.orch.participating ?? "—"}`);
    if (Array.isArray(ctx.orch.signals)) {
      const top = ctx.orch.signals
        .slice()
        .sort((a, b) => Math.abs(b.signal * b.confidence) - Math.abs(a.signal * a.confidence))
        .slice(0, 4)
        .map((s) => `${s.moduleId || s.id}=${safe(s.signal,2)}@${safe(s.confidence,2)}`);
      if (top.length) lines.push(`  top4: ${top.join(", ")}`);
    }
  }

  if (ctx.ghost && Array.isArray(ctx.ghost.bars) && ctx.ghost.bars.length) {
    const last = ctx.ghost.bars[ctx.ghost.bars.length - 1];
    lines.push("GHOST:");
    lines.push(`  bars=${ctx.ghost.bars.length}  direction=${ctx.ghost.direction}  bias=${safe(ctx.ghost.bias, 2)}  conformal=${ctx.ghost.usedConformal ? "yes" : "ATR√h"}`);
    lines.push(`  finalClose=${safe(last.c)}  band=[${safe(last.lo)},${safe(last.hi)}]  width=${safe(last.width)}`);
    if (Number.isFinite(ctx.ghost.firstBarBoost) && ctx.ghost.firstBarBoost !== 1) {
      lines.push(`  pattern boost = ×${safe(ctx.ghost.firstBarBoost, 2)}`);
    }
  }

  if (ctx.regime?.label) {
    lines.push(`REGIME: ${ctx.regime.label}  trend=${ctx.regime.trend}  strength=${ctx.regime.strength}  vol=${ctx.regime.volatility}`);
  }
  if (ctx.wyckoff?.phase) {
    lines.push(`WYCKOFF: phase=${ctx.wyckoff.phase}  bias=${ctx.wyckoff.bias}  bull%=${safe(ctx.wyckoff.bullPct, 0)}`);
  }
  if (ctx.macro?.label) {
    lines.push(`MACRO: ${ctx.macro.label}  score=${safe(ctx.macro.score, 2)}`);
  }
  if (ctx.deriv?.symbol) {
    const d = ctx.deriv;
    const fund = d.premiumIndex?.lastFundingRate;
    lines.push(`DERIV (${d.symbol}): funding=${pct(fund, 4)}  mark=${safe(d.premiumIndex?.markPrice)}  index=${safe(d.premiumIndex?.indexPrice)}`);
  }
  if (ctx.stability?.score != null) {
    lines.push(`STABILITY: ${ctx.stability.label} ${(ctx.stability.score*100).toFixed(0)}%  σ(bias)=${safe(ctx.stability.biasSigma, 3)}  flip%=${pct(ctx.stability.flipRate, 0)}`);
  }
  if (Array.isArray(ctx.news) && ctx.news.length) {
    lines.push("NEWS (recent, top 5):");
    for (const it of ctx.news.slice(0, 5)) {
      const sentLab = it.sentiment?.label || "?";
      const cat     = it.classification?.primary || "?";
      const imp     = it.classification?.impact;
      lines.push(`  [${cat}/${sentLab}${Number.isFinite(imp) ? "/"+(imp*100).toFixed(0)+"%":""}] ${(it.title || "").slice(0, 110)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build full prompt = system block + context block + user question.
 *
 * @returns {{ system:string, prompt:string, context:string }}
 */
export function buildPrompt({ ctx = {}, question = "What's your read on the next 25 bars?", systemPrompt = null } = {}) {
  const context = buildContext(ctx);
  const system  = systemPrompt || SYSTEM_PROMPT_DEFAULT;
  const prompt  = `=== LIVE CONTEXT ===\n${context || "(no live context yet)"}\n\n=== QUESTION ===\n${question}\n`;
  return { system, prompt, context };
}

/** Convert a single user prompt into a messages[] array for /api/chat. */
export function buildMessages({ ctx, question, history = [] }) {
  const { system, prompt } = buildPrompt({ ctx, question });
  // Rolling window of prior turns (excludes the system message).
  const turns = Array.isArray(history) ? history.slice(-6) : [];
  return {
    system,
    messages: [
      ...turns,
      { role: "user", content: prompt },
    ],
  };
}

export const SYSTEM_PROMPT = SYSTEM_PROMPT_DEFAULT;

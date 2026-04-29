/**
 * My Next Prediction v3.0 — M-LEARN-4 · Meta-Brain (decision layer)
 * -----------------------------------------------------------------
 * Replaces the orchestrator as the *final* decision-maker.  The
 * orchestrator stops being "the brain" and becomes one of many
 * inputs to the brain.
 *
 *   aggregate(ctx)             → 80-dim Float32 input vector
 *   decide(input, opts)        → { direction, probability, confidence,
 *                                  rawScore, used: "meta-nn"|"orch-fallback",
 *                                  reason }
 *   pairForTraining(predId, ctx) / labelForTraining(predId, realizedDir)
 *   maybeTrain({minRows, force}) → trains offline NN, persists weights
 *
 * Storage: reuses Phase 8 `models` IDB store with regime="meta-brain".
 * Reuses Phase 8 `trainingPool` store for (input, label) pairs keyed
 * by predictionId.
 *
 * Pure where possible.  IDB-backed for persistence + paired training
 * data.  No DOM.
 */

import { put, withStore, req2promise, count as idbCount } from "../data/idb.js";
import { MLP, paramCount } from "../ml/nn.js";
import * as ModelStore from "../ml/modelStore.js";
import { EventBus } from "../core/bus.js";

const POOL_STORE   = "metaBrainPool";
const MODEL_REGIME = "meta-brain";
const MIN_TRAIN_ROWS = 200;
const MAX_POOL_ROWS  = 5000;

/* ═══════════════════════════ Aggregator ═══════════════════════════ */

/**
 * Build a fixed-size Float32 vector from the live runtime surface.
 * Layout (80 dims):
 *
 *   0..29   : 15 modules × (signal, confidence)              — 30 dims
 *   30..36  : ghost params (direction, bias, |conf|, width0,
 *             width-final, bandPct, firstBarBoost)            — 7 dims
 *   37..43  : regime one-hot (trend-up, trend-down, range,
 *             strong, moderate, weak, vol-high)               — 7 dims
 *   44..47  : wyckoff one-hot (markup, markdown, accum, dist) — 4 dims
 *   48..49  : macro (score, isRiskOn)                         — 2 dims
 *   50..53  : derivs (funding, OI Δ24h, L/S, basis)           — 4 dims
 *   54..56  : stability (score, biasSigma, flipRate)          — 3 dims
 *   57..60  : adaptive weights summary (mean, std, max-w-mod) — 4 dims
 *   61..62  : anti-pattern match (inRadius, hitRate)          — 2 dims
 *   63..76  : last-bar OHLC-derived (ret_1, ret_5, log_range,
 *             body_frac, atr_pct, rsi/50, macd_hist_rel,
 *             bb_pos, bb_width_rel, adx/100, plusDIminusDI,
 *             vol_rel, fvg_open_rel, ob_open_rel)             — 14 dims
 *   77..79  : meta (hour-of-day, day-of-week, recent error mag) — 3 dims
 *
 * Total = 80 dims.  All values normalized to roughly [-1, +1] or [0, 1].
 *
 * @param {object} ctx
 * @returns {Float32Array}
 */
export function aggregate(ctx = {}) {
  const out = new Float32Array(80);
  const safe = (v, fb = 0) => Number.isFinite(v) ? +v : fb;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // 0..29 — 15 modules × 2.  Order is determined by ctx.orch.signals.
  // We iterate in order; if fewer than 15 modules, the rest stay 0.
  const sigs = Array.isArray(ctx?.orch?.signals) ? ctx.orch.signals : [];
  for (let i = 0; i < Math.min(15, sigs.length); i++) {
    out[i * 2]     = clamp(safe(sigs[i].signal),     -1, 1);
    out[i * 2 + 1] = clamp(safe(sigs[i].confidence), 0, 1);
  }

  // 30..36 — ghost params
  if (ctx?.ghost) {
    out[30] = clamp(safe(ctx.ghost.direction), -1, 1);
    out[31] = clamp(safe(ctx.ghost.bias),       -1, 1);
    out[32] = clamp(safe(ctx.ghost.confidence),  0, 1);
    if (Array.isArray(ctx.ghost.bars) && ctx.ghost.bars.length) {
      const b0 = ctx.ghost.bars[0];
      const bL = ctx.ghost.bars[ctx.ghost.bars.length - 1];
      out[33] = clamp(safe(b0?.width) / Math.max(1e-9, safe(ctx.ghost.atr) || 1), 0, 10);
      out[34] = clamp(safe(bL?.width) / Math.max(1e-9, safe(ctx.ghost.atr) || 1), 0, 10);
      out[35] = clamp((safe(bL?.hi) - safe(bL?.lo)) / Math.max(1e-9, safe(bL?.c) || 1), 0, 1);
    }
    out[36] = clamp(safe(ctx.ghost.firstBarBoost, 1), 0, 2) - 1;
  }

  // 37..43 — regime one-hot
  const r = ctx?.regime || ctx?.ta?.regime;
  if (r) {
    if (r.trend === "up")     out[37] = 1;
    if (r.trend === "down")   out[38] = 1;
    if (r.trend === "range")  out[39] = 1;
    if (r.strength === "strong")   out[40] = 1;
    if (r.strength === "moderate") out[41] = 1;
    if (r.strength === "weak")     out[42] = 1;
    if (r.volatility === "high")   out[43] = 1;
  }

  // 44..47 — Wyckoff one-hot
  const w = ctx?.wyckoff || ctx?.ta?.wyckoff;
  if (w?.phase) {
    if (w.phase === "markup")        out[44] = 1;
    if (w.phase === "markdown")      out[45] = 1;
    if (w.phase === "accumulation")  out[46] = 1;
    if (w.phase === "distribution")  out[47] = 1;
  }

  // 48..49 — macro
  if (ctx?.macro) {
    out[48] = clamp(safe(ctx.macro.score), -1, 1);
    out[49] = ctx.macro.label === "risk-on" ? 1 : ctx.macro.label === "risk-off" ? -1 : 0;
  }

  // 50..53 — derivs
  if (ctx?.deriv) {
    out[50] = clamp(safe(ctx.deriv.premiumIndex?.lastFundingRate) * 100, -1, 1); // funding%
    if (Array.isArray(ctx.deriv.oiHist) && ctx.deriv.oiHist.length >= 24) {
      const cur = ctx.deriv.oiHist[ctx.deriv.oiHist.length - 1]?.openInterestUSD;
      const old = ctx.deriv.oiHist[ctx.deriv.oiHist.length - 24]?.openInterestUSD;
      if (Number.isFinite(cur) && Number.isFinite(old) && old > 0) {
        out[51] = clamp((cur - old) / old, -1, 1);
      }
    }
    const lsLast = (ctx.deriv.lsHist || []).at?.(-1);
    if (lsLast?.longShortRatio) {
      // Squash via tanh of (ratio - 1)
      out[52] = Math.tanh(lsLast.longShortRatio - 1);
    }
    if (Number.isFinite(ctx.deriv.premiumIndex?.markPrice) && Number.isFinite(ctx.deriv.premiumIndex?.indexPrice)) {
      const basis = (ctx.deriv.premiumIndex.markPrice - ctx.deriv.premiumIndex.indexPrice) / Math.max(1e-9, ctx.deriv.premiumIndex.indexPrice);
      out[53] = clamp(basis * 100, -1, 1);
    }
  }

  // 54..56 — stability
  if (ctx?.stability) {
    out[54] = clamp(safe(ctx.stability.score), 0, 1);
    out[55] = clamp(safe(ctx.stability.biasSigma), 0, 1);
    out[56] = clamp(safe(ctx.stability.flipRate), 0, 1);
  }

  // 57..60 — adaptive weights summary (signal-confidence weighted by EMA)
  if (ctx?.adaptive?.emaSnapshot) {
    const ema = ctx.adaptive.emaSnapshot();
    const vals = Object.values(ema).filter(Number.isFinite);
    if (vals.length) {
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      let s2 = 0;
      for (const v of vals) s2 += (v - m) * (v - m);
      const std = Math.sqrt(s2 / vals.length);
      out[57] = clamp(m, 0, 1);
      out[58] = clamp(std, 0, 1);
      out[59] = clamp(Math.max(...vals), 0, 1);
      out[60] = clamp(Math.min(...vals), 0, 1);
    }
  }

  // 61..62 — anti-pattern match
  if (ctx?.antiPatternMatch) {
    out[61] = ctx.antiPatternMatch.inRadius ? 1 : 0;
    out[62] = clamp(safe(ctx.antiPatternMatch.antiPattern?.hitRate, 0.5), 0, 1);
  } else {
    out[62] = 0.5;   // neutral hitRate prior
  }

  // 63..76 — last-bar derived
  const ta = ctx?.ta;
  if (ta && Array.isArray(ta.close)) {
    const i = ta.close.length - 1;
    const c = +ta.close[i], o = +ta.open?.[i], h = +ta.high?.[i], l = +ta.low?.[i];
    if (Number.isFinite(c) && Number.isFinite(o) && Number.isFinite(h) && Number.isFinite(l) && c > 0) {
      const ret1 = i >= 1 && ta.close[i-1] > 0 ? (c - ta.close[i-1]) / ta.close[i-1] : 0;
      const ret5 = i >= 5 && ta.close[i-5] > 0 ? (c - ta.close[i-5]) / ta.close[i-5] : 0;
      out[63] = clamp(ret1 * 50, -1, 1);
      out[64] = clamp(ret5 * 50, -1, 1);
      out[65] = clamp(Math.log(Math.max(1e-9, (h - l) / c)), -10, 0) / 10;
      out[66] = h !== l ? clamp((c - o) / (h - l), -1, 1) : 0;
      const atr = Array.isArray(ta.atr14) ? ta.atr14[i] : null;
      out[67] = Number.isFinite(atr) && c > 0 ? clamp(atr / c, 0, 0.1) * 10 : 0;
      const rsi = Array.isArray(ta.rsi14) ? ta.rsi14[i] : null;
      out[68] = Number.isFinite(rsi) ? (rsi - 50) / 50 : 0;
      const macdH = ta.macd_12_26_9?.hist?.[i];
      out[69] = Number.isFinite(macdH) && c > 0 ? clamp(macdH / c * 1000, -1, 1) : 0;
      const bb = ta.bb_20_2;
      if (bb) {
        const mid = bb.mid?.[i], up = bb.up?.[i], lo = bb.lo?.[i];
        if (Number.isFinite(mid) && Number.isFinite(up) && Number.isFinite(lo)) {
          const half = up - mid;
          out[70] = half !== 0 ? clamp((c - mid) / half, -3, 3) / 3 : 0;
          out[71] = mid !== 0 ? clamp((up - lo) / mid, 0, 0.2) * 5 : 0;
        }
      }
      const adx = ta.adx14?.adx?.[i];
      out[72] = Number.isFinite(adx) ? clamp(adx / 100, 0, 1) : 0;
      const plus = ta.adx14?.plusDI?.[i], minus = ta.adx14?.minusDI?.[i];
      out[73] = Number.isFinite(plus) && Number.isFinite(minus) ? clamp((plus - minus) / 100, -1, 1) : 0;
      const v = +ta.volume?.[i];
      const volAvg = ta.volume ? (() => { let s = 0, n = 0; for (let k = Math.max(0, i - 19); k <= i; k++) { const x = +ta.volume[k]; if (Number.isFinite(x)) { s += x; n++; } } return n > 0 ? s/n : 0; })() : 0;
      out[74] = volAvg > 0 ? clamp(v / volAvg - 1, -1, 4) / 4 : 0;
      const fvgOpen = Array.isArray(ta.fvg?.open) ? ta.fvg.open.length : 0;
      out[75] = clamp(fvgOpen / 10, 0, 1);
      const obOpen = Array.isArray(ta.orderBlocks) ? ta.orderBlocks.filter((b) => !b.mitigated).length : 0;
      out[76] = clamp(obOpen / 10, 0, 1);
    }
  }

  // 77..79 — meta
  const dt = new Date(ctx?.t || Date.now());
  out[77] = (dt.getUTCHours() / 24) * 2 - 1;
  out[78] = (dt.getUTCDay() / 6) * 2 - 1;
  out[79] = clamp(safe(ctx?.recentErrorMag, 0), 0, 5) / 5;

  return out;
}

/* ═══════════════════════════ Decide ═══════════════════════════ */

let _modelCache = null;       // { mlp, version, trainedAt, accuracy }
let _modelLoadInflight = null;

async function loadModelOnce() {
  if (_modelCache) return _modelCache;
  if (_modelLoadInflight) return _modelLoadInflight;
  _modelLoadInflight = (async () => {
    try {
      // Prefer the explicit champion (M-LEARN-5).  Fall back to most-recent
      // model row if no champion is tagged (back-compat with M-LEARN-4 IDB).
      const all = await ModelStore.listModels({ regime: MODEL_REGIME });
      if (!all.length) return null;
      const champs = all.filter((r) => !r.meta?.role || r.meta.role === "champion");
      const pool = champs.length ? champs : all;
      pool.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const row = pool[0];
      const w = row?.weights || row?.payload;
      if (!row || !w) return null;
      const mlp = MLP.deserialize(w);
      const m = row.meta || row.metrics || {};
      _modelCache = {
        mlp,
        version: row.version || "?",
        trainedAt: row.createdAt || row.trainedAt || 0,
        accuracy: m.accuracy ?? null,
        rows: m.rows ?? null,
      };
      return _modelCache;
    } catch { return null; }
    finally { _modelLoadInflight = null; }
  })();
  return _modelLoadInflight;
}

/** Force a reload from IDB (used after training). */
export function invalidateModelCache() { _modelCache = null; }

/**
 * Run the meta-brain on an aggregate input.  Falls back to the
 * orchestrator's raw score when no trained model exists yet.
 *
 * @param {Float32Array|number[]} input
 * @param {{orchFallback?:object}} [opts]
 * @returns {Promise<{
 *   direction: "long"|"short"|"neutral",
 *   probability: number,
 *   confidence: number,
 *   rawScore: number,
 *   used: "meta-nn"|"orch-fallback"|"none",
 *   modelVersion?: string,
 * }>}
 */
export async function decide(input, { orchFallback } = {}) {
  if (!input || (input.length || 0) === 0) {
    return decideFromOrch(orchFallback, "none");
  }
  const cache = await loadModelOnce();
  if (!cache) return decideFromOrch(orchFallback, "orch-fallback");

  // MLP forward.  Output: scalar in [-1, +1] (rawScore) — convert to direction + prob.
  const x = input instanceof Float32Array ? input : Float32Array.from(input);
  let y;
  try { y = cache.mlp.predict(x); }
  catch { return decideFromOrch(orchFallback, "orch-fallback"); }
  const raw = Array.isArray(y) ? y[0] : (typeof y === "number" ? y : 0);
  const score = Math.max(-1, Math.min(1, +raw || 0));
  const prob = 0.5 + 0.5 * score;
  const direction = score >  0.05 ? "long"
                  : score < -0.05 ? "short"
                  : "neutral";
  return {
    direction,
    probability: prob,
    confidence:  Math.abs(score),
    rawScore:    score,
    used:        "meta-nn",
    modelVersion: cache.version,
  };
}

function decideFromOrch(orch, used) {
  if (!orch) return { direction: "neutral", probability: 0.5, confidence: 0, rawScore: 0, used: "none" };
  return {
    direction:   orch.direction || "neutral",
    probability: Number.isFinite(orch.probability) ? orch.probability : 0.5,
    confidence:  Number.isFinite(orch.confidence)  ? orch.confidence  : Math.abs(orch.rawScore || 0),
    rawScore:    Number.isFinite(orch.rawScore)    ? orch.rawScore    : 0,
    used,
  };
}

/* ═══════════════════════════ Training pool ═══════════════════════════ */

/**
 * Snapshot the aggregate vector at predict-time.  Stored in trainingPool
 * keyed by predictionId so the verdict-side pairing can find it.
 *
 * @param {number|string} predictionId
 * @param {object} ctx context for `aggregate()`
 */
export async function pairForTraining(predictionId, ctx) {
  if (predictionId == null) return null;
  const vec = aggregate(ctx);
  const row = {
    id:           `mb-${predictionId}`,
    kind:         "meta-brain",
    predictionId,
    symbol:       ctx?.symbol || null,
    tf:           ctx?.tf || null,
    t:            ctx?.t || Date.now(),
    input:        Array.from(vec),
    label:        null,         // set later by labelForTraining
    pending:      true,
    createdAt:    Date.now(),
  };
  try { await put(POOL_STORE, row); } catch { return null; }
  return row.id;
}

/**
 * Pair the realized label.  `realizedDir` ∈ {"up","down","flat"}.
 * Returns true if the row was found + labeled.
 */
export async function labelForTraining(predictionId, realizedDir) {
  if (predictionId == null) return false;
  const id = `mb-${predictionId}`;
  return withStore(POOL_STORE, "readwrite", async (s) => {
    const row = await req2promise(s.get(id));
    if (!row || !row.pending) return false;
    row.label = realizedDir === "up"   ?  1
              : realizedDir === "down" ? -1
              : 0;
    row.pending = false;
    row.labeledAt = Date.now();
    await req2promise(s.put(row));
    return true;
  });
}

/** Count labeled rows ready for training. */
export async function readyCount() {
  return withStore(POOL_STORE, "readonly", async (s) => {
    const rows = await req2promise(s.getAll());
    return rows.filter((r) => r.pending === false).length;
  });
}

/* ═══════════════════════════ Train ═══════════════════════════ */

/**
 * Train (or retrain) the Meta-NN on labeled rows from the training pool.
 *
 * @param {{minRows?:number, force?:boolean}} [opts]
 * @returns {Promise<{trained:boolean, rows:number, accuracy:number, version:string}>}
 */
export async function maybeTrain({ minRows = MIN_TRAIN_ROWS, force = false, role = "champion", returnModel = false } = {}) {
  const labeled = await loadLabeledRows();
  if (!force && labeled.length < minRows) return { trained: false, rows: labeled.length };

  // Build matrices.
  const D = labeled[0].input.length;
  const X = new Float32Array(labeled.length * D);
  const Y = new Float32Array(labeled.length);
  for (let i = 0; i < labeled.length; i++) {
    for (let j = 0; j < D; j++) X[i * D + j] = +labeled[i].input[j] || 0;
    Y[i] = +labeled[i].label || 0;     // signed in {-1, 0, +1}
  }

  // D → 32 → 16 → 1 with tanh output (regression in [-1,+1]).
  const mlp = new MLP({
    layers: [
      { in: D, out: 32, act: "relu" },
      { in: 32, out: 16, act: "relu" },
      { in: 16, out: 1,  act: "tanh" },
    ],
    loss: "mse",
    optimizer: "adam",
    lr: 0.005,
    l2: 1e-5,
    seed: 42,
  });

  // 20 % validation split — internal to mlp.fit
  const { history, valHistory } = mlp.fit(X, Y, {
    epochs: 30,
    batchSize: 32,
    valFrac: 0.2,
  });
  const lastLoss = valHistory && valHistory.length ? valHistory[valHistory.length - 1] : NaN;

  // Compute sign-agreement accuracy on the held-out slice (last 20 %).
  const split = Math.floor(labeled.length * 0.8);
  let correct = 0, evaluable = 0;
  for (let i = split; i < labeled.length; i++) {
    const xi = X.slice(i * D, (i + 1) * D);
    const py = mlp.predict(xi);
    const pred = py[0];
    const lbl  = Y[i];
    if (Math.abs(lbl) < 1e-6) continue;
    evaluable++;
    if ((pred > 0 && lbl > 0) || (pred < 0 && lbl < 0)) correct++;
  }
  const accuracy = evaluable > 0 ? correct / evaluable : 0;

  const version = `mb-${Date.now()}`;
  const meta = {
    accuracy: +accuracy.toFixed(4),
    rows: labeled.length,
    valRows: Math.floor(labeled.length * 0.2),
    params: paramCount(mlp),
    lastLoss: Number.isFinite(lastLoss) ? +lastLoss.toFixed(6) : null,
    role,
  };
  const id = await ModelStore.saveModel({
    kind: "mlp",
    regime: MODEL_REGIME,
    version,
    weights: mlp.serialize(),
    meta,
    createdAt: Date.now(),
  });
  if (role === "champion") invalidateModelCache();
  try { EventBus.emit("metabrain:trained", { rows: labeled.length, accuracy, version, role }); } catch {}
  const result = { trained: true, rows: labeled.length, accuracy, version, role, id };
  if (returnModel) {
    // For champion/challenger evaluation we also need the held-out X/Y slice
    // and the model itself so we don't have to deserialize twice.
    const D = labeled[0].input.length;
    const split = Math.floor(labeled.length * 0.8);
    const evalN = labeled.length - split;
    const evalX = new Float32Array(evalN * D);
    const evalY = new Float32Array(evalN);
    for (let i = 0; i < evalN; i++) {
      const src = labeled[split + i];
      for (let j = 0; j < D; j++) evalX[i * D + j] = +src.input[j] || 0;
      evalY[i] = +src.label || 0;
    }
    result.mlp = mlp;
    result.evalX = evalX;
    result.evalY = evalY;
    result.evalN = evalN;
    result.D = D;
  }
  return result;
}

/* ═══════════════════════════ Champion lookup ═══════════════════════════ */

/** Find the current champion model row (role==="champion" or no role for legacy). */
export async function findChampion() {
  const all = await ModelStore.listModels({ regime: MODEL_REGIME });
  const eligible = all.filter((r) => !r.meta?.role || r.meta.role === "champion");
  if (!eligible.length) return null;
  eligible.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return eligible[0];
}

/** Find the most recent challenger awaiting evaluation. */
export async function findChallenger() {
  const all = await ModelStore.listModels({ regime: MODEL_REGIME });
  const ch = all.filter((r) => r.meta?.role === "challenger");
  if (!ch.length) return null;
  ch.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return ch[0];
}

/** Set a model row's role + invalidate cache so the next decide() re-loads. */
export async function setRole(id, role) {
  const row = await ModelStore.loadModel(id);
  if (!row) return false;
  row.meta = { ...(row.meta || {}), role };
  await ModelStore.saveModel(row);
  invalidateModelCache();
  return true;
}

async function loadLabeledRows() {
  return withStore(POOL_STORE, "readonly", async (s) => {
    const rows = await req2promise(s.getAll());
    const out = [];
    for (const r of rows) {
      if (r.pending) continue;
      if (!Array.isArray(r.input)) continue;
      out.push(r);
    }
    // Cap pool size.
    if (out.length > MAX_POOL_ROWS) {
      out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return out.slice(0, MAX_POOL_ROWS);
    }
    return out;
  });
}

/** Diagnostics for the BrainCard. */
export async function status() {
  const cache = await loadModelOnce();
  const pending = await withStore(POOL_STORE, "readonly", async (s) => {
    const rows = await req2promise(s.getAll());
    return rows.filter((r) => r.pending).length;
  });
  const ready = await readyCount();
  return {
    hasModel:   !!cache,
    version:    cache?.version || null,
    accuracy:   cache?.accuracy ?? null,
    trainedAt:  cache?.trainedAt || null,
    rowsTrained: cache?.rows ?? null,
    pending,
    ready,
  };
}

/** For tests — wipe pool + cached model. */
export async function _resetForTests() {
  await withStore(POOL_STORE, "readwrite", async (s) => req2promise(s.clear()));
  invalidateModelCache();
}

export const _internals = { aggregate, loadLabeledRows, MIN_TRAIN_ROWS };

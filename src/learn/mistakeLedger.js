/**
 * My Next Prediction v3.0 — M-LEARN-1 · Mistake Ledger
 * ----------------------------------------------------
 * Persistent record of every wrong prediction, with the full feature
 * snapshot at predict-time.  Downstream consumers:
 *
 *   - Pattern Discovery (M-LEARN-2) clusters mistake feature vectors
 *     to surface anti-patterns (cluster of features where the model
 *     reliably gets it wrong).
 *   - Online Learner (M-LEARN-4) replays mistakes during retrain so
 *     the new model is explicitly punished for the old failures.
 *   - UI surfaces (MistakeLedgerCard, AntiPatternCard, AI Chat) read
 *     this store to explain "why was the last call wrong".
 *
 * Wires to the EventBus:
 *
 *   listen:  validation:verdict
 *   emit:    mistake:recorded   { mistake }
 *
 * The store stays append-only — a mistake is *never* deleted on
 * retrain.  We want long history specifically so the model can be
 * tested against "is the new champion still failing on the same
 * patterns the old champion failed on?"
 *
 * Pure-IDB module — no DOM.  Tests can use the in-memory IDB shim.
 */

import { EventBus } from "../core/bus.js";
import { put, withStore, req2promise, count as idbCount } from "../data/idb.js";

const STORE = "mistakes";

/* ═══════════════════════════ Types ═══════════════════════════ */

/**
 * @typedef {Object} Mistake
 * @property {number}  id              auto-increment
 * @property {number}  predictionId    FK → predictions.id
 * @property {string}  symbol
 * @property {string}  tf
 * @property {number}  t               timestamp this prediction was for (ms)
 * @property {string}  kind            "direction" | "interval" | "set" | "return"
 * @property {string}  errorType       "direction" | "magnitude" | "interval-miss" | "set-miss"
 * @property {number}  errorMag        |predicted - realized|, normalized to ATR units when possible
 * @property {{
 *   direction:string,
 *   prob?:number,
 *   target?:number,
 *   rawScore?:number
 * }}                  predicted
 * @property {{
 *   direction:string,
 *   magnitude?:number,
 *   close?:number
 * }}                  realized
 * @property {{
 *   featureVec?:number[],
 *   regime?:string,
 *   wyckoff?:string,
 *   macro?:string,
 *   topModules?:Array<{moduleId:string, signal:number, confidence:number}>,
 *   atr?:number,
 * }}                  context
 * @property {number}  createdAt       ms
 */

/* ═══════════════════════════ Recording ═══════════════════════════ */

/**
 * Compute the error-type and a normalized magnitude from a verdict.
 *
 * @param {object} prediction prediction store row
 * @param {object} verdict    validator output
 * @param {{atr?:number}} [hint]
 * @returns {null | {errorType:string, errorMag:number}}
 */
export function classifyError(prediction, verdict, hint = {}) {
  if (!prediction || !verdict) return null;
  const k = verdict.kind || prediction.kind;
  // Abstain → never count as a mistake.  By design.
  if (verdict.abstain) return null;
  switch (k) {
    case "direction": {
      // hit=false means we picked the wrong side (long when market went short).
      // Validator emits the realized magnitude as `realized` (return), not
      // `realizedReturn`.  Older tests / external callers may pass
      // `realizedReturn` for convenience — accept both.
      if (verdict.hit === false) {
        const realizedRet = +(verdict.realized ?? verdict.realizedReturn);
        const errorMag = Number.isFinite(realizedRet)
          ? (Number.isFinite(hint.atr) && hint.atr > 0
              ? Math.abs(realizedRet) * (prediction.payload?.refPrice || 1) / hint.atr
              : Math.abs(realizedRet))
          : 1.0;
        return { errorType: "direction", errorMag };
      }
      return null;
    }
    case "interval": {
      // covered=false means the realized close fell outside the predicted band.
      if (verdict.covered === false) {
        const cr = +verdict.centreResidual;
        return { errorType: "interval-miss", errorMag: Number.isFinite(cr) ? Math.abs(cr) : 1.0 };
      }
      return null;
    }
    case "return": {
      const ae = +verdict.absError;
      // Treat as a "magnitude" mistake whenever |error| > 1 ATR — a soft heuristic.
      if (Number.isFinite(ae) && ae > 0 && Number.isFinite(hint.atr) && hint.atr > 0 && ae > hint.atr) {
        return { errorType: "magnitude", errorMag: ae / hint.atr };
      }
      return null;
    }
    case "set": {
      // Validator's set verdict uses `covered` only when the user passed
      // a target class explicitly; absent that, treat empty/abstain as
      // a non-mistake.
      if (verdict.covered === false) return { errorType: "set-miss", errorMag: 1.0 };
      return null;
    }
    default:
      return null;
  }
}

/**
 * Build a Mistake row from a prediction + verdict + optional context.
 * Pure — no IDB.  Returns null if verdict is not actually a miss.
 */
export function buildMistake({ prediction, verdict, ta, orch, regime, wyckoff, macro }) {
  if (!prediction || !verdict) return null;
  const atrArr = ta?.atr14;
  const atr = Array.isArray(atrArr) ? atrArr[atrArr.length - 1] : (atrArr ?? null);
  const cls = classifyError(prediction, verdict, { atr });
  if (!cls) return null;

  // Capture top contributing modules at predict-time if we have orch.
  let topModules = null;
  if (orch?.signals && Array.isArray(orch.signals)) {
    topModules = orch.signals
      .slice()
      .sort((a, b) => Math.abs((b.signal || 0) * (b.confidence || 0)) - Math.abs((a.signal || 0) * (a.confidence || 0)))
      .slice(0, 4)
      .map((s) => ({
        moduleId:   s.moduleId || s.id,
        signal:     +(+s.signal     || 0).toFixed(3),
        confidence: +(+s.confidence || 0).toFixed(3),
      }));
  }

  return {
    predictionId: prediction.id,
    symbol:       prediction.symbol,
    tf:           prediction.tf,
    t:            prediction.t,
    kind:         prediction.kind || verdict.kind,
    errorType:    cls.errorType,
    errorMag:     +cls.errorMag.toFixed(4),
    predicted: {
      direction: prediction.payload?.direction || verdict.expectedDirection || "?",
      prob:      Number.isFinite(prediction.payload?.probability) ? prediction.payload.probability : null,
      target:    Number.isFinite(prediction.payload?.target)      ? prediction.payload.target      : null,
      rawScore:  Number.isFinite(prediction.payload?.rawScore)    ? prediction.payload.rawScore    : null,
    },
    realized: {
      // Validator field is `realizedDir` ("up" | "down" | "flat").
      // Fall back to inverting predicted direction when hit=false.
      direction: verdict.realizedDir || verdict.realizedDirection
              || (verdict.hit === false && prediction.payload?.direction
                  ? (prediction.payload.direction === "long" ? "short"
                    : prediction.payload.direction === "short" ? "long"
                    : "?")
                  : "?"),
      // Validator emits `realized` (the realized return); accept legacy
      // `realizedReturn` alias for callers that synthesise verdicts.
      magnitude: Number.isFinite(+(verdict.realized ?? verdict.realizedReturn))
                  ? +(verdict.realized ?? verdict.realizedReturn) : null,
      // Validator does not emit a realizedClose; accept it when the
      // caller provides one (test fixtures, future verdicts).
      close:     Number.isFinite(+verdict.realizedClose) ? +verdict.realizedClose : null,
    },
    context: {
      regime:      regime  || ta?.regime?.label || null,
      wyckoff:     wyckoff || ta?.wyckoff?.phase || null,
      macro:       macro?.label || null,
      atr:         Number.isFinite(atr) ? +atr : null,
      topModules,
      // Feature vector frozen at predict-time — large; only stored
      // when the caller passes it in (orch.featureVec or ta.lastFeatureVec).
      featureVec:  Array.isArray(orch?.featureVec) ? orch.featureVec.slice()
                  : Array.isArray(ta?.lastFeatureVec) ? ta.lastFeatureVec.slice()
                  : null,
    },
    createdAt: Date.now(),
  };
}

/**
 * Persist a Mistake row.  Returns the assigned id.
 */
export async function recordMistake(mistake) {
  if (!mistake || typeof mistake !== "object") throw new Error("recordMistake: object required");
  const id = await put(STORE, mistake);
  const stored = { ...mistake, id };
  try { EventBus.emit("mistake:recorded", { mistake: stored }); } catch {}
  return id;
}

/* ═══════════════════════════ Read API ═══════════════════════════ */

/** Total count. */
export async function count() { return idbCount(STORE); }

/** Most-recent N mistakes (newest first), optionally filtered. */
export async function recent({ limit = 50, symbol, tf, errorType, regime } = {}) {
  return withStore(STORE, "readonly", async (s) => {
    const rows = await req2promise(s.getAll());
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (symbol    && r.symbol  !== symbol)    continue;
      if (tf        && r.tf      !== tf)        continue;
      if (errorType && r.errorType !== errorType) continue;
      if (regime    && r.context?.regime !== regime) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  });
}

/**
 * Aggregate mistake stats for a sidebar card.
 *
 * @returns {Promise<{
 *   total:number, byErrorType:Record<string,number>,
 *   byRegime:Record<string,number>, lastT:number|null,
 * }>}
 */
export async function summary() {
  return withStore(STORE, "readonly", async (s) => {
    const rows = await req2promise(s.getAll());
    const out = { total: rows.length, byErrorType: {}, byRegime: {}, lastT: null };
    for (const r of rows) {
      out.byErrorType[r.errorType] = (out.byErrorType[r.errorType] || 0) + 1;
      const rg = r.context?.regime || "unknown";
      out.byRegime[rg] = (out.byRegime[rg] || 0) + 1;
      if (!out.lastT || r.t > out.lastT) out.lastT = r.t;
    }
    return out;
  });
}

/** Wipe everything — for tests / Settings → forget-me. */
export async function clearAll() {
  return withStore(STORE, "readwrite", async (s) => req2promise(s.clear()));
}

/* ═══════════════════════════ Auto-recorder ═══════════════════════════ */

/**
 * Subscribe to validation:verdict events and auto-write mistakes.
 *
 * Caller passes a `getCtx()` resolver that returns the live runtime
 * surface ({ ta, orch, regime, wyckoff, macro }) — typically a closure
 * over the React app's hooks or the bootstrap exposes it.
 *
 *   const off = startAutoRecorder({ getCtx: () => ({ ta, orch, ... }) });
 *
 * Returns an off() function.
 */
export function startAutoRecorder({ getCtx, store } = {}) {
  if (typeof getCtx !== "function") {
    throw new Error("startAutoRecorder: getCtx() resolver required");
  }
  const off = EventBus.on("validation:verdict", async (e) => {
    try {
      const prediction = e?.prediction;
      const verdict    = e?.verdict;
      if (!prediction || !verdict) return;
      const ctx = getCtx() || {};
      const m = buildMistake({
        prediction, verdict,
        ta:      ctx.ta,
        orch:    ctx.orch,
        regime:  ctx.regime,
        wyckoff: ctx.wyckoff,
        macro:   ctx.macro,
      });
      if (m) await recordMistake(m);
    } catch (err) {
      try { EventBus.emit("mistake:error", { error: err?.message || String(err) }); } catch {}
    }
  });
  return off;
}

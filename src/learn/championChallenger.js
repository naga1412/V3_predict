/**
 * My Next Prediction v3.0 — M-LEARN-5 · Champion / Challenger
 * -----------------------------------------------------------
 * Online retrainer that protects the active model (champion) by
 * training a candidate (challenger) on the same data, evaluating it
 * head-to-head on a held-out tail, and only promoting the challenger
 * if it beats the champion by a margin.
 *
 * Also tracks rolling accuracy on live verdicts and rolls the champion
 * back to the previous one when drift exceeds a threshold.
 *
 * Public surface:
 *   runCycle({ minRows, evalMargin })        full train+eval+promote
 *   evaluatePair({ champion, challenger })   head-to-head on tail
 *   recentCycles({ limit })                  last N cycle records
 *   onVerdict(verdict, prediction)           rolling-accuracy hook
 *   driftCheck()                             returns {drifted, ewma, baseline}
 *   recoverIfDrifted()                       attempts auto-rollback
 *
 * Bus events:
 *   metabrain:cycle      {kind: 'promoted'|'rejected'|'no-train', ...}
 *   metabrain:rollback   {to, reason}
 */

import { EventBus } from "../core/bus.js";
import * as MetaBrain  from "./metaBrain.js";
import * as ModelStore from "../ml/modelStore.js";
import { MLP } from "../ml/nn.js";

const MODEL_REGIME = "meta-brain";

const DEFAULT_EVAL_MARGIN = 0.01;     // challenger must beat champ by ≥ 1pp acc
const DEFAULT_MIN_ROWS    = 200;
const ROLLING_WINDOW      = 50;       // recent verdicts considered for drift
const DRIFT_DROP_THRESHOLD = 0.10;    // 10pp drop triggers rollback

const _state = {
  cycles:    [],           // ring of last cycle records
  rolling:   [],           // recent verdicts {pred, real, t}
  baseline:  null,         // champion's accuracy at promotion time
};

const MAX_CYCLES = 20;

/* ════════════════════════ Cycle ════════════════════════ */

/**
 * Run one full retrain cycle.
 *
 *   1. Train a challenger on the labeled pool.
 *   2. Load the current champion (if any).
 *   3. Evaluate both on the same held-out tail.
 *   4. Promote the challenger iff its accuracy ≥ champ + evalMargin.
 *   5. Otherwise discard the challenger.
 */
export async function runCycle({
  minRows    = DEFAULT_MIN_ROWS,
  evalMargin = DEFAULT_EVAL_MARGIN,
} = {}) {
  // Step 1 — train challenger
  const trained = await MetaBrain.maybeTrain({ minRows, role: "challenger", returnModel: true });
  if (!trained.trained) {
    const rec = { kind: "no-train", at: Date.now(), rows: trained.rows || 0 };
    pushCycle(rec);
    EventBus.emit("metabrain:cycle", rec);
    return rec;
  }

  const challenger = trained;          // {mlp, evalX, evalY, evalN, D, accuracy, version, id}
  const champRow   = await loadIncumbentChampion();

  // No incumbent — promote challenger immediately.
  if (!champRow) {
    await MetaBrain.setRole(challenger.id, "champion");
    const rec = {
      kind: "promoted", reason: "no-incumbent",
      at: Date.now(),
      champion: { version: challenger.version, accuracy: challenger.accuracy },
      challenger: null,
      retired: null,
    };
    _state.baseline = challenger.accuracy;
    _state.rolling.length = 0;
    pushCycle(rec);
    EventBus.emit("metabrain:cycle", rec);
    return rec;
  }

  // Step 3 — evaluate both on same tail
  const champMlp = MLP.deserialize(champRow.weights);
  const champAcc = signAccuracy(champMlp, challenger.evalX, challenger.evalY, challenger.evalN, challenger.D);
  const chalAcc  = signAccuracy(challenger.mlp, challenger.evalX, challenger.evalY, challenger.evalN, challenger.D);

  const verdict = chalAcc >= champAcc + evalMargin ? "promote" : "reject";

  if (verdict === "promote") {
    await MetaBrain.setRole(champRow.id, "retired");
    await MetaBrain.setRole(challenger.id, "champion");
    _state.baseline = chalAcc;
    _state.rolling.length = 0;
    const rec = {
      kind: "promoted", reason: `+${(chalAcc - champAcc).toFixed(3)}`,
      at: Date.now(),
      champion:   { version: challenger.version, accuracy: +chalAcc.toFixed(4) },
      challenger: { version: challenger.version, accuracy: +chalAcc.toFixed(4) },
      retired:    { version: champRow.version,   accuracy: +champAcc.toFixed(4) },
    };
    pushCycle(rec);
    EventBus.emit("metabrain:cycle", rec);
    return rec;
  } else {
    // Reject — drop the challenger row entirely.
    try { await ModelStore.deleteModel(challenger.id); } catch {}
    const rec = {
      kind: "rejected", reason: `${(chalAcc - champAcc).toFixed(3)}`,
      at: Date.now(),
      champion:   { version: champRow.version,   accuracy: +champAcc.toFixed(4) },
      challenger: { version: challenger.version, accuracy: +chalAcc.toFixed(4) },
      retired:    null,
    };
    pushCycle(rec);
    EventBus.emit("metabrain:cycle", rec);
    return rec;
  }
}

/** Compute sign-agreement accuracy on the held-out tail. */
function signAccuracy(mlp, X, Y, N, D) {
  let correct = 0, evaluable = 0;
  const xi = new Float32Array(D);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < D; j++) xi[j] = X[i * D + j];
    const py = mlp.predict(xi);
    const pred = py[0];
    const lbl  = Y[i];
    if (Math.abs(lbl) < 1e-6) continue;
    evaluable++;
    if ((pred > 0 && lbl > 0) || (pred < 0 && lbl < 0)) correct++;
  }
  return evaluable > 0 ? correct / evaluable : 0;
}

async function loadIncumbentChampion() {
  // findChampion includes legacy un-roled rows; same logic.
  return MetaBrain.findChampion();
}

/* ════════════════════════ Rolling drift ════════════════════════ */

/**
 * Record a live verdict.  Used by bootstrap.js to feed the drift
 * detector — call once per validation:verdict event.
 */
export function onVerdict(verdict, prediction) {
  if (!verdict || !prediction?.payload) return;
  const dir = prediction.payload.dir || prediction.payload.direction;
  const realDir = verdict.realizedDir
                || (verdict.hit === true && dir)
                || (verdict.hit === false && (dir === "up" ? "down" : dir === "down" ? "up" : null));
  if (!dir || !realDir) return;
  const correct = dir === realDir ? 1 : 0;
  _state.rolling.push({ correct, t: verdict.t || Date.now() });
  if (_state.rolling.length > ROLLING_WINDOW) _state.rolling.shift();
}

/**
 * Drift state given the rolling window vs the current champion's training acc.
 */
export function driftCheck() {
  if (_state.rolling.length < 20 || _state.baseline == null) {
    return { drifted: false, ewma: null, baseline: _state.baseline, n: _state.rolling.length };
  }
  // EWMA accuracy (alpha = 0.1)
  let ewma = _state.rolling[0].correct;
  for (let i = 1; i < _state.rolling.length; i++) {
    ewma = 0.9 * ewma + 0.1 * _state.rolling[i].correct;
  }
  return {
    drifted: ewma < _state.baseline - DRIFT_DROP_THRESHOLD,
    ewma:    +ewma.toFixed(4),
    baseline: _state.baseline,
    n: _state.rolling.length,
  };
}

/**
 * If drift is detected, roll the champion back to the most recent retired model.
 * Returns the rollback record or null.
 */
export async function recoverIfDrifted() {
  const d = driftCheck();
  if (!d.drifted) return null;
  // Find newest retired model; promote it back.
  const all = await ModelStore.listModels({ regime: MODEL_REGIME });
  const retired = all.filter((r) => r.meta?.role === "retired");
  if (!retired.length) return null;
  retired.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const target = retired[0];
  // Demote current champion to "rolled-back" (kept for forensics)
  const champ = await MetaBrain.findChampion();
  if (champ) await MetaBrain.setRole(champ.id, "rolled-back");
  await MetaBrain.setRole(target.id, "champion");
  _state.baseline = target.meta?.accuracy ?? null;
  _state.rolling.length = 0;
  const rec = {
    kind: "rollback", at: Date.now(),
    to: target.version, reason: `ewma ${d.ewma} < baseline-${DRIFT_DROP_THRESHOLD}`,
  };
  pushCycle(rec);
  EventBus.emit("metabrain:rollback", rec);
  return rec;
}

/* ════════════════════════ Status / history ════════════════════════ */

export function recentCycles({ limit = MAX_CYCLES } = {}) {
  return _state.cycles.slice(-limit).reverse();
}

export function status() {
  const drift = driftCheck();
  const last  = _state.cycles[_state.cycles.length - 1] || null;
  return {
    lastCycle: last,
    cycleCount: _state.cycles.length,
    drift,
  };
}

export async function _resetForTests() {
  _state.cycles.length = 0;
  _state.rolling.length = 0;
  _state.baseline = null;
}

function pushCycle(rec) {
  _state.cycles.push(rec);
  if (_state.cycles.length > MAX_CYCLES) _state.cycles.shift();
}

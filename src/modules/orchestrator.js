/**
 * My Next Prediction v3.0 — Module Orchestrator
 * ---------------------------------------------
 * Runs all registered modules against a TA snapshot, aggregates their
 * Signals into a single ensemble prediction, and returns a structured
 * result the UI/predictor can consume.
 *
 * Aggregation:
 *   rawScore  = Σ (module.signal × module.confidence × weight)  /  Σ (weight)
 *   calibrated = calibrator?.predict(rawScore) || sigmoid(rawScore * k)
 *
 * The session-calendar module exposes `payload.multiplier` that is applied
 * globally to other modules' confidences (off-hours dampening, event windows).
 */
import { MODULES } from "./registry.js";
import { clampSignal } from "./baseModule.js";

/**
 * @param {object} ta      TAEngine output
 * @param {object} [opts]
 * @param {object} [opts.weights]       per-id weight overrides { [id]: number }
 * @param {object} [opts.ctx]           extra context passed to each module
 * @param {object} [opts.calibrator]    { predict(score)->[0,1] }
 * @param {string[]} [opts.only]        restrict to these module ids
 * @param {string[]} [opts.exclude]     skip these module ids
 * @returns {{
 *   signals: Array,
 *   rawScore: number,         // ensemble score in [-1,+1]
 *   probability: number,      // calibrated P(up), in [0,1]
 *   direction: "long"|"short"|"neutral",
 *   confidence: number,       // avg of participating confidences
 *   reasonsByModule: object,
 *   bySignal: object,
 * }}
 */
export function runModules(ta, opts = {}) {
  const weights = opts.weights || {};
  const only = opts.only instanceof Set ? opts.only : (Array.isArray(opts.only) ? new Set(opts.only) : null);
  const exclude = opts.exclude instanceof Set ? opts.exclude : (Array.isArray(opts.exclude) ? new Set(opts.exclude) : null);

  // Pass 1 — evaluate every module.
  const signals = [];
  for (const mod of MODULES) {
    const id = mod.meta.id;
    if (only && !only.has(id)) continue;
    if (exclude && exclude.has(id)) continue;
    let sig;
    try {
      sig = clampSignal(mod.evaluate(ta, opts.ctx || {}));
    } catch (err) {
      sig = clampSignal({ signal: 0, confidence: 0, reasons: [`error: ${err.message}`] });
    }
    signals.push({ id, meta: { ...mod.meta }, ...sig });
  }

  // Session-calendar module exposes a global multiplier — apply to other
  // modules' effective confidence for aggregation.
  const sessSig = signals.find(s => s.id === "session-calendar");
  const globalMult = Number.isFinite(sessSig?.payload?.multiplier) ? sessSig.payload.multiplier : 1;

  // Pass 2 — aggregate.
  let weightedSum = 0;
  let weightTotal = 0;
  let confidenceSum = 0;
  let participating = 0;
  for (const s of signals) {
    const w = weights[s.id] ?? s.meta.weight ?? 1;
    const effConf = s.id === "session-calendar" ? s.confidence : Math.min(1, s.confidence * globalMult);
    // skip near-zero confidence rows from aggregation to reduce noise
    if (effConf < 0.05 && Math.abs(s.signal) < 0.1) continue;
    weightedSum += s.signal * effConf * w;
    weightTotal += w;
    confidenceSum += effConf;
    participating++;
  }
  const rawScore = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const avgConfidence = participating > 0 ? confidenceSum / participating : 0;

  const probability = opts.calibrator && typeof opts.calibrator.predict === "function"
    ? clamp01(opts.calibrator.predict(rawScore))
    : 1 / (1 + Math.exp(-rawScore * 3));   // soft default

  const direction = probability > 0.55 ? "long" : probability < 0.45 ? "short" : "neutral";

  const reasonsByModule = Object.fromEntries(signals.map(s => [s.id, s.reasons]));
  const bySignal = Object.fromEntries(signals.map(s => [s.id, {
    signal: s.signal, confidence: s.confidence, direction: s.direction,
  }]));

  return {
    signals,
    rawScore,
    probability,
    direction,
    confidence: avgConfidence,
    globalMult,
    participating,
    reasonsByModule,
    bySignal,
  };
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

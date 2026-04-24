/**
 * My Next Prediction v3.0 — Phase 10 · Validator (verdict computer)
 * -----------------------------------------------------------------
 * Given a pending prediction row and the realized OHLCV candle it referred
 * to, compute a structured verdict object.  Pure, no-DOM, no-IDB — the
 * orchestrator (monitor.js) wires this module to events and persistence.
 *
 * Supported prediction kinds (matches predictionStore.VALID_KINDS):
 *
 *   1. "direction"
 *        payload: { dir: "up"|"down"|"flat", prob?: number }
 *        verdict: { ok, realizedDir, hit, prob, brier, abstain, error? }
 *
 *   2. "return"
 *        payload: { yhat: number, sigma?: number, refPrice?: number }
 *        verdict: { ok, realized, residual, absError, zScore?, error? }
 *
 *   3. "interval"
 *        payload: { lo: number, hi: number, refPrice?: number }
 *        verdict: { ok, realized, covered, width, error? }
 *
 *   4. "set"           (from AdaptivePredictionSet)
 *        payload: { classes: ["up","down"]|["up"]|["down"]|[],
 *                   direction: "long"|"short"|"uncertain"|"abstain" }
 *        verdict: { ok, realizedDir, covered, setSize, abstain, error? }
 *
 * The candle is expected in MNP canonical shape:
 *   { o, h, l, c, v, t }   (numbers; `t` = open time ms of the realized candle)
 *
 * "Realized return" is computed relative to `payload.refPrice` when provided,
 * otherwise the candle's open (`o`).  This matches Phase 5 label conventions.
 *
 * Directional hit uses a configurable flat-band (default 0 → strict sign),
 * so callers can treat tiny sign flips as "flat" if desired.
 */

/* ───────────────────────── Timeframe utilities ───────────────────────── */

export const TF_MS = Object.freeze({
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "3d": 259_200_000,
  "1w": 604_800_000,
});

/** ms-duration for a timeframe string, or NaN if unknown. */
export function tfMs(tf) {
  return TF_MS[tf] ?? NaN;
}

/**
 * Open time of the NEXT candle after `lastT` on timeframe `tf`.
 * Returns NaN if tf is unknown.
 */
export function nextCandleOpen(lastT, tf) {
  const d = tfMs(tf);
  if (!Number.isFinite(d) || !Number.isFinite(lastT)) return NaN;
  return lastT + d;
}

/**
 * Time (ms since epoch) when the next-after-`lastT` candle CLOSES on `tf`.
 * The close is 1ms before the following open — but for validation purposes
 * we use next-open + grace so the exchange has serialized the close candle.
 *
 * @param {number} lastT  open-time ms of the last confirmed candle
 * @param {string} tf
 * @param {number} [graceMs=4000]  extra ms to wait for exchange book-keeping
 */
export function nextCloseAt(lastT, tf, graceMs = 4000) {
  const nextOpen = nextCandleOpen(lastT, tf);
  if (!Number.isFinite(nextOpen)) return NaN;
  const d = tfMs(tf);
  // Next candle closes at nextOpen + tfMs - 1 — add grace for safety.
  return nextOpen + d + Math.max(0, graceMs | 0);
}

/**
 * ms from `now` until the next-candle close for (lastT, tf).  Clamped to 0
 * for "already closed" cases.
 */
export function msUntilNextClose(lastT, tf, { now = Date.now(), graceMs = 4000 } = {}) {
  const ca = nextCloseAt(lastT, tf, graceMs);
  if (!Number.isFinite(ca)) return NaN;
  return Math.max(0, ca - now);
}

/* ───────────────────────── Realized metrics ───────────────────────── */

/**
 * Realized direction of a candle: "up" if close > open * (1+band), "down"
 * if close < open * (1-band), else "flat".  `band` is a relative fraction
 * (e.g. 0.0005 for 5 bps). Default 0 → strict sign.
 */
export function realizedDirection(candle, band = 0) {
  if (!candle || !Number.isFinite(candle.o) || !Number.isFinite(candle.c)) return "flat";
  const d = candle.c - candle.o;
  if (band > 0) {
    const thresh = Math.abs(candle.o) * band;
    if (Math.abs(d) <= thresh) return "flat";
  }
  if (d > 0) return "up";
  if (d < 0) return "down";
  return "flat";
}

/**
 * Realized *return* of a candle given a reference price (the price at which
 * the prediction was made, typically the previous close).  Defaults to the
 * candle open if no reference provided.
 */
export function realizedReturn(candle, refPrice) {
  if (!candle || !Number.isFinite(candle.c)) return NaN;
  const ref = Number.isFinite(refPrice) ? refPrice : candle.o;
  if (!Number.isFinite(ref) || ref === 0) return NaN;
  return (candle.c - ref) / ref;
}

/* ───────────────────────── Verdict builders ───────────────────────── */

function errVerdict(kind, msg) {
  return { ok: false, kind, error: msg };
}

/**
 * Compute a verdict for one prediction / one realized candle.
 *
 * @param {object} prediction  row from predictionStore
 * @param {object} candle      OHLCV with {o,h,l,c,v,t}
 * @param {{band?:number}} [opts]
 * @returns {object} verdict; always has `ok:boolean, kind:string`
 */
export function verdictFor(prediction, candle, opts = {}) {
  if (!prediction || typeof prediction !== "object") {
    return { ok: false, kind: "unknown", error: "prediction row required" };
  }
  if (!candle || typeof candle !== "object") {
    return errVerdict(prediction.kind || "unknown", "candle required");
  }
  const kind = prediction.kind || "direction";
  const payload = prediction.payload || {};
  const band = Number.isFinite(opts.band) ? opts.band : 0;

  switch (kind) {
    case "direction":
      return verdictDirection(payload, candle, band);
    case "return":
      return verdictReturn(payload, candle);
    case "interval":
      return verdictInterval(payload, candle);
    case "set":
      return verdictSet(payload, candle, band);
    default:
      return errVerdict(kind, `unknown kind "${kind}"`);
  }
}

/* — direction — */
function verdictDirection(payload, candle, band) {
  const predDir = (payload.dir || "").toLowerCase();
  if (!["up", "down", "flat"].includes(predDir)) {
    return errVerdict("direction", `invalid payload.dir "${payload.dir}"`);
  }
  const realDir = realizedDirection(candle, band);
  const abstain = predDir === "flat";
  const hit = !abstain && predDir === realDir;
  // Brier score (if probability provided): 0 = perfect, 1 = worst.
  // Encode realization as 1 for "predDir matches realized", 0 otherwise;
  // this mirrors a binary classifier evaluated on its own class.
  let brier = null;
  if (Number.isFinite(payload.prob)) {
    const target = hit ? 1 : 0;
    const d = payload.prob - target;
    brier = d * d;
  }
  return {
    ok: true,
    kind: "direction",
    predDir,
    realizedDir: realDir,
    hit,
    prob: Number.isFinite(payload.prob) ? payload.prob : null,
    brier,
    abstain,
    band,
  };
}

/* — return — */
function verdictReturn(payload, candle) {
  if (!Number.isFinite(payload.yhat)) {
    return errVerdict("return", "payload.yhat required");
  }
  const realized = realizedReturn(candle, payload.refPrice);
  if (!Number.isFinite(realized)) {
    return errVerdict("return", "realized return not computable");
  }
  const residual = realized - payload.yhat;
  const absError = Math.abs(residual);
  const sigma = Number.isFinite(payload.sigma) && payload.sigma > 0 ? payload.sigma : null;
  const zScore = sigma ? residual / sigma : null;
  return {
    ok: true,
    kind: "return",
    yhat: payload.yhat,
    realized,
    residual,
    absError,
    sigma,
    zScore,
  };
}

/* — interval — (conformal or otherwise) */
function verdictInterval(payload, candle) {
  if (!Number.isFinite(payload.lo) || !Number.isFinite(payload.hi)) {
    return errVerdict("interval", "payload.lo & payload.hi required");
  }
  if (payload.lo > payload.hi) {
    return errVerdict("interval", "lo > hi");
  }
  const realized = realizedReturn(candle, payload.refPrice);
  if (!Number.isFinite(realized)) {
    return errVerdict("interval", "realized return not computable");
  }
  const covered = realized >= payload.lo && realized <= payload.hi;
  const width = payload.hi - payload.lo;
  // Residual to interval centre (useful for drift on interval placement)
  const centre = (payload.lo + payload.hi) / 2;
  return {
    ok: true,
    kind: "interval",
    lo: payload.lo,
    hi: payload.hi,
    realized,
    covered,
    width,
    centreResidual: realized - centre,
  };
}

/* — set — */
function verdictSet(payload, candle, band) {
  const classes = Array.isArray(payload.classes) ? payload.classes : [];
  const realDir = realizedDirection(candle, band);
  // A set containing everything is vacuously correct but useless.
  // An empty set (direction === "abstain") is a strong OOD signal.
  const abstain = classes.length === 0 || payload.direction === "abstain";
  // Map MNP-internal dir to set labels ("long"/"short" used by APS for binary,
  // but we also accept {"up","down","flat"} for flexibility).
  const key = realDir === "up" ? "long" : realDir === "down" ? "short" : realDir;
  const covered = classes.includes(key) || classes.includes(realDir);
  return {
    ok: true,
    kind: "set",
    classes: classes.slice(),
    setSize: classes.length,
    direction: payload.direction ?? null,
    realizedDir: realDir,
    covered,
    abstain,
    band,
  };
}

/* ───────────────────────── Batch validation ───────────────────────── */

/**
 * Validate a collection of predictions against a lookup function that
 * returns the realized candle for a given `(symbol, tf, t)`.  The lookup
 * may return null/undefined if the candle isn't available yet; those
 * predictions are skipped (caller should retry them later).
 *
 * Returns `[{prediction, verdict, missing}]`; `missing` is true when no
 * candle was found for that prediction.
 *
 * @param {object[]} predictions
 * @param {(symbol:string, tf:string, t:number) => object|null|undefined} lookup
 * @param {{band?:number, nextOffset?:number}} [opts]  nextOffset: "next" → use prediction.closeAt-based
 *                                                     offset; default is to look up candle at `prediction.t + tfMs`
 */
export function validateBatch(predictions, lookup, opts = {}) {
  if (!Array.isArray(predictions)) throw new Error("validateBatch: predictions array required");
  if (typeof lookup !== "function") throw new Error("validateBatch: lookup function required");
  const band = Number.isFinite(opts.band) ? opts.band : 0;
  const out = [];
  for (const p of predictions) {
    const target = nextCandleOpen(p.t, p.tf);
    if (!Number.isFinite(target)) {
      out.push({ prediction: p, verdict: errVerdict(p.kind, "unknown tf"), missing: false });
      continue;
    }
    const c = lookup(p.symbol, p.tf, target);
    if (!c) { out.push({ prediction: p, verdict: null, missing: true }); continue; }
    const v = verdictFor(p, c, { band });
    out.push({ prediction: p, verdict: v, missing: false });
  }
  return out;
}

/* ───────────────────────── Summary aggregation ───────────────────────── */

/**
 * Aggregate verdicts into a compact KPI object.  Accepts raw verdict
 * objects (as produced by verdictFor) in any mix of kinds; returns:
 *
 *   {
 *     n,
 *     directional: { n, hits, accuracy, abstainN },
 *     regression:  { n, mae, rmse, meanResidual, meanAbsResidual },
 *     intervals:   { n, coverage, meanWidth },
 *     sets:        { n, coverage, meanSize, abstainN },
 *     brier:       { n, mean },
 *   }
 */
export function summarizeVerdicts(verdicts) {
  const out = {
    n: 0,
    directional: { n: 0, hits: 0, accuracy: null, abstainN: 0 },
    regression:  { n: 0, mae: null, rmse: null, meanResidual: null },
    intervals:   { n: 0, coverage: null, meanWidth: null },
    sets:        { n: 0, coverage: null, meanSize: null, abstainN: 0 },
    brier:       { n: 0, mean: null },
  };
  if (!Array.isArray(verdicts) || verdicts.length === 0) return out;
  out.n = verdicts.length;

  let sumAbs = 0, sumSq = 0, sumRes = 0, nReg = 0;
  let covI = 0, widthI = 0, nI = 0;
  let covS = 0, sizeS = 0, nS = 0, absS = 0;
  let nBr = 0, sumBr = 0;

  for (const v of verdicts) {
    if (!v || !v.ok) continue;
    switch (v.kind) {
      case "direction":
        out.directional.n++;
        if (v.abstain) out.directional.abstainN++;
        else if (v.hit) out.directional.hits++;
        if (Number.isFinite(v.brier)) { nBr++; sumBr += v.brier; }
        break;
      case "return":
        nReg++;
        sumAbs += v.absError;
        sumSq  += v.residual * v.residual;
        sumRes += v.residual;
        if (Number.isFinite(v.brier)) { nBr++; sumBr += v.brier; }
        break;
      case "interval":
        nI++;
        if (v.covered) covI++;
        widthI += v.width;
        break;
      case "set":
        nS++;
        if (v.covered) covS++;
        sizeS += v.setSize;
        if (v.abstain) absS++;
        break;
    }
  }

  if (out.directional.n > 0) {
    const nonAbs = out.directional.n - out.directional.abstainN;
    out.directional.accuracy = nonAbs > 0 ? out.directional.hits / nonAbs : null;
  }
  if (nReg > 0) {
    out.regression.n = nReg;
    out.regression.mae = sumAbs / nReg;
    out.regression.rmse = Math.sqrt(sumSq / nReg);
    out.regression.meanResidual = sumRes / nReg;
    out.regression.meanAbsResidual = sumAbs / nReg;
  }
  if (nI > 0) {
    out.intervals.n = nI;
    out.intervals.coverage = covI / nI;
    out.intervals.meanWidth = widthI / nI;
  }
  if (nS > 0) {
    out.sets.n = nS;
    out.sets.coverage = covS / nS;
    out.sets.meanSize = sizeS / nS;
    out.sets.abstainN = absS;
  }
  if (nBr > 0) {
    out.brier.n = nBr;
    out.brier.mean = sumBr / nBr;
  }
  return out;
}

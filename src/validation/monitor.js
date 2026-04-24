/**
 * My Next Prediction v3.0 — Phase 10 · Validation + Drift Monitor
 * ---------------------------------------------------------------
 * Orchestrator that turns three pure pieces into a live service:
 *
 *     predictionStore  ←  IDB pending/validated rows
 *     validator        ←  pure verdict math
 *     drift            ←  PSI/KS/Rolling/ADWIN/PageHinkley primitives
 *
 * Responsibilities:
 *
 *   1. Consume a prediction submitted by the app (`submit(prediction, {candle})`)
 *      and persist it to the `predictions` store with `closeAt` scheduled at
 *      the next-candle close + grace.
 *
 *   2. On every `candle:closed` event (from the Phase-1 feed manager) or on
 *      explicit `tick()` calls in tests/headless mode, evaluate all pending
 *      predictions whose `closeAt ≤ now`:
 *         - look up the realized candle (injected `candleLookup`)
 *         - compute a verdict (validator.verdictFor)
 *         - write a row to `validations` store
 *         - mark the prediction as validated
 *         - update drift detectors per (symbol, tf, kind)
 *         - emit 'validation:verdict' on the EventBus
 *
 *   3. When a drift detector trips, emit 'drift:shift' (with cause + stats).
 *      The Phase-10 contract stops at signalling — actual retraining hooks
 *      live in Phase 8's `Trainer` and are consumed by later phases.
 *
 * The monitor is **construction-injected** (event bus, store, candle lookup)
 * so it stays testable without IDB or a real WS in unit tests.
 */

import * as Store from "./predictionStore.js";
import * as Validator from "./validator.js";
import {
  RollingAccuracy,
  ResidualWindow,
  ADWINLite,
  PageHinkley,
  psi,
  levelFromPSI,
} from "./drift.js";
// Phase 11 — ghost-verdict feedback loop:
// RollingConformal eats realized per-bar errors and closes the loop
// between Phase-11 ghost forecasts and Phase-9 conformal widths.
import { RollingConformal } from "../ml/conformal.js";
import * as DefaultConformalStore from "../ml/conformalStore.js";

const DEFAULTS = {
  graceMs: 4_000,
  band: 0,
  accuracyCapacity: 200,
  residualCapacity: 500,
  adwinDelta: 0.002,
  phDelta: 0.005,
  phThreshold: 0.05,
  psiBaselineMin: 200,
  psiBins: 10,
  psiMajor: 0.25,
  // Ghost-verdict feedback loop -----------------------------------------
  ghostConformalCapacity: 500,
  ghostConformalAlpha:    0.1,
  ghostPersistEvery:      25,     // write RC → IDB every N pushed scores
  ghostVersion:           "phase11-feedback-1",
};

/**
 * A drift bundle aggregates detectors for a single `(symbol, tf, kind)` triple.
 */
function makeDriftBundle(opts) {
  return {
    accuracy: new RollingAccuracy({ capacity: opts.accuracyCapacity }),
    residuals: new ResidualWindow({ capacity: opts.residualCapacity }),
    coverage: new RollingAccuracy({ capacity: opts.accuracyCapacity }),
    adwinAcc: new ADWINLite({ delta: opts.adwinDelta }),
    adwinRes: new ADWINLite({ delta: opts.adwinDelta }),
    phResid:  new PageHinkley({ delta: opts.phDelta, threshold: opts.phThreshold, direction: "both" }),
    // Baseline snapshot for PSI (captured once after warm-up).
    baseline: null,
    baselineTakenAt: null,
  };
}

/**
 * ValidationMonitor — construct with at least a store + bus + candleLookup.
 *
 * @typedef {Object} MonitorOpts
 * @property {object} store         — predictionStore module (or compat shim)
 * @property {object} bus           — { emit(topic, data), on(topic, fn) }
 * @property {(symbol:string, tf:string, t:number) => (object|null|Promise<object|null>)} candleLookup
 * @property {number} [graceMs]
 * @property {number} [band]
 * @property {number} [accuracyCapacity]
 * @property {number} [residualCapacity]
 * @property {number} [adwinDelta]
 * @property {number} [phDelta]
 * @property {number} [phThreshold]
 * @property {number} [psiBaselineMin]
 * @property {number} [psiBins]
 * @property {number} [psiMajor]
 */
export class ValidationMonitor {
  /** @param {MonitorOpts} opts */
  constructor(opts = {}) {
    if (!opts.bus || typeof opts.bus.emit !== "function") {
      throw new Error("ValidationMonitor: opts.bus with .emit required");
    }
    if (typeof opts.candleLookup !== "function") {
      throw new Error("ValidationMonitor: opts.candleLookup function required");
    }
    this.store = opts.store || Store;
    this.bus = opts.bus;
    this.candleLookup = opts.candleLookup;
    this.conformalStore = opts.conformalStore ?? DefaultConformalStore;
    this.opts = { ...DEFAULTS, ...opts };
    /** @type {Map<string, ReturnType<typeof makeDriftBundle>>} */
    this.drift = new Map();
    // Ghost-verdict feedback state ----------------------------------------
    /** @type {Map<string, RollingConformal>} keyed by `${symbol}|${tf}` */
    this.ghostConformal = new Map();
    /** @type {Map<string, number>} cached IDB row ids for write-in-place */
    this.ghostRowIds = new Map();
    /** @type {Map<string, number>} pushes since last persistence per key */
    this.ghostWriteCounter = new Map();
    /** @type {Map<string, Promise<void>>} coalesce concurrent hydrations */
    this.ghostHydrations = new Map();
    this.stopped = false;
    this.unsubscribers = [];
    this.stats = {
      submitted: 0,
      validated: 0,
      errors: 0,
      driftsDetected: 0,
      missing: 0,
      ghostVerdicts: 0,
      ghostScoresPushed: 0,
      ghostWrites: 0,
    };
  }

  /** Wire listeners. No-op if the bus lacks .on. */
  start() {
    this.stopped = false;
    if (typeof this.bus.on === "function") {
      this.unsubscribers.push(
        this.bus.on("candle:closed", (e) => this._onCandleClosed(e)),
      );
      // Phase-11 feedback: when a ghost's horizon fully resolves, push its
      // realized per-bar errors into the rolling conformal window so the
      // next forecast's band reflects actual path error, not the ATR·√h
      // heuristic fallback.
      this.unsubscribers.push(
        this.bus.on("ghost:verdict", (e) => {
          this.onGhostVerdict(e).catch((err) => {
            try { this.bus.emit("validation:error", { error: err?.message || String(err), source: "ghost:verdict" }); } catch {}
          });
        }),
      );
      // If the app visibility wakes, sweep once to catch missed windows.
      this.unsubscribers.push(
        this.bus.on("visibility", ({ visible }) => {
          if (visible) this.tick().catch(() => { /* swallow */ });
        }),
      );
    }
    return this;
  }

  stop() {
    this.stopped = true;
    for (const off of this.unsubscribers) { try { off(); } catch {} }
    this.unsubscribers = [];
    return this;
  }

  /**
   * Submit a new prediction. `refCandle` is the candle that FED the prediction
   * (used to compute `closeAt` = nextCandleOpen + tfMs + graceMs).
   *
   * @param {{symbol, tf, kind, payload, t?, version?, regime?}} prediction
   * @param {{refCandle?:object}} [ctx]
   * @returns {Promise<number>} prediction id
   */
  async submit(prediction, ctx = {}) {
    if (!prediction || typeof prediction !== "object") {
      throw new Error("submit: prediction required");
    }
    const { symbol, tf, kind = "direction", payload } = prediction;
    if (!symbol || !tf || !payload) throw new Error("submit: symbol/tf/payload required");

    const lastT = Number.isFinite(prediction.t)
      ? prediction.t
      : Number.isFinite(ctx.refCandle?.t) ? ctx.refCandle.t : Date.now();
    const closeAt = Validator.nextCloseAt(lastT, tf, this.opts.graceMs);
    if (!Number.isFinite(closeAt)) throw new Error(`submit: unknown tf "${tf}"`);

    const row = {
      symbol, tf,
      t: lastT,
      closeAt,
      kind,
      payload,
      version: prediction.version ?? "unknown",
      regime:  prediction.regime  ?? null,
      validated: 0,
      verdict: null,
      createdAt: Date.now(),
    };
    const id = await this.store.savePrediction(row);
    this.stats.submitted++;
    try { this.bus.emit("prediction:submitted", { id, symbol, tf, kind, closeAt }); } catch {}
    return id;
  }

  /**
   * Run one validation sweep: validate every pending prediction whose
   * `closeAt ≤ now`.  This is idempotent — already-validated rows are skipped
   * by the store's `duePredictions` filter.
   *
   * Returns `{ validated, missing, errors, drifts }`.
   */
  async tick({ now = Date.now(), symbol = undefined, tf = undefined } = {}) {
    if (this.stopped) return { validated: 0, missing: 0, errors: 0, drifts: [] };
    let validated = 0, missing = 0, errors = 0;
    const drifts = [];

    let due;
    try { due = await this.store.duePredictions({ now, symbol, tf }); }
    catch (err) { errors++; return { validated, missing, errors, drifts, error: err?.message }; }

    for (const p of due) {
      try {
        const target = Validator.nextCandleOpen(p.t, p.tf);
        if (!Number.isFinite(target)) { errors++; continue; }
        const candle = await this.candleLookup(p.symbol, p.tf, target);
        if (!candle) { missing++; continue; }

        const verdict = Validator.verdictFor(p, candle, { band: this.opts.band });
        if (!verdict.ok) { errors++; continue; }

        await this.store.markValidated(p.id, verdict);
        await this.store.saveValidation({
          predictionId: p.id,
          symbol: p.symbol,
          tf:     p.tf,
          t:      p.t,
          kind:   p.kind,
          verdict,
          validatedAt: now,
        });
        validated++;

        const drift = this._updateDrift(p, verdict);
        if (drift) drifts.push(drift);

        try { this.bus.emit("validation:verdict", { prediction: p, verdict }); } catch {}
      } catch (err) {
        errors++;
        try { this.bus.emit("validation:error", { prediction: p, error: err?.message || String(err) }); } catch {}
      }
    }

    this.stats.validated += validated;
    this.stats.missing   += missing;
    this.stats.errors    += errors;
    this.stats.driftsDetected += drifts.length;
    return { validated, missing, errors, drifts };
  }

  /* ───────────── drift update + emission ───────────── */

  _bundleFor(symbol, tf, kind) {
    const key = `${symbol}|${tf}|${kind}`;
    let b = this.drift.get(key);
    if (!b) { b = makeDriftBundle(this.opts); this.drift.set(key, b); }
    return { key, bundle: b };
  }

  /**
   * Consume a verdict into the relevant drift bundle.  Returns a drift event
   * object if a detector tripped (else null).  Event always includes the
   * `cause`, the KPI snapshot, and the prediction key.
   */
  _updateDrift(prediction, verdict) {
    const { key, bundle: b } = this._bundleFor(prediction.symbol, prediction.tf, prediction.kind);
    let tripped = null;

    switch (verdict.kind) {
      case "direction": {
        if (!verdict.abstain) {
          const hit = verdict.hit ? 1 : 0;
          b.accuracy.push(hit);
          if (b.adwinAcc.push(hit)) tripped = { cause: "accuracy-adwin", detector: "ADWINLite" };
        }
        break;
      }
      case "return": {
        const r = verdict.absError;
        b.residuals.push(r);
        if (b.adwinRes.push(r)) tripped = { cause: "residual-adwin", detector: "ADWINLite" };
        if (!tripped && b.phResid.push(r)) tripped = { cause: "residual-pagehinkley", detector: "PageHinkley" };
        break;
      }
      case "interval": {
        const cov = verdict.covered ? 1 : 0;
        b.coverage.push(cov);
        if (b.adwinAcc.push(cov)) tripped = { cause: "coverage-adwin", detector: "ADWINLite" };
        const r = Math.abs(verdict.centreResidual ?? 0);
        b.residuals.push(r);
        if (!tripped && b.phResid.push(r)) tripped = { cause: "interval-residual-pagehinkley", detector: "PageHinkley" };
        break;
      }
      case "set": {
        if (!verdict.abstain) {
          const cov = verdict.covered ? 1 : 0;
          b.coverage.push(cov);
          if (b.adwinAcc.push(cov)) tripped = { cause: "set-coverage-adwin", detector: "ADWINLite" };
        }
        break;
      }
    }

    // Opportunistic PSI: once we've collected enough residuals for a baseline,
    // periodically compare the recent window to the frozen baseline.
    const psiEv = this._maybeEmitPSI(b);
    if (psiEv) tripped = tripped || psiEv;

    if (tripped) {
      const snapshot = this.kpis(prediction.symbol, prediction.tf, prediction.kind);
      const evt = {
        key,
        symbol: prediction.symbol,
        tf:     prediction.tf,
        kind:   prediction.kind,
        ...tripped,
        at: Date.now(),
        kpis: snapshot,
      };
      try { this.bus.emit("drift:shift", evt); } catch {}
      return evt;
    }
    return null;
  }

  _maybeEmitPSI(bundle) {
    const need = Math.max(40, this.opts.psiBaselineMin | 0);
    const live = bundle.residuals.values();
    if (!bundle.baseline && live.length >= need) {
      bundle.baseline = live.slice();
      bundle.baselineTakenAt = Date.now();
      return null;
    }
    if (!bundle.baseline) return null;
    // Compute PSI every `need/2` pushes using the most-recent `need` residuals.
    if (live.length < need) return null;
    if ((live.length - (bundle._lastPSIEval ?? 0)) < Math.max(20, need >> 2)) return null;
    bundle._lastPSIEval = live.length;
    const recent = live.slice(-need);
    const { psi: v } = psi(bundle.baseline, recent, this.opts.psiBins);
    const level = levelFromPSI(v);
    if (Number.isFinite(v) && v > this.opts.psiMajor) {
      return { cause: "residual-psi", detector: "PSI", psi: v, psiLevel: level };
    }
    return null;
  }

  /* ───────────── introspection / KPIs ───────────── */

  /**
   * KPI snapshot for one bundle (or null if never seen).  Convenience wrapper
   * around drift detectors + a validation summary.
   */
  kpis(symbol, tf, kind) {
    const key = `${symbol}|${tf}|${kind}`;
    const b = this.drift.get(key);
    if (!b) return null;
    const accN = b.accuracy.length;
    const covN = b.coverage.length;
    return {
      key,
      accuracy: accN ? { n: accN, value: b.accuracy.accuracy(), ci: b.accuracy.wilson95() } : null,
      coverage: covN ? { n: covN, value: b.coverage.accuracy(), ci: b.coverage.wilson95() } : null,
      residuals: b.residuals.length ? {
        n: b.residuals.length,
        mean: b.residuals.mean(),
        std:  b.residuals.std(),
        rmse: b.residuals.rmse(),
      } : null,
      adwinAcc:    { size: b.adwinAcc.size(),    detections: b.adwinAcc.detectionCount, last: b.adwinAcc.lastDrift },
      adwinRes:    { size: b.adwinRes.size(),    detections: b.adwinRes.detectionCount, last: b.adwinRes.lastDrift },
      phResid:     { n: b.phResid.n, mean: b.phResid.mean, detections: b.phResid.detectionCount, last: b.phResid.lastDrift },
      baselineN:   b.baseline?.length ?? 0,
    };
  }

  /** All bundle keys. */
  keys() { return Array.from(this.drift.keys()); }

  /* ───────────── Phase 11 · Ghost-verdict feedback loop ───────────── */

  /**
   * Consume a `ghost:verdict` event (emitted by `ghostStore.resolveGhosts`
   * when a forecast's horizon is fully resolved).  Each per-bar realized
   * error is pushed into the per-(symbol, tf) `RollingConformal`, closing
   * the loop between the Phase-11 projections and the Phase-9 calibrator.
   * Coverage + |residual| also feed the existing `kind:"interval"` drift
   * bundle so ADWIN / PH / PSI detectors fire off ghost outcomes too.
   *
   * Emits:
   *   - `ghost:calibration` → `{ symbol, tf, q, samples, coverage, residualMean, … }`
   *   - `drift:shift`       → on detector trip (source: "ghost")
   *
   * Idempotent & tolerant: ignores malformed events; never throws.
   */
  async onGhostVerdict(e) {
    if (!e || typeof e !== "object") return null;
    const { symbol, tf, verdict } = e;
    if (!symbol || !tf || !verdict || !Array.isArray(verdict.perBar)) return null;

    this.stats.ghostVerdicts++;

    const key = `${symbol}|${tf}`;

    // Lazy hydrate RC from IDB on first touch for this key.
    if (!this.ghostConformal.has(key) && !this.ghostRowIds.has(key)) {
      await this._hydrateGhostConformal(symbol, tf);
    }
    let rc = this.ghostConformal.get(key);
    if (!rc) {
      rc = new RollingConformal({
        capacity: this.opts.ghostConformalCapacity,
        alpha:    this.opts.ghostConformalAlpha,
      });
      this.ghostConformal.set(key, rc);
    }

    // Ghost bars are treated as interval predictions for drift purposes.
    const { bundle } = this._bundleFor(symbol, tf, "interval");

    let pushed = 0, absSum = 0, absN = 0;
    let coveredN = 0, coveredTot = 0;
    let tripped = null;

    for (const pb of verdict.perBar) {
      if (!pb || typeof pb !== "object") continue;

      if (Number.isFinite(pb.absError) && pb.absError >= 0) {
        rc.push(pb.absError);
        pushed++;
        absSum += pb.absError;
        absN++;
        bundle.residuals.push(pb.absError);
        if (!tripped && bundle.phResid.push(pb.absError)) {
          tripped = { cause: "ghost-residual-pagehinkley", detector: "PageHinkley" };
        }
      }

      if (typeof pb.covered === "boolean") {
        const cov = pb.covered ? 1 : 0;
        bundle.coverage.push(cov);
        coveredTot++;
        if (pb.covered) coveredN++;
        if (!tripped && bundle.adwinAcc.push(cov)) {
          tripped = { cause: "ghost-coverage-adwin", detector: "ADWINLite" };
        }
      }
    }

    this.stats.ghostScoresPushed += pushed;

    // Counter-based write-through: every `ghostPersistEvery` pushes we
    // serialize the RC and write-in-place via ConformalStore.
    if (pushed > 0) {
      const prev = this.ghostWriteCounter.get(key) || 0;
      const next = prev + pushed;
      if (next >= this.opts.ghostPersistEvery) {
        try {
          await this._persistGhostConformal(key, symbol, tf);
          this.ghostWriteCounter.set(key, 0);
        } catch (err) {
          this.ghostWriteCounter.set(key, next);  // retain, retry next time
          try { this.bus.emit("validation:error", { error: err?.message || String(err), source: "ghost:verdict:persist" }); } catch {}
        }
      } else {
        this.ghostWriteCounter.set(key, next);
      }
    }

    const q = rc.quantile();
    const calibration = {
      symbol, tf,
      key,
      q:             Number.isFinite(q) ? q : null,
      samples:       rc.length,
      alpha:         rc.alpha,
      coverage:      coveredTot ? coveredN / coveredTot : null,
      coverageN:     coveredTot,
      residualMean:  absN ? absSum / absN : null,
      residualN:     absN,
      pushed,
      usedConformal: !!e.usedConformal,
      alphaGhost:    Number.isFinite(e.alpha) ? e.alpha : null,
      at:            Date.now(),
    };
    try { this.bus.emit("ghost:calibration", calibration); } catch {}

    // PSI opportunistic check (once enough residuals have flowed in).
    if (!tripped) {
      const psiEv = this._maybeEmitPSI(bundle);
      if (psiEv) tripped = psiEv;
    }

    if (tripped) {
      this.stats.driftsDetected++;
      const snapshot = this.kpis(symbol, tf, "interval");
      const evt = {
        key:  `${symbol}|${tf}|interval`,
        symbol, tf,
        kind: "interval",
        ...tripped,
        at:   Date.now(),
        kpis: snapshot,
        source: "ghost",
      };
      try { this.bus.emit("drift:shift", evt); } catch {}
    }

    return calibration;
  }

  /**
   * Load the most-recent ghost-version RollingConformal blob from
   * `conformalSets` and hydrate the in-memory cache.  No-op on miss or
   * backend failure — the next `onGhostVerdict` will just start a fresh RC.
   */
  async _hydrateGhostConformal(symbol, tf) {
    const key = `${symbol}|${tf}`;
    // Coalesce concurrent hydrations for the same key.
    if (this.ghostHydrations.has(key)) {
      try { await this.ghostHydrations.get(key); } catch {}
      return;
    }
    const promise = (async () => {
      try {
        if (!this.conformalStore || typeof this.conformalStore.latestConformal !== "function") return;
        const row = await this.conformalStore.latestConformal({
          symbol, tf,
          kind:    "rolling",
          regime:  null,
          version: this.opts.ghostVersion,
        });
        if (!row || !row.payload) return;
        const rc = RollingConformal.deserialize(row.payload);
        this.ghostConformal.set(key, rc);
        if (row.id != null) this.ghostRowIds.set(key, row.id);
      } catch (err) {
        try { this.bus.emit("validation:error", { error: err?.message || String(err), source: "ghost:hydrate" }); } catch {}
      }
    })();
    this.ghostHydrations.set(key, promise);
    try { await promise; } finally { this.ghostHydrations.delete(key); }
  }

  /**
   * Write-through: serialize the cached RC for `key` to `conformalSets`,
   * reusing the cached row id for write-in-place (avoids row accumulation
   * across restarts).  Increments `stats.ghostWrites` on success.
   */
  async _persistGhostConformal(key, symbol, tf) {
    if (!this.conformalStore || typeof this.conformalStore.saveConformal !== "function") return null;
    const rc = this.ghostConformal.get(key);
    if (!rc) return null;
    const payload = rc.serialize();
    const row = {
      kind:    "rolling",
      symbol, tf,
      regime:  null,
      version: this.opts.ghostVersion,
      alpha:   rc.alpha,
      q:       Number.isFinite(rc.q) ? rc.q : null,
      payload,
      meta:    { source: "ghost-verdict", samples: rc.length },
    };
    const existingId = this.ghostRowIds.get(key);
    if (existingId != null) row.id = existingId;
    const id = await this.conformalStore.saveConformal(row);
    if (id != null) this.ghostRowIds.set(key, id);
    this.stats.ghostWrites++;
    return id ?? null;
  }

  /**
   * Introspection: return the live RollingConformal for (symbol, tf), or
   * null.  Used by the UI to read the current q / coverage.
   */
  ghostRC(symbol, tf) {
    return this.ghostConformal.get(`${symbol}|${tf}`) || null;
  }

  /* ───────────── candle hook ───────────── */

  /** Internal: drive a tick from a candle-closed event (if filterable). */
  async _onCandleClosed(e) {
    if (this.stopped) return;
    try {
      await this.tick({
        now: Number.isFinite(e?.t) ? e.t + this.opts.graceMs : Date.now(),
        symbol: e?.symbol,
        tf: e?.tf,
      });
    } catch (err) {
      try { this.bus.emit("validation:error", { error: err?.message || String(err) }); } catch {}
    }
  }

  /** Reset all drift state (stats + detectors + ghost caches). */
  reset() {
    this.drift.clear();
    this.ghostConformal.clear();
    this.ghostRowIds.clear();
    this.ghostWriteCounter.clear();
    this.ghostHydrations.clear();
    this.stats.submitted = 0;
    this.stats.validated = 0;
    this.stats.errors = 0;
    this.stats.missing = 0;
    this.stats.driftsDetected = 0;
    this.stats.ghostVerdicts = 0;
    this.stats.ghostScoresPushed = 0;
    this.stats.ghostWrites = 0;
    return this;
  }
}

/* ───────────── factory convenience ───────────── */

/**
 * Build a monitor wired to the default MNP EventBus + predictionStore.
 * Requires `candleLookup` to be injected (usually routed to candleBuffer or
 * gapFiller.getStored).
 */
export function createDefaultMonitor({ bus, candleLookup, ...rest } = {}) {
  if (!bus)          throw new Error("createDefaultMonitor: bus required");
  if (!candleLookup) throw new Error("createDefaultMonitor: candleLookup required");
  return new ValidationMonitor({ bus, candleLookup, store: Store, ...rest });
}

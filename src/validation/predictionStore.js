/**
 * My Next Prediction v3.0 — Phase 10 · Prediction persistence
 * -----------------------------------------------------------
 * IDB-backed facade over the `predictions` and `validations` object stores
 * (both declared in schema.js since Phase 9).  Separating the facade from
 * the runtime orchestrator (monitor.js) lets us evolve the stored row shape
 * without coupling the runtime to IDB internals.
 *
 * ── `predictions` row shape ─────────────────────────────────────────────
 *   {
 *     id:         <auto>,
 *     symbol:     "BTCUSDT",
 *     tf:         "1h",
 *     t:          ms,       // the candle this prediction was MADE FROM
 *     closeAt:    ms,       // when the NEXT candle will close (= validation time)
 *     kind:       "direction" | "return" | "interval" | "set",
 *     payload:    {...},    // kind-dependent; see validator.js
 *     version:    "phaseN-x",
 *     regime:     string|null,
 *     validated:  0 | 1,    // NB: 0/1 (boolean indexing is not reliable in IDB)
 *     verdict:    object|null,
 *     createdAt:  ms,
 *   }
 *
 * ── `validations` row shape ─────────────────────────────────────────────
 *   Append-only verdict log (useful for drift + analytics queries that
 *   shouldn't scan the whole predictions store).
 *   {
 *     id:         <auto>,
 *     predictionId: number,
 *     symbol, tf, t, kind,
 *     verdict:    object,
 *     validatedAt: ms,
 *   }
 *
 * This module is a thin persistence layer — no validation math lives here.
 */

import {
  withStore,
  put,
  get,
  del,
  req2promise,
} from "../data/idb.js";

const PSTORE = "predictions";
const VSTORE = "validations";

const VALID_KINDS = new Set(["direction", "return", "interval", "set"]);

/* ═══════════════════════ Prediction row helpers ═══════════════════════ */

function normalizePrediction(row) {
  if (!row || typeof row !== "object") throw new Error("predictionStore: row required");
  if (!row.symbol || typeof row.symbol !== "string") {
    throw new Error("predictionStore: row.symbol required");
  }
  if (!row.tf || typeof row.tf !== "string") {
    throw new Error("predictionStore: row.tf required");
  }
  if (!Number.isFinite(row.t)) {
    throw new Error("predictionStore: row.t (source candle timestamp) required");
  }
  if (!Number.isFinite(row.closeAt)) {
    throw new Error("predictionStore: row.closeAt (next-candle close time) required");
  }
  const kind = row.kind || "direction";
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`predictionStore: unknown kind "${kind}"`);
  }
  if (!row.payload || typeof row.payload !== "object") {
    throw new Error("predictionStore: row.payload required");
  }
  return {
    symbol:    row.symbol,
    tf:        row.tf,
    t:         row.t,
    closeAt:   row.closeAt,
    kind,
    payload:   row.payload,
    version:   row.version   ?? "unknown",
    regime:    row.regime    ?? null,
    validated: row.validated ? 1 : 0,
    verdict:   row.verdict   ?? null,
    createdAt: row.createdAt ?? Date.now(),
  };
}

/** Insert or update-by-id. Returns row id. */
export async function savePrediction(row) {
  const norm = normalizePrediction(row);
  if (row && row.id != null) norm.id = row.id;
  return put(PSTORE, norm);
}

/** Load one prediction by id. */
export async function loadPrediction(id) {
  return get(PSTORE, id);
}

/** Delete one prediction by id. */
export async function deletePrediction(id) {
  return del(PSTORE, id);
}

/** Row count in predictions store. */
export async function countPredictions() {
  return withStore(PSTORE, "readonly", (s) => req2promise(s.count()));
}

/** Raw list of all predictions. Use sparingly. */
export async function listAllPredictions() {
  return withStore(PSTORE, "readonly", (s) => req2promise(s.getAll()));
}

/**
 * Filter rows. All fields optional and AND-ed.
 * `validated` accepts boolean or 0/1.
 * @param {{symbol?:string, tf?:string, kind?:string, version?:string, regime?:string|null, validated?:boolean|0|1}} filter
 */
export async function listPredictions(filter = {}) {
  const rows = await listAllPredictions();
  return rows.filter((r) => {
    if (filter.symbol  != null && r.symbol  !== filter.symbol)  return false;
    if (filter.tf      != null && r.tf      !== filter.tf)      return false;
    if (filter.kind    != null && r.kind    !== filter.kind)    return false;
    if (filter.version != null && r.version !== filter.version) return false;
    if ("regime" in filter     && r.regime  !== filter.regime)  return false;
    if (filter.validated != null) {
      const want = filter.validated ? 1 : 0;
      if ((r.validated ? 1 : 0) !== want) return false;
    }
    return true;
  });
}

/**
 * Return all *pending* predictions whose `closeAt ≤ now`, optionally for
 * a specific symbol/tf. This is the primary query the monitor uses each
 * time a new candle closes.
 */
export async function duePredictions({ now = Date.now(), symbol, tf } = {}) {
  const rows = await listAllPredictions();
  return rows.filter((r) => {
    if (r.validated) return false;
    if (symbol != null && r.symbol !== symbol) return false;
    if (tf     != null && r.tf     !== tf)     return false;
    return Number.isFinite(r.closeAt) && r.closeAt <= now;
  });
}

/**
 * Mark a prediction row as validated and attach the verdict in-place.
 * Returns the updated row.
 */
export async function markValidated(id, verdict) {
  if (!Number.isFinite(id)) throw new Error("predictionStore.markValidated: id required");
  if (!verdict || typeof verdict !== "object") {
    throw new Error("predictionStore.markValidated: verdict object required");
  }
  const row = await loadPrediction(id);
  if (!row) return null;
  row.validated = 1;
  row.verdict = verdict;
  await put(PSTORE, row);
  return row;
}

/** Clear all predictions (tests / nuclear). */
export async function clearPredictions() {
  return withStore(PSTORE, "readwrite", (s) => req2promise(s.clear()));
}

/* ═══════════════════════ Validation row helpers ═══════════════════════ */

function normalizeValidation(row) {
  if (!row || typeof row !== "object") throw new Error("predictionStore: validation row required");
  if (!Number.isFinite(row.predictionId)) {
    throw new Error("predictionStore: validation.predictionId required");
  }
  if (!row.symbol || !row.tf) {
    throw new Error("predictionStore: validation.symbol & tf required");
  }
  if (!Number.isFinite(row.t)) {
    throw new Error("predictionStore: validation.t required");
  }
  if (!row.verdict || typeof row.verdict !== "object") {
    throw new Error("predictionStore: validation.verdict required");
  }
  return {
    predictionId: row.predictionId,
    symbol:       row.symbol,
    tf:           row.tf,
    t:            row.t,
    kind:         row.kind ?? "direction",
    verdict:      row.verdict,
    validatedAt:  row.validatedAt ?? Date.now(),
  };
}

/** Append a validation record. Returns row id. */
export async function saveValidation(row) {
  const norm = normalizeValidation(row);
  if (row && row.id != null) norm.id = row.id;
  return put(VSTORE, norm);
}

/** Load a single validation row. */
export async function loadValidation(id) {
  return get(VSTORE, id);
}

/** Row count in validations store. */
export async function countValidations() {
  return withStore(VSTORE, "readonly", (s) => req2promise(s.count()));
}

/** Raw list (use sparingly). */
export async function listAllValidations() {
  return withStore(VSTORE, "readonly", (s) => req2promise(s.getAll()));
}

/** Filter validations. All fields optional and AND-ed. */
export async function listValidations(filter = {}) {
  const rows = await listAllValidations();
  return rows.filter((r) => {
    if (filter.symbol != null && r.symbol !== filter.symbol) return false;
    if (filter.tf     != null && r.tf     !== filter.tf)     return false;
    if (filter.kind   != null && r.kind   !== filter.kind)   return false;
    if (filter.predictionId != null && r.predictionId !== filter.predictionId) return false;
    if (filter.sinceT != null && r.t < filter.sinceT) return false;
    if (filter.untilT != null && r.t > filter.untilT) return false;
    return true;
  });
}

/** Most recent N validations for (symbol, tf), sorted by validatedAt desc. */
export async function recentValidations({ symbol, tf, limit = 100 } = {}) {
  const all = await listValidations({ symbol, tf });
  all.sort((a, b) => (b.validatedAt || 0) - (a.validatedAt || 0));
  return all.slice(0, Math.max(0, limit | 0));
}

/** Clear all validation rows. */
export async function clearValidations() {
  return withStore(VSTORE, "readwrite", (s) => req2promise(s.clear()));
}

/** Remove both stores' rows. */
export async function clearAll() {
  await clearPredictions();
  await clearValidations();
}

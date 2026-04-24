/**
 * My Next Prediction v3.0 — Model persistence (IDB-backed)
 * --------------------------------------------------------
 * Save / load serialized MLP and RegimeEnsemble models to the `models`
 * object store. Row shape:
 *
 *   {
 *     id:        <auto>,
 *     kind:      "mlp" | "ensemble",
 *     regime:    string|null,    // null = global fallback / whole ensemble
 *     symbol:    string|null,
 *     tf:        string|null,
 *     version:   string,         // caller-supplied, e.g. "phase8-1"
 *     weights:   object,         // MLP.serialize() or RegimeEnsemble.serialize()
 *     meta:      object,         // free-form (trainRows, loss, etc.)
 *     createdAt: number,         // ms
 *   }
 *
 * This layer does NOT hydrate models (caller passes weights to
 * `MLP.deserialize` or `RegimeEnsemble.deserialize`) — keeping it a pure
 * persistence facade lets us evolve the network format without coupling
 * storage to runtime shape.
 */

import {
  withStore,
  put,
  get,
  del,
  req2promise,
  rangeByKey,
} from "../data/idb.js";

const STORE = "models";

/** Normalize a partial row into a valid record (sans id). */
function normalize(row) {
  if (!row || typeof row !== "object") throw new Error("modelStore: row required");
  if (!row.weights || typeof row.weights !== "object") {
    throw new Error("modelStore: weights required (object from .serialize())");
  }
  const kind = row.kind || "mlp";
  if (kind !== "mlp" && kind !== "ensemble") {
    throw new Error(`modelStore: unknown kind "${kind}"`);
  }
  return {
    kind,
    regime:    row.regime    ?? null,
    symbol:    row.symbol    ?? null,
    tf:        row.tf        ?? null,
    version:   row.version   ?? "unknown",
    weights:   row.weights,
    meta:      row.meta      ?? {},
    createdAt: row.createdAt ?? Date.now(),
  };
}

/**
 * Save a model (insert or update-by-id). Returns the row `id`.
 * If `row.id` is omitted, IDB auto-increments.
 */
export async function saveModel(row) {
  const norm = normalize(row);
  if (row && row.id != null) norm.id = row.id;
  return put(STORE, norm);
}

/** Load a single model row by primary key. */
export async function loadModel(id) {
  return get(STORE, id);
}

/** Delete a single model row. */
export async function deleteModel(id) {
  return del(STORE, id);
}

/** Total rows in the store. */
export async function countModels() {
  return withStore(STORE, "readonly", (s) => req2promise(s.count()));
}

/** Raw list of all rows (use cautiously on large stores). */
export async function listAll() {
  return withStore(STORE, "readonly", (s) => req2promise(s.getAll()));
}

/**
 * List rows matching a filter. All filter fields are optional and AND-ed.
 * @param {{symbol?:string, tf?:string, version?:string, regime?:string|null, kind?:string}} filter
 */
export async function listModels(filter = {}) {
  const rows = await listAll();
  return rows.filter((r) => {
    if (filter.symbol  != null && r.symbol  !== filter.symbol)  return false;
    if (filter.tf      != null && r.tf      !== filter.tf)      return false;
    if (filter.version != null && r.version !== filter.version) return false;
    if (filter.kind    != null && r.kind    !== filter.kind)    return false;
    if ("regime" in filter     && r.regime  !== filter.regime)  return false;
    return true;
  });
}

/**
 * Fetch the most recently created model matching a filter, or null if none.
 */
export async function latestModel(filter = {}) {
  const rows = await listModels(filter);
  if (!rows.length) return null;
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows[0];
}

/**
 * Fetch the latest model for a given regime (by_regime index + createdAt tiebreak).
 */
export async function loadByRegime(regime, filter = {}) {
  return latestModel({ ...filter, regime });
}

/**
 * Clear all rows. Meant for tests / nuclear recovery.
 */
export async function clearAll() {
  return withStore(STORE, "readwrite", (s) => req2promise(s.clear()));
}

/**
 * Convenience: save the global fallback + each per-regime specialist
 * from a RegimeEnsemble as individual rows (kind:"mlp"), plus one
 * top-level ensemble manifest row (kind:"ensemble"). Returns the
 * ensemble row id.
 *
 * This is useful when the ensemble is small enough to be stored whole,
 * but the caller wants per-regime rows for analytics / per-model eviction.
 *
 * @param {import("./ensemble.js").RegimeEnsemble} ens
 * @param {{symbol?:string, tf?:string, version:string, meta?:object}} opts
 */
export async function saveEnsembleExpanded(ens, opts) {
  if (!ens || typeof ens.serialize !== "function") {
    throw new Error("saveEnsembleExpanded: ensemble required");
  }
  const { symbol = null, tf = null, version, meta = {} } = opts || {};
  if (!version) throw new Error("saveEnsembleExpanded: version required");
  const ids = { perRegime: {}, fallback: null, ensemble: null };
  // Per-regime rows
  for (const key of ens.keys()) {
    const m = ens.models.get(key);
    if (!m || typeof m.serialize !== "function") continue;
    ids.perRegime[key] = await saveModel({
      kind: "mlp",
      regime: key,
      symbol, tf, version,
      weights: m.serialize(),
      meta: { ...(ens.meta.get(key) || {}) },
    });
  }
  // Fallback
  if (ens.fallback && typeof ens.fallback.serialize === "function") {
    ids.fallback = await saveModel({
      kind: "mlp",
      regime: null, // null = global fallback
      symbol, tf, version,
      weights: ens.fallback.serialize(),
      meta: { role: "fallback" },
    });
  }
  // Top-level ensemble manifest
  ids.ensemble = await saveModel({
    kind: "ensemble",
    regime: null,
    symbol, tf, version,
    weights: ens.serialize(),
    meta: { ...meta, keys: ens.keys(), hasFallback: !!ens.fallback },
  });
  return ids;
}

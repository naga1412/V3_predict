/**
 * My Next Prediction v3.0 — Phase 9 · Conformal calibration-set persistence
 * -------------------------------------------------------------------------
 * Save / load serialized conformal calibrators (split-regression, APS binary
 * classification, or rolling-window) to the `conformalSets` object store.
 *
 * Row shape:
 *   {
 *     id:        <auto>,
 *     kind:      "regression" | "classification" | "rolling",
 *     symbol:    string|null,
 *     tf:        string|null,
 *     regime:    string|null,    // null = global / not regime-specialized
 *     version:   string,         // caller-supplied (e.g. "phase9-1")
 *     alpha:     number,         // target miscoverage
 *     q:         number,         // cached calibrated threshold
 *     payload:   object,         // full .serialize() blob
 *     meta:      object,         // free-form
 *     createdAt: number,         // ms
 *   }
 *
 * This layer is a thin persistence facade.  Hydration is the caller's
 * responsibility (pass `payload` to `SplitConformalRegressor.deserialize`
 * etc.), keeping the store decoupled from the runtime classes.
 */

import {
  withStore,
  put,
  get,
  del,
  req2promise,
} from "../data/idb.js";

const STORE = "conformalSets";

const VALID_KINDS = new Set(["regression", "classification", "rolling"]);

/** Normalize a partial row into a valid record (sans id). */
function normalize(row) {
  if (!row || typeof row !== "object") throw new Error("conformalStore: row required");
  if (!row.payload || typeof row.payload !== "object") {
    throw new Error("conformalStore: payload required (object from .serialize())");
  }
  const kind = row.kind || row.payload?.kind;
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`conformalStore: unknown kind "${kind}"`);
  }
  return {
    kind,
    symbol:    row.symbol    ?? null,
    tf:        row.tf        ?? null,
    regime:    row.regime    ?? null,
    version:   row.version   ?? "unknown",
    alpha:     Number.isFinite(row.alpha) ? row.alpha : (row.payload?.alpha ?? 0.1),
    q:         Number.isFinite(row.q)     ? row.q     : (row.payload?.q     ?? Infinity),
    payload:   row.payload,
    meta:      row.meta      ?? {},
    createdAt: row.createdAt ?? Date.now(),
  };
}

/**
 * Save a conformal calibration set (insert or update-by-id). Returns the row id.
 * @returns {Promise<number>}
 */
export async function saveConformal(row) {
  const norm = normalize(row);
  if (row && row.id != null) norm.id = row.id;
  return put(STORE, norm);
}

/** Load a single conformal row by primary key. */
export async function loadConformal(id) {
  return get(STORE, id);
}

/** Delete a single conformal row. */
export async function deleteConformal(id) {
  return del(STORE, id);
}

/** Total rows in the store. */
export async function countConformal() {
  return withStore(STORE, "readonly", (s) => req2promise(s.count()));
}

/** Raw list of all rows (use cautiously on large stores). */
export async function listAll() {
  return withStore(STORE, "readonly", (s) => req2promise(s.getAll()));
}

/**
 * List rows matching a filter. All filter fields optional and AND-ed.
 * @param {{symbol?:string, tf?:string, version?:string, regime?:string|null, kind?:string}} filter
 */
export async function listConformals(filter = {}) {
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

/** Fetch the most recently created row matching a filter, or null. */
export async function latestConformal(filter = {}) {
  const rows = await listConformals(filter);
  if (!rows.length) return null;
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows[0];
}

/** Clear all rows (tests / nuclear recovery). */
export async function clearAll() {
  return withStore(STORE, "readwrite", (s) => req2promise(s.clear()));
}

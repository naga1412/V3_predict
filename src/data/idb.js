/**
 * My Next Prediction v3.0 — IndexedDB wrapper
 * -------------------------------------------
 * Zero-dep promise-based IDB helper. Not a general-purpose lib — only the
 * operations MNP needs. Detects corruption on open (scenario #47) and
 * surfaces quota errors (scenario #46) via EventBus.
 */

import { DB_NAME, DB_VERSION, MIGRATIONS } from "./schema.js";
import { EventBus } from "../core/bus.js";
import { degrade } from "../core/resilience.js";

let _dbPromise = null;

/** Open (or upgrade) the DB. Idempotent. */
export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (err) { return reject(err); }

    req.onupgradeneeded = (e) => {
      const db = req.result;
      const fromV = e.oldVersion;
      const toV   = e.newVersion;
      for (let v = fromV + 1; v <= toV; v++) {
        const fn = MIGRATIONS[v];
        if (typeof fn === "function") fn(db, req.transaction);
      }
    };
    req.onblocked = () => {
      EventBus.emit("idb:blocked");
      console.warn("[MNP] IDB upgrade blocked — close other tabs on older version");
    };
    req.onerror = () => {
      degrade("idb-open", req.error?.message || "unknown");
      reject(req.error);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        // Another tab wants to upgrade — let it.
        console.warn("[MNP] IDB version change detected; closing DB in this tab");
        db.close();
        _dbPromise = null;
        EventBus.emit("idb:versionchange");
      };
      resolve(db);
    };
  });
  return _dbPromise;
}

/** Delete & reopen (nuclear recovery for #47 corruption). */
export async function resetDB() {
  try {
    const db = await openDB(); db.close();
  } catch {}
  _dbPromise = null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
    req.onblocked = () => EventBus.emit("idb:delete-blocked");
  });
}

/* ───────── Core txn helpers ───────── */

export async function withStore(name, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let result;
    Promise.resolve(fn(store, tx)).then(r => { result = r; }).catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror   = () => reject(tx.error);
    tx.onabort   = () => reject(tx.error || new Error("tx aborted"));
  });
}

export function req2promise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/* ───────── Typed helpers ───────── */

export async function put(store, value) {
  return withStore(store, "readwrite", (s) => req2promise(s.put(value)));
}

export async function putMany(store, values) {
  if (!values?.length) return 0;
  return withStore(store, "readwrite", (s) => {
    for (const v of values) s.put(v);
    return values.length;
  });
}

export async function get(store, key) {
  return withStore(store, "readonly", (s) => req2promise(s.get(key)));
}

export async function del(store, key) {
  return withStore(store, "readwrite", (s) => req2promise(s.delete(key)));
}

export async function count(store) {
  return withStore(store, "readonly", (s) => req2promise(s.count()));
}

/**
 * Range query on a composite primary key.
 * Example:  rangeByKey("candles", IDBKeyRange.bound(["BTCUSDT","1m",0], ["BTCUSDT","1m",Infinity]))
 */
export async function rangeByKey(store, range, { limit = Infinity, direction = "next" } = {}) {
  return withStore(store, "readonly", (s) => new Promise((resolve, reject) => {
    const results = [];
    const req = s.openCursor(range, direction);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || results.length >= limit) return resolve(results);
      results.push(cur.value);
      cur.continue();
    };
  }));
}

/** Get the single row with max key in a range — used for "latest candle". */
export async function latestInRange(store, range) {
  return withStore(store, "readonly", (s) => new Promise((resolve, reject) => {
    const req = s.openCursor(range, "prev");
    req.onerror   = () => reject(req.error);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
  }));
}

/* ───────── Meta helpers (schema migrations, last-synced, flags) ───────── */

export async function metaGet(key, fallback) {
  const row = await get("meta", key);
  return row ? row.value : fallback;
}

export async function metaSet(key, value) {
  return put("meta", { key, value, ts: Date.now() });
}

/* ───────── Quota error catcher ───────── */

export function handleQuotaError(err) {
  if (err?.name === "QuotaExceededError") {
    EventBus.emit("quota:exceeded", { err: err.message });
    degrade("quota-exceeded", "Browser storage full; oldest candles will be evicted");
  }
}

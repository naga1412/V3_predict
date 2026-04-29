/**
 * My Next Prediction v3.0 — IndexedDB Schema
 * ------------------------------------------
 * Single source of truth for object stores, versions, and upgrade handlers.
 * Bump DB_VERSION when a store/index changes; add an entry to MIGRATIONS.
 *
 * Store conventions:
 *   - Composite primary key on time-series stores: [symbol, tf, t]
 *     (naturally dedupes identical candles — scenario #25)
 *   - All timestamps are ms since epoch, UTC (scenario #32, #100)
 *
 * Scenarios covered: #25 dedup, #46 quota, #47 corruption detection, #52 migrations.
 */

export const DB_NAME    = "mnp";
export const DB_VERSION = 9;

export const STORES = {
  // Time-series (OHLCV)
  candles: {
    keyPath: ["symbol", "tf", "t"],
    indexes: [
      { name: "by_symbol_tf_t", keyPath: ["symbol", "tf", "t"], unique: true },
      { name: "by_t",           keyPath: "t" },
    ],
  },
  // Computed feature vectors (filled in Phase 5)
  features: {
    keyPath: ["symbol", "tf", "t"],
    indexes: [
      { name: "by_version", keyPath: "version" },
    ],
  },
  // AI predictions (filled in Phase 11)
  predictions: {
    keyPath: "id",
    autoIncrement: true,
    indexes: [
      { name: "by_symbol_tf_t", keyPath: ["symbol", "tf", "t"] },
      { name: "by_validated",   keyPath: "validated" },
    ],
  },
  // Validated predictions (filled in Phase 10)
  validations: {
    keyPath: "id",
    autoIncrement: true,
    indexes: [
      { name: "by_symbol_tf_t", keyPath: ["symbol", "tf", "t"] },
    ],
  },
  // NN training pool (filled in Phase 7)
  trainingPool: {
    keyPath: "id",
    autoIncrement: true,
    indexes: [
      { name: "by_regime", keyPath: "regime" },
      { name: "by_tf",     keyPath: "tf" },
      { name: "by_ts",     keyPath: "ts" },
      { name: "by_version", keyPath: "version" },
    ],
  },
  // Regime classifications (filled in Phase 6)
  regimes: {
    keyPath: ["symbol", "tf", "t"],
    indexes: [
      { name: "by_regime", keyPath: "regime" },
    ],
  },
  // News cache (filled in Phase 13)
  newsCache: {
    keyPath: "url",
    indexes: [
      { name: "by_publishedAt", keyPath: "publishedAt" },
      { name: "by_symbol",      keyPath: "symbol" },
    ],
  },
  // App metadata (migrations, last sync, settings pointer)
  meta: {
    keyPath: "key",
  },
  // Serialized trained models (filled in Phase 8)
  //   Row shape: { id, kind:"mlp"|"ensemble", regime, symbol, tf, version,
  //                weights, meta, createdAt }
  //   - `regime` is null for the GLOBAL fallback and for whole-ensemble rows.
  //   - `weights` is the JSON-safe output of MLP/RegimeEnsemble `.serialize()`.
  models: {
    keyPath: "id",
    autoIncrement: true,
    indexes: [
      { name: "by_regime",    keyPath: "regime" },
      { name: "by_symbol_tf", keyPath: ["symbol", "tf"] },
      { name: "by_version",   keyPath: "version" },
      { name: "by_createdAt", keyPath: "createdAt" },
    ],
  },
  // Serialized conformal-prediction calibration sets (filled in Phase 9).
  //   Row shape: { id, kind:"regression"|"classification"|"rolling",
  //                symbol, tf, regime, version, alpha, q, scores|buf,
  //                mode?, capacity?, head?, length?, meta, createdAt }
  //   - `kind` distinguishes the three flavors in conformal.js.
  //   - `regime` is null if not regime-specialized.
  //   - `scores`/`buf` are plain number arrays (IDB-serializable).
  conformalSets: {
    keyPath: "id",
    autoIncrement: true,
    indexes: [
      { name: "by_regime",    keyPath: "regime" },
      { name: "by_symbol_tf", keyPath: ["symbol", "tf"] },
      { name: "by_kind",      keyPath: "kind" },
      { name: "by_version",   keyPath: "version" },
      { name: "by_createdAt", keyPath: "createdAt" },
    ],
  },
  // Ghost-candle forecasts (filled in Phase 11)
  //   Row shape: { id, symbol, tf, anchorTime, anchorClose, tfSec,
  //                horizon, nBars, alpha, lambda, bias, direction,
  //                confidence, usedConformal, atr, bars: [...],
  //                resolved, resolvedAt, resolvedN, verdict, meta, createdAt }
  //   - Each forecast is keyed by (symbol, tf, anchorTime) for dedup: a
  //     subsequent forecast at the same anchor overwrites the earlier one
  //     via the `by_anchor` unique index (callers find + put).
  //   - `bars[i]` ≡ { time, o, h, l, c, lo, hi, width }.
  //   - `resolved` is 0 until the horizon has fully closed (or was graded
  //     early by ValidationMonitor), then 1.
  //   - `verdict` holds per-bar coverage + path error from the monitor.
  ghosts: {
    keyPath: "id",
    autoIncrement: true,
    indexes: [
      { name: "by_symbol_tf",   keyPath: ["symbol", "tf"] },
      { name: "by_anchor",      keyPath: ["symbol", "tf", "anchorTime"], unique: true },
      { name: "by_resolved",    keyPath: "resolved" },
      { name: "by_createdAt",   keyPath: "createdAt" },
    ],
  },

  // M-LEARN-1 (DB v6): mistake ledger — frozen snapshot of every wrong
  // prediction, indexed by regime / errorType / timestamp.  Drives the
  // anti-pattern discovery worker downstream.
  mistakes: {
    keyPath: "id",
    autoIncrement: true,
    indexes: [
      { name: "by_t",         keyPath: "t" },
      { name: "by_symbol_tf", keyPath: ["symbol", "tf"] },
      { name: "by_regime",    keyPath: "context.regime" },
      { name: "by_errorType", keyPath: "errorType" },
      { name: "by_predId",    keyPath: "predictionId" },
    ],
  },

  // M-LEARN-4 (DB v8): meta-brain training pool — paired (input, label)
  // rows for the meta-NN.  Keyed by string id so the verdict-side
  // labeler can look up by `mb-${predictionId}`.
  metaBrainPool: {
    keyPath: "id",
    autoIncrement: false,
    indexes: [
      { name: "by_predictionId", keyPath: "predictionId" },
      { name: "by_pending",      keyPath: "pending" },
      { name: "by_t",            keyPath: "t" },
      { name: "by_symbol_tf",    keyPath: ["symbol", "tf"] },
    ],
  },

  // M-LEARN-2 (DB v7): anti-pattern clusters — feature-space regions
  // where the model has reliably been wrong.  Consumed by the
  // meta-veto layer (M-LEARN-3) on every prediction.
  antiPatterns: {
    keyPath: "id",
    autoIncrement: true,
    indexes: [
      { name: "by_regime",    keyPath: "regime" },
      { name: "by_hitRate",   keyPath: "hitRate" },
      { name: "by_direction", keyPath: "direction" },
      { name: "by_updatedAt", keyPath: "updatedAt" },
    ],
  },

  // M4a (DB v5): news headlines + sentiment + categorisation.  Row shape:
  //   { guid, source, sourceId, link, title, summary, pubDate, fetchedAt,
  //     sentiment: {compound,label,pos,neg},
  //     classification: {primary, matched, impact, highImpact},
  //     symbols: [...], focus: [...], region }
  news: {
    keyPath: "guid",
    autoIncrement: false,
    indexes: [
      { name: "by_pubDate",       keyPath: "pubDate" },
      { name: "by_source",        keyPath: "sourceId" },
      { name: "by_primary",       keyPath: "classification.primary" },
      { name: "by_highImpact",    keyPath: "classification.highImpact" },
    ],
  },

  // M-SCAN (DB v9): per-symbol scan results — orchestrator + meta-brain
  // verdict for every symbol scanned across the universe.  Indexed by
  // (symbol, tf) for fast ranked lookups; refreshed on every scan run.
  scanResults: {
    keyPath: ["symbol", "tf"],
    autoIncrement: false,
    indexes: [
      { name: "by_scannedAt", keyPath: "scannedAt" },
      { name: "by_assetType", keyPath: "assetType" },
      { name: "by_absBias",   keyPath: "absBias" },
    ],
  },
};

/**
 * Migration handlers keyed by target version.
 * Runs inside the versionchange transaction.
 */
export const MIGRATIONS = {
  1: (db /*: IDBDatabase */) => {
    for (const [name, def] of Object.entries(STORES)) {
      if (db.objectStoreNames.contains(name)) continue;
      const store = db.createObjectStore(name, {
        keyPath: def.keyPath,
        autoIncrement: def.autoIncrement || false,
      });
      (def.indexes || []).forEach(({ name: iname, keyPath, unique = false, multiEntry = false }) => {
        store.createIndex(iname, keyPath, { unique, multiEntry });
      });
    }
  },
  // Phase 8: added `models` store for serialized MLP / RegimeEnsemble weights.
  2: (db /*: IDBDatabase */) => {
    if (db.objectStoreNames.contains("models")) return;
    const def = STORES.models;
    const store = db.createObjectStore("models", {
      keyPath: def.keyPath,
      autoIncrement: def.autoIncrement || false,
    });
    (def.indexes || []).forEach(({ name: iname, keyPath, unique = false, multiEntry = false }) => {
      store.createIndex(iname, keyPath, { unique, multiEntry });
    });
  },
  // Phase 9: added `conformalSets` store for split-conformal & APS calibration.
  3: (db /*: IDBDatabase */) => {
    if (db.objectStoreNames.contains("conformalSets")) return;
    const def = STORES.conformalSets;
    const store = db.createObjectStore("conformalSets", {
      keyPath: def.keyPath,
      autoIncrement: def.autoIncrement || false,
    });
    (def.indexes || []).forEach(({ name: iname, keyPath, unique = false, multiEntry = false }) => {
      store.createIndex(iname, keyPath, { unique, multiEntry });
    });
  },
  // Phase 11: added `ghosts` store for forward-projected candle forecasts.
  4: (db /*: IDBDatabase */) => {
    if (db.objectStoreNames.contains("ghosts")) return;
    const def = STORES.ghosts;
    const store = db.createObjectStore("ghosts", {
      keyPath: def.keyPath,
      autoIncrement: def.autoIncrement || false,
    });
    (def.indexes || []).forEach(({ name: iname, keyPath, unique = false, multiEntry = false }) => {
      store.createIndex(iname, keyPath, { unique, multiEntry });
    });
  },
  // M4a: added `news` store for headlines + sentiment + categorisation.
  5: (db /*: IDBDatabase */) => {
    if (db.objectStoreNames.contains("news")) return;
    const def = STORES.news;
    const store = db.createObjectStore("news", {
      keyPath: def.keyPath,
      autoIncrement: def.autoIncrement || false,
    });
    (def.indexes || []).forEach(({ name: iname, keyPath, unique = false, multiEntry = false }) => {
      store.createIndex(iname, keyPath, { unique, multiEntry });
    });
  },
  // M-LEARN-1: added `mistakes` store for wrong-prediction ledger.
  6: (db /*: IDBDatabase */) => {
    if (db.objectStoreNames.contains("mistakes")) return;
    const def = STORES.mistakes;
    const store = db.createObjectStore("mistakes", {
      keyPath: def.keyPath,
      autoIncrement: def.autoIncrement || false,
    });
    (def.indexes || []).forEach(({ name: iname, keyPath, unique = false, multiEntry = false }) => {
      store.createIndex(iname, keyPath, { unique, multiEntry });
    });
  },
  // M-LEARN-2: added `antiPatterns` store.
  7: (db /*: IDBDatabase */) => {
    if (db.objectStoreNames.contains("antiPatterns")) return;
    const def = STORES.antiPatterns;
    const store = db.createObjectStore("antiPatterns", {
      keyPath: def.keyPath,
      autoIncrement: def.autoIncrement || false,
    });
    (def.indexes || []).forEach(({ name: iname, keyPath, unique = false, multiEntry = false }) => {
      store.createIndex(iname, keyPath, { unique, multiEntry });
    });
  },
  // M-LEARN-4: added `metaBrainPool` store.
  8: (db /*: IDBDatabase */) => {
    if (db.objectStoreNames.contains("metaBrainPool")) return;
    const def = STORES.metaBrainPool;
    const store = db.createObjectStore("metaBrainPool", {
      keyPath: def.keyPath,
      autoIncrement: def.autoIncrement || false,
    });
    (def.indexes || []).forEach(({ name: iname, keyPath, unique = false, multiEntry = false }) => {
      store.createIndex(iname, keyPath, { unique, multiEntry });
    });
  },
  // M-SCAN: added `scanResults` store.
  9: (db /*: IDBDatabase */) => {
    if (db.objectStoreNames.contains("scanResults")) return;
    const def = STORES.scanResults;
    const store = db.createObjectStore("scanResults", {
      keyPath: def.keyPath,
      autoIncrement: def.autoIncrement || false,
    });
    (def.indexes || []).forEach(({ name: iname, keyPath, unique = false, multiEntry = false }) => {
      store.createIndex(iname, keyPath, { unique, multiEntry });
    });
  },
};

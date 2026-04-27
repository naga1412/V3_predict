/**
 * My Next Prediction v3.0 — M4a · News Manager
 * --------------------------------------------
 * Periodic RSS pull + sentiment + categorisation + IDB persistence,
 * with EventBus emits for the UI to consume.
 *
 *   refresh({force?})       → fetch all sources, score, dedupe, persist
 *   start({intervalMs?})    → kick off auto-refresh (default every 10 min)
 *   stop()
 *   list({type, limit})     → live snapshot of stored items (newest first)
 *   subscribe(fn)           → fired whenever the in-memory list changes
 *
 * Events:
 *   news:item     {item}             — every newly-classified item
 *   news:batch    {items, fetched, persisted}
 *   news:macro    {tally, top}       — digest after each refresh
 *   news:error    {error}
 *
 * IDB schema: see ../data/schema.js for the `news` store added in
 * DB_VERSION 5.  Rows look like:
 *   {
 *     guid, source, sourceId, link, title, summary,
 *     pubDate, fetchedAt,
 *     sentiment: { compound, label },
 *     classification: { primary, matched, impact, highImpact },
 *     symbols: [...],
 *     focus: [...],
 *   }
 */

import { EventBus } from "../core/bus.js";
import { putMany, withStore, req2promise } from "../data/idb.js";
import { fetchAll, SOURCES } from "./rss.js";
import { scoreItem, extractSymbols, cleanHeadline } from "./sentiment.js";
import { classify, tally } from "./categories.js";

const STORE = "news";
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;   // 10 min
const MAX_KEEP = 500;                          // ring-cap on IDB rows

/* ═══════════════════════════ State ═══════════════════════════ */

let _items = [];                 // newest-first cache
let _byGuid = new Map();         // dedupe set
let _timer = null;
let _running = false;
const _listeners = new Set();

function fire() { for (const fn of _listeners) try { fn(_items); } catch {} }

/* ═══════════════════════════ Pipeline ═══════════════════════════ */

/**
 * Score + classify + extract symbols for one raw item.
 */
function annotate(raw) {
  const title   = cleanHeadline(raw.title || "");
  const summary = cleanHeadline(raw.summary || "").slice(0, 600);
  const sentiment       = scoreItem({ title, summary });
  const classification  = classify({ title, summary, source: raw.source });
  const symbols         = extractSymbols(`${title} ${summary}`);
  return {
    guid:     raw.guid || raw.link || `${raw.source || "x"}:${title}`,
    source:   raw.source   || "",
    sourceId: raw.sourceId || "",
    link:     raw.link     || "",
    title, summary,
    pubDate:  Number.isFinite(raw.pubDate) ? raw.pubDate : Date.now(),
    fetchedAt: Date.now(),
    sentiment: { compound: sentiment.compound, label: sentiment.label, pos: sentiment.pos, neg: sentiment.neg },
    classification: {
      primary:    classification.primary,
      matched:    classification.matched,
      impact:     classification.impact,
      highImpact: classification.highImpact,
    },
    symbols,
    focus:    Array.isArray(raw.focus) ? raw.focus.slice() : [],
    region:   raw.region || "",
  };
}

/**
 * Hydrate the in-memory list from IDB on first start (so a cold load
 * shows the latest cached items even before any RSS pull lands).
 */
async function hydrateFromIDB() {
  try {
    const rows = await withStore(STORE, "readonly", (s) => req2promise(s.getAll()));
    if (!Array.isArray(rows) || !rows.length) return;
    rows.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));
    _items = rows.slice(0, MAX_KEEP);
    _byGuid = new Map(_items.map((r) => [r.guid, r]));
    fire();
  } catch { /* fresh DB → ignore */ }
}

/**
 * Trim IDB to the last MAX_KEEP rows (oldest dropped).
 */
async function trimIDB() {
  try {
    await withStore(STORE, "readwrite", async (s) => {
      const rows = await req2promise(s.getAll());
      if (!Array.isArray(rows) || rows.length <= MAX_KEEP) return;
      rows.sort((a, b) => (a.pubDate || 0) - (b.pubDate || 0));   // oldest first
      const drop = rows.slice(0, rows.length - MAX_KEEP);
      for (const r of drop) {
        try { s.delete(r.guid); } catch {}
      }
    });
  } catch { /* ignore */ }
}

/* ═══════════════════════════ Public API ═══════════════════════════ */

/**
 * Pull all sources, annotate, dedupe, persist.  Resolves with a stat block.
 *
 * @param {{signal?:AbortSignal, sources?:Array, force?:boolean}} [opts]
 */
export async function refresh({ signal, sources, force = false } = {}) {
  if (_running && !force) return { skipped: true };
  _running = true;
  try {
    const raws = await fetchAll({ sources: sources || SOURCES, signal });
    let added = 0;
    const fresh = [];
    for (const raw of raws) {
      const item = annotate(raw);
      if (!item.guid) continue;
      if (_byGuid.has(item.guid)) continue;
      _byGuid.set(item.guid, item);
      fresh.push(item);
      added++;
      try { EventBus.emit("news:item", { item }); } catch {}
    }
    if (fresh.length) {
      _items = fresh.concat(_items);
      // sort newest first + cap
      _items.sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0));
      if (_items.length > MAX_KEEP) _items = _items.slice(0, MAX_KEEP);
      try { await putMany(STORE, fresh); } catch { /* IDB unavail */ }
      try { await trimIDB(); } catch {}
      fire();
    }
    const macro = tally(_items);
    try {
      EventBus.emit("news:batch",  { items: fresh, fetched: raws.length, persisted: fresh.length });
      EventBus.emit("news:macro",  { tally: macro, top: _items.slice(0, 5) });
    } catch {}
    return { added, fetched: raws.length, total: _items.length };
  } catch (err) {
    try { EventBus.emit("news:error", { error: err?.message || String(err) }); } catch {}
    return { error: err?.message || String(err) };
  } finally {
    _running = false;
  }
}

/**
 * Start auto-refresh.  Idempotent.  Hydrates from IDB on first call.
 */
export async function start({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (_timer) return;
  await hydrateFromIDB();
  // First fetch fires after a short delay so it doesn't compete with
  // the rest of the bootstrap sequence.
  _timer = setTimeout(async function tick() {
    await refresh().catch(() => {});
    _timer = setTimeout(tick, intervalMs);
  }, 4_000);
  try { EventBus.emit("news:started", { intervalMs }); } catch {}
}

export function stop() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
  try { EventBus.emit("news:stopped"); } catch {}
}

/** Snapshot of the current cache.  `type` filters by classification.primary. */
export function list({ type, limit = 100, symbol = null, minImpact = null } = {}) {
  let out = _items;
  if (type && type !== "all") {
    out = out.filter((it) => it.classification?.primary === type);
  }
  if (symbol) {
    const s = String(symbol).toUpperCase();
    out = out.filter((it) => Array.isArray(it.symbols) && it.symbols.includes(s));
  }
  if (Number.isFinite(minImpact)) {
    out = out.filter((it) => (it.classification?.impact || 0) >= minImpact);
  }
  return out.slice(0, limit);
}

/** Subscribe to in-memory updates.  Returns an off() function. */
export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Aggregate counts per category for the macro tally row. */
export function macroTally() { return tally(_items); }

/** Reset — tests only. */
export function _resetForTests() {
  _items = [];
  _byGuid = new Map();
  fire();
}

/** Inject a synthetic item — tests only. */
export function _ingestForTests(raw) {
  const item = annotate(raw);
  if (_byGuid.has(item.guid)) return null;
  _byGuid.set(item.guid, item);
  _items.unshift(item);
  fire();
  return item;
}

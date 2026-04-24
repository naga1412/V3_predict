/**
 * My Next Prediction v3.0 — Event Calendar
 * ----------------------------------------
 * Macro events matter more than any TA signal. This module keeps a user-
 * editable list of scheduled events and exposes proximity queries:
 *
 *   eventsNear(t, windowMs) -> [{event, deltaMs, phase:"before"|"during"|"after"}]
 *   isInEventWindow(t) -> {active:boolean, event, phase}
 *
 * Events are stored as:
 *   { id, name, at: number (ms UTC), impact: "high"|"medium"|"low",
 *     category: "macro"|"crypto"|"other", symbols?: string[],
 *     durationMs?: number }
 *
 * Persistence is separate — this file is pure. Use
 * `loadFromMetaSync(rows)` / `exportEvents()` to bridge with IDB meta store.
 *
 * Ships with a small DEFAULT_EVENTS list (illustrative); real dates should
 * be fetched from a user-provided source (web-scraper service or paste-in).
 */

export const IMPACT = Object.freeze({ HIGH: "high", MEDIUM: "medium", LOW: "low" });

// These are placeholder events for initial UX. Users should supply real
// calendars via the ingest API or the settings panel.
export const DEFAULT_EVENTS = Object.freeze([
  {
    id: "fomc-2026-03-18",
    name: "FOMC rate decision",
    at: Date.UTC(2026, 2, 18, 18, 0), // 2026-03-18 18:00 UTC
    impact: IMPACT.HIGH,
    category: "macro",
    durationMs: 30 * 60 * 1000,
  },
  {
    id: "cpi-2026-04-10",
    name: "US CPI release",
    at: Date.UTC(2026, 3, 10, 12, 30),
    impact: IMPACT.HIGH,
    category: "macro",
    durationMs: 5 * 60 * 1000,
  },
  {
    id: "nfp-2026-05-01",
    name: "US Non-farm payrolls",
    at: Date.UTC(2026, 4, 1, 12, 30),
    impact: IMPACT.HIGH,
    category: "macro",
    durationMs: 5 * 60 * 1000,
  },
]);

function impactWeight(imp) {
  if (imp === IMPACT.HIGH) return 3;
  if (imp === IMPACT.MEDIUM) return 2;
  if (imp === IMPACT.LOW) return 1;
  return 0;
}

export class EventCalendar {
  constructor(events = []) {
    this._events = [];
    this.replace(events);
  }

  /** Replace all events (sorted by `at`). */
  replace(events) {
    this._events = (Array.isArray(events) ? events : [])
      .filter(e => e && Number.isFinite(e.at))
      .map(e => ({ ...e }))
      .sort((a, b) => a.at - b.at);
    return this;
  }

  /** Add a new event (or upsert by id). */
  upsert(ev) {
    if (!ev || !Number.isFinite(ev.at)) return this;
    const i = this._events.findIndex(e => e.id === ev.id);
    if (i >= 0) this._events[i] = { ...this._events[i], ...ev };
    else this._events.push({ ...ev });
    this._events.sort((a, b) => a.at - b.at);
    return this;
  }

  remove(id) {
    this._events = this._events.filter(e => e.id !== id);
    return this;
  }

  all() { return this._events.slice(); }
  count() { return this._events.length; }

  /**
   * Events within [t-windowMs, t+windowMs]. Returns sorted by `deltaMs`.
   * @param {number} t            reference timestamp
   * @param {number} windowMs     half-window in ms
   * @param {object} [filter]
   * @param {string} [filter.impact]   minimum impact ("low"|"medium"|"high")
   * @param {string} [filter.symbol]   only events with .symbols including this
   */
  eventsNear(t, windowMs, filter = {}) {
    const minW = impactWeight(filter.impact || IMPACT.LOW);
    const out = [];
    for (const e of this._events) {
      if (Math.abs(e.at - t) > windowMs) continue;
      if (impactWeight(e.impact) < minW) continue;
      if (filter.symbol && Array.isArray(e.symbols) && !e.symbols.includes(filter.symbol)) continue;
      const deltaMs = e.at - t;
      const dur = e.durationMs ?? 0;
      let phase = "before";
      if (t > e.at + dur) phase = "after";
      else if (t >= e.at) phase = "during";
      out.push({ event: e, deltaMs, phase });
    }
    return out.sort((a, b) => Math.abs(a.deltaMs) - Math.abs(b.deltaMs));
  }

  /**
   * Is `t` currently inside any event's active window?
   * Active window = [event.at - preMs, event.at + event.durationMs + postMs]
   *
   * @param {number} t
   * @param {object} [opts]
   * @param {number} [opts.preMs=5*60000]   minutes before event
   * @param {number} [opts.postMs=30*60000] minutes after event
   * @param {string} [opts.impact]          filter min impact
   */
  isInEventWindow(t, { preMs = 5 * 60_000, postMs = 30 * 60_000, impact = IMPACT.LOW } = {}) {
    const minW = impactWeight(impact);
    for (const e of this._events) {
      if (impactWeight(e.impact) < minW) continue;
      const dur = e.durationMs ?? 0;
      const start = e.at - preMs;
      const end   = e.at + dur + postMs;
      if (t >= start && t <= end) {
        let phase = "pre";
        if (t >= e.at + dur) phase = "post";
        else if (t >= e.at) phase = "during";
        return { active: true, event: e, phase };
      }
    }
    return { active: false, event: null, phase: null };
  }

  /**
   * Flag tool for a time series: returns {flags: Uint8Array, impacts: Int8Array}
   * where flags[i]=1 when candle[i].t falls in an event window.
   *
   * @param {number[]} tArr   timestamps
   * @param {object} [opts]   see isInEventWindow
   */
  tagSeries(tArr, opts) {
    const n = tArr.length;
    const flags = new Uint8Array(n);
    const weights = new Int8Array(n);
    // Two-pointer sweep since events are sorted and tArr is usually sorted.
    let p = 0;
    for (let i = 0; i < n; i++) {
      const t = tArr[i];
      // find first event whose window could cover t
      while (p < this._events.length) {
        const e = this._events[p];
        const end = e.at + (e.durationMs ?? 0) + (opts?.postMs ?? 30 * 60_000);
        if (end < t) { p++; continue; }
        break;
      }
      // check from p forward
      let active = null;
      for (let q = p; q < this._events.length; q++) {
        const e = this._events[q];
        const start = e.at - (opts?.preMs ?? 5 * 60_000);
        if (start > t) break;
        const end = e.at + (e.durationMs ?? 0) + (opts?.postMs ?? 30 * 60_000);
        if (t >= start && t <= end) { active = e; break; }
      }
      if (active) { flags[i] = 1; weights[i] = impactWeight(active.impact); }
    }
    return { flags, weights };
  }

  /** Serialize to JSON for persistence. */
  export() { return this._events.slice(); }

  /** Hydrate from JSON — no validation beyond `at` being finite. */
  static fromJSON(arr) { return new EventCalendar(arr); }
}

/**
 * Build a calendar pre-loaded with DEFAULT_EVENTS plus any supplied rows.
 */
export function defaultCalendar(extra = []) {
  return new EventCalendar([...DEFAULT_EVENTS, ...extra]);
}

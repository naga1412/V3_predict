/**
 * My Next Prediction v3.0 — CandleValidator
 * -----------------------------------------
 * Guard for every candle ingested from any source. Cheap (< 0.01 ms).
 *
 * Rejects:
 *   - missing / non-finite fields (scenario #27, #91)
 *   - negative or zero prices (#27, #35 dead tokens)
 *   - H < max(O,C) or L > min(O,C) (logical impossibility)
 *   - v < 0
 *   - timestamp < 946684800000 (2000-01-01) or > now + 2 min (scenario #31 skew)
 *   - numeric overflow / NaN (#34)
 *
 * Returns { ok, reason, fixed? } — never throws.
 */

const MIN_T = 946684800000;       // 2000-01-01
const MAX_FUTURE_MS = 2 * 60_000; // +2 min

const TF_SECS = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "8h": 28800,
  "12h": 43200, "1d": 86400, "3d": 259200, "1w": 604800,
};

export function tfSecs(tf) { return TF_SECS[tf] || null; }
export function tfMs(tf)   { const s = TF_SECS[tf]; return s ? s * 1000 : null; }

/**
 * Normalize a candle into canonical shape:
 *   { symbol, tf, t, o, h, l, c, v, closed }
 */
export function validateCandle(raw, { symbol, tf, nowOverride = null } = {}) {
  if (!raw || typeof raw !== "object") return fail("not-an-object");

  const t = num(raw.t);
  const o = num(raw.o), h = num(raw.h), l = num(raw.l), c = num(raw.c), v = num(raw.v);

  for (const [k, x] of [["t", t], ["o", o], ["h", h], ["l", l], ["c", c], ["v", v]]) {
    if (!Number.isFinite(x)) return fail(`bad-${k}`);
  }

  // #34 overflow guard
  if (Math.abs(o) > 1e15 || Math.abs(h) > 1e15 || Math.abs(l) > 1e15 || Math.abs(c) > 1e15) {
    return fail("overflow");
  }

  // #35 dead tokens
  if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return fail("non-positive-price");
  if (v < 0) return fail("neg-volume");

  // Logical: high must be the max, low must be the min
  const mx = Math.max(o, c, l);
  const mn = Math.min(o, c, h);
  if (h < mx) return fail("h<max", { h, mx });
  if (l > mn) return fail("l>min", { l, mn });

  // Temporal sanity
  const now = nowOverride ?? Date.now();
  if (t < MIN_T) return fail("t-too-old");
  if (t > now + MAX_FUTURE_MS) return fail("t-in-future");

  // TF alignment: t must align on TF boundary (if tf known)
  if (tf) {
    const step = tfMs(tf);
    if (step && t % step !== 0) {
      // Some exchanges use close-time; accept if t+step aligns too. Otherwise snap.
      const aligned = Math.floor(t / step) * step;
      if (t - aligned > step / 4) return fail("t-not-aligned", { t, aligned });
      // soft-fix: snap
      return ok({ t: aligned, o, h, l, c, v, symbol, tf, closed: !!raw.closed }, "soft-aligned");
    }
  }

  return ok({ t, o, h, l, c, v, symbol, tf, closed: !!raw.closed });
}

function num(x) {
  if (typeof x === "number") return x;
  if (typeof x === "string") { const n = parseFloat(x); return Number.isFinite(n) ? n : NaN; }
  return NaN;
}

function ok(cand, note) { return { ok: true, candle: cand, note: note || null }; }
function fail(reason, meta) { return { ok: false, reason, meta: meta || null }; }

/* ───────── Batch helper ───────── */

/**
 * Validate an array; return { valid, dropped } and per-reason counts.
 */
export function validateBatch(arr, opts) {
  const valid = [];
  const dropped = [];
  const reasons = Object.create(null);
  for (const raw of arr) {
    const r = validateCandle(raw, opts);
    if (r.ok) valid.push(r.candle);
    else {
      dropped.push(r);
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
  }
  return { valid, dropped, reasons };
}

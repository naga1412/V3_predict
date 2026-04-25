/**
 * My Next Prediction v3.0 — Phase M3 · Volume Profile (enhanced)
 * --------------------------------------------------------------
 * Computes a price-bucketed volume profile with full traders'-pit
 * decoration:
 *
 *   - POC (point of control) — the price bucket with the largest volume.
 *   - VAH / VAL              — top / bottom of the 70 % value-area band.
 *                              Built by greedily expanding outward from
 *                              the POC until the running sum crosses
 *                              `valueAreaPct` of total volume.
 *   - HVN / LVN              — high / low volume nodes (relative-density
 *                              flags vs the bucket median).
 *   - TPO letters            — Time Price Opportunity letters (one
 *                              capital-letter glyph per bar that touched
 *                              that bucket; rolls over after Z → AA …)
 *
 * Pure module — no DOM, no IDB.  Caller passes a candle array and a
 * config object; the function returns the full bundle for either:
 *   - the inline sidebar card (renders rows directly), or
 *   - the on-chart overlay (price → pixel mapping done by the caller).
 *
 * Candle shape accepted:
 *   { o, h, l, c, v, t? } (lowercase)  *or*
 *   { open, high, low, close, volume, t? }
 *
 * Session-anchored mode:
 *   When `opts.sessionAnchored` is true and `opts.sessionStartT` is
 *   provided, only candles with `t >= sessionStartT` participate.
 *   Useful for "today's profile" / cash-session views.
 */

const DEFAULTS = Object.freeze({
  buckets:        24,
  lookback:       200,
  valueAreaPct:   0.70,
  hvnFactor:      1.5,   // bucket vol > median * factor → HVN
  lvnFactor:      0.4,   // bucket vol < median * factor → LVN
  sessionAnchored: false,
  sessionStartT:  null,
  /**
   * If non-null, a callback `(candle, idx) => "asia"|"london"|"ny-am"|"ny-pm"|"off"`.
   * Used to optionally tag TPO letters with a session prefix.  When null,
   * letters are simple A..Z, AA..ZZ.
   */
  sessionForCandle: null,
});

/* ═══════════════════════════ Helpers ═══════════════════════════ */

function getNum(c, lo, hi) {
  const v = c?.[lo] ?? c?.[hi];
  return Number.isFinite(v) ? +v : NaN;
}
function getO(c) { return getNum(c, "o", "open"); }
function getH(c) { return getNum(c, "h", "high"); }
function getL(c) { return getNum(c, "l", "low"); }
function getC(c) { return getNum(c, "c", "close"); }
function getV(c) {
  const v = c?.v ?? c?.volume;
  const n = Number.isFinite(v) ? +v : 0;
  return n > 0 ? n : 0;
}

/**
 * Convert a 0-indexed counter to a TPO glyph string: 0→A, 25→Z,
 * 26→AA, 27→AB, … (spreadsheet column scheme, 1-indexed internally).
 */
export function tpoLetter(i) {
  if (!Number.isInteger(i) || i < 0) return "";
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Locate the price-bucket index for `price` in [lo, hi] split into N
 * equal-width buckets.  Returns -1 if out of range / non-finite.
 */
export function bucketIndex(price, lo, hi, N) {
  if (!Number.isFinite(price) || !Number.isFinite(lo) || !Number.isFinite(hi)) return -1;
  if (hi <= lo || N <= 0) return -1;
  const step = (hi - lo) / N;
  if (step <= 0) return -1;
  if (price < lo) return -1;
  if (price > hi) return N - 1;        // include upper edge
  return Math.min(N - 1, Math.max(0, Math.floor((price - lo) / step)));
}

/**
 * Greedy 70 % value-area expansion around the POC.  At each step we look
 * at the bucket immediately above and below the current band and add
 * whichever has more volume; when both edges are reached we stop.
 *
 * Returns `{ vahIdx, valIdx, accumulatedVolume, areaPct }`.
 */
export function valueArea(rows, pocIdx, opts = {}) {
  const target = (opts.valueAreaPct ?? DEFAULTS.valueAreaPct);
  if (!Array.isArray(rows) || rows.length === 0 || pocIdx < 0 || pocIdx >= rows.length) {
    return { vahIdx: -1, valIdx: -1, accumulatedVolume: 0, areaPct: 0 };
  }
  const total = rows.reduce((s, r) => s + (r.vol || 0), 0);
  if (total <= 0) {
    return { vahIdx: pocIdx, valIdx: pocIdx, accumulatedVolume: 0, areaPct: 0 };
  }
  let lo = pocIdx, hi = pocIdx;
  let acc = rows[pocIdx]?.vol || 0;
  const need = total * target;
  while (acc < need && (lo > 0 || hi < rows.length - 1)) {
    const above = hi + 1 < rows.length ? rows[hi + 1].vol : -Infinity;
    const below = lo - 1 >= 0          ? rows[lo - 1].vol : -Infinity;
    if (above >= below) {
      if (hi + 1 < rows.length) { hi++; acc += rows[hi].vol; }
      else if (lo - 1 >= 0)     { lo--; acc += rows[lo].vol; }
      else break;
    } else {
      if (lo - 1 >= 0)          { lo--; acc += rows[lo].vol; }
      else if (hi + 1 < rows.length) { hi++; acc += rows[hi].vol; }
      else break;
    }
  }
  return { vahIdx: hi, valIdx: lo, accumulatedVolume: acc, areaPct: total > 0 ? acc / total : 0 };
}

/* ═══════════════════════════ Core compute ═══════════════════════════ */

/**
 * @typedef {Object} VPRow
 * @property {number} idx       bucket index (0..buckets-1, 0 = lowest)
 * @property {number} lo        bucket lower edge (price)
 * @property {number} hi        bucket upper edge (price)
 * @property {number} mid       (lo+hi)/2
 * @property {number} vol       total volume traded in this bucket
 * @property {number} up        up-bar volume share
 * @property {number} dn        down-bar volume share
 * @property {string[]} tpo     TPO letters (one per bar touching this bucket)
 * @property {boolean} isPOC
 * @property {boolean} isVAH
 * @property {boolean} isVAL
 * @property {boolean} inValueArea
 * @property {"HVN"|"LVN"|null} density
 */

/**
 * @typedef {Object} VPBundle
 * @property {VPRow[]} rows         lowest price first
 * @property {number}  pocIdx
 * @property {number}  pocPrice
 * @property {number}  vahIdx
 * @property {number}  vahPrice
 * @property {number}  valIdx
 * @property {number}  valPrice
 * @property {number}  totalVolume
 * @property {number}  buckets
 * @property {number}  lookback
 * @property {{lo:number, hi:number, step:number}} priceRange
 * @property {{barsUsed:number, sessionStartT:number|null, sessionAnchored:boolean}} window
 * @property {number}  hvnCount
 * @property {number}  lvnCount
 */

/**
 * Compute a volume profile bundle.
 *
 * @param {Array} candles
 * @param {Partial<DEFAULTS>} opts
 * @returns {VPBundle|null}  null when input is invalid / empty.
 */
export function computeVolumeProfile(candles, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!Array.isArray(candles) || candles.length < 2) return null;

  // 1. Window selection — last `lookback` bars or session-anchored.
  let from = Math.max(0, candles.length - (cfg.lookback | 0 || candles.length));
  if (cfg.sessionAnchored && Number.isFinite(cfg.sessionStartT)) {
    for (let i = from; i < candles.length; i++) {
      const t = candles[i]?.t ?? candles[i]?.time;
      if (Number.isFinite(t) && t >= cfg.sessionStartT) { from = i; break; }
    }
  }
  const window = candles.slice(from);
  if (window.length < 2) return null;

  // 2. Price range across the window.
  let lo = +Infinity, hi = -Infinity;
  for (const c of window) {
    const h = getH(c), l = getL(c);
    if (Number.isFinite(l) && l < lo) lo = l;
    if (Number.isFinite(h) && h > hi) hi = h;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;

  const N = Math.max(4, Math.min(256, cfg.buckets | 0));
  const step = (hi - lo) / N;
  /** @type {VPRow[]} */
  const rows = new Array(N);
  for (let i = 0; i < N; i++) {
    rows[i] = {
      idx: i,
      lo: lo + step * i,
      hi: lo + step * (i + 1),
      mid: lo + step * (i + 0.5),
      vol: 0, up: 0, dn: 0, tpo: [],
      isPOC: false, isVAH: false, isVAL: false, inValueArea: false, density: null,
    };
  }

  // 3. Bucket the candle volumes.  We split each candle's volume by its
  // direction (up bar → up share, else dn share) and tag the TPO bucket
  // with a letter so the caller can render time-price-opportunity glyphs.
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    const o = getO(c), h = getH(c), l = getL(c), cl = getC(c), v = getV(c);
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) continue;
    const tp = (h + l + cl) / 3;
    const idx = bucketIndex(tp, lo, hi, N);
    if (idx < 0) continue;
    rows[idx].vol += v;
    if (cl >= o) rows[idx].up += v; else rows[idx].dn += v;
    let tpoG = tpoLetter(i);
    if (typeof cfg.sessionForCandle === "function") {
      try {
        const tag = cfg.sessionForCandle(c, i);
        if (tag) tpoG = `${tag.slice(0, 1).toLowerCase()}${tpoG}`;
      } catch { /* ignore tagger errors */ }
    }
    rows[idx].tpo.push(tpoG);
  }

  // 4. POC = bucket with max volume (ties → highest price).
  let pocIdx = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].vol > rows[pocIdx].vol) pocIdx = i;
  }
  rows[pocIdx].isPOC = true;

  // 5. Value area — 70 % expansion around POC.
  const va = valueArea(rows, pocIdx, { valueAreaPct: cfg.valueAreaPct });
  if (va.vahIdx >= 0) {
    rows[va.vahIdx].isVAH = true;
    rows[va.valIdx].isVAL = true;
    for (let i = va.valIdx; i <= va.vahIdx; i++) rows[i].inValueArea = true;
  }

  // 6. HVN / LVN classification.  Prefer the median bucket volume as
  // the baseline (robust against POC dominance), but when the profile
  // is sparse (most buckets zero → median=0) fall back to the mean of
  // non-zero buckets so HVN / LVN flags can still be assigned.
  const sortedVols = rows.map((r) => r.vol).sort((a, b) => a - b);
  let baseline = sortedVols[Math.floor(sortedVols.length / 2)] || 0;
  if (baseline <= 0) {
    let nz = 0, sum = 0;
    for (const r of rows) if (r.vol > 0) { sum += r.vol; nz++; }
    baseline = nz > 0 ? sum / nz : 0;
  }
  let hvnCount = 0, lvnCount = 0;
  for (const r of rows) {
    if (baseline > 0 && r.vol >= baseline * cfg.hvnFactor) { r.density = "HVN"; hvnCount++; }
    else if (baseline > 0 && r.vol <= baseline * cfg.lvnFactor && r.vol > 0) { r.density = "LVN"; lvnCount++; }
  }

  const totalVolume = rows.reduce((s, r) => s + r.vol, 0);

  return {
    rows,
    pocIdx,
    pocPrice: rows[pocIdx].mid,
    vahIdx:   va.vahIdx,
    vahPrice: va.vahIdx >= 0 ? rows[va.vahIdx].hi : NaN,
    valIdx:   va.valIdx,
    valPrice: va.valIdx >= 0 ? rows[va.valIdx].lo : NaN,
    valueAreaPct: va.areaPct,
    totalVolume,
    buckets: N,
    lookback: window.length,
    priceRange: { lo, hi, step },
    window: {
      barsUsed: window.length,
      sessionStartT: cfg.sessionAnchored ? (cfg.sessionStartT ?? null) : null,
      sessionAnchored: !!cfg.sessionAnchored,
    },
    hvnCount,
    lvnCount,
  };
}

/* ═══════════════════════════ Convenience ═══════════════════════════ */

/**
 * Compact KPI snapshot for quick inspection / logging.
 */
export function summarizeProfile(bundle) {
  if (!bundle) return null;
  return {
    poc:  bundle.pocPrice,
    vah:  bundle.vahPrice,
    val:  bundle.valPrice,
    vapct: bundle.valueAreaPct,
    buckets: bundle.buckets,
    bars:  bundle.lookback,
    hvn:   bundle.hvnCount,
    lvn:   bundle.lvnCount,
  };
}

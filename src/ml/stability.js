/**
 * My Next Prediction v3.0 — M5 · Stability scorer
 * -----------------------------------------------
 * "Is the model agreeing with itself over the last N bars?"
 *
 * Three components blend into a 0..1 stability score:
 *   - biasStability    — 1 − std(bias)/0.5, clamped 0..1.   Lower σ
 *                         of the bias series means the model has been
 *                         consistently leaning one way.
 *   - directionStability — 1 − flipRate.   How many bars in a row the
 *                         direction sign has actually flipped.
 *   - intervalStability  — 1 − cpWidthGrowth, clamped.  When CP
 *                         widths blow out, intervals get unreliable.
 *
 * stability = 0.4·bias + 0.4·direction + 0.2·interval
 *
 * Pure module: input is a `history` array `{bias, direction, cpWidth?}`
 * (oldest-first).  Returns:
 *   { score, label, components: {bias, direction, interval}, n }
 *
 * Label thresholds: ≥ 0.7 stable · ≥ 0.45 moderate · else volatile
 */

const DEFAULTS = Object.freeze({ window: 30 });

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function safeNum(x) { return Number.isFinite(x) ? +x : NaN; }

function std(arr) {
  const xs = arr.filter(Number.isFinite);
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  let s2 = 0;
  for (const x of xs) { const d = x - m; s2 += d * d; }
  return Math.sqrt(s2 / (xs.length - 1));
}

/**
 * @param {Array<{bias?:number, direction?:number, cpWidth?:number}>} history
 * @param {object} [opts]
 */
export function computeStability(history, opts = {}) {
  if (!Array.isArray(history) || history.length < 3) {
    return {
      score: 0, label: "unknown",
      components: { bias: 0, direction: 0, interval: 0 },
      n: history?.length || 0,
    };
  }
  const cfg = { ...DEFAULTS, ...opts };
  const tail = history.slice(-Math.max(3, cfg.window));
  const biases   = tail.map(r => safeNum(r?.bias)).filter(Number.isFinite);
  const dirs     = tail.map(r => Math.sign(safeNum(r?.direction))).filter((d) => d === 1 || d === -1 || d === 0);
  const widths   = tail.map(r => safeNum(r?.cpWidth)).filter(Number.isFinite);

  // 1. bias stability — std over [-1,+1] domain.
  const sigma = std(biases);
  const biasStab = clamp01(1 - sigma / 0.5);

  // 2. direction stability — fraction of bar-to-bar non-flips.
  let flips = 0, total = 0;
  for (let i = 1; i < dirs.length; i++) {
    if (dirs[i] === 0 || dirs[i - 1] === 0) continue;
    total++;
    if (dirs[i] !== dirs[i - 1]) flips++;
  }
  const flipRate = total > 0 ? flips / total : 0;
  const dirStab  = clamp01(1 - flipRate);

  // 3. interval stability — how much the CP width grew over the window.
  let intervalStab = 0.5;   // neutral when no widths
  if (widths.length >= 3) {
    const first = widths[0], last = widths[widths.length - 1];
    const growth = first > 0 ? Math.max(0, (last - first) / first) : 0;
    intervalStab = clamp01(1 - growth / 1.0);   // 100% growth → 0
  }

  const score = 0.4 * biasStab + 0.4 * dirStab + 0.2 * intervalStab;
  const label = score >= 0.7 ? "stable"
              : score >= 0.45 ? "moderate"
              : "volatile";
  return {
    score: +score.toFixed(3),
    label,
    components: {
      bias:     +biasStab.toFixed(3),
      direction:+dirStab.toFixed(3),
      interval: +intervalStab.toFixed(3),
    },
    biasSigma: +sigma.toFixed(3),
    flipRate:  +flipRate.toFixed(3),
    n: tail.length,
  };
}

/**
 * Pure recorder: maintain a rolling history given a series of
 * orchestration outputs.  Returns a new array (immutable).
 */
export function appendHistory(history, snapshot, maxLen = 200) {
  const next = Array.isArray(history) ? history.slice() : [];
  next.push({
    t:         snapshot?.t ?? Date.now(),
    bias:      Number.isFinite(snapshot?.bias) ? snapshot.bias
              : Number.isFinite(snapshot?.rawScore) ? snapshot.rawScore
              : 0,
    direction: snapshot?.direction === "long" ? 1
              : snapshot?.direction === "short" ? -1
              : Number.isFinite(snapshot?.direction) ? Math.sign(snapshot.direction)
              : 0,
    cpWidth:   Number.isFinite(snapshot?.cpWidth) ? snapshot.cpWidth : null,
  });
  if (next.length > maxLen) next.splice(0, next.length - maxLen);
  return next;
}

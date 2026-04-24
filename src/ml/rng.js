/**
 * My Next Prediction v3.0 — Seeded RNG utilities
 * ----------------------------------------------
 * Deterministic pseudo-random generation. Mulberry32 is tiny, fast, and
 * has a 2^32 period — more than enough for batch shuffling and weight
 * initialization in small NNs.
 *
 * Determinism is important so that training runs can be reproduced for
 * validation (Phase 10) and so that unit tests don't flake.
 */

/**
 * Build a Mulberry32 PRNG from a 32-bit seed. Returns a function that
 * yields uniform floats in [0,1).
 * @param {number} seed   unsigned 32-bit integer
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let s = (seed >>> 0) || 1;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296);
  };
}

/**
 * Box-Muller — draws Normal(0,1) from two uniform [0,1) samples.
 * Caches the second sample so amortised cost is ~1 uniform per call.
 * @param {() => number} rand
 * @returns {() => number}
 */
export function gaussianFactory(rand) {
  let spare = null;
  return function gauss() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    // Guard against ln(0)
    while (u < 1e-12) u = rand();
    v = rand();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

/** In-place Fisher-Yates shuffle on an array using the given rand. */
export function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** Build a Uint32Array of length n with values [0..n-1], then shuffle. */
export function shuffledIndices(n, rand) {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  // Fisher-Yates on Uint32Array
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx;
}

/** Random integer in [0, n). */
export function randInt(rand, n) {
  return Math.floor(rand() * n);
}

/** Hash a string into a 32-bit unsigned int (for seeding from symbol/regime). */
export function hashStringToU32(s) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * My Next Prediction v3.0 — Integrity checksums
 * ---------------------------------------------
 * Pure-JS FNV-1a 32-bit hash for shard integrity. We don't need cryptographic
 * strength here — just corruption detection. For crypto-grade hashes we use
 * WebCrypto in `crypto.js`.
 *
 * Scenario coverage:
 *   - #55 detect corrupt shards (partial write, OPFS corruption)
 *   - #56 auto-repair by re-backfill from exchange
 *
 * FNV-1a: very fast, well-distributed for small-to-mid inputs, no deps.
 */

const FNV_OFFSET = 2166136261 >>> 0;
const FNV_PRIME  = 16777619;

/** Compute FNV-1a 32-bit hash of a byte array (Uint8Array / ArrayBuffer). */
export function fnv1a(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes
           : bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
           : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
           : null;
  if (!u8) throw new TypeError("fnv1a: expected Uint8Array/ArrayBuffer");
  let h = FNV_OFFSET;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    // Math.imul is significantly faster than plain multiply in JS engines.
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** Hex string version (8 chars). */
export function fnv1aHex(bytes) {
  return fnv1a(bytes).toString(16).padStart(8, "0");
}

/** Verify that `bytes` match `expectedHex`; return true/false without throwing. */
export function verify(bytes, expectedHex) {
  try { return fnv1aHex(bytes) === String(expectedHex).toLowerCase(); }
  catch { return false; }
}

/** Throw-on-mismatch variant for defensive decoding paths. */
export function verifyStrict(bytes, expectedHex) {
  const got = fnv1aHex(bytes);
  if (got !== String(expectedHex).toLowerCase()) {
    const err = new Error(`integrity: checksum mismatch (got=${got} expected=${expectedHex})`);
    err.code = "checksum-mismatch";
    throw err;
  }
  return true;
}

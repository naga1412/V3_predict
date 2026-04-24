/**
 * My Next Prediction v3.0 — Encryption at rest
 * --------------------------------------------
 * AES-GCM with a device key derived from a 32-byte random secret persisted in
 * IDB meta (`deviceKeySecret`). On first run we generate it; later runs reuse.
 *
 * Why a derived key instead of `generateKey({extractable:false})` and storing
 * the CryptoKey itself?  Because we need to survive IDB-only persistence and
 * CryptoKey objects are not structured-cloneable in all browsers. Storing the
 * raw secret in IDB meta is equivalent in threat model (whoever can read your
 * IDB can read your keys either way) and is portable.
 *
 * Scenarios covered:
 *   - #51 sensitive data at rest (prefs, notes)
 *   - #52 export/import preserves encryption
 *   - #57 rotate key (future: re-encrypt on rotate)
 */

import { metaGet, metaSet } from "./idb.js";

const HAS_CRYPTO = typeof crypto !== "undefined" && !!crypto.subtle;

let _keyPromise = null;

/** Ensure a device key exists in meta and return it as a CryptoKey. */
export async function getDeviceKey() {
  if (!HAS_CRYPTO) throw new Error("WebCrypto unavailable");
  if (_keyPromise) return _keyPromise;
  _keyPromise = (async () => {
    let secret = await metaGet("deviceKeySecret");
    if (!secret) {
      secret = crypto.getRandomValues(new Uint8Array(32));
      await metaSet("deviceKeySecret", secret);
      await metaSet("deviceKeyCreatedAt", Date.now());
    }
    // If it came back as ArrayBuffer (IDB round-trip), coerce.
    const raw = secret instanceof Uint8Array ? secret : new Uint8Array(secret);
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  })();
  return _keyPromise;
}

/** Encrypt JSON-able object. Returns { iv, ct, alg:'AES-GCM' }. */
export async function encryptJSON(obj) {
  const key = await getDeviceKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12)); // 96-bit GCM nonce
  const pt  = new TextEncoder().encode(JSON.stringify(obj));
  const ct  = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  return { iv, ct, alg: "AES-GCM" };
}

/** Decrypt to JSON. Returns the original object. */
export async function decryptJSON(pkg) {
  const key = await getDeviceKey();
  const iv  = pkg.iv instanceof Uint8Array ? pkg.iv : new Uint8Array(pkg.iv);
  const ct  = pkg.ct instanceof Uint8Array ? pkg.ct : new Uint8Array(pkg.ct);
  const pt  = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Encrypt raw bytes. Returns { iv, ct }. */
export async function encryptBytes(bytes) {
  const key = await getDeviceKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const ct  = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  return { iv, ct };
}

/** Decrypt raw bytes. */
export async function decryptBytes(pkg) {
  const key = await getDeviceKey();
  const iv  = pkg.iv instanceof Uint8Array ? pkg.iv : new Uint8Array(pkg.iv);
  const ct  = pkg.ct instanceof Uint8Array ? pkg.ct : new Uint8Array(pkg.ct);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

/** Convenience: SHA-256 of bytes (hex). Used for audit / content-addressing. */
export async function sha256hex(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
  const dig = await crypto.subtle.digest("SHA-256", u8);
  return Array.from(new Uint8Array(dig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export const crypto_info = { hasWebCrypto: HAS_CRYPTO };

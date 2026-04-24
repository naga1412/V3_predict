/**
 * My Next Prediction v3.0 — Backup / Restore
 * ------------------------------------------
 * Export/import the entire local dataset as a single .mnp.json.gz file.
 *
 * Format (after gunzip):
 *   {
 *     version: 1,
 *     createdAt: <ms>,
 *     app: "my-next-prediction-v3",
 *     stores: { [storeName]: Array<row> },
 *     meta:   { ...key→value from "meta" store },
 *     shards: { [key]: { bytesB64, meta } }   // from OPFS
 *   }
 *
 * Scenarios covered (plan §Q, §X):
 *   - #68 export-before-reset / migrate browsers
 *   - #69 import into fresh browser
 *   - #70 sanitized export (strips secrets via `redact` option)
 */

import * as IDB from "./idb.js";
import { STORES } from "./schema.js";
const STORE_NAMES = Object.keys(STORES);
import * as Shard from "./shardWriter.js";
import * as OPFS from "./opfs.js";
import { gzipJSON, gunzipJSON } from "./compress.js";

const APP = "my-next-prediction-v3";

/** Pull every row from every store (cursor-based to avoid OOM). */
async function dumpAll() {
  const out = {};
  for (const name of STORE_NAMES) {
    out[name] = await IDB.rangeByKey(name, undefined, { limit: Infinity });
  }
  return out;
}

function b64enc(bytes) {
  let s = "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // chunk to avoid "Maximum call stack size exceeded" on big shards
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
function b64dec(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** Export to a gzipped Blob. Returns { blob, filename, info }. */
export async function exportAll({ redact = ["deviceKeySecret"] } = {}) {
  const stores = await dumpAll();
  // Redact sensitive meta rows.
  if (stores.meta?.length && redact?.length) {
    const redactSet = new Set(redact);
    stores.meta = stores.meta.filter(row => !redactSet.has(row.key));
  }
  // Include shards from OPFS (raw bytes + header).
  const shards = {};
  const shardIndex = (await IDB.metaGet("shardIndex")) || {};
  for (const [key, meta] of Object.entries(shardIndex)) {
    const bytes = await OPFS.readFile(["candles", meta.symbol, meta.tf], `${meta.day}.bin`);
    if (bytes) shards[key] = { bytesB64: b64enc(bytes), meta };
  }
  const payload = {
    version: 1,
    createdAt: Date.now(),
    app: APP,
    stores,
    shards,
  };
  const { bytes, codec, origSize, compSize, ratio } = await gzipJSON(payload);
  const blob = new Blob([bytes], { type: "application/gzip" });
  const filename = `mnp-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json.gz`;
  return { blob, filename, info: { codec, origSize, compSize, ratio, shards: Object.keys(shards).length } };
}

/** Restore from a Blob / File / ArrayBuffer. Overwrites current stores. */
export async function importAll(source, { replace = true } = {}) {
  const buf = source instanceof Blob
    ? new Uint8Array(await source.arrayBuffer())
    : source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : source instanceof Uint8Array
        ? source
        : null;
  if (!buf) throw new TypeError("importAll: expected Blob/ArrayBuffer/Uint8Array");

  const payload = await gunzipJSON(buf, "gzip");
  if (payload?.app !== APP) throw new Error("backup: not an MNP backup");
  if (payload.version !== 1) throw new Error(`backup: unsupported version ${payload.version}`);

  // 1. Hot-tier stores.
  for (const name of STORE_NAMES) {
    const rows = payload.stores?.[name] || [];
    if (replace) {
      await IDB.withStore(name, "readwrite", (s) => s.clear());
    }
    if (rows.length) {
      await IDB.putMany(name, rows);
    }
  }

  // 2. Cold-tier shards → OPFS.
  const shards = payload.shards || {};
  let shardsRestored = 0;
  for (const [, entry] of Object.entries(shards)) {
    const bytes = b64dec(entry.bytesB64);
    await OPFS.writeFile(["candles", entry.meta.symbol, entry.meta.tf], `${entry.meta.day}.bin`, bytes);
    shardsRestored++;
  }

  return {
    ok: true,
    storesRestored: Object.fromEntries(STORE_NAMES.map(n => [n, (payload.stores?.[n] || []).length])),
    shardsRestored,
    backupCreatedAt: payload.createdAt,
  };
}

/** Utility: trigger a browser download of a backup blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

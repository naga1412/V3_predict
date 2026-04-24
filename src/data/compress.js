/**
 * My Next Prediction v3.0 — Compression
 * -------------------------------------
 * Thin wrapper around the browser CompressionStream API (gzip).
 *
 * Scenarios covered (from v3 plan §S):
 *   - #34 large-history storage fits under quota
 *   - #43 multi-timeframe retention without explosion
 *   - #59 cold-shard payloads small enough for sync I/O via OPFS
 *
 * Fallback: if CompressionStream isn't available we store raw bytes and
 * tag them as "raw" — reader is transparent.
 */
const HAS_CS = typeof CompressionStream === "function" && typeof DecompressionStream === "function";

/** Encode a string/Uint8Array to a gzip'd Uint8Array (or raw if unsupported). */
export async function gzip(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : toU8(input);
  if (!HAS_CS) return { bytes, codec: "raw" };
  const cs = new CompressionStream("gzip");
  const blob = await new Response(
    new Blob([bytes]).stream().pipeThrough(cs)
  ).arrayBuffer();
  return { bytes: new Uint8Array(blob), codec: "gzip" };
}

/** Decode a (maybe-gzip'd) Uint8Array back to raw bytes. */
export async function gunzip(bytes, codec = "gzip") {
  const u8 = toU8(bytes);
  if (codec === "raw" || !HAS_CS) return u8;
  const ds = new DecompressionStream("gzip");
  const blob = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(blob);
}

/** Compress a JSON-serializable object. Returns {bytes, codec, origSize, compSize}. */
export async function gzipJSON(obj) {
  const json = JSON.stringify(obj);
  const origSize = json.length;
  const { bytes, codec } = await gzip(json);
  return { bytes, codec, origSize, compSize: bytes.length, ratio: bytes.length / Math.max(1, origSize) };
}

/** Decompress and JSON.parse. */
export async function gunzipJSON(bytes, codec = "gzip") {
  const u8 = await gunzip(bytes, codec);
  return JSON.parse(new TextDecoder().decode(u8));
}

function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError("compress: expected Uint8Array/ArrayBuffer/string");
}

export const compress_info = { hasCompressionStream: HAS_CS };

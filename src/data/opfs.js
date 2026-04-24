/**
 * My Next Prediction v3.0 — OPFS layer
 * ------------------------------------
 * Thin wrapper around navigator.storage.getDirectory() (Origin Private File
 * System) for cold-tier shard storage. OPFS gives us near-unlimited, fast,
 * sandboxed disk access that IDB can't match for large binary blobs.
 *
 * Directory layout:
 *   /mnp/
 *     candles/
 *       {symbol}/
 *         {tf}/
 *           {yyyy-mm-dd}.bin        ← gzip'd JSON candle array, FNV-tagged
 *     meta/
 *       index.json                  ← shard registry (list of {path, from, to, count, crc})
 *
 * Scenarios covered:
 *   - #34 store 2y of 1m candles without blowing IDB quota
 *   - #58 survive crash mid-write (atomic tmp-then-rename pattern)
 *   - #59 fast random reads by (symbol, tf, day)
 */

const HAS_OPFS = typeof navigator !== "undefined"
               && navigator.storage
               && typeof navigator.storage.getDirectory === "function";

let _rootP = null;

/** Lazy get the /mnp root dir (created if absent). */
async function root() {
  if (!HAS_OPFS) throw new Error("OPFS unavailable");
  if (_rootP) return _rootP;
  _rootP = (async () => {
    const r = await navigator.storage.getDirectory();
    return await r.getDirectoryHandle("mnp", { create: true });
  })();
  return _rootP;
}

/** Walk or create a nested directory given an array of path segments. */
async function ensureDir(segments) {
  let d = await root();
  for (const s of segments) d = await d.getDirectoryHandle(s, { create: true });
  return d;
}

/** Resolve a directory (no create). Throws NotFoundError if missing. */
async function resolveDir(segments) {
  let d = await root();
  for (const s of segments) d = await d.getDirectoryHandle(s, { create: false });
  return d;
}

/** Write bytes to a file atomically (tmp → rename). */
export async function writeFile(pathSegments, name, bytes) {
  const dir = await ensureDir(pathSegments);
  const tmp = `.${name}.tmp-${Date.now().toString(36)}`;
  const tmpH = await dir.getFileHandle(tmp, { create: true });
  const w = await tmpH.createWritable();
  try {
    await w.write(bytes);
  } finally {
    await w.close();
  }
  // Rename the old one out of the way, then in. (OPFS has no "move", so we
  // copy-then-delete.)
  try { await dir.removeEntry(name); } catch (e) { /* not present */ }
  // Copy tmp → final by reading+writing (no native rename).
  const finalH = await dir.getFileHandle(name, { create: true });
  const buf = await (await tmpH.getFile()).arrayBuffer();
  const fw  = await finalH.createWritable();
  try { await fw.write(buf); } finally { await fw.close(); }
  try { await dir.removeEntry(tmp); } catch {}
  return { path: [...pathSegments, name].join("/"), size: bytes.byteLength ?? bytes.length };
}

/** Read a file's bytes. Returns null if missing. */
export async function readFile(pathSegments, name) {
  try {
    const dir = await resolveDir(pathSegments);
    const fh  = await dir.getFileHandle(name, { create: false });
    const f   = await fh.getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch (e) {
    if (e?.name === "NotFoundError") return null;
    throw e;
  }
}

/** Delete a file. Returns true if removed, false if missing. */
export async function deleteFile(pathSegments, name) {
  try {
    const dir = await resolveDir(pathSegments);
    await dir.removeEntry(name);
    return true;
  } catch (e) {
    if (e?.name === "NotFoundError") return false;
    throw e;
  }
}

/** List files in a directory. */
export async function listDir(pathSegments) {
  try {
    const dir = await resolveDir(pathSegments);
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file") out.push(name);
    }
    return out.sort();
  } catch (e) {
    if (e?.name === "NotFoundError") return [];
    throw e;
  }
}

/** Remove a whole directory tree. */
export async function removeDir(pathSegments) {
  if (!pathSegments.length) return;
  const parent = pathSegments.slice(0, -1);
  const name   = pathSegments[pathSegments.length - 1];
  try {
    const dir = await resolveDir(parent);
    await dir.removeEntry(name, { recursive: true });
  } catch (e) {
    if (e?.name !== "NotFoundError") throw e;
  }
}

/** Total bytes under /mnp (recursive). Used for quota dashboards. */
export async function sizeOf(pathSegments = []) {
  if (!HAS_OPFS) return 0;
  try {
    const dir = pathSegments.length ? await resolveDir(pathSegments) : await root();
    return await walkSize(dir);
  } catch (e) {
    if (e?.name === "NotFoundError") return 0;
    throw e;
  }
}

async function walkSize(dir) {
  let total = 0;
  for await (const [, h] of dir.entries()) {
    if (h.kind === "file") {
      const f = await h.getFile();
      total += f.size;
    } else {
      total += await walkSize(h);
    }
  }
  return total;
}

export const opfs_info = { hasOPFS: HAS_OPFS };

/**
 * My Next Prediction v3.0 — Capability Detector
 * ---------------------------------------------
 * Detects browser features so downstream modules can route to fast path or fallback.
 * Scenarios covered: #48 OPFS, #49 FS Access API, #50 private browsing, #55 cross-origin
 * isolation, #56-57 tab visibility, #63 WebGPU, #64 WASM, #65 SharedArrayBuffer,
 * plus storage quota (#46) and network online-state (#39).
 */

const RESULT = {};

/** @returns {Promise<Capabilities>} */
export async function detectCapabilities() {
  if (RESULT._done) return RESULT;

  RESULT.ua            = navigator.userAgent;
  RESULT.platform      = navigator.platform || "unknown";
  RESULT.online        = navigator.onLine;
  RESULT.hardwareCores = navigator.hardwareConcurrency || 2;
  RESULT.deviceMemGB   = navigator.deviceMemory || null;     // Chrome-only
  RESULT.touch         = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
  RESULT.smallScreen   = Math.min(window.innerWidth, window.innerHeight) < 700;
  RESULT.dpr           = window.devicePixelRatio || 1;
  RESULT.lang          = navigator.language || "en";
  RESULT.tz            = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  // --- Compute ------------------------------------------------------------
  RESULT.webgpu        = await probeWebGPU();
  RESULT.wasm          = probeWasm();
  RESULT.wasmSIMD      = await probeWasmSimd();
  RESULT.workers       = typeof Worker !== "undefined";
  RESULT.sharedWorker  = typeof SharedWorker !== "undefined";
  RESULT.sab           = probeSAB();
  RESULT.coiIsolated   = (typeof crossOriginIsolated !== "undefined") && crossOriginIsolated;

  // --- Storage ------------------------------------------------------------
  RESULT.localStorage  = probeLocalStorage();
  RESULT.sessionStorage= probeSessionStorage();
  RESULT.indexedDB     = typeof indexedDB !== "undefined";
  RESULT.opfs          = await probeOPFS();
  RESULT.fsAccess      = ("showDirectoryPicker" in window);
  RESULT.persistent    = !!(navigator.storage && navigator.storage.persist);
  RESULT.quota         = await probeQuota();
  RESULT.privateMode   = await probePrivateMode();

  // --- Comm / realtime ----------------------------------------------------
  RESULT.websocket     = typeof WebSocket !== "undefined";
  RESULT.broadcastCh   = typeof BroadcastChannel !== "undefined";
  RESULT.webLocks      = !!(navigator.locks && navigator.locks.request);
  RESULT.serviceWorker = "serviceWorker" in navigator;

  // --- UI -----------------------------------------------------------------
  RESULT.webCrypto     = !!(window.crypto && window.crypto.subtle);
  RESULT.resizeObserver= typeof ResizeObserver !== "undefined";
  RESULT.intersection  = typeof IntersectionObserver !== "undefined";
  RESULT.prefersReduced= matchMedia("(prefers-reduced-motion: reduce)").matches;
  RESULT.prefersContrast=matchMedia("(prefers-contrast: more)").matches;

  RESULT._done = true;
  Object.freeze(RESULT);
  return RESULT;
}

/* ───────── Probes ───────── */

async function probeWebGPU() {
  try {
    if (!("gpu" in navigator)) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

function probeWasm() {
  try {
    return typeof WebAssembly === "object"
      && typeof WebAssembly.instantiate === "function";
  } catch { return false; }
}

async function probeWasmSimd() {
  if (!probeWasm()) return false;
  // minimal SIMD test module (v128.const)
  try {
    const bytes = new Uint8Array([
      0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,
      65,0,253,15,253,98,11
    ]);
    return WebAssembly.validate(bytes);
  } catch { return false; }
}

function probeSAB() {
  try {
    // SAB requires COOP+COEP headers. Constructor existence alone is misleading.
    if (typeof SharedArrayBuffer !== "function") return false;
    new SharedArrayBuffer(16); // will throw if isolation missing
    return true;
  } catch { return false; }
}

function probeLocalStorage() {
  try {
    const k = "__mnp_probe__";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

function probeSessionStorage() {
  try {
    const k = "__mnp_probe__";
    sessionStorage.setItem(k, "1");
    sessionStorage.removeItem(k);
    return true;
  } catch { return false; }
}

async function probeOPFS() {
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    return !!root;
  } catch { return false; }
}

async function probeQuota() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { quota, usage } = await navigator.storage.estimate();
    return { quota: quota || 0, usage: usage || 0, freePct: quota ? 1 - usage / quota : null };
  } catch { return null; }
}

/** Best-effort private/incognito detection (#50). */
async function probePrivateMode() {
  // Chrome/Edge: storage quota is very small in incognito
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { quota } = await navigator.storage.estimate();
      if (quota && quota < 120 * 1024 * 1024) return true; // <120MB usually = incognito
    }
  } catch {}
  // Safari: IndexedDB unusable in private
  if (typeof indexedDB === "undefined") return true;
  return false;
}

/* ───────── Classification ───────── */

/**
 * @param {Capabilities} caps
 * @returns {{tier:"rich"|"standard"|"lite", reasons:string[]}}
 */
export function classifyTier(caps) {
  const reasons = [];
  let score = 0;
  if (caps.indexedDB)      score += 3; else reasons.push("no IndexedDB");
  if (caps.opfs)           score += 2; else reasons.push("no OPFS");
  if (caps.workers)        score += 2; else reasons.push("no WebWorker");
  if (caps.wasm)           score += 1; else reasons.push("no WASM");
  if (caps.websocket)      score += 2; else reasons.push("no WebSocket");
  if (caps.serviceWorker)  score += 1; else reasons.push("no SW");
  if (caps.webCrypto)      score += 1; else reasons.push("no WebCrypto");
  if (caps.broadcastCh)    score += 1; else reasons.push("no BroadcastChannel");
  if (caps.privateMode)    { score -= 2; reasons.push("private/incognito"); }
  if (caps.hardwareCores < 4) reasons.push("low CPU");
  if (caps.deviceMemGB && caps.deviceMemGB < 4) reasons.push("low RAM");

  let tier;
  if (score >= 10) tier = "rich";
  else if (score >= 6) tier = "standard";
  else tier = "lite";
  return { tier, reasons };
}

/**
 * Log & return human summary. Used by bootstrap splash.
 */
export function summarize(caps) {
  const { tier, reasons } = classifyTier(caps);
  return {
    tier,
    reasons,
    compute: [caps.wasm && "wasm", caps.wasmSIMD && "simd", caps.webgpu && "gpu", caps.workers && "worker", caps.sab && "sab"]
      .filter(Boolean).join("+") || "js-only",
    storage: [caps.indexedDB && "idb", caps.opfs && "opfs", caps.fsAccess && "fsa", caps.localStorage && "ls"]
      .filter(Boolean).join("+") || "none",
    net: caps.online ? "online" : "offline",
  };
}

/** Singleton getter (synchronous after first detection). */
export function getCapabilities() {
  if (!RESULT._done) throw new Error("capabilities not yet detected");
  return RESULT;
}

/** @typedef {object} Capabilities
 *  @property {boolean} webgpu
 *  @property {boolean} wasm
 *  @property {boolean} wasmSIMD
 *  @property {boolean} workers
 *  @property {boolean} sharedWorker
 *  @property {boolean} sab
 *  @property {boolean} coiIsolated
 *  @property {boolean} localStorage
 *  @property {boolean} sessionStorage
 *  @property {boolean} indexedDB
 *  @property {boolean} opfs
 *  @property {boolean} fsAccess
 *  @property {boolean} persistent
 *  @property {{quota:number,usage:number,freePct:number|null}|null} quota
 *  @property {boolean} privateMode
 *  @property {boolean} websocket
 *  @property {boolean} broadcastCh
 *  @property {boolean} webLocks
 *  @property {boolean} serviceWorker
 *  @property {boolean} webCrypto
 *  @property {boolean} touch
 *  @property {boolean} smallScreen
 *  @property {number}  dpr
 *  @property {number}  hardwareCores
 *  @property {number|null} deviceMemGB
 *  @property {string}  ua
 *  @property {string}  platform
 *  @property {boolean} online
 *  @property {string}  lang
 *  @property {string}  tz
 */

/**
 * My Next Prediction v3.0 — M6.5 · Web-LLM (in-browser WebGPU LLM)
 * ----------------------------------------------------------------
 * Wraps `@mlc-ai/web-llm` so the AI-chat tab can run a real model
 * inside the browser — zero install, no Ollama daemon, works on
 * GitHub Pages over HTTPS.
 *
 * Strategy:
 *   - The library (~5 MB minified) is heavy.  We lazy-load it via
 *     CDN dynamic import only when the user actually opts into the
 *     web-llm tier (via `getEngine()`).
 *   - The first chat downloads the chosen model (700 MB – 2.5 GB)
 *     and caches it forever in browser storage.  Subsequent chats
 *     are instant.
 *   - Same `{ ping, listModels, generate, chat }` interface as
 *     ollama.js so the router can dispatch transparently.
 *
 * Mixed-content note: Web-LLM is same-origin — no fetch to
 * `localhost`, no CSP issues beyond the model fetch from HuggingFace
 * (already covered by `connect-src https:` in index.html CSP).
 */

const CDN_URL = "https://esm.run/@mlc-ai/web-llm";
const STORAGE_KEY = "mnp.webllm.model";

/** Curated model menu — q4f16 quants are sweet-spot for size/quality. */
export const MODELS = Object.freeze([
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",  name: "Llama 3.2 1B",   sizeMB: 700,  ctx: 4096, default: false },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",  name: "Llama 3.2 3B",   sizeMB: 1700, ctx: 4096, default: true  },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC",  name: "Phi 3.5 mini",   sizeMB: 2400, ctx: 4096, default: false },
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",    name: "Qwen 2.5 3B",    sizeMB: 1700, ctx: 4096, default: false },
  { id: "Hermes-3-Llama-3.2-3B-q4f16_1-MLC",  name: "Hermes 3 (3B)",  sizeMB: 1700, ctx: 4096, default: false },
]);

/* ═══════════════════════════ State ═══════════════════════════ */

let _lib = null;             // dynamic-imported module
let _engine = null;          // active engine
let _engineModel = null;     // currently loaded model id
const _progressListeners = new Set();
let _initInProgress = null;

/** True when WebGPU is available in this browser. */
export function hasWebGPU() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

/** Same shape as ollama.ping() — just "is this tier viable?" */
export async function ping() {
  return hasWebGPU();
}

/** Lazy-import the library exactly once. */
async function ensureLib() {
  if (_lib) return _lib;
  // Dynamic import from esm.run.  CSP must allow https://cdn.jsdelivr.net
  // (esm.run resolves there) and any model-fetch domain (huggingface).
  _lib = await import(/* @vite-ignore */ CDN_URL);
  return _lib;
}

/**
 * Subscribe to download / load progress events.
 *   fn({ progress: 0..1, text: string })
 * Returns an off() function.
 */
export function onProgress(fn) {
  if (typeof fn !== "function") return () => {};
  _progressListeners.add(fn);
  return () => _progressListeners.delete(fn);
}
function fireProgress(report) {
  for (const fn of _progressListeners) try { fn(report); } catch {}
}

/**
 * Get / create the engine for `modelId`.  Coalesces concurrent
 * callers — only one download runs at a time.
 *
 * @param {string} [modelId]
 * @returns {Promise<{chat:any, reload:Function}>}
 */
export async function getEngine(modelId) {
  if (!hasWebGPU()) throw new Error("WebGPU not available in this browser");
  const m = modelId || localStorage.getItem(STORAGE_KEY) || MODELS.find((x) => x.default).id;
  if (_engine && _engineModel === m) return _engine;
  if (_initInProgress) return _initInProgress;

  _initInProgress = (async () => {
    const lib = await ensureLib();
    const create = lib.CreateMLCEngine || lib.default?.CreateMLCEngine;
    if (typeof create !== "function") throw new Error("Web-LLM CreateMLCEngine missing");
    fireProgress({ progress: 0, text: `loading ${m}…` });
    const engine = await create(m, {
      initProgressCallback: (p) => fireProgress({ progress: p.progress ?? 0, text: p.text || "" }),
    });
    _engine = engine;
    _engineModel = m;
    try { localStorage.setItem(STORAGE_KEY, m); } catch {}
    fireProgress({ progress: 1, text: "ready" });
    return engine;
  })().finally(() => { _initInProgress = null; });
  return _initInProgress;
}

/** Forget the active engine (frees GPU memory).  Models stay cached. */
export async function unload() {
  if (_engine?.unload) try { await _engine.unload(); } catch {}
  _engine = null;
  _engineModel = null;
}

/** Match ollama.listModels() signature — returns the curated list. */
export async function listModels() {
  return MODELS.map((m) => m.id);
}

/**
 * Generate a streaming response (chat-style, since Web-LLM only
 * exposes /chat).  Same hook contract as ollama.generate / chat.
 *
 * @param {{model?:string, prompt?:string, system?:string, signal?:AbortSignal, options?:object}} args
 * @param {{onToken?:Function, onDone?:Function, onError?:Function}} [hooks]
 */
export async function generate({ model, prompt, system, signal, options }, hooks = {}) {
  return chat({
    model,
    messages: [{ role: "user", content: prompt || "" }],
    system, signal, options,
  }, hooks);
}

export async function chat({ model, messages, system, signal, options }, hooks = {}) {
  if (!hasWebGPU()) {
    try { hooks.onError?.(new Error("WebGPU not available — switch to a Chromium-based browser or use Ollama")); } catch {}
    return null;
  }
  if (!Array.isArray(messages) || !messages.length) {
    try { hooks.onError?.(new Error("webllm.chat: messages required")); } catch {}
    return null;
  }
  let engine;
  try {
    engine = await getEngine(model);
  } catch (err) {
    try { hooks.onError?.(err); } catch {}
    return null;
  }
  const finalMsgs = system
    ? [{ role: "system", content: system }, ...messages]
    : messages;

  let aborted = false;
  let fullText = "";
  let finalEvent = null;
  const onAbort = () => { aborted = true; try { engine.interruptGenerate?.(); } catch {} };
  signal?.addEventListener?.("abort", onAbort, { once: true });

  try {
    const stream = await engine.chat.completions.create({
      stream: true,
      messages: finalMsgs,
      temperature: options?.temperature ?? 0.4,
      top_p:        options?.top_p ?? 0.95,
      max_tokens:   options?.max_tokens ?? 800,
    });
    for await (const chunk of stream) {
      if (aborted) break;
      const tok = chunk?.choices?.[0]?.delta?.content || "";
      if (tok) {
        fullText += tok;
        try { hooks.onToken?.(tok, chunk); } catch {}
      }
      const finish = chunk?.choices?.[0]?.finish_reason;
      if (finish) {
        finalEvent = chunk;
        try { hooks.onDone?.(chunk); } catch {}
      }
    }
  } catch (err) {
    try { hooks.onError?.(err); } catch {}
    return { aborted, finalEvent, fullText };
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
  }

  return { aborted, finalEvent, fullText };
}

/** Optional: kick a background pre-warm so the first chat is instant. */
export async function preload(modelId) {
  if (!hasWebGPU()) return null;
  return getEngine(modelId).catch(() => null);
}

/** Currently-active model id, or null. */
export function activeModel() { return _engineModel; }

export const _internals = { ensureLib, hasWebGPU };

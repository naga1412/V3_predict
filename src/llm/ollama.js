/**
 * My Next Prediction v3.0 — M6 · Ollama HTTP client
 * -------------------------------------------------
 * Talks to a locally-running Ollama daemon at http://localhost:11434.
 *
 *   listModels()                    → ["deepseek-r1:7b", "llama3", …]
 *   ping()                          → boolean (is the daemon reachable?)
 *   generate({model, prompt, …})    → ReadableStream-yielding async fn
 *   chat({model, messages, …})      → same, /api/chat shape
 *
 * Mixed-content note: when the page is served over HTTPS (e.g.
 * GitHub Pages) the browser blocks fetch to plain http://localhost.
 * Calls return null and emit `llm:blocked`.  Locally-served (http)
 * dev / electron wrapper / served-over-cleartext setups work fine.
 */

import { readStream } from "./stream.js";

const DEFAULT_BASE = "http://localhost:11434";

/** Pick the active base URL (env-overridable later via window.__MNP__.llmBase). */
function base() {
  return (typeof window !== "undefined" && window.__MNP__?.llmBase) || DEFAULT_BASE;
}

function isHttpsBlocked() {
  if (typeof window === "undefined") return false;
  if (window.location?.protocol !== "https:") return false;
  const b = base();
  return /^http:\/\//i.test(b);
}

/** True if the daemon responds on /api/version within 2 s. */
export async function ping({ signal } = {}) {
  if (isHttpsBlocked()) return false;
  try {
    const ctl = new AbortController();
    signal?.addEventListener?.("abort", () => ctl.abort(), { once: true });
    const t = setTimeout(() => ctl.abort(), 2000);
    const r = await fetch(`${base()}/api/version`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

/** List installed models. */
export async function listModels({ signal } = {}) {
  if (isHttpsBlocked()) return [];
  try {
    const r = await fetch(`${base()}/api/tags`, { signal });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j?.models) ? j.models.map((m) => m.name).filter(Boolean) : [];
  } catch { return []; }
}

/**
 * Generate a streaming response.
 *
 * @param {{model:string, prompt:string, system?:string, options?:object, signal?:AbortSignal}} args
 * @param {{onToken?:Function, onDone?:Function, onError?:Function}} [hooks]
 * @returns {Promise<{aborted:boolean, finalEvent:object|null, fullText:string}|null>}
 */
export async function generate({ model, prompt, system, options, signal }, hooks = {}) {
  if (isHttpsBlocked()) {
    try { hooks.onError?.(new Error("LLM blocked: page served over HTTPS but Ollama at http://localhost. Run app over http or use electron wrapper.")); } catch {}
    return null;
  }
  if (!model || !prompt) {
    try { hooks.onError?.(new Error("ollama.generate: model + prompt required")); } catch {}
    return null;
  }
  let res;
  try {
    res = await fetch(`${base()}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, prompt,
        system: system || undefined,
        options: options || undefined,
        stream: true,
      }),
      signal,
    });
  } catch (err) {
    try { hooks.onError?.(err); } catch {}
    return null;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    try { hooks.onError?.(new Error(`ollama HTTP ${res.status}: ${txt.slice(0, 200)}`)); } catch {}
    return null;
  }
  return readStream(res, { ...hooks, signal });
}

/**
 * Chat-style generation with a messages array.
 */
export async function chat({ model, messages, system, options, signal }, hooks = {}) {
  if (isHttpsBlocked()) {
    try { hooks.onError?.(new Error("LLM blocked: page served over HTTPS but Ollama at http://localhost.")); } catch {}
    return null;
  }
  if (!model || !Array.isArray(messages) || !messages.length) {
    try { hooks.onError?.(new Error("ollama.chat: model + messages required")); } catch {}
    return null;
  }
  const finalMsgs = system
    ? [{ role: "system", content: system }, ...messages]
    : messages;
  let res;
  try {
    res = await fetch(`${base()}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model, messages: finalMsgs,
        options: options || undefined,
        stream: true,
      }),
      signal,
    });
  } catch (err) {
    try { hooks.onError?.(err); } catch {}
    return null;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    try { hooks.onError?.(new Error(`ollama HTTP ${res.status}: ${txt.slice(0, 200)}`)); } catch {}
    return null;
  }
  return readStream(res, { ...hooks, signal });
}

export const _internals = { base, isHttpsBlocked };

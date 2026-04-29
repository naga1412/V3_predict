/**
 * My Next Prediction v3.0 — M6.5 · LLM Router
 * -------------------------------------------
 * Picks the best available LLM tier and exposes a unified API.
 * Order:
 *   1. user-pinned tier   (localStorage "mnp.llm.tier")
 *   2. Ollama             (local daemon, fastest if running)
 *   3. Web-LLM (WebGPU)   (in-browser, zero-install)
 *   4. null               (caller should show deterministic fallback)
 *
 * Same `{ ping, listModels, generate, chat }` contract as the
 * underlying clients, so AIChatPane is tier-agnostic.
 */

import * as Ollama from "./ollama.js";
import * as WebLLM from "./webllm.js";

const TIER_KEY = "mnp.llm.tier";

/** All known tiers. */
export const TIERS = Object.freeze(["ollama", "webllm"]);

/**
 * Probe each tier's availability.  `ollama.ping()` has a 2 s timeout;
 * `webllm.ping()` is just a WebGPU feature check.
 *
 * @returns {Promise<{ollama:boolean, webllm:boolean}>}
 */
export async function probe() {
  const [ollama, webllm] = await Promise.all([
    Ollama.ping().catch(() => false),
    Promise.resolve(WebLLM.hasWebGPU()),
  ]);
  return { ollama, webllm };
}

/**
 * Pick the active tier.  Honours user pin from localStorage when the
 * pinned tier is actually available.
 *
 * @returns {Promise<{tier:"ollama"|"webllm"|null, status:object}>}
 */
export async function pickTier() {
  const status = await probe();
  let pinned = null;
  try { pinned = localStorage.getItem(TIER_KEY); } catch {}
  if (pinned && status[pinned]) return { tier: pinned, status };
  if (status.ollama) return { tier: "ollama", status };
  if (status.webllm) return { tier: "webllm", status };
  return { tier: null, status };
}

/** Pin a specific tier (or null to clear). */
export function pinTier(tier) {
  try {
    if (tier && TIERS.includes(tier)) localStorage.setItem(TIER_KEY, tier);
    else localStorage.removeItem(TIER_KEY);
  } catch {}
}

/** Pinned tier (or null). */
export function pinnedTier() {
  try { return localStorage.getItem(TIER_KEY) || null; } catch { return null; }
}

/** Resolve the underlying client for a given tier. */
function clientFor(tier) {
  if (tier === "ollama") return Ollama;
  if (tier === "webllm") return WebLLM;
  return null;
}

/* ═══════════════════════════ Unified API ═══════════════════════════ */

export async function listModels(tier) {
  const c = clientFor(tier);
  return c ? c.listModels() : [];
}

export async function generate(args, hooks) {
  const { tier } = await pickTier();
  if (!tier) {
    try { hooks?.onError?.(new Error("no LLM tier available — install Ollama or use a WebGPU browser")); } catch {}
    return null;
  }
  const c = clientFor(tier);
  return c.generate(args, hooks);
}

export async function chat(args, hooks) {
  const { tier } = await pickTier();
  if (!tier) {
    try { hooks?.onError?.(new Error("no LLM tier available — install Ollama or use a WebGPU browser")); } catch {}
    return null;
  }
  const c = clientFor(tier);
  return c.chat(args, hooks);
}

/** Direct dispatch to a specific tier (used by the UI when the user toggles). */
export async function chatVia(tier, args, hooks) {
  const c = clientFor(tier);
  if (!c) return null;
  return c.chat(args, hooks);
}
export async function generateVia(tier, args, hooks) {
  const c = clientFor(tier);
  if (!c) return null;
  return c.generate(args, hooks);
}

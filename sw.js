/**
 * My Next Prediction v3.0 — Service Worker
 * ----------------------------------------
 * Strategy:
 *   - App shell: cache-first with background update (fast cold load, scenario UX)
 *   - CDN libs:  stale-while-revalidate (always eventually fresh)
 *   - API/WS:    never cached (handled at network layer)
 * Scenarios covered: cold-load perf, offline shell (#39), SW update flow (#62)
 */

const SW_VERSION = "mnp-v3-phase11.1-1";
const SHELL_CACHE = `${SW_VERSION}-shell`;
const CDN_CACHE   = `${SW_VERSION}-cdn`;

const SHELL = [
  "./",
  "./index.html",
  "./public/theme.css",
  // core
  "./src/core/bootstrap.js",
  "./src/core/capabilities.js",
  "./src/core/resilience.js",
  "./src/core/bus.js",
  // data layer (phase 1)
  "./src/data/idb.js",
  "./src/data/schema.js",
  "./src/data/candleValidator.js",
  "./src/data/candleBuffer.js",
  "./src/data/clockSkew.js",
  "./src/data/gapFiller.js",
  "./src/data/leaderElection.js",
  "./src/data/feedManager.js",
  "./src/data/exchanges/binance.js",
  "./src/data/exchanges/bybit.js",
  "./src/data/exchanges/index.js",
  // data layer (phase 2)
  "./src/data/compress.js",
  "./src/data/integrity.js",
  "./src/data/crypto.js",
  "./src/data/opfs.js",
  "./src/data/shardWriter.js",
  "./src/data/retention.js",
  "./src/data/storageManager.js",
  "./src/data/backup.js",
  // ta engine (phase 3)
  "./src/ta/math.js",
  "./src/ta/engine.js",
  "./src/ta/indicators/moving.js",
  "./src/ta/indicators/oscillators.js",
  "./src/ta/indicators/bands.js",
  "./src/ta/indicators/volatility.js",
  "./src/ta/indicators/volume.js",
  "./src/ta/indicators/parabolic.js",
  "./src/ta/indicators/ichimoku.js",
  "./src/ta/indicators/cci.js",
  "./src/ta/indicators/williamsr.js",
  "./src/ta/indicators/mfi.js",
  "./src/ta/patterns/candles.js",
  "./src/ta/structure/swings.js",
  "./src/ta/structure/bos.js",
  "./src/ta/structure/fvg.js",
  "./src/ta/levels/supportResistance.js",
  // phase 4 — smc completion + worker offload
  "./src/ta/structure/orderBlocks.js",
  "./src/ta/structure/liquidity.js",
  "./src/ta/structure/premiumDiscount.js",
  "./src/ta/structure/sessions.js",
  "./src/ta/engineProxy.js",
  "./src/workers/taWorker.js",
  // phase 5 — labels + feature store
  "./src/ml/labels.js",
  "./src/ml/features.js",
  "./src/ml/normalize.js",
  "./src/ml/splits.js",
  "./src/ml/featureStore.js",
  // phase 6 — regime + calendar
  "./src/regime/classifier.js",
  "./src/regime/stateMachine.js",
  "./src/regime/calendar.js",
  // phase 7 — 12 modules + orchestrator + calibration
  "./src/modules/baseModule.js",
  "./src/modules/trendFollow.js",
  "./src/modules/meanReversion.js",
  "./src/modules/momentum.js",
  "./src/modules/breakout.js",
  "./src/modules/supportResistance.js",
  "./src/modules/volatilityRegime.js",
  "./src/modules/volumeProfile.js",
  "./src/modules/candlePatterns.js",
  "./src/modules/orderBlocks.js",
  "./src/modules/liquidity.js",
  "./src/modules/premiumDiscount.js",
  "./src/modules/sessionCalendar.js",
  "./src/modules/registry.js",
  "./src/modules/orchestrator.js",
  "./src/modules/cisd.js",
  "./src/ml/calibration.js",
  // phase 8 — NN + per-regime ensemble (worker-trained)
  "./src/ml/rng.js",
  "./src/ml/nn.js",
  "./src/ml/ensemble.js",
  "./src/ml/trainer.js",
  "./src/ml/modelStore.js",
  "./src/workers/trainingWorker.js",
  // phase 9 — conformal prediction intervals
  "./src/ml/conformal.js",
  "./src/ml/conformalStore.js",
  // phase 11 — ghost candles (conformal forward projection) + persistence
  "./src/ml/ghostCandles.js",
  "./src/ml/ghostStore.js",
  // phase 10 — auto-validation + drift monitor
  "./src/validation/predictionStore.js",
  "./src/validation/validator.js",
  "./src/validation/drift.js",
  "./src/validation/monitor.js",
  // ui
  "./src/ui/App.jsx",
];

const CDN_HOSTS = ["unpkg.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL).catch(() => { /* tolerate missing files during dev */ });
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, CDN_CACHE]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache WebSocket upgrades, API, Ollama, or long-poll
  if (url.protocol === "ws:" || url.protocol === "wss:") return;
  if (url.hostname === "localhost" && url.port === "11434") return; // Ollama
  if (/\.(binance|bybit|okx|coinbase)\./.test(url.hostname)) return;

  // CDN — stale-while-revalidate
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(swr(req, CDN_CACHE));
    return;
  }

  // Same-origin shell — cache-first with network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    // Kick off background revalidation
    fetch(req).then((res) => res.ok && cache.put(req, res.clone())).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return new Response("offline", { status: 503, statusText: "offline", headers: { "content-type": "text/plain" } });
  }
}

async function swr(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fetchPromise;
}

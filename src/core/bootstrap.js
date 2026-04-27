/**
 * My Next Prediction v3.0 — Bootstrap
 * -----------------------------------
 * Deterministic boot sequence:
 *   1. Detect capabilities
 *   2. Register Service Worker
 *   3. Wire cross-cutting events (net, visibility, quota)
 *   4. Register health probes
 *   5. Apply UI decisions (a11y, degrade banner)
 *   6. Hand off to React App.jsx (which is loaded via <script type="text/babel">)
 *
 * Scenarios covered: most of §A.3, §A.4, §A.5 from the v3 plan.
 */

import { detectCapabilities, classifyTier, summarize } from "./capabilities.js";
import { EventBus } from "./bus.js";
import { Health, wireNetworkEvents, wireVisibility, wireQuotaWatcher, degrade } from "./resilience.js";
import { openDB, metaGet, metaSet, count as idbCount } from "../data/idb.js";
import * as ClockSkew from "../data/clockSkew.js";
// Import data-layer surface here (pure ES) and expose to window so App.jsx
// can use them WITHOUT needing `import` (Babel-standalone blob URLs break
// relative imports).
import { FeedManager } from "../data/feedManager.js";
import { getStored } from "../data/gapFiller.js";
import * as IDB from "../data/idb.js";
// Phase 2 — storage hardening surfaces
import * as Compress from "../data/compress.js";
import * as CryptoLayer from "../data/crypto.js";
import * as Integrity from "../data/integrity.js";
import * as OPFS from "../data/opfs.js";
import * as Shard from "../data/shardWriter.js";
import * as Retention from "../data/retention.js";
import * as Storage from "../data/storageManager.js";
import * as Backup from "../data/backup.js";
// Phase 3 — TA engine
import { TAEngine } from "../ta/engine.js";
// Phase 4 — TA Engine worker proxy
import { TAEngineProxy } from "../ta/engineProxy.js";
// Phase 5 — Labels / features / feature store
import * as Labels from "../ml/labels.js";
import * as Features from "../ml/features.js";
import * as Normalize from "../ml/normalize.js";
import * as Splits from "../ml/splits.js";
import * as FeatureStore from "../ml/featureStore.js";
// Phase 6 — Regime classifier, state machine, event calendar
import * as RegimeClassifier from "../regime/classifier.js";
import * as RegimeSM from "../regime/stateMachine.js";
import * as RegimeCalendar from "../regime/calendar.js";
// Phase 7 — 12 analysis modules + ensemble orchestrator + calibration
//   + Phase 7b: CISD structural module (13th)
import * as BaseModule from "../modules/baseModule.js";
import * as ModulesRegistry from "../modules/registry.js";
import * as Orchestrator from "../modules/orchestrator.js";
import * as Calibration from "../ml/calibration.js";
import * as CISD from "../modules/cisd.js";
// Phase 8 — NN + per-regime ensemble (worker-trained)
import * as RNG from "../ml/rng.js";
import * as NN from "../ml/nn.js";
import * as Ensemble from "../ml/ensemble.js";
import { Trainer, tripleBarrierToBinary } from "../ml/trainer.js";
import * as ModelStore from "../ml/modelStore.js";
// Phase 9 — Conformal prediction intervals
import * as Conformal from "../ml/conformal.js";
import * as ConformalStore from "../ml/conformalStore.js";
// Phase 11 — Ghost candles (conformal forward projection) + persistence
import * as GhostCandles from "../ml/ghostCandles.js";
import * as GhostStore   from "../ml/ghostStore.js";
// M3 step 5 — Enhanced volume profile (VAH/VAL/POC/HVN/LVN/TPO)
import * as VolumeProfile from "../ta/profile/volumeProfileEnhanced.js";
// M3 step 6 — Trendlines + chart patterns
import * as Trendlines    from "../ta/structure/trendlines.js";
import * as ChartPatterns from "../ta/patterns/chartPatterns.js";
// M3.5 — Multi-asset universe + dynamic Binance crypto loader
import * as Universe        from "../data/universe.js";
import { fetchCryptoUniverse } from "../data/cryptoUniverse.js";
// M4a — News + sentiment + macro categorisation
import * as Sentiment   from "../news/sentiment.js";
import * as NewsCats    from "../news/categories.js";
import * as RSS         from "../news/rss.js";
import * as NewsManager from "../news/newsManager.js";
// M4b — Wyckoff phase + macro Risk-ON/OFF
import * as Wyckoff from "../regime/wyckoff.js";
import * as Macro   from "../regime/macro.js";
// Phase 10 — Auto-validation + drift monitor
import * as PredictionStore from "../validation/predictionStore.js";
import * as Validator from "../validation/validator.js";
import * as Drift from "../validation/drift.js";
import { ValidationMonitor, createDefaultMonitor } from "../validation/monitor.js";

const log = (...a) => console.log("%c[MNP]%c", "color:#2962ff;font-weight:bold", "color:inherit", ...a);

function setStep(msg) {
  const el = document.getElementById("mnp-splash-step");
  if (el) el.textContent = msg;
}

export async function boot() {
  log("bootstrap start");
  setStep("detecting capabilities…");
  const caps = await detectCapabilities();
  const sum  = summarize(caps);
  log("capabilities", sum, caps);

  // Expose runtime surface for App.jsx (no `import` inside JSX due to
  // Babel-standalone blob-URL resolution limits).
  // NOTE: hideSplash must be exposed here (not later) because App.jsx's
  // mount-effect reads it the moment it sees `caps` populated, which is
  // before the rest of the boot sequence finishes awaiting.
  window.__MNP__ = {
    caps,
    EventBus,
    FeedManager,
    getStored,
    ClockSkew,
    IDB,
    hideSplash,
    // Phase 2
    Compress,
    Crypto: CryptoLayer,
    Integrity,
    OPFS,
    Shard,
    Retention,
    Storage,
    Backup,
    // Phase 3
    TAEngine,
    // Phase 4
    TAEngineProxy,
    // Phase 5
    Labels,
    Features,
    Normalize,
    Splits,
    FeatureStore,
    // Phase 6
    RegimeClassifier,
    RegimeSM,
    RegimeCalendar,
    // Phase 7
    BaseModule,
    Modules: ModulesRegistry,
    Orchestrator,
    Calibration,
    CISD,
    // Phase 8
    RNG,
    NN,
    Ensemble,
    Trainer,
    tripleBarrierToBinary,
    ModelStore,
    // Phase 9
    Conformal,
    ConformalStore,
    // Phase 11
    GhostCandles,
    GhostStore,
    // M3 step 5
    VolumeProfile,
    // M3 step 6
    Trendlines,
    ChartPatterns,
    // M3.5
    Universe,
    fetchCryptoUniverse,
    // M4a
    Sentiment,
    NewsCats,
    RSS,
    NewsManager,
    // M4b
    Wyckoff,
    Macro,
    // Phase 10
    PredictionStore,
    Validator,
    Drift,
    ValidationMonitor,
    createDefaultMonitor,
    version: "3.0.0-m4b",
  };

  // Degrade decisions ------------------------------------------------------
  if (!caps.indexedDB)   degrade("no-idb",  "IndexedDB unavailable; large storage disabled");
  if (caps.privateMode)  degrade("private", "Private/Incognito — persistence limited");
  if (!caps.workers)     degrade("no-workers", "Web Workers unavailable; UI may jank during training");
  if (!caps.webCrypto)   degrade("no-crypto",  "WebCrypto unavailable; encryption-at-rest disabled");
  if (!caps.websocket)   degrade("no-ws",      "WebSocket unavailable; live feed disabled");

  showDegradeBannerIfNeeded();

  // Service Worker --------------------------------------------------------
  setStep("installing service worker…");
  await registerServiceWorker(caps);

  // IndexedDB -------------------------------------------------------------
  if (caps.indexedDB) {
    setStep("opening database…");
    try {
      await openDB();
      const installedAt = await metaGet("installedAt");
      if (!installedAt) await metaSet("installedAt", Date.now());
      await metaSet("lastOpenedAt", Date.now());
      const candleCount = await idbCount("candles");
      log("idb ready · candles:", candleCount);
    } catch (err) {
      console.error("[MNP] idb open failed", err);
      degrade("idb-open", err?.message || String(err));
    }
  }

  // Clock skew monitor ----------------------------------------------------
  setStep("syncing clock with exchange…");
  try { await ClockSkew.probeOnce(); } catch { /* will retry via timer */ }
  ClockSkew.start({ intervalMs: 60_000 });

  // Cross-cutting --------------------------------------------------------
  setStep("wiring events…");
  wireNetworkEvents();
  wireVisibility();
  wireQuotaWatcher({ intervalMs: 60_000 });

  // Health probes (stubs — real ones added in later phases) -------------
  setStep("registering health probes…");
  Health.register("network",  () => navigator.onLine, { intervalMs: 10_000 });
  Health.register("storage",  async () => {
    if (!navigator.storage?.estimate) return true;
    const { quota, usage } = await navigator.storage.estimate();
    return !quota || (usage / quota) < 0.95;
  }, { intervalMs: 60_000 });
  Health.start();

  // Phase 2 — storage hardening -----------------------------------------
  setStep("starting storage monitor…");
  Storage.startMonitor({ intervalMs: 30_000 });
  // Retention sweep runs daily; covers the symbols/tfs the user cares about.
  // We seed it with the Phase-1 defaults and let later UI expand them.
  Retention.startSweeper({
    symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"],
    tfs:     ["1m", "5m", "15m", "1h", "4h", "1d"],
    intervalMs: 24 * 60 * 60 * 1000,
  });

  // Wire a few log listeners so Phase 0 is observable -------------------
  EventBus.on("degrade", ({ flag, reason }) => log("degrade:", flag, "—", reason));
  EventBus.on("net",     ({ online }) => log("net:", online ? "online" : "offline"));
  EventBus.on("health",  ({ name, ok }) => log("health:", name, ok ? "ok" : "FAIL"));
  EventBus.on("quota:low", ({ freePct }) => log("quota low:", (freePct*100).toFixed(1)+"% free"));

  // Splash handoff ------------------------------------------------------
  setStep(`ready · tier=${classifyTier(caps).tier} · compute=${sum.compute} · storage=${sum.storage}`);
  // The React App (App.jsx) will call hideSplash() when mounted.
  window.__MNP__.hideSplash = hideSplash;

  log("bootstrap complete", sum);
  EventBus.emit("boot:complete", { caps, summary: sum });

  // M4a — Kick off the news manager.  Hydrates from IDB on first call,
  // schedules a fetch ~4 s after start (so it doesn't compete with the
  // splash → React mount path), then auto-refreshes every 10 minutes.
  NewsManager.start({ intervalMs: 10 * 60 * 1000 }).catch((err) => {
    log("news:start failed", err?.message || err);
  });

  // M3.5 — Kick off dynamic crypto universe load in the background.
  // Doesn't block the splash; emits `universe:ready` when the merge
  // completes (or `universe:error` if both endpoints fail).  The seed
  // universe (~1k stocks/ETFs/forex/commodities/indices) is already
  // live; this adds Binance's full ~3k spot+futures list.
  fetchCryptoUniverse().then((res) => {
    log("universe:crypto loaded", res);
    EventBus.emit("universe:ready", { count: res.count, sources: res.sources, fromCache: res.fromCache });
  }).catch((err) => {
    log("universe:crypto failed", err?.message || err);
    EventBus.emit("universe:error", { error: err?.message || String(err) });
  });
}

async function registerServiceWorker(caps) {
  if (!caps.serviceWorker) return;
  try {
    const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    log("sw registered", reg.scope);
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          EventBus.emit("sw:update-available");
          log("sw update available");
        }
      });
    });
  } catch (err) {
    console.warn("[MNP] sw register failed", err);
    degrade("no-sw", "Service Worker registration failed; cold load will be slower");
  }
}

function showDegradeBannerIfNeeded() {
  // Only shown if something non-trivial is degraded
  const flags = (window.__MNP__?.caps?.privateMode && ["private"]) || [];
  if (!flags.length) return;
  const el = document.createElement("div");
  el.className = "degrade-banner";
  el.textContent = "⚠ Running in limited mode — data will not persist across sessions (private browsing detected).";
  document.body.prepend(el);
}

function hideSplash() {
  const s = document.getElementById("mnp-splash");
  if (!s) return;
  s.classList.add("hide");
  setTimeout(() => s.remove(), 260);
}

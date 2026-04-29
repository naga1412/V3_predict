/*
  My Next Prediction v3.0 — Cockpit UI (Phase 10.5)
  --------------------------------------------------
  A full trading cockpit surfacing every engine built in Phases 1–10:

    Phase 1/2  → FeedManager live candles + IDB history
    Phase 3/4  → TAEngine indicators + structure (BOS/FVG/OB/Liquidity/SR)
    Phase 6    → Regime classifier tag
    Phase 7    → 13-module orchestrator  → MasterBias + per-module breakdown
    Phase 8    → NN + Ensemble           → Deep-Learning Supervisor
    Phase 9    → Conformal intervals     → expected-move band
    Phase 10   → ValidationMonitor       → live accuracy + drift banner

  Architectural notes:
  • No ES imports (Babel-standalone blob-URL restriction). Engines come
    from window.__MNP__ populated by bootstrap.js.
  • Chart uses lightweight-charts@4.1.1 (global: LightweightCharts).
  • Sub-components + hooks live in this file to keep the build simple.
*/

const { useEffect, useState, useCallback, useRef, useMemo, useLayoutEffect } = React;

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  A11y + utility hooks                                            ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function useAnnouncer() {
  const ref = useRef(null);
  useEffect(() => { ref.current = document.getElementById("mnp-live"); }, []);
  return useCallback((msg) => { if (ref.current) ref.current.textContent = msg; }, []);
}

function useBus(topic, initial) {
  const [v, setV] = useState(initial);
  useEffect(() => {
    const bus = window.__MNP__?.EventBus;
    if (!bus) return;
    return bus.on(topic, setV);
  }, [topic]);
  return v;
}

function useBusEvent(topic, handler) {
  const saved = useRef(handler);
  useEffect(() => { saved.current = handler; }, [handler]);
  useEffect(() => {
    const bus = window.__MNP__?.EventBus;
    if (!bus) return;
    return bus.on(topic, (e) => { try { saved.current?.(e); } catch (err) { console.error(err); } });
  }, [topic]);
}

/**
 * Aggregate the health/circuit/storage/SW events the bus emits but that the UI
 * previously ignored.  Returns { health: {name: ok}, circuits: {name: state},
 * quota: {freePct}, swUpdate: bool, idbBlocked: bool, toasts: [] }.
 */
function useSystemEvents(pushToast) {
  const [state, setState] = useState({
    health: {}, circuits: {}, quota: null, swUpdate: false, idbBlocked: false,
    leader: "unknown", degradeFlags: [], lastExchangeSwitch: null,
  });
  // Keep a stable push reference
  const toastRef = useRef(pushToast);
  useEffect(() => { toastRef.current = pushToast; }, [pushToast]);
  const push = useCallback((t) => toastRef.current?.(t), []);

  useBusEvent("health", (m) => setState(s => ({ ...s, health: { ...s.health, [m.name]: m.ok } })));
  useBusEvent("circuit:open",  (m) => {
    setState(s => ({ ...s, circuits: { ...s.circuits, [m.name]: "open" } }));
    push({ tone: "warn", text: `Circuit "${m.name}" opened — degrading` });
  });
  useBusEvent("circuit:close", (m) => {
    setState(s => ({ ...s, circuits: { ...s.circuits, [m.name]: "closed" } }));
    push({ tone: "bull", text: `Circuit "${m.name}" recovered` });
  });
  useBusEvent("degrade", (m) => {
    setState(s => ({ ...s, degradeFlags: Array.from(new Set([...s.degradeFlags, m.flag])) }));
    push({ tone: "warn", text: `⚠ ${m.flag} · ${m.reason}` });
  });
  useBusEvent("restore", (m) => {
    setState(s => ({ ...s, degradeFlags: s.degradeFlags.filter(f => f !== m.flag) }));
    push({ tone: "bull", text: `Restored · ${m.flag}` });
  });
  useBusEvent("quota",      (m) => setState(s => ({ ...s, quota: m })));
  useBusEvent("quota:low",  (m) => push({ tone: "warn", text: `Storage low · ${((m.freePct||0)*100).toFixed(1)}% free` }));
  useBusEvent("quota:exceeded", () => push({ tone: "bear", text: "Storage quota exceeded — oldest data will be pruned" }));
  useBusEvent("sw:update-available", () => {
    setState(s => ({ ...s, swUpdate: true }));
    push({ tone: "accent", text: "New version available — reload to apply", action: { label: "Reload", fn: () => location.reload() } });
  });
  useBusEvent("idb:blocked", () => {
    setState(s => ({ ...s, idbBlocked: true }));
    push({ tone: "warn", text: "IndexedDB upgrade blocked — close other tabs" });
  });
  useBusEvent("idb:versionchange", () => push({ tone: "warn", text: "Database schema changed in another tab" }));
  useBusEvent("feed:failover", (m) => {
    setState(s => ({ ...s, lastExchangeSwitch: m }));
    push({ tone: "accent", text: `Feed switched · ${m.from || "?"} → ${m.to || m.exchange || "?"}` });
  });
  useBusEvent("feed:backfill", (m) => m?.count && push({ tone: "accent", text: `Backfilled ${m.count} candles · ${m.symbol} ${m.tf}` }));
  useBusEvent("feed:error",  (m) => push({ tone: "bear", text: `Feed error · ${m?.reason || m?.message || "unknown"}` }));
  useBusEvent("feed:invalid",(m) => push({ tone: "warn", text: `Invalid candle · ${m?.reason || "?"}` }));
  useBusEvent("feed:gap-fill-fail", () => push({ tone: "warn", text: "Gap back-fill failed; will retry" }));
  useBusEvent("storage:near-quota", (m) => push({ tone: "warn", text: `Storage near quota · ${((m?.freePct||0)*100).toFixed(1)}% free` }));
  useBusEvent("leader:status", (m) => setState(s => ({ ...s, leader: m?.role || s.leader })));
  useBusEvent("validation:error", (m) => push({ tone: "bear", text: `Validation error · ${m?.reason || "unknown"}` }));
  useBusEvent("clockskew:stale", () => push({ tone: "warn", text: "Clock skew probe stale — network or CORS issue" }));

  return state;
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Error boundary                                                  ║
   ╚══════════════════════════════════════════════════════════════════╝ */

class ErrorBoundary extends React.Component {
  constructor(p){ super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err){ return { err }; }
  componentDidCatch(err, info){ console.error("[MNP] UI crash", err, info); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ margin: 40, padding: 20, background: "var(--bg-elev-1)",
                    border: "1px solid var(--bear)", borderRadius: 10 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Something broke 🧯</div>
        <div style={{ color: "var(--fg-dim)", marginBottom: 12, fontFamily: "var(--font-mono)", fontSize: 12 }}>
          {String(this.state.err?.message || this.state.err)}
        </div>
        <button className="btn-primary" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Constants / catalog                                             ║
   ╚══════════════════════════════════════════════════════════════════╝ */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT"];
const TFS     = ["1m", "5m", "15m", "1h", "4h", "1d"];

const INDICATOR_CATALOG = [
  { id: "ema20",  label: "EMA 20",  color: "#2962ff", kind: "ema",  period: 20 },
  { id: "ema50",  label: "EMA 50",  color: "#ff9800", kind: "ema",  period: 50 },
  { id: "ema200", label: "EMA 200", color: "#e91e63", kind: "ema",  period: 200 },
  { id: "vwap",   label: "VWAP",    color: "#b388ff", kind: "vwap" },
  { id: "bbUp",   label: "BB Upper",color: "#26a69a66", kind: "bbUp" },
  { id: "bbLo",   label: "BB Lower",color: "#ef535066", kind: "bbLo" },
  { id: "psar",   label: "Parabolic SAR", color: "#ffb74d", kind: "psar" },
  { id: "ichiTenkan", label: "Ichimoku Tenkan", color: "#29b6f6", kind: "ichi", field: "tenkan" },
  { id: "ichiKijun",  label: "Ichimoku Kijun",  color: "#ab47bc", kind: "ichi", field: "kijun" },
  { id: "ichiCloudA", label: "Ichimoku Senkou A", color: "#26a69a99", kind: "ichi", field: "senkouA" },
  { id: "ichiCloudB", label: "Ichimoku Senkou B", color: "#ef535099", kind: "ichi", field: "senkouB" },
  { id: "ichiChikou", label: "Ichimoku Chikou", color: "#ffd54f", kind: "ichi", field: "chikou" },
];

// Oscillator subplots rendered in their own lightweight-charts panes below the main chart
const SUBPLOT_CATALOG = [
  { id: "volume", label: "Volume",     tone: "accent", height: 90 },
  { id: "rsi",    label: "RSI 14",     tone: "bull",   height: 100 },
  { id: "macd",   label: "MACD",       tone: "accent", height: 110 },
  { id: "stoch",  label: "Stochastic", tone: "warn",   height: 100 },
  { id: "cci",    label: "CCI 20",     tone: "accent", height: 100 },
  { id: "wr",     label: "Williams %R",tone: "bear",   height: 100 },
  { id: "mfi",    label: "MFI 14",     tone: "bull",   height: 100 },
  { id: "obv",    label: "OBV",        tone: "accent", height: 100 },
  { id: "cmf",    label: "CMF 20",     tone: "warn",   height: 100 },
  { id: "adx",    label: "ADX 14",     tone: "bear",   height: 100 },
];

const STRUCTURE_CATALOG = [
  { id: "bos",        label: "BOS / CHoCH",    tone: "warn"   },
  { id: "fvg",        label: "FVG",            tone: "accent" },
  { id: "ob",         label: "Order Blocks",   tone: "accent" },
  { id: "liq",        label: "Liquidity",      tone: "bull"   },
  { id: "sr",         label: "S/R",            tone: "accent" },
  { id: "pdh",        label: "PDH / PDL",      tone: "warn"   },
  { id: "pd",         label: "Premium/Disc.",  tone: "accent" },
  { id: "ghost",      label: "Ghost candle",   tone: "accent" },
  { id: "volProfile", label: "Volume Profile", tone: "warn"   },
  { id: "trendlines", label: "Trendlines",     tone: "accent" },
  { id: "patterns",   label: "Patterns",       tone: "warn"   },
];

const MODULE_META = {
  "trend-follow":     { emoji: "📈", label: "Trend Follow"    },
  "mean-reversion":   { emoji: "↔️", label: "Mean Reversion"  },
  "momentum":         { emoji: "⚡",  label: "Momentum"        },
  "breakout":         { emoji: "🚀", label: "Breakout"        },
  "support-resistance":{emoji: "🧱", label: "Support / Resist"},
  "volatility-regime":{emoji: "🌪️", label: "Volatility Regime"},
  "volume-profile":   { emoji: "📊", label: "Volume Profile"  },
  "candle-patterns":  { emoji: "🕯️", label: "Candle Patterns" },
  "order-blocks":     { emoji: "📦", label: "Order Blocks"    },
  "liquidity":        { emoji: "💧", label: "Liquidity"       },
  "premium-discount": { emoji: "💎", label: "Premium/Disc."   },
  "session-calendar": { emoji: "🕐", label: "Session / Cal."  },
  "cisd":             { emoji: "🧬", label: "CISD"            },
  "trendline":        { emoji: "📐", label: "Trendlines"      },
  "chart-patterns":   { emoji: "🔱", label: "Chart Patterns"  },
};

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Data hooks                                                      ║
   ╚══════════════════════════════════════════════════════════════════╝ */

/**
 * Load and live-update the candle history for (symbol, tf).
 * - Pulls last N from IDB on mount.
 * - Starts a FeedManager, tracks forming + closed updates.
 * - Returns { candles, forming, status, exchange, role, bootstrapCount, gaps }
 */
function useCandleSeries(symbol, tf, limit = 500) {
  const [candles, setCandles] = useState([]);
  const [forming, setForming] = useState(null);
  const [status, setStatus] = useState({ status: "idle" });
  const [bootstrapCount, setBootstrapCount] = useState(0);
  const [exchange, setExchange] = useState(null);
  const [role, setRole] = useState("unknown");
  const [gaps, setGaps] = useState(0);
  const feedRef = useRef(null);

  // Hydrate from IDB then start feed.
  useEffect(() => {
    let cancelled = false;
    let fm = null;
    setCandles([]); setForming(null);
    (async () => {
      const mnp = window.__MNP__;
      if (!mnp) return;
      // 1. IDB history
      try {
        const hist = await mnp.getStored({ symbol, tf, limit });
        if (!cancelled && Array.isArray(hist) && hist.length) {
          setCandles(hist.slice().sort((a, b) => a.t - b.t));
        }
      } catch (err) { console.warn("[ui] history load failed", err); }
      // 2. Feed
      try {
        fm = new mnp.FeedManager({ symbol, tf });
        feedRef.current = fm;
        await fm.start();
        if (cancelled) return;
        const snap = fm.getSnapshot();
        setExchange(snap.exchange);
        setRole(snap.role);
        if (snap.forming) setForming(snap.forming);
      } catch (err) { console.error("[ui] feed start failed", err); }
    })();
    return () => {
      cancelled = true;
      (async () => { try { await fm?.stop(); } catch {} })();
      feedRef.current = null;
    };
  }, [symbol, tf, limit]);

  // Event subscriptions (closed candles, forming ticks, status)
  useBusEvent("feed:close", (m) => {
    if (m.symbol !== symbol || m.tf !== tf || !m.candle) return;
    setCandles(prev => {
      const next = prev.slice();
      // replace if same t, else append (sorted insert)
      const i = next.findIndex(c => c.t === m.candle.t);
      if (i >= 0) next[i] = m.candle;
      else next.push(m.candle);
      // keep within limit
      if (next.length > limit) next.splice(0, next.length - limit);
      return next;
    });
    setForming(null);
  });
  useBusEvent("feed:update", (m) => {
    if (m.symbol !== symbol || m.tf !== tf) return;
    if (m.candle) setForming(m.candle);
  });
  useBusEvent("feed:status", (m) => {
    if (m.symbol !== symbol || m.tf !== tf) return;
    setStatus(m);
    if (m.role) setRole(m.role);
    if (m.exchange) setExchange(m.exchange);
  });
  useBusEvent("feed:bootstrap", (m) => {
    if (m.symbol !== symbol || m.tf !== tf) return;
    setBootstrapCount(m.count || 0);
    // reload history after bootstrap settles
    (async () => {
      try {
        const hist = await window.__MNP__.getStored({ symbol, tf, limit });
        if (Array.isArray(hist) && hist.length) setCandles(hist.slice().sort((a,b)=>a.t-b.t));
      } catch {}
    })();
  });
  useBusEvent("feed:gap", (m) => {
    if (m.symbol === symbol && m.tf === tf) setGaps(g => g + 1);
  });

  return { candles, forming, status, bootstrapCount, exchange, role, gaps };
}

/**
 * Run TAEngine.compute on a candle array.  Memoized on the closed-candle
 * length + last-t so it recomputes only when a new candle arrives.
 */
function useTASnapshot(candles) {
  return useMemo(() => {
    if (!Array.isArray(candles) || candles.length < 30) return null;
    const TA = window.__MNP__?.TAEngine;
    if (!TA) return null;
    try { return TA.compute(candles); }
    catch (err) { console.warn("[ui] TAEngine.compute failed", err); return null; }
  // eslint-disable-next-line
  }, [candles.length, candles[candles.length - 1]?.t]);
}

/**
 * Run orchestrator against a TA snapshot → ensemble decision + signals.
 */
function useOrchestration(ta) {
  return useMemo(() => {
    if (!ta || ta.empty) return null;
    const Orch = window.__MNP__?.Orchestrator;
    if (!Orch?.runModules) return null;
    try { return Orch.runModules(ta, {}); }
    catch (err) { console.warn("[ui] orchestrator failed", err); return null; }
  }, [ta]);
}

/**
 * Conformal band (Phase 9) — if a saved model / calibration exists, wrap
 * the orchestration rawScore with a symmetric residual interval.  When no
 * calibration data is available yet, fall back to a heuristic magnitude
 * derived from ATR.
 */
function useExpectedMove(ta, orch) {
  return useMemo(() => {
    if (!ta || ta.empty || !orch) return null;
    const last = ta.close?.[ta.close.length - 1];
    const atr  = Array.isArray(ta.atr14) ? ta.atr14[ta.atr14.length - 1] : ta.atr14;
    if (!Number.isFinite(last) || !Number.isFinite(atr)) return null;
    // Directional bias translated into expected move: scale ATR by |rawScore|
    const bias = Math.max(-1, Math.min(1, orch.rawScore || 0));
    const magnitude = Math.abs(bias) * atr * 1.25;   // ~1.25 ATR at full-bias
    const direction = bias >= 0 ? +1 : -1;
    const point = last + direction * magnitude;
    const band  = atr * 0.85;                        // ±ATR·0.85 (≈80% heuristic band)
    return { last, atr, bias, direction, magnitude, point, lo: point - band, hi: point + band };
  }, [ta, orch]);
}

/**
 * Ghost candles (Phase 11) — forward-projected OHLC + conformal confidence band.
 *
 * Attempts to load the most-recent saved SplitConformalRegressor from the
 * ConformalStore once on mount.  If none exists (cold install / no training
 * yet) the forecaster falls back to an ATR·√horizon heuristic band.
 *
 * Returns null until a TA snapshot + orchestration are available.
 */
/**
 * Map the most-recent candlestick patterns (last ≤ 3 bars) into a single
 * bias score in [-1, +1].  Bullish patterns push positive, bearish push
 * negative.  Doji and ambiguous patterns contribute 0.
 *
 * The decay across recency-bars matches the ghost forecast's λ=0.18 so
 * an old pattern doesn't dominate fresh price action.
 */
function derivePatternBias(ta) {
  if (!ta || !Array.isArray(ta.patterns) || ta.patterns.length === 0) return 0;
  const bullSet = new Set(["hammer", "bullEngulf", "bullHarami", "morningStar", "invHammer"]);
  const bearSet = new Set(["bearEngulf", "bearHarami", "eveningStar"]);
  // Walk backwards through the last 3 hits.
  let score = 0;
  let weight = 0;
  const tail = ta.patterns.slice(-3).reverse();
  for (let r = 0; r < tail.length; r++) {
    const decay = Math.exp(-0.18 * r);
    const names = (tail[r] && Array.isArray(tail[r].patterns)) ? tail[r].patterns : [];
    for (const name of names) {
      if (bullSet.has(name))      { score += decay;   weight += decay; }
      else if (bearSet.has(name)) { score -= decay;   weight += decay; }
      // doji etc → ignore
    }
  }
  if (weight <= 0) return 0;
  // Average across all sampled patterns; keep bounded to [-1,+1].
  const v = score / weight;
  return Math.max(-1, Math.min(1, v));
}

function useGhostCandles(ta, orch, candles, { nBars = 25, alpha = 0.1, symbol, tf, patternBias = 0 } = {}) {
  const [conformal, setConformal] = useState(null);
  // M-LEARN-3 — meta-veto: re-check the live feature vector against
  // the anti-pattern store on every bar.  When a match lands, this
  // returns an "adjusted" orch (signal softened or zeroed) which is
  // what then feeds predictGhostCandles below.
  const [vetoedOrch, setVetoedOrch] = useState(orch);
  const [vetoInfo,   setVetoInfo]   = useState(null);
  useEffect(() => {
    let cancelled = false;
    const MV = window.__MNP__?.MetaVeto;
    if (!MV?.applyVetoToOrch || !orch) { setVetoedOrch(orch); setVetoInfo(null); return; }
    const fv = ta?.lastFeatureVec || orch?.featureVec || null;
    if (!Array.isArray(fv) || fv.length === 0) { setVetoedOrch(orch); setVetoInfo(null); return; }
    (async () => {
      try {
        const verdict = await MV.applyVetoToOrch(orch, fv, { regime: ta?.regime?.label });
        if (cancelled) return;
        setVetoInfo(verdict);
        setVetoedOrch(verdict.vetoed ? MV.applyToOrch(orch, verdict) : orch);
        if (verdict.vetoed) {
          try { window.__MNP__?.EventBus?.emit?.("meta:veto", verdict); } catch {}
        }
      } catch { setVetoedOrch(orch); setVetoInfo(null); }
    })();
    return () => { cancelled = true; };
  }, [orch?.rawScore, orch?.direction, ta?.lastFeatureVec, ta?.regime?.label]);

  // Try to hydrate a previously-calibrated regressor from IDB (fire-and-forget).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const store = window.__MNP__?.ConformalStore;
      const Conformal = window.__MNP__?.Conformal;
      if (!store?.latestConformal || !Conformal?.SplitConformalRegressor) return;
      try {
        const row = await store.latestConformal({ kind: "regression" });
        if (cancelled || !row) return;
        const cp = Conformal.SplitConformalRegressor.deserialize(row.payload);
        if (!cancelled) setConformal(cp);
      } catch (err) {
        // Not fatal — fall back to heuristic band
        console.debug("[ui] no saved conformal regressor", err?.message || err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const forecast = useMemo(() => {
    const gc = window.__MNP__?.GhostCandles;
    if (!gc?.predictGhostCandles) return null;
    if (!ta || ta.empty || !vetoedOrch) return null;
    try {
      const f = gc.predictGhostCandles(ta, vetoedOrch, {
        nBars, alpha,
        conformal,
        candles,
        patternBias,
      });
      // Surface the veto on the forecast so the UI can render a chip.
      if (f && vetoInfo?.vetoed) {
        f.metaVeto = {
          kind:        vetoInfo.vetoed,
          reason:      vetoInfo.reason,
          antiPattern: vetoInfo.antiPattern,
          originalScore: vetoInfo.originalScore,
          originalProb:  vetoInfo.originalProb,
        };
      }
      return f;
    } catch (err) {
      console.warn("[ui] ghost candles failed", err);
      return null;
    }
  }, [ta, vetoedOrch, conformal, candles, nBars, alpha, patternBias, vetoInfo]);

  // Side-effect: persist each forecast + emit on the bus.  Keyed on
  // anchorTime so a forecast is only stored once per bar-open (subsequent
  // mid-bar recomputes overwrite the same row via by_anchor index).
  const lastAnchorRef = useRef(0);
  useEffect(() => {
    if (!forecast || !symbol || !tf) return;
    if (!Number.isFinite(forecast.anchorTime)) return;
    if (forecast.anchorTime === lastAnchorRef.current) return;
    lastAnchorRef.current = forecast.anchorTime;
    const mnp = window.__MNP__;
    const store = mnp?.GhostStore;
    if (!store?.saveForecast) return;
    (async () => {
      try {
        const id = await store.saveForecast(forecast, { symbol, tf });
        try {
          mnp?.EventBus?.emit?.("ghost:forecast", {
            id, symbol, tf,
            anchorTime: forecast.anchorTime,
            horizon: forecast.bars.length,
            alpha: forecast.alpha,
            usedConformal: forecast.usedConformal,
            direction: forecast.direction,
            bias: forecast.bias,
            confidence: forecast.confidence,
          });
        } catch {}
      } catch (err) {
        console.debug("[ui] ghostStore.saveForecast failed", err?.message || err);
      }
    })();
  }, [forecast, symbol, tf]);

  return forecast;
}

/**
 * Ghost resolver (Phase 11) — on every closed candle, grade any outstanding
 * ghost forecasts whose projected time has now arrived.  The candle lookup
 * walks `feed.candles` (already sorted by t ascending).  Emits
 * `ghost:resolved` / `ghost:verdict` via the EventBus.
 */
function useGhostResolver(symbol, tf, candles) {
  // `candles` are updated via React state when `feed:close` fires, so
  // running as a useEffect on its length change is equivalent to listening
  // for bar closes — without needing another bus subscription.
  useEffect(() => {
    if (!symbol || !tf) return;
    if (!Array.isArray(candles) || candles.length === 0) return;
    const mnp = window.__MNP__;
    const store = mnp?.GhostStore;
    if (!store?.resolveGhosts) return;

    // Build a sec → candle index for O(1) lookup inside resolveGhosts.
    // Candles carry `t` in ms; ghost bars carry `time` in UTC seconds.
    const byTimeSec = new Map();
    for (const c of candles) {
      if (!c || !Number.isFinite(c.t)) continue;
      byTimeSec.set(Math.floor(c.t / 1000), c);
    }
    const candleLookup = (tSec, row) => {
      // Exact match first; fall back to nearest-within-tfSec/2 if the feed
      // subsampled the bar open time.
      const exact = byTimeSec.get(tSec);
      if (exact) return exact;
      const tol = Math.max(1, ((row?.tfSec || 60) / 2) | 0);
      for (let d = 1; d <= tol; d++) {
        const a = byTimeSec.get(tSec + d);
        if (a) return a;
        const b = byTimeSec.get(tSec - d);
        if (b) return b;
      }
      return null;
    };
    (async () => {
      try {
        await store.resolveGhosts({
          candleLookup,
          bus: mnp?.EventBus,
          nowSec: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        console.debug("[ui] ghostStore.resolveGhosts failed", err?.message || err);
      }
    })();
    // Trigger each time the candle array reference changes (new bar closed).
    // We intentionally depend on candles.length + last t so we don't re-run
    // on every intra-bar tick.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, tf, candles?.length, candles?.[candles?.length - 1]?.t]);
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Small presentational atoms                                      ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function fmt(x, d = 2) {
  if (!Number.isFinite(Number(x))) return "—";
  return Number(x).toLocaleString(undefined, { maximumFractionDigits: d });
}
function fmtPct(x, d = 1) {
  if (!Number.isFinite(Number(x))) return "—";
  return (Number(x) * 100).toFixed(d) + "%";
}
function fmtSigned(x, d = 2) {
  if (!Number.isFinite(Number(x))) return "—";
  const n = Number(x);
  return (n >= 0 ? "+" : "") + n.toFixed(d);
}
function fmtMB(bytes) {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return mb.toFixed(1) + " MB";
  return (mb / 1024).toFixed(2) + " GB";
}
function directionTone(dir) {
  if (dir === "long" || dir === "up") return "bull";
  if (dir === "short" || dir === "down") return "bear";
  return "flat";
}

/**
 * Derive previous-day high / low from a candle array.
 * Buckets by UTC yyyy-mm-dd; PDH/PDL are from the day-prior bucket.
 */
function derivePDHPDL(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const key = (t) => new Date(t).toISOString().slice(0, 10);
  const byDay = new Map();
  for (const c of candles) {
    const k = key(c.t);
    let d = byDay.get(k);
    if (!d) { d = { high: -Infinity, low: +Infinity }; byDay.set(k, d); }
    if (+c.h > d.high) d.high = +c.h;
    if (+c.l < d.low)  d.low  = +c.l;
  }
  const days = Array.from(byDay.keys()).sort();
  if (days.length < 2) return null;
  const prev = byDay.get(days[days.length - 2]);
  if (!prev) return null;
  return { pdh: prev.high, pdl: prev.low };
}

function Bar({ value, max = 1, tone = "accent", label, showValue = true, valueFmt }) {
  const pct = Math.max(0, Math.min(100, (Math.abs(value) / max) * 100));
  return (
    <div className="bar-row">
      {label && <span className="lbl">{label}</span>}
      <div className={"bar " + (tone === "bull" ? "bull" : tone === "bear" ? "bear" : "")}>
        <span style={{ width: pct + "%" }} />
      </div>
      {showValue && <span className="val">{valueFmt ? valueFmt(value) : fmt(value)}</span>}
    </div>
  );
}

function BiasTrack({ value }) {
  const v = Math.max(-1, Math.min(1, Number(value) || 0));
  const leftPct = ((v + 1) / 2) * 100;
  return (
    <div style={{ marginTop: 6 }}>
      <div className="bias-track">
        <div className="bias-needle" style={{ left: leftPct + "%" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--fg-dim)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
        <span>BEAR</span><span>{v.toFixed(2)}</span><span>BULL</span>
      </div>
    </div>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Top bar + tab nav                                               ║
   ╚══════════════════════════════════════════════════════════════════╝ */

/* ── M3.5 SymbolPicker · type-tabbed search-modal ──
   Replaces the original 8-symbol <select>.  Reads the live universe
   registry (which the dynamic Binance loader populates after boot)
   and exposes 7 asset-class tabs:
     all · crypto · stock · etf · forex · commodity · index
   Type-ahead filter searches symbol id + name + region + currency.
   Each row gets a typed badge.  Tab counts update live as the
   crypto loader merges the full ~3000-symbol Binance list. */
const TYPE_LABELS = {
  all: "All", crypto: "Crypto", stock: "Stocks", etf: "ETFs",
  forex: "Forex", commodity: "Comm.", index: "Indices",
};
const TYPE_TONE = {
  crypto: "bull", stock: "accent", etf: "warn",
  forex: "accent", commodity: "warn", index: "fg-dim",
};

function SymbolPicker({ symbol, setSymbol }) {
  const [open, setOpen]     = useState(false);
  const [type, setType]     = useState("all");
  const [query, setQuery]   = useState("");
  const [tick, setTick]     = useState(0);            // bump on universe:ready
  const popRef              = useRef(null);
  const inputRef            = useRef(null);

  // Subscribe to dynamic-universe updates so tab counts repopulate.
  useEffect(() => {
    const U = window.__MNP__?.Universe;
    if (!U?.onUniverseChange) return;
    const off = U.onUniverseChange(() => setTick((n) => n + 1));
    return () => { try { off?.(); } catch {} };
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const U = window.__MNP__?.Universe;
  const typeCounts = useMemo(() => U?.counts ? U.counts() : { all: 0 }, [U, tick]);
  const matches    = useMemo(() => {
    if (!U?.searchUniverse) return [];
    return U.searchUniverse(query, type, 200);
  }, [U, query, type, tick, open]);

  const meta = U?.getSymbol ? U.getSymbol(symbol) : null;
  const tone = meta?.type ? TYPE_TONE[meta.type] || "" : "";

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="sel"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 140 }}
        title={meta ? `${meta.name} · ${meta.type}` : symbol}>
        <span style={{ fontWeight: "bold" }}>{symbol}</span>
        {meta?.type && (
          <span className={"chip-toggle on " + tone} style={{ fontSize: 9, padding: "1px 5px" }}>
            {TYPE_LABELS[meta.type] || meta.type}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: "var(--fg-dim)", fontSize: 11 }}>▾</span>
      </button>

      {open && (
        <div
          ref={popRef}
          role="listbox"
          aria-label="Symbol picker"
          style={{
            position: "absolute", top: "100%", right: 0, zIndex: 50,
            width: 360, marginTop: 4,
            background: "var(--bg-elev-2, #1a1e2a)",
            border: "1px solid var(--border, #2a2e39)",
            borderRadius: 6, boxShadow: "0 8px 24px rgba(0,0,0,.55)",
            display: "flex", flexDirection: "column", maxHeight: 480,
          }}>
          {/* Type tabs */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 8, borderBottom: "1px solid var(--border,#2a2e39)" }}>
            {Object.entries(TYPE_LABELS).map(([t, label]) => (
              <button
                key={t}
                type="button"
                className={"chip-toggle " + (t === type ? "on " + (TYPE_TONE[t] || "") : "")}
                style={{ fontSize: 10, padding: "3px 8px" }}
                onClick={() => setType(t)}
                aria-pressed={t === type}>
                {label} <span style={{ color: "var(--fg-dim)", marginLeft: 4 }}>{typeCounts[t] ?? 0}</span>
              </button>
            ))}
          </div>
          {/* Search */}
          <div style={{ padding: 8, borderBottom: "1px solid var(--border,#2a2e39)" }}>
            <input
              ref={inputRef}
              type="search"
              placeholder={`Search ${typeCounts[type] ?? 0} ${TYPE_LABELS[type] || ""}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: "100%", boxSizing: "border-box", padding: "6px 8px",
                fontSize: 12, fontFamily: "inherit",
                background: "var(--bg, #131722)", color: "var(--fg, #d1d4dc)",
                border: "1px solid var(--border, #2a2e39)", borderRadius: 4,
              }}
            />
          </div>
          {/* Result list */}
          <div style={{ flex: "1 1 auto", overflowY: "auto", padding: 4 }}>
            {matches.length === 0 ? (
              <div style={{ color: "var(--fg-dim)", fontSize: 12, padding: 16, textAlign: "center" }}>
                No matches — try clearing the filter or another type.
              </div>
            ) : matches.map((e) => (
              <button
                key={`${e.exchange || "_"}:${e.id}`}
                type="button"
                className={symbol === e.id ? "chip-toggle on" : "chip-toggle"}
                style={{
                  display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8,
                  width: "100%", padding: "5px 8px", marginBottom: 1,
                  fontSize: 11, textAlign: "left", border: "none",
                  background: symbol === e.id ? "rgba(41,98,255,.12)" : "transparent",
                  color: "var(--fg)", cursor: "pointer", borderRadius: 3,
                }}
                onClick={() => { setSymbol(e.id); setOpen(false); }}>
                <span style={{ fontFamily: "var(--font-mono, monospace)", fontWeight: "bold" }}>{e.id}</span>
                <span style={{ color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.name}{e.region ? ` · ${e.region}` : ""}{e.currency ? ` · ${e.currency}` : ""}
                </span>
                <span className={"chip-toggle on " + (TYPE_TONE[e.type] || "")} style={{ fontSize: 9, padding: "1px 5px" }}>
                  {TYPE_LABELS[e.type] || e.type}
                </span>
              </button>
            ))}
          </div>
          {/* Footer */}
          <div style={{ fontSize: 10, color: "var(--fg-dim)", padding: "6px 8px", borderTop: "1px solid var(--border,#2a2e39)" }}>
            {typeCounts.all} symbols · {Object.entries(typeCounts).filter(([k]) => k !== "all").map(([k, n]) => `${TYPE_LABELS[k] || k} ${n}`).join(" · ")}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── M4b · MacroRibbon — Risk-ON / Risk-OFF pill in topbar ──
   Polls Yahoo every 5 min for VIX / SPX / DXY / 10Y / GOLD,
   feeds them to Macro.computeMacroState, renders a coloured pill. */
function useMacroState() {
  const [state, setState] = useState({ score: 0, label: "loading", contributions: [] });
  useEffect(() => {
    const Macro = window.__MNP__?.Macro;
    const Yahoo = window.__MNP__?.Universe;   // not the right surface — use exchanges directly
    const yahoo = window.__MNP__?.RSS && window.__MNP__;   // use exchanges adapter via window
    if (!Macro || !Macro.computeMacroState) return;
    const yahooAdapter = window.__MNP__?.exchanges?.yahoo || null;
    let stopped = false;
    const PROXIES = ["^VIX", "^GSPC", "DX-Y.NYB", "^TNX", "GC=F"];

    const fetchOne = async (sym) => {
      try {
        // Use the same polling endpoint as the yahoo adapter (parsed → closes).
        const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1mo&events=`;
        const r = await fetch(url, { headers: { "Accept": "application/json" } });
        if (!r.ok) return null;
        const j = await r.json();
        const closes = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
        return closes.filter(Number.isFinite);
      } catch { return null; }
    };
    const tick = async () => {
      const samples = {};
      const arrs = await Promise.all(PROXIES.map(fetchOne));
      PROXIES.forEach((s, i) => { if (arrs[i]?.length) samples[s] = arrs[i]; });
      if (stopped) return;
      const next = Macro.computeMacroState(samples);
      setState(next);
      try { window.__MNP__?.EventBus?.emit("macro:state", next); } catch {}
    };
    tick();
    const t = setInterval(tick, 5 * 60_000);
    return () => { stopped = true; clearInterval(t); };
  }, []);
  return state;
}

function MacroRibbon() {
  const m = useMacroState();
  const tone = m.label === "risk-on"  ? "bull"
             : m.label === "risk-off" ? "bear"
             : "";
  const arrow = m.label === "risk-on" ? "▲" : m.label === "risk-off" ? "▼" : "—";
  return (
    <span
      className={"chip-toggle on " + tone}
      style={{ fontSize: 10, padding: "3px 8px", marginRight: 6 }}
      title={(m.contributions || []).map(c => `${c.label} ${c.score >= 0 ? "+":""}${c.score.toFixed(2)}`).join("  ·  ") || "macro"}>
      {arrow} {String(m.label).toUpperCase()}
      {Number.isFinite(m.score) && m.label !== "loading" && m.label !== "unknown" && (
        <span style={{ marginLeft: 4, color: "var(--fg-dim)" }}>
          {m.score >= 0 ? "+" : ""}{m.score.toFixed(2)}
        </span>
      )}
    </span>
  );
}

function TopBar({ tab, setTab, symbol, setSymbol, tf, setTf, net, skew, status, exchange }) {
  return (
    <header className="topbar" role="banner">
      <div className="brand">
        <span className="brand-mark">MNP</span>
        <span className="brand-name">My Next Prediction</span>
        <span className="brand-tag">{window.__MNP__?.version}</span>
      </div>

      <nav className="tabnav" aria-label="primary">
        <button className={"tab-btn" + (tab === "chart" ? " active" : "")} onClick={() => setTab("chart")}>Chart</button>
        <button className={"tab-btn" + (tab === "scanner" ? " active" : "")} onClick={() => setTab("scanner")}>Scanner</button>
        <button className={"tab-btn" + (tab === "news" ? " active" : "")} onClick={() => setTab("news")}>News</button>
        <button className={"tab-btn" + (tab === "chat" ? " active" : "")} onClick={() => setTab("chat")}>AI Chat</button>
        <button className={"tab-btn" + (tab === "system" ? " active" : "")} onClick={() => setTab("system")}>
          System <span className="chip">{window.__MNP__?.caps?.privateMode ? "PRIV" : "OK"}</span>
        </button>
      </nav>

      <span className="spacer-flex" />

      <MacroRibbon />
      <SymbolPicker symbol={symbol} setSymbol={setSymbol} />

      <div className="tf-group" role="group" aria-label="timeframe">
        {TFS.map(t => (
          <button key={t} className={"tf-btn" + (t === tf ? " active" : "")} onClick={() => setTf(t)}>{t}</button>
        ))}
      </div>

      <span className={"status-pill " + (status?.status === "open" ? "ok" : status?.status === "closed" || status?.status === "error" ? "bad" : "warn")}>
        <span className="dot" />
        {status?.status || "idle"} · {exchange || "—"}
      </span>
      <span className={"status-pill " + (net?.online ? "ok" : "bad")}>
        <span className="dot" />
        {net?.online ? "online" : "offline"}
      </span>
      {skew && (
        <span className="status-pill">
          Δt {skew.offsetMs}ms
        </span>
      )}
    </header>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Indicator + structure toggle rail                               ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function IndicatorRail({ indicators, setIndicators, structure, setStructure, subplots, setSubplots }) {
  const toggle = (setter, key) => () => setter(s => ({ ...s, [key]: !s[key] }));
  return (
    <div className="indicator-rail" role="toolbar">
      <div className="rail-group">
        <span className="rail-label">Overlays</span>
        {INDICATOR_CATALOG.map(ind => (
          <button
            key={ind.id}
            className={"chip-toggle" + (indicators[ind.id] ? " on" : "")}
            onClick={toggle(setIndicators, ind.id)}
            style={indicators[ind.id] ? { borderColor: ind.color, color: ind.color } : undefined}
          >
            {ind.label}
          </button>
        ))}
      </div>
      <div className="rail-group">
        <span className="rail-label">Subplots</span>
        {SUBPLOT_CATALOG.map(sp => (
          <button
            key={sp.id}
            className={"chip-toggle" + (subplots[sp.id] ? " on " + sp.tone : "")}
            onClick={toggle(setSubplots, sp.id)}
          >
            {sp.label}
          </button>
        ))}
      </div>
      <div className="rail-group">
        <span className="rail-label">Structure</span>
        {STRUCTURE_CATALOG.map(s => (
          <button
            key={s.id}
            className={"chip-toggle" + (structure[s.id] ? " on " + s.tone : "")}
            onClick={toggle(setStructure, s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Trendline + Chart-pattern overlay (M3 step 6)                   ║
   ║  Renders fitted trendlines + the latest detected chart pattern   ║
   ║  as SVG primitives anchored to the chart's price scale.          ║
   ║  Pure overlay — pulls ta.trendlines + ta.chartPatterns straight  ║
   ║  from the TA snapshot.                                           ║
   ╚══════════════════════════════════════════════════════════════════╝ */
function TrendlinePatternOverlay({ chartRef, seriesRef, dims, ta, candles, showTrendlines, showPatterns }) {
  if (!chartRef?.current || !seriesRef?.current?.candle) return null;
  if (!ta || ta.empty) return null;
  if (!Array.isArray(candles) || candles.length === 0) return null;

  const series = seriesRef.current.candle;
  const chart  = chartRef.current;
  const ts = chart.timeScale?.();

  const priceToY = (price) => {
    try { return series.priceToCoordinate(price); } catch { return null; }
  };
  // Time scale uses UTC seconds (per LWC); our candles store ms in `t`.
  const barIdxToX = (i) => {
    if (i < 0 || i >= candles.length) return null;
    const c = candles[i];
    const tSec = Number.isFinite(c?.time) ? c.time : Math.floor(c.t / 1000);
    try { return ts?.timeToCoordinate?.(tSec); } catch { return null; }
  };

  // ── Trendlines ────────────────────────────────────────────────
  const tl = ta.trendlines;
  const renderLine = (line, color) => {
    if (!line) return null;
    // Span from the first anchor pivot's bar idx to the LAST candle index
    // so the line projects all the way to the right edge.
    const startIdx = Math.max(0, line.points[0]?.i ?? 0);
    const endIdx   = candles.length - 1;
    const yStart   = priceToY(line.slope * startIdx + line.intercept);
    const yEnd     = priceToY(line.slope * endIdx   + line.intercept);
    const xStart   = barIdxToX(startIdx);
    const xEnd     = barIdxToX(endIdx);
    if (!Number.isFinite(yStart) || !Number.isFinite(yEnd) || !Number.isFinite(xStart) || !Number.isFinite(xEnd)) return null;
    return (
      <g>
        <line x1={xStart} y1={yStart} x2={xEnd} y2={yEnd}
              stroke={color} strokeWidth="1.4" strokeDasharray="6 4" />
        {line.touchPoints?.map((p, j) => {
          const cx = barIdxToX(p.i);
          const cy = priceToY(p.p);
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
          return <circle key={j} cx={cx} cy={cy} r="3" fill={color} fillOpacity="0.7" stroke="white" strokeWidth="0.5" />;
        })}
      </g>
    );
  };

  // ── Chart pattern (latest only) ───────────────────────────────
  const cp = ta.chartPatterns?.last;
  let patternG = null;
  if (showPatterns && cp && Array.isArray(cp.anchorPoints) && cp.anchorPoints.length >= 2) {
    const tone = cp.bias === "bullish" ? "#26a69a"
               : cp.bias === "bearish" ? "#ef5350"
               : "#9aa0ab";
    const pts = cp.anchorPoints.map((a) => {
      const x = barIdxToX(a.i);
      const y = priceToY(a.p);
      return Number.isFinite(x) && Number.isFinite(y) ? `${x.toFixed(1)},${y.toFixed(1)}` : null;
    }).filter(Boolean).join(" ");
    const necklineY = Number.isFinite(cp.necklinePrice) ? priceToY(cp.necklinePrice) : null;
    const targetY   = Number.isFinite(cp.targetPrice)   ? priceToY(cp.targetPrice)   : null;
    const invalidY  = Number.isFinite(cp.invalidationPrice) ? priceToY(cp.invalidationPrice) : null;
    patternG = (
      <g>
        {pts && <polyline points={pts} fill="none" stroke={tone} strokeWidth="1.6" />}
        {cp.anchorPoints.map((a, i) => {
          const cx = barIdxToX(a.i);
          const cy = priceToY(a.p);
          if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
          return <circle key={i} cx={cx} cy={cy} r="3.5" fill={tone} stroke="white" strokeWidth="0.7" />;
        })}
        {Number.isFinite(necklineY) && (
          <line x1={0} x2={dims.w - 56} y1={necklineY} y2={necklineY}
                stroke="rgba(255,255,255,.45)" strokeWidth="1" strokeDasharray="2 4" />
        )}
        {Number.isFinite(targetY) && (
          <line x1={0} x2={dims.w - 56} y1={targetY} y2={targetY}
                stroke="rgba(38,166,154,.55)" strokeWidth="1" strokeDasharray="6 4" />
        )}
        {Number.isFinite(invalidY) && (
          <line x1={0} x2={dims.w - 56} y1={invalidY} y2={invalidY}
                stroke="rgba(239,83,80,.55)" strokeWidth="1" strokeDasharray="6 4" />
        )}
        {/* Label */}
        {cp.anchorPoints[0] && (() => {
          const x = barIdxToX(cp.anchorPoints[0].i);
          const y = priceToY(cp.anchorPoints[0].p);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
          return (
            <text x={x + 4} y={y - 6} fill={tone} fontSize="10" fontFamily="ui-monospace, monospace">
              {cp.name}{cp.broken ? " ✓" : ""}
            </text>
          );
        })()}
      </g>
    );
  }

  // ── Render only when we actually have something to show ──────
  const haveTL = showTrendlines && tl && (tl.upper || tl.lower);
  const havePT = !!patternG;
  if (!haveTL && !havePT) return null;

  return (
    <svg
      width={dims.w} height={dims.h}
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}
      aria-hidden="true">
      {haveTL && tl.upper && renderLine(tl.upper, "rgba(239,83,80,.85)")}
      {haveTL && tl.lower && renderLine(tl.lower, "rgba(38,166,154,.85)")}
      {havePT && patternG}
      {haveTL && tl.lastBreakout && (() => {
        const x = barIdxToX(tl.lastBreakout.atBar);
        const y = priceToY(candles[tl.lastBreakout.atBar]?.c);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const arrowColor = tl.lastBreakout.side === "up" ? "#26a69a" : "#ef5350";
        const dy = tl.lastBreakout.side === "up" ? -10 : 10;
        return (
          <g>
            <circle cx={x} cy={y} r="4" fill={arrowColor} stroke="white" strokeWidth="1" />
            <text x={x + 6} y={y + dy} fill={arrowColor} fontSize="10" fontFamily="ui-monospace, monospace">
              breakout {tl.lastBreakout.side.toUpperCase()}
            </text>
          </g>
        );
      })()}
    </svg>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Volume Profile overlay (M3 step 5)                              ║
   ║  Horizontal volume-at-price histogram pinned to the chart's      ║
   ║  right edge.  Subscribes to vp:updated events and uses the       ║
   ║  candle series' priceToCoordinate to align each bucket to the    ║
   ║  correct y-pixel.  Pure SVG so it composes with WebGL chart.     ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function VolumeProfileOverlay({ chartRef, seriesRef, dims }) {
  const [bundle, setBundle] = useState(null);

  // Listen for vp:updated from the sidebar card.
  useEffect(() => {
    const bus = window.__MNP__?.EventBus;
    if (!bus) return;
    const off = bus.on?.("vp:updated", (e) => { if (e?.bundle) setBundle(e.bundle); });
    return () => { try { off?.(); } catch {} };
  }, []);

  if (!bundle || !chartRef?.current || !seriesRef?.current?.candle) return null;

  // Width of the histogram band — % of chart width, max 240 px.
  const W = Math.min(220, Math.max(80, Math.round(dims.w * 0.22)));
  // Left/right inset to avoid colliding with the price-axis labels.
  const RIGHT_INSET = 56;
  const x0 = Math.max(0, dims.w - RIGHT_INSET - W);   // left edge of bars
  const xEnd = Math.max(x0 + 1, dims.w - RIGHT_INSET); // right edge (anchor)

  const series = seriesRef.current.candle;
  let coord;
  try { coord = (price) => series.priceToCoordinate(price); }
  catch { return null; }

  const maxV = bundle.rows.reduce((m, r) => r.vol > m ? r.vol : m, 0) || 1;

  // Bucket strip height — derive from row count + chart height.
  const strip = Math.max(2, Math.floor((dims.h * 0.9) / bundle.rows.length));

  return (
    <svg
      width={dims.w}
      height={dims.h}
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}
      aria-hidden="true">
      {/* faded backdrop behind histogram so bars read against the chart */}
      <rect x={x0} y={0} width={W} height={dims.h} fill="rgba(19,23,34,.35)" />
      {bundle.rows.map((r) => {
        const yMid = coord(r.mid);
        if (!Number.isFinite(yMid)) return null;
        const w = (r.vol / maxV) * W;
        if (!Number.isFinite(w) || w <= 0) return null;
        const upPct = r.vol > 0 ? r.up / r.vol : 0;
        const wUp = w * upPct;
        const wDn = w - wUp;
        const y = yMid - strip / 2;
        const barX = xEnd - w;
        return (
          <g key={r.idx}>
            {/* down portion (closer to anchor edge) */}
            <rect x={xEnd - wDn} y={y} width={wDn} height={Math.max(1, strip - 1)} fill="rgba(239,83,80,.55)" />
            {/* up portion */}
            <rect x={barX}      y={y} width={wUp} height={Math.max(1, strip - 1)} fill="rgba(38,166,154,.55)" />
            {/* POC frame */}
            {r.isPOC && (
              <rect x={barX - 1} y={y - 1} width={w + 2} height={Math.max(2, strip + 1)}
                    fill="none" stroke="rgba(255,176,32,.95)" strokeWidth="1" />
            )}
          </g>
        );
      })}
      {/* VAH / VAL guide lines (dashed, full chart width) */}
      {Number.isFinite(bundle.vahPrice) && Number.isFinite(coord(bundle.vahPrice)) && (
        <line x1={0} x2={dims.w - RIGHT_INSET} y1={coord(bundle.vahPrice)} y2={coord(bundle.vahPrice)}
              stroke="rgba(41,98,255,.55)" strokeWidth="1" strokeDasharray="3 3" />
      )}
      {Number.isFinite(bundle.valPrice) && Number.isFinite(coord(bundle.valPrice)) && (
        <line x1={0} x2={dims.w - RIGHT_INSET} y1={coord(bundle.valPrice)} y2={coord(bundle.valPrice)}
              stroke="rgba(41,98,255,.55)" strokeWidth="1" strokeDasharray="3 3" />
      )}
      {Number.isFinite(bundle.pocPrice) && Number.isFinite(coord(bundle.pocPrice)) && (
        <line x1={0} x2={dims.w - RIGHT_INSET} y1={coord(bundle.pocPrice)} y2={coord(bundle.pocPrice)}
              stroke="rgba(255,176,32,.65)" strokeWidth="1" />
      )}
      {/* Labels, top-right of the band */}
      <text x={x0 + 6} y={12} fill="#9aa0ab" fontSize="10" fontFamily="ui-monospace, monospace">
        VP · {bundle.buckets}c · {bundle.lookback}b
      </text>
    </svg>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Chart pane — lightweight-charts + overlay layer                 ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function ChartPane({ symbol, tf, candles, forming, ta, indicators, structure, expected, subplots, ghost }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({ candle: null, indicators: {}, markers: [], ghost: null, ghostHi: null, ghostLo: null });
  const [dims, setDims] = useState({ w: 0, h: 0 });

  // Mount chart
  useLayoutEffect(() => {
    if (!containerRef.current || !window.LightweightCharts) return;
    const LWC = window.LightweightCharts;
    const chart = LWC.createChart(containerRef.current, {
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor:  "#9aa0ab",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,.04)" },
        horzLines: { color: "rgba(255,255,255,.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,.08)" },
      timeScale:       { borderColor: "rgba(255,255,255,.08)", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 /* normal */ },
      handleScroll: true, handleScale: true,
    });
    const candle = chart.addCandlestickSeries({
      upColor: "#26a69a", downColor: "#ef5350",
      borderUpColor: "#26a69a", borderDownColor: "#ef5350",
      wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    });
    chartRef.current = chart;
    seriesRef.current = { candle, indicators: {}, markers: [] };

    // Responsive resize
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        chart.applyOptions({ width: Math.floor(width), height: Math.floor(height) });
        setDims({ w: width, h: height });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      try { ro.disconnect(); } catch {}
      try { chart.remove(); } catch {}
      chartRef.current = null;
      seriesRef.current = { candle: null, indicators: {}, markers: [], ghost: null, ghostHi: null, ghostLo: null };
    };
  }, []);

  // Feed candle data
  useEffect(() => {
    const s = seriesRef.current.candle;
    if (!s) return;
    if (!Array.isArray(candles) || !candles.length) { s.setData([]); return; }
    const rows = candles.map(c => ({
      time: Math.floor(c.t / 1000),
      open: +c.o, high: +c.h, low: +c.l, close: +c.c,
    }));
    // If last forming candle exists + is newer than the last closed, append it
    if (forming && forming.t > candles[candles.length - 1].t) {
      rows.push({
        time: Math.floor(forming.t / 1000),
        open: +forming.o, high: +forming.h, low: +forming.l, close: +forming.c,
      });
    }
    s.setData(rows);
  }, [candles, forming]);

  // Indicator lines
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ta || ta.empty) return;
    const reg = seriesRef.current.indicators;

    const ensure = (id, color) => {
      if (!reg[id]) {
        reg[id] = chart.addLineSeries({
          color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        });
      }
      return reg[id];
    };
    const drop = (id) => {
      if (reg[id]) {
        try { chart.removeSeries(reg[id]); } catch {}
        delete reg[id];
      }
    };
    const points = (arr) => {
      if (!Array.isArray(arr) || !Array.isArray(ta.t)) return [];
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (Number.isFinite(v) && Number.isFinite(ta.t[i])) {
          out.push({ time: Math.floor(ta.t[i] / 1000), value: v });
        }
      }
      return out;
    };

    // EMAs
    for (const ind of INDICATOR_CATALOG) {
      if (ind.kind !== "ema") continue;
      if (indicators[ind.id]) {
        const key = `ema${ind.period}`;
        const line = ensure(ind.id, ind.color);
        line.setData(points(ta[key]));
      } else drop(ind.id);
    }
    // VWAP
    if (indicators.vwap) {
      const line = ensure("vwap", "#b388ff");
      line.setData(points(ta.vwap));
    } else drop("vwap");
    // Bollinger (engine stores as `bb_20_2` object with {mid,up,lo})
    const bb = ta.bb_20_2 || ta.bb;
    if (indicators.bbUp) {
      const line = ensure("bbUp", "#26a69a88");
      line.setData(points(bb?.up));
    } else drop("bbUp");
    if (indicators.bbLo) {
      const line = ensure("bbLo", "#ef535088");
      line.setData(points(bb?.lo));
    } else drop("bbLo");
    // Parabolic SAR — render as small dots via line series (one point per bar)
    if (indicators.psar && ta.psar?.psar) {
      if (!reg.psar) {
        reg.psar = chart.addLineSeries({
          color: "#ffb74d", lineWidth: 1, lineStyle: 0,
          pointMarkersVisible: true, pointMarkersRadius: 2,
          priceLineVisible: false, lastValueVisible: false,
          lineType: 1 /* with-steps */,
        });
      }
      // Break PSAR into separate segments whenever the trend flips, so the
      // line does not draw diagonals between bullish + bearish dot clusters.
      const out = [];
      const tr = ta.psar.trend;
      for (let i = 0; i < ta.psar.psar.length; i++) {
        const v = ta.psar.psar[i];
        if (!Number.isFinite(v) || !Number.isFinite(ta.t[i])) continue;
        out.push({ time: Math.floor(ta.t[i] / 1000), value: v });
        // Insert a whitespace/gap on trend flip
        if (i > 0 && tr?.[i] !== tr?.[i - 1]) {
          out.push({ time: Math.floor((ta.t[i] + 1) / 1000), value: NaN });
        }
      }
      reg.psar.setData(out.filter(p => Number.isFinite(p.value)));
    } else drop("psar");
    // Ichimoku — render each selected component as a line
    for (const ind of INDICATOR_CATALOG) {
      if (ind.kind !== "ichi") continue;
      if (indicators[ind.id] && ta.ichimoku?.[ind.field]) {
        const line = ensure(ind.id, ind.color);
        line.setData(points(ta.ichimoku[ind.field]));
      } else drop(ind.id);
    }
  }, [ta, indicators]);

  // Structural overlays — markers + price lines
  useEffect(() => {
    const s = seriesRef.current.candle;
    const chart = chartRef.current;
    if (!s || !chart || !ta || ta.empty) return;

    // ─ Markers: BOS/CHoCH, OB, liquidity sweeps, FVG
    //   (shapes use lightweight-charts v4 API: setMarkers)
    const markers = [];
    const seen = new Set();                 // dedupe by "time|text"
    const push = (m) => {
      const k = `${m.time}|${m.text}`;
      if (seen.has(k)) return; seen.add(k);
      markers.push(m);
    };

    if (structure.bos && Array.isArray(ta.breaks)) {
      for (const b of ta.breaks.slice(-40)) {
        const t = Number(b.t ?? ta.t?.[b.i]);
        if (!Number.isFinite(t)) continue;
        const up = b.dir === "up";
        push({
          time: Math.floor(t / 1000),
          position: up ? "belowBar" : "aboveBar",
          color:    up ? "#26a69a" : "#ef5350",
          shape:    up ? "arrowUp" : "arrowDown",
          text:     b.type || "BOS",
        });
      }
    }
    if (structure.ob && Array.isArray(ta.orderBlocks)) {
      for (const ob of ta.orderBlocks.filter(x => !x.mitigated).slice(-20)) {
        const t = Number(ob.t ?? ta.t?.[ob.i]);
        if (!Number.isFinite(t)) continue;
        const up = ob.kind === "bull";
        push({
          time: Math.floor(t / 1000),
          position: up ? "belowBar" : "aboveBar",
          color:    up ? "#26a69a" : "#ef5350",
          shape: "square", text: "OB",
        });
      }
    }
    if (structure.liq && ta.liquidity && Array.isArray(ta.liquidity.sweeps)) {
      for (const l of ta.liquidity.sweeps.slice(-20)) {
        const t = Number(l.t ?? ta.t?.[l.i]);
        if (!Number.isFinite(t)) continue;
        const up = l.kind === "bullish";
        push({
          time: Math.floor(t / 1000),
          position: up ? "belowBar" : "aboveBar",
          color: "#b388ff", shape: "circle", text: "SWEEP",
        });
      }
    }
    if (structure.fvg && Array.isArray(ta.fvg?.open)) {
      for (const g of ta.fvg.open.slice(-20)) {
        const t = Number(g.t ?? ta.t?.[g.i]);
        if (!Number.isFinite(t)) continue;
        const up = g.kind === "bull";
        push({
          time: Math.floor(t / 1000),
          position: up ? "belowBar" : "aboveBar",
          color: up ? "#2962ff" : "#7c4dff", shape: "square", text: "FVG",
        });
      }
    }
    markers.sort((a, b) => a.time - b.time);
    try { s.setMarkers(markers); } catch {}

    // ─ Price lines: S/R + PDH/PDL + (phase 11-prep) predicted point
    // Clear previous lines (stored on series ref)
    if (!seriesRef.current.priceLines) seriesRef.current.priceLines = [];
    for (const pl of seriesRef.current.priceLines) {
      try { s.removePriceLine(pl); } catch {}
    }
    seriesRef.current.priceLines = [];

    const addLine = (opts) => {
      try { seriesRef.current.priceLines.push(s.createPriceLine(opts)); } catch {}
    };

    if (structure.sr && Array.isArray(ta.levels)) {
      for (const lv of ta.levels.slice(0, 8)) {
        addLine({
          price: lv.price,
          color: "rgba(255,152,0,.7)",
          lineWidth: 1, lineStyle: 2 /* dashed */,
          axisLabelVisible: true, title: `${lv.kind || "SR"} ${fmt(lv.strength, 2)}`,
        });
      }
    }
    // Liquidity levels — draw BSL (equal highs) + SSL (equal lows) as horizontal lines
    if (structure.liq && ta.liquidity) {
      for (const eh of (ta.liquidity.eqHighs || []).slice(0, 4)) {
        addLine({
          price: eh.price,
          color: "rgba(38,166,154,.55)",
          lineWidth: 1, lineStyle: 0,
          axisLabelVisible: true, title: `BSL×${eh.touches ?? "?"}`,
        });
      }
      for (const el of (ta.liquidity.eqLows || []).slice(0, 4)) {
        addLine({
          price: el.price,
          color: "rgba(239,83,80,.55)",
          lineWidth: 1, lineStyle: 0,
          axisLabelVisible: true, title: `SSL×${el.touches ?? "?"}`,
        });
      }
    }
    // Order blocks — render each open block as a pair of faint horizontal lines
    // (top + bottom) to approximate a zone until lightweight-charts v5 rectangles land.
    if (structure.ob && Array.isArray(ta.orderBlocks)) {
      const open = ta.orderBlocks.filter(b => !b.mitigated).slice(-6);
      for (const ob of open) {
        const color = ob.kind === "bull" ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)";
        addLine({ price: ob.top, color, lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: `OB${ob.kind === "bull" ? "↑" : "↓"}` });
        addLine({ price: ob.bot, color, lineWidth: 1, lineStyle: 3, axisLabelVisible: false });
      }
    }
    // Premium / Discount zone — anchor on last pivot range
    if (structure.pd && ta.premiumDiscount) {
      const pd = ta.premiumDiscount;
      if (Number.isFinite(pd.rangeHigh) && Number.isFinite(pd.rangeLow)) {
        addLine({ price: pd.rangeHigh, color: "rgba(239,83,80,.45)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Premium" });
        addLine({ price: pd.mid,       color: "rgba(255,255,255,.25)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "EQ" });
        addLine({ price: pd.rangeLow,  color: "rgba(38,166,154,.45)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Discount" });
      }
    }
    if (structure.pdh) {
      // Derive previous-day high / low from candles spanning the prior UTC day.
      // Works on any TF: we bucket by UTC date from the closed-candle timestamps.
      const pd = derivePDHPDL(candles);
      if (Number.isFinite(pd?.pdh)) addLine({ price: pd.pdh, color: "#26a69a", lineWidth: 1, lineStyle: 0, title: "PDH", axisLabelVisible: true });
      if (Number.isFinite(pd?.pdl)) addLine({ price: pd.pdl, color: "#ef5350", lineWidth: 1, lineStyle: 0, title: "PDL", axisLabelVisible: true });
    }
  }, [ta, structure, expected, candles]);

  // Ghost candles (Phase 11) — forward-projected candlestick series + confidence ribbon.
  // Rendered as a secondary candlestick series with faded colors; the (lo, hi) bands
  // are drawn as dashed line series so the ribbon widens with horizon.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const refs = seriesRef.current;
    const on = !!(structure?.ghost && ghost && Array.isArray(ghost.bars) && ghost.bars.length);

    // Lazily create the ghost series
    if (on && !refs.ghost) {
      try {
        refs.ghost = chart.addCandlestickSeries({
          upColor: "rgba(38,166,154,.35)", downColor: "rgba(239,83,80,.35)",
          borderUpColor: "rgba(38,166,154,.55)", borderDownColor: "rgba(239,83,80,.55)",
          wickUpColor: "rgba(38,166,154,.45)", wickDownColor: "rgba(239,83,80,.45)",
          priceLineVisible: false, lastValueVisible: false,
        });
      } catch {}
      try {
        refs.ghostHi = chart.addLineSeries({
          color: "rgba(179,136,255,.45)", lineWidth: 1, lineStyle: 2 /* dashed */,
          priceLineVisible: false, lastValueVisible: false,
        });
        refs.ghostLo = chart.addLineSeries({
          color: "rgba(179,136,255,.45)", lineWidth: 1, lineStyle: 2,
          priceLineVisible: false, lastValueVisible: false,
        });
      } catch {}
    }

    // Tear down when toggled off or ghost is missing
    if (!on) {
      for (const k of ["ghost", "ghostHi", "ghostLo"]) {
        if (refs[k]) {
          try { chart.removeSeries(refs[k]); } catch {}
          refs[k] = null;
        }
      }
      return;
    }

    // Populate with computed bars — start from the anchor so there is no
    // discontinuity with the real candle series.
    const gc = window.__MNP__?.GhostCandles;
    const serialized = gc?.toChartSeriesData?.(ghost);
    if (!serialized) return;

    // Prepend an anchor point so both bands + candle connect visually.
    const anchor = {
      time: ghost.anchorTime,
      open: ghost.anchorClose, high: ghost.anchorClose,
      low:  ghost.anchorClose, close: ghost.anchorClose,
    };
    const anchorBand = { time: ghost.anchorTime, value: ghost.anchorClose };

    try { refs.ghost?.setData([anchor, ...serialized.candleData]); } catch {}
    try { refs.ghostHi?.setData([anchorBand, ...serialized.upperBand]); } catch {}
    try { refs.ghostLo?.setData([anchorBand, ...serialized.lowerBand]); } catch {}
  }, [ghost, structure?.ghost]);

  // Chart header — price + OHLC readout
  const last = forming?.c ?? candles[candles.length - 1]?.c;
  const open = candles[candles.length - 1]?.o;
  const delta = Number.isFinite(last) && Number.isFinite(open) ? last - open : 0;
  const pct   = Number.isFinite(open) && open ? (delta / open) * 100 : 0;
  const lastC = candles[candles.length - 1];

  const activeSubplots = SUBPLOT_CATALOG.filter(sp => subplots?.[sp.id]);

  return (
    <section className="chart-card" aria-labelledby="chart-title">
      <div className="chart-header">
        <div>
          <div style={{ fontSize: 10, color: "var(--fg-dim)", letterSpacing: 1, textTransform: "uppercase" }}>
            {symbol} · {tf}
          </div>
          <div className="price" id="chart-title" style={{ color: delta >= 0 ? "var(--bull)" : "var(--bear)" }}>
            {fmt(last, last > 50 ? 2 : 4)}
          </div>
        </div>
        <div className={"delta " + (delta >= 0 ? "bull" : "bear")}>
          {fmtSigned(delta, 2)} ({fmtSigned(pct, 2)}%)
        </div>
        {lastC && (
          <div className="ohlc">
            <span>O <b>{fmt(lastC.o)}</b></span>
            <span>H <b style={{color:"var(--bull)"}}>{fmt(lastC.h)}</b></span>
            <span>L <b style={{color:"var(--bear)"}}>{fmt(lastC.l)}</b></span>
            <span>C <b>{fmt(lastC.c)}</b></span>
            <span>V <b>{fmt(lastC.v, 3)}</b></span>
          </div>
        )}
      </div>
      <div className="chart-canvas" ref={containerRef}>
        <div className="chart-watermark">{symbol} · {tf}</div>
        {!candles?.length && <div className="chart-empty">loading history…</div>}
        {structure?.volProfile && (
          <VolumeProfileOverlay
            chartRef={chartRef}
            seriesRef={seriesRef}
            dims={dims}
          />
        )}
        {(structure?.trendlines || structure?.patterns) && (
          <TrendlinePatternOverlay
            chartRef={chartRef}
            seriesRef={seriesRef}
            dims={dims}
            ta={ta}
            candles={candles}
            showTrendlines={!!structure?.trendlines}
            showPatterns={!!structure?.patterns}
          />
        )}
      </div>
      {activeSubplots.length > 0 && (
        <div className="subplot-stack">
          {activeSubplots.map(sp => (
            <SubplotPane key={sp.id} kind={sp.id} ta={ta} candles={candles} />
          ))}
        </div>
      )}
      <div className="chart-footer">
        <span>{candles?.length ?? 0} candles · {dims.w|0}×{dims.h|0}px · {activeSubplots.length} subplots</span>
        <span>lightweight-charts v4 · MNP v{window.__MNP__?.version}</span>
      </div>
    </section>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Subplot panes (oscillators below main chart)                    ║
   ╚══════════════════════════════════════════════════════════════════╝ */

/**
 * A single oscillator subplot rendered in its own lightweight-charts instance.
 * `kind` picks the data extraction + series style.
 * All panes share the same time-scale via the sync-hook below.
 */
function SubplotPane({ kind, ta, candles, onChart }) {
  const wrapRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const [label, setLabel] = useState(kind);

  // Human label from catalog
  useEffect(() => {
    const m = SUBPLOT_CATALOG.find(s => s.id === kind);
    if (m) setLabel(m.label);
  }, [kind]);

  // Mount chart
  useLayoutEffect(() => {
    if (!wrapRef.current || !window.LightweightCharts) return;
    const LWC = window.LightweightCharts;
    const chart = LWC.createChart(wrapRef.current, {
      layout: {
        background: { type: "solid", color: "transparent" },
        textColor: "#9aa0ab",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,.03)" },
        horzLines: { color: "rgba(255,255,255,.04)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,.08)" },
      timeScale:       { borderColor: "rgba(255,255,255,.08)", timeVisible: true, secondsVisible: false },
      handleScroll: false, handleScale: false,
    });
    chartRef.current = chart;
    seriesRef.current = {};
    onChart?.(chart);

    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        chart.applyOptions({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) });
      }
    });
    ro.observe(wrapRef.current);

    return () => {
      try { ro.disconnect(); } catch {}
      try { chart.remove(); } catch {}
      chartRef.current = null;
      seriesRef.current = {};
      onChart?.(null);
    };
  }, []);

  // Feed data (kind-specific)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !ta || ta.empty) return;
    const ref = seriesRef.current;
    const points = (arr) => {
      if (!Array.isArray(arr) || !Array.isArray(ta.t)) return [];
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (Number.isFinite(v) && Number.isFinite(ta.t[i])) {
          out.push({ time: Math.floor(ta.t[i] / 1000), value: v });
        }
      }
      return out;
    };
    const ensure = (id, mk) => {
      if (!ref[id]) ref[id] = mk();
      return ref[id];
    };

    if (kind === "volume") {
      const s = ensure("vol", () => chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "", // overlay
      }));
      const rows = [];
      for (let i = 0; i < (ta.t?.length || 0); i++) {
        const up = ta.close[i] >= ta.open[i];
        rows.push({
          time: Math.floor(ta.t[i] / 1000),
          value: +ta.volume[i] || 0,
          color: up ? "rgba(38,166,154,.55)" : "rgba(239,83,80,.55)",
        });
      }
      s.setData(rows);
    } else if (kind === "rsi") {
      const s = ensure("rsi", () => chart.addLineSeries({ color: "#ffb74d", lineWidth: 1 }));
      s.setData(points(ta.rsi14));
      // Horizontal guides at 70/30
      if (!ref._rsiGuides) {
        try {
          s.createPriceLine({ price: 70, color: "rgba(239,83,80,.45)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "70" });
          s.createPriceLine({ price: 50, color: "rgba(255,255,255,.15)", lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
          s.createPriceLine({ price: 30, color: "rgba(38,166,154,.45)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "30" });
          ref._rsiGuides = true;
        } catch {}
      }
    } else if (kind === "macd") {
      const m = ta.macd_12_26_9 || ta.macd;
      if (!m) return;
      const hist = ensure("hist", () => chart.addHistogramSeries({ priceScaleId: "" }));
      const line = ensure("macd", () => chart.addLineSeries({ color: "#2962ff", lineWidth: 1 }));
      const sig  = ensure("sig",  () => chart.addLineSeries({ color: "#ff9800", lineWidth: 1 }));
      const hrows = [];
      for (let i = 0; i < (ta.t?.length || 0); i++) {
        const v = m.hist?.[i];
        if (!Number.isFinite(v) || !Number.isFinite(ta.t[i])) continue;
        hrows.push({
          time: Math.floor(ta.t[i] / 1000),
          value: v,
          color: v >= 0 ? "rgba(38,166,154,.6)" : "rgba(239,83,80,.6)",
        });
      }
      hist.setData(hrows);
      line.setData(points(m.macd));
      sig.setData(points(m.signal));
    } else if (kind === "stoch") {
      const st = ta.stoch_14_3;
      if (!st) return;
      const k = ensure("k", () => chart.addLineSeries({ color: "#29b6f6", lineWidth: 1 }));
      const d = ensure("d", () => chart.addLineSeries({ color: "#ff9800", lineWidth: 1 }));
      k.setData(points(st.k));
      d.setData(points(st.d));
      if (!ref._stochGuides) {
        try {
          k.createPriceLine({ price: 80, color: "rgba(239,83,80,.45)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "80" });
          k.createPriceLine({ price: 20, color: "rgba(38,166,154,.45)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "20" });
          ref._stochGuides = true;
        } catch {}
      }
    } else if (kind === "cci") {
      const s = ensure("cci", () => chart.addLineSeries({ color: "#ab47bc", lineWidth: 1 }));
      s.setData(points(ta.cci20));
      if (!ref._cciGuides) {
        try {
          s.createPriceLine({ price:  100, color: "rgba(239,83,80,.4)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "+100" });
          s.createPriceLine({ price: -100, color: "rgba(38,166,154,.4)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "-100" });
          ref._cciGuides = true;
        } catch {}
      }
    } else if (kind === "wr") {
      const s = ensure("wr", () => chart.addLineSeries({ color: "#ef5350", lineWidth: 1 }));
      s.setData(points(ta.wr14));
      if (!ref._wrGuides) {
        try {
          s.createPriceLine({ price: -20, color: "rgba(239,83,80,.4)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "-20" });
          s.createPriceLine({ price: -80, color: "rgba(38,166,154,.4)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "-80" });
          ref._wrGuides = true;
        } catch {}
      }
    } else if (kind === "mfi") {
      const s = ensure("mfi", () => chart.addLineSeries({ color: "#26a69a", lineWidth: 1 }));
      s.setData(points(ta.mfi14));
      if (!ref._mfiGuides) {
        try {
          s.createPriceLine({ price: 80, color: "rgba(239,83,80,.4)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "80" });
          s.createPriceLine({ price: 20, color: "rgba(38,166,154,.4)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "20" });
          ref._mfiGuides = true;
        } catch {}
      }
    } else if (kind === "obv") {
      const s = ensure("obv", () => chart.addLineSeries({ color: "#b388ff", lineWidth: 1 }));
      s.setData(points(ta.obv));
    } else if (kind === "cmf") {
      const s = ensure("cmf", () => chart.addLineSeries({ color: "#ffd54f", lineWidth: 1 }));
      s.setData(points(ta.cmf20));
      if (!ref._cmfGuides) {
        try {
          s.createPriceLine({ price: 0, color: "rgba(255,255,255,.2)", lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
          ref._cmfGuides = true;
        } catch {}
      }
    } else if (kind === "adx") {
      const a = ta.adx14;
      if (!a) return;
      const adxL = ensure("adx",  () => chart.addLineSeries({ color: "#ffd54f", lineWidth: 1 }));
      const pL   = ensure("p",    () => chart.addLineSeries({ color: "#26a69a", lineWidth: 1 }));
      const mL   = ensure("m",    () => chart.addLineSeries({ color: "#ef5350", lineWidth: 1 }));
      adxL.setData(points(a.adx));
      pL.setData(points(a.plusDI));
      mL.setData(points(a.minusDI));
      if (!ref._adxGuides) {
        try { adxL.createPriceLine({ price: 25, color: "rgba(255,255,255,.2)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "25" }); ref._adxGuides = true; } catch {}
      }
    }
  }, [kind, ta]);

  return (
    <div className="subplot" data-kind={kind}>
      <div className="subplot-label">{label}</div>
      <div className="subplot-canvas" ref={wrapRef} />
    </div>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Signal sidebar                                                  ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function TradeSignalCard({ orch, expected, regime, ta }) {
  if (!orch) {
    return (
      <div className="card card-glass">
        <h3>Trade Signal <span className="badge">waiting…</span></h3>
        <div className="shimmer" style={{ height: 62, marginBottom: 10 }} />
        <div className="shimmer" style={{ height: 16 }} />
      </div>
    );
  }
  const tone = directionTone(orch.direction);
  const arrow = orch.direction === "long" ? "▲" : orch.direction === "short" ? "▼" : "●";
  const prob = Number.isFinite(orch.probability) ? orch.probability : 0.5;
  const conf = Number.isFinite(orch.confidence) ? orch.confidence : 0;
  const regimeLabel = regime || ta?.regime?.label || ta?.regime?.regime || "—";
  return (
    <div className="card card-glass">
      <h3>
        Trade Signal
        <span className={"badge " + (tone === "bull" ? "bull" : tone === "bear" ? "bear" : "")}>
          {orch.direction.toUpperCase()}
        </span>
      </h3>
      <div className="signal-dial">
        <div className={"dial-arrow " + tone}>{arrow}</div>
        <div className="dial-meta">
          <div className={"dir " + tone}>{orch.direction}</div>
          <div className="sub">regime · {regimeLabel}</div>
          <div className="sub">modules · {orch.participating}/{orch.signals?.length ?? 13}</div>
        </div>
      </div>
      <Bar label="P(up)"      value={prob}   max={1} tone={tone} valueFmt={fmtPct} />
      <Bar label="Confidence" value={conf}   max={1} tone="accent" valueFmt={fmtPct} />
      <Bar label="|Bias|"     value={Math.abs(orch.rawScore || 0)} max={1} tone={tone}
           valueFmt={(x) => fmt(x, 2)} />
      {expected && (
        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div className="dl-cell">
            <div className="k">Target</div>
            <div className="v" style={{ color: expected.direction > 0 ? "var(--bull)" : "var(--bear)" }}>
              {fmt(expected.point)}
            </div>
          </div>
          <div className="dl-cell">
            <div className="k">Band ±</div>
            <div className="v">{fmt(expected.hi - expected.point)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── M5 · StabilityCard — bias σ + flip rate + interval growth ── */
function StabilityCard({ stability }) {
  if (!stability || stability.label === "unknown") {
    return (
      <div className="card">
        <h3>Stability <span className="badge">warmup</span></h3>
        <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>Need ≥ 3 bars of orchestration history.</div>
      </div>
    );
  }
  const tone = stability.label === "stable" ? "bull"
            : stability.label === "moderate" ? ""
            : "bear";
  const c = stability.components || {};
  const bar = (label, v, color) => (
    <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 32px", gap: 6, alignItems: "center", fontSize: 11 }}>
      <span style={{ color: "var(--fg-dim)" }}>{label}</span>
      <div style={{ position: "relative", height: 6, background: "var(--bg)", borderRadius: 2, overflow: "hidden" }}>
        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round((v||0)*100)}%`, background: color }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", textAlign: "right" }}>{((v||0)*100).toFixed(0)}</span>
    </div>
  );
  return (
    <div className="card">
      <h3>Stability <span className={"badge " + tone}>{stability.label.toUpperCase()} {(stability.score*100).toFixed(0)}</span></h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {bar("Bias σ",       c.bias,      "rgba(38,166,154,.7)")}
        {bar("Direction",    c.direction, "rgba(41,98,255,.7)")}
        {bar("Interval",     c.interval,  "rgba(255,176,32,.7)")}
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6 }}>
        σ(bias)={Number.isFinite(stability.biasSigma) ? stability.biasSigma.toFixed(3) : "—"} · flips={Number.isFinite(stability.flipRate) ? (stability.flipRate * 100).toFixed(0)+"%" : "—"} · n={stability.n}
      </div>
    </div>
  );
}

/* ── M5 · AdaptiveWeightsCard — per-module EWMA hit-rates ── */
function AdaptiveWeightsCard({ adaptive, tick, orch }) {
  if (!adaptive) return null;
  const ema = adaptive.emaSnapshot ? adaptive.emaSnapshot() : {};
  const ids = Object.keys(ema);
  if (ids.length === 0) {
    return (
      <div className="card">
        <h3>Adaptive Weights <span className="badge">warmup</span></h3>
        <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>Awaiting validation:verdict events to learn module accuracy.</div>
      </div>
    );
  }
  const weights = adaptive.weights ? adaptive.weights(ids) : {};
  const sorted = ids.slice().sort((a, b) => (ema[b] || 0) - (ema[a] || 0));
  const meta = MODULE_META || {};
  return (
    <div className="card">
      <h3>Adaptive Weights <span className="badge">{ids.length} mods</span></h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
        {sorted.slice(0, 10).map((id) => {
          const e = ema[id] || 0;
          const w = weights[id] || 0;
          const tone = e >= 0.6 ? "bull" : e <= 0.4 ? "bear" : "";
          const m = meta[id];
          return (
            <div key={id} style={{ display: "grid", gridTemplateColumns: "20px 1fr 50px", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 12 }}>{m?.emoji || "•"}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ color: "var(--fg)" }}>{m?.label || id}</span>
                <div style={{ position: "relative", height: 4, background: "var(--bg)", borderRadius: 2, overflow: "hidden" }}>
                  <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round(w*100)}%`, background: tone === "bull" ? "var(--bull)" : tone === "bear" ? "var(--bear)" : "var(--accent)" }} />
                </div>
              </div>
              <span style={{ fontFamily: "var(--font-mono)", textAlign: "right", color: tone === "bull" ? "var(--bull)" : tone === "bear" ? "var(--bear)" : "var(--fg)" }}>
                {(e*100).toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6 }}>
        EWMA hit-rate · α=0.05 · learns from validation:verdict
      </div>
    </div>
  );
}

/* ── M-LEARN-1 · MistakeLedgerCard ──
   Shows the running mistake count + last 5 wrong calls for the
   current (symbol, tf) so you can see the brain working. */
/* ── M-LEARN-2/3 · AntiPatternCard ──
   Lists the active anti-patterns, sorted by miss-rate (worst first).
   Refreshes whenever `antipatterns:rebuilt` fires. */
function AntiPatternCard() {
  const [aps, setAps] = useState([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const off = window.__MNP__?.EventBus?.on?.("antipatterns:rebuilt", () => setTick((n) => n + 1));
    return () => { try { off?.(); } catch {} };
  }, []);
  useEffect(() => {
    let stopped = false;
    const AP = window.__MNP__?.AntiPatterns;
    if (!AP?.listAntiPatterns) return;
    AP.listAntiPatterns({ limit: 8 }).then((rows) => { if (!stopped) setAps(rows || []); }).catch(() => {});
    return () => { stopped = true; };
  }, [tick]);
  if (!aps.length) {
    return (
      <div className="card">
        <h3>Anti-patterns <span className="badge">0</span></h3>
        <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>
          No anti-patterns yet — needs ≥ 20 mistakes to discover clusters.
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <h3>Anti-patterns <span className="badge warn">{aps.length}</span></h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {aps.slice().sort((a, b) => (a.hitRate || 0) - (b.hitRate || 0)).map((ap) => {
          const tone = ap.hitRate <= 0.25 ? "bear"
                    : ap.hitRate <= 0.40 ? "warn"
                    : "";
          return (
            <div key={ap.id} style={{ padding: "5px 6px", background: "var(--bg)", borderRadius: 3, fontSize: 11 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                <span className={"chip-toggle on " + tone} style={{ fontSize: 9, padding: "1px 5px" }}>
                  {(ap.hitRate * 100 | 0)}% hit
                </span>
                <span style={{ color: "var(--fg-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ap.label}
                </span>
                <span style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>{ap.mistakeN}/{ap.sampleN}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6 }}>
        Auto-rebuilt every 25 mistakes / 1 hr · meta-veto blocks ghosts when current bar matches
      </div>
    </div>
  );
}

function MistakeLedgerCard({ symbol, tf }) {
  const [sum, setSum] = useState(null);
  const [recent, setRecent] = useState([]);
  const [tick, setTick] = useState(0);

  // Listen for new mistakes; refresh stats.
  useEffect(() => {
    const off = window.__MNP__?.EventBus?.on?.("mistake:recorded", () => setTick((n) => n + 1));
    return () => { try { off?.(); } catch {} };
  }, []);

  useEffect(() => {
    let stopped = false;
    const ML = window.__MNP__?.MistakeLedger;
    if (!ML) return;
    (async () => {
      try {
        const [s, r] = await Promise.all([
          ML.summary(),
          ML.recent({ limit: 5, symbol, tf }),
        ]);
        if (!stopped) { setSum(s); setRecent(r); }
      } catch { /* ignore */ }
    })();
    return () => { stopped = true; };
  }, [symbol, tf, tick]);

  if (!sum) {
    return (
      <div className="card">
        <h3>Mistake Ledger <span className="badge">loading</span></h3>
      </div>
    );
  }
  const total = sum.total || 0;
  const tone = total === 0 ? "" : "warn";
  const dirN = sum.byErrorType?.direction || 0;
  const intN = sum.byErrorType?.["interval-miss"] || 0;
  const magN = sum.byErrorType?.magnitude || 0;
  return (
    <div className="card">
      <h3>Mistake Ledger <span className={"badge " + tone}>{total}</span></h3>
      {total === 0 ? (
        <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>
          No wrong calls recorded yet.  When verdicts come in, mistakes land here.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
            <div className="dl-cell"><div className="k">Direction</div><div className="v" style={{ color: dirN > 0 ? "var(--bear)" : "var(--fg)" }}>{dirN}</div></div>
            <div className="dl-cell"><div className="k">Interval</div><div className="v" style={{ color: intN > 0 ? "var(--bear)" : "var(--fg)" }}>{intN}</div></div>
            <div className="dl-cell"><div className="k">Magnitude</div><div className="v" style={{ color: magN > 0 ? "var(--bear)" : "var(--fg)" }}>{magN}</div></div>
          </div>
          {recent.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: 1 }}>
                Last {recent.length} on {symbol} · {tf}
              </div>
              {recent.map((m) => {
                const age = Date.now() - (m.t || m.createdAt || 0);
                const ageStr = age < 3600_000 ? `${(age/60_000)|0}m`
                            : age < 86400_000 ? `${(age/3600_000)|0}h`
                            : `${(age/86400_000)|0}d`;
                return (
                  <div key={m.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 6, fontSize: 11, padding: "3px 6px", background: "var(--bg)", borderRadius: 3 }}>
                    <span className="chip-toggle on bear" style={{ fontSize: 9, padding: "1px 5px" }}>{m.errorType}</span>
                    <span style={{ color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      pred {m.predicted?.direction || "?"} → real {m.realized?.direction || "?"}
                      {Number.isFinite(m.errorMag) && ` · ${m.errorMag.toFixed(2)} ATR`}
                      {m.context?.regime && <span style={{ marginLeft: 4 }}>· {m.context.regime}</span>}
                    </span>
                    <span style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>{ageStr}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: 10, color: "var(--fg-dim)" }}>No recent mistakes for this pair.</div>
          )}
        </>
      )}
    </div>
  );
}

function MasterBiasCard({ orch }) {
  if (!orch) return null;
  return (
    <div className="card">
      <h3>Master Bias <span className="badge">{fmt(orch.rawScore, 2)}</span></h3>
      <BiasTrack value={orch.rawScore} />
      <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 10, lineHeight: 1.5 }}>
        Weighted ensemble across {orch.signals?.length ?? 13} analysis modules.
        Global multiplier · <b style={{ color: "var(--fg)" }}>{fmt(orch.globalMult, 2)}</b>
        {" · "}effective modules · <b style={{ color: "var(--fg)" }}>{orch.participating}</b>
      </div>
    </div>
  );
}

function ModuleBreakdownCard({ orch }) {
  if (!orch?.signals) return null;
  const sorted = orch.signals.slice().sort((a, b) => Math.abs(b.signal * b.confidence) - Math.abs(a.signal * a.confidence));
  return (
    <div className="card">
      <h3>Module Breakdown <span className="badge">{orch.signals.length}</span></h3>
      {sorted.map(s => {
        const meta = MODULE_META[s.id] || { emoji: "🔸", label: s.id };
        const tone = directionTone(s.direction);
        const strength = Math.abs(s.signal) * (s.confidence ?? 0);
        const pct = Math.min(100, strength * 100);
        return (
          <div key={s.id} className={"module-row " + tone}>
            <div className="name">
              <span className="emoji">{meta.emoji}</span>{meta.label}
            </div>
            <div className="mini-bar">
              <span style={{
                width: pct + "%",
                background: tone === "bull" ? "var(--bull)" : tone === "bear" ? "var(--bear)" : "var(--fg-dim)",
                left: 0,
              }} />
            </div>
            <div className="sig" style={{ color: tone === "bull" ? "var(--bull)" : tone === "bear" ? "var(--bear)" : "var(--fg-dim)" }}>
              {fmtSigned(s.signal, 2)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DLSupervisorCard({ orch, expected, ta }) {
  // The NN + conformal path won't have calibration until some validation data
  // accrues.  Until then we show a "diagnostic" readout built from ensemble
  // probability + ATR-derived expected move.
  const nnReady = !!window.__MNP__?.ModelStore;   // NN surface available
  const atr = Array.isArray(ta?.atr14) ? ta.atr14[ta.atr14.length - 1] : ta?.atr14;
  return (
    <div className="card">
      <h3>Deep-Learning Supervisor
        <span className="badge">{nnReady ? "NN · conformal" : "fallback"}</span>
      </h3>
      <div className="dl-grid">
        <div className="dl-cell">
          <div className="k">P(up)</div>
          <div className="v" style={{ color: orch ? (orch.probability > 0.5 ? "var(--bull)" : "var(--bear)") : "var(--fg)" }}>
            {orch ? fmtPct(orch.probability) : "—"}
          </div>
        </div>
        <div className="dl-cell">
          <div className="k">Confidence</div>
          <div className="v">{orch ? fmtPct(orch.confidence) : "—"}</div>
        </div>
        <div className="dl-cell">
          <div className="k">Expected move</div>
          <div className="v" style={{ color: expected && expected.direction > 0 ? "var(--bull)" : "var(--bear)" }}>
            {expected ? fmtSigned(expected.point - expected.last) : "—"}
          </div>
        </div>
        <div className="dl-cell">
          <div className="k">Volatility (ATR14)</div>
          <div className="v">{Number.isFinite(atr) ? fmt(atr) : "—"}</div>
        </div>
      </div>
    </div>
  );
}

/* ── M4b · WyckoffCard — phase chip + bull%/range/volume scores ── */
function WyckoffCard({ ta }) {
  const w = ta?.wyckoff;
  if (!w) return null;
  const phaseTone = w.bias === "bullish" ? "bull"
                  : w.bias === "bearish" ? "bear"
                  : "";
  const phaseLabel = (w.phase || "neutral").toUpperCase();
  return (
    <div className="card">
      <h3>
        Wyckoff Phase
        <span className={"badge " + phaseTone}>{phaseLabel}</span>
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <div className="dl-cell"><div className="k">Bias</div><div className="v" style={{ textTransform: "capitalize" }}>{w.bias}</div></div>
        <div className="dl-cell"><div className="k">Bull %</div><div className="v">{Number.isFinite(w.bullPct) ? w.bullPct.toFixed(0) + "%" : "—"}</div></div>
        <div className="dl-cell"><div className="k">Volume slope</div><div className="v" style={{ color: w.volumeSlope > 0 ? "var(--bull)" : w.volumeSlope < 0 ? "var(--bear)" : "var(--fg)" }}>{Number.isFinite(w.volumeSlope) ? (w.volumeSlope >= 0 ? "+" : "") + (w.volumeSlope * 100).toFixed(1) + "%" : "—"}</div></div>
        <div className="dl-cell"><div className="k">Range %</div><div className="v">{Number.isFinite(w.rangePct) ? (w.rangePct * 100).toFixed(2) + "%" : "—"}</div></div>
      </div>
      {Array.isArray(w.reasons) && w.reasons.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6 }}>
          {w.reasons[0]}
        </div>
      )}
    </div>
  );
}

function ContextCard({ ta, candles }) {
  if (!ta || ta.empty) return null;
  const last = ta.close?.[ta.close.length - 1];
  const atr  = Array.isArray(ta.atr14) ? ta.atr14[ta.atr14.length - 1] : ta.atr14;
  const rsi  = Array.isArray(ta.rsi14) ? ta.rsi14[ta.rsi14.length - 1] : ta.rsi14;
  const vwap = Array.isArray(ta.vwap)  ? ta.vwap[ta.vwap.length - 1]  : ta.vwap;
  const trend = ta.trend || "—";
  // Phase-6 regime bundle
  const regime = ta.regime || {};
  // Premium/discount per Phase-4 module (engine stores `lastZone`)
  const pd  = ta.premiumDiscount?.lastZone || ta.summary?.zone;
  const pdhpdl = derivePDHPDL(candles);
  return (
    <div className="card">
      <h3>Market Context <span className="badge">{trend}</span></h3>
      <div className="dl-grid">
        <div className="dl-cell"><div className="k">Last</div><div className="v">{fmt(last)}</div></div>
        <div className="dl-cell"><div className="k">RSI 14</div>
          <div className="v" style={{ color: rsi > 70 ? "var(--bear)" : rsi < 30 ? "var(--bull)" : "var(--fg)" }}>{fmt(rsi, 1)}</div>
        </div>
        <div className="dl-cell"><div className="k">VWAP Δ</div>
          <div className="v">{Number.isFinite(vwap) && Number.isFinite(last) ? fmtSigned(last - vwap) : "—"}</div>
        </div>
        <div className="dl-cell"><div className="k">ATR 14</div><div className="v">{fmt(atr)}</div></div>
        <div className="dl-cell"><div className="k">PDH</div><div className="v" style={{ color: "var(--bull)" }}>{fmt(pdhpdl?.pdh)}</div></div>
        <div className="dl-cell"><div className="k">PDL</div><div className="v" style={{ color: "var(--bear)" }}>{fmt(pdhpdl?.pdl)}</div></div>
        <div className="dl-cell" style={{ gridColumn: "1 / -1" }}>
          <div className="k">Regime</div>
          <div className="v" style={{ textTransform: "uppercase", letterSpacing: 1, fontSize: 13 }}>
            {regime.label || "—"}
            <span style={{ color: "var(--fg-dim)", fontSize: 11, marginLeft: 8, fontWeight: 400 }}>
              {regime.trend && `· ${regime.trend}`} {regime.volatility && `· ${regime.volatility} vol`}
            </span>
          </div>
        </div>
        <div className="dl-cell" style={{ gridColumn: "1 / -1" }}>
          <div className="k">Premium / Discount</div>
          <div className="v" style={{ textTransform: "uppercase", letterSpacing: 1 }}>{pd || "—"}</div>
        </div>
      </div>
    </div>
  );
}

/* ── Trade Setup — computes Entry / TP1 / TP2 / SL / R:R from expected move + ATR */
function TradeSetupCard({ orch, expected, ta }) {
  if (!orch || !expected || !ta || ta.empty) return null;
  const atr = Array.isArray(ta.atr14) ? ta.atr14[ta.atr14.length - 1] : ta.atr14;
  if (!Number.isFinite(atr) || !Number.isFinite(expected.last)) return null;
  const longSide = expected.direction > 0;
  const entry = expected.last;
  const sl    = longSide ? entry - atr * 1.25 : entry + atr * 1.25;
  const tp1   = longSide ? entry + atr * 1.00 : entry - atr * 1.00;
  const tp2   = longSide ? entry + atr * 2.00 : entry - atr * 2.00;
  const risk  = Math.abs(entry - sl);
  const rewardTp1 = Math.abs(tp1 - entry);
  const rr1 = risk > 0 ? rewardTp1 / risk : 0;
  const rr2 = risk > 0 ? Math.abs(tp2 - entry) / risk : 0;
  const tone = longSide ? "bull" : "bear";
  const abstain = Math.abs(orch.rawScore || 0) < 0.15;
  return (
    <div className="card">
      <h3>Trade Setup
        <span className={"badge " + tone}>{longSide ? "LONG" : "SHORT"}</span>
      </h3>
      {abstain && (
        <div style={{ padding: 6, marginBottom: 8, background: "rgba(255,193,7,.08)", border: "1px solid rgba(255,193,7,.25)", borderRadius: 4, fontSize: 11, color: "var(--warn)" }}>
          ⚠ bias |{fmt(orch.rawScore, 2)}| too small — stand aside
        </div>
      )}
      <div className="dl-grid">
        <div className="dl-cell">
          <div className="k">Entry</div>
          <div className="v">{fmt(entry)}</div>
        </div>
        <div className="dl-cell">
          <div className="k">Stop Loss</div>
          <div className="v" style={{ color: "var(--bear)" }}>{fmt(sl)}</div>
        </div>
        <div className="dl-cell">
          <div className="k">TP1 <span style={{ opacity: .6, fontSize: 10 }}>({rr1.toFixed(2)}R)</span></div>
          <div className="v" style={{ color: "var(--bull)" }}>{fmt(tp1)}</div>
        </div>
        <div className="dl-cell">
          <div className="k">TP2 <span style={{ opacity: .6, fontSize: 10 }}>({rr2.toFixed(2)}R)</span></div>
          <div className="v" style={{ color: "var(--bull)" }}>{fmt(tp2)}</div>
        </div>
      </div>
      <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--fg-dim)" }}>
        <span>Risk · <b style={{ color: "var(--fg)" }}>{fmt(risk)}</b></span>
        <span>ATR·1.25 stop · 1.0/2.0 ATR targets</span>
      </div>
    </div>
  );
}

/* ── Pattern Detection — reads ta.patterns */
function PatternCard({ ta }) {
  if (!ta || ta.empty || !Array.isArray(ta.patterns)) return null;
  const tail = ta.patterns.slice(-8).reverse();
  if (!tail.length) {
    return (
      <div className="card">
        <h3>Pattern Detection <span className="badge">0</span></h3>
        <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>No recent candlestick patterns.</div>
      </div>
    );
  }
  const tag = (name) => {
    const bull = /bull|hammer|piercing|morning|engulf.*bull|invertedHammer/i.test(name);
    const bear = /bear|shooting|dark|evening|engulf.*bear|hanged/i.test(name);
    return bull ? "bull" : bear ? "bear" : "flat";
  };
  return (
    <div className="card">
      <h3>Pattern Detection <span className="badge">{ta.patterns.length}</span></h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {tail.map((p, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, padding: "4px 6px", background: "var(--bg)", borderRadius: 4 }}>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {(p.patterns || []).map((name, j) => (
                <span key={j} className={"chip-toggle on " + tag(name)} style={{ fontSize: 10, padding: "2px 6px" }}>
                  {name}
                </span>
              ))}
            </div>
            <span style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
              {new Date(p.t).toISOString().slice(11, 16)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Key Levels — lists BSL/SSL liquidity + equal-highs/lows */
function KeyLevelsCard({ ta }) {
  if (!ta || ta.empty || !ta.liquidity) return null;
  const { eqHighs = [], eqLows = [], sweeps = [] } = ta.liquidity;
  const last = ta.close?.[ta.close.length - 1];
  const topN = (arr, k) => arr.slice().sort((a, b) => Math.abs(b.price - last) > Math.abs(a.price - last) ? -1 : 1).slice(0, k);
  const bsl = topN(eqHighs, 3);
  const ssl = topN(eqLows,  3);
  const lastSweep = sweeps.slice(-1)[0];
  return (
    <div className="card">
      <h3>Key Levels
        <span className="badge">{eqHighs.length}·BSL / {eqLows.length}·SSL</span>
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <div style={{ fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Buy-Side (BSL)</div>
          {bsl.length ? bsl.map((l, i) => (
            <div key={i} style={{ fontSize: 11, color: "var(--bull)", fontFamily: "var(--font-mono)" }}>
              {fmt(l.price)} <span style={{ color: "var(--fg-dim)" }}>×{l.touches ?? "?"}</span>
            </div>
          )) : <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>—</div>}
        </div>
        <div>
          <div style={{ fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Sell-Side (SSL)</div>
          {ssl.length ? ssl.map((l, i) => (
            <div key={i} style={{ fontSize: 11, color: "var(--bear)", fontFamily: "var(--font-mono)" }}>
              {fmt(l.price)} <span style={{ color: "var(--fg-dim)" }}>×{l.touches ?? "?"}</span>
            </div>
          )) : <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>—</div>}
        </div>
      </div>
      {lastSweep && (
        <div style={{ marginTop: 10, padding: 6, background: "rgba(179,136,255,.08)", border: "1px solid rgba(179,136,255,.25)", borderRadius: 4, fontSize: 11 }}>
          Last sweep · <b style={{ color: lastSweep.kind === "bullish" ? "var(--bull)" : "var(--bear)" }}>{lastSweep.kind?.toUpperCase()}</b> @ {fmt(lastSweep.level)}
        </div>
      )}
    </div>
  );
}

/* ── Volume Profile — bucket volume by price, horizontal bars */
/* ── Chart-pattern card (M3 step 6) ──
   Shows the current detected geometric pattern (H&S, double/triple
   tops/bottoms, triangles).  Bias chip + confidence badge + measured-
   move target + invalidation level + a tiny SVG of the anchor points. */
function ChartPatternCard({ ta }) {
  const cp = ta?.chartPatterns;
  if (!cp || !cp.last) {
    return (
      <div className="card">
        <h3>Chart Pattern <span className="badge">none</span></h3>
        <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>
          No geometric pattern in last 30 bars.
        </div>
      </div>
    );
  }
  const p = cp.last;
  const tone = p.bias === "bullish" ? "bull" : p.bias === "bearish" ? "bear" : "flat";
  const confLabel = p.confidence >= 0.75 ? "HIGH"
                  : p.confidence >= 0.45 ? "MED"
                  : "LOW";
  // Mini SVG of anchor points (relative coordinates).
  const anchors = Array.isArray(p.anchorPoints) ? p.anchorPoints : [];
  const W = 180, H = 56;
  let svg = null;
  if (anchors.length >= 2) {
    const xs = anchors.map(a => a.i);
    const ys = anchors.map(a => a.p);
    const xLo = Math.min(...xs), xHi = Math.max(...xs);
    const yLo = Math.min(...ys), yHi = Math.max(...ys);
    const xR = Math.max(1e-9, xHi - xLo);
    const yR = Math.max(1e-9, yHi - yLo);
    const px = (x) => 4 + ((x - xLo) / xR) * (W - 8);
    const py = (y) => H - 4 - ((y - yLo) / yR) * (H - 8);
    const pts = anchors.map(a => `${px(a.i).toFixed(1)},${py(a.p).toFixed(1)}`).join(" ");
    const stroke = tone === "bull" ? "#26a69a" : tone === "bear" ? "#ef5350" : "#9aa0ab";
    svg = (
      <svg width={W} height={H} aria-hidden="true" style={{ display: "block", margin: "4px 0 6px" }}>
        <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" />
        {anchors.map((a, i) => (
          <circle key={i} cx={px(a.i)} cy={py(a.p)} r="2.5" fill={stroke} />
        ))}
      </svg>
    );
  }
  return (
    <div className="card">
      <h3>Chart Pattern <span className={"badge " + tone}>{p.bias.toUpperCase()}</span></h3>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontWeight: "bold" }}>{p.name}</span>
        <span className={"badge " + (p.confidence >= 0.75 ? "bull" : p.confidence >= 0.45 ? "" : "fg-dim")}>
          {confLabel} {fmtPct(p.confidence, 0)}
        </span>
      </div>
      {svg}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <div className="dl-cell">
          <div className="k">Target</div>
          <div className="v">{Number.isFinite(p.targetPrice) ? fmt(p.targetPrice) : "—"}</div>
        </div>
        <div className="dl-cell">
          <div className="k">Invalidation</div>
          <div className="v">{Number.isFinite(p.invalidationPrice) ? fmt(p.invalidationPrice) : "—"}</div>
        </div>
        <div className="dl-cell">
          <div className="k">Status</div>
          <div className="v" style={{ color: p.broken ? "var(--bull)" : "var(--fg-dim)" }}>
            {p.broken ? "confirmed" : "forming"}
          </div>
        </div>
        <div className="dl-cell">
          <div className="k">Age</div>
          <div className="v">{Number.isFinite(p.ageBars) ? `${p.ageBars} bars` : "—"}</div>
        </div>
      </div>
      {Array.isArray(cp.patterns) && cp.patterns.length > 1 && (
        <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6 }}>
          + {cp.patterns.length - 1} other candidate{cp.patterns.length === 2 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

const VP_BUCKET_OPTIONS   = [12, 24, 48, 96];
const VP_LOOKBACK_OPTIONS = [50, 100, 200, 500];

function VolumeProfileCard({ ta }) {
  const [buckets,  setBuckets]  = useState(24);
  const [lookback, setLookback] = useState(200);

  // Build a lightweight candle array view from the TA snapshot.
  const candles = useMemo(() => {
    if (!ta || ta.empty || !ta.t?.length) return null;
    const n = ta.t.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = { t: ta.t[i], o: ta.open[i], h: ta.high[i], l: ta.low[i], c: ta.close[i], v: ta.volume[i] };
    }
    return out;
  }, [ta]);

  const VP = window.__MNP__?.VolumeProfile;
  const bundle = useMemo(() => {
    if (!VP || !candles) return null;
    try { return VP.computeVolumeProfile(candles, { buckets, lookback }); }
    catch (err) { console.warn("[ui] VP compute failed", err); return null; }
  }, [VP, candles, buckets, lookback]);

  // Emit `vp:updated` (and a paired `vp:vah-val` snapshot) whenever the
  // bundle changes so other surfaces (e.g. the chart overlay, scanner,
  // AI chat) can subscribe without re-computing.
  useEffect(() => {
    const bus = window.__MNP__?.EventBus;
    if (!bus || !bundle) return;
    try {
      bus.emit("vp:updated", { bundle, buckets, lookback });
      bus.emit("vp:vah-val", { poc: bundle.pocPrice, vah: bundle.vahPrice, val: bundle.valPrice });
    } catch { /* swallow listener errors */ }
  }, [bundle, buckets, lookback]);

  const picker = (label, value, options, setValue) => (
    <div style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 10 }}>
      <span style={{ color: "var(--fg-dim)", marginRight: 4, textTransform: "uppercase", letterSpacing: 1 }}>{label}</span>
      {options.map((n) => (
        <button
          key={n}
          type="button"
          className={"chip-toggle " + (value === n ? "on" : "")}
          style={{ fontSize: 10, padding: "3px 8px" }}
          onClick={() => setValue(n)}
          aria-pressed={value === n}>
          {n}
        </button>
      ))}
    </div>
  );

  if (!bundle) {
    return (
      <div className="card">
        <h3>Volume Profile <span className="badge">warmup</span></h3>
        <div style={{ color: "var(--fg-dim)", fontSize: 12, marginBottom: 8 }}>
          Need price-bucketable history (≥ 2 bars with non-flat range).
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {picker("Buckets",  buckets,  VP_BUCKET_OPTIONS,   setBuckets)}
          {picker("Lookback", lookback, VP_LOOKBACK_OPTIONS, setLookback)}
        </div>
      </div>
    );
  }

  const last  = ta?.close?.[ta.close.length - 1];
  const maxV  = bundle.rows.reduce((m, r) => r.vol > m ? r.vol : m, 0) || 1;

  return (
    <div className="card">
      <h3>Volume Profile
        <span className="badge">{bundle.lookback}b · {bundle.buckets}c</span>
      </h3>

      {/* KPI strip — POC / VAH / VAL */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
        <div className="dl-cell"><div className="k">POC</div><div className="v" style={{ color: "var(--warn)" }}>{fmt(bundle.pocPrice)}</div></div>
        <div className="dl-cell"><div className="k">VAH</div><div className="v">{fmt(bundle.vahPrice)}</div></div>
        <div className="dl-cell"><div className="k">VAL</div><div className="v">{fmt(bundle.valPrice)}</div></div>
      </div>

      <div style={{ display: "flex", flexDirection: "column-reverse", gap: 1, fontSize: 10, fontFamily: "var(--font-mono)" }}>
        {bundle.rows.map((r) => {
          const w = (r.vol / maxV) * 100;
          const upPct = r.vol > 0 ? (r.up / r.vol) * 100 : 0;
          const near  = Number.isFinite(last) && last >= r.lo && last < r.hi;
          const tag = r.isPOC ? "POC"
                    : r.isVAH ? "VAH"
                    : r.isVAL ? "VAL"
                    : r.density === "HVN" ? "HVN"
                    : r.density === "LVN" ? "LVN"
                    : "";
          const tagColor = r.isPOC ? "var(--warn)"
                         : r.isVAH || r.isVAL ? "var(--accent)"
                         : r.density === "HVN" ? "var(--bull)"
                         : r.density === "LVN" ? "var(--fg-dim)"
                         : "var(--fg-dim)";
          // Visual: shaded background for value-area rows, framed border for POC,
          // dashed top/bottom for VAH/VAL.
          const rowBg = r.inValueArea ? "rgba(41,98,255,.05)" : "transparent";
          const border =
            r.isPOC ? "1px solid var(--warn)"
            : r.isVAH ? "1px dashed var(--accent)"
            : r.isVAL ? "1px dashed var(--accent)"
            : "none";
          return (
            <div
              key={r.idx}
              style={{
                display: "grid",
                gridTemplateColumns: "54px 1fr 38px",
                alignItems: "center",
                gap: 4,
                opacity: r.inValueArea ? 1 : 0.78,
                background: rowBg,
                paddingRight: 2,
              }}>
              <span style={{ color: near ? "var(--accent)" : "var(--fg-dim)", fontSize: 9 }}>
                {fmt(r.mid, r.mid > 1000 ? 0 : 2)}
              </span>
              <div style={{ position: "relative", height: 10, background: "var(--bg)", borderRadius: 2, overflow: "hidden", border }}>
                <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${w * upPct / 100}%`, background: "rgba(38,166,154,.55)" }} />
                <span style={{ position: "absolute", left: `${w * upPct / 100}%`, top: 0, bottom: 0, width: `${w * (100 - upPct) / 100}%`, background: "rgba(239,83,80,.55)" }} />
              </div>
              <span style={{ color: tagColor, textAlign: "right", fontSize: 9, fontWeight: r.isPOC ? "bold" : "normal" }}>
                {tag}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, paddingTop: 8, borderTop: "1px dashed var(--border)" }}>
        {picker("Buckets",  buckets,  VP_BUCKET_OPTIONS,   setBuckets)}
        {picker("Lookback", lookback, VP_LOOKBACK_OPTIONS, setLookback)}
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6 }}>
        VA {Math.round(bundle.valueAreaPct * 100)} % · HVN {bundle.hvnCount} · LVN {bundle.lvnCount}
      </div>
    </div>
  );
}

/* ── Liquidation heatmap (approximation) — cluster from recent sweeps + high-volume candles */
function LiquidationHeatmapCard({ ta }) {
  if (!ta || ta.empty) return null;
  const last = ta.close?.[ta.close.length - 1];
  const atr  = Array.isArray(ta.atr14) ? ta.atr14[ta.atr14.length - 1] : ta.atr14;
  if (!Number.isFinite(last) || !Number.isFinite(atr)) return null;
  // Approximate "liquidation zones" from: PDH/PDL, equal-highs/lows, and ATR bands
  const zones = [];
  if (ta.liquidity) {
    for (const eh of (ta.liquidity.eqHighs || []).slice(0, 6)) {
      zones.push({ side: "long", price: eh.price, score: (eh.touches || 1) * 0.3 });
    }
    for (const el of (ta.liquidity.eqLows || []).slice(0, 6)) {
      zones.push({ side: "short", price: el.price, score: (el.touches || 1) * 0.3 });
    }
  }
  // ATR band approximations (common leverage liquidation zones)
  for (const mult of [1, 2, 3]) {
    zones.push({ side: "long",  price: last - atr * mult, score: 1 / mult, atr: mult });
    zones.push({ side: "short", price: last + atr * mult, score: 1 / mult, atr: mult });
  }
  zones.sort((a, b) => a.price - b.price);
  const maxScore = zones.reduce((m, z) => z.score > m ? z.score : m, 0) || 1;
  return (
    <div className="card">
      <h3>Liquidation Heatmap
        <span className="badge">{zones.length} zones</span>
      </h3>
      <div style={{ display: "flex", flexDirection: "column-reverse", gap: 2, fontSize: 10, fontFamily: "var(--font-mono)" }}>
        {zones.map((z, i) => {
          const w = (z.score / maxScore) * 100;
          const near = Math.abs(z.price - last) < atr * 0.5;
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "60px 1fr 30px", alignItems: "center", gap: 4 }}>
              <span style={{ color: near ? "var(--accent)" : "var(--fg-dim)" }}>{fmt(z.price, z.price > 1000 ? 0 : 2)}</span>
              <div style={{ position: "relative", height: 8, background: "var(--bg)", borderRadius: 2, overflow: "hidden" }}>
                <span style={{
                  position: "absolute", top: 0, bottom: 0,
                  left: z.side === "long" ? 0 : `${100 - w}%`,
                  width: `${w}%`,
                  background: z.side === "long" ? "linear-gradient(90deg,#26a69a,#26a69a55)" : "linear-gradient(270deg,#ef5350,#ef535055)",
                }} />
              </div>
              <span style={{ color: "var(--fg-dim)", textAlign: "right", fontSize: 9 }}>
                {z.atr ? `${z.atr}x` : "eq"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Long/Short ratio — Binance public futures API */
function useLongShortRatio(symbol, tf = "15m") {
  const [data, setData] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const fetcher = async () => {
      try {
        const url = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=${tf}&limit=20`;
        const res = await fetch(url, { mode: "cors" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const json = await res.json();
        if (cancelled || !Array.isArray(json)) return;
        setData({
          series: json.map(r => ({
            t: +r.timestamp,
            ratio: +r.longShortRatio,
            longPct: +r.longAccount * 100,
            shortPct: +r.shortAccount * 100,
          })),
          updatedAt: Date.now(),
        });
      } catch (err) {
        if (!cancelled) setData({ error: err.message || String(err), updatedAt: Date.now() });
      }
    };
    fetcher();
    timer = setInterval(fetcher, 60_000);
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [symbol, tf]);
  return data;
}

/* ── M4c · DerivCard — OI / funding / L-S snapshot via Binance USDT-M ── */
function DerivCard({ symbol }) {
  const [snap, setSnap] = useState(null);
  const [err, setErr]   = useState(null);
  useEffect(() => {
    const DM = window.__MNP__?.DerivManager;
    if (!DM?.getSnapshot) { setSnap(null); return; }
    let stopped = false;
    setSnap(null); setErr(null);
    DM.getSnapshot(symbol).then((s) => { if (!stopped) setSnap(s); })
      .catch((e) => { if (!stopped) setErr(e?.message || String(e)); });
    const t = setInterval(() => {
      DM.getSnapshot(symbol, { force: true }).then((s) => { if (!stopped) setSnap(s); }).catch(() => {});
    }, 60_000);
    return () => { stopped = true; clearInterval(t); };
  }, [symbol]);

  // Skip card entirely for non-USDT crypto / non-crypto.
  if (!/USDT(:.*)?$/.test(String(symbol||"")) && !/USD_PERP/.test(String(symbol||""))) return null;
  if (!snap) {
    return (
      <div className="card">
        <h3>Derivatives <span className="badge">{err ? "err" : "loading…"}</span></h3>
        <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>
          {err ? `Fetch failed: ${err}` : "Pulling OI / funding / L-S from Binance USDT-M…"}
        </div>
      </div>
    );
  }
  const fund = snap.premiumIndex?.lastFundingRate;
  const fundPct = Number.isFinite(fund) ? fund * 100 : null;
  const fundTone = !Number.isFinite(fund) ? ""
                 : fund > 0.0001 ? "bear"   // longs paying shorts → richer-priced longs → mean revert bear
                 : fund < -0.0001 ? "bull"
                 : "";
  const lsLatest = (snap.lsHist && snap.lsHist[snap.lsHist.length - 1]) || null;
  const ls       = lsLatest?.longShortRatio;
  const lsTone   = !Number.isFinite(ls) ? ""
                 : ls > 1.5 ? "bear"
                 : ls < 0.7 ? "bull"
                 : "";
  const oiUSD    = snap.oiHist && snap.oiHist[snap.oiHist.length - 1]?.openInterestUSD;
  const oiPrev   = snap.oiHist && snap.oiHist[Math.max(0, snap.oiHist.length - 24)]?.openInterestUSD;
  const oiPct    = (Number.isFinite(oiUSD) && Number.isFinite(oiPrev) && oiPrev > 0)
                  ? ((oiUSD - oiPrev) / oiPrev) * 100 : null;
  const fmtUSD = (v) => !Number.isFinite(v) ? "—"
                      : v > 1e9 ? `$${(v/1e9).toFixed(2)}B`
                      : v > 1e6 ? `$${(v/1e6).toFixed(1)}M`
                      :           `$${Math.round(v).toLocaleString()}`;
  return (
    <div className="card">
      <h3>Derivatives <span className="badge">{snap.symbol}</span></h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <div className="dl-cell">
          <div className="k">OI (USD)</div>
          <div className="v">{fmtUSD(oiUSD || snap.oi?.openInterest)}</div>
        </div>
        <div className="dl-cell">
          <div className="k">OI Δ24h</div>
          <div className="v" style={{ color: oiPct > 0 ? "var(--bull)" : oiPct < 0 ? "var(--bear)" : "var(--fg)" }}>
            {Number.isFinite(oiPct) ? `${oiPct >= 0 ? "+" : ""}${oiPct.toFixed(2)}%` : "—"}
          </div>
        </div>
        <div className="dl-cell">
          <div className="k">Funding (8h)</div>
          <div className={"v " + fundTone} style={{ color: fundTone === "bear" ? "var(--bear)" : fundTone === "bull" ? "var(--bull)" : undefined }}>
            {Number.isFinite(fundPct) ? `${fundPct >= 0 ? "+" : ""}${fundPct.toFixed(4)}%` : "—"}
          </div>
        </div>
        <div className="dl-cell">
          <div className="k">L/S (top trader)</div>
          <div className={"v " + lsTone} style={{ color: lsTone === "bear" ? "var(--bear)" : lsTone === "bull" ? "var(--bull)" : undefined }}>
            {Number.isFinite(ls) ? ls.toFixed(2) : "—"}
          </div>
        </div>
        <div className="dl-cell">
          <div className="k">Mark</div>
          <div className="v">{Number.isFinite(snap.premiumIndex?.markPrice) ? fmt(snap.premiumIndex.markPrice) : "—"}</div>
        </div>
        <div className="dl-cell">
          <div className="k">Index</div>
          <div className="v">{Number.isFinite(snap.premiumIndex?.indexPrice) ? fmt(snap.premiumIndex.indexPrice) : "—"}</div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6 }}>
        OI samples: {snap.oiHist?.length || 0} · L/S samples: {snap.lsHist?.length || 0}
      </div>
    </div>
  );
}

/* ── M4c · IntermarketCard — RS-vs-BTC + correlation panel for current symbol ── */
function IntermarketCard({ symbol, candles }) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  const C = window.__MNP__?.Correlation;
  if (!C) return null;
  // For now: compute RS-vs-BTC from current symbol's closes vs synthetic
  // BTC-USDT closes (only if our symbol IS BTC, just show vs SPX).
  // Real cross-asset closes need a fetched BTC series — keep light:
  // we only show "self" stats here unless the bus brings a peer series.
  const closes = candles.map(c => +c.c).filter(Number.isFinite);
  if (closes.length < 30) return null;
  // Pearson of returns vs lagged returns of same series (autocorrelation)
  const rets  = C.logReturns(closes);
  const lag   = rets.slice(0, -1);
  const fwd   = rets.slice(1);
  const auto  = C.pearson(lag, fwd);
  const beta1 = C.beta(rets.slice(-30), rets.slice(-30));
  const rs20  = (closes.length >= 22) ? C.relativeStrength(closes, closes.slice(0, -1), 20) : NaN;
  return (
    <div className="card">
      <h3>Intermarket <span className="badge">{symbol}</span></h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <div className="dl-cell"><div className="k">Autocorr (1)</div><div className="v">{Number.isFinite(auto) ? auto.toFixed(3) : "—"}</div></div>
        <div className="dl-cell"><div className="k">Self-β</div><div className="v">{Number.isFinite(beta1) ? beta1.toFixed(2) : "—"}</div></div>
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6 }}>
        Cross-asset corr matrix arrives in M4c-2 (multi-symbol fetcher).
      </div>
    </div>
  );
}

function LongShortRatioCard({ symbol }) {
  const data = useLongShortRatio(symbol, "15m");
  if (!data) {
    return (
      <div className="card">
        <h3>Long/Short Ratio <span className="badge">loading…</span></h3>
        <div className="shimmer" style={{ height: 40 }} />
      </div>
    );
  }
  if (data.error) {
    return (
      <div className="card">
        <h3>Long/Short Ratio <span className="badge">error</span></h3>
        <div style={{ fontSize: 11, color: "var(--bear)" }}>{data.error}</div>
      </div>
    );
  }
  const latest = data.series?.[data.series.length - 1];
  if (!latest) return null;
  const bullish = latest.ratio >= 1;
  return (
    <div className="card">
      <h3>Long/Short Ratio
        <span className={"badge " + (bullish ? "bull" : "bear")}>
          {latest.ratio.toFixed(2)}
        </span>
      </h3>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div className="dl-cell">
          <div className="k">Long accounts</div>
          <div className="v" style={{ color: "var(--bull)" }}>{latest.longPct.toFixed(1)}%</div>
        </div>
        <div className="dl-cell">
          <div className="k">Short accounts</div>
          <div className="v" style={{ color: "var(--bear)" }}>{latest.shortPct.toFixed(1)}%</div>
        </div>
      </div>
      {/* Sparkline */}
      <div style={{ display: "flex", gap: 1, height: 26, alignItems: "flex-end", marginTop: 10 }}>
        {data.series.map((p, i) => {
          const pctUp = Math.max(5, Math.min(100, (p.longPct / 100) * 100));
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ flex: (100 - pctUp), background: "rgba(239,83,80,.45)" }} />
              <div style={{ flex: pctUp, background: "rgba(38,166,154,.55)" }} />
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6, textAlign: "right" }}>
        Binance futures · 15m · updated {new Date(data.updatedAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

/* ── Hybrid Decision — fuses Orchestrator + NN + Conformal into a consensus */
function HybridDecisionCard({ orch, ta }) {
  if (!orch || !ta || ta.empty) return null;
  // Try to get NN output from the ensemble store (Phase 8), if available
  let nnProb = null;
  try {
    const Ens = window.__MNP__?.Ensemble;
    if (Ens?.getLastProbability) nnProb = Ens.getLastProbability();
  } catch {}
  // Try to get conformal interval (Phase 9), if calibrated
  let conf = null;
  try {
    const CStore = window.__MNP__?.ConformalStore;
    if (CStore?.getLastInterval) conf = CStore.getLastInterval();
  } catch {}
  const orchP = orch.probability ?? 0.5;
  const weights = [];
  let sum = 0, total = 0;
  weights.push({ name: "Ensemble", prob: orchP, weight: 0.5 });
  sum += orchP * 0.5; total += 0.5;
  if (Number.isFinite(nnProb)) { weights.push({ name: "NN", prob: nnProb, weight: 0.35 }); sum += nnProb * 0.35; total += 0.35; }
  if (Number.isFinite(conf?.prob)) { weights.push({ name: "Conformal", prob: conf.prob, weight: 0.15 }); sum += conf.prob * 0.15; total += 0.15; }
  const fusedP = total > 0 ? sum / total : orchP;
  const dir = fusedP >= 0.55 ? "long" : fusedP <= 0.45 ? "short" : "neutral";
  const tone = directionTone(dir);
  return (
    <div className="card">
      <h3>Hybrid Decision
        <span className={"badge " + tone}>{dir.toUpperCase()}</span>
      </h3>
      <Bar label="Fused P(up)" value={fusedP} max={1} tone={tone} valueFmt={fmtPct} />
      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, fontSize: 11 }}>
        {weights.map(w => (
          <div key={w.name} className="dl-cell" style={{ padding: 6 }}>
            <div className="k">{w.name} · {(w.weight * 100).toFixed(0)}%</div>
            <div className="v" style={{ fontSize: 13, color: w.prob > 0.5 ? "var(--bull)" : "var(--bear)" }}>
              {fmtPct(w.prob)}
            </div>
          </div>
        ))}
      </div>
      {!Number.isFinite(nnProb) && (
        <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6 }}>NN not calibrated yet · using ensemble-only fusion.</div>
      )}
    </div>
  );
}

/* ── Next Candle Prediction — one-bar-ahead direction / magnitude estimate */
function NextCandleCard({ orch, expected, ta }) {
  if (!orch || !expected || !ta || ta.empty) return null;
  const last = expected.last;
  const atr  = expected.atr;
  // Scaled one-bar estimate — ensemble bias × 0.6 ATR as the 1-bar expected magnitude
  const mag = Math.abs(orch.rawScore || 0) * atr * 0.6;
  const predOpen  = last;
  const predClose = expected.direction > 0 ? last + mag : last - mag;
  const predHi    = predClose + atr * 0.35;
  const predLo    = predClose - atr * 0.35;
  const tone = directionTone(expected.direction > 0 ? "long" : "short");
  return (
    <div className="card">
      <h3>Next Candle
        <span className={"badge " + tone}>{expected.direction > 0 ? "BULL" : "BEAR"}</span>
      </h3>
      <div className="dl-grid">
        <div className="dl-cell"><div className="k">Open</div><div className="v">{fmt(predOpen)}</div></div>
        <div className="dl-cell"><div className="k">Close</div><div className="v" style={{ color: tone === "bull" ? "var(--bull)" : "var(--bear)" }}>{fmt(predClose)}</div></div>
        <div className="dl-cell"><div className="k">High</div><div className="v" style={{ color: "var(--bull)" }}>{fmt(predHi)}</div></div>
        <div className="dl-cell"><div className="k">Low</div><div className="v" style={{ color: "var(--bear)" }}>{fmt(predLo)}</div></div>
      </div>
      <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 6, textAlign: "right" }}>
        {fmtSigned(((predClose - last) / last) * 100, 3)}% · mag {fmt(mag)} (0.6·ATR)
      </div>
    </div>
  );
}

/* ── HTF Bias Grid — runs TA/Orchestrator against higher timeframes */
function HTFBiasGridCard({ symbol }) {
  const [grid, setGrid] = useState([]);
  const HTFS = ["15m", "1h", "4h", "1d"];
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mnp = window.__MNP__;
      if (!mnp) return;
      const out = [];
      for (const tf of HTFS) {
        try {
          const candles = await mnp.getStored({ symbol, tf, limit: 200 });
          if (!Array.isArray(candles) || candles.length < 50) { out.push({ tf, status: "no-data" }); continue; }
          const ta = mnp.TAEngine.compute(candles);
          const o  = mnp.Orchestrator.runModules(ta, {});
          out.push({ tf, status: "ok", bias: o.rawScore, prob: o.probability, dir: o.direction, trend: ta.trend });
        } catch (e) { out.push({ tf, status: "err", err: e?.message || String(e) }); }
      }
      if (!cancelled) setGrid(out);
    })();
    return () => { cancelled = true; };
  }, [symbol]);
  return (
    <div className="card">
      <h3>HTF Bias Grid <span className="badge">{symbol}</span></h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {grid.length ? grid.map((r, i) => {
          const tone = directionTone(r.dir);
          return (
            <div key={i} style={{ padding: "8px 6px", background: "var(--bg)", borderRadius: 4, textAlign: "center", border: `1px solid ${tone === "bull" ? "rgba(38,166,154,.35)" : tone === "bear" ? "rgba(239,83,80,.35)" : "var(--border)"}` }}>
              <div style={{ fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: 1 }}>{r.tf}</div>
              {r.status === "ok" ? (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700, color: tone === "bull" ? "var(--bull)" : tone === "bear" ? "var(--bear)" : "var(--fg-dim)" }}>
                    {(r.dir || "—").toUpperCase()}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>
                    {fmtSigned(r.bias, 2)}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 10, color: "var(--fg-dim)" }}>{r.status}</div>
              )}
            </div>
          );
        }) : HTFS.map(tf => (
          <div key={tf} className="shimmer" style={{ height: 50 }} />
        ))}
      </div>
    </div>
  );
}

/* ── Summary Table — 13 key metrics at a glance */
function SummaryTableCard({ ta, orch, expected, candles }) {
  if (!ta || ta.empty) return null;
  const last = ta.close?.[ta.close.length - 1];
  const rsi  = Array.isArray(ta.rsi14) ? ta.rsi14[ta.rsi14.length - 1] : ta.rsi14;
  const atr  = Array.isArray(ta.atr14) ? ta.atr14[ta.atr14.length - 1] : ta.atr14;
  const adx  = ta.adx14?.adx?.[ta.adx14.adx.length - 1];
  const cci  = Array.isArray(ta.cci20) ? ta.cci20[ta.cci20.length - 1] : null;
  const mfi  = Array.isArray(ta.mfi14) ? ta.mfi14[ta.mfi14.length - 1] : null;
  const wr   = Array.isArray(ta.wr14)  ? ta.wr14[ta.wr14.length - 1]  : null;
  const vwap = Array.isArray(ta.vwap)  ? ta.vwap[ta.vwap.length - 1] : ta.vwap;
  const pdhpdl = derivePDHPDL(candles);
  const bb = ta.bb_20_2 || ta.bb;
  const bbUp = bb?.up?.[bb.up.length - 1];
  const bbLo = bb?.lo?.[bb.lo.length - 1];
  const cp = ta.chartPatterns?.last;
  const cpLabel = cp ? `${cp.name} · ${cp.bias.slice(0,4)}${cp.broken ? " ✓" : ""}` : "—";
  const cpTone  = cp ? (cp.bias === "bullish" ? "bull" : cp.bias === "bearish" ? "bear" : null) : null;
  const rows = [
    ["Price",     fmt(last)],
    ["Trend",     ta.trend],
    ["Regime",    ta.regime?.label || "—"],
    ["RSI 14",    Number.isFinite(rsi) ? rsi.toFixed(1) : "—", rsi > 70 ? "bear" : rsi < 30 ? "bull" : null],
    ["ATR 14",    fmt(atr)],
    ["ADX 14",    Number.isFinite(adx) ? adx.toFixed(1) : "—", adx > 25 ? "bull" : null],
    ["CCI 20",    Number.isFinite(cci) ? cci.toFixed(1) : "—", cci > 100 ? "bear" : cci < -100 ? "bull" : null],
    ["MFI 14",    Number.isFinite(mfi) ? mfi.toFixed(1) : "—", mfi > 80 ? "bear" : mfi < 20 ? "bull" : null],
    ["W %R 14",   Number.isFinite(wr) ? wr.toFixed(1) : "—"],
    ["VWAP",      fmt(vwap)],
    ["BB Upper",  fmt(bbUp)],
    ["BB Lower",  fmt(bbLo)],
    ["PDH / PDL", pdhpdl ? `${fmt(pdhpdl.pdh)} / ${fmt(pdhpdl.pdl)}` : "—"],
    ["Chart Pattern", cpLabel, cpTone],
  ];
  return (
    <div className="card">
      <h3>Summary Table <span className="badge">{rows.length}</span></h3>
      <table className="summary-table">
        <tbody>
          {rows.map(([k, v, tone], i) => (
            <tr key={i}>
              <td style={{ color: "var(--fg-dim)", fontSize: 11 }}>{k}</td>
              <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 11,
                color: tone === "bull" ? "var(--bull)" : tone === "bear" ? "var(--bear)" : "var(--fg)" }}>
                {v ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Feature Explorer (U5, M3 closeout) ──
   Live feature vector for the latest bar with a raw / z-scored toggle.
   Pulls features.js + normalize.js via the window.__MNP__ surface so
   we don't need an `import` at the JSX top-level (Babel-standalone +
   blob URL).  Buckets columns by category for at-a-glance scanning;
   highlights extreme z-scores (|z|>2). */
const FEATURE_GROUPS = [
  ["Returns / candle",    ["ret_1","ret_5","ret_20","log_range","body_frac","upper_wick_frac","lower_wick_frac"]],
  ["Moving averages",     ["d_ema20","d_ema50","d_ema200","ema20_slope"]],
  ["Oscillators",         ["rsi14","macd_hist_rel","stoch_k","stoch_d"]],
  ["Bands / volatility",  ["bb_pos","bb_width_rel","atr_rel","adx14","plusDI_minusDI"]],
  ["Volume",              ["vol_rel","obv_slope","cmf20","roc10"]],
  ["Structure (SMC)",     ["trend_up","trend_dn","break_recent","fvg_open_rel","ob_open_rel","zone_premium","zone_discount"]],
  ["Sessions",            ["sess_asia","sess_london","sess_ny_am","sess_ny_pm"]],
  ["Meta",                ["time_of_day","day_of_week"]],
];

function FeatureDrawer({ ta }) {
  const [mode, setMode] = useState("raw");        // "raw" | "z"
  const [open, setOpen] = useState(true);

  const fb = window.__MNP__?.Features;
  const norm = window.__MNP__?.Normalize;

  const data = useMemo(() => {
    if (!fb || !ta || ta.empty) return null;
    let fm;
    try { fm = fb.buildFeatureMatrix(ta, { warmup: 50 }); }
    catch { return null; }
    if (!fm || fm.n === 0) return null;
    // Last valid row — fall back to last row if all flagged invalid.
    let idx = fm.n - 1;
    while (idx >= 0 && !fm.valid[idx]) idx--;
    if (idx < 0) idx = fm.n - 1;
    const raw = fb.rowAt(fm, idx);

    let stats = null, z = null;
    if (norm) {
      try { stats = norm.fitZScore(fm.matrix, fm.d, null, fm.valid); }
      catch { stats = null; }
      if (stats) {
        z = raw.map((v, k) => (v - stats.mean[k]) / (stats.std[k] || 1));
      }
    }
    const byName = Object.create(null);
    for (let k = 0; k < fm.names.length; k++) {
      byName[fm.names[k]] = { raw: raw[k], z: z ? z[k] : null };
    }
    return { byName, idx, n: fm.n, d: fm.d, t: fm.t[idx], hasZ: !!z };
  }, [ta, fb, norm]);

  if (!fb) {
    return (
      <div className="card">
        <h3>Feature Explorer <span className="badge">offline</span></h3>
        <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>
          ml/features.js not yet loaded.
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card">
        <h3>Feature Explorer <span className="badge">warmup</span></h3>
        <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>
          Need ≥ 50 bars of TA history for a valid feature row.
        </div>
      </div>
    );
  }

  // Choose what to display + how to colour.
  const show = mode === "z" && data.hasZ ? "z" : "raw";
  const valFor = (name) => {
    const cell = data.byName[name];
    if (!cell) return { txt: "—", tone: "" };
    const v = show === "z" ? cell.z : cell.raw;
    if (!Number.isFinite(v)) return { txt: "—", tone: "" };
    if (show === "z") {
      const a = Math.abs(v);
      const tone = a > 2 ? (v > 0 ? "bull" : "bear")
                 : a > 1 ? (v > 0 ? "soft-bull" : "soft-bear")
                 : "";
      return { txt: (v >= 0 ? "+" : "") + v.toFixed(2), tone };
    }
    // raw
    const txt = Math.abs(v) >= 1
      ? Number(v).toFixed(2)
      : v.toFixed(3);
    return { txt, tone: "" };
  };

  const toneColor = (t) => (
    t === "bull"      ? "var(--bull)" :
    t === "bear"      ? "var(--bear)" :
    t === "soft-bull" ? "rgba(38,166,154,.7)" :
    t === "soft-bear" ? "rgba(239,83,80,.7)"  :
                        "var(--fg)"
  );

  return (
    <div className="card">
      <h3>
        Feature Explorer
        <span className="badge">{data.d}d · row {data.idx + 1}/{data.n}</span>
      </h3>

      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
        <button
          type="button"
          className={"chip-toggle " + (show === "raw" ? "on" : "")}
          style={{ fontSize: 10, padding: "3px 8px" }}
          onClick={() => setMode("raw")}>
          raw
        </button>
        <button
          type="button"
          className={"chip-toggle " + (show === "z" ? "on" : "") + (data.hasZ ? "" : " disabled")}
          style={{ fontSize: 10, padding: "3px 8px", opacity: data.hasZ ? 1 : 0.4, cursor: data.hasZ ? "pointer" : "not-allowed" }}
          onClick={() => data.hasZ && setMode("z")}
          aria-disabled={!data.hasZ}
          title={data.hasZ ? "z-score normalised against this matrix" : "need more history for z-score"}>
          z-score
        </button>
        <button
          type="button"
          className="chip-toggle"
          style={{ fontSize: 10, padding: "3px 8px", marginLeft: "auto" }}
          onClick={() => setOpen((o) => !o)}>
          {open ? "collapse" : "expand"}
        </button>
      </div>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {FEATURE_GROUPS.map(([label, names]) => (
            <div key={label}>
              <div style={{ fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>
                {label}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 2, columnGap: 8 }}>
                {names.filter((n) => data.byName[n] != null).map((n) => {
                  const { txt, tone } = valFor(n);
                  return (
                    <React.Fragment key={n}>
                      <div style={{ fontSize: 11, color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>{n}</div>
                      <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: toneColor(tone), textAlign: "right" }}>
                        {txt}
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          ))}
          {show === "z" && (
            <div style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 4 }}>
              z-score · |z|&gt;1 highlighted, |z|&gt;2 saturated · stats fitted on {data.n} rows
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SignalSidebar({ orch, expected, ghost, ta, candles, regime, symbol, ghostNBars, setGhostNBars, stability, adaptive, adaptiveTick }) {
  return (
    <aside className="sidebar" aria-label="signal-sidebar">
      <TradeSignalCard orch={orch} expected={expected} regime={regime} ta={ta} />
      <HybridDecisionCard orch={orch} ta={ta} />
      <GhostCandleCard ghost={ghost} ta={ta} nBars={ghostNBars} setNBars={setGhostNBars} />
      <TradeSetupCard orch={orch} expected={expected} ta={ta} />
      <NextCandleCard orch={orch} expected={expected} ta={ta} />
      <MasterBiasCard orch={orch} />
      <StabilityCard stability={stability} />
      <AdaptiveWeightsCard adaptive={adaptive} tick={adaptiveTick} orch={orch} />
      <MistakeLedgerCard symbol={symbol} tf={tf} />
      <AntiPatternCard />
      <DLSupervisorCard orch={orch} expected={expected} ta={ta} />
      {symbol && <LongShortRatioCard symbol={symbol} />}
      {symbol && <HTFBiasGridCard symbol={symbol} />}
      {symbol && <DerivCard symbol={symbol} />}
      {symbol && <IntermarketCard symbol={symbol} candles={candles} />}
      <ContextCard ta={ta} candles={candles} />
      <WyckoffCard ta={ta} />
      <PatternCard ta={ta} />
      <ChartPatternCard ta={ta} />
      <KeyLevelsCard ta={ta} />
      <VolumeProfileCard ta={ta} />
      <LiquidationHeatmapCard ta={ta} />
      <SummaryTableCard ta={ta} orch={orch} expected={expected} candles={candles} />
      <ModuleBreakdownCard orch={orch} />
      <FeatureDrawer ta={ta} />
    </aside>
  );
}

/* ── Ghost candles (Phase 11) — forward-projected OHLC path with ±conformal band */
const GHOST_NBAR_OPTIONS = [5, 10, 25, 50];

function GhostCandleCard({ ghost, ta, nBars, setNBars }) {
  // Even when no forecast (cold start), still render the horizon picker so
  // the user can configure horizon before data flows.
  const gc = window.__MNP__?.GhostCandles;
  const summary = ghost && Array.isArray(ghost.bars) && ghost.bars.length
    ? gc?.summarizeForecast?.(ghost)
    : null;
  if (!summary && (nBars == null || setNBars == null)) return null;
  const horizonPicker = (typeof setNBars === "function" && Number.isFinite(nBars)) ? (
    <div style={{ display: "flex", gap: 4, marginTop: 8, fontSize: 10 }}>
      <span style={{ color: "var(--fg-dim)", alignSelf: "center", marginRight: 4, textTransform: "uppercase", letterSpacing: 1 }}>Horizon</span>
      {GHOST_NBAR_OPTIONS.map((n) => (
        <button
          key={n}
          type="button"
          className={"chip-toggle " + (nBars === n ? "on" : "")}
          style={{ fontSize: 10, padding: "3px 8px" }}
          onClick={() => setNBars(n)}
          aria-pressed={nBars === n}>
          {n}
        </button>
      ))}
    </div>
  ) : null;
  if (!summary) {
    return (
      <div className="card card-glass">
        <h3>Ghost Candles <span className="badge">warmup</span></h3>
        <div style={{ color: "var(--fg-dim)", fontSize: 12 }}>Awaiting orchestration + ATR.</div>
        {horizonPicker}
      </div>
    );
  }
  const dirTone = summary.direction > 0 ? "bull" : summary.direction < 0 ? "bear" : "flat";
  const dirLabel = summary.direction > 0 ? "LONG" : summary.direction < 0 ? "SHORT" : "FLAT";
  const badgeClass = "badge " + (dirTone === "bull" ? "bull" : dirTone === "bear" ? "bear" : "");
  const movePct = summary.expectedMovePct * 100;
  // Build a sparkline of projected closes + ribbon for quick visual read.
  const W = 180, H = 40;
  const steps = ghost.bars.length;
  const allHi = [ghost.anchorClose, ...ghost.bars.map(b => b.hi)];
  const allLo = [ghost.anchorClose, ...ghost.bars.map(b => b.lo)];
  const minV = Math.min(...allLo);
  const maxV = Math.max(...allHi);
  const range = Math.max(1e-9, maxV - minV);
  const scaleY = (v) => {
    const y = H - ((v - minV) / range) * H;
    return Math.max(0, Math.min(H, y));
  };
  const xAt = (i) => (i / steps) * W;               // i=0 anchor, i=steps last bar
  const pathPts = [
    `${xAt(0).toFixed(1)},${scaleY(ghost.anchorClose).toFixed(1)}`,
    ...ghost.bars.map((b, i) => `${xAt(i + 1).toFixed(1)},${scaleY(b.c).toFixed(1)}`),
  ].join(" ");
  const upperPts = [
    `${xAt(0).toFixed(1)},${scaleY(ghost.anchorClose).toFixed(1)}`,
    ...ghost.bars.map((b, i) => `${xAt(i + 1).toFixed(1)},${scaleY(b.hi).toFixed(1)}`),
  ];
  const lowerPts = ghost.bars.slice().reverse().map((b, idx) => {
    const i = ghost.bars.length - idx - 1;
    return `${xAt(i + 1).toFixed(1)},${scaleY(b.lo).toFixed(1)}`;
  }).concat([`${xAt(0).toFixed(1)},${scaleY(ghost.anchorClose).toFixed(1)}`]);
  const ribbon = upperPts.concat(lowerPts).join(" ");
  const lineColor = summary.direction > 0 ? "#26a69a" : summary.direction < 0 ? "#ef5350" : "#9aa0ab";
  const ribbonFill = summary.direction > 0 ? "rgba(38,166,154,.15)" : summary.direction < 0 ? "rgba(239,83,80,.15)" : "rgba(179,136,255,.12)";
  return (
    <div className="card card-glass">
      <h3>Ghost Candles <span className={badgeClass}>{dirLabel}</span></h3>
      <svg width={W} height={H} aria-hidden="true" style={{ display: "block", margin: "4px 0 8px" }}>
        <polygon points={ribbon} fill={ribbonFill} stroke="none" />
        <polyline points={pathPts} fill="none" stroke={lineColor} strokeWidth="1.5" />
      </svg>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div className="dl-cell">
          <div className="k">Horizon</div>
          <div className="v">{summary.horizon} bars</div>
        </div>
        <div className="dl-cell">
          <div className="k">Final close</div>
          <div className="v" style={{ color: summary.direction > 0 ? "var(--bull)" : summary.direction < 0 ? "var(--bear)" : undefined }}>
            {fmt(summary.finalClose)}
          </div>
        </div>
        <div className="dl-cell">
          <div className="k">Expected move</div>
          <div className="v" style={{ color: summary.expectedMove >= 0 ? "var(--bull)" : "var(--bear)" }}>
            {fmtSigned(summary.expectedMove)} ({fmtSigned(movePct, 2)}%)
          </div>
        </div>
        <div className="dl-cell">
          <div className="k">Band (final)</div>
          <div className="v">±{fmt((summary.finalHi - summary.finalLo) / 2)}</div>
        </div>
        <div className="dl-cell">
          <div className="k">Widens</div>
          <div className="v">{fmt(summary.widthFirst)} → {fmt(summary.widthLast)}</div>
        </div>
        <div className="dl-cell">
          <div className="k">Interval</div>
          <div className="v">{ghost.usedConformal ? `CP ${Math.round((1 - ghost.alpha) * 100)}%` : "ATR√h"}</div>
        </div>
      </div>
      {Number.isFinite(ghost.firstBarBoost) && Math.abs(ghost.firstBarBoost - 1) > 1e-6 && (
        <div style={{ marginTop: 8, padding: 6, background: "rgba(179,136,255,.08)", border: "1px solid rgba(179,136,255,.25)", borderRadius: 4, fontSize: 11 }}>
          {ghost.firstBarBoost > 1 ? "Pattern boost · " : "Pattern dampen · "}
          <b style={{ color: ghost.firstBarBoost > 1 ? "var(--bull)" : "var(--bear)" }}>
            ×{ghost.firstBarBoost.toFixed(2)}
          </b>
          {Number.isFinite(ghost.patternBias) && (
            <span style={{ color: "var(--fg-dim)", marginLeft: 6 }}>
              (bias {fmtSigned(ghost.patternBias, 2)})
            </span>
          )}
        </div>
      )}
      {ghost.metaVeto && (
        <div style={{ marginTop: 8, padding: 6, background: ghost.metaVeto.kind === "full" ? "rgba(239,83,80,.10)" : "rgba(255,176,32,.10)", border: "1px solid " + (ghost.metaVeto.kind === "full" ? "rgba(239,83,80,.35)" : "rgba(255,176,32,.35)"), borderRadius: 4, fontSize: 11 }}>
          🚫 <b style={{ color: ghost.metaVeto.kind === "full" ? "var(--bear)" : "var(--warn)" }}>
            {ghost.metaVeto.kind === "full" ? "VETOED" : "SOFTENED"}
          </b>
          <span style={{ color: "var(--fg-dim)", marginLeft: 6 }}>
            by anti-pattern {ghost.metaVeto.antiPattern?.label ? `· ${ghost.metaVeto.antiPattern.label}` : ""}
          </span>
        </div>
      )}
      {horizonPicker}
    </div>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  KPI strip (footer)                                              ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function KpiStrip({ bootstrapCount, gaps, orch, ta, validation, sysEvents }) {
  const candlePool = Array.isArray(ta?.t) ? ta.t.length : 0;
  const accuracy = validation?.accuracy;
  const drift    = validation?.lastDrift;
  const openCircuits = Object.entries(sysEvents?.circuits || {}).filter(([, v]) => v === "open").map(([k]) => k);
  const failingHealth = Object.entries(sysEvents?.health || {}).filter(([, v]) => v === false).map(([k]) => k);
  const degradeFlags = sysEvents?.degradeFlags || [];
  const quotaPct = sysEvents?.quota?.freePct;
  return (
    <footer className="kpi-strip" role="contentinfo">
      <span className="kpi"><b>Pool</b> {candlePool} candles</span>
      <span className="kpi-divider" />
      <span className="kpi"><b>Bootstrap</b> {bootstrapCount}</span>
      <span className="kpi-divider" />
      <span className="kpi" style={{ color: gaps > 0 ? "var(--warn)" : undefined }}><b>Gaps</b> {gaps}</span>
      <span className="kpi-divider" />
      {accuracy ? (
        <span className="kpi">
          <b>Live Acc</b> <span className={accuracy.value >= 0.5 ? "trend-up" : "trend-down"}>
            {fmtPct(accuracy.value)}
          </span> <span style={{opacity:.6}}>(n={accuracy.n})</span>
        </span>
      ) : (
        <span className="kpi"><b>Live Acc</b> —</span>
      )}
      <span className="kpi-divider" />
      {orch && (
        <>
          <span className="kpi">
            <b>Bias</b> <span className={orch.rawScore >= 0 ? "trend-up" : "trend-down"}>
              {fmtSigned(orch.rawScore, 2)}
            </span>
          </span>
          <span className="kpi-divider" />
          <span className="kpi"><b>P(up)</b> {fmtPct(orch.probability)}</span>
          <span className="kpi-divider" />
        </>
      )}
      {drift ? (
        <span className="drift-banner" title={drift.cause}>
          ⚠ drift · {drift.cause}
        </span>
      ) : (
        <span className="kpi" style={{ color: "var(--bull)" }}>● no-drift</span>
      )}
      <span className="kpi-divider" />
      <span className="kpi" style={{ color: openCircuits.length ? "var(--bear)" : failingHealth.length ? "var(--warn)" : "var(--bull)" }}
            title={openCircuits.length ? "Open: " + openCircuits.join(", ") : failingHealth.length ? "Failing: " + failingHealth.join(", ") : "All systems nominal"}>
        ● health {openCircuits.length ? `${openCircuits.length}⚡` : failingHealth.length ? `${failingHealth.length}⚠` : "ok"}
      </span>
      {degradeFlags.length > 0 && (
        <>
          <span className="kpi-divider" />
          <span className="kpi" style={{ color: "var(--warn)" }} title={degradeFlags.join(", ")}>
            ⚡ {degradeFlags.length} degrade
          </span>
        </>
      )}
      {Number.isFinite(quotaPct) && (
        <>
          <span className="kpi-divider" />
          <span className="kpi" style={{ color: quotaPct < 0.1 ? "var(--bear)" : quotaPct < 0.2 ? "var(--warn)" : "var(--fg-dim)" }}>
            <b>Quota</b> {(quotaPct * 100).toFixed(1)}% free
          </span>
        </>
      )}
      <span className="spacer-flex" />
      <span className="kpi" style={{ color: "var(--fg-dim)" }}>
        For educational use only · not financial advice
      </span>
    </footer>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  News tab (M4a) — sentiment wall + filters                       ║
   ║  Pulls from window.__MNP__.NewsManager which auto-refreshes       ║
   ║  every 10 min.  Renders a category tab strip, an impact filter,  ║
   ║  optional symbol filter, and a list of items — each with         ║
   ║  sentiment chip, category chip, age, and sentiment-bar tinted    ║
   ║  on the side (green/red gradient).                               ║
   ╚══════════════════════════════════════════════════════════════════╝ */

const NEWS_TYPES = [
  ["all",        "All",        ""],
  ["FED",        "FED",        "warn"],
  ["WAR",        "War",        "bear"],
  ["CRYPTO REG", "Crypto Reg", "warn"],
  ["MACRO",      "Macro",      "accent"],
  ["EARNINGS",   "Earnings",   "accent"],
  ["CRYPTO MKT", "Crypto",     "bull"],
  ["STOCK MKT",  "Stocks",     "accent"],
  ["EU MKT",     "EU",         ""],
  ["GENERAL",    "Other",      ""],
];

function timeAgo(t) {
  if (!Number.isFinite(t)) return "";
  const d = Date.now() - t;
  if (d < 60_000) return "just now";
  if (d < 60 * 60_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 24 * 60 * 60_000) return `${Math.floor(d / (60 * 60_000))}h ago`;
  return `${Math.floor(d / (24 * 60 * 60_000))}d ago`;
}

function NewsPane({ symbol }) {
  const [type,        setType]        = useState("all");
  const [minImpact,   setMinImpact]   = useState(0);
  const [filterSymbol,setFilterSymbol]= useState("");
  const [items,       setItems]       = useState([]);
  const [refreshing,  setRefreshing]  = useState(false);
  const [err,         setErr]         = useState(null);

  // Subscribe to NewsManager updates.
  useEffect(() => {
    const NM = window.__MNP__?.NewsManager;
    if (!NM?.subscribe) return;
    const off = NM.subscribe((rows) => setItems(rows.slice(0, 200)));
    setItems(NM.list?.({ limit: 200 }) || []);
    return () => { try { off?.(); } catch {} };
  }, []);

  useEffect(() => {
    const bus = window.__MNP__?.EventBus;
    if (!bus?.on) return;
    const offErr = bus.on("news:error", (e) => setErr(e?.error || "fetch failed"));
    const offBatch = bus.on("news:batch", () => setErr(null));
    return () => { try { offErr?.(); offBatch?.(); } catch {} };
  }, []);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (type !== "all" && it.classification?.primary !== type) return false;
      if (minImpact > 0 && (it.classification?.impact || 0) < minImpact) return false;
      if (filterSymbol) {
        const s = filterSymbol.toUpperCase();
        if (!Array.isArray(it.symbols) || !it.symbols.includes(s)) return false;
      }
      return true;
    });
  }, [items, type, minImpact, filterSymbol]);

  const tally = useMemo(() => {
    const out = { all: items.length };
    for (const it of items) {
      const k = it.classification?.primary || "GENERAL";
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }, [items]);

  const refresh = async () => {
    const NM = window.__MNP__?.NewsManager;
    if (!NM?.refresh) return;
    setRefreshing(true);
    try { await NM.refresh({ force: true }); }
    catch (e) { setErr(e?.message || String(e)); }
    finally { setRefreshing(false); }
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--fg)" }}>News & Sentiment</h2>
          <div style={{ fontSize: 11, color: "var(--fg-dim)", marginTop: 4 }}>
            {items.length} items · auto-refresh 10m · sentiment + 8-cat taxonomy
            {err ? ` · err: ${err}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button
            type="button"
            className="chip-toggle"
            style={{ fontSize: 11, padding: "4px 10px", opacity: refreshing ? 0.5 : 1 }}
            disabled={refreshing}
            onClick={refresh}>
            {refreshing ? "fetching…" : "refresh now"}
          </button>
        </div>
      </div>

      {/* Category tabs */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {NEWS_TYPES.map(([k, label, tone]) => (
          <button
            key={k}
            type="button"
            className={"chip-toggle " + (type === k ? "on " + (tone || "") : "")}
            style={{ fontSize: 10, padding: "3px 8px" }}
            onClick={() => setType(k)}
            aria-pressed={type === k}>
            {label}
            <span style={{ marginLeft: 4, color: "var(--fg-dim)" }}>{tally[k] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* Impact + symbol row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ color: "var(--fg-dim)" }}>Min impact</span>
          {[0, 0.35, 0.65].map((v) => (
            <button
              key={v}
              type="button"
              className={"chip-toggle " + (minImpact === v ? "on warn" : "")}
              style={{ fontSize: 10, padding: "3px 8px" }}
              onClick={() => setMinImpact(v)}>
              {v === 0 ? "any" : v === 0.35 ? "med" : "high"}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ color: "var(--fg-dim)" }}>Symbol</span>
          <input
            type="search"
            placeholder="e.g. BTC"
            value={filterSymbol}
            onChange={(e) => setFilterSymbol(e.target.value)}
            style={{
              padding: "3px 8px", fontSize: 11, fontFamily: "inherit",
              background: "var(--bg)", color: "var(--fg)",
              border: "1px solid var(--border)", borderRadius: 3,
              width: 100,
            }}
          />
          <button type="button" className="chip-toggle" style={{ fontSize: 10, padding: "3px 8px" }}
                  onClick={() => setFilterSymbol(symbol?.replace(/USDT$/, "").replace(/:.*/, "") || "")}>
            track current
          </button>
        </div>
      </div>

      {/* List */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {filtered.length === 0 ? (
          <div style={{ color: "var(--fg-dim)", fontSize: 12, padding: 24, textAlign: "center" }}>
            {items.length === 0 ? "Loading first batch — RSS proxy can take a few seconds…" : "No matches for the current filter."}
          </div>
        ) : filtered.map((it) => {
          const sent = it.sentiment?.compound || 0;
          const sentColor = sent >  0.2 ? "var(--bull)"
                          : sent < -0.2 ? "var(--bear)"
                          : "var(--fg-dim)";
          const sentLabel = it.sentiment?.label || "neutral";
          const cat = it.classification?.primary || "GENERAL";
          const catTone = NEWS_TYPES.find(([k]) => k === cat)?.[2] || "";
          const impact = it.classification?.impact || 0;
          return (
            <a
              key={it.guid}
              href={it.link || "#"}
              target="_blank" rel="noopener noreferrer"
              style={{
                display: "grid",
                gridTemplateColumns: "4px 1fr auto",
                gap: 10,
                padding: 10,
                textDecoration: "none",
                color: "var(--fg)",
                background: "var(--bg-elev-1, #1a1e2a)",
                border: "1px solid var(--border, #2a2e39)",
                borderRadius: 4,
              }}>
              {/* sentiment bar (left edge) */}
              <span style={{
                background: sentColor,
                width: 4, borderRadius: 2,
                opacity: 0.5 + 0.5 * Math.min(1, Math.abs(sent)),
              }} />
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: "bold", fontSize: 13, lineHeight: 1.3 }}>{it.title}</span>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 10 }}>
                  <span className={"chip-toggle on " + catTone} style={{ fontSize: 9, padding: "1px 6px" }}>{cat}</span>
                  <span style={{ color: sentColor, fontWeight: "bold" }}>
                    {sentLabel.toUpperCase()} {sent >= 0 ? "+" : ""}{sent.toFixed(2)}
                  </span>
                  {it.classification?.highImpact && (
                    <span className="chip-toggle on warn" style={{ fontSize: 9, padding: "1px 6px" }}>HIGH-IMPACT</span>
                  )}
                  <span style={{ color: "var(--fg-dim)" }}>· {it.source || "—"}</span>
                  <span style={{ color: "var(--fg-dim)" }}>· {timeAgo(it.pubDate)}</span>
                  {Array.isArray(it.symbols) && it.symbols.slice(0, 4).map((s) => (
                    <span key={s} style={{ color: "var(--fg-dim)", fontFamily: "var(--font-mono)" }}>${s}</span>
                  ))}
                </div>
                {it.summary && (
                  <div style={{ fontSize: 11, color: "var(--fg-dim)", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {it.summary}
                  </div>
                )}
              </div>
              <div style={{ alignSelf: "center", fontSize: 9, color: "var(--fg-dim)", textAlign: "right", minWidth: 32 }}>
                {impact > 0 ? `${Math.round(impact * 100)}%` : ""}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Scanner tab                                                     ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function ScannerPane({ tf }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const scan = useCallback(async () => {
    setBusy(true); setErr(null); setRows([]);
    const mnp = window.__MNP__;
    if (!mnp) { setBusy(false); setErr("runtime not ready"); return; }
    const out = [];
    try {
      for (const sym of SYMBOLS) {
        try {
          const candles = await mnp.getStored({ symbol: sym, tf, limit: 300 });
          if (!Array.isArray(candles) || candles.length < 50) {
            out.push({ symbol: sym, status: "no-data", candles: candles?.length || 0 });
            continue;
          }
          const ta = mnp.TAEngine.compute(candles);
          const orch = mnp.Orchestrator.runModules(ta, {});
          const last = ta.close?.[ta.close.length - 1];
          const atr  = Array.isArray(ta.atr14) ? ta.atr14[ta.atr14.length - 1] : ta.atr14;
          out.push({
            symbol: sym,
            status: "ok",
            last, atr, trend: ta.trend,
            direction: orch.direction,
            bias: orch.rawScore,
            prob: orch.probability,
            conf: orch.confidence,
            candles: candles.length,
          });
        } catch (e) {
          out.push({ symbol: sym, status: "err", err: e?.message || String(e) });
        }
        // micro-yield
        await new Promise(r => setTimeout(r, 5));
      }
      setRows(out.sort((a, b) => Math.abs(b.bias || 0) - Math.abs(a.bias || 0)));
    } catch (e) {
      setErr(e?.message || String(e));
    } finally { setBusy(false); }
  }, [tf]);

  // initial scan + rescan on tf change
  useEffect(() => { scan(); }, [scan]);

  return (
    <section className="card" style={{ overflow: "auto", height: "100%" }}>
      <h3>Scanner <span className="badge">{SYMBOLS.length} symbols · {tf}</span></h3>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button className="btn-primary" onClick={scan} disabled={busy}>{busy ? "scanning…" : "Rescan"}</button>
        {err && <span style={{ color: "var(--bear)", fontSize: 12 }}>{err}</span>}
      </div>
      <table className="scan-table">
        <thead>
          <tr>
            <th>Symbol</th><th>Last</th><th>Trend</th><th>Direction</th>
            <th>Bias</th><th>P(up)</th><th>Conf</th><th>ATR</th><th>Candles</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const tone = directionTone(r.direction);
            return (
              <tr key={r.symbol}>
                <td><b style={{ color: "var(--fg)" }}>{r.symbol}</b></td>
                <td>{fmt(r.last)}</td>
                <td className={r.trend === "up" ? "bull" : r.trend === "down" ? "bear" : "flat"}>{r.trend || "—"}</td>
                <td className={tone}>{(r.direction || "—").toUpperCase()}</td>
                <td className={r.bias >= 0 ? "bull" : "bear"}>{fmtSigned(r.bias, 2)}</td>
                <td>{Number.isFinite(r.prob) ? fmtPct(r.prob) : "—"}</td>
                <td>{Number.isFinite(r.conf) ? fmtPct(r.conf) : "—"}</td>
                <td>{fmt(r.atr)}</td>
                <td style={{ opacity: .7 }}>{r.candles ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  AI Chat stub tab                                                ║
   ╚══════════════════════════════════════════════════════════════════╝ */

/* ── M6.5 · AIChatPane — multi-tier LLM (Ollama → Web-LLM → fallback) ──
   The Router (window.__MNP__.LLMRouter) auto-picks the active tier:
     - ollama  : http://localhost:11434 (best, but needs install)
     - webllm  : in-browser WebGPU (zero-install, ~1.5 GB model dl)
   When neither is reachable, falls back to the deterministic analyst. */
function AIChatPane({ orch, expected, ta, symbol, tf, ghost, regime, wyckoff, macro, deriv, stability, news }) {
  const [msgs, setMsgs] = useState([
    { role: "ai", text: "Hi — I auto-pick the best local LLM tier:\n  • Ollama if running on :11434 (best quality)\n  • Web-LLM in-browser via WebGPU (zero install, ~1.5 GB model on first run)\n  • Deterministic analyst fallback otherwise.\nAsk anything." },
  ]);
  const [input, setInput] = useState("");
  const [tier, setTier]     = useState(null);
  const [tierStatus, setTierStatus] = useState({ ollama: false, webllm: false });
  const [models, setModels] = useState([]);
  const [model, setModel]   = useState(localStorage.getItem("mnp.llm.model") || "");
  const [busy, setBusy]     = useState(false);
  const [dl, setDl]         = useState(null);   // { progress, text } for web-llm download
  const abortRef = useRef(null);

  // Probe both tiers on mount + every 30s.  Pick the active tier.
  useEffect(() => {
    const R = window.__MNP__?.LLMRouter;
    if (!R) return;
    let stopped = false;
    const probe = async () => {
      const { tier: picked, status } = await R.pickTier();
      if (stopped) return;
      setTierStatus(status);
      setTier(picked);
      if (picked === "ollama") {
        const list = await window.__MNP__.Ollama.listModels();
        if (stopped) return;
        setModels(list);
        if ((!model || !list.includes(model)) && list.length) {
          const ds = list.find((m) => /deepseek/i.test(m));
          const pick = ds || list[0];
          setModel(pick);
          try { localStorage.setItem("mnp.llm.model", pick); } catch {}
        }
      } else if (picked === "webllm") {
        const W = window.__MNP__.WebLLM;
        const list = (W?.MODELS || []).map((m) => m.id);
        setModels(list);
        if ((!model || !list.includes(model)) && list.length) {
          const def = (W.MODELS.find((m) => m.default) || W.MODELS[0]).id;
          setModel(def);
          try { localStorage.setItem("mnp.llm.model", def); } catch {}
        }
      } else {
        setModels([]);
      }
    };
    probe();
    const t = setInterval(probe, 30_000);
    return () => { stopped = true; clearInterval(t); };
  }, []);

  // Subscribe to Web-LLM download progress.
  useEffect(() => {
    const W = window.__MNP__?.WebLLM;
    if (!W?.onProgress) return;
    return W.onProgress((p) => setDl(p));
  }, []);

  const onModelChange = useCallback((m) => {
    setModel(m);
    try { localStorage.setItem("mnp.llm.model", m); } catch {}
  }, []);

  const onTierChange = useCallback((t) => {
    const R = window.__MNP__?.LLMRouter;
    R?.pinTier?.(t);
    setTier(t);
  }, []);

  const buildCtx = useCallback(() => ({
    symbol, tf,
    lastPrice: ta?.close?.[ta.close.length - 1],
    ta, orch, ghost,
    regime: regime || ta?.regime,
    wyckoff: wyckoff || ta?.wyckoff,
    macro,
    deriv,
    stability,
    news: Array.isArray(news) ? news.slice(0, 5) : null,
  }), [symbol, tf, ta, orch, ghost, regime, wyckoff, macro, deriv, stability, news]);

  // Deterministic fallback (used when Ollama is offline).
  const deterministic = useCallback((user) => {
    if (/why|explain|reason/i.test(user)) {
      if (!orch) return "The orchestration pipeline hasn't produced a signal yet — load more candles first.";
      const lines = [];
      lines.push(`On ${symbol} · ${tf}, the ensemble is leaning ${orch.direction?.toUpperCase()} with bias ${fmt(orch.rawScore, 2)} and P(up) ${fmtPct(orch.probability)}.`);
      if (expected) lines.push(`Expected move target: ${fmt(expected.point)} (band ±${fmt(expected.hi - expected.point)}).`);
      if (orch.signals) {
        const top = orch.signals.slice().sort((a, b) => Math.abs(b.signal * b.confidence) - Math.abs(a.signal * a.confidence)).slice(0, 3);
        lines.push("Top drivers:");
        for (const s of top) {
          const meta = MODULE_META[s.id || s.moduleId] || { label: s.moduleId || s.id || "?", emoji: "•" };
          lines.push(`  ${meta.emoji} ${meta.label}: ${fmtSigned(s.signal, 2)} @ ${fmtPct(s.confidence)} conf`);
        }
      }
      return lines.join("\n");
    }
    if (/target|price|move/i.test(user)) return expected ? `Target ${fmt(expected.point)} (band ${fmt(expected.lo)}–${fmt(expected.hi)})` : "No target available yet.";
    if (/risk|atr|volat/i.test(user)) return ta?.atr14?.length ? `ATR14: ${fmt(ta.atr14[ta.atr14.length - 1])}` : "ATR not available.";
    return "Ollama isn't reachable — local analyst answers: why · target · risk.";
  }, [orch, expected, symbol, tf, ta]);

  const send = useCallback(async () => {
    if (!input.trim() || busy) return;
    const user = input.trim();
    setInput("");
    setMsgs(m => [...m, { role: "you", text: user }]);

    const R   = window.__MNP__?.LLMRouter;
    const PB  = window.__MNP__?.LLMPrompt;
    if (!tier || !R || !PB) {
      setMsgs(m => [...m, { role: "ai", text: deterministic(user) }]);
      return;
    }
    setBusy(true);
    setMsgs(m => [...m, { role: "ai", text: "", streaming: true, tier }]);
    const ctl = new AbortController();
    abortRef.current = ctl;
    const ctx = buildCtx();
    const { system, prompt } = PB.buildPrompt({ ctx, question: user });
    let acc = "";
    try {
      // Route through the active tier.  Ollama uses /generate, Web-LLM
      // gets the same prompt funnelled through its chat endpoint.
      const fn = tier === "ollama" ? "generateVia" : "generateVia";
      await R[fn](tier,
        { model, prompt, system, signal: ctl.signal, options: { temperature: 0.4 } },
        {
          onToken: (tok) => {
            acc += tok;
            setMsgs((m) => {
              const arr = m.slice();
              const last = arr[arr.length - 1];
              if (last && last.role === "ai" && last.streaming) arr[arr.length - 1] = { ...last, text: acc };
              return arr;
            });
          },
          onError: (err) => {
            acc = `(LLM error: ${err?.message || err})\n\n` + deterministic(user);
            setMsgs((m) => {
              const arr = m.slice();
              arr[arr.length - 1] = { role: "ai", text: acc, streaming: false, tier };
              return arr;
            });
          },
        }
      );
    } catch { /* onError handled */ }
    setMsgs((m) => {
      const arr = m.slice();
      const last = arr[arr.length - 1];
      if (last && last.role === "ai" && last.streaming) arr[arr.length - 1] = { ...last, streaming: false };
      return arr;
    });
    setBusy(false);
    abortRef.current = null;
  }, [input, busy, tier, model, buildCtx, deterministic]);

  const stop = useCallback(() => {
    if (abortRef.current) { try { abortRef.current.abort(); } catch {} abortRef.current = null; }
  }, []);

  return (
    <div className="chat-shell" aria-label="ai-chat">
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border)", fontSize: 11, flexWrap: "wrap" }}>
        {/* Tier toggles */}
        <span style={{ color: "var(--fg-dim)" }}>Tier</span>
        <button type="button"
          className={"chip-toggle " + (tier === "ollama" ? "on bull" : "")}
          style={{ fontSize: 10, padding: "2px 8px", opacity: tierStatus.ollama ? 1 : 0.4 }}
          disabled={!tierStatus.ollama}
          onClick={() => tierStatus.ollama && onTierChange("ollama")}
          title={tierStatus.ollama ? "Local Ollama daemon" : "start `ollama serve` then `ollama pull deepseek-r1`"}>
          Ollama {tierStatus.ollama ? "●" : "○"}
        </button>
        <button type="button"
          className={"chip-toggle " + (tier === "webllm" ? "on accent" : "")}
          style={{ fontSize: 10, padding: "2px 8px", opacity: tierStatus.webllm ? 1 : 0.4 }}
          disabled={!tierStatus.webllm}
          onClick={() => tierStatus.webllm && onTierChange("webllm")}
          title={tierStatus.webllm ? "In-browser WebGPU LLM" : "WebGPU not available — try Chromium 113+"}>
          Web-LLM {tierStatus.webllm ? "●" : "○"}
        </button>

        {/* Model picker — labels differ per tier */}
        {tier && models.length > 0 && (
          <select
            value={model || ""}
            onChange={(e) => onModelChange(e.target.value)}
            style={{ fontSize: 11, padding: "2px 4px", background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 3, maxWidth: 200 }}>
            {models.map((m) => {
              // Friendly label for Web-LLM model ids
              const W = window.__MNP__?.WebLLM;
              const meta = tier === "webllm" && Array.isArray(W?.MODELS)
                ? W.MODELS.find((x) => x.id === m)
                : null;
              const label = meta ? `${meta.name} · ${(meta.sizeMB/1024).toFixed(1)} GB` : m;
              return <option key={m} value={m}>{label}</option>;
            })}
          </select>
        )}

        {!tier && (
          <span style={{ color: "var(--fg-dim)" }}>(no LLM tier available — using deterministic fallback)</span>
        )}

        {/* Web-LLM download progress */}
        {tier === "webllm" && dl && dl.progress > 0 && dl.progress < 1 && (
          <span style={{ color: "var(--fg-dim)", display: "flex", alignItems: "center", gap: 4 }}>
            ⇣ {(dl.progress * 100).toFixed(0)}%
            <span style={{ display: "inline-block", width: 80, height: 4, background: "var(--bg)", borderRadius: 2, overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${dl.progress*100}%`, background: "var(--accent)" }} />
            </span>
          </span>
        )}

        {busy && <button type="button" onClick={stop} className="chip-toggle" style={{ fontSize: 10, padding: "2px 6px", marginLeft: "auto" }}>stop</button>}
      </div>
      <div className="chat-log">
        {msgs.map((m, i) => (
          <div key={i} className={"chat-msg " + m.role} style={{ whiteSpace: "pre-wrap" }}>
            {m.text}{m.streaming ? <span style={{ color: "var(--fg-dim)" }}> ▌</span> : null}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <input
          type="text" placeholder={llmReady ? `Ask ${model || "the LLM"}…` : "Why is the model leaning this way?"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={busy}
        />
        <button className="btn-primary" onClick={send} disabled={busy || !input.trim()}>{busy ? "…" : "Send"}</button>
      </div>
    </div>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  System tab (capabilities + health)                              ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function SystemPane({ caps }) {
  const row = (k, v, good) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px dashed var(--border)" }}>
      <span style={{ color: "var(--fg-dim)", fontSize: 12 }}>{k}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12,
                     color: good === false ? "var(--bear)" : good === true ? "var(--bull)" : "var(--fg)" }}>
        {typeof v === "boolean" ? (v ? "✓" : "✗") : String(v ?? "—")}
      </span>
    </div>
  );
  if (!caps) return <div className="card">loading capabilities…</div>;
  return (
    <div className="card" style={{ overflow: "auto", height: "100%" }}>
      <h3>Runtime Capabilities <span className="badge">tier · {caps.tier || "?"}</span></h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "6px 20px" }}>
        {row("IndexedDB", caps.indexedDB, caps.indexedDB)}
        {row("OPFS", caps.opfs, caps.opfs)}
        {row("Web Workers", caps.workers, caps.workers)}
        {row("WASM / SIMD", `${caps.wasm ? "✓" : "✗"}/${caps.wasmSIMD ? "✓" : "✗"}`)}
        {row("WebGPU", caps.webgpu, caps.webgpu)}
        {row("WebSocket", caps.websocket, caps.websocket)}
        {row("BroadcastChannel", caps.broadcastCh, caps.broadcastCh)}
        {row("Web Locks", caps.webLocks, caps.webLocks)}
        {row("SharedArrayBuffer", caps.sab, caps.sab)}
        {row("WebCrypto", caps.webCrypto, caps.webCrypto)}
        {row("Service Worker", caps.serviceWorker, caps.serviceWorker)}
        {row("Private mode", caps.privateMode, !caps.privateMode)}
        {row("Cores / RAM", `${caps.hardwareCores} / ${caps.deviceMemGB ?? "?"} GB`)}
        {row("Timezone", caps.tz)}
      </div>
      {caps.quota && (
        <div style={{ marginTop: 14, padding: 10, background: "var(--bg)", borderRadius: 6, fontSize: 12 }}>
          <b>Storage</b>: {fmtMB(caps.quota.usage)} / {fmtMB(caps.quota.quota)} used
          {caps.quota.freePct != null && ` · ${(caps.quota.freePct * 100).toFixed(1)}% free`}
        </div>
      )}
    </div>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Toast stack (bus event notifier)                                ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={"toast tone-" + (t.tone || "accent")}>
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button className="toast-action" onClick={() => { t.action.fn?.(); onDismiss(t.id); }}>
              {t.action.label}
            </button>
          )}
          <button className="toast-dismiss" onClick={() => onDismiss(t.id)} aria-label="dismiss">×</button>
        </div>
      ))}
    </div>
  );
}

function useToasts(autoMs = 7000) {
  const [items, setItems] = useState([]);
  const nextId = useRef(1);
  const push = useCallback((t) => {
    const id = nextId.current++;
    setItems(prev => [...prev, { id, ...t }]);
    if (autoMs > 0) setTimeout(() => setItems(p => p.filter(x => x.id !== id)), autoMs);
  }, [autoMs]);
  const dismiss = useCallback((id) => setItems(p => p.filter(x => x.id !== id)), []);
  return { items, push, dismiss };
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Root App                                                        ║
   ╚══════════════════════════════════════════════════════════════════╝ */

function App() {
  const [caps, setCaps] = useState(null);
  const [ready, setReady] = useState(false);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [tf, setTf] = useState("1m");
  const [tab, setTab] = useState("chart");
  const [indicators, setIndicators] = useState({
    ema20: true, ema50: true, ema200: false, vwap: true, bbUp: false, bbLo: false,
    psar: false, ichiTenkan: false, ichiKijun: false, ichiCloudA: false, ichiCloudB: false, ichiChikou: false,
  });
  const [subplots, setSubplots] = useState({
    volume: true, rsi: true, macd: true, stoch: false,
    cci: false, wr: false, mfi: false, obv: false, cmf: false, adx: false,
  });
  const [structure, setStructure] = useState({
    bos: true, fvg: true, ob: true, liq: true, sr: true, pdh: true, pd: false, ghost: true,
    volProfile: false,
    trendlines: true,
    patterns: true,
  });
  const announce = useAnnouncer();
  const net  = useBus("net", { online: navigator.onLine });
  const skew = useBus("clockskew", null);
  const toasts = useToasts(7000);
  const sysEvents = useSystemEvents(toasts.push);

  // Boot wait-wire pattern (same as Phase 0)
  useEffect(() => {
    let pollId = null; let busOff = null;
    const tryWire = () => {
      const mnp = window.__MNP__;
      if (!mnp) return false;
      if (mnp.caps) {
        setCaps(mnp.caps); setReady(true);
        mnp.hideSplash?.();
      } else if (mnp.EventBus) {
        busOff = mnp.EventBus.once?.("boot:complete", ({ caps }) => {
          setCaps(caps); setReady(true);
          window.__MNP__?.hideSplash?.();
        });
      } else return false;
      return true;
    };
    if (!tryWire()) pollId = setInterval(() => { if (tryWire()) clearInterval(pollId); }, 50);
    return () => { if (pollId) clearInterval(pollId); if (typeof busOff === "function") busOff(); };
  }, []);

  useEffect(() => { if (ready) announce("My Next Prediction cockpit ready"); }, [ready, announce]);

  // ── Live data + engine pipeline
  const feed = useCandleSeries(symbol, tf, 500);
  const ta   = useTASnapshot(feed.candles);
  const orch = useOrchestration(ta);
  const expected = useExpectedMove(ta, orch);
  // Ghost anchors AFTER the currently-forming bar when one exists, so the
  // forecast does not overlap the real-time candle still being drawn.
  const ghostAnchorCandles = useMemo(() => {
    if (!feed.candles?.length) return feed.candles;
    if (!feed.forming || feed.forming.t <= feed.candles[feed.candles.length - 1].t) return feed.candles;
    return [...feed.candles, feed.forming];
  }, [feed.candles, feed.forming]);
  // Ghost horizon — user-selectable in the GhostCandleCard.
  const [ghostNBars, setGhostNBars] = useState(25);
  // Recent candlestick-pattern bias (last ≤ 3 bars).  Returns a number
  // in [-1, +1]; magnitude scales the first-bar pattern boost.
  const recentPatternBias = useMemo(() => derivePatternBias(ta), [ta]);
  const ghost = useGhostCandles(ta, orch, ghostAnchorCandles, {
    nBars: ghostNBars, alpha: 0.1, symbol, tf,
    patternBias: recentPatternBias,
  });
  useGhostResolver(symbol, tf, feed.candles);

  // ── M-LEARN plumbing · Submit a prediction once per closed bar so
  // ValidationMonitor produces verdicts that feed AdaptiveWeights,
  // MistakeLedger, and (next) anti-pattern discovery.  Without this
  // wire the entire closed-loop chain receives nothing.
  const monitorRef = useRef(null);
  const lastSubmittedBarRef = useRef(0);
  if (!monitorRef.current) {
    const M = window.__MNP__;
    if (M?.createDefaultMonitor && M?.EventBus && M?.getStored) {
      try {
        const candleLookup = async (sym, tff, t) => {
          const rows = await M.getStored({ symbol: sym, tf: tff, fromT: t, toT: t, limit: 1 });
          return rows && rows.length ? rows[0] : null;
        };
        monitorRef.current = M.createDefaultMonitor({ bus: M.EventBus, candleLookup });
        monitorRef.current.start();
      } catch (err) { console.warn("[ui] monitor init failed", err); }
    }
  }
  useEffect(() => {
    const mon = monitorRef.current;
    if (!mon || !orch || !ta?.close?.length) return;
    if (orch.direction === "neutral" || !Number.isFinite(orch.rawScore)) return;
    const lastBar = feed.candles?.[feed.candles.length - 1];
    if (!lastBar || lastBar.t === lastSubmittedBarRef.current) return;
    lastSubmittedBarRef.current = lastBar.t;
    const dir =
      orch.direction === "long"  ? "up"   :
      orch.direction === "short" ? "down" :
      "flat";
    const refPrice = ta.close[ta.close.length - 1];
    mon.submit({
      symbol, tf,
      kind: "direction",
      t: lastBar.t,
      payload: { dir, prob: orch.probability, refPrice, rawScore: orch.rawScore, direction: orch.direction },
      regime:  ta.regime?.label || null,
      version: window.__MNP__?.version || "unknown",
    }, { refCandle: lastBar }).catch(() => { /* swallow */ });
  }, [orch?.rawScore, orch?.direction, feed.candles?.length]);

  // Tick the monitor on every closed candle so it sweeps due predictions.
  useEffect(() => {
    const mon = monitorRef.current;
    if (!mon) return;
    const off = window.__MNP__?.EventBus?.on?.("candle:closed", () => {
      mon.tick({ symbol, tf }).catch(() => {});
    });
    return () => { try { off?.(); } catch {} };
  }, [symbol, tf]);

  // ── M5 · Stability history + adaptive weights
  // Append one snapshot per orchestration tick (capped at 200 bars).
  const [stabHistory, setStabHistory] = useState([]);
  useEffect(() => {
    const Stability = window.__MNP__?.Stability;
    if (!Stability?.appendHistory || !orch) return;
    setStabHistory((prev) => Stability.appendHistory(prev, {
      bias:      Number.isFinite(orch.rawScore) ? orch.rawScore : 0,
      direction: orch.direction || "neutral",
      cpWidth:   Number.isFinite(ghost?.bars?.[0]?.width) ? ghost.bars[0].width : null,
    }, 200));
  }, [orch?.rawScore, orch?.direction, ghost?.bars?.[0]?.width]);
  const stability = useMemo(() => {
    const S = window.__MNP__?.Stability;
    return S?.computeStability ? S.computeStability(stabHistory, { window: 30 }) : null;
  }, [stabHistory]);

  // Adaptive weights — singleton instance per (symbol, tf), updated
  // whenever a `validation:verdict` lands.
  const adaptiveRef = useRef(null);
  if (!adaptiveRef.current) {
    const A = window.__MNP__?.Adaptive;
    adaptiveRef.current = A ? new A.AdaptiveWeights({}) : null;
  }
  const [adaptiveTick, setAdaptiveTick] = useState(0);
  useBusEvent("validation:verdict", (e) => {
    const A = window.__MNP__?.Adaptive;
    if (!A?.recordVerdict || !adaptiveRef.current) return;
    A.recordVerdict(adaptiveRef.current, orch, e?.verdict || {});
    setAdaptiveTick((n) => n + 1);
  });

  // M-LEARN-1 — auto-record any miss into the Mistake Ledger with the
  // full feature snapshot at predict-time.  Pulls live ctx from the
  // current React render so the captured context matches what the
  // orchestrator actually saw.
  useBusEvent("validation:verdict", async (e) => {
    const ML = window.__MNP__?.MistakeLedger;
    if (!ML?.buildMistake) return;
    try {
      const m = ML.buildMistake({
        prediction: e?.prediction,
        verdict:    e?.verdict,
        ta, orch,
        regime:  ta?.regime?.label,
        wyckoff: ta?.wyckoff?.phase,
        macro:   null,
      });
      if (m) await ML.recordMistake(m);
    } catch { /* swallow */ }
  });

  // ── Validation signal (Phase 10)
  const [validation, setValidation] = useState({ accuracy: null, lastDrift: null });
  useBusEvent("validation:verdict", (e) => {
    // Derive a crude live accuracy by remembering last 200 direction hits.
    setValidation(prev => {
      if (e.verdict?.kind !== "direction" || e.verdict?.abstain) return prev;
      const hit = e.verdict.hit ? 1 : 0;
      const rolling = [...(prev._hits || []), hit].slice(-200);
      const acc = rolling.reduce((a, b) => a + b, 0) / rolling.length;
      return { ...prev, _hits: rolling, accuracy: { value: acc, n: rolling.length } };
    });
  });
  useBusEvent("drift:shift", (e) => {
    setValidation(prev => ({ ...prev, lastDrift: e }));
    announce(`drift detected: ${e.cause}`);
  });

  if (!ready || !caps) return <div style={{ display: "grid", placeItems: "center", width: "100%", height: "100%", color: "var(--fg-dim)" }}>warming up…</div>;

  return (
    <div className="app-shell">
      <TopBar
        tab={tab} setTab={setTab}
        symbol={symbol} setSymbol={setSymbol}
        tf={tf} setTf={setTf}
        net={net} skew={skew}
        status={feed.status} exchange={feed.exchange}
      />

      {tab === "chart" ? (
        <IndicatorRail
          indicators={indicators} setIndicators={setIndicators}
          structure={structure} setStructure={setStructure}
          subplots={subplots} setSubplots={setSubplots}
        />
      ) : (
        <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-elev-1)" }} />
      )}

      <main className="workspace" role="main">
        {tab === "chart" && (
          <>
            <ChartPane
              symbol={symbol} tf={tf}
              candles={feed.candles} forming={feed.forming}
              ta={ta}
              indicators={indicators} structure={structure}
              expected={expected} subplots={subplots}
              ghost={ghost}
            />
            <SignalSidebar orch={orch} expected={expected} ghost={ghost} ta={ta} candles={feed.candles} regime={ta?.regime?.label} symbol={symbol} ghostNBars={ghostNBars} setGhostNBars={setGhostNBars} stability={stability} adaptive={adaptiveRef.current} adaptiveTick={adaptiveTick} />
          </>
        )}
        {tab === "scanner" && (
          <div style={{ gridColumn: "1 / -1", overflow: "auto" }}>
            <ScannerPane tf={tf} />
          </div>
        )}
        {tab === "news" && (
          <div style={{ gridColumn: "1 / -1", overflow: "auto" }}>
            <NewsPane symbol={symbol} />
          </div>
        )}
        {tab === "chat" && (
          <>
            <AIChatPane orch={orch} expected={expected} ta={ta} symbol={symbol} tf={tf} ghost={ghost} stability={stability} />
            <SignalSidebar orch={orch} expected={expected} ghost={ghost} ta={ta} candles={feed.candles} regime={ta?.regime?.label} symbol={symbol} ghostNBars={ghostNBars} setGhostNBars={setGhostNBars} stability={stability} adaptive={adaptiveRef.current} adaptiveTick={adaptiveTick} />
          </>
        )}
        {tab === "system" && (
          <div style={{ gridColumn: "1 / -1", overflow: "auto" }}>
            <SystemPane caps={caps} />
          </div>
        )}
      </main>

      <KpiStrip
        bootstrapCount={feed.bootstrapCount}
        gaps={feed.gaps}
        orch={orch} ta={ta}
        validation={validation}
        sysEvents={sysEvents}
      />
      <ToastStack toasts={toasts.items} onDismiss={toasts.dismiss} />
    </div>
  );
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  Mount                                                           ║
   ╚══════════════════════════════════════════════════════════════════╝ */

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

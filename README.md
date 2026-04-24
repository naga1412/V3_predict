# My Next Prediction — v3.0

Client-side AI trading prediction platform. **No backend. No API keys. No telemetry.**

> **Status:** Phase 11 (Ghost Candles) — live.
> Engines 1–10 + v2-parity cockpit shipped. Phase 11 adds a conformal
> N-bar-ahead OHLC forecaster (`src/ml/ghostCandles.js`) rendered as a faded
> forward-projected candlestick series + confidence ribbon, plus a
> Ghost-Candle sidebar card with the projected path, expected move and
> widening ±band.

---

## 1 · Quick start

### Run locally (dev)
```bash
# From the repo root
cd v3
python -m http.server 3000
# open http://localhost:3000
```

> **Why a server?** ES modules + Service Worker require `http://` (not `file://`).
> Any static server works: `npx serve`, `python -m http.server`, `php -S 0.0.0.0:3000`, etc.

### Optional: DeepSeek-R1 (enabled in Phase 15)
```powershell
# Windows
winget install Ollama.Ollama
ollama pull deepseek-r1:8b
ollama serve
```

---

## 2 · Phase 11 — what's built

**Foundation (Phase 0)**
- ✅ `index.html` shell with CSP & SRI, Service Worker (cache-first + SWR)
- ✅ Capability detector (22+ probes), ResilienceLayer, EventBus
- ✅ Dark theme (TradingView palette), a11y-aware, reduced-motion, high-contrast

**Data + Engines (Phases 1–10)**
- ✅ Live feed (WS + REST backfill, validator, gap filler, leader election)
- ✅ IndexedDB schema with migrations, OPFS adapter, retention, backup
- ✅ TA engine (EMAs, RSI, MACD, BB, ATR, ADX, stoch, VWAP, OBV, CMF, …)
- ✅ SMC structure: pivots, BOS/CHoCH, FVG, Order Blocks, Liquidity, S/R, Premium/Discount, Sessions
- ✅ 13 analysis modules + ensemble orchestrator + calibration
- ✅ NN + per-regime ensemble (worker-trained) + conformal prediction intervals
- ✅ Auto-validation + drift monitor (PSI, KS, ADWIN, Page-Hinkley)

**Cockpit UI (Phase 10.5 foundation)**
- ✅ Premium top bar — tab nav (Chart / Scanner / AI Chat / System), symbol picker, TF pill group, live status pills (WS state, clock skew, network)
- ✅ Indicator + structure toggle rail (EMA 20/50/200, VWAP, Bollinger, BOS/FVG/OB/Liquidity/S&R/PDH-PDL/Ghost)
- ✅ Chart pane — `lightweight-charts@4.1.1` candles + indicator lines + BOS/OB/FVG/Sweep markers + S/R + PDH/PDL + ghost-candle predicted band
- ✅ Signal sidebar — Trade Signal dial, P(up), confidence, Master Bias needle, Module breakdown (all 13), Deep-Learning Supervisor, Market Context
- ✅ KPI footer — candle pool, bootstrap count, gap counter, live accuracy, current bias, drift banner
- ✅ Scanner tab — multi-symbol ensemble scan, sortable by |bias|
- ✅ AI Chat tab — deterministic local analyst (full LLM hook lands in Phase 15 with DeepSeek-R1)
- ✅ System tab — runtime capabilities + storage quota

**v2 parity (Phase 10.6 — new)**
- ✅ New indicators — Parabolic SAR (with trend-flip dots), Ichimoku Cloud (Tenkan/Kijun/Senkou A+B/Chikou), CCI 20, Williams %R 14, MFI 14 — all wired into `TAEngine`
- ✅ Oscillator subplot stack — Volume histogram, RSI 14 (with 30/70 guides), MACD (with histogram + signal), Stochastic %K/%D (with 20/80 guides), CCI, Williams %R, MFI, OBV, CMF, ADX+DI/−DI — each toggleable from the "Subplots" rail
- ✅ Trade Setup card — Entry / SL (1.25·ATR) / TP1 (1.0·ATR) / TP2 (2.0·ATR) / R:R, with abstain warning when |bias| < 0.15
- ✅ Pattern Detection card — scans `ta.patterns` and surfaces the last 8 candlestick patterns with bull/bear chips
- ✅ Key Levels card — Buy-Side (BSL) and Sell-Side (SSL) equal-high / equal-low liquidity with last sweep call-out
- ✅ Volume Profile card — 24-bucket horizontal histogram with split up/down volume, POC highlight, HVN / LVN labels
- ✅ Liquidation Heatmap card — approximation from equal-highs/lows + ATR 1x/2x/3x bands
- ✅ Long / Short Ratio card — Binance public futures API (`globalLongShortAccountRatio`, 15 m), refreshed every 60 s with sparkline
- ✅ Hybrid Decision card — weighted fusion of Orchestrator P(up) + NN (if calibrated) + Conformal (if available) → consensus direction
- ✅ Next Candle card — one-bar-ahead O/H/L/C estimate from ensemble bias × 0.6·ATR
- ✅ HTF Bias Grid — runs `TAEngine` + Orchestrator against 15 m / 1 h / 4 h / 1 d concurrently
- ✅ Summary Table — 13-row cockpit recap (Price, Trend, Regime, RSI, ATR, ADX, CCI, MFI, W%R, VWAP, BB Upper / Lower, PDH/PDL)

**Ghost Candles (Phase 11 — new)**
- ✅ `src/ml/ghostCandles.js` — pure, no-DOM module: `predictGhostCandles(ta, orch, { nBars, alpha, conformal, candles })` builds N forward bars with decaying drift (`|bias|·ATR·exp(-λi)`) and ±band that widens as √(i+1)
- ✅ Conformal integration — loads the latest saved `SplitConformalRegressor` from `ConformalStore`; falls back to the ATR·√h heuristic band when no calibration is available
- ✅ Chart rendering — secondary faded candlestick series (α≈0.35) projected forward in time + two dashed line series for the hi/lo ribbon; anchors after the forming bar so real-time candles are never occluded
- ✅ Ghost-Candle sidebar card — inline SVG sparkline of the projected path, shaded confidence ribbon, and a KV grid (horizon, final close, move, band, widening, interval source)

### Verify
Open the app. You should see:
1. Splash → cockpit mounts with live BTCUSDT · 1m chart (lightweight-charts), ~500 candles.
2. Right sidebar: "Trade Signal" card with LONG / SHORT / FLAT direction, Master Bias needle, 13 module bars.
3. Top-bar status pill turns green ("open") once WS connects. Clock-skew pill shows `Δt` after first probe.
4. KPI footer shows bias + P(up) updating as candles close. Switch symbol / TF — chart reloads cleanly.
5. Scanner tab produces a ranked table. AI Chat tab answers `why`, `target`, `risk` queries.
6. With the **Ghost** structure toggle on, 5 faded candles project forward past the newest bar with a widening dashed confidence ribbon; the sidebar "Ghost Candles" card shows the projected path, expected move %, and ±band.
7. DevTools → Application → Service Workers shows `sw.js` (version `mnp-v3-phase11.0-1`) registered.

---

## 3 · Directory

```
v3/
├── index.html            # App shell (CSP, CDN, module bootstrap)
├── sw.js                 # Service Worker (cache-first shell + SWR CDN)
├── public/
│   └── theme.css         # Dark theme, a11y, responsive
├── src/
│   ├── core/
│   │   ├── bootstrap.js  # Boot sequence
│   │   ├── capabilities.js # Feature detection
│   │   ├── resilience.js # Circuit breakers, retry, health
│   │   └── bus.js        # EventBus
│   ├── data/             # Phase 1  — WS/REST, IDB (next)
│   ├── ta/               # Phase 3  — TA indicators
│   ├── modules/          # Phase 5+ — 12 modules
│   ├── ml/               # Phase 7+ — NN, ensemble, conformal
│   ├── ui/               # React views
│   │   └── App.jsx       # Phase 0 dashboard
│   └── workers/          # SharedWorker + Web Workers
├── tests/                # Scenario fixtures & unit tests
└── docs/
```

---

## 4 · Roadmap

> The canonical plan lives in [`docs/PLAN.md`](./docs/PLAN.md). The summary
> below is a mirror — if they ever drift, PLAN.md wins.

v3 is delivered in **three parallel tracks**: Engine (E0–E22), UI (U0–U22)
and Platform (P0–P7). Phases in different tracks share a number when they
ship together; no more decimal patches ("10.5 / 10.6"). Work is cut into
**vertical-slice milestones** so the app stays coherent at every drop.

| Milestone | Phases (E + U)                 | User-visible story                                          | Status |
|-----------|--------------------------------|-------------------------------------------------------------|--------|
| M1 · Live cockpit    | E0–E4, U0–U4         | Live chart with TA + structure overlays                     | ✅ |
| M2 · Signal + ML     | E5–E10, U5–U10       | Bias, probability, uncertainty, drift banner                | ⚠ U5 missing · phase10 tests missing |
| M3 · Forecast        | E11–E12 + E23, U11–U12 + U23 | Forward-projected candles + real volume profile + trendlines + chart patterns | ⚠ E11 feedback loop missing · E12 partial · **E23 greenfield** |
| M3.5 · Multi-asset   | E24 + U24            | Stocks, ETFs, commodities, indices — not just crypto        | ❌ greenfield |
| M4 · Context         | E13, E18, E19 + paired U | News (with chart markers), Wyckoff, macro regime, OI/funding, intermarket | ❌ greenfield |
| M5 · Confidence      | E14, E16 + paired U  | Stability score + adaptive weights                          | ❌ |
| M6 · Reasoning       | E15 + U15            | DeepSeek-R1 streaming chat with reasoning trace             | ❌ |
| M7 · Evidence        | E17 + U17            | Walk-forward backtest with equity curve, heatmaps           | ❌ |
| M8 · Platform polish | E20–E22, U20–U22, P0–P7 | Multi-tab safe, fast on low-end, private by default      | ❌ |

### New phases added to restore v2 parity

- **E18 · Wyckoff + Macro regime** — Wyckoff phase detector
  (accumulation / distribution / markup / markdown), Risk-ON/OFF
  macro tagger.
- **E19 · Derivatives + Intermarket** — OI, funding, basis, L/S ratio
  (already live as a card) consolidated with RS-vs-BTC and a
  cross-asset correlation heatmap.
- **E23 · Trendlines + Chart Patterns (NEW)** — pivot-regression
  trendlines drawn on chart (upper + lower + channel) + 11 classical
  chart-pattern families ported from v2's `detect_advanced_patterns`
  (Triple Top/Bottom, H&S, Inverse H&S, Rising/Falling Wedge,
  Asc/Desc/Sym Triangle, Rounding Top/Bottom, Bump & Run). Adds two
  new orchestrator modules (14th + 15th). This is the direct answer
  to the trendline ask and closes v2 gap G5 in one coherent slice.
- **E24 · Multi-asset data sources (NEW)** — Stooq CSV + Yahoo v8
  via CORS proxy for stocks/ETFs/commodities/indices. Symbol registry
  with type metadata (crypto / stock / etf / commodity / index).
- **E25 · Scanner enhancements (NEW)** — filters (regime × TF ×
  min-confidence × aligned-only × with-pattern-only), saved watchlists
  in IDB, alerting engine with browser notifications. Was bundled into
  pre-rewrite "10.6 v2 parity" and never re-slotted — this fixes that.
- **U5 · Feature explorer** — inspectable feature vector drawer
  (surfaces Phase-5 features that were invisible to users).
- **U24 · Multi-asset picker** — 6-tab symbol search modal
  (All/Crypto/Stocks/ETFs/Commodities/Indices) with ~400 symbols.
- **U25 · Scanner UI** — filter bar + watchlist dropdown + alert bell
  with rule builder, on top of the existing Scanner tab.

### Deep v2 re-audit — 12 parity gaps discovered

A full re-read of `backend/{main,ta_logic}.py` and `frontend/index.html`
against the v3 codebase turned up 12 v2 surfaces not in the previous
plan, now tracked in `docs/PLAN.md` Part A ("Deep v2 re-audit").
Headliners:

- **G5 · Chart patterns** (11 families) — entire analysis dimension
  missing. Addressed by new E23/U23.
- **G9 · Multi-asset universe** — v3 is crypto-only; v2 had 72 crypto
  + 80+ stocks + ETFs + futures + indices. Addressed by new E24/U24.
- **G1 · Candle-typed next-candle narrative** — v3 shows OHLC;
  v2 names the candle (Engulfing / Marubozu / Hammer / …) with
  body+wick adjectives. Port into U11.
- **G7 · Macro Risk-ON / Risk-OFF pill** — always-visible top-bar
  pulse, missing from v3. Landing in U18.
- **G8 · News taxonomy** (8 categories + impact filter + HIGH-IMPACT
  chip) — v3 U13 must preserve v2's exact lexicon.

See `docs/PLAN.md` Part A for the full 12-row matrix with file
citations.

### Closing Phase 11 properly (next up)

Phase 11 shipped the engine + UI but is missing the companion pieces
every prior ML phase shipped: `ghostStore.js`, `ghost:*` events,
`ValidationMonitor` integration, and a `phase11-unit.html` test harness.
`PLAN.md` Part F lists the six concrete steps that formally close M3
before M4 begins — step 6 is the new trendlines + chart-patterns
delivery (E23/U23).

See [`docs/PLAN.md`](./docs/PLAN.md) for:
- Honest current-state truth map + deep v2 re-audit 12-gap matrix (Part A)
- Design principles (Part B)
- Full engine / UI / platform tables including new E23/U23 (trendlines +
  chart patterns) and E24/U24 (multi-asset) (Part C)
- Vertical-slice milestone schedule with M3.5 added (Part D)
- v2 parity closeout matrix with deep-audit gap rows (Part E)
- Immediate next-step checklist — now 6 steps, step 6 = E23/U23 (Part F)

---

## 5 · Dev tools

Once loaded, the following is exposed on `window.__MNP__`:

```js
__MNP__.caps       // frozen capability snapshot
__MNP__.EventBus   // pub/sub — try __MNP__.EventBus.on('net', console.log)
__MNP__.version    // "3.0.0-phase0"
```

Useful events: `boot:complete`, `net`, `visibility`, `quota`, `quota:low`, `health`, `circuit:open/close`, `degrade`, `restore`, `sw:update-available`.

---

## 6 · License & disclaimer

MIT. For educational use only. **Not financial advice.**

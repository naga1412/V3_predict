# My Next Prediction v3 — Master Plan (rewrite)

> This document replaces the decimal-patched roadmap ("10.5 / 10.6") that
> collapsed engine + UI into a single numbered sequence. The original v3
> plan was engine-only; UI was bolted on retrospectively. This rewrite
> restores the clean separation, captures every v2 feature that has to
> land in v3, and adds the analysis-heavy surfaces v3 is supposed to
> introduce beyond v2.

---

## Part A — Current-state truth map (as of Phase 11 ship)

Audited 2026-04-24 against the live codebase. "Partial" means some code
exists but the phase's promised deliverable is not complete.

| #   | Phase                        | Engine   | UI        | Events / Store / Tests |
|-----|------------------------------|----------|-----------|------------------------|
| 0   | Foundation                   | built    | built     | boot:*, net, health · no store · no phase0 tests |
| 1   | Data ingest                  | built    | built     | feed:* events · IDB candles · phase1 tests |
| 2   | Storage hardening            | built    | built     | quota:* · IDB+OPFS · phase2 tests |
| 3   | TA engine                    | built    | built     | ta per-tick · phase3 tests |
| 4   | Market structure             | built    | built     | structure in ta · phase4 tests |
| 5   | Labels + feature store       | built    | **none**  | internal · featureStore · phase5 tests |
| 6   | Regime + calendar            | built    | partial   | regime tag · phase6 tests |
| 7   | 13 modules + orchestrator    | built    | built     | orch per-tick · phase7/7b tests |
| 8   | NN + per-regime ensemble     | built    | built     | training events · modelStore · phase8 tests |
| 9   | Conformal intervals          | built    | built     | no events · conformalStore · phase9 tests |
| 10  | Auto-validation + drift      | built    | built     | validation:verdict · drift:shift · predictionStore · **no phase10 tests** |
| 11  | Ghost candles                | built    | built     | **no events · no store · no tests** |
| 12  | Volume profile enhanced      | partial  | partial   | 24-bucket only; no VAH/VAL, no TPO |
| 13  | News + sentiment             | missing  | missing   | — |
| 14  | Stability score              | missing  | missing   | — |
| 15  | DeepSeek-R1 (Ollama)         | missing  | partial   | AIChat deterministic placeholder |
| 16  | Adaptive hybrid              | missing  | missing   | — |
| 17  | Walk-forward backtest        | missing  | missing   | — |
| 18  | AI chat enhancements         | partial  | partial   | no retrieval, no replay |
| 19  | ~~Scanner enhancements~~ (renumbered → **E25/U25**) | partial  | partial   | Scanner tab exists (sort-only); filters/alerts/watchlists = E25/U25 |
| 20  | Multi-tab leader election    | built    | partial   | leader pill stuck at "unknown" |
| 21  | Performance hardening        | missing  | missing   | — |
| 22  | Security & compliance polish | missing  | missing   | — |

### Cross-cutting gaps flagged during audit

1. **Phase 11 is missing its feedback loop** — no `ghostStore.js`, no
   `ghost:*` events, no integration with `ValidationMonitor`. Every prior
   ML phase (8, 9, 10) shipped a store + events + tests.
2. **v2 has features v3 has no phase for** — Wyckoff phase detection,
   macro-sentiment (Risk-ON/OFF), OI/Funding/Intermarket analysis. v2
   had them; v3's current plan doesn't.
3. **Phase-5 feature store has no UI** — users can't inspect what
   features the ML pipeline sees. (v2 had a features-visible path.)
4. **Phase 10 has no unit test harness** — drift is our most complex
   math; it's the one module without a `phase10-unit.html`.
5. **Decimal phases (10.5 / 10.6)** bundled ~20 cards + 5 indicators
   under a single marker, making progress tracking opaque.

### Deep v2 re-audit (2026-04-24) — twelve additional gaps

After re-reading `backend/ta_logic.py`, `backend/main.py`, and
`frontend/index.html` end-to-end, the following v2 surfaces are NOT
covered by the existing v3 phases (pre-rewrite) and require explicit
slots in C1/C2 or burndown rows in E:

| # | v2 surface | Where (v2)                | v3 phase that must close it | State |
|---|------------|----------------------------|-----------------------------|-------|
| G1  | Candlestick-typed next-candle narrative (Engulfing/Marubozu/Hammer/…) | `_predict_next_candle` ta_logic.py:395 | U11 polish | missing — v3 shows OHLC only |
| G2  | Yellow "Predicted" anchor marker on first forward bar                  | index.html:385 | U11 chart overlay | missing |
| G3  | News markers on price chart (📰, sentiment-colored, snap ±2 bars)      | index.html:388 | U13 chart overlay | missing |
| G4  | Symbol search modal w/ 6 type tabs (crypto/stocks/ETFs/commodity/idx)  | index.html:918 | U1 + new E24 | missing in v3 (crypto-only) |
| G5  | Advanced chart-pattern detector (11 families from swing-slope geometry) | `detect_advanced_patterns` ta_logic.py:128 | **new E23 / U23** | missing entirely |
| G6  | Future-candle count input (0–200) in top bar                           | index.html:584 | U1 / U11 | missing |
| G7  | Macro Risk-ON / Risk-OFF pill always visible in top bar                | index.html:574 | U18 MacroRibbon | missing |
| G8  | News feed with 8-category taxonomy + impact filter + HIGH-IMPACT chip  | index.html:189 + main.py:277 | U13 NewsPane | missing |
| G9  | Multi-asset universe: 72 crypto + 80+ stocks + ETFs + futures + indices | main.py:71, 190 | **new E24** | crypto-only currently |
| G10 | MTF consistency call-out: "MIXED — 4h (Bearish), 1d (Bearish)"         | `generate_mtf_prediction` ta_logic.py:489 | U7 / U18 | partial — per-TF shown, no explicit conflict chip |
| G11 | Simple Wyckoff phase chip from bull_pct (Markup/Markdown/Accum/Dist)   | ta_logic.py:464 | U18 (pre-E18) | missing |
| G12 | Last-candle TYPE label (Doji/Hammer/Marubozu…) with body+wick adjectives | `detect_candle_type` ta_logic.py:260 | U7 ContextCard | partial — `ta.patterns` exists but not surfaced as KV |

**Sizing insight:** G5 (chart patterns) is the largest single gap — it's
a whole analysis dimension. G9 (multi-asset) is the largest engineering
effort — client-side can't call yfinance directly, needs CORS-friendly
proxy or cached static data. These two drive the addition of **E23
(Trendlines + Chart Patterns)** and **E24 (Multi-asset data sources)**
to the engine track.

---

## Part B — Design principles for the rewrite

1. **Two tracks, one ledger.** Engine (E) and UI (U) get their own
   numbered lanes. E-N and U-N are delivered together but measured
   independently. No decimals.
2. **Vertical-slice milestones.** Every 2–4 phases roll up into a
   visible cockpit milestone so the product is always coherent.
3. **Every engine phase has a matching UI phase.** No orphan engines
   (v3 can't keep features.js invisible), no orphan UI (no cards
   without backing data).
4. **Consistent phase shape.** Every engine phase ships:
   - Pure ES module(s) in the right subtree
   - `{ Name }Store.js` if state needs to survive a reload
   - Events on `EventBus` with a namespaced topic (`ghost:*`,
     `news:*`, `stability:*`, …)
   - `tests/phase{N}-unit.html` harness
5. **Consistent UI phase shape.** Every UI phase ships:
   - Presentational React component(s) in `src/ui/`
   - Subscription to the matching engine's events (not polling)
   - Empty / loading / error / abstain states
   - Accessibility: keyboard path, ARIA live region for state changes
6. **Platform lane for cross-cutting work.** Security, perf, testing,
   leader election, i18n scaffolding — these live in P-N lanes so
   they don't warp the E/U numbering.
7. **v2 feature parity is a checklist, not a phase.** Tracked in
   Part E; burned down as E/U phases land.
8. **Event-first coordination.** UI never calls engines directly; it
   subscribes to topics and renders. Engines never touch the DOM.

---

## Part C — The three tracks

### C1. Engine track (E0 – E22)

| #   | Name                      | Module path                           | Purpose                                               | Feeds |
|-----|---------------------------|---------------------------------------|-------------------------------------------------------|-------|
| E0  | Foundation                | src/core/*                            | caps probe, SW, EventBus, resilience                  | all   |
| E1  | Data ingest               | src/data/feedManager.js + adapters/*  | WS+REST, validator, gap filler, leader election       | E3+   |
| E2  | Storage hardening         | src/data/{idb,opfs,retention,…}.js    | schema, quota, OPFS, backup                           | all   |
| E3  | TA engine                 | src/ta/engine.js + indicators/*       | 22 indicators, pattern library                        | E4 E7 E11 |
| E4  | Market structure          | src/ta/structure/*                    | BOS/FVG/OB/liq/PD/sessions                            | E7    |
| E5  | Features + labels         | src/ml/{features,labels,…}.js         | triple-barrier, feature vectors                       | E8    |
| E6  | Regime + calendar         | src/regime/*                          | bull/bear/choppy, session + news calendar stubs       | E7 E8 |
| E7  | 13 modules + orchestrator | src/modules/*                         | weighted ensemble bias + per-module breakdown         | E11 E14 E16 |
| E8  | NN + per-regime ensemble  | src/ml/{nn,ensemble,trainer}.js       | worker-trained NN + regime-weighted fusion            | E16   |
| E9  | Conformal intervals       | src/ml/conformal.js                   | split-CP + APS + rolling                              | E11 E14 |
| E10 | Auto-validation + drift   | src/validation/*                      | verdicts + PSI/KS/ADWIN/Page-Hinkley                  | E8 E16 |
| E11 | Ghost candles             | src/ml/{ghostCandles,ghostStore}.js   | N-bar forward OHLC with ±conformal ribbon             | E14   |
| E12 | Volume profile enhanced   | src/ta/profile/{vp,tpo}.js            | VAH/VAL, session POC, time-of-day TPO                 | E7    |
| E13 | News + sentiment          | src/news/{rss,sentiment,macro}.js     | RSS fetch + Transformers.js DistilBERT + macro tag    | E7 E18 |
| E14 | Stability score           | src/ml/stability.js                   | bias σ, flip rate, CP width score                     | E16 UI |
| E15 | DeepSeek-R1 (Ollama)      | src/llm/{ollama,prompt,stream}.js     | local LLM, reasoning trace, JSON tool blocks          | E18   |
| E16 | Adaptive hybrid           | src/ml/adaptive.js                    | online weighting of modules + NN + LLM votes          | all   |
| E17 | Walk-forward backtest     | src/backtest/{runner,metrics,…}.js    | WF splits, equity curve, confusion matrix             | all   |
| E18 | Wyckoff + macro regime    | src/ta/wyckoff.js + src/regime/macro.js | Wyckoff phase (accum/dist/markup/markdown), Risk-ON/OFF | E7 |
| E19 | Derivatives + intermarket | src/derivs/*, src/intermarket/*       | OI, funding, basis, L/S ratio, RS-vs-BTC, corr matrix | E7 E16 |
| E20 | Multi-tab leader election | src/data/leaderElection.js (finish)   | leader arbitration, follower read-only                | E1    |
| E21 | Performance hardening     | src/perf/{hud,profiler,queue}.js      | frame-time, worker queue, IDB tx latency              | UI    |
| E22 | Security & compliance     | src/security/{csp,export,wipe}.js     | CSP report, audit bundle, forget-me                   | UI    |
| E23 | **Trendlines + chart patterns (NEW)** | src/ta/structure/trendlines.js + src/ta/patterns/chartPatterns.js + src/modules/trendline.js + src/modules/chartPatterns.js | pivot-regression trendlines + 11 chart-pattern families (Triple Top/Bottom, H&S, Inv-H&S, Rising/Falling Wedge, Asc/Desc/Sym Triangle, Rounding Top/Bottom, Bump & Run). Two new orchestrator modules (14th + 15th) | E4 E7 |
| E24 | **Multi-asset data sources (NEW)** | src/data/exchanges/{yfinance-proxy,stooq,cboe}.js + registry | add stocks/ETFs/commodities/indices; CORS-friendly sources (Stooq CSV, Yahoo v8 via public CORS proxy, static daily OHLCV for indices); symbol registry with type metadata | E1 U1 |
| E25 | **Scanner enhancements (NEW)** | src/scanner/{filters,watchlists,alerts}.js | saved watchlists (IDB), filters (regime × TF × min-confidence × only-aligned × only-with-pattern), alerting engine (browser notif + in-app toast on crossover events) | E1 E7 E10 |

**New vs. old plan:** E18 (Wyckoff + Macro), E19 (Derivatives + Intermarket), E23 (Trendlines + Chart Patterns), E24 (Multi-asset), and E25 (Scanner enhancements) are added to close v2 parity — the original engine-only plan had none of these. E23 is the direct answer to the "add trendline" ask and also closes v2's `detect_advanced_patterns` gap with one coherent phase. E25 was bundled into pre-rewrite "10.6 v2 parity" and never re-slotted — this fixes that.

### C2. UI track (U0 – U22)

Each U-phase consumes a single engine lane (or a well-defined group) and
produces visible surfaces. No UI phase ships ahead of its engine.

| #   | Name                        | Component(s)                              | Subscribes to            |
|-----|-----------------------------|-------------------------------------------|--------------------------|
| U0  | Shell + theme               | App shell, theme.css, splash, ErrorBoundary | boot:complete         |
| U1  | Top bar + status            | TopBar, symbol picker, TF group, status pills | net, feed:status, clockskew |
| U2  | System tab                  | SystemPane, storage card                  | quota:*, caps            |
| U3  | Chart + indicator rail      | ChartPane, IndicatorRail                  | ta per-tick              |
| U4  | Structure overlays          | markers, OB zones, liquidity lines, PD band | ta.structure           |
| U5  | **Feature explorer (NEW)**  | FeatureDrawer — inspectable feature vector | feature:snapshot        |
| U6  | Regime + calendar chip      | RegimeCard                                | ta.regime, regime:event  |
| U7  | Signal sidebar              | TradeSignalCard, MasterBiasCard, ModuleBreakdownCard | orch:* |
| U8  | DL Supervisor               | DLSupervisorCard                          | nn:prob, ensemble:prob   |
| U9  | Uncertainty + Hybrid        | HybridDecisionCard                        | conformal:interval       |
| U10 | Validation + drift          | KPI strip health pills, drift banner, toasts | validation:*, drift:* |
| U11 | **Ghost candles**           | Chart ghost series + GhostCandleCard      | ghost:forecast, ghost:resolved |
| U12 | Volume profile + TPO        | VolumeProfileCard (with VAH/VAL/mode switcher), TPO overlay | vp:* |
| U13 | **News tab**                | NewsPane (sentiment wall, impact filter, symbol filter), ticker strip in top bar | news:item, news:macro |
| U14 | **Stability card**          | StabilityCard (gauge + history sparkline) | stability:score |
| U15 | **AI chat (DeepSeek)**      | AIChatPane (streaming tokens, reasoning trace, JSON tool cards) | llm:token, llm:final |
| U16 | **Adaptive weights card**   | AdaptiveWeightsCard (stacked-bar per bar) | adaptive:weights |
| U17 | **Backtest tab**            | BacktestPane (equity curve, confusion matrix, regime × TF heatmap, trade list) | backtest:result |
| U18 | **Macro + Wyckoff ribbon**  | MacroRibbon in top bar + WyckoffChip in Market-Context | macro:state, wyckoff:phase |
| U19 | **Derivatives + Intermarket** | DerivCard (OI/funding/basis/L-S) + IntermarketCard (RS-vs-BTC, corr heatmap) | deriv:*, intermarket:* |
| U20 | Leader state                | LeaderPill (top bar), LeaderCard (System tab), follower banner | leader:status |
| U21 | **Perf HUD**                | PerfHud (frame time, worker queue, IDB tx) — toggled via ?debug=1 | perf:tick |
| U22 | **Settings tab**            | SettingsPane — CSP report, export bundle, forget-me | security:* |
| U23 | **Trendlines + Chart Pattern card (NEW)** | Chart overlay: upper + lower trendline (LineSeries) + channel fill + breakout marker + pattern polyline overlay (H&S neckline, wedge lines, triangle apex). ChartPatternCard in sidebar: name, bias, confidence, measured-move target, invalidation. Indicator rail toggle "Trendlines" + "Patterns" | trendline:*, pattern:chart:* |
| U24 | **Multi-asset picker (NEW)**| SymbolSearchModal — 6 type tabs (All/Crypto/Stocks/ETFs/Commodities/Indices), typed badges, type-ahead filter against full universe (~400 symbols) | symbols:loaded |
| U25 | **Scanner enhancements (NEW)** | Filter bar (regime / TF / min-confidence / aligned-only / with-pattern-only), saved-watchlist dropdown + CRUD, alert bell with rule builder, toast stream when alerts fire | scanner:filter, scanner:alert, watchlist:* |

**Bold** entries are not yet built at all or are stubs needing full work.

### Surface-location decisions (clarified 2026-04-24)

Where each of the following lives is ambiguous in the tables above; this
block pins the choice:

- **E12 / U12 Volume Profile** ships TWO surfaces:
  (a) `VolumeProfileCard` in sidebar (existing, with VAH/VAL upgrade)
  (b) **On-chart vertical histogram overlay** — TradingView-style
  volume-at-price bars drawn on the right edge of the price chart, as a
  separate left-bound histogram series. Toggled via new "Volume Profile"
  entry in the indicator rail. This is what "the vertical histogram
  overlay on the chart" means operationally.

- **E13 / U13 News** ships TWO surfaces:
  (a) `NewsCard` in the Chart-view sidebar — condensed v2-style
  accordion with overall Risk-ON/OFF pill, category chips, top 5
  headlines.
  (b) **Dedicated News tab** in top-bar tabs (Chart / Scanner /
  AI Chat / **News** / System) — full feed, category filters, impact
  filter, symbol filter, chart-marker toggle.
  The sidebar card is a condensed mirror of the tab.

- **E15 / U15 DeepSeek-R1** ships THREE UI consumers:
  (a) `AIChatPane` tab (existing deterministic placeholder upgraded to
  streaming tokens + reasoning trace + JSON tool cards).
  (b) **HybridDecisionCard extension (U9 polish)** — when the LLM is
  connected, add an "LLM Vote" row with direction + one-line
  rationale + "Expand reasoning" link. LLM becomes the 4th input to
  hybrid (after orch, NN, Conformal).
  (c) "Explain this signal" button on TradeSignalCard → opens chat
  tab pre-filled with context.

- **E17 / U17 Backtest tab** adds a 6th top-bar tab (Chart / Scanner /
  AI Chat / News / **Backtest** / System) containing equity curve,
  confusion matrix, regime × TF heatmap, trade list, parameter panel.
  Running backtests is gated behind an explicit "Run" button because
  the walk-forward is CPU-heavy.

- **Scanner** is the existing `ScannerPane` tab (built pre-rewrite).
  E25/U25 adds filters + watchlists + alerts on top of it. The tab
  stays; only its contents and its toolbar grow.

### C3. Platform track (P0 – P7, cross-cutting)

| #   | Name                    | Purpose |
|-----|-------------------------|---------|
| P0  | Test harness canon      | Standardize `tests/phase{N}-unit.html`; fill missing 0, 10, 11 |
| P1  | Event topic registry    | Single `src/core/topics.js` documenting every emitted topic + payload |
| P2  | Store pattern canon     | Base `createStore(storeName)` helper; retrofit all *Store.js |
| P3  | Worker lifecycle        | Standard worker proxy pattern + termination on idle |
| P4  | CI / pre-commit         | Babel parse check + tests/index.html runner |
| P5  | Accessibility pass      | Keyboard audit, focus rings, reduced-motion + high-contrast per card |
| P6  | i18n scaffold           | `src/i18n/` string table (en-only initially, future-proofed) |
| P7  | Telemetry / opt-in logs | Local-only error log viewer in Settings (no network) |

---

## Part D — Vertical-slice milestones

Each milestone leaves the app in a coherent demoable state. Engine phases
inside a milestone ship together with their paired UI phases.

| Milestone | Phases (E + U)                            | User-visible story                                       | Status |
|-----------|-------------------------------------------|----------------------------------------------------------|--------|
| M1 · Live cockpit      | E0–E4, U0–U4              | "I can watch a live chart with TA + structure overlays" | ✅ done |
| M2 · Signal + ML core  | E5–E10, U5–U10            | "I see a bias, a probability, an uncertainty band, drift" | ⚠ mostly done — U5 (feature explorer) missing, phase10 tests missing |
| M3 · Forecast          | E11–E12 + E23, U11–U12 + U23 | "I see forward-projected candles with a widening band, a real volume profile, and auto-drawn trendlines + chart patterns" | ⚠ E11 lacks feedback loop · E12 partial · **E23 greenfield** |
| M3.5 · Multi-asset     | E24 + U24 (**NEW**)       | "I can chart stocks, ETFs, commodities, indices — not just crypto"       | ❌ greenfield (also satisfies v2 parity for symbol universe) |
| M4 · Context           | E13, E18, E19 + U13, U18, U19 | "I see news (with chart markers), macro regime, Wyckoff, funding, intermarket correlations" | ❌ 0% — greenfield |
| M5 · Confidence        | E14, E16 + U14, U16       | "I know how stable the signal is and how the model is weighting inputs today" | ❌ |
| M6 · Reasoning         | E15 + U15                 | "I can ask the local LLM why and get a streamed, cited answer" | ❌ |
| M7 · Evidence          | E17 + U17                 | "I can run a walk-forward backtest and see the equity curve" | ❌ |
| M8 · Platform polish   | E20–E22, U20–U22, P0–P7   | "Multi-tab safe, fast on low-end, private by default"    | ❌ |

**Sequencing rule:** M3 closes (finish ghostStore + E12 enhanced VP +
E23 trendlines+patterns) BEFORE M4 begins. M3.5 (multi-asset) can run
in parallel to M4 or slot before it — the two tracks are independent.
Then M4 ships M4a (News) → M4b (Macro+Wyckoff) → M4c
(Derivatives+Intermarket) in that order, because macro + derivatives
consume news/sentiment signals.

---

## Part E — v2 parity closeout matrix

Everything v2 displays that v3 must eventually display. Each row maps to
the phase that will close it.

| v2 feature                       | v3 phase | Status  |
|----------------------------------|----------|---------|
| Live candle chart + volume       | U3       | ✅ done |
| EMA 9 / 21 / 50 overlays         | U3       | ✅ done (20/50/200) |
| RSI 14 subplot                   | U3       | ✅ done |
| PSAR, Ichimoku, CCI, W%R, MFI    | U3       | ✅ done |
| Trade Signal (LONG/SHORT badge)  | U7       | ✅ done |
| HTF Bias & Structure card        | U7 + U18 | ⚠ HTF grid ✅; Wyckoff phase missing |
| Next Candle Prediction           | U11      | ✅ done (1-bar) — extend to 50-bar v2-style in U11 polish |
| Trade Setup (Entry/TP/SL/R:R)    | U7       | ✅ done |
| Key Levels (BSL / SSL)           | U4       | ✅ done |
| Liquidation Heatmap              | U19 (moved from U4) | ⚠ moved to derivatives card for cohesion |
| News & Macro Impact              | U13      | ❌ missing |
| Analysis Summary table (14 rows) | U7       | ✅ done (13 rows; add Macro row in U18) |
| Symbol search modal              | U1       | ✅ done (picker) |
| Macro sentiment pulse (Risk-ON)  | U18      | ❌ missing |
| Wyckoff phase indicator          | U18      | ❌ missing |
| OI / Funding / L-S ratio         | U19      | ⚠ L-S done standalone; fold into DerivCard |
| Intermarket / RS-vs-BTC          | U19      | ❌ missing |
| Ghost candles (50-bar, patterns) | U11      | ⚠ currently 5-bar; extend to 50 + pattern injection |
| Candlestick-typed next-candle narrative | U11 | ❌ currently OHLC only — add Engulfing/Marubozu/Hammer name + body+wick adjectives (port v2 `_predict_next_candle`) |
| Yellow "Predicted" anchor marker on chart | U11 | ❌ add marker on first forward bar |
| News markers on price chart (📰 snap ±2 bars) | U13 | ❌ add as chart overlay extension to NewsPane |
| Symbol search modal (6 type tabs) | U24 | ❌ need multi-asset picker with typed badges |
| **Advanced chart patterns (11 families)** | **E23/U23** | ❌ **entire dimension missing — #1 priority** |
| Future-candle count input (top bar) | U1 + U11 | ❌ add 0–200 input with auto default |
| Macro Risk-ON / Risk-OFF pill (top bar) | U18 | ❌ MacroRibbon not built |
| Category news taxonomy (8 cats, impact filter) | U13 | ❌ preserve exact v2 lexicon (FED/WAR/CRYPTO REG/EARNINGS/MACRO/CRYPTO MKT/STOCK MKT) |
| **Multi-asset universe (crypto + stocks + ETFs + commodities + indices)** | **E24/U24** | ❌ **crypto-only currently** |
| MTF consistency conflict chip | U7 polish | ⚠ per-TF shown in HTFBiasGrid but no "MIXED — 4h Bear, 1d Bear" call-out |
| Simple Wyckoff phase chip (from bull_pct) | U18 (pre-E18) | ❌ interim phase label before full E18 Wyckoff |
| Last-candle TYPE label (Doji/Hammer/…) with adjectives | U7 ContextCard | ⚠ `ta.patterns` present but KV surface missing |

**v3-beyond-v2 surfaces** (things v3 should ship that v2 doesn't have):

- Feature explorer (U5)
- Conformal / stability cards (U9, U14)
- Adaptive weights card (U16)
- Walk-forward backtest (U17)
- System + storage + perf HUD tabs (U2, U21)
- Multi-tab leader card (U20)
- Settings / privacy (U22)
- Local LLM reasoning trace (U15)

---

## Part F — Immediate next step (the "close M3" move)

Before starting M4, close the gaps the audit flagged. This is small,
concrete, and restores phase integrity before we widen scope.

### Step 1 — Close Phase 11 (engine)
- Add `src/ml/ghostStore.js` (matches conformalStore / modelStore /
  predictionStore pattern).
- Emit `ghost:forecast` on each compute, `ghost:resolved` on bar close.
- Extend `src/validation/monitor.js` to resolve outstanding ghosts on
  bar close, push realized error to a `RollingConformal`, and emit
  `ghost:verdict`.
- Add `tests/phase11-unit.html` covering:
  drift decay, √-horizon band widening, CP vs fallback switch, time
  projection, resolution grading.

### Step 2 — Fill Phase 10 test gap
- Add `tests/phase10-unit.html` covering validator verdict shape,
  direction-hit accounting, PSI/KS/ADWIN/Page-Hinkley drift detection
  on synthetic shift fixtures.

### Step 3 — Add feature explorer (U5)
- `FeatureDrawer` in Signal Sidebar: live feature vector from
  `ml/features.js`, with a toggle to display z-scored vs raw values.
  Fills the only pre-M3 UI gap.

### Step 4 — Upgrade U11 to v2-scale forecast
- Raise default horizon from 5 → 25, expose `nBars` slider in the
  Ghost card (5 / 10 / 25 / 50).
- Add pattern-injection branch: when the forecast direction matches a
  recently-completed candlestick pattern, bias the first ghost's body
  accordingly.

### Step 5 — Upgrade U12 with VAH / VAL / TPO + **on-chart histogram**
- `src/ta/profile/volumeProfileEnhanced.js`: 70% value-area math,
  VAH/VAL, session-anchored mode, TPO letters.
- `VolumeProfileCard` (sidebar): bucket/lookback selector + VAH/VAL
  highlight + POC line + HVN/LVN labels.
- **On-chart overlay (the "vertical histogram overlay on the chart")**:
  add a new `addHistogramSeries` anchored to a dedicated right-side
  price scale, rendering volume-at-price bars horizontally (bars grow
  left from the right edge). Toggled via new "Volume Profile" entry in
  the indicator rail. Bars colored split up/down volume.
- `vp:updated` / `vp:vah-val` events.

### Step 6 — Ship E23 / U23 (Trendlines + Chart Patterns) — **new**

This is the direct response to (a) the user's trendline request and
(b) v2-parity gap G5 (`detect_advanced_patterns`). It's one coherent
delivery because chart patterns ARE trendlines geometrically.

**E23 engine (~380 LOC):**

1. `src/ta/structure/trendlines.js`
   - Input: `candles`, reuse pivots from `src/ta/structure/swings.js`
     (already detected in E4).
   - Algorithm:
     - Take last 6–8 swing highs → least-squares fit line
       `y = m·t + b` → compute slope, R², touch-count (points within
       0.5·ATR of line).
     - Same for swing lows.
     - Score each by `R² × min(touches/4, 1)`.
     - Channel width = 2·σ of residuals.
     - Breakout fires when last close is ≥ 0.5·ATR beyond the line,
       emitting `{ side: "up"|"down", atBar, strength }`.
   - Output:
     ```js
     {
       upper: { slope, intercept, r2, touches, points:[{t,p}…], startT, endT },
       lower: { ... },
       channel: { widthATR, parallel: bool },
       lastBreakout: { side, atBar, strength } | null,
     }
     ```

2. `src/ta/patterns/chartPatterns.js`
   - Port v2's `detect_advanced_patterns` ta_logic.py:128 verbatim,
     ported from pandas→JS with the 11 pattern families:
     Triple Top, Triple Bottom, Head & Shoulders, Inverse H&S,
     Rising Wedge, Falling Wedge, Ascending Triangle,
     Descending Triangle, Symmetrical Triangle, Rounding Top,
     Rounding Bottom (Cup), Bump & Run.
   - Consumes trendlines from (1); adds pattern-specific geometry
     (neckline, measured move target, breakout trigger).
   - Output per pattern: `{ name, bias, confidence, targetPrice,
     invalidationPrice, anchorPoints: [{t,p}…] }`.

3. `src/modules/trendline.js` — orchestrator module #14
   ```
   bias = 0.5 · tanh(slope_norm)
        + 0.3 · breakoutDirection
        + 0.2 · positionInChannel  // +1 near lower, −1 near upper
   confidence = r² · min(touches/4, 1)
   abstain if r² < 0.5 OR touches < 3
   ```

4. `src/modules/chartPatterns.js` — orchestrator module #15
   ```
   bias = biasSign(pattern.bias) · pattern.confidenceWeight
   confidence = pattern.confidence  // High=0.85 / Medium=0.6 / Low=0.35
   abstain if no pattern OR confidence < Low
   ```

5. Register both modules in `src/modules/registry.js` (13 → 15).

6. Events: `trendline:detected`, `trendline:breakout`,
   `pattern:chart:detected`, `pattern:chart:invalidated`.

7. `tests/phase23-unit.html`:
   - Fixture A: synthetic rising channel → assert `slope > 0`,
     `touches ≥ 4`, `r² > 0.8`.
   - Fixture B: synthetic H&S (ls=100, head=120, rs=100, neckline=90)
     → assert pattern="Head & Shoulders", bias="Bearish",
     targetPrice≈70 (neckline − head-height).
   - Fixture C: synthetic breakout (price closes 0.7·ATR above upper
     trendline) → assert `lastBreakout.side="up"`.

**U23 UI (~120 LOC):**

1. `ChartPane` — extend `seriesRef` with `{ upperTL, lowerTL,
   channelFill, patternPolyline }`. Keyed on `ta.trendlines` + selected
   pattern. Teardown on toggle-off. Breakout fires a marker (▲/▼) at
   the breakout bar.

2. Indicator rail — add two toggles: "Trendlines" and "Patterns".

3. `ChartPatternCard` in sidebar (after `PatternCard`):
   - Pattern name + bias chip + confidence chip
   - Measured-move target + invalidation level (formatted with smart
     decimals)
   - Mini-SVG showing the pattern anchor points
   - Empty state: "No pattern in last 30 bars"

4. `ModuleBreakdownCard` auto-picks up modules 14 + 15 (no UI work —
   the orchestrator loop iterates registry).

5. `SummaryTableCard` — add one row: "Chart Pattern".

**Why ship this inside M3 closeout rather than later:**
- The chart-pattern module ALSO completes v2 gap G5 which is big.
- Trendlines naturally pair with Ghost Candles: if the forecast
  horizon projects through a rising lower trendline, the sidebar can
  flag consonance; if it projects against the upper line, a warning
  chip renders. This is a richer M3 demo than ghost-alone.
- Same code path would otherwise be rediscovered during M4 Wyckoff
  (Wyckoff's spring/UTAD needs trendline geometry) — build the
  primitive once.

**Effort:** ~500 LOC total (engine 380 + UI 120). One session for
engine + tests, one session for UI + chart overlay.

---

When Steps 1–6 ship, M3 is formally closed and we begin M4 with a
clean ledger AND the chart-pattern dimension restored to v2 parity.

---

## Part G — Rules of engagement going forward

1. **No more decimal patches.** If a UI scope appears mid-stream, it
   gets its own U-phase (or piggybacks an existing one). Never mint
   "10.7 / 10.8" rows.
2. **No phase is done until its test, event, and store exist.** If a
   phase can't persist or can't grade itself, it's partial.
3. **README roadmap mirrors this doc.** Roadmap table in v3/README.md
   is auto-derivable from Part C tables here.
4. **Status reports quote this doc.** When I say "Phase 11 shipped",
   it shall mean E11 + U11 + store + events + tests, per the phase
   shape in Part B §4–5.

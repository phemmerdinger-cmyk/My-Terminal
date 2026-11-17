# Market Desk 2.0 — implementation progress

Branch: `feat/desk-2.0-phase1` · Spec: the "Market Desk 2.0" directive (13 phases). Naming: the owner rejected "Mission Control" — the landing page is **Home**. Avoid grandiose names for new modules; prefer plain ones.

## Done
### Phase 0 — audit
- `CLAUDE.md`, `docs/ARCH-MAP.md` (concise map). Existing `docs/ARCHITECTURE.md` = feature-ownership rules.
- Already present (extend, don't rebuild): Quant Lab strategy tournament + walk-forward backtests, Intelligence Studio browser alerts, Spider research memory (versioned discoveries, sources, fact/interpretation, timelines, export/import), knowledge graph `/api/web/graph`, command palette `#cmd` (search only), military-green theme.

### Phase 1 — Home (personalized landing page)
- `server.js`: owner-only `/api/desk` doc store (`deskRoute`, `DESK_KEYS` allowlist, 800 KB cap, timestamp validation, 409 on stale write, `?force=1`).
- `public/desk-store.js`: `window.MDDesk` — sections in localStorage + debounced server mirror + pull/adopt newer + export/import. Visitors: memory only.
- `public/home-core.js` (pure): `summarize` (merged lots, unpriced excluded, unrealized vs day), `exposureShift`, `risk` (hypothetical 1Y, today's shares, vs benchmark), `briefing` (sourced+timestamped only, relevance + reasons, dedupe, new-since-last-visit), `priorities`, layout model.
- `public/home.js` + `home.css`: widgets (priorities, briefing, portfolio, allocation, risk, catalysts); drag/drop + ↑/↓ keyboard, resize 1–3 cols, hide/restore, named layouts, reset, portfolio picker, compact/expanded, export/import personal data. Owner lands on `#home`; demo still lands on News.
- `index.html`: Home nav group/tab, `setTab` hook, quote/news refresh hooks, scripts/CSS.
- Limits/benchmark read from `MDDesk.get("dna")` when Phase 2 exists (`maxPosition`, `maxSector`, `benchmark`).

Tests: `tests/home-core.test.js`, `tests/desk.test.js` (incl. privacy: 401 for visitor/forged cookie). `npm test` → 132 pass. Browser smoke (Playwright + local Chrome, `/tmp/smoke.py` not committed): render, persistence across reload, server copy, demo mode, mobile layout.

### Day trader — self-learning brain (AI vs S&P 500)
- Same pace as before (every stock, every minute, ~38,800 trades/day), but the side and size now come from `daytrade-brain.js` (pure, tested in `tests/daybrain.test.js`): 18 features — chart (1/5/15-min momentum, VWAP distance, EMA trend, order flow, per-stock autocorrelation, sweeps/gap-and-go via `daytrade-core.js`, patterns), tape (beta-adjusted RS vs SPY, SPY last minute × beta, breadth), and the rest of the site (News/earnings/analysts/Financials health grade, Spider `signal(sym,{trader:true})`, swing-bot score percentile `apScoreOf`, Quant trader ranking + regime, sector ETF vs SPY, Macro page yield curve/Sahm, VIX).
- Online linear forecaster: Huber error, one RMSprop step per minute on the averaged gradient, L2 pull toward starting weights. Prequential scorecard (hit rate, IC) → `/api/daytrader` `model`, shown as "🧠 The forecast model" card.
- Sizing by edge after costs (0.15×–2× a slice), half size into earnings / after −3% day, portfolio guard: gross ≤ 4×, |net| ≤ 1.5× (0.75× under stress). Brain persists in the DT doc and survives busts.
- Offline replay (synthetic 100 stocks × 390 min): 38,800 trades, ~3.5 ms per minute of decisions.

### All bots reset to $30,000 (2026-11-16)
- `BOT_RESET_ID` in server.js: on the first start with a new id, the swing bot, day trader and Quant trader each archive the old run (test-run history; Quant gets a `runs` list) and restart at $30,000 together. Backups from before the reset are refused by `apRestore`/`dtRestore`. Swing bust line is now $3,000 (still a 90% loss). `QT_START` = 30000.

### Home: trading bots replace Daily priorities (2026-11-16)
- `priorities` removed (core, widget, CSS, test). New top widget `trading` ("AI vs S&P 500 · trading bots"): swing, day and Quant bots — value, return, the S&P over each bot's own run, lead in $, combined total — from `/api/pub/botslive` (now includes Quant + run/trades/hit-rate extras), polled every 10 s while Home is visible. Pure `botBoard()` in home-core (tested). Saved layouts get the new widget on top; clicking a bot opens it on AI vs S&P 500.
- "Strategy drawdown" / "thesis contradiction" priorities from Known limitations no longer apply.

### Day trader leverage raised to 10× (2026-11-16, owner's choice: same $30,000, higher risk)
- `DT_LEV = 10` (gross cap; was 6×, before that 4×, above a real broker's 4× PDT limit — labeled on the page), slice = 0.75 × DT_LEV × equity ÷ stocks, `DT_NET = 3.75` net cap (half under stress).

### Day trader: evidence first (2026-11-16, owner: "quick profits backed by news and earnings")
- `evidenceTilt()` in daytrade-brain.js (tested): evidence = research lean (news/earnings/analysts/health) + ½ Spider. |e| ≥ 0.4 picks the side when the forecast is weak; agreeing evidence ×(1+1.5|e|) up to 2.5×, opposing down to 0.25×. Earnings-due half size only when unbacked. Trade log says "backed by: …".

### Day trader: Quant Lab factor analysis (2026-11-16)
- `quantScores()` in daytrade-brain.js (tested, qmath.js math): daily cross-sectional z-scores for all 100 stocks — 12-1 momentum, residual momentum vs SPY (beta-adjusted), 3-month momentum, low vol, 200-day trend, 5-day reversal, 6-month Sharpe. The `quant` feature = 65% factors + 35% Quant trader ranking (where covered); also +0.3 into the evidence tilt. `/api/daytrader` `quantFactors` → "📐 Quant factor analysis" card.

### Zweig put/call ratio for all three bots (2026-11-16)
- `putcall-core.js` (UMD, tested in `tests/putcall.test.js`): Marty Zweig's contrarian reading — more puts than usual = crowd bearish = **bullish**; more calls = crowd bullish = **bearish**. 10-day average of the Cboe EQUITY put/call ratio, ranked against its own history (≥60 days, up to a year; fixed bands before that). A turn back from an extreme = BUY/SELL signal. Score −1…+1 (+ = bullish).
- server.js: daily Cboe market statistics (free), backfilled ~40 days per 30-min run up to a year, persisted (Upstash or tmp, key `pft:putcall:v1`). Today's figure is marked provisional. Fallback only when Cboe has <10 days: labeled proxy from Yahoo option-chain volume (10 mega-caps, nearest expiry). No data → no tilt.
- Swing bot: `exposureTilt` — fear + S&P below 200-day → up to 95% invested (not 80%); euphoria in an uptrend → up to 15% cash; never overrides defense mode. Buy reasons mention a BUY signal. Quant trader: `decide(px, {putcall})` nudges the equity sleeve ±10% (not in risk-off), shown in the trade reason. Day trader: ±0.25 added to the market lean.
- Public `/api/pub/putcall` → "Put/call ratio · Marty Zweig's contrarian gauge" card on AI vs S&P 500 (10-day avg, zone, crowd vs contrarian read, signal, chart, how each bot uses it, source).
- Not verified against live Cboe from the dev sandbox (no network): check the card after deploy; if it says unavailable, Cboe is blocking Render and the proxy takes over after 10 trading days.

### Three-Trader Challenge — Phase 1 audit + Phase 2 reliability (2026-11-16)
- Audit (live data, Nov 16 after the $30k reset): day trader 16,315 trades, −$1,293, of which modeled costs $1,234 (≈ flat before costs); avg forecast 0.034 ATR vs round-trip cost ≈ 0.083 (long) / 0.167 (short) ATR. Swing bot: a single-stock headline ("Helus Pharma stock tumbles 21%") tripped market defense mode 10 min after buying; rank sells within 1–4 h. Quant: one day, tracking the market.
- `risk-core.js` (tested, `tests/risk-core.test.js`): market-wide swan filter, stale-quote check, Alex's net-edge qualification rule, daily loss limit, expectancy with 95% interval, swing rank-exit rule, strategy-version check, data-gap minutes.
- Strategy registry `STRATS` in server.js (Alex `alex-intraday` v2, Sarah `sarah-swing` v2, Daniel `daniel-macro-quant` v2). A version change archives the run (full records) to `pft:archive:v1:<bot>` (Upstash list + tmp file) and starts a new $30,000 run. Busts archive too (swing no longer wipes trades). Public `/api/pub/archive?bot=`, `/api/pub/strategies`.
- Alex v2: trades only when |forecast| > round-trip costs + 50% buffer; 1 bp/side costs + 1 bp borrow; 0.25% risk per trade, ≤0.5× equity per position, 4× gross / 2× net; 1% daily loss halt; evidence can veto/shrink only; gaps > 5 min close trades at the reconnect price, only the newest bar can open; 5,000-record log; daily aggregates; research scorecard (all forecasts vs qualified, net of costs, in ATR) on the page.
- Sarah v2: rank sells/swaps only at the opening re-score after ≥2 days held; no trades/stops on quotes older than 15 min in session.
- "Order flow" relabeled "candle pressure (OHLC proxy)".
- Next (directive phases 3–8): central risk engine across bots, walk-forward validation + research registry for each strategy, Daniel's macro (FRED/ALFRED vintages) model vs simple baselines, Sarah's setup scoring trained out of sample, competition leaderboard + Investment Committee view, trader profiles/portraits, trade replay.

### Three-Trader Challenge leaderboard (2026-11-16)
- `competition-core.js` (tested): same-window stats per trader (profit, return, S&P and alpha over identical dates, max drawdown, vol, Sharpe/Sortino ≥20 days, annualized/Calmar ≥60 days, t-stat vs S&P), ranking by net profit, 20% drawdown limit → ineligible.
- `/api/pub/leaderboard` + cards at the top of AI vs S&P 500 (Alex/Daniel/Sarah, initials as portraits, period switch Today/Week/Month/Quarter/Lifetime, expectancy with 95% range, costs, exposure, latest decision); clicking a card opens that bot.

## Next
- **Phase 2 — Investor DNA**: new `dna` desk section + profiles; form page (probably under Portfolio group); wire into Home (limits, benchmark, sector interests → briefing reasons), news-intel For-you weights, Spider `/api/web/context` priorities. Suggested-preference approvals (never auto-apply).
- Then 3 (thesis tracking on top of Spider memory), 4 (analyst: deterministic mode first), 5 (extend Quant Lab tournament), 6 (extend `/api/web/graph`), 7 (workspaces + extend `#cmd` palette), 8, 9, 10 (extend Studio alerts), 11 (purge leftover orange e.g. Ask Claude FAB `--claude`), 12–13.

## Known limitations
- Without Upstash keys, `/api/desk` lives in Render's temp folder (wiped on redeploy); localStorage copy + Export cover that.
- Briefing "since last visit" uses the previous session ≥30 min old, per browser profile (synced via desk doc).
- "Strategy drawdown" and "thesis contradiction" priorities wait for Phases 3/5.

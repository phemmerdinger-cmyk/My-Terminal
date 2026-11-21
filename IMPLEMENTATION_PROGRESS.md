# Market Desk 2.0 — implementation progress

Branch: `feat/desk-2.0-phase1` · Spec: the "Market Desk 2.0" directive (13 phases). Naming: the owner rejected "Mission Control" — the landing page is **Home**. Avoid grandiose names for new modules; prefer plain ones.

## Done
### Workspace tab removed (2026-11-21, owner's request)
- Research → Workspace (and its Multi-screen layout) is gone: `public/workspace.js`, `public/workspace-core.js` and their tests deleted, the tab, lazy group and `?pane=1` page mode removed. Saved `md_ws` layouts are simply ignored.

### Bot HQ — a separate website for the bots (2026-11-21)
- Its own site, not a page of Market Desk: on the laptop desk it runs at **http://127.0.0.1:3001** (second port of the same local server, `HQ_PORT`); online it can run as its own service with `MODE=hq` (its own sign-in with SITE_PASSWORD; reads the bots from PUBLIC_URL with DESK_TOKEN, read-only routes only). Market Desk's "HQ" button links to it when one is available (`/api/health` → `hqUrl`; `HQ_URL` env for an online one). The main site no longer serves `/hq`.
- Laid out like the agentic-trading video: top bar (spider/bots status, $0 AI budget, jobs run, decisions, clock), live tape, sidebar (Overview · Lab · Research · Strategies · Rulebook · Agent room · Paper & live · Decisions · Costs · Machines). Overview: 8-number strip, brain core (sources flow into a particle sphere, signals/checks/trades flow out, with sparklines and jobs-per-minute), daily report, pipeline, automatic decisions. Lab: toughness checks + bad-luck reshuffle fans of each bot's own trades. Research: findings constellation, now-reading, thought stream. Strategies: list with sparklines and check dots; key numbers, equity vs S&P, drawdown, monthly grid, weekday/hour, holdings, queued orders, trades. Rulebook: 11 rule cards (plain words + the deciding code, `public/hq-rules.js`). Agent room: 2.5D floor drawn in code (drag to turn, click a desk for NOW/WHY/FOUND/NEXT). Machines: public-server health (`/api/system/health`).
- Home is a full-screen globe: every section sits on a ring around it, wired into it. Click the globe to go inside: the six agents (spider in the middle; swing, day, quant, Strategy Lab, risk desk around it, with research flowing out from the spider). Click an agent for its page: its research (what it holds, plans and weighs, with the spider's findings, signals and pre-buy checks on each; the spider's page shows what it's reading, its queue, findings and thought stream), then its numbers and trades. The research map was removed; Research keeps filters, findings, now reading, queue and stream.
- Logo: an orange globe (`public/hq-favicon.svg`, also on its top bar and sign-in page).
- Rules in `deploy-mode-core.js` (`hqAccess`, `hqPage`); logic in `public/hq-core.js`; UI `public/hq.html` + `public/hq.js`. Tests: `tests/hq-core.test.js`, `tests/hq-site.test.js` (runs the server with MODE=hq).

### Multi-screen, Bloomberg style (2026-11-21)
- Research → Workspace → **Multi-screen**: 2, 3, 4 or 6 live screens at once, each showing any site tool (news, heatmap, stock research for any ticker, macro, portfolio, bots, labs…), with reload, enlarge (Esc to shrink), pop out into its own window, and a ⛶ full-screen grid. Layout and choices are saved.
- Each screen zooms on its own (− / % / + buttons or Ctrl + scroll inside it, 50%–200%, saved with the layout).
- Each screen is the normal site at `?pane=1` (top bar, menus, watchlist and pop-ups hidden), so every tool works as usual. Pane helpers in `public/workspace-core.js` (tested).
- Framing policy is now same-site only (`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`): other websites still can't embed Market Desk.

### Toughness test with automatic gating (2026-11-21)
- `robustness-core.js` replays a bot's own rules on past daily prices and checks: profit after costs, the later 40% of the period on its own, settings ±20%, doubled costs, and 1,000 bad-luck reshuffles (5th-percentile result > −15%, 95th-percentile drawdown < 30%). One miss = borderline; a loss or two misses = fail; under 15 trades = too few to judge. Limits (today's stock list, daily bars, modeled costs, hypothetical) are shown with every result.
- Runs weekly after the close inside the Strategy Lab (pullback, sector rotation) and the Quant trader's planning step (monthly replay of `decide()`; put/call tilt and ratio score off — no free history). Earnings-drift, insider-buying, the swing bot and the day trader have no free history for their inputs, so they're judged on their live paper record after 20 closed trades.
- No approvals: a failing lab bot's new buys pause automatically until a re-test passes; exits keep running. The three main bots show their result but keep trading. Results appear in the existing Strategy Lab rows and notes (no new section).

### Four more paper bots in the Strategy Lab (2026-11-21)
- New rows in the existing Strategy Lab table (AI Lab → Bots vs S&P 500), no new page: **2-day pullback** (Connors RSI(2) < 10 above the 200-day, exit above the 5-day average, 8% stop, 7 sessions), **monthly sector rotation** (top 3 of 11 sector funds by 3/6-month return, only above their 200-day), **post-earnings drift** (≥5% EPS beat confirmed by a ≥2% up day, 10% stop, 40 sessions), **insider buying** (≥2 different open-market insider buyers in a spider Form 4 finding from the last 10 days, not >20% below the 200-day, 12% stop, 60 sessions).
- Rules: `extra-bots-core.js`; books: `extra-bots-runner.js` (decide after the close on final daily bars, fill only at the verified 9:30 open with modeled costs; unfilled buys expire, unfilled sells retry). Each $30k paper book. Tests: `tests/extra-bots.test.js`, lab test in `tests/strategy-lab.test.js`.
- The pairs bot already existed as "Quant · hedged spread book".

### Bots and the spider work together (2026-11-21)
- **Pre-buy check:** before the swing bot buys, the spider's research on that stock is checked (`bot-teamwork-core.preBuyCheck`). Negative regulatory, negative earnings or negative filing findings, or a strongly negative research signal, veto the buy; insider selling or a news spike is logged as a caution. Stocks the spider hasn't researched in 7 days are queued for research and allowed.
- **Quant regime confirmation:** a new regime is used only after it shows up 3 trading days in a row, or sooner toward safety when the spider's own macro research shows stress (`confirmRegime`). Raw vs confirmed regime is stored with each decision.
- **Quant cash fix:** BIL (T-bills) was treated like a stock with a 2% stop, so the desk's per-trade risk cap clipped each BIL buy near $3k and left most of the account in plain cash. BIL now counts as near-zero stop risk.
- **Post-mortems:** every closed swing trade is paired with its buy and its loss classified (earnings, bad news, market selloff, stop, trend break, rank decay). Buy patterns (e.g. chasing a 3%+ gap) with ≥4 trades, <40% wins and a net loss lower new picks' scores by up to 0.06.
- **Earnings early warning:** holdings reporting within 5 trading days are held, or trimmed (half if the spider's research leans negative; a third of a big high-risk winner the day before). New buys wait for the report unless research leans positive (never within 1 day).
- **Smarter defense mode:** full defense needs a broad selloff or two independent warnings (VIX ≥30 or +20%, S&P −2%, black-swan headline, the spider's own macro findings — not its mirror of the bot). High-risk holdings are trimmed first; the safe sleeve keeps its normal size; no new high-risk buys for the rest of the day. One warning = caution (high-risk buys paused, nothing sold).
- **Spider-off twin:** a hypothetical copy of the swing bot without any spider input runs from the same holdings, filled at scan prices, to show whether the research helps.
- **Why card:** Research → "Why (bots)" shows each bot's view of a stock (rank, score parts, holdings, plans, trades) and the spider's evidence with sources (`/api/why`, owner/desk only).
- **Morning brief (pop-up):** opens by itself once a day the first time the owner opens the desk, and from the ☀ button in the top bar (no separate tab). It lists overnight spider findings, each bot's plan for the open, today's earnings, risk flags, the twin comparison, lessons and pre-buy checks (`/api/brief`, owner/desk only; `public/teamwork.js`, lazy group `team`).
- Anthropic (ANT) is an ordinary stock again: no IPO shortcut, banner or special data handling, and not in the default watchlist (existing personal watchlists unchanged).

### Lists that update themselves (2026-11-21)
- The S&P 500 list refreshes daily from github.com/datasets/s-and-p-500-companies (`sp500-core.js`, tests in `tests/sp500-core.test.js`); `/sp500.json` is served from memory with `asOf`, `joined`, `left`; a bad download keeps the last good list. Bots and screens using `SP500` see the update in place.
- The instant search list adds S&P joiners and the exchange catalog's new listings (past week) on page load, so new IPOs appear without editing `tickers.js`.
- The owner's laptop desk (`Market Desk.bat`) downloads the latest `main` from GitHub on every start and keeps the existing copy when offline.

### Bigger built-in ticker directory (2026-11-21)
- `public/tickers.js` grew from 296 to 753 entries: every S&P 500 company (names from `sp500.json`), about 130 popular non-S&P stocks (growth, ADRs, crypto-linked, recent IPOs such as CRWV, CRCL, FIG, CBRS, FRVO) and 26 more ETFs. No duplicates. Live Yahoo search still finds anything not listed.

### SpaceX (SPCX) (2026-11-21)
- SpaceX, public on Nasdaq since June 12, 2026 as SPCX, is in the built-in ticker directory (instant search suggestions) and the default watchlist after ANT. Existing personal watchlists are unchanged.

### News page polish (2026-11-20)
- News sources use theme-friendly colors (Yahoo orange, CNBC gold, Morningstar red, Seeking Alpha burnt orange, WSJ off-white, Official grey); story counts are neutral text, only "unavailable" is red.
- The newspaper masthead stacks (title, date, index moves) when the news column is under 900px wide, so the index strip is never squeezed or clipped.

### Back to black and orange (2026-11-20, owner's request)
- Every military/olive-green accent (theme, Studio, spider, Quant, reader, charts, favicons) is mapped back to the original orange `#ff991f` family; gains stay green and losses red. Categorical chart palettes, news-source colors and the red-to-green mood gauge keep their colors. `tests/orange-theme.test.js` now fails if an olive accent returns.

### Research → Workspace (2026-11-20)
- One ticker, four panels side by side: price chart (1M/6M/1Y/5Y), key stats, latest tagged news (opens in the in-site reader) and the last four 10-K years (revenue, growth, net income, margin, free cash flow). Grid or Focus layout; watchlist chips; stacks on phones.
- Each panel loads and fails independently with its own message; missing values show "—". Growth and margins are computed only from reported figures. Logic in `public/workspace-core.js` (tests in `tests/workspace-core.test.js`); UI in `public/workspace.js`, loaded on demand.

### Faster first load, phone polish, "Trading bots vs. S&P 500" (2026-11-19)
- Quant Lab, Backtest Lab and Studio tools load when their tab first opens (`public/lazy-core.js`, tests in `tests/lazy-core.test.js`); each tool still opens itself once loaded. THE WEB's spider code loads for the owner only, after the page settles, so the demo no longer downloads it or polls its private endpoints. About 460 KB less code on the demo's first page.
- AI Lab's bot page is now "Trading bots vs. the S&P 500", with a line saying the rules decide every trade and no AI model trades. Welcome, About and meta text updated to match.
- Phones: the demo welcome strip is two lines with one button; the spider button is owner-only.

### Review fixes (2026-11-19)
- Demo visitors land on Markets Overview. Prediction Accuracy is hidden in the demo (the owner's log is private). The About box links to the code on GitHub.
- DCF and Financials open on the selected stock only when it has 10-K data; otherwise AAPL (a fresh IPO such as ANT has no 10-K yet).
- Live price streams are capped at 4 per visitor and 200 in total.
- Accessibility: decorative nav emoji are hidden from screen readers, the About dialog traps and restores focus, keyboard focus is always visible.
- `og.png` compressed from 838 KB to 270 KB. Removed the committed `srv.log`, an unreachable THE WEB branch in `setTab`, and stale README text ($10,000 accounts, `cd stock-hub`).

### Two-server deploy modes (2026-11-19)
- `MODE=public` serves only the demo: no sign-in page, no Claude, owner-only API routes return 404. It keeps running the paper bots and THE WEB and answers the owner's bot, sync and desk routes only for requests carrying `DESK_TOKEN`.
- `MODE=local` is the owner desk on 127.0.0.1 with no password. It runs no bots or Spider and forwards their routes, sync and the desk store to `PUBLIC_URL` with `DESK_TOKEN`.
- Unset `MODE` keeps the existing sign-in behavior. Routing rules live in `deploy-mode-core.js` with tests in `tests/deploy-mode-core.test.js`.
- Rate limits, password lockouts and the Claude hourly cap use `True-Client-IP` / `CF-Connecting-IP` (set by Cloudflare in front of Render) or the socket address, never the client-supplied first `X-Forwarded-For` entry.
- Dockerfile uses Node 22 to match `engines`. Four tests that checked removed Home/Studio markup now check the current routing.

### Research trade updates and one-minute charts (2026-11-19)
- Prioritize the active Research ticker in the owner’s live stream. A valid regular-session trade can update an IPO quote without a previous close. Slower snapshots preserve newer trades.
- Update the Research price and its timestamp at most once per second as trades arrive. Use one-minute candles for the 1D Research view.

### ANT Research and extended-hours quotes (2026-11-19)
- Open ANT in its own Research view and start on the intraday chart. Reset the visible chart immediately on symbol changes and exclude zero-volume IPO placeholders from trade history.
- Label pre-market and after-hours prices with their New York timestamps. Keep the IPO offer separate and link to the auction indication while the first market quote is pending.

### Free ticker discovery and portfolio review (2026-11-19)
- Refresh the exchange ticker directory and SEC company names in the background and use them in the existing search. Type “new listings” to see symbols first detected in the last seven days. The first complete snapshot establishes a baseline for future changes.
- Calculate and preview dashboard holdings changes before saving them. Show shares, price and resulting average cost in a confirmation using the existing portfolio controls. An unavailable market price can be replaced by the owner's actual cost. Existing sync saves the confirmed changes.

### Anthropic IPO and Day Trader momentum (2026-11-19)
- Add Nasdaq-listed ANT to ticker search, the default watchlist and a Research shortcut. Show the official $83 IPO offer separately from the latest observed quote. Wait for a positive-volume regular-session candle before showing a debut market price.
- Add confirmed momentum to the main paper Day Trader alongside ETF reversals. Require aligned one- and five-minute moves plus either a qualified forecast or an observed five-minute move of at least 25 basis points. Rank candidates by target room after costs and recheck fixed brackets at the scheduled opening print. Use the existing Day allocation and desk controls.

### Main Day Trader ETF reversals (2026-11-18)
- Switch the main paper strategy to confirmed one-minute ETF reversals toward session VWAP. Preserve the original forecast for learning and the separate Volume Test.
- Require a sweep of a recent range, a separate confirmation, at least twice modeled round-trip cost in target room, and a fresh exact opening print. Recheck target room, fixed bracket, and paper allocation at the opening print.
- Give this Day-only paper strategy a bounded exception to the standard shared exposure caps, with $15 modeled risk per entry, $30 open or queued, and $60 committed in a session. Gross exposure and gross SPY beta are each capped at $3,000 for the allocation. Desk loss and volatility controls still apply. Preserve paper balances and position history.

### Day Trader volume experiment (2026-11-18)
- Run a separate paper experiment with a target of 1,000 completed intraday round trips on a full session. Reuse the one-minute scanner and rank the available forecasts by estimated edge, including forecasts below the main strategy's cost hurdle.
- Settle only observed post-decision opens and completed bars. Use up to $200 per order and $10,000 of gross paper exposure. Charge 5 basis points per side and a one-basis-point short entry allowance. Show fees, net paper P&L, and the number of completed trials that cleared the cost hurdle.

### Day Trader entry cadence (2026-11-18)
- Evaluate each new completed minute while a symbol is flat and has no entry queued. A separate observation remains scheduled for model scoring, with one unfinished research sample per symbol.
- Cap forward paper entries between learning samples at $15 of modeled stop risk. Report the extra forecasts and fills separately.
- Preserve open positions, queued risk-approved orders, learned weights, paper balances, modeled costs and desk limits across the state migration. Expire a missed entry independently of its research observation.

### Owner Strategy Lab and cash benchmark (2026-11-18)
- Independent forward paper books evaluate five-minute Day continuation/reversal and gap-filter ablation, Stage 2 Swing with and without timestamped SEC earnings confirmation, and fixed-hedge Quant pairs. The incumbent books remain the operational comparison.
- The lab records synchronized completed-session comparisons, doubled-cost sensitivity, SPY and a prior-observation cash benchmark using FRED DGS3MO with a U.S. Treasury par-yield fallback. The cash hurdle is a comparison series and adds no interest to the paper ledgers.
- Pairs require a recorded borrow estimate and an eligible opening print for both legs. The owner interface records the evidence source and timestamp. Original research and trader sources appear under the owner-only notes.

### Shared paper desk risk (2026-11-18)
- The combined paper desk now uses synchronized position marks and a persistent session reference/high-water mark. New risk is scaled at a $400 daily loss, stopped for the session at $650, and locked at a $1,000 peak drawdown pending owner review.
- Paper entry sizing uses aggregate stop risk, estimated SPY beta and per-strategy dollar budgets. Reducing orders remain eligible. The current Quant allocator uses a labeled 2% adverse-price scenario plus costs because its legacy positions have no individual stops.
- Owner controls live on AI Lab → AI vs S&P 500, with one dashboard showing the active reference, marked equity, exposure, and any risk lock.

### AI vs S&P 500: top hero and Three-Trader leaderboard removed from the page (2026-11-18, owner's request)
- Removed the `#apHero` readout and the `#apLb` Three-Trader Challenge leaderboard (markup, CSS, `apLeaderboard`/`heroRender`/`lbRender`). The tab now opens on the trader switcher.
- Kept server-side: `/api/pub/leaderboard`, `competition-core` (`windowStats` with `spxProfit`/`edge`, `combine`) and their tests, in case the UI comes back.

### Day Trader forecast horizon (2026-11-18)
- Model, research scoring and the paper holding clock use the same ten-minute window. Score the originally issued prediction only after its scheduled outcome is available. History and account equity carry over, and training starts fresh for the new window.
- Keep the modeled round-trip costs, buffer and exposure limits. Require the whole window to fit before the regular or early close. Settle stops, targets and time exits from completed bars, with a conservative first-fresh-open exit after an actual data gap.
- Show the strongest forecast against its cost threshold and distinguish qualified, queued, vetoed, expired and filled entries. Use Block's `XYZ` ticker in the scanner and sector lookup.

### Paper execution audit and capital reset (2026-11-17)
- Swing uses prior-session daily indicators and fills queued orders against a fresh, later print with a 7.5 bp adverse allowance.
- Day fills strictly after the decision at a scheduled completed minute's open. Missing bars expire, ambiguous stop/target bars take the stop first, and the model scores the corresponding open-to-close return. New fills use 5 bp per side plus 1 bp for short entries.
- Quant freezes share orders using finalized daily inputs, fills against the following session's opening data, and accounts for entry and exit costs in closed-trade P&L.
- Backtest Lab values positions using carried marks while requiring observed completed bars for fills. Rebalances with unavailable prices expire after five benchmark sessions, and closed-trade P&L includes both legs' costs.
- The three deployed paper accounts restart at $30,000 under a new reset marker and archive their earlier trades. Market data quotes and modeled fills cannot establish actual broker slippage.

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

### Fin 370 ratio indicators (2026-11-16, owner's course units 6–9)
- `ratio-core.js` (tested against the Unit 6 Sage Inc. DuPont workbook): profitability (gross/operating/net margin, ROE, 3-step DuPont), leverage (D/E, D/A, A/E, LT debt/capital — total liabilities as "debt", as in the units), efficiency (AR/inventory/asset turnover on average balances, DSO/DIO/DPO, cash conversion cycle), valuation (P/E, P/S, P/B, PEG, P/CF, EV/EBITDA, dividend yield). `score()` = 75% rank vs peers scored at the same time + 25% better/worse than the prior year, per family, −1…+1; needs ≥ 8 peers.
- SEC tags added: `payables` (AccountsPayableCurrent…), `dividends` (PaymentsOfDividends…).
- Sarah v3: +0.08 × ratio score in the ranking; buy reasons cite the strongest/weakest ratio. Daniel v3: +0.25 × ratio score in the stock ranking (ETFs 0). Both weights are fixed priors, labeled in STRATS, to be tested out of sample. Alex unchanged (annual ratios have no 1-minute signal).
- Leaderboard portraits removed at the owner's request (2026-11-17).

## Next
- **Phase 2 — Investor DNA**: new `dna` desk section + profiles; form page (probably under Portfolio group); wire into Home (limits, benchmark, sector interests → briefing reasons), news-intel For-you weights, Spider `/api/web/context` priorities. Suggested-preference approvals (never auto-apply).
- Then 3 (thesis tracking on top of Spider memory), 4 (analyst: deterministic mode first), 5 (extend Quant Lab tournament), 6 (extend `/api/web/graph`), 7 (workspaces + extend `#cmd` palette), 8, 9, 10 (extend Studio alerts), 11 (purge leftover orange e.g. Ask Claude FAB `--claude`), 12–13.

## Known limitations
- Without Upstash keys, `/api/desk` lives in Render's temp folder (wiped on redeploy); localStorage copy + Export cover that.
- Briefing "since last visit" uses the previous session ≥30 min old, per browser profile (synced via desk doc).
- "Strategy drawdown" and "thesis contradiction" priorities wait for Phases 3/5.

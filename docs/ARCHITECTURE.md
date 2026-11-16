# Market Desk — information architecture

Every feature has **one home**. Other pages may show a compact summary of it with a link to that home, but never a second full copy. Check this file before adding a feature: if the data or tool already has a home, extend that page or add a summary that links to it.

## Ownership map

| Area (nav) | Page | Owns | Summaries it may show (and where they link) |
|---|---|---|---|
| Home | **Home** (owner landing page; `home.js`, `home-core.js`) | Personal briefing ranked by relevance (news, SEC 8-Ks, Spider findings, earnings, big moves on holdings — each with source + timestamp + "why this matters"), daily priorities, portfolio command (value / today / unrealized), allocation vs limits, hypothetical 1Y risk vs benchmark, catalysts. Customizable layout saved via `MDDesk` | Every widget links to its home page (Portfolio, Risk, Research, News, THE WEB, Macro); it holds no full copies |
| Markets | **Overview** (dashboard) | Market radar (what is unusual right now: big moves, breaking news, volume, earnings, macro findings), earnings calendar, top gainers/losers/most active, watchlist performance table (1W–1Y, news mood), cross-asset tables (indexes, Treasuries, bond funds, crypto, ETFs, mutual funds, futures), analyst Best Buys/Sells | Market health (→ Analysis), Your portfolio today (→ Portfolio), Latest research findings (→ THE WEB) |
| Markets | **News** | Full news feed (6 sources incl. Official: Fed, SEC, BLS, BEA, Treasury, 8-Ks), filters, Smart Money, the in-site **reader** (`public/reader.js`), saved articles, which companies are most in the news | — |
| Markets | **Heatmap** | Every S&P 500 stock's move, grouped by sector | — |
| Markets | **Analysis** | The market-health score (one scorer: `anScores`), the written market brief, sector leadership, what's driving the market, Claude's market deep dive | Top 6 stories (→ News) |
| Markets | **Macro** | Economic series from FRED (rates, inflation, jobs, growth, recession signals) | — |
| Research | **Stock research** | Quote pages, price charts, company compare | — |
| Research | **Financials / DCF** | SEC statement analysis and valuation | — |
| Portfolio | **My portfolio** | Holdings, allocation, performance chart, price alerts, past-year return / Sharpe / beta summary | → Risk & stress |
| Portfolio | **Intelligence Studio** (in THE WEB group) | Scenario what-if calculations, holding-based research context, network preview, saved-run audit, Spider question interface, browser-open alert rules, and appearance preferences | Routes to Risk & stress, Quant, Backtest Lab, AI Trader, and full THE WEB graph rather than duplicating those modules |\n| Portfolio | **Risk & stress** | VaR / expected shortfall, concentration, rate sensitivity, hypothetical shocks, historical crisis replays | Correlations (→ Quant › Correlation lab) |
| Quant | **Quant Lab** | Rolling risk diagnostics, risk universe (MDS / MST / component VaR / ENB), correlation lab, factor exposure, optimization, regime, Monte Carlo, strategy tournament, signal board, earnings event study (SEC 8-K dates × prices) and the spider's graded-hypothesis record | AI Trader overlap (signal board) |
| Quant | **Backtest lab** | Custom rule-based backtests, walk-forward tests, saved runs | — |
| AI Lab | **AI vs S&P 500** | The three paper bots (swing, day trader, quant trader): positions, trades, performance vs the S&P, and the spider's research signals (rules, inputs, sources) | Past earnings reactions (→ Quant) |
| AI Lab | **Claude Predictor** | Claude predictions and free-text questions (behind the Claude password), screener, head-to-head, the prediction log | Saved count + accuracy (→ Prediction accuracy) |
| AI Lab | **Prediction accuracy** | Grading of every saved prediction vs the S&P 500 | — |
| THE WEB | **Command center** | The spider, the stock web (S&P 500 by market cap, holdings lit), research findings with sources, workstation, **Control center** (Research now / Research company, pause, frequency, monitored companies & sectors, live monitor, research timeline, company timelines, backup) (research summary, holdings intel, macro intel, event timeline, technical chart) | Paper-bot values (→ AI Lab), models (→ Quant) |
| THE WEB | **System health** | Data sources, freshness, scheduler, tests, errors | — |

Global (every page): the watchlist sidebar (prices), the ticker tape, the Claude budget chip, the Spider button, and the floating Ask Claude panel (it answers questions about the page you're on).

## What was merged or removed (Nov 2026 cleanup)

| Duplicate | Where it was | Now |
|---|---|---|
| Two different market gauges ("Market mood" fear/greed on Overview, "Market health" on Analysis) built from the same inputs, which could disagree | Overview, Analysis | One scorer. Overview shows a compact view of Analysis's score with a link |
| Watchlist prices | Sidebar, Overview watchlist table, Overview watchlist heatmap, News "Watchlist movers" | Sidebar (prices) + Overview table (multi-period performance). The heatmap was removed. The News sidebar now shows the companies most in the news |
| Sector ETF moves | Overview sector tiles, Analysis sector leadership, Heatmap | Analysis (ranked, explained) and Heatmap (every stock). The Overview tiles were removed |
| Upcoming earnings | Overview, Analysis | Overview |
| "Your portfolio today" | Analysis | Moved to the Overview dashboard (summary → Portfolio) |
| Correlation matrix | Risk & stress, Quant Lab correlation lab | Quant Lab. Risk & stress links to it |
| AI Trader position/mode tiles | Quant Lab command center | AI Lab only. Quant keeps the overlap check in its signal board |
| Portfolio performance chart, economic data, company compare | THE WEB workstation | The owning pages (Portfolio, Macro, Research). The workstation now shows Holdings intel and Macro intel (the spider's findings) with links |
| Ask Claude tab | AI Lab › Claude Predictor | The predictor box takes questions directly. Its quick prompts moved under it |
| Accuracy by stance | Prediction database, Prediction accuracy | Prediction accuracy. The database keeps the count + overall accuracy and a link |
| "Claude used today" counter | Predictor header line | Header budget chip + budget card |
| Old in-page backtester (no longer had a UI) | index.html | Removed. Backtest lab replaced it |
| 10-K crawler page, watchlist "10-K" buttons, filing alerts | THE WEB | Removed at the owner's request. SEC statements stay in Research › Financials / DCF; the server-side 10-K scorecard still feeds the AI trader |
| Market radar | THE WEB canvas | Moved to the Overview dashboard, where market-wide alerts belong. THE WEB's map now fills its canvas: no oval hub, no rotation, no optional view toggles |

## Reader relevance — `public/news-intel.js`

The News reader's **For you** filter uses a standalone, browser-only rules engine (`MDNewsIntel`) that ranks headlines by *direct holdings*, watchlist matches, source coverage, official primary sources and recency. Its rank is a **personal relevance measure, not a market-impact forecast or buy/sell signal**. The reader shows the reasons behind each result.

The For you view collapses likely duplicate headlines published within 36 hours, conservatively requiring high title-token overlap and compatible tickers; it keeps other publishers' names and links attached to the chosen item. All original feed items remain available through the default All filter. There are no new background jobs, paid APIs or storage requirements.

The old `#newss` deep link now normalizes to `#news` even when clicked while another tab is open. Unit tests: `tests/news-intel.test.js` (`npm test`).

## Five random live-data backtests (`quant-batch.js`, `quant-ui.js`)

The Backtest Lab now includes a **Run 5 random backtests** workflow. On the owner's first visit after deployment (not visitor mode), five distinct strategies are chosen randomly from momentum, mean reversion, moving-average trend, RSI, multi-factor, inverse-volatility risk parity, and fixed-weight rebalance. The user can re-run a new random set using the visible button.

**Actual calculations** use `window.MD.hist` and the existing `QUANT.run` implementation. Every experiment uses the same trailing five-year period, $10,000 starting capital, SPY benchmark, 0 bps commission, 5 bps spread, 5 bps slippage, 35% single-position weight cap, 2% minimum cash and a stated 3% cash rate. A missing ticker or incomplete history is an error (never replaced by estimates), and result cards report computed CAGR, total return, Sharpe, drawdown and executed trades. Each successful result enters the standard local Backtest Lab saved-run history and can be inspected for the complete trade and equity history. Compact report data are saved locally and deep inspection recomputes with history if the page was reloaded.

This is **not** historical data embedded into the repository or server-generated performance. On first entry the live browser **actually downloads history and runs the calculations**; until then there are no published performance numbers. On subsequent visits results persist on that browser. Full traceable price data and existing survivorship/no-look-ahead caveats apply. The workflow adds no third-party charges, backend jobs, live trades, or subscriptions.

Tests: `tests/quant-batch.test.js`, run by GitHub Actions with all existing tests.

## Studio layout, example gallery and cross-tab starter UX

The standalone Studio hero is a `div`, **not an HTML `header`**, so the site's sticky, 46px global header rule no longer overrides the Studio title or clips its actions. Scoped responsive styling stacks the title and action rail, wraps navigation where there is room, provides compact settings instead of a large empty block, and adjusts for mobile viewports.

`public/studio-strategies.js` defines **14 executable strategy examples** using existing `QUANT.STRATEGIES` implementations (momentum, relative-strength sector rotation, moving-average trends, short-term mean reversion, RSI, multi-factor, inverse-volatility, fixed rebalancing and buy-and-hold). Their default backtests share the same five-year window, $10,000 starting capital, SPY benchmark, realistic stated trading costs and long-only limits. On the first owner visit to Studio / Strategies, the browser calculates five examples; users can run all 14 or calculate an individual one. Prices come from `window.MD.hist`, and only **actual completed** `QUANT.run` metrics and sampled equity curves are displayed and persisted. Missing prices generate explicit errors. A strategy's **Full report** opens the existing Backtest Lab with that configuration via sessionStorage and re-runs the engine for the complete equity curve and trade record. No real-money orders or paid model calls are made.

`public/empty-examples.js` adds **conditional starter affordances only when content is truly absent**: real filing and DCF tickers, research page tickers, portfolio watch-only ticker suggestions, risk methodology hints and Backtest Lab strategy shortcuts. Empty Studio scenario/research/knowledge-network/Quant/alert panels likewise have guided and clearly labeled examples. No fake quotes, financial statements, user holdings or backtest performance are inserted.

Unit tests: `tests/studio-strategies.test.js` exercises all 14 configurations with explicitly **synthetic test-only** candle fixtures; no such fixture data is ever shown on the live terminal.

## Intelligence Studio (`public/studio-core.js`, `studio.js`, `studio.css`)\n\nThe studio is a **cross-page workbench**. It uses actual in-browser portfolios/quotes and existing owner-protected Spider endpoints, without a new server/paid API. The scenario engine calculates deterministic shocks from marked-to-market holdings *where current quotes are available*, drops missing quotes with an explicit partial-result warning, and never claims to forecast returns. The Technology component applies only when the S&P 500 sector file identifies that stock.\n\nThe Research bridge ranks stored Spider discoveries by ticker match, importance, source presence and age; verified HTTPS source links are shown. The Knowledge network explorer uses the same `/api/web/graph` graph as THE WEB, scoped to a company and with click-to-inspect edge reasons. The Ask Spider page calls `/api/web/ask` with `useClaude:false` always (no paid inference). Quant audit reads locally saved Backtest Lab runs (`md_qb_runs`) and clearly distinguishes in-sample from out-of-sample runs; it does not claim that past performance predicts future results.\n\nSmart alerts: price changes require a recent *exchange* timestamp, not just a recently fetched API response; important new Spider findings require a holding match. Once-per-event deduplication, thresholds and local history are stored in localStorage. They run only while the browser is open and focused; there are **no server-side or push notifications**. Refresh, content and persistence limitations are visible on the page.\n\nTests: `tests/studio-core.test.js`, run by the existing GitHub Actions suite. All additions use free in-browser calculations and the site's existing endpoints.\n\n## Personal data — `public/desk-store.js`

`window.MDDesk` keeps the owner's personal sections (`home`, `dna`, `theses`, `journal`, …) in localStorage and mirrors them to owner-only `/api/desk` (Upstash if configured, else server temp). Export/import from Home. Visitors: in-memory only, no server calls.

## Shared data layer — `public/data.js`

Pages read shared data through `window.MD` instead of keeping their own copies:

- `MD.hist(sym, from, to)`: daily price history. One canonical download per symbol per day (the same even-year window the server caches), sliced locally for each caller. It is kept in memory and in localStorage until midnight. It is used by Quant Lab, Backtest lab, Risk & stress and THE WEB.
- `MD.cached(key, ms, fn)`: a time-limited cache that shares in-flight requests, so two pages asking at once make one request.
- `MD.earnings(syms)`, `MD.macro()`, `MD.discoveries(n)`, `MD.sp500()`: common feeds behind that cache, used by Overview, Analysis, Heatmap, Macro and THE WEB.

## Rules for new features

1. One primary home per dataset, tool and detailed chart.
2. Summaries are fine elsewhere; full duplicates are not. A summary always links to its home (`data-gotab="<tab>"`, optional `data-scroll="<element id>"`).
3. Each AI insight is tailored to the page it sits on. Don't add a second general "market summary".
4. Fetch shared data through `MD`. Don't add a new per-page cache.

## Research engine data flow

News feed (`getNews`, incl. Official) → spider jobs (`web/spider.js`: news_sweep, policy_watch, filings_watch, earnings_release, insiders, …) → discoveries (deduplicated by key, versioned, with sources, fact/interpretation labels, expiry) →
- THE WEB (findings, summary, briefings, graph, control center, timelines)
- News reader (spider research on the story's tickers)
- AI vs S&P (`researchSignals`; the swing bot's ranking nudge via `traderAdjust`, capped by `SPIDER_TRADER_WEIGHT`)
- Quant (hypothesis record) · Research › stock spider report (connected research)

Storage: Upstash Redis free tier when `UPSTASH_REDIS_REST_URL`/`TOKEN` are set, otherwise the server temp folder (wiped by Render on redeploy). `/api/web/export` and `/api/web/import` back it up and restore it.

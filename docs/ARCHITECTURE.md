# Market Desk — information architecture

Every feature has **one home**. Other pages may show a compact summary of it with a link to that home, but never a second full copy. Check this file before adding a feature: if the data or tool already has a home, extend that page or add a summary that links to it.

## Ownership map

| Area (nav) | Page | Owns | Summaries it may show (and where they link) |
|---|---|---|---|
| Markets | **Overview** (dashboard) | Market radar (what is unusual right now: big moves, breaking news, volume, earnings, macro findings), earnings calendar, top gainers/losers/most active, watchlist performance table (1W–1Y, news mood), cross-asset tables (indexes, Treasuries, bond funds, crypto, ETFs, mutual funds, futures), analyst Best Buys/Sells | Market health (→ Analysis), Your portfolio today (→ Portfolio), Latest research findings (→ THE WEB) |
| Markets | **News** | Full news feed, filters, Smart Money, article previews, which companies are most in the news | — |
| Markets | **Heatmap** | Every S&P 500 stock's move, grouped by sector | — |
| Markets | **Analysis** | The market-health score (one scorer: `anScores`), the written market brief, sector leadership, what's driving the market, Claude's market deep dive | Top 6 stories (→ News) |
| Markets | **Macro** | Economic series from FRED (rates, inflation, jobs, growth, recession signals) | — |
| Research | **Stock research** | Quote pages, price charts, company compare | — |
| Research | **Financials / DCF** | SEC statement analysis and valuation | — |
| Portfolio | **My portfolio** | Holdings, allocation, performance chart, price alerts, past-year return / Sharpe / beta summary | → Risk & stress |
| Portfolio | **Risk & stress** | VaR / expected shortfall, concentration, rate sensitivity, hypothetical shocks, historical crisis replays | Correlations (→ Quant › Correlation lab) |
| Quant | **Quant Lab** | Rolling risk diagnostics, risk universe (MDS / MST / component VaR / ENB), correlation lab, factor exposure, optimization, regime, Monte Carlo, strategy tournament, signal board | AI Trader overlap (signal board) |
| Quant | **Backtest lab** | Custom rule-based backtests, walk-forward tests, saved runs | — |
| AI Lab | **AI vs S&P 500** | The three paper bots (swing, day trader, quant trader): positions, trades, performance vs the S&P | — |
| AI Lab | **Claude Predictor** | Claude predictions and free-text questions (behind the Claude password), screener, head-to-head, the prediction log | Saved count + accuracy (→ Prediction accuracy) |
| AI Lab | **Prediction accuracy** | Grading of every saved prediction vs the S&P 500 | — |
| THE WEB | **Command center** | The spider, the stock web (S&P 500 by market cap, holdings lit), research findings with sources, workstation (research summary, holdings intel, macro intel, event timeline, technical chart) | Paper-bot values (→ AI Lab), models (→ Quant) |
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

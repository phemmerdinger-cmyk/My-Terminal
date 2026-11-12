# Market Desk

**Live site:** https://my-terminal-28tq.onrender.com

## About this project

I'm a finance student at Bryant University, and I built this terminal to follow the markets in one place instead of jumping between Yahoo Finance, CNBC and the WSJ. It also gave me a way to practice what I'm learning in class: the **Portfolio** tab doesn't just track gains. It measures a portfolio's **annualized return, volatility, Sharpe ratio, beta against the S&P 500 and maximum drawdown** over the past year, for the whole portfolio and for each holding. It also uses AI (Claude) to explore how AI can support investment research.

Built with Node.js and plain JavaScript (no frameworks), using public Yahoo Finance price data and news RSS feeds, and hosted on Render.

A real, self-hosted website that pulls **live headlines** from Yahoo Finance, CNBC, Morningstar, Seeking Alpha and The Wall Street Journal, along with **live prices**. It also gives you charts, a portfolio tracker, price alerts and **Claude predictions**.

No build step and **no dependencies**. All you need is Node.js 22 or newer.

## What's inside

| Tab | What it does |
|---|---|
| **News** | One live feed from Yahoo Finance, CNBC, Morningstar, Seeking Alpha and the WSJ. Sources dropdown (with "Only" buttons), timeline from Today to All time, positive/negative tags, ticker labels, search. |
| **Markets** | Market mood gauge, upcoming earnings, top gainers/losers/most active, watchlist heatmap and table, sectors, indexes, Treasury yields, bond funds, crypto, ETFs, mutual funds, futures and currencies. |
| **Research** | A Yahoo Finance-style page for any stock, ETF, fund, crypto, index or future: interactive chart first, then Summary, Statistics, Financials, Analysis, Holders, Holdings, Performance, Profile, News and Compare. |
| **Portfolio** | Multiple named portfolios (right-click a name to rename or delete), add holdings by dollar amount, live gains, allocation by sector, price alerts, and a **Risk & performance** panel (1-year return vs. the S&P 500, annualized volatility, Sharpe ratio, beta, max drawdown, best/worst day, plus the same for each holding). |
| **Financials** (Research) | Up to six years of income statement, balance sheet, cash flow and ratios from SEC 10-K filings (EDGAR XBRL), with a side-by-side company comparison. |
| **DCF valuation** (Research) | Five-year unlevered free cash flow model with bull/base/bear cases, CAPM WACC, terminal value, enterprise-to-equity bridge and a WACC × growth sensitivity table; every input labeled by source. |
| **Risk & stress** (Portfolio) | VaR / expected shortfall, correlations, concentration, rate sensitivity, beta-scaled shocks and 2008 / 2020 / 2022 replays. |
| **Macro** (Markets) | Fed funds, CPI, unemployment, GDP, Treasury yields and curves, sentiment and recession signals (FRED, with Treasury/BLS/NY Fed/UMich/NBER fallbacks). |
| **AI vs. S&P 500** (AI Lab) | A rules-based $10,000 paper-trading bot (no API cost) racing the index, with trade analytics and test runs. |
| **Prediction accuracy** (AI Lab) | Grades saved Claude predictions with non-overlapping outcome bands, calibration and sample sizes. |
| **🕸 THE WEB** | An autonomous research Spider that runs on the server (no open tab needed): it researches your holdings, watchlist and the broader market on a schedule, remembers what it finds, writes a daily briefing (pre-market, intraday, after-market), shows a live activity feed, a discovery feed, a brain-style intelligence network and an "Ask the Spider" chat with citations, and shares research with AI Trader. Rules-based and free. |
| **✦ Claude Predictor** | Predictions with 2-week and 6-month targets, risk level and a projection chart; AI Screener that ranks a whole list; Head-to-head comparisons; a prediction database graded after 2 weeks; Ask Claude. |

**Ask Claude** is on every page and sees what you're looking at. **☁ Sync** keeps portfolios, watchlist, alerts and predictions the same on every device. Press **⌘K** (or **/**) anywhere to search. Install it on your phone with "Add to Home Screen".

## Run it on your computer

```bash
cd stock-hub
node server.js
```
Open http://localhost:3000

To turn on Claude predictions, get an API key at https://console.anthropic.com, then:
```bash
ANTHROPIC_API_KEY=sk-ant-... node server.js
```
(On Windows PowerShell: `$env:ANTHROPIC_API_KEY="sk-ant-..."; node server.js`)

You can also paste a key into the Predictions tab. It's stored only in your browser and sent only to your own server.

## Turn on real-time streaming prices (free)

Without this, prices refresh every 15 seconds from Yahoo Finance. With it, prices change with every trade.

1. Get a free API key at https://finnhub.io (sign up, then copy the key from your dashboard).
2. Start the server with it (needs **Node 22 or newer**):
   ```bash
   FINNHUB_API_KEY=your_key ANTHROPIC_API_KEY=sk-ant-... node server.js
   ```
3. The status in the top bar changes to **STREAMING · real-time**.

Finnhub's free tier streams up to 30 stocks at once (your watchlist and holdings come first). Indexes, futures and crypto in the ticker tape still refresh every 15 seconds.

## Put it on the internet (free)

**Render** (easiest):
1. Push this folder to a new GitHub repo.
2. On https://render.com choose **New → Blueprint** and pick the repo. It reads `render.yaml`.
3. Add `ANTHROPIC_API_KEY` and `FINNHUB_API_KEY` when it asks. You'll get a link like `https://my-terminal.onrender.com`.

Railway, Fly.io or any VPS also work (there's a `Dockerfile`). Free tiers may sleep when idle, so the first visit can take a few seconds.

> **Note:** if you set `ANTHROPIC_API_KEY` on a public server, anyone with the link can run predictions on your key. Keep the URL private. Each prediction is cached for 30 minutes to limit cost.

## Private site + public demo
The real site is private: opening `…onrender.com/` shows a sign-in page, and only the site password unlocks it (the browser then stays signed in for 180 days; **Sign out** in the header ends it). Every private API (sync, Claude, the bot's restore) is blocked on the server without that sign-in.

Recruiters and visitors use the public demo at `…onrender.com/demo`: live market data, news, the heatmap, the AI vs. S&P experiment and a sample portfolio, with none of the owner's data and no Claude. Old `?visitor` links redirect there.

Set `SITE_PASSWORD` (and optionally `CLAUDE_PASSWORD`) in Render's Environment settings to replace the built-in passwords. Claude is **off by default** so the site costs $0; set `CLAUDE_DAILY_LIMIT` (for example 20) to turn it on.

Run the checks with `npm test`.

## Quant Trader (third paper bot)

**AI Lab → AI vs S&P 500 → 📐 Quant trader** is a systematic paper-trading bot built on the Quant Lab's math (`quant-trader.js`,
tested in `tests/quanttrader.test.js`). Once per trading day after the close it reads the market regime (S&P trend,
50/200-day cross, realized volatility, drawdown, HYG/IEF credit), which sets the equity share (100 / 70 / 40 / 10%);
ranks 38 liquid stocks and sector ETFs on 12-1 month momentum, 3-month momentum and low volatility; buys the top 8 above
their 200-day average; sizes them by risk parity (≤ 20% each) with a risk-parity defensive sleeve (IEF, TLT, GLD);
scales the book to a 15% volatility target with the rest in T-bills (BIL); and trades only changes above 1.5% at the
daily close, paying 5 bps per side. Starts with $10,000. Paper money only.

## The Spider button

The **🕷 Spider** button in the top bar sends THE WEB's spider onto whatever page you're on. It enters from the middle of the
left edge, scrolls through every section at 2× speed, inspects each one and records the figures it reads, starts the
matching server research job, then opens a report: takeaways (positive vs negative figures, biggest moves, most-mentioned
tickers, any STALE/ERROR flags), THE WEB's market context and stored research on those tickers, and a section-by-section
list of what it collected. Rule-based, no paid AI. Outside a scan the spider stays on THE WEB page.

## Quant › Quant Lab (fully automatic)

Open **Quant → Quant Lab** and there is nothing to fill in: the engine loads your active portfolio (or a labelled sample
portfolio if it's empty), pulls ~4 years of free daily adjusted closes through `/api/pub/hist`, and runs nine modules:

1. **Command center** — value, 1-year return, volatility, Sharpe, Sortino, max drawdown, beta, 1-day VaR/ES (95%, historical), regime, simulation status, data freshness, AI Trader paper status.
2. **3D portfolio risk universe** — classical MDS of the correlation matrix (distance √(2(1−ρ))); size = weight, color = volatility / return / risk share / Sharpe / beta; drag, zoom, hover, click, sector filter, risk-vs-return 2D view. Clicking a holding shows THE WEB's findings, SEC EDGAR fundamentals and links to DCF / Financials.
3. **Strategy tournament & replay** — six strategies auto-selected for the portfolio, ranked on the last 30% of the window with a flag when early leaders fade; a momentum parameter-tuning check with true out-of-sample scoring; a replay timeline with trade markers.
4. **Monte Carlo** — 5,000 seeded GBM paths in a Web Worker (`qmc-worker.js`); CAPM expected return, realized volatility; percentile fan, terminal histogram, probability of ending below today's value.
5. **Factor exposure** — OLS on ETF long-short proxies (market, size, value, momentum, quality, low-vol) with t-stats, R², alpha and rolling 6-month betas.
6. **Correlation lab** — clustered heatmap, click a pair for rolling 63-day correlation, diversification ratio, effective holdings.
7. **Optimization** — minimum variance, maximum Sharpe, risk parity, equal weight; efficient frontier; long-only bounds; turnover and cost; a split-half stability flag. Research output only — nothing is rebalanced.
8. **Market regime** — transparent rules on SPY trend, 50/200-day cross, realized volatility, drawdown and HYG/IEF credit; weekly timeline.
9. **Quant research assistant** — a rule-based analyst over the computed numbers (no paid AI); every statement is tagged *Calculated* or *Interpretation*, plus an in-browser self-check.

Each module shows a status chip (ONLINE / CALCULATING / STALE / UNAVAILABLE / ERROR) driven by real conditions (data age, missing
history, too few holdings, errors). The math lives in `public/qmath.js` and is covered by `tests/qmath.test.js`.

## Quant › Backtest lab
- **Strategies:** buy-and-hold, fixed-weight rebalancing, momentum, mean reversion, moving-average crossover, RSI, multi-factor (momentum + low volatility + trend), risk parity (inverse volatility), and custom rules (`rsi(14) < 30 and price > sma(200)`).
- **Realism:** signals use data through each day's close and trade at the next day's close (no look-ahead); dividend- and split-adjusted prices; the benchmark's real trading calendar; commission, half the bid-ask spread and slippage on every trade; max position size and minimum cash; cash earns the risk-free rate (default = today's 13-week T-bill yield). Survivorship bias and other data limits are listed on every result.
- **Metrics:** CAGR, volatility, Sharpe, Sortino, max drawdown, Calmar, alpha, beta, information ratio, 1-day VaR and expected shortfall (95%), win rate, profit factor, average win/loss, turnover, total costs; equity and drawdown charts, monthly-return heatmap, full trade history.
- **Overfitting controls:** optimize on the first 70% and test once on the unseen 30%; walk-forward (re-tune each year on the previous 3, chain only out-of-sample years); parameter-sensitivity heatmap (descriptive only).
- **Backtested vs. paper-traded vs. market-observed** results are labeled and shown separately. All math runs in the browser (`public/quant.js`), so it costs nothing on the server.

## Data integrity and system health
- **Data Integrity Engine** (`data/integrity.js`): every company's SEC figures are checked on the Financials and DCF pages — Assets = Liabilities + Equity, liabilities + equity components, operating + investing + financing cash flow = change in cash, gross profit and EPS consistency, sign checks, an independent re-computation of the ratios the site shows, fiscal-period and filing identification, currency, recency, merged duplicate periods, restatements (from the SEC's own filing history) and revisions (changes since the last time the site checked).
- **Data Confidence Score (0–100):** `100 × (0.35·completeness + 0.25·recency + 0.25·consistency + 0.15·source quality)`. A data-quality diagnostic, not a probability that a number is correct.
- **Quotes** are classified current / delayed / stale / unavailable (header indicator), with an optional cross-check against Finnhub.
- **System Health page** (THE WEB → System health): every data source's success rate and last error (keys and tokens removed), data freshness, the research scheduler, both paper-trading bots, and the latest GitHub Actions test runs. A pass is only shown for a run that actually happened.
- **Automated tests** run on every push via `.github/workflows/tests.yml` (free for public repos).

## THE WEB — how the Spider works
- **Where it runs:** inside `server.js` on a 15-second scheduler (`web/spider.js`). It reads the site's own data services directly (news feeds, quotes, S&P 500 snapshot, FRED macro, SEC EDGAR filings/8-Ks/Form 4s/XBRL, Finnhub's free earnings calendar, the Fed/SEC/Treasury/BLS feeds) — it never crawls this site's pages.
- **What it decides:** a priority engine scores every job on portfolio relevance, market impact, freshness, source reliability, price move, upcoming catalysts, research gaps, existing coverage and AI Trader relevance, and re-ranks the queue every tick. Findings queue follow-ups (an 8-K → read the earnings release; a 6% move → look for the catalyst; several peers moving together → a sector pattern).
- **Limits:** one job at a time, a hard time limit per job, at most 2 retries, 80 jobs an hour, a 60-job queue, follow-up chains at most 2 deep. SEC requests go through the existing polite queue.
- **Memory:** discoveries are deduplicated by key, versioned when they change, linked to related findings and expire by category. Directional findings (an EPS beat, an insider buying cluster) record a hypothesis that is graded against the S&P 500 a week or two later — that grading is the only feedback loop; nothing else "learns".
- **Honesty rules:** every fact has a source and time; interpretations, estimates and speculation are labeled; briefings say when prices are delayed, from the last close, or unavailable.
- **AI Trader:** the swing bot gets a small research nudge (at most ±`SPIDER_TRADER_WEIGHT`, default 0.05, on a ~0–1 score) built only from inputs it doesn't already score — insider buying, earnings-release tone/guidance and sector news patterns. The Claude Predictor and Ask Claude also see the Spider's stored research. **The Spider never places or modifies trades.**
- **Free hosting:** Render's free plan sleeps when idle; the existing GitHub Actions ping keeps it awake about 7 AM–11 PM ET, which covers all three briefings. Overnight the Spider pauses and catches up when the server wakes. For research memory to survive redeploys and sleeps, set the free Upstash variables below (otherwise it lives in the server's temp folder).

## Settings
- `PORT`: default 3000
- `ANTHROPIC_API_KEY`: turns on predictions and Ask Claude
- `FINNHUB_API_KEY`: turns on real-time streaming prices
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`: free Upstash Redis database so device sync is permanent (otherwise synced data lives on the server and is wiped when it redeploys)
- `SITE_PASSWORD`: replaces the built-in site password
- `CLAUDE_DAILY_LIMIT`: Claude requests allowed per day (default 0 = off, so the site costs $0)
- `SEC_USER_AGENT`: contact sent to the SEC with each request (their fair-access rules require one)
- `SPIDER_TRADER_WEIGHT`: how much THE WEB's research can move the swing bot's ranking score (default 0.05, max 0.15; 0 = display only)
- `SPIDER_OFF`: set to anything to turn THE WEB off
- `CLAUDE_MODEL`: default `claude-sonnet-5-5` (set to `claude-opus-5-5` for deeper analysis)

## How the data works
- **News:** the server reads each outlet's public RSS feeds. If a feed is down, it falls back to Google News results for that site. Stock-specific news comes from Yahoo and Seeking Alpha ticker feeds, plus Google News results for CNBC, Morningstar and WSJ.
- **Prices and charts:** Yahoo Finance's public chart data (may be delayed).
- Your watchlist, holdings and alerts are saved in your browser.
- Some WSJ and Morningstar articles need a subscription to read.

Not financial advice. Claude's predictions are AI opinions and can be wrong.

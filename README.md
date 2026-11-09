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

## View-only for visitors
Anyone who opens the link sees the site in **view-only** mode: they can browse news, markets, research, the heatmap and a sample portfolio with its risk analysis, but the Claude tab, Ask Claude, the Claude switch, Sync, and all portfolio/watchlist editing are hidden and turned off. Claude requests are also blocked on the server without the password.

To use the full site on your own device, open it once as `…onrender.com/?owner` and enter the Claude password. That device stays unlocked. Open `?viewer` to switch a device back to view-only.

## Settings
- `PORT`: default 3000
- `ANTHROPIC_API_KEY`: turns on predictions and Ask Claude
- `FINNHUB_API_KEY`: turns on real-time streaming prices
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`: free Upstash Redis database so device sync is permanent (otherwise synced data lives on the server and is wiped when it redeploys)
- `CLAUDE_MODEL`: default `claude-sonnet-5-5` (set to `claude-opus-5-5` for deeper analysis)

## How the data works
- **News:** the server reads each outlet's public RSS feeds. If a feed is down, it falls back to Google News results for that site. Stock-specific news comes from Yahoo and Seeking Alpha ticker feeds, plus Google News results for CNBC, Morningstar and WSJ.
- **Prices and charts:** Yahoo Finance's public chart data (may be delayed).
- Your watchlist, holdings and alerts are saved in your browser.
- Some WSJ and Morningstar articles need a subscription to read.

Not financial advice. Claude's predictions are AI opinions and can be wrong.

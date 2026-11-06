# Peter's Finance Terminal

A real, self-hosted website that pulls **live headlines** from Yahoo Finance, CNBC, Morningstar, Seeking Alpha and The Wall Street Journal, along with **live prices**. It also gives you charts, a portfolio tracker, price alerts and **Claude predictions**.

No database, no build step and **no dependencies**. All you need is Node.js 18 or newer.

## What's inside

| Tab | What it does |
|---|---|
| **News** | One live feed from all 5 outlets. Refreshes every 60s and flags new stories. Each headline is tagged positive or negative and labeled with your tickers. Filter by source, ticker or keyword. Optional desktop alerts. |
| **Markets** | Watchlist heatmap and table, S&P sectors, indexes, Treasury yields, bond funds, crypto, popular ETFs, mutual funds, futures and currencies. |
| **Research** | A Yahoo Finance-style page for any stock, ETF, mutual fund, crypto, index or future: Summary, Statistics, Financials (income statement, balance sheet, cash flow, annual and quarterly), Analysis, Holders, Holdings, Performance, Profile and News. |
| **Charts** | Interactive candlestick or line charts with volume for any ticker (1D → 5Y), plus period stats and 1-month mini charts for your whole watchlist. |
| **Portfolio** | Enter your holdings to see live value, today's P/L, total P/L and allocation. Set price alerts ("TSLA rises above 300"). |
| **✦ Claude Predictions** | Search any stock for Claude's outlook: stance, confidence, 1–2 week and 3–6 month ranges, bull and bear case, and catalysts. Includes a whole-market outlook and an **Ask Claude** box that knows your watchlist and portfolio. |

Press **⌘K** (or **/**) anywhere to jump to any stock.

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

## Settings
- `PORT`: default 3000
- `ANTHROPIC_API_KEY`: turns on predictions and Ask Claude
- `FINNHUB_API_KEY`: turns on real-time streaming prices
- `CLAUDE_MODEL`: default `claude-sonnet-5-5` (set to `claude-opus-5-5` for deeper analysis)

## How the data works
- **News:** the server reads each outlet's public RSS feeds. If a feed is down, it falls back to Google News results for that site. Stock-specific news comes from Yahoo and Seeking Alpha ticker feeds, plus Google News results for CNBC, Morningstar and WSJ.
- **Prices and charts:** Yahoo Finance's public chart data (may be delayed).
- Your watchlist, holdings and alerts are saved in your browser.
- Some WSJ and Morningstar articles need a subscription to read.

Not financial advice. Claude's predictions are AI opinions and can be wrong.

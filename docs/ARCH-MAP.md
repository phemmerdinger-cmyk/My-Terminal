# Architecture map (concise)

**Runtime:** single Node 22 process (`server.js`, no deps) on Render free tier; serves `public/` statically (gzip+etag) and JSON APIs. Tests in `tests/` (node:test), CI in `.github/workflows/tests.yml`; `keep-warm.yml` pings ~7AM–11PM ET.

## Server (`server.js`)
| Area | Where |
|---|---|
| Deploy mode | `deploy-mode-core.js` → `DEPLOY` (MODE unset / `public` / `local`); `DM.access()` decides serve / proxy / 404 for each `/api/*`; `proxyToPublic()` forwards bot, sync and desk routes in local mode |
| Auth | `isOwner(req)` (scrypt cookie `md_owner`), `PUBLIC_API` set ≈ line 821; `handle()` ≈ 3011 rejects non-public `/api/*` for visitors |
| Quotes / history / news / earnings / financials | `/api/quotes`, `/api/history`, `/api/pub/hist`, `/api/news` (6 sources + Official incl. SEC 8-Ks), `/api/earnings`, `/api/financials` |
| Claude | budgeted, password-gated (`/api/predict`, ask); `x-api-cost` header → client budget chip |
| Sync | `/api/sync?code=` (Upstash or temp dir) — client `SYNC_KEYS` in index.html |
| THE WEB / Spider | `webRoute` → `/api/web/*` (status, discoveries, briefings, graph, timeline, control, export/import, ask) backed by `web/spider.js` + `web/store.js` (`createStore`: Upstash if `UPSTASH_REDIS_REST_URL/TOKEN`, else tmp) |
| Desk (new, Phase 1) | `/api/desk` owner-only doc store for personal data (layouts, DNA, theses, journal…) via `createStore` prefix `pft:desk:v1:` |
| Toughness test | `robustness-core.js` (replay, ±20% settings, 2× costs, later-period, Monte Carlo, live-record gate); weekly in `strategy-lab.js` (`s.robust`, pauses failing lab bots) and `qtPlan` (`QT.robust`, info only) |
| Strategy Lab extra bots | `extra-bots-core.js` (pullback, sector rotation, earnings drift, insider buying rules) + `extra-bots-runner.js` (books, open fills), wired in `strategy-lab.js`; server passes `events` (Finnhub EPS surprises, spider insider findings) |
| Multi-asset data | `public/instruments-core.js` (schema, classes, futures specs, formatting, market status, tick/multiplier), `market-data-core.js` (Yahoo gate, Coinbase/Binance.US/Frankfurter/FRED parsers, options chain); server `quote()` fallbacks, `instrumentView` `/api/instrument`, `/api/options`, Coinbase WebSocket (`cb*`) |
| Thesis tracker | `thesis-core.js` (swing bot: reasons recorded at each buy, sell when most are gone); sizing `RISK.volSize` in `risk-core.js` |
| Bot teamwork | `bot-teamwork-core.js` (pre-buy check, regime confirmation, post-mortems, earnings warning, defense decision, twin compare, morning brief); spider `marketStress`/`researchedAt`/`overnight`; `/api/why`, `/api/brief` (desk routes) |
| Paper bots | `putcall-core.js` (Zweig contrarian put/call, `/api/pub/putcall`), `daytrade-core.js` (setups), `daytrade-brain.js` (day trader's self-learning forecast + sizing), `quant-trader.js`, autopilot in server.js |

## Client (`public/`)
| File | Role |
|---|---|
| `my-trader-core.js` / `public/my-trader.js` | My Trader: the owner's hand-traded $30,000 paper account (server `mtView`/`mtOrder`/`mtTick`, `/api/mytrader*`), shown on Bots vs S&P 500 and ranked on the leaderboard |
| `coach-core.js` | Coach agent rules: chart read, trade-journal review, −20% stress + hedge. Server `/api/coach` (coachView in server.js); Bot HQ Coach desk; Research → Why chart-read card (teamwork.js) |
| `hq.html` / `hq.js` / `hq-core.js` | Bot HQ, a separate site: desk port 3001 or `MODE=hq` service (`handleHq` in server.js); overview, every bot in depth, agent room, spider, risk & costs |
| `teamwork.js` | Morning brief pop-up (once a day + ☀ top-bar button) + Research "Why (bots)" card; lazy group `team` |
| `lazy-core.js` | `MDLazyCore.GROUPS` (quant / studio / web / team script lists) + `createLoader`; `window.MDLazy` in index.html loads a group when `setTab` opens a tool |
| `index.html` | Shell, all legacy pages inline. `NAV`/`TABS`/`setTab()` ≈ 1935–2105. Global state `S` (S.pfs portfolios, S.pfActive, S.wl, S.quotes, S.news, S.earn). `store` = localStorage (no-op for visitors). Helpers `api()`, `$`, `esc`, `fmt`, `pct`, `put()`. `riskStats()`, `pfcCombine()` portfolio math |
| `data.js` | `window.MD`: `hist`, `histDays`, `cached`, `earnings`, `macro`, `discoveries`, `sp500` |
| `fin.js`, `qmath.js` | finance formulas (FIN.*), quant math |
| `quant*.js`, `quant-lab.js` | Backtest lab (`QUANT.run`, saved runs `md_qb_runs`), Quant Lab (incl. a tournament) |
| `studio*.js` | Intelligence Studio: scenarios, research bridge, browser alerts (`md_studio_alerts_v1`) |
| `web*.js` | THE WEB page + moving Spider; `web-control.js` control center |
| `news-intel.js`, `reader.js` | For-you relevance ranking, in-site reader |
| `desk-store.js` (new) | `window.MDDesk` personal data store: localStorage + owner server copy + export/import |
| `home-core.js` / `home.js` / `home.css` (new) | Home (Phase 1) |
| `orange-theme.css` | Global military-green theme, loaded last |

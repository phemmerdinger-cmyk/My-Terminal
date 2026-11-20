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
| Paper bots | `putcall-core.js` (Zweig contrarian put/call, `/api/pub/putcall`), `daytrade-core.js` (setups), `daytrade-brain.js` (day trader's self-learning forecast + sizing), `quant-trader.js`, autopilot in server.js |

## Client (`public/`)
| File | Role |
|---|---|
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

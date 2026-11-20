@AGENTS.md

# Market Desk — notes for Claude

Read `IMPLEMENTATION_PROGRESS.md` first (what's done, what's next), then `docs/ARCH-MAP.md` (where things live). Read `docs/ARCHITECTURE.md` only for the feature-ownership rules of the page you're touching.

## Commands
- `npm test` — node:test suite (`tests/*.test.js`), no network needed. Must pass before every commit.
- `node server.js` — local server on :3000 (`SITE_PASSWORD=x` to set the owner password).
- No build step, no npm dependencies. Plain JS + one CDN script (lightweight-charts).

## Hard rules
- $0: no paid APIs/services. Claude API calls only behind the existing password + budget, never automatic.
- Owner vs visitor: every `/api/*` route is owner-only unless listed in `PUBLIC_API` (server.js). Visitor (`/demo`) = `html.viewonly`, `window.__VISITOR`, `store.set` is a no-op. Never rely on hidden UI for access control.
- Never fabricate data. Missing quote/history → show "unavailable", don't estimate. Label hypothetical vs realized vs benchmark returns.
- Colors: black/graphite/orange (`--orange:#ff991f` is the accent), gains `--up`, losses `--down`. No blue/cyan/purple/olive-green decoration; categorical chart palettes may use other hues. `public/orange-theme.css` loads last.
- One home per feature (docs/ARCHITECTURE.md). Reuse `window.MD` (data.js) for shared fetches/caching; `window.MDDesk` (desk-store.js) for new personal data.
- Pure logic goes in UMD `*-core.js` files with node tests; UI files stay thin.
- Targeted edits; don't rewrite `public/index.html` (5.4k lines) or `server.js` (4.3k lines).

## Workflow
Small phase → test → update `IMPLEMENTATION_PROGRESS.md` → commit on the feature branch.

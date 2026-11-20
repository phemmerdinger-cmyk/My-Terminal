# Shared coding instructions — My-Terminal

## Project
Market Desk is a Node.js 22+ finance terminal deployed to Render. The server entry point is `server.js`; the browser UI uses plain JavaScript and files under `public/`. There is no frontend build step and no npm dependencies. Read `IMPLEMENTATION_PROGRESS.md`, `docs/ARCH-MAP.md`, and the relevant section of `docs/ARCHITECTURE.md` before changing a feature.

## Commands
- `node server.js` or `npm start`: run locally (normally http://localhost:3000).
- `npm test`: run the offline Node built-in test suite (`tests/*.test.js`).
- No build command.

## Conventions and safeguards
- Make small, targeted changes; avoid wholesale rewrites of `server.js` or `public/index.html`.
- Put testable pure logic in `*-core.js` modules and add corresponding Node tests; keep UI code focused on presentation.
- Reuse existing shared data/caching interfaces (`window.MD` and `window.MDDesk`) and follow documented feature ownership.
- Maintain the black/graphite/orange theme (`--orange:#ff991f` is the accent). Keep gains/losses semantic (green/red).
- Never fabricate market prices, historical performance, backtest results, or financial data. Distinguish simulated, hypothetical, and realized returns.
- Preserve server-side owner/visitor authorization. Public demo access is not permission to expose private APIs or user data.
- Avoid introducing paid services or automatic paid AI calls. Keep credentials server-side and out of commits. Subscription-based CLI login does **not** authorize using Claude or OpenAI APIs inside the deployed website.
- Run `npm test` before committing and update `IMPLEMENTATION_PROGRESS.md` for completed phases.

## Claude Code and Codex
Both assistants must follow this file. Claude Code loads it via `CLAUDE.md` (`@AGENTS.md`). Coordinate on the same working tree; review diffs and tests before accepting delegated changes.

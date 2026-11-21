"use strict";
// Deploy modes: one codebase, two ways to run it.
//   MODE unset  — legacy: one server with the owner sign-in page and the public /demo (unchanged behavior).
//   MODE=public — the internet-facing server (Render). Only the demo. No sign-in page, no Claude, and
//                 owner-only routes do not exist (404). It still runs the paper bots and THE WEB, and it
//                 answers the owner's bot/data routes only for requests carrying DESK_TOKEN.
//   MODE=local  — the owner's desk on their own computer. Listens on 127.0.0.1 only, so no password is
//                 needed. Does not run the bots (the public server does); their routes and the owner's
//                 saved data are forwarded to PUBLIC_URL with DESK_TOKEN. It also serves Bot HQ as a separate
//                 site on HQ_PORT (default 3001), 127.0.0.1 only.
//   MODE=hq     — Bot HQ as its own website (e.g. a second Render service): only the bot control room and its
//                 read-only bot routes, behind the owner password (SITE_PASSWORD). Runs no bots; it reads them
//                 from PUBLIC_URL with DESK_TOKEN, like the desk.
const crypto = require("crypto");

const MODES = Object.freeze(["", "public", "local", "hq"]);
const MIN_TOKEN = 32;

// Routes whose state lives on the server that runs the bots: paper bots, desk risk, strategy lab,
// THE WEB, system health (reports on the bots), device sync and the owner's desk store.
const REMOTE_EXACT = new Set([
  "/api/autopilot", "/api/autopilot/restore", "/api/daytrader", "/api/daytrader/restore",
  "/api/quanttrader", "/api/quanttrader/run", "/api/why", "/api/brief", "/api/desk-risk", "/api/desk-risk/review",
  "/api/strategy-lab", "/api/strategy-lab/borrow", "/api/day-volume", "/api/system/health",
  "/api/pub/botslive", "/api/pub/archive", "/api/pub/leaderboard", "/api/pub/putcall", "/api/pub/strategies",
  "/api/sync", "/api/desk",
]);
const REMOTE_PREFIX = ["/api/web/"];
const isRemoteRoute = (p) => REMOTE_EXACT.has(p) || REMOTE_PREFIX.some((x) => String(p).startsWith(x));

function parseMode(env = {}) {
  const mode = String(env.MODE || "").trim().toLowerCase();
  if (!MODES.includes(mode)) throw new Error(`MODE must be "public", "local", "hq" or unset (got "${env.MODE}")`);
  const token = String(env.DESK_TOKEN || "");
  if (token && token.length < MIN_TOKEN) throw new Error(`DESK_TOKEN must be at least ${MIN_TOKEN} characters`);
  let publicUrl = String(env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (publicUrl) {
    let u; try { u = new URL(publicUrl); } catch { throw new Error("PUBLIC_URL must be a full URL, e.g. https://my-terminal.onrender.com"); }
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("PUBLIC_URL must use https");
    publicUrl = u.origin;
  }
  return Object.freeze({
    mode, token, publicUrl,
    runJobs: mode !== "local" && mode !== "hq", // only one server may trade the paper books and write their state
    host: mode === "local" ? "127.0.0.1" : undefined,
    remoteReady: (mode === "local" || mode === "hq") && !!publicUrl && !!token,
    hqPort: mode === "local" ? Number(env.HQ_PORT || 3001) || null : null,
  });
}

// Constant-time check of the x-desk-token header. False when no token is configured.
function tokenOk(header, token) {
  if (!token || typeof header !== "string" || !header) return false;
  const h = (s) => crypto.createHash("sha256").update(s).digest();
  return crypto.timingSafeEqual(h(header), h(token));
}

// What the server should do with an /api/ request: "serve", "proxy", "deny" (401) or "notfound" (404).
function access({ mode, path, owner = false, isPublic = false, token = false }) {
  if (mode === "local") return isRemoteRoute(path) ? "proxy" : "serve";
  if (mode === "public") {
    if (path === "/api/login") return "notfound"; // there is no sign-in on the public server
    if (isPublic) return "serve";
    return token && isRemoteRoute(path) ? "serve" : "notfound";
  }
  return owner || isPublic ? "serve" : "deny";
}

// Where a page request goes in each mode; null = serve normally.
function pageRedirect(mode, pathname) {
  if (mode === "public") {
    if (pathname === "/ai-vs-sp500") return "/demo#aitrade";
    if (["/", "/index.html", "/login", "/logout", "/hq", "/hq/"].includes(pathname)) return "/demo";
  }
  if (mode === "local" && (pathname === "/login" || pathname === "/logout")) return "/";
  return null;
}

// The visitor's IP for rate limits and password lockouts. Render sits behind Cloudflare, which sets
// True-Client-IP / CF-Connecting-IP itself; X-Forwarded-For is only appended to by Render, so its first
// entry is whatever the client sent and must not be trusted. Without those headers, use the socket address.
function clientIp(headers = {}, remote = "") {
  for (const h of ["true-client-ip", "cf-connecting-ip"]) {
    const v = String(headers[h] || "").trim();
    if (v && v.length <= 64 && /^[0-9a-f:.]+$/i.test(v)) return v;
  }
  return String(remote || "?");
}

// ---- Bot HQ, the separate control-room site (MODE=hq, or the desk's second port)
// Read-only bot and spider routes the control room uses; everything else on that site doesn't exist.
const HQ_API = new Set(["/api/autopilot", "/api/daytrader", "/api/quanttrader", "/api/strategy-lab", "/api/desk-risk", "/api/brief",
  "/api/web/status", "/api/web/signals", "/api/web/discoveries", "/api/system/health"]);
const HQ_FILES = new Set(["/hq.js", "/hq-core.js", "/hq-rules.js", "/hq-favicon.svg"]);
function hqAccess({ path, method = "GET", owner = false, remote = true }) {
  if (path === "/api/login" || path === "/api/health") return "serve";
  if (!HQ_API.has(path) || method !== "GET") return "notfound";
  if (!owner) return "deny";
  return remote ? "proxy" : "serve";
}
// { page } | { file } | { redirect } | { login } | { logout } | null (404)
function hqPage(pathname, owner) {
  if (pathname === "/" || pathname === "/index.html") return owner ? { page: "hq.html" } : { redirect: "/login" };
  if (pathname === "/login") return owner ? { redirect: "/" } : { login: true };
  if (pathname === "/logout") return { logout: true };
  if (HQ_FILES.has(pathname)) return { file: pathname };
  return null;
}

module.exports = { HQ_API, hqAccess, hqPage, MODES, MIN_TOKEN, parseMode, tokenOk, access, pageRedirect, isRemoteRoute, clientIp };

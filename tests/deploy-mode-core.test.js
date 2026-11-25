"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const DM = require("../deploy-mode-core.js");
const TOKEN = "x".repeat(40);

test("parseMode: legacy by default, validates mode, token and URL", () => {
  const legacy = DM.parseMode({});
  assert.equal(legacy.mode, ""); assert.equal(legacy.runJobs, true); assert.equal(legacy.host, undefined);
  assert.throws(() => DM.parseMode({ MODE: "owner" }), /MODE must be/);
  assert.throws(() => DM.parseMode({ MODE: "public", DESK_TOKEN: "short" }), /at least 32/);
  assert.throws(() => DM.parseMode({ MODE: "local", PUBLIC_URL: "http://example.com" }), /https/);
  assert.throws(() => DM.parseMode({ MODE: "local", PUBLIC_URL: "not a url" }), /full URL/);
  const local = DM.parseMode({ MODE: " Local ", PUBLIC_URL: "https://md.onrender.com/", DESK_TOKEN: TOKEN });
  assert.equal(local.mode, "local"); assert.equal(local.publicUrl, "https://md.onrender.com");
  assert.equal(local.runJobs, false); assert.equal(local.host, "127.0.0.1"); assert.equal(local.remoteReady, true);
  assert.equal(DM.parseMode({ MODE: "local" }).remoteReady, false);
  assert.equal(DM.parseMode({ MODE: "local", PUBLIC_URL: "http://localhost:3001" }).publicUrl, "http://localhost:3001");
  assert.equal(DM.parseMode({ MODE: "public" }).runJobs, true);
});

test("tokenOk only accepts the exact configured token", () => {
  assert.equal(DM.tokenOk(TOKEN, TOKEN), true);
  assert.equal(DM.tokenOk(TOKEN + "y", TOKEN), false);
  assert.equal(DM.tokenOk("", TOKEN), false);
  assert.equal(DM.tokenOk(undefined, TOKEN), false);
  assert.equal(DM.tokenOk(TOKEN, ""), false); // no token configured: nothing is accepted
});

test("legacy mode keeps the existing owner/visitor rule", () => {
  assert.equal(DM.access({ mode: "", path: "/api/desk", owner: false }), "deny");
  assert.equal(DM.access({ mode: "", path: "/api/desk", owner: true }), "serve");
  assert.equal(DM.access({ mode: "", path: "/api/news", isPublic: true }), "serve");
  assert.equal(DM.access({ mode: "", path: "/api/login", isPublic: true }), "serve");
});

test("public mode: no sign-in, no Claude, owner routes only with the desk token", () => {
  const a = (path, extra = {}) => DM.access({ mode: "public", path, ...extra });
  assert.equal(a("/api/login", { isPublic: true }), "notfound");
  assert.equal(a("/api/news", { isPublic: true }), "serve");
  assert.equal(a("/api/autopilot", { isPublic: true }), "serve"); // the demo shows the bots
  for (const p of ["/api/predict", "/api/ask", "/api/unlock"]) {
    assert.equal(a(p), "notfound"); assert.equal(a(p, { token: true }), "notfound"); // Claude never runs here
  }
  for (const p of ["/api/sync", "/api/desk", "/api/web/status", "/api/quanttrader/run", "/api/system/health"]) {
    assert.equal(a(p), "notfound");
    assert.equal(a(p, { owner: true }), "notfound"); // a cookie means nothing on the public server
    assert.equal(a(p, { token: true }), "serve");
  }
});

test("local mode serves everything itself except routes whose state lives with the bots", () => {
  const a = (path) => DM.access({ mode: "local", path });
  for (const p of ["/api/news", "/api/predict", "/api/ask", "/api/quotes", "/api/financials"]) assert.equal(a(p), "serve");
  for (const p of ["/api/autopilot", "/api/daytrader/restore", "/api/sync", "/api/desk", "/api/web/briefings", "/api/pub/archive"]) assert.equal(a(p), "proxy");
  assert.equal(a("/api/pub/hist"), "serve"); // plain market data is fetched locally
});

test("page redirects", () => {
  assert.equal(DM.pageRedirect("public", "/"), "/demo");
  assert.equal(DM.pageRedirect("public", "/login"), "/demo");
  assert.equal(DM.pageRedirect("public", "/ai-vs-sp500"), "/demo#aitrade");
  assert.equal(DM.pageRedirect("public", "/demo"), null);
  assert.equal(DM.pageRedirect("local", "/logout"), "/");
  assert.equal(DM.pageRedirect("local", "/"), null);
  assert.equal(DM.pageRedirect("", "/"), null);
});

test("clientIp trusts Cloudflare's headers, never a client-supplied X-Forwarded-For", () => {
  assert.equal(DM.clientIp({ "true-client-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" }, "10.0.0.1"), "203.0.113.7");
  assert.equal(DM.clientIp({ "cf-connecting-ip": "2001:db8::1" }, "10.0.0.1"), "2001:db8::1");
  assert.equal(DM.clientIp({ "x-forwarded-for": "1.2.3.4, 104.22.17.40" }, "10.0.0.1"), "10.0.0.1");
  assert.equal(DM.clientIp({ "true-client-ip": "<script>" }, "10.0.0.1"), "10.0.0.1");
  assert.equal(DM.clientIp({}, undefined), "?");
});

test("the Why card and Morning brief are desk routes, never public", () => {
  const DM2 = require("../deploy-mode-core.js");
  for (const p of ["/api/why", "/api/brief"]) {
    assert.equal(DM2.isRemoteRoute(p), true);
    assert.equal(DM2.access({ mode: "public", path: p, owner: false, token: false, isPublic: false }), "notfound");
    assert.equal(DM2.access({ mode: "local", path: p, owner: false, token: false, isPublic: false }), "proxy");
  }
});

test("Bot HQ is never served by the public demo server", () => {
  const DM3 = require("../deploy-mode-core.js");
  assert.equal(DM3.pageRedirect("public", "/hq"), "/demo");
  assert.equal(DM3.pageRedirect("local", "/hq"), null);
});

test("bot hours: awake Mon–Fri 6 AM – 5 PM New York, asleep otherwise (EST and EDT)", () => {
  const DMX = require("../deploy-mode-core.js"), at = (iso) => DMX.awakeWindow(Date.parse(iso));
  assert.equal(at("2026-11-24T10:59:00Z"), false, "Tue 5:59 AM EST");
  assert.equal(at("2026-11-24T11:00:00Z"), true, "Tue 6:00 AM EST");
  assert.equal(at("2026-11-24T21:59:00Z"), true, "Tue 4:59 PM EST");
  assert.equal(at("2026-11-24T22:00:00Z"), false, "Tue 5:00 PM EST");
  assert.equal(at("2026-07-14T10:00:00Z"), true, "Tue 6:00 AM EDT");
  assert.equal(at("2026-07-14T21:00:00Z"), false, "Tue 5:00 PM EDT");
  assert.equal(at("2026-11-28T15:00:00Z"), false, "Saturday");
});

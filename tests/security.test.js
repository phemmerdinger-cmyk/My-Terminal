// Stage 0 checks: private site, public demo, headers, compression, rate limits, login lockout.
// Runs the real server on a spare port with a test password (SITE_PASSWORD) — no network needed.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const PORT = 3990 + Math.floor(Math.random() * 9), BASE = `http://127.0.0.1:${PORT}`;
let srv;
before(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(PORT), SITE_PASSWORD: "test-site-password-123", FINNHUB_API_KEY: "", ANTHROPIC_API_KEY: "" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/api/health"); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error("server did not start");
});
after(() => srv && srv.kill());
const get = (p, h = {}) => fetch(BASE + p, { redirect: "manual", headers: h });
const login = (pw) => fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0." + Math.floor(Math.random() * 200) }, body: JSON.stringify({ password: pw }) });

test("the real site needs a login", async () => {
  for (const p of ["/", "/index.html", "/?owner"]) { const r = await get(p); assert.equal(r.status, 302, p); assert.equal(r.headers.get("location"), "/login"); }
  assert.equal((await get("/ai-vs-sp500")).headers.get("location"), "/demo#aitrade");
});
test("old visitor links go to the public demo", async () => {
  const r = await get("/?visitor"); assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/demo");
});
test("the demo is public, compressed and sends security headers", async () => {
  const r = await get("/demo", { "accept-encoding": "gzip" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("content-encoding"), "gzip");
  assert.match(await r.text(), /Market Desk|MARKET/i);
});
test("private APIs are blocked for visitors, public data APIs are open", async () => {
  for (const p of ["/api/sync?code=abcdefghijkl", "/api/autopilot/restore", "/api/unlock", "/api/ask", "/api/predict?symbol=AAPL", "/api/web/status", "/api/web/discoveries", "/api/web/briefing?id=latest", "/api/web/research?symbol=AAPL", "/api/web/graph"]) {
    const r = await get(p); assert.equal(r.status, 401, p); assert.equal((await r.json()).code, "private");
  }
  assert.equal((await get("/api/health")).status, 200);
});
test("wrong password fails, right password unlocks the site and private APIs", async () => {
  assert.equal((await login("nope")).status, 401);
  const r = await login("test-site-password-123"); assert.equal(r.status, 200);
  const ck = r.headers.get("set-cookie"); assert.match(ck, /md_owner=[0-9a-f]{64}; .*HttpOnly; Secure; SameSite=Lax/);
  const cookie = ck.split(";")[0];
  assert.equal((await get("/", { cookie })).status, 200);
  assert.notEqual((await get("/api/sync?code=short", { cookie })).status, 401);
  assert.equal((await get("/", { cookie: "md_owner=" + "0".repeat(64) })).status, 302, "a forged cookie is rejected");
});
test("wrong-password lockout after 8 tries", async () => {
  const h = { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" }, body = JSON.stringify({ password: "bad" });
  let last; for (let i = 0; i < 9; i++) last = await fetch(BASE + "/api/login", { method: "POST", headers: h, body });
  assert.equal(last.status, 429);
});
test("rate limit kicks in for a flood of API requests", async () => {
  const h = { "x-forwarded-for": "10.7.7.7" }; let last;
  for (let i = 0; i < 185; i++) last = await get("/api/nothing-here", h);
  assert.equal(last.status, 429);
});
test("index.html can't be fetched directly around the login", async () => {
  assert.equal((await get("/index.html")).status, 302);
  assert.equal((await get("/../server.js")).status === 200, false);
});
test("Claude is off by default ($0)", async () => {
  const j = await (await get("/api/health")).json(); assert.equal(j.claudeDailyLimit, 0);
});

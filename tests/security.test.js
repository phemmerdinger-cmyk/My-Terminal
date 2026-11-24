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
const login = (pw) => fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json", "true-client-ip": "10.0.0." + Math.floor(Math.random() * 200) }, body: JSON.stringify({ password: pw }) });

test("the real site needs a login", async () => {
  for (const p of ["/", "/index.html", "/?owner"]) { const r = await get(p); assert.equal(r.status, 302, p); assert.equal(r.headers.get("location"), "/login"); }
  assert.equal((await get("/ai-vs-sp500")).headers.get("location"), "/login");
});
test("the public demo is gone: old visitor and demo links lead to the sign-in", async () => {
  const r = await get("/?visitor"); assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/");
  assert.equal((await get("/demo")).status, 404);
});
test("the sign-in page is compressed and sends security headers", async () => {
  const r = await get("/login", { "accept-encoding": "gzip" });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("content-encoding"), "gzip");
  assert.match(await r.text(), /Market Desk|MARKET/i);
});
test("private APIs are blocked for visitors, public data APIs are open", async () => {
  for (const p of ["/api/sync?code=abcdefghijkl", "/api/autopilot/restore", "/api/unlock", "/api/ask", "/api/predict?symbol=AAPL", "/api/web/status", "/api/web/discoveries", "/api/web/briefing?id=latest", "/api/web/research?symbol=AAPL", "/api/web/graph", "/api/system/health", "/api/quanttrader/run", "/api/web/control", "/api/web/export", "/api/web/import", "/api/web/timeline?symbol=AAPL", "/api/web/signals", "/api/coach", "/api/mytrader"]) {
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
  const h = { "content-type": "application/json", "true-client-ip": "10.9.9.9" }, body = JSON.stringify({ password: "bad" });
  let last; for (let i = 0; i < 9; i++) last = await fetch(BASE + "/api/login", { method: "POST", headers: h, body });
  assert.equal(last.status, 429);
});
test("a spoofed X-Forwarded-For can't dodge the password lockout", async () => {
  const body = JSON.stringify({ password: "bad" }); let last;
  for (let i = 0; i < 9; i++) last = await fetch(BASE + "/api/login", { method: "POST", body, headers: { "content-type": "application/json", "true-client-ip": "10.8.8.8", "x-forwarded-for": "198.51.100." + i } });
  assert.equal(last.status, 429);
});
test("rate limit kicks in for a flood of API requests", async () => {
  const h = { "true-client-ip": "10.7.7.7" }; let last;
  const cookie = (await login("test-site-password-123")).headers.get("set-cookie").split(";")[0];
  for (let i = 0; i < 605; i++) last = await get("/api/nothing-here", { ...h, cookie }); // owners get 600 a minute
  assert.equal(last.status, 429);
});
test("index.html can't be fetched directly around the login", async () => {
  assert.equal((await get("/index.html")).status, 302);
  assert.equal((await get("/../server.js")).status === 200, false);
});
test("Claude spending is capped by a dollar budget (default $4, $1/day) and needs the password", async () => {
  const j = await (await get("/api/health")).json();
  assert.ok(j.claudeBudget, "budget reported"); assert.equal(j.claudeBudget.budget, 4); assert.equal(j.claudeBudget.dailyCap, 1);
  assert.ok(j.claudeBudget.left <= j.claudeBudget.budget);
  const r = await fetch(BASE + "/api/ask", { redirect: "manual", method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); assert.ok([302, 401, 403].includes(r.status), "visitors can't spend credits: " + r.status);
});
test("the data-integrity status is owner-only and honest when sources are unreachable", async () => {
  assert.equal((await get("/api/pub/integrity/status")).status, 401);
  const cookie = (await login("test-site-password-123")).headers.get("set-cookie").split(";")[0];
  const r = await get("/api/pub/integrity/status", { cookie }); assert.equal(r.status, 200);
  const j = await r.json(); assert.ok(["current", "delayed", "stale", "unavailable"].includes(j.status)); assert.ok(Array.isArray(j.rows));
});

test("the in-site reader only fetches allowlisted public-domain hosts over https", async () => {
  const cookie = (await login("test-site-password-123")).headers.get("set-cookie").split(";")[0], getO = (p) => get(p, { cookie });
  for (const u of ["file:///etc/passwd", "http://www.federalreserve.gov/x", "https://user:pw@www.sec.gov/x", "https://www.sec.gov:8443/x", "gopher://x"]) {
    const r = await getO("/api/article?url=" + encodeURIComponent(u)); assert.equal(r.status, 400, u);
  }
  // a host that isn't allowlisted is never fetched for full text: only metadata, no paragraphs
  for (const u of ["https://169.254.169.254/latest/meta-data", "https://localhost/admin", "https://example.com/story"]) {
    const j = await (await getO("/api/article?url=" + encodeURIComponent(u))).json(); assert.equal(j.full, false, u); assert.deepEqual(j.paragraphs, [], u);
  }
});

test("the bot pages' data routes answer (no server errors)", async () => {
  for (const p of ["/api/autopilot", "/api/daytrader", "/api/quanttrader"]) {
    const r = await get(p); assert.notEqual(r.status, 500, p + " " + (await r.text()).slice(0, 120));
  }
});

test("My Trader: visitors can't trade; the owner's order is checked, queued without a fresh price, and cancellable", async () => {
  const post = (p, body, h = {}) => fetch(BASE + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
  assert.equal((await post("/api/mytrader/order", { side: "BUY", sym: "AAPL", shares: 1 })).status, 401);
  const cookie = (await login("test-site-password-123")).headers.get("set-cookie").split(";")[0];
  assert.equal((await post("/api/mytrader/order", { side: "SELL", sym: "AAPL", shares: 1 }, { cookie })).status, 400, "no shorting");
  const before = await (await get("/api/mytrader", { cookie })).json(); // the book may hold orders from earlier local runs
  const r = await post("/api/mytrader/order", { side: "BUY", sym: "AAPL", shares: 1, note: "test" }, { cookie }), j = await r.json();
  assert.equal(r.status, 200);
  const v = await (await get("/api/mytrader", { cookie })).json();
  assert.equal(v.startValue, 30000);
  if (j.filled) { // only with a fresh live price (a networked machine during market hours): it's a real paper fill, so undo it
    assert.ok(j.trade.price > 0 && v.cash < before.cash);
    assert.equal((await post("/api/mytrader/order", { side: "SELL", sym: "AAPL", all: true }, { cookie })).status, 200);
  } else { // offline or market closed: it waits instead of guessing a fill
    assert.equal(v.cash, before.cash, "nothing spent until it fills"); assert.equal(v.pending.length, before.pending.length + 1);
    assert.equal((await post("/api/mytrader/cancel", { id: j.order.id }, { cookie })).status, 200);
    assert.equal((await (await get("/api/mytrader", { cookie })).json()).pending.length, before.pending.length);
  }
});

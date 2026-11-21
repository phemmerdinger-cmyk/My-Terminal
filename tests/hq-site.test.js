// Bot HQ as its own website (MODE=hq): only the control room, behind the owner password, read-only bot routes.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");
const DM = require("../deploy-mode-core.js");
const PORT = 3970 + Math.floor(Math.random() * 9), BASE = `http://127.0.0.1:${PORT}`;
let srv;
before(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, MODE: "hq", PORT: String(PORT), SITE_PASSWORD: "hq-test-password-123", PUBLIC_URL: "", DESK_TOKEN: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/api/health"); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error("server did not start");
});
after(() => srv && srv.kill());
const get = (p, h = {}) => fetch(BASE + p, { redirect: "manual", headers: h });

test("the HQ site is the control room only, behind its own sign-in", async () => {
  assert.equal((await get("/")).headers.get("location"), "/login");
  const login = await get("/login"); assert.equal(login.status, 200); assert.match(await login.text(), /Bot HQ sign-in/);
  for (const p of ["/demo", "/hq.html", "/app.js", "/portfolio.html", "/api/quotes?symbols=SPY", "/api/predict"]) assert.equal((await get(p)).status, 404, p);
  assert.equal((await get("/api/autopilot")).status, 401);
  assert.equal((await get("/hq.js")).status, 200);
  const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json", "true-client-ip": "10.9.9.9" }, body: JSON.stringify({ password: "hq-test-password-123" }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const page = await get("/", { cookie }); assert.equal(page.status, 200); assert.match(await page.text(), /BOT HQ/);
  assert.equal((await get("/api/autopilot", { cookie })).status, 503, "no PUBLIC_URL/DESK_TOKEN configured → clear 503, never local bot state");
  assert.equal((await fetch(BASE + "/api/autopilot/restore", { method: "POST", headers: { cookie } })).status, 404, "read-only");
});

test("hq rules", () => {
  assert.equal(DM.parseMode({ MODE: "hq" }).runJobs, false);
  assert.equal(DM.parseMode({ MODE: "local" }).hqPort, 3001);
  assert.equal(DM.parseMode({ MODE: "public" }).hqPort, null);
  assert.equal(DM.hqAccess({ path: "/api/web/status", owner: true }), "proxy");
  assert.equal(DM.hqAccess({ path: "/api/web/control", owner: true }), "notfound");
  assert.equal(DM.hqAccess({ path: "/api/brief", owner: false }), "deny");
  assert.deepEqual(DM.hqPage("/", true), { page: "hq.html" });
  assert.equal(DM.hqPage("/portfolio", true), null);
});

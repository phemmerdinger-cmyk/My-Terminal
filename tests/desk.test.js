"use strict";
// Personal data store: browser factory + the owner-only /api/desk endpoint on a real server.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path"), os = require("node:os"), fs = require("node:fs");
const F = require("../public/desk-store.js");
const mem = () => { const m = new Map(); return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), m }; };
const noTimer = { set: () => 0, clear: () => {} };

test("browser store persists sections locally and survives a reload", () => {
  const st = mem(); const a = F.create({ storage: st, timers: noTimer });
  a.set("home", { density: "compact" });
  assert.throws(() => a.set("bogus", 1));
  const b = F.create({ storage: st, timers: noTimer });
  assert.deepEqual(b.get("home"), { density: "compact" });
  assert.equal(b.get("dna", "none"), "none");
});
test("visitor mode never writes storage or calls the server", async () => {
  const st = mem(); let calls = 0;
  const v = F.create({ storage: st, visitor: true, fetchImpl: () => { calls++; }, timers: noTimer });
  v.set("home", { x: 1 }); assert.deepEqual(v.get("home"), { x: 1 });
  assert.equal(st.m.size, 0); assert.equal(await v.pull(), false); assert.equal(calls, 0);
});
test("pull adopts a newer server copy; export/import round-trips only known sections", async () => {
  const st = mem();
  const remote = { updated: Date.now() + 1000, data: { dna: { risk: "moderate" } } };
  const s = F.create({ storage: st, timers: noTimer, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ doc: remote, durable: false }) }) });
  assert.equal(await s.pull(), true); assert.deepEqual(s.get("dna"), { risk: "moderate" });
  const ex = s.exportDoc(); assert.equal(ex.kind, "market-desk-personal-data");
  const t = F.create({ storage: mem(), timers: noTimer });
  assert.deepEqual(t.importDoc({ ...ex, data: { ...ex.data, evil: 1 } }), ["dna"]);
  assert.throws(() => t.importDoc({ data: {} }));
});

const PORT = 4100 + Math.floor(Math.random() * 50), BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "desk-"));
let srv, cookie;
before(async () => {
  srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(PORT), SITE_PASSWORD: "desk-test-pw-123", FINNHUB_API_KEY: "", ANTHROPIC_API_KEY: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", SPIDER_OFF: "1", TMPDIR: TMP }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/api/health"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" }, body: JSON.stringify({ password: "desk-test-pw-123" }) });
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
});
after(() => srv && srv.kill());
const put = (doc, h = {}, q = "") => fetch(BASE + "/api/desk" + q, { method: "PUT", headers: { "content-type": "application/json", cookie, ...h }, body: JSON.stringify(doc) });

test("/api/desk is private: visitors and forged cookies get 401", async () => {
  assert.equal((await fetch(BASE + "/api/desk")).status, 401);
  assert.equal((await fetch(BASE + "/api/desk", { method: "PUT", body: "{}", headers: { "content-type": "application/json" } })).status, 401);
  assert.equal((await fetch(BASE + "/api/desk", { headers: { cookie: "md_owner=" + "0".repeat(64) } })).status, 401);
});
test("owner can save and read back; bad sections, timestamps and older writes are rejected", async () => {
  assert.match(cookie, /^md_owner=/);
  const t = Date.now();
  assert.equal((await put({ updated: t, data: { home: { density: "compact" } } })).status, 200);
  const j = await (await fetch(BASE + "/api/desk", { headers: { cookie } })).json();
  assert.deepEqual(j.doc.data.home, { density: "compact" }); assert.equal(j.durable, false);
  assert.equal((await put({ updated: t + 1, data: { apiKey: "x" } })).status, 400);
  assert.equal((await put({ updated: t + 864e5, data: {} })).status, 400);
  assert.equal((await put({ updated: "x", data: {} })).status, 400);
  const old = await put({ updated: t - 1000, data: { home: {} } }); assert.equal(old.status, 409);
  assert.deepEqual((await old.json()).doc.data.home, { density: "compact" });
  assert.equal((await put({ updated: t - 1000, data: { home: { a: 1 } } }, {}, "?force=1")).status, 200);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const O = require("../coach-orders-core.js");
const now = Date.parse("2026-11-25T15:00:00Z"), DAY = 864e5;

test("plain-English instructions are understood", () => {
  const p = (s) => O.parse(s);
  assert.deepEqual([p("swing bot buy NVDA $3,000").intent, p("swing bot buy NVDA $3,000").sym, p("swing bot buy NVDA $3,000").amount, p("swing bot buy NVDA $3,000").bots], ["buy", "NVDA", 3000, ["swing"]]);
  assert.equal(p("invest 5k in $AAPL").amount, 5000);
  assert.equal(p("swing bot invest in apple, 10 shares").symText, "apple");
  assert.equal(p("swing bot invest in apple, 10 shares").shares, 10);
  assert.equal(p("buy 5% of the account in MSFT").pct, 0.05);
  assert.deepEqual([p("never buy TSLA for 2 weeks").intent, p("never buy TSLA for 2 weeks").sym, p("never buy TSLA for 2 weeks").days], ["avoid", "TSLA", 14]);
  assert.deepEqual(p("day trader don't short anything").bots, ["day"]); assert.equal(p("day trader don't short anything").intent, "noShorts");
  assert.equal(p("pause the quant").intent, "pause"); assert.deepEqual(p("pause the quant").bots, ["quant"]);
  assert.deepEqual(p("resume all bots").bots, ["swing", "day", "quant"]);
  assert.equal(p("half size").factor, 0.5); assert.equal(p("max $2,000 per trade").max, 2000);
  assert.equal(p("cancel 3").n, 3); assert.equal(p("list").intent, "list"); assert.equal(p("what are my instructions").intent, "list");
  assert.equal(p("swing bot sell AMD").intent, "sell"); assert.equal(p("allow TSLA").intent, "allow");
  assert.equal(p("buy ES=F").sym, "ES=F");
  assert.equal(p("hello there").intent, "unknown");
  // the way people actually talk
  const t1 = p("tell swing trader to buy nvda");
  assert.deepEqual([t1.intent, t1.bots, t1.maybeTicker], ["buy", ["swing"], "NVDA"]);
  const t2 = p("can you have the quant avoid tesla please");
  assert.deepEqual([t2.intent, t2.bots, t2.symText], ["avoid", ["quant"], "tesla"]);
  const t3 = p("I want the swing bot to invest 2k in microsoft");
  assert.deepEqual([t3.intent, t3.amount, t3.symText], ["buy", 2000, "microsoft"]);
  assert.equal(p("hey coach, tell the day trader to stop shorting").intent, "noShorts");
  assert.equal(p("get the swing trader out of amd").intent, "sell");
  assert.equal(p("get the swing trader out of amd").maybeTicker, "AMD");
  assert.equal(p("all bots stay out of gamestop").intent, "avoid");
});

test("buy, then the bots see it; bots that can't do something say why", () => {
  const st = O.fresh();
  const r = O.apply(st, O.parse("swing bot buy NVDA $3,000"), { ok: true, sym: "NVDA", name: "NVIDIA Corporation" }, now);
  assert.match(r, /#1 Swing bot: buy NVDA \(\$3,000\)/);
  assert.equal(O.buys(st, "swing", now)[0].amount, 3000);
  const q = O.apply(st, O.parse("quant buy NVDA"), { ok: true, sym: "NVDA" }, now);
  assert.match(q, /Quant only holds its fixed list/); assert.equal(O.buys(st, "quant", now).length, 0);
  assert.match(O.apply(st, O.parse("day trader buy SPY"), { ok: true, sym: "SPY" }, now), /intraday/);
});

test("avoid, allow, pause, shorts, size and caps", () => {
  const st = O.fresh();
  O.apply(st, O.parse("never buy TSLA for 2 weeks"), { ok: true, sym: "TSLA" }, now);
  for (const b of ["swing", "day", "quant"]) assert.ok(O.blocked(st, b, "TSLA", now));
  assert.ok(!O.blocked(st, "swing", "TSLA", now + 15 * DAY), "ends on its own");
  O.apply(st, O.parse("allow TSLA"), { ok: true, sym: "TSLA" }, now);
  assert.ok(!O.blocked(st, "swing", "TSLA", now));
  O.apply(st, O.parse("day trader no shorts"), {}, now); assert.ok(O.noShorts(st, "day", now)); assert.ok(!O.noShorts(st, "swing", now));
  O.apply(st, O.parse("pause the quant"), {}, now); assert.ok(O.paused(st, "quant", now));
  O.apply(st, O.parse("resume the quant"), {}, now); assert.ok(!O.paused(st, "quant", now));
  O.apply(st, O.parse("half size"), {}, now); assert.equal(O.sizeFactor(st, "swing", now), 0.5); assert.equal(O.sizeFactor(st, "quant", now), 1);
  O.apply(st, O.parse("normal size"), {}, now); assert.equal(O.sizeFactor(st, "swing", now), 1);
  O.apply(st, O.parse("max $2,000 per trade"), {}, now); assert.equal(O.maxTrade(st, "day", now), 2000);
  assert.match(O.apply(st, O.parse("list"), {}, now), /at most \$2,000 per new trade/);
  const id = O.live(st, now).find((d) => d.kind === "maxTrade" && d.bot === "day").id;
  assert.match(O.apply(st, O.parse(`cancel ${id}`), {}, now), /Cancelled/); assert.equal(O.maxTrade(st, "day", now), Infinity);
  assert.match(O.apply(st, O.parse("clear all"), {}, now), /Cleared|Nothing/);
});

test("a buy replaces an old ban on the same stock; a sell replaces a pending buy", () => {
  const st = O.fresh();
  O.apply(st, O.parse("swing bot avoid AMD"), { ok: true, sym: "AMD" }, now);
  O.apply(st, O.parse("swing bot buy AMD"), { ok: true, sym: "AMD" }, now);
  assert.ok(!O.blocked(st, "swing", "AMD", now)); assert.equal(O.buys(st, "swing", now).length, 1);
  O.apply(st, O.parse("swing bot sell AMD"), { ok: true, sym: "AMD" }, now);
  assert.equal(O.buys(st, "swing", now).length, 0); assert.equal(O.sells(st, "swing", now).length, 1);
  assert.match(O.apply(st, O.parse("quant sell IEF"), { ok: true, sym: "IEF" }, now), /next rebalance/);
  assert.ok(O.blocked(st, "quant", "IEF", now));
});

test("buy amounts: dollars, shares, % of the account, or one normal slot", () => {
  assert.equal(O.buyAmount({ amount: 3000 }, { price: 100, accountValue: 30000, slot: 2970 }), 3000);
  assert.equal(O.buyAmount({ shares: 10 }, { price: 100, accountValue: 30000, slot: 2970 }), 1000);
  assert.equal(O.buyAmount({ pct: 0.05 }, { price: 100, accountValue: 30000, slot: 2970 }), 1500);
  assert.equal(O.buyAmount({}, { price: 100, accountValue: 30000, slot: 2970 }), 2970);
});

test("unknown symbols and unclear messages get a helpful answer", () => {
  const st = O.fresh();
  assert.match(O.apply(st, O.parse("buy zzzz corp"), { ok: false }, now), /couldn't find "zzzz corp"/);
  assert.match(O.apply(st, O.parse("hmm"), {}, now), /Examples/);
});

test("the chat is the one write route in Bot HQ, owner only, and runs where the bots run", () => {
  const DM = require("../deploy-mode-core.js");
  assert.equal(DM.hqAccess({ path: "/api/coach/chat", method: "POST", owner: true }), "proxy");
  assert.equal(DM.hqAccess({ path: "/api/coach/chat", method: "POST", owner: false }), "deny");
  assert.equal(DM.hqAccess({ path: "/api/coach", method: "POST", owner: true }), "notfound", "everything else stays read-only");
  assert.equal(DM.hqAccess({ path: "/api/autopilot", method: "POST", owner: true }), "notfound");
  assert.equal(DM.access({ mode: "local", path: "/api/coach/chat" }), "proxy");
  assert.equal(DM.access({ mode: "public", path: "/api/coach/chat" }), "notfound", "visitors can't reach it");
  assert.equal(DM.access({ mode: "public", path: "/api/coach/chat", token: true }), "serve");
});

test("end to end: the server's chat route takes instructions and lists them", async () => {
  const { spawn } = require("node:child_process"), path = require("node:path"), fs = require("node:fs"), os = require("node:os");
  const port = 39600 + Math.floor(Math.random() * 300), TMP = fs.mkdtempSync(path.join(os.tmpdir(), "md-chat-"));
  const env = { ...process.env, PORT: String(port), SITE_PASSWORD: "chat-test-pw-123", FINNHUB_API_KEY: "", ANTHROPIC_API_KEY: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", SPIDER_OFF: "1", AP_TEST: "closed", TMPDIR: TMP };
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/health"); break; } catch { await new Promise((ok) => setTimeout(ok, 200)); } }
    const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.7" }, body: JSON.stringify({ password: "chat-test-pw-123" }) });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const say = async (text) => (await fetch(base + "/api/coach/chat", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text }) })).json();
    assert.match((await say("hey coach, tell the day trader to stop shorting")).reply, /#1 Day trader: no short selling/);
    const r = await say("pause the quant");
    assert.equal(r.instructions.length, 2);
    assert.match((await say("list")).reply, /Quant: paused/);
    assert.equal((await fetch(base + "/api/coach/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "pause all" }) })).status, 401, "not without signing in");
  } finally { srv.kill(); }
});

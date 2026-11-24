const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../public/coach-core.js");

const wave = (n, base, slope, amp = 0.03, per = 20) => Array.from({ length: n }, (_, i) => base * (1 + slope * i) * (1 + amp * Math.sin((i / per) * 2 * Math.PI)));

test("chartRead: a steady uptrend reads Buy with support below and moving averages in order", () => {
  const r = C.chartRead(wave(260, 100, 0.004), { sym: "UP" });
  assert.equal(r.ok, true);
  assert.equal(r.trend, "up");
  assert.ok(r.sma50 > r.sma200);
  assert.ok(r.support && r.support.price < r.price);
  assert.notEqual(r.signal, "Sell");
});

test("chartRead: a downtrend reads Sell", () => {
  const r = C.chartRead(wave(260, 200, -0.002), { sym: "DN" });
  assert.equal(r.signal, "Sell");
  assert.equal(r.trend, "down");
});

test("chartRead: refuses short histories instead of guessing", () => {
  const r = C.chartRead([1, 2, 3]);
  assert.equal(r.ok, false);
  assert.match(r.why, /60 daily closes/);
});

test("rsi stays between 0 and 100 and is 100 with no down days", () => {
  assert.equal(C.rsi(Array.from({ length: 30 }, (_, i) => i + 1)), 100);
  const v = C.rsi(wave(100, 50, 0));
  assert.ok(v > 0 && v < 100);
});

const T0 = Date.UTC(2026, 0, 5);
function ledger(list) { // [sym, pnl, heldDays, why, setup]
  const out = []; let t = T0;
  for (const [sym, pnl, held, why, setup] of list) { out.push({ t, side: "BUY", sym, setup, why: "entry" }); t += held * 864e5; out.push({ t, side: "SELL", sym, pnl, why, setup }); t += 864e5; }
  return out.reverse(); // newest first, like the bots
}

test("journal: needs 5 closed trades", () => {
  const j = C.journal(ledger([["A", 10, 1, "x"], ["B", -5, 1, "Stop-loss"]]));
  assert.equal(j.ok, false);
  assert.equal(j.closed, 2);
});

test("journal: finds big losses, slow exits and a dominant exit reason, and writes at most 3 rules", () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(["W" + i, 50, 1, "Took profit", "breakout"]);
  for (let i = 0; i < 6; i++) rows.push(["L" + (i % 2), -150, 5, "Stop-loss hit", "breakout"]);
  const j = C.journal(ledger(rows));
  assert.equal(j.ok, true);
  assert.equal(j.closed, 14);
  assert.equal(j.wins, 8);
  assert.ok(Math.abs(j.profitFactor - 400 / 900) < 0.01);
  assert.ok(j.mistakes.some((m) => /Average loss/.test(m)));
  assert.ok(j.mistakes.some((m) => /held/.test(m)));
  assert.ok(j.mistakes.some((m) => /hit its stop/.test(m)));
  assert.ok(j.mistakes.some((m) => /L\d lost 3 times/.test(m)));
  assert.equal(j.rules.length, 3);
});

test("journal: uses only the last 20 closed trades", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ["S" + i, i < 10 ? -100 : 20, 1, "x"]);
  const j = C.journal(ledger(rows));
  assert.equal(j.closed, 20);
  assert.equal(j.losses, 0);
  assert.equal(j.rules.length, 0);
  assert.match(j.enough, /No recurring mistake/);
});

test("stress: beta-scaled hit, overexposure, correlated pairs and a hedge", () => {
  const spy = wave(260, 400, 0.001, 0.02, 13);
  const twice = spy.map((x, i) => 50 * Math.pow(x / spy[0], 2)); // moves ~2× the market
  const closes = { SPY: spy, AAA: twice, BBB: twice.map((x) => x * 3), CCC: wave(260, 30, 0, 0.01, 7) };
  const s = C.stress([{ bot: "swing", sym: "AAA", value: 10000 }, { bot: "swing", sym: "BBB", value: 1000 }, { bot: "quant", sym: "AAA", value: 2000 }, { bot: "quant", sym: "ZZZ", value: 500 }], closes);
  assert.equal(s.ok, true);
  const a = s.rows.find((r) => r.bot === "swing" && r.sym === "AAA");
  assert.ok(a.beta > 1.8 && a.beta < 2.2);
  assert.ok(a.hit < -3600 && a.hit > -4400);
  assert.deepEqual(s.missing, ["ZZZ"]);
  assert.ok(s.bots.find((b) => b.bot === "swing").over.some((o) => o.sym === "AAA"));
  assert.ok(s.pairs.some((p) => (p.a === "AAA" && p.b === "BBB") || (p.a === "BBB" && p.b === "AAA")));
  assert.deepEqual(s.shared.map((x) => x.sym), ["AAA"]);
  assert.ok(s.hedge.amount > 0);
  assert.match(s.note, /Hypothetical/);
});

test("stress: nothing held or no market history is reported, not estimated", () => {
  assert.equal(C.stress([], { SPY: [] }).ok, false);
  assert.match(C.stress([{ bot: "x", sym: "A", value: 1 }], { SPY: [1, 2] }).why, /unavailable/);
});

test("the Coach route reaches the bot server and Bot HQ, read-only and owner-only", () => {
  const DM = require("../deploy-mode-core.js");
  assert.equal(DM.isRemoteRoute("/api/coach"), true);
  assert.equal(DM.HQ_API.has("/api/coach"), true);
  assert.equal(DM.hqAccess({ path: "/api/coach", method: "GET", owner: false }), "deny");
  assert.equal(DM.hqAccess({ path: "/api/coach", method: "POST", owner: true }), "notfound");
});

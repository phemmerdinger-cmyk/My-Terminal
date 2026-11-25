const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../public/coach-tuner-core.js");
const C = require("../public/coach-core.js");

const DAY = 864e5, T0 = Date.parse("2026-11-02T15:00:00Z");
// n closed trades, one a day, with the given P&Ls (cycled)
const trades = (n, pnls, start = T0, extra = {}) => Array.from({ length: n }, (_, i) => ({ t: start + i * DAY, pnl: pnls[i % pnls.length], sym: "S" + (i % 7), setup: null, ...extra }));
const big = { kind: "bigLosses", weight: 3, text: "Average loss ($90) is 3.0× the average win ($30)." };

test("no changes before 10 closed trades", () => {
  const st = T.fresh();
  const out = T.plan(st, "swing", { closed: trades(9, [30, -90]), findings: [big], now: T0 + 20 * DAY });
  assert.deepEqual(out, []);
  assert.equal(T.effective(st, "swing").lossCap, null);
});

test("big losses → tightens the swing bot's loss cap one step, then waits a week", () => {
  const st = T.fresh(), L = trades(12, [30, -90]), now = T0 + 20 * DAY;
  const out = T.plan(st, "swing", { closed: L, findings: [big], now });
  assert.equal(out.length, 1);
  assert.equal(out[0].action, "changed");
  assert.equal(T.effective(st, "swing").lossCap, 0.12);
  assert.match(out[0].what, /the bot's own stops → −12%/i);
  // a day later, with more trades, nothing new: one lasting change per week
  const again = T.plan(st, "swing", { closed: trades(25, [30, -90]), findings: [big], now: now + DAY });
  assert.equal(again.filter((e) => e.action === "changed").length, 0);
});

test("a change that made results worse is undone and not tried again", () => {
  const st = T.fresh(), before = trades(20, [30, -40]), now = T0 + 25 * DAY;
  T.plan(st, "swing", { closed: before, findings: [big], now });
  assert.equal(T.effective(st, "swing").lossCap, 0.12);
  const after = trades(10, [-60], T0 + 30 * DAY); // worse per trade than the −$5 average before
  const out = T.plan(st, "swing", { closed: [...before, ...after], findings: [], now: now + 12 * DAY });
  const rev = out.find((e) => e.action === "reverted");
  assert.ok(rev, "reverted");
  assert.equal(T.effective(st, "swing").lossCap, null);
  // a week later the same finding doesn't bring the same setting back
  const later = T.plan(st, "swing", { closed: [...before, ...after, ...trades(10, [-60], T0 + 45 * DAY)], findings: [big], now: now + 30 * DAY });
  assert.equal(later.filter((e) => e.action === "changed" && e.key === "lossCap").length, 0);
});

test("a change that helped is kept", () => {
  const st = T.fresh(), before = trades(20, [30, -40]), now = T0 + 25 * DAY;
  T.plan(st, "swing", { closed: before, findings: [big], now });
  const out = T.plan(st, "swing", { closed: [...before, ...trades(10, [25], T0 + 30 * DAY)], findings: [], now: now + 12 * DAY });
  assert.ok(out.find((e) => e.action === "kept"));
  assert.equal(T.effective(st, "swing").lossCap, 0.12);
});

test("loss cap never goes below its floor", () => {
  const st = T.fresh(); let L = [], now = T0;
  for (let k = 0; k < 8; k++) { L = [...L, ...trades(10, [30, -90], T0 + k * 10 * DAY)]; now = T0 + (k * 10 + 10) * DAY; T.plan(st, "swing", { closed: L, findings: [big], now }); }
  assert.ok(T.effective(st, "swing").lossCap >= T.LIMITS.lossCap.min);
});

test("repeat loser and losing setup are blocked for 14 days, then expire", () => {
  const st = T.fresh(), L = trades(12, [-10]), now = T0 + 20 * DAY;
  const out = T.plan(st, "day", { closed: L, findings: [{ kind: "repeatSym", sym: "TSLA", weight: 3, text: "TSLA lost 3 times." }, { kind: "setup", setup: "VWAP snap-back", weight: 3, text: "lost" }], now });
  assert.equal(out.length, 2);
  const e = T.effective(st, "day", now + DAY);
  assert.ok(e.avoid.has("TSLA") && e.paused.has("VWAP snap-back"));
  const exp = T.plan(st, "day", { closed: L, findings: [], now: now + 15 * DAY });
  assert.equal(exp.filter((x) => x.action === "expired").length, 2);
  assert.equal(T.effective(st, "day", now + 15 * DAY).avoid.size, 0);
});

test("losing streak halves size until the next win", () => {
  const st = T.fresh(), L = trades(12, [20, 20, 20, 20, 20, 20, 20, 20, -5, -5, -5, -5]), now = T0 + 20 * DAY;
  T.plan(st, "day", { closed: L, findings: [{ kind: "streak", streak: 4, weight: 2, text: "Had a run of 4 losses in a row." }], now });
  assert.equal(T.effective(st, "day").sizeMult, 0.5);
  const out = T.plan(st, "day", { closed: [...L, { t: T0 + 13 * DAY, pnl: 15, sym: "X" }], findings: [], now: now + DAY });
  assert.ok(out.find((e) => e.action === "expired"));
  assert.equal(T.effective(st, "day").sizeMult, 1);
});

test("the quant trader is never changed; the reason is reported", () => {
  const st = T.fresh();
  const out = T.plan(st, "quant", { closed: trades(30, [30, -90]), findings: [big, { kind: "repeatSym", sym: "XLE", weight: 3, text: "x" }], now: T0 + 40 * DAY });
  assert.deepEqual(out, []);
  const why = T.cantFix(st, "quant", [big]);
  assert.match(why[0].why, /weekly replay test/);
});

test("causes the Coach can't fix are explained, not faked", () => {
  const st = T.fresh();
  const why = T.cantFix(st, "swing", [{ kind: "cause", cause: "hit its stop", weight: 3, text: "3 of 5 losses hit their stop." }]);
  assert.equal(why.length, 1);
  assert.match(why[0].why, /code/);
});

test("journal findings carry a machine-readable kind", () => {
  const L = [];
  for (let i = 0; i < 12; i++) { const t = T0 + i * DAY; L.push({ t, side: "BUY", sym: i % 2 ? "AAA" : "BBB" }, { t: t + 3600e3, side: "SELL", sym: i % 2 ? "AAA" : "BBB", pnl: i % 2 ? -90 : 30, why: "stop hit" }); }
  const j = C.journal(L);
  assert.ok(j.findings.some((f) => f.kind === "bigLosses"));
  assert.equal(C.closedTrades(L).length, 12);
});

test("success bar needs 40 trades, a profit, profit factor 1.3 and beating the S&P", () => {
  assert.equal(T.status(trades(12, [30, -10]), 0.01).met, false);
  assert.match(T.status(trades(12, [30, -10]), 0.01).text, /12 of 40/);
  assert.equal(T.status(trades(40, [30, -10]), 0.01).met, true);
  assert.equal(T.status(trades(40, [30, -10]), -0.01).met, false);
  assert.equal(T.status(trades(40, [30, -10]), null).checks[3].value, "unavailable");
});

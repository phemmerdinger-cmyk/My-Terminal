const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../coach-actions-core.js");
const DAY = 864e5, now = Date.parse("2026-11-25T15:00:00Z");

// today's real review on the owner's desk: a breakeven day-trader setup, a Quant losing run, Quant 100% in IEF
const review = {
  journals: [
    { bot: "Swing bot", ok: false },
    { bot: "Day trader", ok: true, findings: [{ kind: "setup", setup: "Confirmed momentum", text: "The \"Confirmed momentum\" setup lost $0 over 20 trades (10 wins)." }, { kind: "cause", cause: "hit its stop", text: "10 of 10 losses ended the same way: hit its stop ($16 lost)." }],
      trades: [{ sym: "SPY", t: now - 3600e3, pnl: -1, setup: "Confirmed momentum" }, { sym: "QQQ", t: now - 7200e3, pnl: 2, setup: "Confirmed momentum" }] },
    { bot: "Quant", ok: true, findings: [{ kind: "cause", cause: "market selloff", text: "5 of 8 losses ended the same way: market selloff ($470 lost)." }, { kind: "streak", worst: 4, text: "Had a run of 4 losses in a row." }, { kind: "lossSize", avgWin: 52, avgLoss: 87, text: "Average loss ($87) is 1.7× the average win ($52)." }], trades: [] },
  ],
  stress: { ok: true, bots: [{ bot: "Quant", over: [{ sym: "IEF", weight: 100 }] }], pairs: [] },
  charts: [{ ok: true, sym: "IEF", signal: "Sell", role: "held by Quant" }],
};

test("the Coach fixes what it can and explains what it won't touch", () => {
  const p = A.plan(review, { now });
  assert.deepEqual(p.actions.map((a) => a.kind), ["pauseSetup"]);
  assert.equal(p.actions[0].setup, "Confirmed momentum"); assert.equal(p.actions[0].until, now + 5 * DAY);
  assert.ok(A.setupPaused(p, "day", "Confirmed momentum", now));
  assert.ok(!A.setupPaused(p, "day", "ETF VWAP reversal", now));
  const notes = p.skipped.map((s) => s.why).join(" ");
  assert.match(notes, /IEF is a bond\/defensive fund/);
  assert.match(notes, /regime model/);
  assert.equal(p.skipped.filter((s) => s.bot === "Quant").length, 5, "all five Quant findings are explained, none acted on");
  assert.equal(A.summary(p, now).headline, "1 fix applied automatically");
});

test("pauses end on their own and need new losses to come back", () => {
  const p1 = A.plan(review, { now });
  const again = A.plan(review, { now: now + DAY, prev: p1 });
  assert.equal(again.actions[0].until, p1.actions[0].until, "a later review doesn't extend the pause");
  const after = A.plan(review, { now: now + 6 * DAY, prev: again });
  assert.equal(after.actions.length, 0, "same old trades don't re-pause it");
  assert.match(after.skipped.find((s) => /Confirmed/.test(s.finding)).why, /fresh chance/);
  const fresh = { ...review, journals: review.journals.map((j) => j.bot !== "Day trader" ? j : { ...j, trades: [1, 2, 3].map((i) => ({ sym: "SPY", t: now + 6 * DAY + i * 1000, pnl: -5, setup: "Confirmed momentum" })) }) };
  assert.equal(A.plan(fresh, { now: now + 7 * DAY, prev: after }).actions[0].kind, "pauseSetup", "3 new losing trades pause it again");
});

test("swing fixes: half size on a losing run, loss cap, time stop, cooldown, trim, sell half", () => {
  const sw = { journals: [{ bot: "Swing bot", ok: true, trades: [{ sym: "X", t: now - 1, pnl: -10 }, { sym: "X", t: now - 2, pnl: -10 }, { sym: "X", t: now - 3, pnl: -10 }, { sym: "Y", t: now - 4, pnl: 50 }],
    findings: [{ kind: "streak", worst: 4, text: "run" }, { kind: "lossSize", avgWin: 80, text: "loss" }, { kind: "holdLosers", holdWin: 3, text: "hold" }, { kind: "repeatSym", sym: "X", text: "X lost 3 times" }] }],
    stress: { ok: true, bots: [{ bot: "Swing bot", over: [{ sym: "NVDA", weight: 31 }, { sym: "TLT", weight: 25 }] }] }, charts: [{ ok: true, sym: "AMD", signal: "Sell", role: "held by Swing bot" }] };
  const p = A.plan(sw, { now });
  assert.deepEqual(p.actions.map((a) => a.kind).sort(), ["cooldown", "halfSize", "lossCap", "sellHalf", "timeStop", "trim"]);
  assert.equal(A.sizeFactor(p, "swing", now), 0.5);
  assert.ok(A.blocked(p, "swing", "X", now)); assert.ok(!A.blocked(p, "swing", "Y", now));
  assert.equal(A.swingExit(p, { cost: 100, shares: 10, at: now }, { sym: "Q", price: 91, now }).sell, 1, "down $90 > $80 cap");
  assert.equal(A.swingExit(p, { cost: 100, shares: 10, at: now - 6 * DAY }, { sym: "Q", price: 99, now }).sell, 1, "time stop after 5 days");
  assert.equal(A.swingExit(p, { cost: 100, shares: 10, at: now }, { sym: "Q", price: 99, now }), null);
  const trim = A.swingExit(p, { cost: 100, shares: 31, at: now }, { sym: "NVDA", price: 100, bookValue: 10000, now });
  assert.ok(Math.abs(trim.sell - (1 - 2000 / 3100)) < 0.01);
  const half = A.swingExit(p, { cost: 100, shares: 10, at: now }, { sym: "AMD", price: 101, now });
  assert.equal(half.sell, 0.5); assert.equal(A.swingExit(p, { cost: 100, shares: 5, at: now }, { sym: "AMD", price: 101, now, done: { [half.actionId]: true } }), null, "only once");
  assert.ok(p.skipped.some((s) => /TLT is a bond/.test(s.why)));
  const won = { journals: [{ ...sw.journals[0], trades: [{ sym: "Y", t: now, pnl: 20 }, ...sw.journals[0].trades] }] };
  assert.equal(A.sizeFactor(A.plan(won, { now }), "swing", now), 1, "half size ends with the next win");
});

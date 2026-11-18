const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../quant-pairs-runner.js");

const fitDate = "2026-11-17", signalDay = "2026-11-18", nextDay = "2026-11-19";
const signalTime = Date.parse("2026-11-18T21:25:00Z"), openTime = Date.parse("2026-11-19T14:30:00Z");
const opens = { SPY: { price: 200, marketTime: openTime }, IVV: { price: 100, marketTime: openTime } };
const c = { halfSpreadBps: 3, slippageBps: 2, feeBps: 1 };
const borrow = { IVV: { available: true, annualBps: 500, source: "test lender", marketTime: signalTime } };
function state() {
  return { ...P.freshPairShadows(), formation: { through: fitDate, models: [{ id: "SPY-IVV", left: "SPY", right: "IVV",
    eligible: true, through: fitDate, observations: 252, beta: 1, mean: 0, sd: 0.04, phi: 0.8, halfLife: 3.1, maxHold: 6 }] } };
}
function inputs(z, day = signalDay, executeDay = nextDay, time = signalTime) {
  return { sessions: [fitDate, signalDay, day].filter((x, i, a) => x <= day && a.indexOf(x) === i), adjustedCloses: {},
    signal: { day, time, adjustedPrices: { SPY: 100 * Math.exp(0.04 * z), IVV: 100 }, rawPrices: { SPY: 202, IVV: 100 } },
    executionCosts: { SPY: c, IVV: c }, borrow, executeDay, now: time };
}

test("queues within the stop-risk budget and fills neither leg on incomplete opening data", () => {
  const original = state(), plan = P.preparePairShadows(original, inputs(-2.4));
  assert.equal(original.pending.length, 0);
  assert.equal(plan.pending.length, 1);
  assert.ok(Math.abs(plan.pending[0].riskDollars - 60) < 1e-6);
  const open = { day: nextDay, openTime, now: openTime + 2000, borrow };
  const waiting = P.openPairShadows(plan, { ...open, opens: { SPY: opens.SPY } });
  assert.equal(waiting.pending.length, 1);
  assert.equal(P.pairSummary(waiting).value, 30000);
  const filled = P.openPairShadows(waiting, { ...open, opens });
  assert.equal(filled.pending.length, 0);
  assert.equal(filled.trades.length, 1);
  assert.ok(P.pairSummary(filled).value < 30000, "entry spread and fees reduce equity immediately");
  assert.equal(P.openPairShadows(filled, { ...open, opens }), filled);
});

test("charges only known borrow, allows risk-off exit with no new borrow, and reconciles realized equity", () => {
  const queue = P.preparePairShadows(state(), inputs(-2.4));
  const filled = P.openPairShadows(queue, { day: nextDay, openTime, now: openTime + 2000, opens, borrow });
  const friday = "2026-11-20", monday = "2026-11-23", fridayClose = Date.parse("2026-11-20T21:25:00Z");
  const exitPlan = P.preparePairShadows(filled, { ...inputs(-0.4, friday, monday, fridayClose), borrow: {}, riskOff: true });
  assert.equal(exitPlan.pending[0].action, "exit");
  assert.ok(exitPlan.borrow > 0);
  const t = Date.parse("2026-11-23T14:30:00Z");
  const exitOpens = { SPY: { price: 207, marketTime: t }, IVV: { price: 98, marketTime: t } };
  const missed = P.openPairShadows(exitPlan, { day: monday, openTime: t, now: t + 180_001, opens: {}, borrow: {} });
  const retried = P.preparePairShadows(missed, { ...inputs(-2, monday, "2026-11-24", Date.parse("2026-11-23T21:25:00Z")), borrow: {} });
  assert.equal(retried.pending[0].action, "exit", "missed liquidation remains due when the spread has moved");
  const closed = P.openPairShadows(exitPlan, { day: monday, openTime: t, now: t, opens: exitOpens, borrow: {} });
  const summary = P.pairSummary(closed);
  assert.equal(summary.openPairs, 0);
  assert.equal(summary.closedPairs, 1);
  assert.ok(closed.borrow > exitPlan.borrow, "accrues the calendar days across the weekend");
  assert.ok(Math.abs(summary.value - summary.capital - summary.realized) < 1e-8);
  assert.equal(P.preparePairShadows(state(), { ...inputs(-2.4), borrow: {} }).pending.length, 0);
});

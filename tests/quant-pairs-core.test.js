const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../quant-pairs-core.js");

function formation() {
  let seed = 97, market = 4.3, noise = 0;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const sessions = [], adjustedCloses = { SPY: {}, IVV: {}, GLD: {}, IAU: {} };
  for (let i = 0; sessions.length < 254; i++) {
    const date = new Date(Date.UTC(2024, 0, 2 + i));
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const day = date.toISOString().slice(0, 10);
    market += 0.0015 + random() * 0.02;
    noise = 0.81 * noise + random() * 0.008;
    sessions.push(day);
    adjustedCloses.IVV[day] = Math.exp(market);
    adjustedCloses.SPY[day] = Math.exp(0.2 + 1.1 * market + noise);
    adjustedCloses.IAU[day] = Math.exp(market);
    adjustedCloses.GLD[day] = Math.exp(0.25 - 1.1 * market + noise);
  }
  return { sessions, adjustedCloses };
}

test("forms only predefined pairs on the latest 252 completed aligned closes", () => {
  const data = formation(), result = P.fitPairs(data);
  const spy = result.models.find((m) => m.id === "SPY-IVV");
  const gold = result.models.find((m) => m.id === "GLD-IAU");
  assert.equal(result.through, data.sessions.at(-1));
  assert.equal(spy.observations, 252);
  assert.ok(Math.abs(spy.beta - 1.1) < 0.02);
  assert.ok(spy.halfLife >= 2 && spy.halfLife <= 10);
  assert.ok(spy.p < 0.01 && spy.holmP >= spy.p);
  assert.ok(Math.abs(spy.critical5 + 3.3605813278) < 1e-8);
  assert.equal(spy.eligible, true);
  assert.ok(gold.beta < 0);
  assert.equal(gold.reason, "Hedge coefficient must be positive");
  assert.match(result.models.find((m) => m.id === "QQQ-QQQM").reason, /missing/i);
  data.adjustedCloses.SPY[data.sessions[0]] = 1e10;
  assert.deepEqual(P.fitPairs(data), result, "a close outside the 252-session window cannot affect the fit");
  delete data.adjustedCloses.SPY[data.sessions.at(-1)];
  const incomplete = P.fitPairs(data).models.find((m) => m.id === "SPY-IVV");
  assert.equal(incomplete.observations, 251);
  assert.equal(incomplete.eligible, false, "no stale-close substitution");
});

const initialModel = { id: "SPY-IVV", left: "SPY", right: "IVV", eligible: true, through: "2026-11-17",
  beta: 1, mean: 0, sd: 0.01, phi: 0.8, halfLife: 3.1, maxHold: 6 };
const signalTime = Date.parse("2026-11-18T21:25:00Z"), openTime = Date.parse("2026-11-19T14:30:00Z");
const actualPrices = (z) => ({ SPY: 100 * Math.exp(z * initialModel.sd), IVV: 100 });
const estimate = { halfSpreadBps: 3, slippageBps: 2, feeBps: 1 };
const feeQuote = { available: true, annualBps: 50, source: "Test lender", marketTime: signalTime };
function input(z) {
  return { model: { ...initialModel }, signal: { day: "2026-11-18", time: signalTime, sessionsSinceFit: 1,
    adjustedPrices: actualPrices(z), rawPrices: { SPY: 200, IVV: 100 } }, executeDay: "2026-11-19", grossNotional: 1000,
    executionCosts: { SPY: estimate, IVV: estimate }, borrow: { IVV: feeQuote, SPY: feeQuote } };
}

test("requires a forward entry, real borrow evidence, cost margin, and a z-score within the entry band", () => {
  assert.equal(P.planEntry(input(-1.9)).ok, false);
  assert.equal(P.planEntry(input(3.6)).ok, false);
  assert.match(P.planEntry({ ...input(-2.4), borrow: {} }).reason, /borrow/);
  const expensive = { ...estimate, slippageBps: 200 };
  assert.match(P.planEntry({ ...input(-2.4), executionCosts: { SPY: expensive, IVV: estimate } }).reason, /modeled costs/);
  const overAge = input(-2.4);
  overAge.signal.sessionsSinceFit = 22;
  assert.equal(P.planEntry(overAge).ok, false);
  const sameDay = input(-2.4);
  sameDay.model.through = sameDay.signal.day;
  assert.equal(P.planEntry(sameDay).ok, false);
  const valid = P.planEntry(input(-2.4));
  assert.equal(valid.ok, true);
  assert.equal(valid.direction, 1);
  assert.ok(valid.edgeBps > 2 * valid.costBps);
  assert.deepEqual(valid.orders.map(({ symbol, side, shares }) => ({ symbol, side, shares })),
    [{ symbol: "SPY", side: "BUY", shares: 2.5 }, { symbol: "IVV", side: "SELL", shares: 5 }]);
});

test("fills both legs at the exact, fresh next opening print or skips the entire batch", () => {
  const orderInput = input(-2.4), entry = P.planEntry(orderInput);
  orderInput.model.beta = 1.5;
  const base = { plan: entry, openTime, now: openTime + 30_000, borrow: orderInput.borrow };
  const quotes = { SPY: { price: 201, marketTime: openTime }, IVV: { price: 99, marketTime: openTime } };
  const late = { ...quotes, IVV: { price: 99, marketTime: openTime + 30_000 } };
  assert.equal(P.fillAtOpen({ ...base, opens: late }).ok, false);
  assert.equal(P.fillAtOpen({ ...base, plan: { ...entry, signalTime: openTime }, opens: quotes }).ok, false);
  assert.equal(P.fillAtOpen({ ...base, opens: quotes, now: openTime + 180_001 }).ok, false);
  assert.equal(P.fillAtOpen({ ...base, opens: quotes, borrow: { IVV: { ...feeQuote, marketTime: openTime + 1 } } }).ok, false);
  assert.equal(P.fillAtOpen({ ...base, opens: quotes, borrow: { IVV: { ...feeQuote, annualBps: 51 } } }).ok, false);
  const filled = P.fillAtOpen({ ...base, opens: quotes });
  assert.equal(filled.ok, true);
  assert.equal(filled.fills.length, 2);
  assert.ok(filled.fills[0].price > 201 && filled.fills[1].price < 99, "adverse spread and slippage on both legs");
  assert.equal(filled.position.model.beta, 1, "fit captured at signal");
});

test("exits with frozen parameters on mean crossing, adverse stop or time limit", () => {
  const entry = P.planEntry(input(-2.4));
  const quotes = { SPY: { price: 201, marketTime: openTime }, IVV: { price: 99, marketTime: openTime } };
  const { position } = P.fillAtOpen({ plan: entry, opens: quotes, openTime, now: openTime, borrow: input(-2.4).borrow });
  const exit = (z, heldSessions) => P.planExit({ position, heldSessions, signal: { day: "2026-11-20", time: Date.parse("2026-11-20T21:25:00Z"), adjustedPrices: actualPrices(z) },
    executeDay: "2026-11-23" });
  assert.match(exit(-1.1, 2).reason, /continue/i);
  assert.equal(exit(-0.4, 2).reason, "Mean reversion");
  assert.equal(exit(0.8, 2).reason, "Mean reversion");
  assert.equal(exit(-3.7, 2).reason, "Spread stop");
  const maxHold = exit(-2, 6);
  assert.equal(maxHold.reason, "Holding limit");
  assert.deepEqual(maxHold.orders.map((o) => o.side), ["SELL", "BUY"]);
  assert.deepEqual(maxHold.orders.map((o) => o.shares), entry.orders.map((o) => o.shares));
  const exitTime = Date.parse("2026-11-23T14:30:00Z");
  const exitOpens = { SPY: { price: 207, marketTime: exitTime }, IVV: { price: 98, marketTime: exitTime } };
  assert.equal(P.fillAtOpen({ plan: maxHold, opens: exitOpens, openTime: exitTime, now: exitTime }).ok, true,
    "buying back a short does not require a new borrow confirmation");
});

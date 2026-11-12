// Backtesting engine: hand-checkable cases (deterministic synthetic prices, no network).
const { test } = require("node:test");
const assert = require("node:assert");
const Q = require("../public/quant.js");
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const T0 = Date.parse("2016-01-04") / 1000;
const series = (fn, n = 900) => { const t = [], c = []; for (let i = 0; i < n; i++) { t.push(T0 + i * 86400); c.push(fn(i)); } return { t, close: c, adj: c.slice() }; };
const spec = (o) => ({ benchmark: "SPY", initial: 10000, costs: { commissionBps: 0, spreadBps: 0, slippageBps: 0 }, limits: { maxWeight: 1, minCash: 0 }, rf: 0, from: T0 + 450 * 86400, to: Infinity, ...o });

test("buy and hold compounds exactly; benchmark held alone has beta 1 and alpha 0", () => {
  const g = 0.001, S = { SPY: series((i) => 100 * (1 + g) ** i) };
  const r = Q.run(spec({ series: S, universe: ["SPY"], strategy: "buyhold", weights: { SPY: 1 } }));
  // bought at the close of day 2 of the test window (signal day 1 → execute day 2), so it grows for n−2 days
  const n = r.equity.length; close(r.equity[n - 1], 10000 * (1 + g) ** (n - 2), 1e-6);
  const m = Q.metrics(r.dates, r.bench, r.bench, 0); close(m.beta, 1, 1e-9); close(m.alpha, 0, 1e-9);
});
test("no look-ahead: a rule that reacts to a jump buys AFTER it, so it can't profit from it", () => {
  const S = { SPY: series(() => 100), X: series((i) => (i < 700 ? 100 : 110)) };
  const r = Q.run(spec({ series: S, universe: ["X"], strategy: "custom", params: { entry: "ret(1) > 0.05", exit: "price < 0" } }));
  assert.equal(r.trades.length, 1); assert.equal(r.trades[0].price, 110, "executed at the post-jump price");
  close(r.equity[r.equity.length - 1], 10000, 1e-6);
  assert.ok(r.trades[0].t > r.trades[0].signalDate, "execution happens the day after the signal");
});
test("trading costs: commission + half the spread + slippage on traded value", () => {
  const S = { SPY: series(() => 100) };
  const r = Q.run(spec({ series: S, universe: ["SPY"], strategy: "buyhold", weights: { SPY: 1 }, costs: { commissionBps: 1, spreadBps: 10, slippageBps: 4 } }));
  const rate = (1 + 5 + 4) / 1e4, spent = 10000 / (1 + rate); // all cash invested, leaving room for the fee
  close(r.metrics.costs, spent * rate, 1e-6); close(r.equity[r.equity.length - 1], 10000 - spent * rate, 1e-6);
});
test("exposure limits: max position weight and minimum cash are enforced", () => {
  const S = { SPY: series(() => 100), A: series(() => 50) };
  const r = Q.run(spec({ series: S, universe: ["A"], strategy: "buyhold", weights: { A: 1 }, limits: { maxWeight: 0.25, minCash: 0 } }));
  close(r.metrics.avgExposure > 0 ? r.trades[0].value : 0, 2500, 1e-6);
  const r2 = Q.run(spec({ series: S, universe: ["A", "SPY"], strategy: "buyhold", weights: { A: 0.5, SPY: 0.5 }, limits: { maxWeight: 1, minCash: 0.2 } }));
  close(r2.trades.reduce((a, t) => a + t.value, 0), 8000, 1e-6);
});
test("metrics: drawdown, total return, VaR on a hand-made equity curve", () => {
  const d = [0, 1, 2, 3, 4].map((k) => T0 + k * 86400), eq = [100, 110, 99, 108.9, 119.79];
  const m = Q.metrics(d, eq, null, 0);
  close(m.maxDrawdown, 99 / 110 - 1); close(m.totalReturn, 0.1979, 1e-9); close(m.worstDay, -0.1, 1e-12); assert.ok(m.var95 > 0);
});
test("RSI uses Wilder smoothing: 100 on a straight rise, 0 on a straight fall", () => {
  const up = Q.indicators([...Array(30)].map((_, i) => 100 + i)).rsi(14), dn = Q.indicators([...Array(30)].map((_, i) => 100 - i)).rsi(14);
  assert.equal(up[29], 100); assert.equal(dn[29], 0); assert.equal(up[13], null, "needs 14 changes first");
});
test("optimization is tested once on later, unseen data", () => {
  const w = (k) => (i) => 100 * (1 + 0.0004) ** i * (1 + 0.05 * Math.sin(i / (20 + k)));
  const S = { SPY: series(w(0), 1400), A: series(w(5), 1400), B: series(w(9), 1400), C: series(w(13), 1400) };
  const o = Q.optimize(spec({ series: S, universe: ["A", "B", "C"], strategy: "momentum", from: T0 + 300 * 86400 }));
  assert.ok(o.inSample.to <= o.outOfSample.dates[0], "out-of-sample starts where in-sample ends");
  assert.ok(o.inSample.tried > 1); assert.match(o.note, /never saw/);
  const wf = Q.walkForward(spec({ series: S, universe: ["A", "B", "C"], strategy: "momentum", from: T0 + 300 * 86400 }), 2, 1);
  for (const x of wf.windows) assert.ok(x.trainTo <= x.testFrom);
});
test("custom rules: valid syntax compiles, anything else is rejected", () => {
  assert.equal(typeof Q.compileRule("rsi(14) < 30 and price > sma(200)"), "function");
  assert.throws(() => Q.compileRule("process.exit()")); assert.throws(() => Q.compileRule("sma(999) > 1")); assert.throws(() => Q.compileRule(""));
});

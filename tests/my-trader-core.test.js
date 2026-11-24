const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../my-trader-core.js");

const NOW = Date.UTC(2026, 10, 24, 16, 0);
const q = (price, ago = 10_000) => ({ price, marketTime: NOW - ago });

test("a buy fills immediately at a fresh quote plus modeled cost, and cash drops", () => {
  const st = M.fresh(NOW);
  const r = M.place(st, { side: "buy", sym: "aapl", shares: 10 }, { now: NOW, open: true, quote: q(200) });
  assert.equal(r.ok, true); assert.equal(r.filled, true);
  assert.equal(r.trade.price, 200.15);
  assert.equal(st.positions.AAPL.shares, 10);
  assert.equal(st.cash, 30000 - 2001.5);
  assert.equal(st.firstTrade, NOW);
});

test("a dollar-amount buy buys fractional shares", () => {
  const st = M.fresh(NOW);
  M.place(st, { side: "BUY", sym: "SPY", amount: 1000 }, { now: NOW, open: true, quote: q(500) });
  assert.ok(Math.abs(st.positions.SPY.shares - 1000 / 500.375) < 1e-3);
  assert.ok(Math.abs(st.cash - 29000) < 0.1);
});

test("orders wait when the market is closed or the quote is stale, and fill only with a quote stamped after the order", () => {
  const st = M.fresh(NOW);
  const r = M.place(st, { side: "BUY", sym: "MSFT", shares: 5 }, { now: NOW, open: false, quote: q(400) });
  assert.equal(r.filled, false); assert.equal(st.pending.length, 1);
  const stale = M.place(st, { side: "BUY", sym: "NVDA", shares: 1 }, { now: NOW, open: true, quote: q(100, 10 * 60_000) });
  assert.equal(stale.filled, false);
  // a quote from before the order doesn't count
  assert.equal(M.work(st, { MSFT: { price: 400, marketTime: NOW - 1000 } }, { now: NOW + 60_000, open: true }).length, 0);
  const done = M.work(st, { MSFT: { price: 401, marketTime: NOW + 30_000 } }, { now: NOW + 60_000, open: true });
  assert.equal(done.length, 1); assert.equal(st.positions.MSFT.shares, 5); assert.equal(st.pending.length, 1);
  assert.equal(M.work(st, {}, { now: NOW + 60_000, open: false }).length, 0, "nothing fills while closed");
});

test("sells realize profit after costs; no shorting, no selling more than you own", () => {
  const st = M.fresh(NOW);
  M.place(st, { side: "BUY", sym: "KO", shares: 10 }, { now: NOW, open: true, quote: q(60) });
  assert.match(M.place(st, { side: "SELL", sym: "PEP", shares: 1 }, { now: NOW, open: true, quote: q(1) }).error, /Shorting/);
  assert.match(M.place(st, { side: "SELL", sym: "KO", shares: 11 }, { now: NOW, open: true, quote: q(70) }).error, /only own 10/);
  const r = M.place(st, { side: "SELL", sym: "KO", all: true }, { now: NOW + 1, open: true, quote: q(70) });
  assert.equal(r.filled, true); assert.equal(st.positions.KO, undefined);
  assert.ok(Math.abs(r.trade.pnl - (70 * (1 - M.COST) - 60 * (1 + M.COST)) * 10) < 0.02);
  assert.equal(M.stats(st).wins, 1);
});

test("can't spend more cash than the account has", () => {
  const st = M.fresh(NOW);
  const r = M.place(st, { side: "BUY", sym: "BRK.B", shares: 100 }, { now: NOW, open: true, quote: q(500) });
  assert.equal(r.ok, false); assert.match(r.error, /Not enough cash/);
  assert.equal(st.cash, 30000); assert.deepEqual(st.positions, {});
});

test("bad input is rejected", () => {
  const st = M.fresh(NOW);
  for (const o of [{ side: "HOLD", sym: "A", shares: 1 }, { side: "BUY", sym: "not a ticker!", shares: 1 }, { side: "BUY", sym: "A" }, { side: "BUY", sym: "A", shares: 1, amount: 5 }, { side: "BUY", sym: "A", shares: -3 }])
    assert.equal(M.validate(st, o).ok, false, JSON.stringify(o));
});

test("cancel removes a waiting order; value marks positions and flags missing prices", () => {
  const st = M.fresh(NOW);
  const r = M.place(st, { side: "BUY", sym: "XOM", shares: 2 }, { now: NOW, open: false });
  assert.equal(M.cancel(st, r.order.id), true); assert.equal(st.pending.length, 0);
  M.place(st, { side: "BUY", sym: "XOM", shares: 10 }, { now: NOW, open: true, quote: q(100) });
  assert.equal(M.value(st, { XOM: 110 }).value, Math.round((st.cash + 1100) * 100) / 100);
  assert.deepEqual(M.value(st, {}).missing, ["XOM"]);
});

test("mark keeps one point per day and starts the S&P benchmark at the first mark", () => {
  const st = M.fresh(NOW);
  M.mark(st, { day: "2026-11-24", value: 30000, spx: 6000, now: NOW });
  assert.equal(st.equity.length, 0, "nothing recorded before the first trade");
  M.place(st, { side: "BUY", sym: "SPY", shares: 1 }, { now: NOW, open: true, quote: q(600) });
  M.mark(st, { day: "2026-11-24", value: 30010, spx: 6000, now: NOW });
  M.mark(st, { day: "2026-11-24", value: 30020, spx: 6010, now: NOW + 60_000 });
  M.mark(st, { day: "2026-11-25", value: 30050, spx: 6020, now: NOW + 864e5 });
  assert.equal(st.spx0, 6000);
  assert.deepEqual(st.equity.map((p) => p.v), [30020, 30050]);
});

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

test("sells realize profit after costs; can't sell what you don't own or more than you own", () => {
  const st = M.fresh(NOW);
  M.place(st, { side: "BUY", sym: "KO", shares: 10 }, { now: NOW, open: true, quote: q(60) });
  assert.match(M.place(st, { side: "SELL", sym: "PEP", shares: 1 }, { now: NOW, open: true, quote: q(1) }).error, /choose Short/);
  assert.match(M.place(st, { side: "SELL", sym: "KO", shares: 11 }, { now: NOW, open: true, quote: q(70) }).error, /only have 10/);
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

test("short then cover: proceeds come in, profit when the price falls, value counts the short as owed", () => {
  const st = M.fresh(NOW);
  const r = M.place(st, { side: "SHORT", sym: "NVDA", shares: 40, note: "Uncertainty" }, { now: NOW, open: true, quote: q(180) });
  assert.equal(r.filled, true);
  assert.equal(st.positions.NVDA.dir, "short");
  assert.ok(Math.abs(st.cash - (30000 + 40 * 180 * (1 - M.COST))) < 0.02);
  assert.ok(Math.abs(M.value(st, { NVDA: 170 }).value - (st.cash - 40 * 170)) < 0.02);
  assert.match(M.place(st, { side: "BUY", sym: "NVDA", shares: 1 }, { now: NOW, open: true, quote: q(170) }).error, /Cover it before buying/);
  assert.match(M.place(st, { side: "SELL", sym: "NVDA", shares: 1 }, { now: NOW, open: true, quote: q(170) }).error, /Use Cover/);
  const c = M.place(st, { side: "COVER", sym: "NVDA", all: true }, { now: NOW + 1, open: true, quote: q(170) });
  assert.equal(c.filled, true); assert.equal(st.positions.NVDA, undefined);
  assert.ok(Math.abs(c.trade.pnl - (180 * (1 - M.COST) - 170 * (1 + M.COST)) * 40) < 0.05);
  assert.ok(Math.abs(st.cash - (30000 + c.trade.pnl)) < 0.05);
  assert.equal(M.stats(st).closed, 1);
});

test("shorts must be backed by free cash, so total shorts can't exceed the account", () => {
  const st = M.fresh(NOW);
  assert.equal(M.place(st, { side: "SHORT", sym: "TSLA", amount: 29000 }, { now: NOW, open: true, quote: q(250) }).ok, true);
  assert.ok(M.buyingPower(st, { TSLA: 250 }) < 1100);
  assert.match(M.place(st, { side: "SHORT", sym: "AMD", amount: 5000 }, { now: NOW, open: true, quote: q(100) }).error, /free cash/);
  assert.match(M.place(st, { side: "BUY", sym: "AMD", amount: 5000 }, { now: NOW, open: true, quote: q(100) }).error, /Not enough cash/);
});

test("a short that loses half its entry price is bought back automatically", () => {
  const st = M.fresh(NOW);
  M.place(st, { side: "SHORT", sym: "GME", shares: 10 }, { now: NOW, open: true, quote: q(20) });
  assert.equal(M.work(st, { GME: { price: 25, marketTime: NOW + 50_000 } }, { now: NOW + 60_000, open: true }).length, 0);
  const done = M.work(st, { GME: { price: 31, marketTime: NOW + 110_000 } }, { now: NOW + 120_000, open: true });
  assert.equal(done.length, 1); assert.equal(st.positions.GME, undefined);
  assert.match(st.trades[0].auto, /Automatic buy-back/); assert.ok(st.trades[0].pnl < 0);
});

test("borrow fee is charged once per day on open shorts", () => {
  const st = M.fresh(NOW);
  M.place(st, { side: "SHORT", sym: "SPY", amount: 10000 }, { now: NOW, open: true, quote: q(500) });
  assert.equal(M.borrow(st, { day: "2026-11-24", px: { SPY: 500 } }), 0, "first day starts the clock");
  const cash = st.cash, fee = M.borrow(st, { day: "2026-11-25", px: { SPY: 500 } });
  assert.ok(Math.abs(fee - st.positions.SPY.shares * 500 * M.BORROW_YR / 360) < 0.01);
  assert.equal(M.borrow(st, { day: "2026-11-25", px: { SPY: 500 } }), 0, "not twice in one day");
  assert.ok(Math.abs(st.cash - (cash - fee)) < 0.01);
});

test("multi-asset: futures trade in whole contracts with the multiplier, prices on the tick", () => {
  const st = M.fresh(1000), now = 10_000, q = { price: 5000.1, marketTime: now - 1000 };
  assert.equal(M.place(st, { side: "BUY", sym: "ES=F", shares: 0.5 }, { now, open: true, quote: q }).ok, false, "no fractional contracts");
  assert.equal(M.place(st, { side: "BUY", sym: "ES=F", amount: 1000 }, { now, open: true, quote: q }).ok, false, "one ES contract is ~$250,000 cash-backed");
  const st2 = M.fresh(1000); st2.cash = st2.start = 1_000_000;
  const r = M.place(st2, { side: "BUY", sym: "ES=F", shares: 2 }, { now, open: true, quote: q });
  assert.ok(r.filled); assert.equal(r.trade.mult, 50);
  assert.equal(r.trade.price % 0.25, 0, "fill on a quarter-point tick");
  assert.ok(Math.abs(r.trade.amount - 2 * 50 * r.trade.price) < 0.01);
  const v = M.value(st2, { "ES=F": r.trade.price + 10 });
  assert.ok(Math.abs(v.value - (1_000_000 + 2 * 50 * 10)) < 0.01, "10 points × $50 × 2 contracts = $1,000");
  const s = M.place(st2, { side: "SELL", sym: "ES=F", all: true }, { now: now + 5000, open: true, quote: { price: r.trade.price + 10, marketTime: now + 4000 } });
  assert.equal(s.trade.pnl, (s.trade.price - r.trade.price) * 2 * 50, "P&L = fill-to-fill points × $50 × 2 contracts (costs are inside the fill prices)");
});

test("multi-asset: indexes can't be traded; each market keeps its own hours", () => {
  const st = M.fresh(1000);
  assert.match(M.place(st, { side: "BUY", sym: "^GSPC", shares: 1 }).error, /index/);
  const now = 10_000, crypto = { price: 60000, marketTime: now - 500 };
  const r = M.place(st, { side: "BUY", sym: "BTC-USD", amount: 600 }, { now, open: (sym) => sym === "BTC-USD", quote: crypto });
  assert.ok(r.filled, "crypto fills while stocks are closed");
  const p = M.place(st, { side: "BUY", sym: "AAPL", shares: 1 }, { now, open: (sym) => sym === "BTC-USD", quote: { price: 190, marketTime: now - 500 } });
  assert.equal(p.filled, false);
  assert.equal(M.work(st, { AAPL: { price: 190, marketTime: now + 100 } }, { now: now + 1000, open: () => false }).length, 0, "stock order waits for its own open");
});

test("multi-asset: a delayed feed (Yahoo futures ~10 min) still counts as fresh for its delay", () => {
  const now = 1_000_000;
  assert.equal(M.usable({ price: 1, marketTime: now - 11 * 60_000 }, now), false);
  assert.equal(M.usable({ price: 1, marketTime: now - 11 * 60_000, delayMin: 10 }, now), true);
});

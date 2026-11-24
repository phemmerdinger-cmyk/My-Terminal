const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../public/order-preview-core.js");
const M = require("../my-trader-core.js");
const R = { cost: M.COST, borrowYr: M.BORROW_YR, shortStop: M.SHORT_STOP };
const acct = { buyingPower: 30000, value: 30000 };
const NOW = Date.UTC(2026, 10, 24, 16, 0);

test("buy preview matches what My Trader actually fills at the same price", () => {
  const pv = P.preview({ side: "BUY", mode: "shares", qty: 10 }, 200, acct, null, R);
  const st = M.fresh(NOW), r = M.place(st, { side: "BUY", sym: "AAPL", shares: 10 }, { now: NOW, open: true, quote: { price: 200, marketTime: NOW - 1000 } });
  assert.equal(pv.fill, r.trade.price); assert.equal(pv.amount, r.trade.amount); assert.equal(pv.cost, r.trade.cost);
  assert.equal(pv.freeAfter, st.cash);
});

test("dollar buys estimate fractional shares; big buys and cash shortfalls warn", () => {
  const pv = P.preview({ side: "BUY", mode: "amount", qty: 9000 }, 100, acct, null, R);
  assert.ok(Math.abs(pv.amount - 9000) < 0.01); assert.match(pv.warn.join(), /30% of your account/);
  assert.match(P.preview({ side: "BUY", mode: "shares", qty: 400 }, 100, acct, null, R).warn.join(), /Not enough free cash/);
});

test("short preview shows proceeds, cash set aside, borrow fee and the automatic buy-back price", () => {
  const pv = P.preview({ side: "SHORT", mode: "shares", qty: 40 }, 180, acct, null, R);
  assert.equal(pv.cashChange, pv.amount); assert.equal(pv.setAside, Math.round(2 * pv.amount * 100) / 100);
  assert.ok(Math.abs(pv.borrowDay - pv.amount * 0.03 / 360) < 0.01);
  assert.ok(Math.abs(pv.autoCover - pv.fill * 1.5) < 0.01);
});

test("sell and cover previews show profit or loss against your entry", () => {
  const s = P.preview({ side: "SELL", mode: "all" }, 110, acct, { dir: "long", shares: 5, cost: 100 }, R);
  assert.equal(s.shares, 5); assert.ok(s.pnl > 49 && s.pnl < 50);
  const c = P.preview({ side: "COVER", mode: "shares", qty: 99 }, 90, acct, { dir: "short", shares: 10, cost: 100 }, R);
  assert.equal(c.shares, 10, "can't cover more than you're short"); assert.ok(c.pnl > 99 && c.pnl < 100);
  assert.equal(P.preview({ side: "SELL", mode: "all" }, 90, acct, { dir: "short", shares: 10, cost: 100 }, R).ok, false);
});

test("no price or no size means no estimate, never a guess", () => {
  assert.equal(P.preview({ side: "BUY", mode: "shares", qty: 1 }, null, acct, null, R).ok, false);
  assert.equal(P.preview({ side: "BUY", mode: "shares", qty: 0 }, 50, acct, null, R).ok, false);
  assert.equal(P.within(5, 1, 9), 0.5); assert.equal(P.within(5, null, 9), null);
});

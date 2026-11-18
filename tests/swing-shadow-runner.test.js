const { test } = require("node:test");
const assert = require("node:assert/strict");
const R = require("../swing-shadow-runner");
const P = require("../paper-execution-core");

const signalDay = "2026-11-17", day = "2026-11-18";
const signalAt = Date.parse(`${signalDay}T22:00:00Z`), openingAt = Date.parse(`${day}T14:30:00Z`);
const idea = (symbol, fields = {}) => ({ symbol, signalDay, signalAt, openDay: day, pivot: 100, stop: 95, atr: 4, ...fields });
const quote = (o, fields = {}) => ({ o, t: openingAt / 1000, m: 570, d: day, ...fields });

test("two shadow books use independent cash, two-sided costs and capped position risk", () => {
  const state = R.freshSwingShadows(signalAt);
  state.books.technical.pending = [idea("A"), idea("B"), idea("C"), idea("D")];
  state.books.canSlim.pending = [idea("A")];
  const openingBars = { A: quote(100), B: quote(100), C: quote(100), D: quote(100) };
  const opened = R.openSwingShadows(state, { day, openingBars, now: openingAt + 60_000 });
  assert.equal(state.books.technical.cash, 30_000);
  assert.equal(opened.books.technical.trades.length, 2);
  assert.equal(opened.books.technical.skipped, 2);
  assert.equal(opened.books.canSlim.trades.length, 1);
  const book = opened.books.technical;
  const risks = Object.values(book.positions).map(({ shares, entry, stop }) => shares * (entry - P.paperFill("SELL", stop, 0.00075)));
  assert.ok(risks.every((risk) => risk <= 90));
  assert.ok(risks.reduce((sum, risk) => sum + risk, 0) <= 180);
  assert.ok(book.cash >= 0);
  assert.ok(Math.abs(book.value - (30_000 - book.costs)) < 1e-7);
  assert.equal(R.openSwingShadows(opened, { day, openingBars, now: openingAt + 60_000 }), opened);
});

test("wrong-minute, future and late opening observations cannot create retroactive fills", () => {
  const state = R.freshSwingShadows(signalAt);
  state.books.technical.pending = [idea("A"), idea("B", { signalAt: openingAt + 1 })];
  const openingBars = { A: quote(100, { t: (openingAt + 60_000) / 1000 }), B: quote(100) };
  const waiting = R.openSwingShadows(state, { day, openingBars, now: openingAt + 60_000 });
  assert.deepEqual(waiting.books.technical.pending.map(({ symbol }) => symbol), ["A"]);
  assert.equal(waiting.books.technical.skipped, 1);
  const expired = R.openSwingShadows(waiting, { day, openingBars: { A: quote(100) }, now: openingAt + 5 * 60_000 });
  assert.deepEqual(expired.books.technical.pending, []);
  assert.equal(expired.books.technical.trades.length, 0);
  assert.equal(expired.books.technical.skipped, 2);
});

test("a finalized gap exit includes both legs and settles only once", () => {
  const state = R.freshSwingShadows(signalAt);
  state.books.technical.pending = [idea("A")];
  const opened = R.openSwingShadows(state, { day, openingBars: { A: quote(100) }, now: openingAt + 60_000 });
  const asOf = Date.parse("2026-11-19T22:00:00Z");
  const input = {
    asOf, signalDay: "2026-11-19", nextSession: "2026-11-20", regime: { riskOff: true },
    barsBySymbol: { A: [
      { day: "2026-11-19", open: 91, high: 96, low: 90, close: 95 },
      { day, open: 100, high: 102, low: 97, close: 101 },
      { day: "2026-11-20", open: 1, high: 2, low: 1, close: 1 },
    ] },
  };
  const settled = R.prepareSwingShadows(opened, input);
  const book = settled.books.technical, [sell, buy] = book.trades;
  assert.equal(sell.referencePrice, 91);
  assert.equal(sell.price, P.paperFill("SELL", 91, 0.00075));
  assert.equal(book.closed, 1);
  assert.ok(Math.abs(book.realizedPnl - buy.shares * (sell.price - buy.price)) < 1e-7);
  assert.ok(Math.abs(book.cash - 30_000 - book.realizedPnl) < 1e-7);
  assert.equal(R.prepareSwingShadows(settled, input).books.technical.closed, 1);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { advanceDayShadows } = require("../day-shadow-runner.js");

const DAY = "2026-11-18", PRIOR = "2026-11-17", OPEN = 9 * 60 + 30, START = 1_800_000_000;
const candle = (o, h, l, c, v = 1000) => ({ o, h, l, c, v });
const signalBars = [
  candle(100.3, 100.4, 100.2, 100.3, 5000), candle(100.2, 100.3, 100.1, 100.2, 5000),
  candle(99.1, 99.3, 98.9, 99), candle(99.2, 99.4, 99.1, 99.3), candle(99.45, 99.7, 99.44, 99.65),
].flatMap((bar, i) => Array.from({ length: 5 }, (_, j) => ({ ...bar, d: DAY, t: START + (i * 5 + j) * 60, m: OPEN + i * 5 + j })));
const warmup = { XYZ: Array.from({ length: 70 }, (_, i) => {
  const c = 100 + (i % 2 ? -0.1 : 0.1);
  return { ...candle(c, c + 0.1, c - 0.1, c), d: PRIOR, t: START - 86400 + i * 300, m: OPEN + i * 5 };
}) };
const prior = { XYZ: { d: PRIOR, o: 103.9, h: 104, l: 99.5, c: 99.6 } };
const signalClose = (START + 1500) * 1000;
const fillAt = START + 1560;
const barAt = (t, quote = candle(99.67, 99.9, 99.6, 99.8)) => ({ ...quote, d: DAY, t, m: OPEN + (t - START) / 60 });
const knownAt = (t) => (t + 60) * 1000 + 5;

function tick(state, bars, now, observedAt = now) {
  return advanceDayShadows(state, { series: [["XYZ", bars, observedAt]], day: DAY, now, warmup, prior });
}

test("independent books queue the same sealed signal once and only its later exact minute can fill", () => {
  let state = tick(null, signalBars, signalClose - 1);
  assert.deepEqual(state.costModel, { sideBps: 5, shortEntryBps: 1, calibrated: false });
  assert.equal(state.books.base.cash, 30000);
  assert.equal(state.books.fvg.cash, 30000);
  assert.equal(state.books.base.queued, 0);
  state = tick(state, signalBars, signalClose + 1);
  assert.equal(state.books.base.pending.XYZ.fillAt, fillAt);
  assert.equal(state.books.fvg.pending.XYZ.fillAt, fillAt);
  assert.notEqual(state.books.base.pending, state.books.fvg.pending);
  tick(state, signalBars, signalClose + 1000);
  assert.equal(state.books.base.queued, 1);
  assert.equal(state.books.fvg.queued, 1);
  state = JSON.parse(JSON.stringify(state));
  tick(state, [barAt(fillAt)], knownAt(fillAt), knownAt(fillAt) - 6);
  assert.equal(state.books.base.filled, 0, "partial minute not treated as a fill");
  for (let i = 0; i < 10; i++) {
    const t = fillAt + i * 60;
    tick(state, [barAt(t)], knownAt(t));
    if (i === 0) {
      const open = state.books.base.positions.XYZ;
      assert.equal(open.entry, 99.67);
      assert.ok(open.at > open.decisionAt);
      assert.ok(open.plannedRisk <= 60);
      tick(state, [barAt(t)], knownAt(t) + 10);
      assert.equal(open.bars, 1, "observation retry does not advance holding clock");
    }
  }
  for (const book of Object.values(state.books)) {
    assert.equal(book.filled, 1);
    assert.equal(book.closed, 1);
    assert.equal(book.trades[0].exit, 99.8);
    assert.match(book.trades[0].why, /Time stop/);
    assert.ok(Math.abs(book.cash - 30_000 - book.trades[0].pnl) < 1e-9);
    assert.equal(book.costs, book.trades[0].costs);
  }
});

test("missed and stale scheduled minutes expire without a replacement fill", () => {
  const missing = tick(null, signalBars, signalClose + 1);
  tick(missing, [barAt(fillAt + 60)], knownAt(fillAt + 60));
  assert.equal(missing.books.base.expired, 1);
  assert.equal(missing.books.base.filled, 0);
  assert.equal(missing.books.base.cash, 30000);
  const stale = tick(null, signalBars, signalClose + 1);
  tick(stale, [barAt(fillAt)], knownAt(fillAt) + 91_000);
  assert.equal(stale.books.base.expired, 1);
  assert.equal(stale.books.base.filled, 0);
});

test("first refreshed open settles an observed position gap without fabricating a price", () => {
  const state = tick(null, signalBars, signalClose + 1);
  tick(state, [barAt(fillAt)], knownAt(fillAt));
  tick(state, [], knownAt(fillAt + 60));
  assert.ok(state.books.base.positions.XYZ);
  const next = barAt(fillAt + 120, candle(98.25, 99.8, 98.2, 99.7));
  tick(state, [next], knownAt(next.t));
  for (const book of Object.values(state.books)) {
    assert.equal(book.closed, 1);
    assert.equal(book.trades[0].exit, 98.25);
    assert.equal(book.trades[0].closedAt, next.t * 1000);
    assert.match(book.trades[0].why, /Data gap/);
  }
});

function plannedBook(symbols, options = {}) {
  const state = advanceDayShadows(null, { series: [], day: DAY, now: signalClose });
  for (const sym of symbols) state.books.base.pending[sym] = {
    day: DAY, fillAt, decisionAt: signalClose,
    signal: { setup: "continuation", dir: "long", stop: 99.01, rewardRisk: 2, hold: 10, closeAt: signalClose, ...options },
  };
  return state;
}
function fillPlanned(state, symbols, quote = candle(100, 100.05, 99.98, 100.01)) {
  const now = knownAt(fillAt);
  return advanceDayShadows(state, { series: symbols.map((sym) => [sym, [barAt(fillAt, quote)], now]), day: DAY, now });
}

test("same-minute orders are limited by planned stop costs, total open risk and unleveraged gross", () => {
  const three = ["A", "B", "C"];
  const byRisk = fillPlanned(plannedBook(three), three).books.base;
  assert.equal(byRisk.filled, 2);
  assert.equal(byRisk.blocked, 1);
  assert.ok(byRisk.openRisk < 120 && byRisk.openRisk > 119);
  assert.ok(Object.values(byRisk.positions).every((p) => p.plannedRisk <= 60));
  const byGross = fillPlanned(plannedBook(three, { stop: 99.94 }), three).books.base;
  assert.equal(byGross.filled, 1);
  assert.equal(byGross.positions.A.shares, 299);
  assert.ok(byGross.gross <= byGross.value);
  assert.ok(byGross.cash > 0);
});

test("ambiguous bracket exits take the stop and short accounting includes the entry allowance", () => {
  const state = plannedBook(["A"], { dir: "short", stop: 101 });
  const book = fillPlanned(state, ["A"], candle(100, 101.25, 97.9, 98.1)).books.base;
  assert.equal(book.closed, 1);
  const trade = book.trades[0];
  assert.equal(trade.exit, 101);
  assert.equal(trade.why, "Stop hit");
  assert.ok(Math.abs(trade.costs - trade.shares * (100 * 0.0006 + 101 * 0.0005)) < 1e-10);
  assert.ok(trade.pnl < 0 && -trade.pnl <= 60);
  assert.equal(state.books.fvg.cash, 30000);
});

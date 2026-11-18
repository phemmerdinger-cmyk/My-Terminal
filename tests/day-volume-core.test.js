"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const DTC = require("../daytrade-core.js");
const { VOLUME_POLICY: P, advanceVolumeTrials, volumeSymbols, volumeSummary } = require("../day-volume-core.js");

const DAY = "2026-11-18", START = Date.parse("2026-11-18T14:30:00Z") / 1_000;
const barAt = (i, overrides = {}) => ({
  t: START + i * 60, m: DTC.OPEN + i, d: DAY, o: 100, h: 100.01, l: 99.99, c: 100, ...overrides,
});
const readAt = (bar) => (bar.t + 60) * 1_000 + 500;
const draft = (sym, last, side = 1, strong = false) => ({
  sym, last, forecast: { side, mu: side * 0.1, a: 1, moveBps: strong ? 16 : 4, hurdleBps: 15, qualified: strong },
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);

function observe(state, bar, symbols, candidates = [], close = DTC.CLOSE) {
  const now = readAt(bar);
  return advanceVolumeTrials(state, { series: symbols.map((sym) => [sym, [bar], now]), day: bar.d, close, now, candidates });
}

test("a complete 100-symbol minute feed produces 1,000 distinct paper round trips within book caps", () => {
  const universe = Array.from({ length: 100 }, (_, i) => `T${String(i).padStart(2, "0")}`);
  let state;
  let maxGross = 0;
  for (let i = 0; i < DTC.CLOSE - DTC.OPEN; i++) {
    const bar = barAt(i);
    state = observe(state, bar, universe, universe.map((sym, k) => draft(sym, bar, k % 2 === 0 ? 1 : -1)));
    const summary = volumeSummary(state);
    maxGross = Math.max(maxGross, summary.grossExposure);
    assert.ok(summary.open + summary.pending <= P.maxOpen);
    assert.ok(summary.opened + summary.pending <= P.target);
    if (i === 33) state = JSON.parse(JSON.stringify(state));
  }
  const summary = volumeSummary(state);
  assert.equal(summary.opened, 1_000);
  assert.equal(summary.closed, 1_000);
  assert.equal(summary.expired, 0);
  assert.equal(summary.pending, 0);
  assert.equal(summary.open, 0);
  assert.equal(summary.status, "Session target reached");
  assert.equal(summary.costQualified, 0);
  assert.equal(maxGross, P.grossLimit);
  near(summary.costs, 210);
  near(summary.pnl, -210);
  near(summary.equity, P.capital - 210);
});

test("paper entries schedule after the decision and charge modeled costs on each side", () => {
  const first = barAt(0);
  let state = observe(null, first, ["LONG", "SHORT", "NEUTRAL"], [draft("LONG", first, 1, true),
    draft("SHORT", first, -1), draft("NEUTRAL", first, 0)]);
  assert.deepEqual(volumeSymbols(state), ["LONG", "SHORT"]);
  assert.equal(state.pending.LONG.fillAt, first.t + 120);
  assert.ok(state.pending.LONG.fillAt * 1_000 > state.pending.LONG.decisionAt);
  for (let i = 1; i <= 11; i++) state = observe(state, barAt(i), ["LONG", "SHORT", "NEUTRAL"]);
  const summary = volumeSummary(state);
  assert.equal(summary.closed, 2);
  assert.equal(summary.costQualified, 1);
  near(summary.recent.find((t) => t.direction === "long").cost, 0.20);
  near(summary.recent.find((t) => t.direction === "short").cost, 0.22);
  near(summary.pnl, -0.42);
  assert.equal(observe(state, barAt(11), ["LONG", "SHORT"]), state, "same observation cannot execute twice");
});

test("future and stale bars cannot create fills and an expired reservation frees its slot", () => {
  const first = barAt(0);
  let state = observe(null, first, ["DIA"], [draft("DIA", first)]);
  const opening = barAt(2), now = readAt(barAt(1));
  state = advanceVolumeTrials(state, { series: [["DIA", [opening], readAt(opening)]], day: DAY, close: DTC.CLOSE, now });
  assert.equal(volumeSummary(state).opened, 0);
  assert.equal(volumeSummary(state).pending, 1);
  state = observe(state, barAt(5), ["DIA"], [draft("DIA", barAt(5))]);
  const summary = volumeSummary(state);
  assert.equal(summary.opened, 0);
  assert.equal(summary.expired, 1);
  assert.equal(summary.pending, 1);
  assert.equal(state.pending.DIA.fillAt, barAt(7).t);
});

test("early close has no target and an overnight data gap does not inflate the next session count", () => {
  const first = barAt(0), close = DTC.OPEN + 12;
  let state = observe(null, first, ["IWM"], [draft("IWM", first)], close);
  assert.equal(volumeSummary(state).target, null);
  state = observe(state, barAt(2), ["IWM"], [draft("QQQ", barAt(2))], close);
  assert.equal(volumeSummary(state).opened, 1);
  assert.equal(volumeSummary(state).pending, 0);
  const next = barAt(0, { d: "2026-11-19", t: START + 86_400, o: 98, l: 97, c: 98, h: 98 });
  state = observe(state, next, ["IWM"]);
  assert.equal(state.day.closed, 0);
  assert.equal(state.sessions.at(-1).recovered, 1);
  assert.equal(state.sessions.at(-1).closed, 0);
  assert.equal(volumeSummary(state).recent[0].reason, "Data gap — closed at first freshly observed minute open");
});

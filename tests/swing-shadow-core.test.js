const { test } = require("node:test");
const assert = require("node:assert/strict");
const SW = require("../swing-shadow-core");

// Deterministic fixture: fictional symbols and values, with no external data or orders.
function sample(signalIndex = 189) {
  const days = [];
  for (let t = Date.parse("2022-01-03"); days.length <= signalIndex + 2; t += 86400_000) {
    const date = new Date(t), weekday = date.getUTCDay();
    if (weekday > 0 && weekday < 6) days.push(date.toISOString().slice(0, 10));
  }
  const bars = (slope, breakout = false) => days.map((day, i) => {
    const close = 100 + i * slope + (i === signalIndex && breakout ? 3 : 0);
    const halfRange = i >= signalIndex - 5 && i < signalIndex ? 0.3 : 2;
    return { day, open: close, high: close + halfRange, low: close - halfRange, close,
      volume: i === signalIndex && breakout ? 1600 : 1000 };
  });
  const signalDay = days[signalIndex], nextSession = days[signalIndex + 1];
  const asOf = Date.parse(`${signalDay}T23:00:00Z`);
  const barsBySymbol = {
    SPY: bars(0.04), A: bars(0.25, true), B: bars(0.08), C: bars(0.07), D: bars(0.03), E: bars(0.02),
  };
  return { barsBySymbol, signalDay, nextSession, asOf, days, signalIndex };
}

test("screen applies weekly trend, relative rank, prior-session contraction and breakout confirmation", () => {
  const input = sample();
  const result = SW.screen(input), [idea] = result.candidates;
  assert.deepEqual(result.counts, { input: 5, ranked: 5, leaders: 1, trend: 1, contraction: 1, breakout: 1, candidates: 1 });
  assert.equal(idea.symbol, "A");
  assert.equal(idea.percentile, 0.9);
  assert.equal(idea.volumeRatio, 1.6);
  assert.ok(idea.contraction < 0.65);
  const prior = input.barsBySymbol.A.slice(179, 189);
  assert.equal(idea.pivot, Math.max(...prior.map((bar) => bar.high)));
  assert.ok(idea.stop < Math.min(...prior.slice(-5).map((bar) => bar.low)));
  for (const rows of Object.values(input.barsBySymbol)) {
    for (const row of rows.filter((bar) => bar.day > input.signalDay)) {
      Object.assign(row, { high: 10000, low: 5, close: 7000, volume: 1e9 });
    }
  }
  assert.deepEqual(SW.screen(input), result);
});

test("missing symbol closes cannot be backfilled for the relative rank or breakout", () => {
  let input = sample();
  input.barsBySymbol.A.splice(input.signalIndex - 126, 1);
  assert.equal(SW.screen(input).counts.ranked, 4);
  assert.deepEqual(SW.screen(input).candidates, []);
  input = sample();
  const gapDay = input.days[input.signalIndex - 2];
  input.barsBySymbol.A = input.barsBySymbol.A.filter(({ day }) => day !== gapDay);
  const result = SW.screen(input);
  assert.equal(result.counts.trend, 1);
  assert.equal(result.counts.contraction, 0);
  assert.deepEqual(result.candidates, []);
});

test("a partial current week cannot stand in for a prior completed week", () => {
  const input = sample(188); // Thursday; the next exchange session is Friday.
  const priorFriday = 184;
  input.barsBySymbol.A[priorFriday].close = 10;
  const result = SW.screen(input);
  assert.equal(result.counts.leaders, 1);
  assert.equal(result.counts.trend, 0);
});

test("breakout volume uses the preceding median and rejects weak volume", () => {
  const input = sample();
  input.barsBySymbol.A[input.signalIndex].volume = 1499;
  assert.equal(SW.screen(input).counts.contraction, 1);
  assert.deepEqual(SW.screen(input).candidates, []);
  input.barsBySymbol.A[input.signalIndex].volume = 1500;
  assert.equal(SW.screen(input).candidates.length, 1);
});

test("the CAN SLIM ablation uses only the public vintage as of the signal", () => {
  const input = sample();
  const first = { availableAt: input.asOf - 1000, eps: 1.3, priorYearEps: 1, sales: 116, priorYearSales: 100 };
  const revised = { ...first, availableAt: input.asOf + 1000, sales: 110 };
  input.fundamentalsBySymbol = { A: [revised, first] };
  assert.equal(SW.screen(input).candidates[0].canSlim, true);
  assert.equal(SW.canSlimAt([revised, first], revised.availableAt), false);
  assert.equal(SW.canSlimAt([revised], input.asOf), null);
  assert.equal(SW.canSlimAt([{ ...first, priorYearEps: 0 }], input.asOf), false);
});

test("opening eligibility requires the scheduled session and enforces both gap bounds", () => {
  const signalDay = "2022-11-18", openDay = "2022-11-21";
  const idea = { signalDay, openDay, pivot: 100, atr: 4 };
  assert.equal(SW.entryAtOpen(idea, { day: signalDay, open: 101 }).status, "wait");
  assert.equal(SW.entryAtOpen(idea, { day: openDay }).status, "wait");
  assert.equal(SW.entryAtOpen(idea, { day: openDay, open: 99.99 }).status, "reject");
  assert.equal(SW.entryAtOpen(idea, { day: openDay, open: 102.01 }).status, "reject");
  assert.equal(SW.entryAtOpen(idea, { day: openDay, open: 100 }).referencePrice, 100);
  assert.equal(SW.entryAtOpen(idea, { day: openDay, open: 102 }).referencePrice, 102);
  assert.equal(SW.entryAtOpen(idea, { day: "2022-11-22", open: 101 }).status, "reject");
});

test("stop and gap handling come first; a new trailing level applies on the next session", () => {
  const position = { openedDay: "2022-11-21", entry: 100, initialStop: 95, stop: 95, atr: 2 };
  const make = (day, open, low, high, close) => ({ day, open, low, high, close });
  assert.equal(SW.advancePosition(position, make("2022-11-18", 105, 89, 105, 100)).exit, null);
  const initial = SW.advancePosition(position, make("2022-11-21", 100, 94, 112, 111));
  assert.equal(initial.exit.referencePrice, 95);
  const gap = SW.advancePosition(position, make("2022-11-22", 93, 91, 104, 103));
  assert.deepEqual(gap.exit, { referencePrice: 93, reason: "Gap through stop" });
  const bar = make("2022-11-21", 100, 96, 112, 111);
  const { position: trailed, exit } = SW.advancePosition(position, bar);
  assert.equal(exit, null);
  assert.equal(trailed.stop, 107);
  assert.equal(SW.advancePosition(trailed, bar).exit, null);
  assert.equal(SW.advancePosition(trailed, make("2022-11-22", 105, 104, 114, 112)).exit.referencePrice, 105);
});

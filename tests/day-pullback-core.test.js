"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const DTC = require("../daytrade-core.js");
const { PULLBACK, findPullback, findMomentum, openPullback } = require("../day-pullback-core.js");

const DAY = "2026-11-18";
const BELL = Date.parse(DAY + "T14:30:00Z") / 1000;
const bar = (minute, o, h, l, c, v = 1_000) => ({
  t: BELL + minute * 60, m: DTC.OPEN + minute, d: DAY, o, h, l, c, v,
});
const sealedAt = (bar) => (bar.t + 60) * 1000 + 500;

function reversal({ nearVwap = false } = {}) {
  const shelf = nearVwap ? 99.95 : 99.50;
  const bars = Array.from({ length: 17 }, (_, i) => {
    const center = i < 12 ? 100 : shelf;
    return bar(i, center, center + 0.02, center - 0.02, center);
  });
  bars.push(bar(17, shelf, shelf + 0.03, shelf - 0.18, shelf - 0.04, 2_000));
  bars.push(bar(18, shelf - 0.05, shelf + 0.06, shelf - 0.06, shelf + 0.04, 1_200));
  return bars;
}

function find(bars, options = {}) {
  return findPullback("QQQ", bars, { day: DAY, now: sealedAt(bars.at(-1)), ...options });
}

test("the long and mirrored short require separate exhaustion and reclaim bars", () => {
  const bars = reversal();
  assert.equal(find(bars.slice(0, -1)), null);
  const long = find(bars);
  const mirror = bars.map((b) => ({ ...b, o: 200 - b.o, h: 200 - b.l, l: 200 - b.h, c: 200 - b.c }));
  const short = find(mirror);
  assert.equal(long.dir, "long");
  assert.equal(short.dir, "short");
  assert.equal(long.target, DTC.vwap(bars.slice(0, -2)));
  assert.equal(short.target, DTC.vwap(mirror.slice(0, -2)));
  assert.ok(long.stop < bars.at(-2).l && long.target > long.entry);
  assert.ok(short.stop > mirror.at(-2).h && short.target < short.entry);
  assert.ok(long.grossTargetBps >= PULLBACK.minGrossCostX * long.costBps);
  assert.ok(short.costBps > long.costBps, "shorts include the borrow allowance");
});

test("a stretched wick, missing bars, or inadequate room do not qualify", () => {
  const bars = reversal();
  const last = bars.at(-1);
  assert.equal(find([...bars.slice(0, -1), { ...last, o: last.c }]), null, "confirmation must move in the reclaim direction");
  assert.equal(find([...bars.slice(0, 3), ...bars.slice(4)]), null, "partial same-session VWAP is rejected");
  assert.equal(find(bars.slice(1)), null, "history must start at the bell");
  assert.equal(find(bars, { now: sealedAt(last) + 90_000 }), null, "stale confirmation is rejected");
  assert.equal(find(bars, { now: sealedAt(last) - 600 }), null, "the confirmation must be sealed");
  assert.equal(find(reversal({ nearVwap: true })), null, "the reclaim still needs enough price room above costs");
  assert.equal(find(bars, { minGrossCostX: 4 }), null);
  assert.equal(findPullback("AAPL", bars, { day: DAY, now: sealedAt(last) }), null);
});

test("only the scheduled future open can fill, and it preserves the reference bracket", () => {
  const bars = reversal(), last = bars.at(-1), idea = find(bars);
  const decisionAt = sealedAt(last);
  const fillAt = DTC.paperEntryMinute(last, decisionAt, DTC.CLOSE, 90, PULLBACK.holdMinutes);
  const order = { day: DAY, decisionAt, fillAt, idea };
  const opening = bar(20, 99.53, 99.61, 99.52, 99.56);
  const filled = openPullback(order, opening, { now: sealedAt(opening) });
  assert.equal(fillAt, opening.t);
  assert.deepEqual(filled, { entry: opening.o, stop: idea.stop, target: idea.target, at: opening.t * 1000 });
  assert.equal(openPullback(order, last, { now: decisionAt }), null);
  assert.equal(openPullback(order, opening, { now: opening.t * 1000 + 1 }), null);
  assert.equal(openPullback(order, opening, { now: sealedAt(opening) + 90_000 }), null);

  const gap = (price) => bar(20, price, price + 0.01, price - 0.01, price);
  assert.equal(openPullback(order, gap(idea.target - 0.05), { now: sealedAt(opening) }), null, "gapping toward VWAP erases room");
  assert.equal(openPullback(order, gap(idea.stop - 0.01), { now: sealedAt(opening) }), null, "gapping through the stop invalidates the bracket");
});

function momentumBars(side) {
  return Array.from({ length: 6 }, (_, i) => {
    const price = 100 + side * i * 0.03;
    return bar(i + 20, price, price + 0.02, price - 0.02, price);
  });
}

const forecastFor = (side, overrides = {}) => ({ day: DAY, side, qualified: true, a: 0.4, moveBps: 25, ...overrides });
const evaluateMomentum = (bars, forecast, options = {}) =>
  findMomentum(bars, forecast, { day: DAY, now: sealedAt(bars.at(-1)), ...options });

test("confirmed momentum checks both time windows, applies costs, and caps the stop", () => {
  const long = evaluateMomentum(momentumBars(1), forecastFor(1));
  const short = evaluateMomentum(momentumBars(-1), forecastFor(-1, { a: 0.01 }));
  assert.equal(long.kind, "momentum-confirmed");
  assert.equal(short.dir, "short");
  assert.equal(long.stopDistance, long.targetDistance * 0.65);
  assert.equal(short.stopDistance, short.entry * 0.0008);
  assert.ok(long.target > long.entry && long.entry > long.stop);
  assert.ok(short.target < short.entry && short.entry < short.stop);
  assert.equal(evaluateMomentum(momentumBars(-1), forecastFor(-1, { moveBps: 21 })), null, "short allowance increases modeled costs");
  assert.equal(evaluateMomentum(momentumBars(1), forecastFor(1, { qualified: false })), null);
  assert.equal(evaluateMomentum(momentumBars(1), forecastFor(-1)), null);
  const bars = momentumBars(1);
  const last = bars.at(-1);
  assert.equal(evaluateMomentum([...bars.slice(0, -1), { ...last, c: bars.at(-2).c + 0.015, l: bars.at(-2).c - 0.001 }], forecastFor(1))?.dir, "long");
  bars[4] = { ...bars[4], c: last.c + 0.01, h: last.c + 0.02 };
  assert.equal(evaluateMomentum(bars, forecastFor(1)), null, "a five-minute rise cannot excuse a falling last close");
});

test("confirmed momentum rejects stale, incomplete, or unsealed bars and rechecks the scheduled open", () => {
  const bars = momentumBars(1), last = bars.at(-1), forecast = forecastFor(1);
  const idea = evaluateMomentum(bars, forecast);
  assert.equal(evaluateMomentum(bars.slice(1), forecast), null);
  assert.equal(evaluateMomentum(bars.map((b, i) => i === 2 ? { ...b, v: 0 } : b), forecast), null);
  assert.equal(evaluateMomentum(bars, forecast, { now: sealedAt(last) - 600 }), null);
  assert.equal(evaluateMomentum(bars, forecast, { now: sealedAt(last) + 90_000 }), null);
  const decisionAt = sealedAt(last);
  const fillAt = DTC.paperEntryMinute(last, decisionAt, DTC.CLOSE, 90, PULLBACK.holdMinutes);
  const open = (px) => bar(27, px, px + 0.02, px - 0.02, px);
  const order = { day: DAY, decisionAt, fillAt, idea };
  const opening = open(idea.entry);
  assert.deepEqual(openPullback(order, opening, { now: sealedAt(opening) }),
    { entry: idea.entry, stop: idea.stop, target: idea.target, at: fillAt * 1000 });
  assert.equal(openPullback(order, open(idea.target - 0.01), { now: sealedAt(opening) }), null);
});

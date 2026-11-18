"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const DTC = require("../daytrade-core.js");
const { PULLBACK, findPullback, openPullback } = require("../day-pullback-core.js");

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

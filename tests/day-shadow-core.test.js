const { test } = require("node:test");
const assert = require("node:assert/strict");
const shadow = require("../day-shadow-core.js");

const DAY = "2026-11-18", PRIOR_DAY = "2026-11-17", OPEN = 9 * 60 + 30, START = 1_800_000_000;
const candle = (o, h, l, c, v = 1000) => ({ o, h, l, c, v });
function minuteBars(candles) {
  return candles.flatMap((bar, i) => Array.from({ length: 5 }, (_, j) => ({
    ...bar, d: DAY, t: START + (i * 5 + j) * 60, m: OPEN + i * 5 + j,
  })));
}
const readyAt = (count) => (START + count * 300) * 1000;
function context(count, options = {}) { return { day: DAY, asOf: readyAt(count), ...options }; }
const warmup = (prices) => prices.map((c, i) => ({ ...candle(c, c + 0.1, c - 0.1, c), d: PRIOR_DAY, t: START - 86400 + i * 300, m: OPEN + i * 5 }));
const rangeWarmup = warmup(Array.from({ length: 70 }, (_, i) => 100 + (i % 2 ? -0.1 : 0.1)));
let trendPrice = 89;
const trendWarmup = warmup(Array.from({ length: 55 }, (_, i) => (trendPrice += i % 4 === 3 ? -0.3 : 0.25)));

test("folds only sealed, contiguous five-minute bars and freezes the first 15-minute range", () => {
  const bars = minuteBars([candle(100, 101, 99, 100), candle(100, 102, 98, 101), candle(101, 103, 99, 102), candle(102, 114, 92, 108)]);
  assert.equal(shadow.foldFiveMinute(bars, { day: DAY, asOf: readyAt(1) - 1 }).length, 0);
  assert.equal(shadow.foldFiveMinute(bars, context(1)).length, 1);
  assert.equal(shadow.foldFiveMinute(bars, { day: DAY }).length, 0);
  assert.equal(shadow.evaluate(bars, context(2)).diagnostics.openingRange, null);
  assert.deepEqual(shadow.evaluate(bars, context(4)).diagnostics.openingRange, { high: 103, low: 98 });
  const gap = shadow.evaluate(bars.filter((b) => b.m !== OPEN + 8), context(4));
  assert.equal(gap.diagnostics.openingRange, null);
  assert.equal(gap.diagnostics.latest.vwap, null);
  assert.equal(gap.diagnostics.vwapComplete, false);
});

test("ADX warms only from allowed past bars and cannot score incomplete current bars", () => {
  const daybars = minuteBars([candle(100, 101, 99, 100), candle(100, 101, 99, 100)]);
  const future = trendWarmup.map((bar) => ({ ...bar, d: DAY }));
  const cold = shadow.evaluate(daybars, context(1, { warmup: future }));
  assert.equal(cold.diagnostics.warmupBars, 0);
  assert.equal(cold.diagnostics.latest.adx, null);
  const ready = shadow.evaluate(daybars, context(1, { warmup: trendWarmup }));
  assert.equal(ready.diagnostics.closedFiveMinuteBars, 1);
  assert.equal(ready.diagnostics.warmupBars, trendWarmup.length);
  assert.ok(ready.diagnostics.latest.adx > 30);
});

test("continuation requires an opening-range breakout, EMA20 pullback, then a separate confirmation", () => {
  const bars = minuteBars([
    candle(95.5, 95.6, 95.4, 95.5), candle(95.7, 96.1, 95.6, 96), candle(96, 96.6, 95.9, 96.5),
    candle(96.8, 98.3, 96.7, 98.2), candle(97.2, 97.5, 94.9, 97.2), candle(97.4, 99, 97.3, 98.5),
  ]);
  const scan = (count) => shadow.evaluate(bars, context(count, { warmup: trendWarmup }));
  assert.equal(scan(3).diagnostics.continuationState, null);
  assert.equal(scan(4).diagnostics.continuationState, "long");
  assert.deepEqual(scan(4).signals, []);
  assert.deepEqual(scan(5).signals, []);
  const next = scan(6), [signal] = next.signals;
  assert.equal(signal.setup, "continuation");
  assert.equal(signal.dir, "long");
  assert.equal(signal.closeAt, readyAt(6));
  assert.equal(signal.hold, 10);
  assert.equal(signal.stop, 94.9 - 0.1 * next.diagnostics.latest.atr);
  assert.equal(signal.target, signal.reference + 2 * (signal.reference - signal.stop));
  assert.deepEqual(shadow.bracketAtFill(signal, 99), { stop: signal.stop, target: 99 + 2 * (99 - signal.stop) });
  assert.equal(shadow.bracketAtFill(signal, signal.stop), null);
});

const prior = { d: PRIOR_DAY, o: 103.9, h: 104, l: 99.5, c: 99.6 };
const fade = [
  candle(100.3, 100.4, 100.2, 100.3, 5000), candle(100.2, 100.3, 100.1, 100.2, 5000),
  candle(99.1, 99.3, 98.9, 99), candle(99.2, 99.4, 99.1, 99.3), candle(99.45, 99.7, 99.44, 99.65),
];
const fadeInput = { warmup: rangeWarmup, prior };

test("80–20 uses prior session, a confirmed breach/reclaim, low ADX and a nearer VWAP target", () => {
  const bars = minuteBars(fade);
  const before = shadow.evaluate(bars, context(4, fadeInput));
  assert.equal(before.diagnostics.sweptExtreme, 98.9);
  assert.deepEqual(before.signals, []);
  const outcome = shadow.evaluate(bars, context(5, fadeInput));
  const [signal] = outcome.signals;
  assert.ok(outcome.diagnostics.latest.adx < 18);
  assert.equal(signal.setup, "80-20-reclaim");
  assert.equal(signal.dir, "long");
  assert.equal(signal.target, outcome.diagnostics.latest.vwap);
  assert.equal(signal.stop, 98.9 - 0.1 * outcome.diagnostics.latest.atr);
  assert.equal(shadow.bracketAtFill(signal, signal.target), null, "VWAP cannot lie behind the actual entry");
  assert.deepEqual(shadow.evaluate(bars, context(5, { warmup: trendWarmup, prior })).signals, []);
  assert.deepEqual(shadow.evaluate(bars, context(5, { ...fadeInput, prior: { ...prior, d: DAY } })).signals, []);
  const behindVwap = minuteBars(fade.map((bar, i) => i === 2 ? { ...bar, v: 1_000_000 } : bar));
  assert.deepEqual(shadow.evaluate(behindVwap, context(5, fadeInput)).signals, []);
});

test("FVG confirmation is a separate optional variant, with the bearish rule mirrored", () => {
  const normal = shadow.evaluate(minuteBars(fade), context(5, fadeInput));
  const withFvg = shadow.evaluate(minuteBars(fade), context(5, { ...fadeInput, includeFvg: true }));
  assert.deepEqual(normal.signals, withFvg.signals);
  assert.deepEqual(normal.variants, []);
  assert.deepEqual(withFvg.variants, [{ ...normal.signals[0], variant: "fvg" }]);
  const mirror = (bar) => ({ ...bar, o: 200 - bar.o, h: 200 - bar.l, l: 200 - bar.h, c: 200 - bar.c });
  const short = shadow.evaluate(minuteBars(fade.map(mirror)), context(5, { prior: mirror(prior), warmup: rangeWarmup.map(mirror), includeFvg: true }));
  assert.equal(short.signals[0].dir, "short");
  assert.equal(short.variants[0].dir, "short");
  assert.ok(Math.abs(short.signals[0].stop - (200 - normal.signals[0].stop)) < 1e-9);
});

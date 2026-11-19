"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { applyTrade, mergeQuote } = require("../public/quote-stream-core.js");

const regularSession = { start: 10_000, end: 30_000 };
const quote = () => ({ symbol: "ANT", regularSession, price: 100, marketTime: 15_000, prevClose: 100,
  dayHigh: 103, dayLow: 95, spark: [99, 100], preMarket: { price: 98, marketTime: 9_000 } });

test("accepted regular trades update price, range, spark and change without touching the snapshot", () => {
  const original = quote();
  const next = applyTrade(original, { p: 110, t: 16_000 }, 16_100);
  assert.equal(next.marketTime, 16_000);
  assert.equal(next.price, 110);
  assert.equal(next.change, 10);
  assert.equal(next.changePct, 10);
  assert.equal(next.streamed, true);
  assert.equal(next.dayHigh, 110);
  assert.equal(next.dayLow, 95);
  assert.deepEqual(next.spark, [99, 110]);
  assert.deepEqual(original, quote());
});

test("old, future and extended trades or malformed prices and volumes leave the quote untouched", () => {
  const original = quote();
  const trades = [
    { p: 111, t: 14_000 }, { p: 111, t: 31_000 }, { p: 111, t: 30_000 },
    { p: 111, t: 9_999 }, { p: 111, t: 32_001 }, { p: 0, t: 16_000 },
    { p: 111, t: Number.NaN }, { p: 111, t: 16_000, v: 0 }, { p: 111, t: 16_000, volume: Infinity },
  ];
  for (const trade of trades) assert.equal(applyTrade(original, trade, 32_000), original);
});

test("same-session IPO print fills the awaited quote with no fabricated prior close", () => {
  const pending = { symbol: "ANT", regularSession, price: null, marketTime: 0, prevClose: null, status: "awaiting-market-print" };
  const trade = { p: 105, t: 16_000, v: 4 };
  const before = { ...pending, regularSession: undefined };
  assert.equal(applyTrade(before, trade, 16_100), before);
  assert.equal(applyTrade(pending, { ...trade, t: 9_999 }, 16_100), pending);
  assert.equal(applyTrade(pending, trade, 30_001), pending);
  const next = applyTrade(pending, trade, 16_100);
  assert.equal(next.price, 105);
  assert.equal(next.dayHigh, 105);
  assert.equal(next.dayLow, 105);
  assert.equal(next.change, null);
  assert.equal(next.changePct, null);
  assert.equal(next.status, undefined);
  assert.equal(pending.status, "awaiting-market-print");
});

test("merges the latest streamed regular price with refreshed baseline and extended snapshots", () => {
  const current = applyTrade(quote(), { p: 110, t: 16_000 }, 17_000);
  const incoming = { ...quote(), price: 106, marketTime: 15_999, prevClose: 80,
    dayHigh: 108, dayLow: 94, postMarket: { price: 113, marketTime: 32_000 }, spark: [97, 101, 106] };
  const merged = mergeQuote(current, incoming);
  assert.equal(merged.streamed, true);
  assert.equal(merged.marketTime, 16_000);
  assert.equal(merged.price, 110);
  assert.equal(merged.change, 30);
  assert.equal(merged.changePct, 37.5);
  assert.equal(merged.dayHigh, 110);
  assert.equal(merged.dayLow, 94);
  assert.deepEqual(merged.spark, [97, 101, 110]);
  assert.equal(merged.postMarket, incoming.postMarket);
  assert.deepEqual(incoming.spark, [97, 101, 106]);
});

test("keeps a usable stream through snapshot failure and resets it on a newer or new-session snapshot", () => {
  const current = applyTrade(quote(), { p: 110, t: 16_000 }, 17_000);
  assert.equal(mergeQuote(current, { symbol: "ANT", error: true }), current);
  assert.equal(mergeQuote(current, null), current);
  const newer = { ...quote(), marketTime: 16_000, price: 108 };
  assert.equal(mergeQuote(current, newer), newer);
  const tomorrow = { ...quote(), regularSession: { start: 100_000, end: 120_000 }, price: 110 };
  assert.equal(mergeQuote(current, tomorrow), tomorrow);
  assert.equal(mergeQuote(current, tomorrow).streamed, undefined);
});

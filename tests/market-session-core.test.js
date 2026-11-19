"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { getExtendedQuotes } = require("../market-session-core.js");

const asMs = (time, day = "2026-11-19") => Date.parse(`${day}T${time}:00Z`);
const asSeconds = (time, day) => asMs(time, day) / 1000;
const bounds = (start, end) => ({ start: asSeconds(start), end: asSeconds(end), gmtoffset: -18_000 });
const meta = (overrides = {}) => ({
  exchangeTimezoneName: "America/New_York",
  chartPreviousClose: 100,
  regularMarketPrice: 125,
  regularMarketTime: asSeconds("21:00"),
  currentTradingPeriod: { pre: bounds("09:00", "14:30"), regular: bounds("14:30", "21:00"), post: bounds("21:00", "23:59") },
  ...overrides,
});
const candles = (sample) => [sample.map(([time]) => typeof time === "number" ? time : asSeconds(time)),
  { close: sample.map(([, price]) => price), volume: sample.map(([, , volume]) => volume) }];
const get = (sample, options = {}, overrides = {}) => getExtendedQuotes(meta(overrides), ...candles(sample), {
  now: asMs("22:15"), ...options,
});
const none = { preMarket: null, postMarket: null };

test("selects a same-day pre-market price without reported volume and excludes future and regular candles", () => {
  const sample = [
    ["11:00", 110, 0], ["10:00", 102, 10], ["11:05", 0, 0], ["11:10", null, null],
    ["11:20", null, 10], ["11:55", 130, 10], ["14:30", 113, 100],
    [asSeconds("21:15", "2026-11-18"), 80, 40],
  ];
  const pre = get(sample, { now: asMs("11:40") });
  assert.deepEqual(pre, { preMarket: { price: 110, marketTime: asMs("11:00"), change: 10, changePct: 10 }, postMarket: null });
});

test("after-hours change uses the same regular close, never the prior close", () => {
  const data = get([
    ["14:40", 124, 100], ["20:55", 124, 100], ["21:00", 130, 80],
    ["22:00", 135, 0], ["22:20", 140, 10], ["22:10", 0, 0], ["23:59", 140, 10],
  ]);
  assert.equal(data.preMarket, null);
  assert.deepEqual(data.postMarket, { price: 135, marketTime: asMs("22:00"), change: 10, changePct: 8 });
});

test("a regular candle in the closing bucket substitutes for stale quote metadata", () => {
  const sample = [["20:55", 128, 20], ["22:10", 136, 20]];
  const data = get(sample, {}, { regularMarketTime: asSeconds("21:00", "2026-11-18") });
  assert.deepEqual(data.postMarket, { price: 136, marketTime: asMs("22:10"), change: 8, changePct: 6.25 });
  const withoutClose = get([["18:00", 128, 20], sample[1]], {}, { regularMarketTime: null });
  assert.deepEqual(withoutClose.postMarket, { price: 136, marketTime: asMs("22:10"), change: null, changePct: null });
});

test("a one-minute IPO quote uses only the final minute to establish its after-hours reference", () => {
  const extended = ["21:10", 99, 0];
  const earlier = get([["20:55", 90, 10], extended], { debut: true, barSeconds: 60 });
  assert.equal(earlier.postMarket.change, null);
  const closing = get([["20:59", 90, 10], extended], { debut: true, barSeconds: 60 });
  assert.equal(closing.postMarket.change, 9);
});

test("rejects prior-day segments and inconsistent windows", () => {
  assert.deepEqual(get([["21:10", 130, 10]], { now: asMs("10:05", "2026-11-20") }), none);
  assert.deepEqual(get([["21:10", 130, 10]], { now: asMs("20:00") }), none);
  assert.deepEqual(get([["13:20", 110, 10], ["20:50", 130, 10]], {}, {
    currentTradingPeriod: { pre: bounds("09:00", "15:00"), regular: bounds("14:30", "21:00"), post: bounds("20:45", "23:59") },
  }), none);
});

test("an IPO offer without a confirmed regular print cannot become an extended quote", () => {
  const book = [["12:00", 83, 60], ["15:20", 83, 0], ["21:10", 99, 30]];
  assert.deepEqual(get(book, { debut: true }, { regularMarketPrice: 83, regularMarketVolume: 1 }), none);
  book.push(["20:55", 90, 10]);
  const data = get(book, { debut: true }, { regularMarketPrice: 83 });
  assert.equal(data.preMarket, null);
  assert.deepEqual(data.postMarket, { price: 99, marketTime: asMs("21:10"), change: 9, changePct: 10 });
});

test("uses vendor early close and UTC offset when no named timezone is supplied", () => {
  const trading = { pre: bounds("09:00", "14:30"), regular: bounds("14:30", "18:00"), post: bounds("18:00", "22:00") };
  const { preMarket, postMarket } = get([["13:30", 102, 25], ["17:55", 100, 50], ["18:00", 104, 50]], {}, {
    exchangeTimezoneName: undefined, currentTradingPeriod: trading, regularMarketTime: null, chartPreviousClose: null,
  });
  assert.deepEqual(preMarket, { price: 102, marketTime: asMs("13:30"), change: null, changePct: null });
  assert.deepEqual(postMarket, { price: 104, marketTime: asMs("18:00"), change: 4, changePct: 4 });
});

test("preserves the same exchange date across UTC midnight without crossing the session end", () => {
  const trading = meta().currentTradingPeriod;
  trading.post = { ...trading.post, end: asSeconds("01:00", "2026-11-20") };
  const beforeClose = asSeconds("00:55", "2026-11-20"), afterClose = asSeconds("01:00", "2026-11-20");
  const data = get([["20:55", 124, 100], [beforeClose, 135, 10], [afterClose, 140, 50]], {
    now: asMs("01:20", "2026-11-20"),
  }, { currentTradingPeriod: trading });
  assert.deepEqual(data.postMarket, { price: 135, marketTime: beforeClose * 1000, change: 10, changePct: 8 });
});

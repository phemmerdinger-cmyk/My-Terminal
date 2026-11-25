const test = require("node:test");
const assert = require("node:assert/strict");
const TH = require("../thesis-core.js");
const RISK = require("../risk-core.js");

const strong = { mom: 0.12, news: 1.5, adj: 0.8, health: { grade: "A" }, ratios: { score: 0.3 }, spider: { adj: 0.03 } };

test("a buy records the reasons that were true, and needs at least two", () => {
  const t = TH.atBuy(strong, 1000);
  assert.deepEqual(t.pillars, ["momentum", "news", "analysts", "health", "ratios", "spider"]);
  assert.equal(t.at, 1000); assert.equal(t.labels.length, 6);
  assert.equal(TH.atBuy({ mom: 0.1 }), null, "one reason is not a thesis");
  assert.equal(TH.atBuy({}), null);
});

test("the thesis breaks only when at least two, and at least half, of its reasons are gone", () => {
  const t = TH.atBuy({ mom: 0.1, news: 1.2, adj: 0.7 });
  assert.equal(TH.check(t, { mom: 0.05, news: 0, adj: 0.6 }).broken, false, "weaker is not gone");
  assert.equal(TH.check(t, { mom: -0.05, news: 0, adj: 0.6 }).broken, false, "one gone");
  const c = TH.check(t, { mom: -0.05, news: -1.5, adj: 0.6 });
  assert.equal(c.broken, true); assert.deepEqual(c.gone, ["momentum", "news"]);
  assert.match(c.reason, /^Thesis broken: bought for rising over 3 months, good news, analysts positive; now 3-month return now -5%, news turned negative/);
  const six = TH.atBuy(strong);
  assert.equal(TH.check(six, { ...strong, mom: -0.1, news: -2 }).broken, false, "2 of 6 is not half");
  assert.equal(TH.check(six, { ...strong, mom: -0.1, news: -2, adj: 0 }).broken, true, "3 of 6 is half");
});

test("missing data never counts as a broken reason", () => {
  const t = TH.atBuy(strong);
  assert.equal(TH.check(t, { mom: null, news: null, adj: null, health: null, ratios: null, spider: null }).broken, false);
  assert.equal(TH.check(null, strong).broken, false);
  assert.equal(TH.check(t, null).broken, false);
});

test("volatility sizing: calmer stocks get bigger slots, within 2/3x to 1.5x", () => {
  assert.equal(RISK.volSize(0.3, 0.3), 1);
  assert.equal(RISK.volSize(0.2, 0.3), 1.5);
  assert.equal(RISK.volSize(0.1, 0.3), 1.5, "capped");
  assert.equal(RISK.volSize(0.6, 0.3), 0.667, "floored at 2/3");
  assert.equal(RISK.volSize(0.4, 0.3), 0.75);
  assert.equal(RISK.volSize(null, 0.3), 1, "unknown volatility gets an equal slot");
  assert.equal(RISK.volSize(0.3, null), 1);
  assert.equal(RISK.median([0.3, 0.1, 0.2]), 0.2);
  assert.equal(RISK.median([0.4, 0.1, 0.2, 0.3]), 0.25);
  assert.equal(RISK.median([null, 0]), null);
});

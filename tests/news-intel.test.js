"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const intel = require("../public/news-intel.js");
const NOW = Date.parse("2026-11-14T17:00:00Z");
const ctx = {
  now: NOW,
  portfolios: [{ id: "growth", holdings: [{ symbol: "NVDA", shares: 12 }, { symbol: "AMD", shares: 0 }] }],
  watchlist: ["AAPL", "AMD"]
};
const item = (id, title, tickers = [], source = "cnbc", ageHours = 2) => ({
  id, title, tickers, source, link: "https://example.com/" + id, time: NOW - ageHours * 3600000
});

test("direct holdings rank ahead of watchlist and unrelated news", () => {
  const a = item("hold", "Nvidia announces new chips at conference", ["NVDA"]);
  const b = item("watch", "Apple releases quarterly report today", ["AAPL"]);
  const c = item("general", "Markets prepare for the coming week");
  const out = intel.prioritize([c, b, a], ctx);
  assert.deepEqual(out.map((x) => x.id), ["hold", "watch", "general"]);
  assert.equal(out[0]._priority.level, "Holding");
  assert.match(out[0]._priority.reasons.join(" "), /You hold NVDA/);
});

test("zero-share positions are not described as current holdings", () => {
  const x = intel.explain(item("amd", "AMD stock rises after earnings", ["AMD"]), ctx);
  assert.deepEqual(x.owned, []);
  assert.deepEqual(x.watched, ["AMD"]);
  assert.equal(x.level, "Watchlist");
});

test("matching titles from different publishers are grouped with source attribution", () => {
  const a = item("a", "Federal Reserve announces monetary policy decision", ["JPM"], "cnbc");
  const b = item("b", "Federal Reserve announces monetary policy decision - Yahoo Finance", ["JPM"], "yahoo");
  const out = intel.prioritize([a, b], ctx);
  assert.equal(out.length, 1);
  assert.deepEqual(new Set([out[0].source, ...out[0].also.map((s) => s.source)]), new Set(["cnbc", "yahoo"]));
  assert.match(out[0]._priority.reasons.join(" "), /2 sources/);
});

test("similar headlines about different tickers must stay separate", () => {
  const a = item("a", "Company announces quarterly financial results today", ["NVDA"]);
  const b = item("b", "Company announces quarterly financial results today", ["AAPL"]);
  assert.equal(intel.sameStory(a, b), false);
  assert.equal(intel.prioritize([a, b], ctx).length, 2);
});

test("same headline weeks apart is not deduplicated", () => {
  const a = item("a", "Federal Reserve announces monetary policy decision", [], "official", 1);
  const b = item("b", "Federal Reserve announces monetary policy decision", [], "official", 200);
  assert.equal(intel.sameStory(a, b), false);
});

test("official primary sources receive a transparent reason, not a trading prediction", () => {
  const x = intel.explain(item("fed", "Federal Reserve publishes monetary policy update", [], "official"), ctx);
  assert.equal(x.level, "Official");
  assert.match(x.reasons.join(" "), /Official primary source/);
  assert.equal("priceTarget" in x, false);
  assert.equal("buySignal" in x, false);
});

test("ranking does not mutate the original feed or fabricate data", () => {
  const a = item("a", "Nvidia announces new chips at conference", ["NVDA"]);
  const b = item("b", "Nvidia announces new chips at conference", ["NVDA"], "yahoo");
  const original = JSON.stringify([a, b]);
  const out = intel.prioritize([a, b], ctx);
  assert.equal(JSON.stringify([a, b]), original);
  assert.equal(out.length, 1);
  assert.deepEqual(intel.prioritize(null, ctx), []);
  assert.deepEqual(intel.prioritize([], ctx), []);
});

test("reader loads the shared intelligence module and preserves the #newss deep link", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const reader = fs.readFileSync(path.join(__dirname, "..", "public", "reader.js"), "utf8");
  assert.ok(html.includes('<script src="/news-intel.js" defer></script>'));
  assert.ok(html.indexOf('src="/news-intel.js"') < html.indexOf('src="/reader.js"'));
  assert.ok(html.includes('({newss:"news",'), "the old #newss deep link still opens News");
  assert.match(reader, /\["priority", "For you"\]/);
  assert.match(reader, /window\.MDNewsIntel\.prioritize/);
});

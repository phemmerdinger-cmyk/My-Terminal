"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createListingCatalog, REFRESH_MS } = require("../listing-catalog.js");

const sec = { fields: ["cik", "name", "ticker", "exchange"], data: [[1, "Example Corporation", "EXM", "Nasdaq"]] };
const nasdaq = (symbols, time) => [
  "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
  ...symbols.map((s) => `${s}|Company ${s} Common Stock|Q|N|N|100|N|N`),
  `File Creation Time: ${time}|||||||`,
].join("\n");
const other = [
  "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
  "OCO|Other Company Class A|N|OCO|N|100|N|OCO",
  "File Creation Time: 1119202610:00|||||||",
].join("\n");

test("directory refresh discovers new symbols, preserves older matches and records a durable baseline", async () => {
  let time = Date.parse("2026-11-19T15:00:00Z"), stored, reads = 0, writes = 0;
  let current = nasdaq(["EXM"], "1119202610:00");
  const opts = {
    now: () => time,
    store: { get: async () => stored, set: async (_, next) => { stored = structuredClone(next); writes++; } },
    feeds: { sec: async () => sec, otherListed: async () => other, nasdaqListed: async () => { reads++; return current; } },
  };
  const catalog = createListingCatalog(opts);
  await Promise.all([catalog.refresh(), catalog.refresh()]);
  assert.equal(reads, 1);
  assert.equal(catalog.search("EXM")[0].name, "Example Corporation");
  assert.deepEqual(catalog.recent(), []);
  await catalog.refresh();
  assert.equal(reads, 1);

  time += REFRESH_MS;
  current = nasdaq(["EXM", "NEW"], "1119202610:30");
  await catalog.refresh();
  assert.equal(catalog.search("NEW")[0].symbol, "NEW");
  assert.deepEqual(catalog.recent().map((r) => r.symbol), ["NEW"]);
  const newAt = catalog.recent()[0].newlyObservedAt;

  time += REFRESH_MS;
  current = nasdaq(["EXM"], "1119202610:00");
  await catalog.refresh();
  assert.equal(catalog.recent()[0].newlyObservedAt, newAt, "an older exchange file cannot rewind the catalog");
  assert.equal(writes, 2);

  current = nasdaq(["EXM", "NEW"], "1119202610:30");
  const restarted = createListingCatalog(opts);
  await restarted.refresh();
  assert.equal(restarted.recent()[0].newlyObservedAt, newAt);
  assert.equal(writes, 2, "stable exchange rows do not trigger extra writes");
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildListingCatalog, searchListingCatalog, recentListingCatalog } = require("../listing-catalog-core.js");

const stamp = "File Creation Time: 1119202612:30";
const nasdaqHeader = "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares";
const otherHeader = "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol";
const file = (header, rows, complete = true) => [header, ...rows, ...(complete ? [stamp + "|||||||"] : [])].join("\n");
const sec = {
  fields: ["ticker", "exchange", "cik", "name"],
  data: [
    ["BRK-B", "NYSE", 1067983, "Berkshire Hathaway Inc."],
    ["BRK.A", "NYSE", 1067983, "Berkshire Hathaway Inc."],
    ["AAPL", "Nasdaq", 320193, "Apple Inc."],
    ["ABCD", "OTC", 1, "Unlisted Corp."],
  ],
};
const nasdaqRows = ["AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N", "ZVZZT|Test Issue|Q|Y|N|100|N|N"];
const otherRows = [
  "BRK.B|Berkshire Hathaway Inc. New Common Stock|N|BRK.B|N|40|N|BRK.B",
  "BRK.A|Berkshire Hathaway Inc. Common Stock|N|BRK.A|N|1|N|BRK.A",
  "ACME.W|Acme Redeemable Warrants|N|ACME.WS|N|100|N|ACME+",
  "FUND|Public Index ETF|P|FUND|Y|100|N|FUND",
];

test("the catalog merges official issuer and listing records without replacing directory identifiers", () => {
  const catalog = buildListingCatalog({ sec, nasdaqListed: file(nasdaqHeader, nasdaqRows),
    otherListed: file(otherHeader, otherRows), observedAt: 1_000 });
  assert.equal(catalog.entries.length, 5);
  assert.equal(catalog.entries.filter((row) => row.symbol === "BRK.B").length, 1);
  const [b] = searchListingCatalog(catalog, "brk-b");
  assert.equal(b.symbol, "BRK.B");
  assert.equal(b.providerSymbol, "BRK-B");
  assert.equal(b.directorySymbol, "BRK.B");
  assert.equal(b.nasdaqSymbol, "BRK.B");
  assert.equal(b.name, "Berkshire Hathaway Inc.");
  assert.equal(b.cik, 1067983);
  assert.deepEqual(b.sources, ["SEC EDGAR", "Nasdaq Trader"]);
  assert.equal(searchListingCatalog(catalog, "ACME+")[0].nasdaqSymbol, "ACME+");
  assert.equal(searchListingCatalog(catalog, "ACME.WS")[0].directorySymbol, "ACME.W");
  assert.equal(searchListingCatalog(catalog, "FUND")[0].exchange, "NYSE Arca");
  assert.equal(searchListingCatalog(catalog, "FUND")[0].isEtf, true);
  assert.equal(searchListingCatalog(catalog, "ABCD").length, 0);
  assert.equal(searchListingCatalog(catalog, "ZVZZT").length, 0);
  assert.deepEqual(searchListingCatalog(catalog, "berkshire hath").map((row) => row.symbol), ["BRK.A", "BRK.B"]);
  assert.equal(searchListingCatalog(catalog, "Apple inc.", 1)[0].symbol, "AAPL");
  assert.equal(searchListingCatalog(catalog, "Hathaway").length, 0);
});

test("new listing observations need two complete snapshots and survive later refreshes", () => {
  const day = 86_400_000, start = day * 20, second = start + day;
  const first = buildListingCatalog({ nasdaqListed: file(nasdaqHeader, nasdaqRows), observedAt: start });
  assert.equal(first.directories.nasdaq.complete, true);
  assert.equal(first.directories.other.complete, false);
  assert.equal(first.entries[0].newlyObservedAt, null);
  assert.deepEqual(recentListingCatalog(first, { now: start }), []);

  const update = file(nasdaqHeader, [...nasdaqRows, "NEWQ|Café Widgets - Class A Ordinary Share|G|N|N|100|N|N"]);
  const next = buildListingCatalog({ nasdaqListed: update, previous: first, observedAt: second });
  const [newest] = recentListingCatalog(next, { now: second });
  assert.equal(newest.symbol, "NEWQ");
  assert.equal(newest.firstSeenAt, second);
  assert.equal(newest.newlyObservedAt, second);
  assert.equal(newest.newlyObserved, true);
  assert.equal(searchListingCatalog(next, "cafe wid")[0].symbol, "NEWQ");

  const later = buildListingCatalog({ nasdaqListed: update, previous: next, observedAt: second + day });
  const [stillRecent] = recentListingCatalog(later, { now: second + day });
  assert.equal(stillRecent.newlyObservedAt, second);
  assert.equal(stillRecent.newlyObserved, false);
  assert.equal(recentListingCatalog(later, { now: second + 8 * day }).length, 0);
  assert.equal(recentListingCatalog(later, { now: second - 1 }).length, 0);
  assert.ok("quote" in newest === false && "listingDate" in newest === false);
});

test("incomplete or invalid files do not create new listing observations", () => {
  const partial = buildListingCatalog({ sec, nasdaqListed: file(nasdaqHeader, nasdaqRows, false), observedAt: 1_000 });
  assert.equal(partial.directories.nasdaq.complete, false);
  const next = buildListingCatalog({
    sec, nasdaqListed: file(nasdaqHeader, [...nasdaqRows, "ZNEW|New Security Inc.|G|N|N|100|N|N"]),
    previous: partial, observedAt: 2_000,
  });
  assert.equal(searchListingCatalog(next, "ZNEW")[0].firstSeenAt, 2_000);
  assert.equal(recentListingCatalog(next, { now: 2_000 }).length, 0);
  const fallback = buildListingCatalog({ sec, nasdaqListed: "<html>Service unavailable</html>", observedAt: 3_000 });
  assert.equal(fallback.directories.nasdaq.complete, false);
  assert.deepEqual(searchListingCatalog(fallback, "AAPL")[0].sources, ["SEC EDGAR"]);
});

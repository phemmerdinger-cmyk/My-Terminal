const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../risk-core.js");

test("black-swan filter: single-company headlines never count (the 2026-11-16 false alarm)", () => {
  assert.equal(R.isMarketSwan("Helus Pharma stock tumbles 21% despite positive trial results"), false);
  assert.equal(R.isMarketSwan("Nvidia shares plunge 12% after guidance cut"), false);
  assert.equal(R.isMarketSwan("Acme Corp (ACME) stock crashes 40%"), false);
});

test("black-swan filter: real market-wide events still count", () => {
  assert.equal(R.isMarketSwan("Stocks plunge 4% as recession fears grip Wall Street"), true);
  assert.equal(R.isMarketSwan("Dow tumbles 5.2% in worst session in years"), true);
  assert.equal(R.isMarketSwan("S&P 500 sinks 3.5% as bond yields spike"), true);
  assert.equal(R.isMarketSwan("Circuit breakers triggered as markets crash at the open"), true);
  assert.equal(R.isMarketSwan("Fed announces emergency rate cut"), true);
  assert.equal(R.isMarketSwan("Stocks slip 0.4% ahead of CPI"), false);
  assert.equal(R.isMarketSwan(""), false);
});

test("stale quotes are refused during the session, accepted after hours", () => {
  const now = Date.parse("2026-11-16T16:00:00Z");
  assert.equal(R.staleQuote({ price: 10, marketTime: now - 60e3 }, now, true), false);
  assert.equal(R.staleQuote({ price: 10, marketTime: now - 30 * 60e3 }, now, true), true);
  assert.equal(R.staleQuote({ price: 10, marketTime: now - 30 * 60e3 }, now, false), false);
  assert.equal(R.staleQuote({ price: 10 }, now, true), true);
  assert.equal(R.staleQuote({ error: "x" }, now, false), true);
  assert.equal(R.staleQuote(null, now, false), true);
});

test("Alex's qualification rule: a forecast smaller than costs never qualifies", () => {
  // the live day trader on 2026-11-16: |mu| ≈ 0.034 ATR, 1-minute range ≈ 0.12% of price
  const live = R.netEdge({ mu: 0.034, atrPct: 0.0012, costPerSide: 0.0001 });
  assert.equal(live.ok, false);
  assert.ok(live.cost > 0.15 && live.cost < 0.2);
  const big = R.netEdge({ mu: 0.4, atrPct: 0.0012, costPerSide: 0.0001 });
  assert.equal(big.ok, true);
  // shorts pay borrow, so the same forecast can qualify long but not short
  const L = R.netEdge({ mu: 0.27, atrPct: 0.0012, costPerSide: 0.0001, borrow: 0.0001, short: false });
  const S = R.netEdge({ mu: 0.27, atrPct: 0.0012, costPerSide: 0.0001, borrow: 0.0001, short: true });
  assert.equal(L.ok, true); assert.equal(S.ok, false);
  assert.equal(R.netEdge({ mu: 1, atrPct: 0, costPerSide: 0.0001 }).ok, false);
});

test("daily loss limit", () => {
  assert.equal(R.dailyLossHit(-299, 30000), false);
  assert.equal(R.dailyLossHit(-300, 30000), true);
  assert.equal(R.dailyLossHit(-100, 0), false);
});

test("expectancy with a 95% interval; tiny positive means are not called significant", () => {
  const e = R.expectancyOf([1, -1, 1, -1, 1.2]);
  assert.ok(Math.abs(e.mean - 0.24) < 1e-9);
  assert.equal(e.significant, false);
  assert.ok(e.lo < 0 && e.hi > 0);
  const big = R.expectancyOf(Array.from({ length: 400 }, (_, i) => (i % 2 ? 1.5 : -1)));
  assert.equal(big.significant, true);
  assert.equal(R.expectancy(1, 5, 25).se, null);
  // matches aggregates
  const a = R.expectancy(5, 1.2, 1 + 1 + 1 + 1 + 1.44);
  assert.ok(Math.abs(a.se - e.se) < 1e-12);
});

test("swing positions can't be churned on intraday rank noise", () => {
  assert.equal(R.rankExitAllowed(3600e3, false), false);
  assert.equal(R.rankExitAllowed(3600e3, true), false);
  assert.equal(R.rankExitAllowed(3 * 864e5, false), false);
  assert.equal(R.rankExitAllowed(3 * 864e5, true), true);
});

test("strategy registry: any change of id or version means a new run", () => {
  assert.equal(R.versionChanged(null, { id: "a", version: 1 }), true);
  assert.equal(R.versionChanged({ id: "a", version: 1 }, { id: "a", version: 1 }), false);
  assert.equal(R.versionChanged({ id: "a", version: 1 }, { id: "a", version: 2 }), true);
});

test("data gaps", () => {
  assert.equal(R.gapMinutes(1000, 1060), 1);
  assert.equal(R.gapMinutes(1000, 1000 + 25 * 60), 25);
  assert.equal(R.gapMinutes(0, 1060), 0);
});

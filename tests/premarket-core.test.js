"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../premarket-core.js");

const NOW = Date.UTC(2026, 10, 25, 13, 0); // 8:00 AM ET
const q = (price, pre, ageMin = 5) => ({ price, name: "x", preMarket: pre == null ? null : { price: pre, changePct: (pre / price - 1) * 100, marketTime: NOW - ageMin * 60e3 } });

test("runs 6:00–9:30 AM and 4–5 PM ET on trading days only", () => {
  assert.equal(P.phase({ wd: "Wed", min: 6 * 60 }), "pre");
  assert.equal(P.phase({ wd: "Wed", min: 5 * 60 + 59 }), "off");
  assert.equal(P.phase({ wd: "Wed", min: 9 * 60 + 30 }), "off");
  assert.equal(P.phase({ wd: "Wed", min: 16 * 60 + 30 }), "after");
  assert.equal(P.phase({ wd: "Wed", min: 17 * 60 }), "off");
  assert.equal(P.phase({ wd: "Sat", min: 7 * 60 }), "off");
  assert.equal(P.phase({ wd: "Thu", min: 7 * 60, holiday: true }), "off");
});

test("scan uses only real, fresh prints and ranks gappers", () => {
  const r = P.scan({ NVDA: q(155.38, 147.1), AAPL: q(354.07, 351.24), AMD: q(100, 106), OLD: q(50, 60, 90), NONE: q(20, null), ERR: { error: true } },
    ["NVDA", "AAPL", "AMD", "OLD", "NONE", "ERR"], { now: NOW });
  assert.equal(r.live, 3);
  assert.deepEqual(r.down.map((x) => x.sym), ["NVDA"]); assert.equal(r.down[0].gapPct, -5.33);
  assert.deepEqual(r.up.map((x) => x.sym), ["AMD"]);
  const by = Object.fromEntries(r.rows.map((x) => [x.sym, x.status]));
  assert.equal(by.OLD, "stale"); assert.equal(by.NONE, "no-print"); assert.equal(by.ERR, "no-quote");
});

test("holding alerts: under the stop, or a 5%+ gap; quiet otherwise", () => {
  const r = P.scan({ NVDA: q(155.38, 147.1), AAPL: q(354.07, 351.24), AMD: q(100, 106) }, ["NVDA", "AAPL", "AMD"], { now: NOW });
  const a = P.holdingAlerts(r, [{ bot: "Swing", sym: "NVDA", shares: 10, stop: 150 }, { bot: "Swing", sym: "AAPL", shares: 1, stop: 300 }, { bot: "Quant", sym: "AMD", shares: 2, stop: null }]);
  assert.deepEqual(a.map((x) => [x.sym, x.kind]), [["NVDA", "stop"], ["AMD", "gapUp"]]);
  assert.equal(a[0].dollars, -82.8); assert.equal(a[1].dollars, 12);
});

test("opening guard blocks swing buys in big gappers for 30 minutes, same day only", () => {
  const r = { ...P.scan({ NVDA: q(155.38, 147.1), AAPL: q(354.07, 351.24) }, ["NVDA", "AAPL"], { now: NOW }), day: "2026-11-25" };
  const t = (min, day = "2026-11-25") => ({ min, day });
  assert.match(P.openingGuard(r, "NVDA", t(9 * 60 + 35)), /gapped down 5.33%.*10:00/);
  assert.equal(P.openingGuard(r, "AAPL", t(9 * 60 + 35)), "");
  assert.equal(P.openingGuard(r, "NVDA", t(10 * 60)), "");
  assert.equal(P.openingGuard(r, "NVDA", t(9 * 60)), "");
  assert.equal(P.openingGuard(r, "NVDA", t(9 * 60 + 35, "2026-11-26")), "");
  assert.equal(P.openingGuard(null, "NVDA", t(9 * 60 + 35)), "");
});

test("day trader scans the biggest gappers first, keeps everyone", () => {
  const r = { ...P.scan({ NVDA: q(155.38, 147.1), AMD: q(100, 103), SPY: q(700, 700.5) }, ["NVDA", "AMD", "SPY"], { now: NOW }), day: "d" };
  const u = ["SPY", "AAPL", "AMD", "NVDA"];
  assert.deepEqual(P.prioritize(u, r, { day: "d" }), ["NVDA", "AMD", "SPY", "AAPL"]);
  assert.deepEqual(P.prioritize(u, r, { day: "other" }), u);
  assert.match(P.summary(r, []), /Down: NVDA -5.33%/);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../public/workspace-core.js");

test("symbols are normalized like the rest of the site; junk is rejected", () => {
  assert.equal(W.normalizeSymbol(" aapl "), "AAPL");
  assert.equal(W.normalizeSymbol("$nvda"), "NVDA");
  assert.equal(W.normalizeSymbol("btc"), "BTC-USD");
  assert.equal(W.normalizeSymbol("^GSPC"), "^GSPC");
  assert.equal(W.normalizeSymbol("<script>"), null);
  assert.equal(W.normalizeSymbol(""), null);
  assert.equal(W.isEquity("AAPL"), true);
  assert.equal(W.isEquity("BTC-USD"), false);
  assert.equal(W.isEquity("^GSPC"), false);
});

test("compact numbers and percentages; missing values stay a dash", () => {
  assert.equal(W.compact(3.41e12, "$"), "$3.41T");
  assert.equal(W.compact(52_300_000), "52.3M");
  assert.equal(W.compact(-1.5e9, "$"), "-$1.50B");
  assert.equal(W.compact(null), "—");
  assert.equal(W.compact(NaN), "—");
  assert.equal(W.pctText(2.345), "+2.3%");
  assert.equal(W.pctText(-0.5, 2), "-0.50%");
  assert.equal(W.pctText(undefined), "—");
});

test("key stats use only what the quote and summary report", () => {
  const rows = W.keyStats({ price: 200, change: -2, changePct: -0.99, low52: 150, high52: 250, volume: 1.2e7 },
    { summaryDetail: { marketCap: 3e12, trailingPE: 30.25 }, financialData: { profitMargins: 0.25 } });
  const get = (l) => rows.find((r) => r[0] === l);
  assert.deepEqual(get("Change today"), ["Change today", "-2.00 (-0.99%)", "down"]);
  assert.equal(get("52-week range")[1], "150.00 – 250.00");
  assert.equal(get("Market cap")[1], "$3.00T");
  assert.equal(get("P/E (trailing)")[1], "30.3");
  assert.equal(get("Net margin")[1], "25.0%");
  assert.equal(get("Beta")[1], "—", "not reported → dash, never a guess");
  assert.equal(W.keyStats(null, null).every((r) => r[1] === "—"), true);
});

test("52-week position", () => {
  assert.equal(W.rangePosition({ price: 200, low52: 150, high52: 250 }), 50);
  assert.equal(W.rangePosition({ price: 300, low52: 150, high52: 250 }), 100);
  assert.equal(W.rangePosition({ price: 200, low52: null, high52: 250 }), null);
});

test("financial summary: last four years, growth and margin from reported rows only", () => {
  const sec = { available: true, name: "Example Inc", years: [
    { end: "2021-12-31", revenue: 80, netIncome: 8 },
    { end: "2022-12-31", revenue: 100, netIncome: 10, fcf: 12 },
    { end: "2023-12-31", revenue: 110, netIncome: null },
    { end: "2024-12-31", revenue: 121, netIncome: 12.1, fcf: 15, _fy: 2024, _filed: "2025-02-01", _form: "10-K" },
    { end: "2025-12-31", revenue: 133.1, netIncome: 13.31, _fy: 2025, _filed: "2026-02-01", _form: "10-K" },
  ] };
  const f = W.finSummary(sec);
  assert.equal(f.cols.length, 4);
  assert.deepEqual(f.cols.map((c) => c.label), ["FY2022", "FY2023", "FY2024", "FY2025"]);
  assert.equal(Math.round(f.cols[0].revenueGrowth), 25, "uses the year before the window too");
  assert.equal(f.cols[1].netMargin, null, "no net income reported → no margin");
  assert.equal(Math.round(f.cols[3].netMargin), 10);
  assert.equal(f.filed, "2026-02-01");
  assert.equal(W.finSummary({ available: false }), null);
  assert.equal(W.finSummary(null), null);
});

test("news for one ticker: tagged, newest first, no duplicate headlines", () => {
  const items = [
    { title: "Apple beats", time: 3, tickers: ["AAPL"] },
    { title: "Apple beats!", time: 2, tickers: ["AAPL"] },
    { title: "Fed holds", time: 4, tickers: [] },
    { title: "Apple supplier news", time: 5, tickers: ["AAPL", "TSM"] },
    { title: "Nvidia", time: 6, tickers: ["NVDA"] },
  ];
  assert.deepEqual(W.pickNews(items, "AAPL").map((i) => i.title), ["Apple supplier news", "Apple beats"]);
  assert.equal(W.pickNews(items, "AAPL", 1).length, 1);
  assert.deepEqual(W.pickNews(null, "AAPL"), []);
});

test("chart points and period return", () => {
  const pts = W.chartPoints([{ time: 3, close: 110 }, { time: 1, close: 100 }, { time: 2, close: null }]);
  assert.deepEqual(pts, [{ time: 1, value: 100 }, { time: 3, value: 110 }]);
  assert.equal(Math.round(W.periodReturn(pts)), 10);
  assert.equal(W.periodReturn([{ time: 1, value: 5 }]), null);
});

test("relative times", () => {
  const now = 1_000_000_000;
  assert.equal(W.relTime(now - 30e3, now), "just now");
  assert.equal(W.relTime(now - 5 * 60e3, now), "5m ago");
  assert.equal(W.relTime(now - 3 * 3600e3, now), "3h ago");
  assert.equal(W.relTime(now - 50 * 3600e3, now), "2d ago");
  assert.equal(W.relTime(null, now), "");
});

test("multi-screen panes are normalized and point at the chrome-less pane page", () => {
  const C = require("../public/workspace-core.js");
  assert.ok(C.LAYOUTS.includes("multi"));
  const p = C.normalizePanes([{ fn: "nyse" }, { fn: "bogus" }, { fn: "research", sym: " nvda " }], 4);
  assert.deepEqual(p.map((x) => x.fn), ["nyse", "news", "research", "aitrade"]);
  assert.equal(p[2].sym, "NVDA");
  assert.equal(C.normalizePanes(null, 5).length, 4, "only supported grid sizes");
  assert.equal(C.normalizePanes(null, 6).length, 6);
  assert.equal(C.paneUrl({ fn: "research", sym: "BRK-B" }), "/?pane=1#research/BRK-B");
  assert.equal(C.paneUrl({ fn: "news" }, { path: "/demo", visitor: true }), "/demo?pane=1&visitor#news");
  assert.ok(!C.PANE_FUNCS.some(([k]) => k === "workspace"), "a pane never nests the workspace");
});

test("each screen keeps its own zoom between 50% and 200%", () => {
  const C = require("../public/workspace-core.js");
  assert.equal(C.stepZoom(1, 1), 1.1); assert.equal(C.stepZoom(2, 1), 2); assert.equal(C.stepZoom(0.5, -1), 0.5);
  assert.equal(C.clampZoom("x"), 1);
  const p = C.normalizePanes([{ fn: "news", zoom: 0.8 }, { fn: "research", sym: "aapl", zoom: 7 }, { fn: "nyse", zoom: 1 }], 4);
  assert.equal(p[0].zoom, 0.8); assert.equal(p[1].zoom, 2); assert.equal(p[1].sym, "AAPL"); assert.equal("zoom" in p[2], false);
});

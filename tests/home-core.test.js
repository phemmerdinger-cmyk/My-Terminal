"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const C = require("../public/home-core.js");
const NOW = Date.parse("2026-11-16T15:00:00Z");
const pf = { id: "p", name: "Core", holdings: [
  { symbol: "NVDA", shares: 10, cost: 100, added: NOW - 30 * 864e5 }, { symbol: "nvda", shares: 10, cost: 120, added: NOW - 20 * 864e5 },
  { symbol: "MSFT", shares: 2, cost: 300, added: NOW - 30 * 864e5 }, { symbol: "ZZZZ", shares: 5, cost: 10 } ] };
const quotes = { NVDA: { price: 150, change: 3, changePct: 2, marketTime: NOW - 6e4 }, MSFT: { price: 400, change: -4, changePct: -1, marketTime: NOW - 6e4 } };
const sectors = { NVDA: "Information Technology", MSFT: "Information Technology" };

test("summary merges lots, excludes unpriced holdings and keeps unrealized separate from day change", () => {
  const s = C.summarize(pf, quotes, sectors, NOW);
  assert.equal(s.positions, 3); assert.deepEqual(s.unpriced, ["ZZZZ"]);
  assert.equal(s.value, 20 * 150 + 2 * 400);           // 3800, unpriced not estimated
  assert.equal(s.pricedCost, 2200 + 600);
  assert.equal(s.unreal, 3800 - 2800);
  assert.equal(s.cost, 2800 + 50);                      // total recorded cost incl. unpriced
  assert.equal(s.day, 20 * 3 + 2 * -4);
  assert.ok(Math.abs(s.rows[0].weight - 3000 / 3800 * 100) < 1e-9);
  assert.equal(s.sectors[0].sector, "Information Technology"); assert.ok(Math.abs(s.sectors[0].weight - 100) < 1e-9);
  assert.equal(s.rows.find((r) => r.symbol === "ZZZZ").weight, null);
});
test("a position bought today counts its whole gain as today's change", () => {
  const s = C.summarize({ holdings: [{ symbol: "NVDA", shares: 1, cost: 140, added: NOW - 3600e3 }] }, quotes, sectors, NOW);
  assert.equal(s.day, 10);
});
test("empty or missing portfolios do not throw", () => {
  const s = C.summarize(null, {}, {}, NOW); assert.equal(s.positions, 0); assert.equal(s.dayPct, null); assert.equal(s.unrealPct, null);
});
test("exposure shift reports only moves above the threshold", () => {
  const r = C.exposureShift([{ sector: "Tech", weight: 50 }, { sector: "Energy", weight: 10 }], [{ sector: "Tech", weight: 62 }, { sector: "Energy", weight: 12 }], 5);
  assert.deepEqual(r.map((x) => x.sector), ["Tech"]); assert.equal(r[0].delta, 12);
});
test("briefing requires a source and timestamp, ranks holdings first and explains why", () => {
  const s = C.summarize(pf, quotes, sectors, NOW);
  const news = { items: [
    { id: "a", title: "Market wraps flat", link: "https://x.test/a", source: "cnbc", time: NOW - 3600e3, tickers: [] },
    { id: "b", title: "Nvidia unveils chip", link: "https://x.test/b", source: "yahoo", time: NOW - 7200e3, tickers: ["NVDA"] },
    { id: "c", title: "No link", link: "", source: "yahoo", time: NOW, tickers: ["NVDA"] },
    { id: "d", title: "No time", link: "https://x.test/d", source: "yahoo", tickers: ["NVDA"] },
    { id: "e", title: "NVDA 8-K: Results", link: "https://sec.test/e", source: "official", agency: "SEC", time: NOW - 864e5, tickers: ["NVDA"] },
    { id: "f", title: "Nvidia unveils chip", link: "https://x.test/f", source: "wsj", time: NOW - 7300e3, tickers: ["NVDA"] } ] };
  const L = C.briefing({ news, quotes, summary: s, watchlist: ["AAPL"], since: NOW - 3 * 3600e3, now: NOW });
  assert.ok(L.every((x) => x.source && x.time));
  assert.ok(!L.some((x) => x.title === "No link" || x.title === "No time"));
  assert.equal(L.filter((x) => x.title === "Nvidia unveils chip").length, 1, "duplicates collapse");
  assert.ok(L[0].tickers.includes("NVDA")); assert.ok(L[0].reasons.some((r) => /You hold NVDA/.test(r)));
  const sec = L.find((x) => x.kind === "filing"); assert.ok(sec && sec.reasons.some((r) => /SEC filing/.test(r)));
  assert.ok(L.find((x) => x.title === "Nvidia unveils chip").isNew); assert.ok(!sec.isNew);
});
test("briefing adds earnings and spider items only for followed names, with sources", () => {
  const s = C.summarize(pf, quotes, sectors, NOW);
  const earnings = { source: "Finnhub", updated: NOW - 6e4, yours: [{ symbol: "MSFT", date: "2026-11-18" }, { symbol: "XOM", date: "2026-11-18" }] };
  const discoveries = { items: [{ id: "1", headline: "Insider buying at MSFT", u: NOW - 6e4, tickers: ["MSFT"], importance: 80, sources: [{ name: "SEC EDGAR", url: "https://sec.test/1" }], interp: { text: "x" } }, { id: "2", headline: "Unsourced", u: NOW, tickers: ["MSFT"], sources: [] }] };
  const L = C.briefing({ earnings, discoveries, quotes, summary: s, watchlist: [], now: NOW });
  assert.ok(L.some((x) => x.kind === "earnings" && /MSFT/.test(x.title)));
  assert.ok(!L.some((x) => /XOM/.test(x.title)));
  const sp = L.find((x) => x.kind === "spider"); assert.equal(sp.url, "https://sec.test/1"); assert.match(sp.nature, /interpretation/);
  assert.ok(!L.some((x) => x.title === "Unsourced"));
});
test("priorities flag earnings, concentration, sector limits, filings and missing quotes", () => {
  const s = C.summarize(pf, quotes, sectors, NOW);
  const P = C.priorities({ summary: s, watchlist: [], now: NOW, limits: { maxPosition: 25, maxSector: 40 },
    earnings: { yours: [{ symbol: "NVDA", date: "2026-11-17" }] },
    news: { items: [{ id: "f", title: "MSFT 8-K", link: "https://sec.test", source: "official", agency: "SEC", time: NOW - 864e5, tickers: ["MSFT"] }] } });
  const ids = P.map((p) => p.id);
  for (const id of ["earn:NVDA", "conc:NVDA", "sec:Information Technology", "unpriced"]) assert.ok(ids.includes(id), id);
  assert.ok(ids.some((x) => x.startsWith("filing:")));
  assert.equal(P[0].sev, "high");
  assert.ok(P.every((p) => p.go), "every priority links into the terminal");
});
test("layout: normalize, move, resize, hide/restore", () => {
  let L = C.normalizeLayout([{ id: "risk", span: 9 }, { id: "bogus" }, { id: "risk" }]);
  assert.equal(L[0].id, "risk"); assert.equal(L[0].span, 1); assert.equal(L.length, C.WIDGETS.length);
  L = C.moveWidget(L, "risk", "down"); assert.equal(L[1].id, "risk");
  L = C.moveWidget(L, "risk", 0); assert.equal(L[0].id, "risk");
  assert.deepEqual(C.moveWidget(L, "risk", "up").map((x) => x.id), L.map((x) => x.id));
  L = C.resizeWidget(L, "risk"); assert.equal(L[0].span, 2); L = C.resizeWidget(C.resizeWidget(L, "risk"), "risk"); assert.equal(L[0].span, 1);
  L = C.toggleWidget(L, "risk", true); assert.ok(L[0].hidden); L = C.toggleWidget(L, "risk", false); assert.ok(!L[0].hidden);
});
test("risk: hypothetical 1Y stats from aligned daily closes, excludes short histories", () => {
  const t = Array.from({ length: 253 }, (_, i) => 1.7e9 + i * 86400);
  const bench = { t, close: t.map((_, i) => 100 * (1 + 0.0004 * i)) };
  const A = { t, close: t.map((_, i) => 50 * (1 + 0.001 * i) * (i === 100 ? 0.9 : 1)) };
  const SHORT = { t: t.slice(200), close: t.slice(200).map(() => 10) };
  const r = C.risk({ A, SHORT }, { A: 2, SHORT: 1, NONE: 1 }, bench, 0.04);
  assert.deepEqual(r.missing.sort(), ["NONE", "SHORT"]);
  assert.ok(Math.abs(r.total - (50 * 1.252 / 50 - 1)) < 1e-9);
  assert.ok(r.mdd < -0.09 && r.mdd > -0.11);
  assert.ok(Math.abs(r.benchTotal - 0.1008) < 1e-9);
  assert.ok(r.vol > 0 && Number.isFinite(r.beta));
  assert.ok(C.risk({}, { A: 1 }, null).error);
});
test("Home is wired into the existing shell without breaking other tabs", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('id="tab-home"'));
  assert.ok(html.includes('const TABS = ["home","news",'));
  assert.ok(html.includes('["home",[["home","Home"]]]'));
  assert.ok(html.includes('VIEW?"news":"home"'), "owner lands on Home, demo keeps News");
  for (const f of ["desk-store.js", "home-core.js", "home.js"]) assert.ok(html.includes(`<script src="/${f}"></script>`), f);
  assert.ok(html.indexOf('href="/home.css"') < html.indexOf('href="/orange-theme.css'));
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "home.css"), "utf8");
  assert.ok(!/#(0ea5e9|06b6d4|22d3ee|3b82f6|8b5cf6|a855f7|f97316|ff9e1b)/i.test(css), "no blue/cyan/purple/orange accents");
  assert.ok(css.includes("prefers-reduced-motion"));
});

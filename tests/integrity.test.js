// Data Integrity Engine: checks against hand-worked fixtures (no network).
const { test } = require("node:test");
const assert = require("node:assert");
const I = require("../data/integrity.js");
const F = require("../public/fin.js");
const { redact, hostLabel, createHealth } = require("../data/health.js");
const NOW = Date.parse("2026-11-11T16:00:00Z");
// a clean, internally consistent fiscal year (all numbers hand-checked)
const good = () => ({ end: "2026-06-30", _form: "10-K", _filed: "2026-08-01", _fy: 2026, _fp: "FY", _unit: "USD", _src: { grossProfit: "GrossProfit" },
  revenue: 1000, cogs: 600, grossProfit: 400, operatingIncome: 200, netIncome: 150, eps: 1.5, dilutedShares: 100,
  totalAssets: 2000, totalLiabilities: 1200, equity: 800, liabilitiesAndEquity: 2000, cfo: 300, cfi: -120, cff: -100, fx: -5, cashChange: 75,
  capex: 120, fcf: 180, cash: 400, currentAssets: 900, currentLiabilities: 500, _hist: {} });
const byId = (l, id) => l.find((c) => c.id === id);

test("accounting identity, components and cash-flow reconciliation pass on consistent data", () => {
  const c = I.checkYear(good(), F.ratios);
  for (const id of ["identity", "components", "cashflow", "grossprofit", "eps", "signs", "derived"]) assert.equal(byId(c, id).status, "pass", id);
});
test("broken statements are caught: identity gap, cash-flow gap, EPS mismatch, wrong signs", () => {
  const y = { ...good(), liabilitiesAndEquity: 2100, cashChange: 200, eps: 3, capex: -120 };
  const c = I.checkYear(y, F.ratios);
  assert.equal(byId(c, "identity").status, "fail");   // 2000 vs 2100 is 4.8% apart
  assert.equal(byId(c, "cashflow").status, "fail");   // 75 computed vs 200 reported
  assert.equal(byId(c, "eps").status, "fail");        // 1.50 computed vs 3.00 reported
  assert.equal(byId(c, "signs").status, "fail");      // negative capex
});
test("missing lines are skipped, not failed", () => {
  const y = good(); delete y.liabilitiesAndEquity; delete y.totalLiabilities; delete y.cfi;
  const c = I.checkYear(y, F.ratios);
  for (const id of ["identity", "components", "cashflow"]) assert.equal(byId(c, id).status, "skip", id);
});
test("restatements come from the SEC's own filing history; revisions from our previous fetch", () => {
  const y = { ...good(), _hist: { revenue: [{ val: 990, filed: "2026-08-01", form: "10-K" }, { val: 1000, filed: "2027-08-01", form: "10-K" }] } };
  const r = I.restatements([y]);
  assert.equal(r.length, 1); assert.equal(r[0].original, 990); assert.equal(r[0].current, 1000);
  const prev = I.snapshot([{ ...good(), revenue: 980 }]), cur = I.snapshot([good()]);
  const d = I.diffSnapshots(prev, cur, NOW);
  assert.deepEqual(d.map((x) => [x.field, x.before, x.after]), [["revenue", 980, 1000]]);
  assert.deepEqual(I.diffSnapshots(null, cur), [], "first check records a baseline, no revisions");
});
test("confidence score follows its published formula and is not a probability", () => {
  const c = I.confidence({ completeness: 1, recency: 0.5, consistency: 0.8, source: 1 });
  assert.equal(c.score, Math.round(100 * (0.35 + 0.125 + 0.2 + 0.15))); // 82.5 → 83
  assert.match(c.note, /not a probability/);
  assert.equal(I.confidence({ completeness: 2, recency: -1, consistency: 1, source: 1 }).score, 75, "inputs are clamped to 0..1");
});
test("full report: periods traced, recency, missing fields, score", () => {
  const f = { available: true, symbol: "TEST", name: "Test Co", cik: 1, currency: "USD", years: [{ ...good(), end: "2025-06-30" }, good()], mergedPeriods: 1, fetched: NOW };
  const r = I.fundamentalsReport(f, { now: NOW, ratiosFn: F.ratios });
  assert.equal(r.summary.fail, 0); assert.equal(byId(r.checks, "periods").status, "pass"); assert.equal(byId(r.checks, "recency").status, "pass");
  assert.ok(byId(r.checks, "duplicates")); assert.ok(r.confidence.score >= 85, "consistent, complete, recent SEC data scores high: " + r.confidence.score);
  assert.ok(r.sources[0].url.includes("CIK0000000001"));
  const old = I.fundamentalsReport({ ...f, years: [{ ...good(), end: "2022-06-30" }] }, { now: NOW, ratiosFn: F.ratios });
  assert.equal(byId(old.checks, "recency").status, "fail"); assert.ok(old.confidence.score < r.confidence.score);
});
test("quote freshness: current, delayed, stale, unavailable — never 'current' for an old intraday price", () => {
  const q = (ageMin) => ({ symbol: "X", price: 10, marketTime: NOW - ageMin * 60e3 });
  assert.equal(I.classifyQuote(q(1), { now: NOW, marketOpen: true }).status, "current");
  assert.equal(I.classifyQuote(q(10), { now: NOW, marketOpen: true }).status, "delayed");
  assert.equal(I.classifyQuote(q(45), { now: NOW, marketOpen: true }).status, "stale");
  assert.equal(I.classifyQuote(q(600), { now: NOW, marketOpen: false }).status, "current", "last close while closed");
  assert.equal(I.classifyQuote(q(60 * 24 * 7), { now: NOW, marketOpen: false }).status, "stale");
  assert.equal(I.classifyQuote({ error: true }, { now: NOW }).status, "unavailable");
  assert.equal(I.crossCheckPrice(100, 100.2).status, "pass"); assert.equal(I.crossCheckPrice(100, 103).status, "fail"); assert.equal(I.crossCheckPrice(100, null).status, "skip");
});
test("health log redacts secrets and labels sources", async () => {
  assert.equal(redact("HTTP 403 for https://finnhub.io/api/v1/quote?symbol=A&token=abc123SECRET"), "HTTP 403 for https://finnhub.io/api/v1/quote?symbol=A&token=***");
  const fake = ["sk", "ant", "api03-ABCDEFGHIJKLMNOPQRSTUV"].join("-"); assert.ok(!redact("key " + fake).includes("QRSTUV"));
  assert.equal(hostLabel("https://data.sec.gov/x"), "SEC EDGAR");
  const h = createHealth(() => NOW), f = h.track(async (u) => { if (/bad/.test(u)) throw new Error("boom " + u + "?token=zzz"); return "ok"; }, (u) => u);
  await f("https://query1.finance.yahoo.com/good"); await assert.rejects(f("https://query1.finance.yahoo.com/bad"));
  const v = h.view(); assert.equal(v.sources[0].ok, 1); assert.equal(v.sources[0].fail, 1); assert.ok(!JSON.stringify(v).includes("zzz"));
});

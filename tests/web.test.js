// THE WEB: the research Spider, run offline against deterministic fake data sources (tests/web-stubs.js).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createSpider, withTimeout } = require("../web/spider.js");
const { createStore } = require("../web/store.js");
const { makeDeps } = require("./web-stubs.js");
const PF = { portfolios: [{ id: "p1", name: "Growth", holdings: [{ symbol: "NVDA", shares: 50, cost: 100 }, { symbol: "AAPL", shares: 20, cost: 150 }, { symbol: "AMD", shares: 30, cost: 90 }, { symbol: "VOO", shares: 5, cost: 400 }] }], watchlist: ["TSLA", "JPM"], active: "p1" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "web-test-"));
async function spider(over = {}, dir = tmp()) {
  const m = makeDeps(over); const sp = createSpider({ ...m.deps, store: createStore({ dir }) });
  await sp.load(); return { sp, ...m, dir };
}
async function run(sp, n = 40) { for (let i = 0; i < n; i++) await sp.tick(); }

test("portfolio exposure: weights, sectors, concentration and relevance come from the shared holdings", async () => {
  const { sp } = await spider(); sp.setContext(PF); await sp.runNow("portfolio_scan");
  const ex = sp._internal.ST.exposure;
  assert.ok(ex.symWeight.NVDA > 0.4 && ex.symWeight.NVDA < 0.55, "NVDA is about half the portfolio");
  assert.ok(ex.sectorWeight["Information Technology"] > 0.9);
  const d = sp.discoveries({ group: "portfolio" }).items.find((x) => x.key === "exposure:p1");
  assert.ok(d && d.pf.rel >= 0.8 && /Information Technology/.test(d.headline));
  assert.ok(d.facts.every((f) => f.src), "every fact names its source");
});

test("research memory deduplicates, versions changes and links related findings", async () => {
  const { sp } = await spider(); const { discover } = sp._internal;
  const a = discover({ key: "k1", cat: "news", tickers: ["NVDA"], headline: "One", summary: "s" });
  const b = discover({ key: "k1", cat: "news", tickers: ["NVDA"], headline: "One", summary: "s" });
  assert.equal(a.isNew, true); assert.equal(b.isNew, false); assert.equal(b.changed, false);
  const c = discover({ key: "k1", cat: "news", tickers: ["NVDA"], headline: "Two", summary: "s" });
  assert.equal(c.changed, true); assert.equal(c.d.v, 2); assert.equal(c.d.prev[0].headline, "One");
  const d = discover({ key: "k2", cat: "insider", tickers: ["NVDA"], headline: "Insiders", summary: "s" });
  assert.ok(d.d.rel.includes(c.d.id), "new finding links to the earlier one about the same company");
  assert.equal(sp.discoveries({ limit: 50 }).total, 2);
});

test("priority engine: a holding's earnings follow-up outranks broad exploration", async () => {
  const { sp } = await spider(); sp.setContext(PF);
  const hold = sp.enqueue("earnings_release", "NVDA", { boost: 0.45, reason: "NVDA just reported", extra: { catalyst: 1 } });
  const exp = sp.enqueue("company_snapshot", "ORCL", { boost: 0.05 });
  assert.ok(hold.prio.score > exp.prio.score, `${hold.prio.score} > ${exp.prio.score}`);
  assert.ok(hold.prio.why.length && hold.prio.parts.catalyst === 1);
});

test("runaway protection: time limits, bounded retries, queue cap and follow-up depth", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 30, "too slow"), /too slow/);
  const { sp } = await spider({ deps: { insiders: () => new Promise(() => {}) } }); // a source that never answers
  sp._internal.JOBS.insiders.timeout = 0.05;
  const log = await sp.runNow("insiders", "NVDA");
  assert.equal(log.status, "error"); assert.match(log.error, /timed out/);
  const retry = sp._internal.ST.queue.find((j) => j.key === "insiders:NVDA");
  assert.ok(retry && retry.tries === 1 && retry.notBefore > Date.now() - 1e9, "one retry queued with a delay");
  for (let i = 0; i < 100; i++) sp.enqueue("company_snapshot", "S" + i, {});
  assert.ok(sp._internal.ST.queue.length <= 60, "queue is capped");
  assert.equal(sp.enqueue("fundamentals", "AAPL", { depth: 3 }), null, "follow-up chains stop at depth 2");
});

test("a full autonomous cycle produces linked, sourced discoveries and never trades", async () => {
  const { sp, calls } = await spider(); sp.setContext(PF); await run(sp, 45);
  const st = sp.status();
  assert.ok(st.stats.jobs >= 20, "many jobs ran"); assert.equal(st.stats.errors, 0);
  const all = sp.discoveries({ limit: 200 }).items, cats = new Set(all.map((d) => d.cat));
  for (const c of ["portfolio", "market", "news", "policy", "earnings", "filing", "insider", "fundamentals", "pattern", "ai_trader"]) assert.ok(cats.has(c), "found " + c);
  assert.ok(all.every((d) => d.sources.length && d.importance >= 1 && d.importance <= 100));
  assert.ok(all.some((d) => d.hyp && d.hyp.status === "open"), "directional findings record a testable hypothesis");
  assert.equal(calls.trades, 0, "the Spider never called a trade function");
  const src = ["spider.js", "briefing.js", "intel.js"].map((f) => fs.readFileSync(path.join(__dirname, "..", "web", f), "utf8")).join("\n");
  assert.ok(!/apTrade|dtOpen|dtExit|place_?order/i.test(src), "no trading code paths in web/");
});

test("AI Trader interface: structured packet, and a bounded score nudge from inputs the bot doesn't already use", async () => {
  const { sp } = await spider(); sp.setContext(PF); await run(sp, 45);
  const P = sp.packet("NVDA");
  for (const k of ["developments", "financialChanges", "earnings", "sentiment", "macro", "sectorPerformance", "catalysts", "risks", "history", "signal", "confidence", "sources"]) assert.ok(k in P, k);
  const a = sp.traderAdjust("NVDA", 0.05);
  assert.ok(Math.abs(a.adj) <= 0.05);
  assert.ok(a.signal.reasons.every((r) => !/Growth is down|holdings are/i.test(r)), "your own portfolio's P&L never feeds a stock's signal");
});

test("briefing: 12+ sections, labeled evidence, honest freshness, weekend handling", async () => {
  const { sp, clock } = await spider(); sp.setContext(PF); await run(sp, 45);
  await sp.runNow("briefing", null, { slot: "midday" });
  const b = await sp.briefing("latest");
  assert.ok(b.sections.length >= 12 && b.exec.length >= 3);
  assert.equal(b.freshness.quotes.status, "live", "fresh quotes during market hours");
  for (const s of b.sections) for (const i of s.items) assert.ok(["fact", "interpretation", "estimate", "speculation"].includes(i.kind));
  clock.set(Date.parse("2026-11-14T15:00:00Z")); // Saturday
  await sp.runNow("briefing", null, { slot: "close" });
  const w = await sp.briefing("latest");
  assert.equal(w.trading, false); assert.notEqual(w.freshness.quotes.status, "live");
  assert.ok(w.freshness.notes.some((n) => /weekend/.test(n)));
  assert.ok((await sp.briefings({ q: "S&P" })).total >= 1, "briefing history is searchable");
});

test("scheduler plans briefings only inside trading-day windows", async () => {
  const { sp, clock } = await spider();
  clock.set(Date.parse("2026-11-11T17:30:00Z")); sp._internal.plan(); // Wed 12:30 ET
  assert.ok(sp._internal.ST.queue.some((j) => j.type === "briefing" && j.slot === "midday"));
  const { sp: sp2, clock: c2 } = await spider(); c2.set(Date.parse("2026-11-26T17:30:00Z")); sp2._internal.plan(); // Thanksgiving
  assert.ok(!sp2._internal.ST.queue.some((j) => j.type === "briefing"));
});

test("research survives a restart", async () => {
  const dir = tmp(); const A = await spider({}, dir); A.sp.setContext(PF); await A.sp.runNow("portfolio_scan"); await A.sp.save(true);
  const B = await spider({}, dir);
  assert.ok(B.sp.discoveries().total >= 1); assert.equal(B.sp.status().context.holdings, 4);
});

test("network edges all carry a reason; chat cites stored research and admits gaps", async () => {
  const { sp } = await spider(); sp.setContext(PF); await run(sp, 45);
  const g = sp.graph(); assert.ok(g.nodes.length > 10 && g.edges.length > 10);
  assert.ok(g.edges.every((e) => e.why && e.why.length > 5));
  const r = await sp.ask("What are the biggest risks facing my investments?");
  assert.equal(r.intent, "risks"); assert.ok(r.citations.length && /\[1\]/.test(r.answer));
  const t = await sp.ask("What has changed about Tesla over the last month?");
  assert.equal(t.intent, "company"); assert.deepEqual(t.tickers, ["TSLA"]);
  const n = await sp.ask("what about the price of tea in china");
  assert.equal(n.citations.length, 0); assert.match(n.answer, /don't have stored research/);
});

test("hypotheses are graded against the S&P 500 after their window", async () => {
  const { sp, clock } = await spider(); const d = sp._internal.discover({ key: "h", cat: "insider", tickers: ["NVDA"], headline: "h", summary: "s", tone: 1, hyp: { sym: "NVDA", dir: 1, days: 7, claim: "c" } }).d;
  clock.add(8 * 864e5); await sp.runNow("hypothesis_review");
  assert.ok(["supported", "refuted", "inconclusive"].includes(d.hyp.status)); assert.ok(typeof d.hyp.rel === "number");
});

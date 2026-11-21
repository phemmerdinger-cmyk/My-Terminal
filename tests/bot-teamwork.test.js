const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../bot-teamwork-core.js");

const NOW = Date.parse("2026-11-20T15:00:00Z");

test("pre-buy check vetoes hard red flags and logs evidence", () => {
  const r = T.preBuyCheck({ sym: "TGT", now: NOW, researchedAt: NOW - 3600e3,
    signals: [{ sym: "TGT", name: "Negative regulatory development", dir: -1, inputs: [{ headline: "FTC opens probe", at: NOW, sources: [{ name: "Reuters" }] }] },
      { sym: "LOW", name: "Negative earnings development", dir: -1, inputs: [] }] });
  assert.equal(r.verdict, "veto");
  assert.deepEqual(r.vetoes, ["Negative regulatory development"]);
  assert.equal(r.evidence[0].source, "Reuters");
  assert.match(r.note, /^Spider veto/);
});

test("pre-buy check: negative filing vetoes, insider selling only cautions", () => {
  assert.equal(T.preBuyCheck({ sym: "A", now: NOW, researchedAt: NOW, signals: [{ sym: "A", name: "Important financial filing change", dir: -1 }] }).verdict, "veto");
  assert.equal(T.preBuyCheck({ sym: "A", now: NOW, researchedAt: NOW, signals: [{ sym: "A", name: "Important financial filing change", dir: 0 }] }).verdict, "ok");
  assert.equal(T.preBuyCheck({ sym: "A", now: NOW, researchedAt: NOW, signals: [{ sym: "A", name: "Insider selling", dir: -1 }] }).verdict, "caution");
});

test("pre-buy check vetoes a strongly negative research signal but not a weak one", () => {
  const strong = T.preBuyCheck({ sym: "A", now: NOW, researchedAt: NOW, trader: { n: 3, score: -0.6, conf: 0.5, reasons: ["▼ Guidance cut"] } });
  assert.equal(strong.verdict, "veto");
  assert.equal(strong.evidence[0].headline, "Guidance cut");
  assert.equal(T.preBuyCheck({ sym: "A", now: NOW, researchedAt: NOW, trader: { n: 1, score: -0.9, conf: 0.9, reasons: [] } }).verdict, "ok");
});

test("an unresearched stock is allowed and research is requested", () => {
  const r = T.preBuyCheck({ sym: "NEW", now: NOW });
  assert.equal(r.verdict, "unchecked");
  assert.equal(r.wantResearch, true);
});

test("quant regime needs 3 days in a row to switch", () => {
  let s = T.confirmRegime(null, "Risk-on trend", "2026-11-16").state;
  let r = T.confirmRegime(s, "Choppy / late-cycle", "2026-11-17"); assert.equal(r.label, "Risk-on trend"); assert.equal(r.state.pending.days, 1);
  r = T.confirmRegime(r.state, "Choppy / late-cycle", "2026-11-17"); assert.equal(r.state.pending.days, 1, "same-day rerun doesn't count twice");
  r = T.confirmRegime(r.state, "Choppy / late-cycle", "2026-11-18"); assert.equal(r.label, "Risk-on trend");
  r = T.confirmRegime(r.state, "Choppy / late-cycle", "2026-11-19"); assert.equal(r.label, "Choppy / late-cycle"); assert.equal(r.changed, true);
});

test("a flip back resets the count (stops the calm → choppy → risk-off whipsaw)", () => {
  let s = T.confirmRegime(null, "Risk-on trend", "d0").state;
  let r = T.confirmRegime(s, "Choppy / late-cycle", "d1");
  r = T.confirmRegime(r.state, "Risk-off / high volatility", "d2"); assert.equal(r.state.pending.days, 1); assert.equal(r.label, "Risk-on trend");
  r = T.confirmRegime(r.state, "Risk-on trend", "d3"); assert.equal(r.state.pending, null); assert.equal(r.label, "Risk-on trend");
});

test("a more defensive regime switches early only when spider stress agrees", () => {
  const s = T.confirmRegime(null, "Risk-on trend", "d0").state;
  assert.equal(T.confirmRegime(s, "Correction", "d1", { spiderStress: "4 negative macro findings" }).label, "Correction");
  const up = T.confirmRegime({ label: "Correction", since: "d0", pending: null }, "Risk-on trend", "d1", { spiderStress: "x" });
  assert.equal(up.label, "Correction", "stress never speeds up a move toward more risk");
});

test("post-mortems pair buys and sells, classify causes and learn penalties", () => {
  const day = 864e5, trades = [];
  // 5 chased-gap trades: 1 win, 4 losses (newest first ledger is built at the end)
  const asc = [];
  for (let i = 0; i < 5; i++) {
    const t0 = NOW - (40 - i * 6) * day;
    asc.push({ t: t0, side: "BUY", sym: "S" + i, why: "Ranked #3: high-risk pick (40% volatility), +30% over 3 months, +4.2% today" });
    asc.push({ t: t0 + 3 * day, side: "SELL", sym: "S" + i, pnl: i === 0 ? 50 : -40, pnlPct: i === 0 ? 0.05 : -0.04, why: i === 1 ? "Stop-loss: down 15% from where it was bought" : "Bad news: “X”" });
  }
  trades.push(...asc.reverse());
  const pm = T.postMortems(trades);
  assert.equal(pm.closed, 5);
  assert.equal(pm.losses.length, 4);
  assert.equal(pm.causes["bad-news"], 3);
  assert.equal(pm.causes.stopped, 1);
  const tags = pm.lessons.map((l) => l.tag);
  assert.ok(tags.includes("chased-gap") && tags.includes("hot-momentum"));
  assert.ok(!tags.includes("high-risk"), "the sleeve itself is never a lesson");
  const p = T.lessonPenalty(pm.lessons, ["high-risk", "chased-gap"]);
  assert.ok(p.penalty < 0 && p.penalty >= -0.08);
  assert.deepEqual(p.tags, ["chased-gap"]);
});

test("candidate tags mirror the buy-reason tags", () => {
  const x = { sleeve: "risk", earn: { kind: "beat" }, news: 1.2, spider: { adj: 0.02, note: "Spider: x" }, mom: 0.3, day: 3.5 };
  assert.deepEqual(T.candidateTags(x).sort(), ["chased-gap", "earnings-beat", "high-risk", "hot-momentum", "news-driven", "spider-boost"]);
  assert.deepEqual(T.tagsFromWhy("Ranked #1: safe pick (20% volatility), reported overnight: earnings beat by 9%, +5% over 3 months"), ["safe", "earnings-beat"]);
});

test("trading days until a report skip weekends", () => {
  assert.equal(T.tradingDaysUntil("2026-11-20", "2026-11-20"), 0);
  assert.equal(T.tradingDaysUntil("2026-11-20", "2026-11-23"), 1); // Fri → Mon
  assert.equal(T.tradingDaysUntil("2026-11-20", "2026-11-27"), 5);
  assert.equal(T.tradingDaysUntil("2026-11-20", "2026-11-19"), null);
});

test("earnings early warning: hold, trim or skip", () => {
  assert.equal(T.earningsAction({ held: true, days: 3, research: { n: 3, score: -0.5, conf: 0.4 } }).action, "trim");
  assert.equal(T.earningsAction({ held: true, days: 1, sleeve: "risk", pnlPct: 0.2 }).fraction, 0.33);
  assert.equal(T.earningsAction({ held: true, days: 4 }).action, "hold");
  assert.equal(T.earningsAction({ held: false, days: 1, research: { n: 5, score: 0.9, conf: 0.9 } }).action, "skip");
  assert.equal(T.earningsAction({ held: false, days: 4, research: { n: 5, score: 0.5, conf: 0.5 } }).action, "ok");
  assert.equal(T.earningsAction({ held: false, days: 4 }).action, "skip");
  assert.equal(T.earningsAction({ held: false, days: 9 }).action, "none");
});

test("defense mode needs two independent warnings or a broad selloff", () => {
  assert.equal(T.defenseDecision({ vix: 31 }).on, false);
  assert.equal(T.defenseDecision({ vix: 31 }).caution, true);
  assert.equal(T.defenseDecision({ swan: "War declared" }).on, false);
  const two = T.defenseDecision({ vix: 31, spider: "3 negative macro findings" });
  assert.equal(two.on, true); assert.deepEqual(two.sources, ["vix", "spider"]);
  assert.equal(T.defenseDecision({ spxDay: -3.2 }).on, true);
  assert.equal(T.defenseDecision({ spxDay: -1.8, breadth: 0.8 }).on, true);
  const calm = T.defenseDecision({ vix: 18, spxDay: 0.4 });
  assert.equal(calm.on, false); assert.equal(calm.caution, false); assert.equal(calm.reason, null);
});

test("twin comparison labels the result as hypothetical", () => {
  const c = T.twinCompare({ start: 30000, value: 30600 }, { start: 30000, value: 30300 });
  assert.equal(c.diffPts, 1); assert.match(c.verdict, /helping/); assert.match(c.note, /Hypothetical/);
  assert.equal(T.twinCompare({ start: 30000, value: 30000 }, { start: 30000, value: 30010 }).verdict, "About even so far");
  assert.equal(T.twinCompare(null, null), null);
});

test("morning brief sorts risk flags by level", () => {
  const b = T.buildBrief({ day: "2026-11-23", defense: { caution: true, reason: "VIX fear index at 31.0" }, desk: { mode: "locked", reason: "Desk drawdown lock" },
    regime: { pending: { label: "Correction", days: 2 } }, earningsHeld: [{ sym: "NVDA", days: 0, bots: ["swing"], action: "holding" }], findings: [{ headline: "a" }], plans: [{ bot: "swing", orders: [] }] });
  assert.equal(b.flags[0].level, "high");
  assert.ok(b.flags.some((f) => /NVDA reports today/.test(f.text)));
  assert.equal(b.overnight.length, 1);
});

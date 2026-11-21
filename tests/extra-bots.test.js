const test = require("node:test");
const assert = require("node:assert/strict");
const X = require("../extra-bots-core.js");
const R = require("../extra-bots-runner.js");

// weekday calendar starting 2026-01-05
function days(n, start = "2026-01-05") {
  const out = [], d = new Date(start + "T12:00:00Z");
  while (out.length < n) { const w = d.getUTCDay(); if (w && w < 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const toBars = (closes, cal) => closes.map((c, i) => ({ day: cal[i], open: c, high: c, low: c, close: c }));

test("RSI(2) uses Wilder smoothing and reads low after two down days", () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.equal(X.rsi(up), 100);
  const dip = [...up, 135, 128];
  assert.ok(X.rsi(dip) < 10);
});

test("pullback bot buys a dip above the 200-day and exits on the bounce", () => {
  const cal = days(260), base = Array.from({ length: 258 }, (_, i) => 100 + i * 0.2);
  const closes = [...base, base.at(-1) - 3, base.at(-1) - 6];
  const ideas = X.pullbackIdeas({ AAA: toBars(closes, cal) }, cal[259], ["AAA", "MISSING"]);
  assert.equal(ideas.length, 1); assert.match(ideas[0].reason, /RSI/);
  assert.equal(X.pullbackIdeas({ AAA: toBars(base.map((x) => 300 - x), cal) }, cal[257], ["AAA"]).length, 0, "below the 200-day: no buy");
  const pos = { entry: 100 };
  assert.match(X.exitFor("pullback", pos, [100, 98, 97, 99, 103, 104], 2), /Bounced/);
  assert.match(X.exitFor("pullback", pos, [100, 95, 93, 92, 91, 90], 2), /Stop/);
  assert.match(X.exitFor("insider", pos, [100, 101], 60), /Time exit/);
  assert.equal(X.exitFor("insider", pos, [100, 101], 10), null);
});

test("sector rotation picks the 3 strongest funds above their 200-day, cash otherwise", () => {
  const cal = days(260), bars = {};
  X.SECTORS.forEach((s, i) => { bars[s] = toBars(Array.from({ length: 260 }, (_, d) => 100 * Math.pow(1 + (i - 5) * 0.0005, d)), cal); });
  const r = X.rotationTargets(bars, cal[259]);
  assert.equal(r.complete, true);
  assert.deepEqual(r.targets, ["XLRE", "XLC", "XLB"]);
  delete bars.XLK;
  assert.equal(X.rotationTargets(bars, cal[259]).complete, false);
});

test("earnings drift needs a 5% beat confirmed by a 2% up day, while fresh", () => {
  const cal = days(80), closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.1);
  closes[78] = closes[77] * 1.04; closes[79] = closes[78] * 1.001;
  const bars = { BEAT: toBars(closes, cal) };
  const e = [{ symbol: "BEAT", date: cal[77], hour: "amc", surprise: 0.12 }];
  assert.equal(X.earningsIdeas(e, bars, cal[79], cal).length, 1);
  assert.equal(X.earningsIdeas([{ ...e[0], surprise: 0.02 }], bars, cal[79], cal).length, 0, "small beat");
  assert.equal(X.earningsIdeas([{ ...e[0], date: cal[70] }], bars, cal[79], cal).length, 0, "stale report");
  assert.equal(X.earningsIdeas([{ ...e[0], hour: "bmo", date: cal[79] }], bars, cal[79], cal).length, 0, "reaction day not confirmed up 2%");
});

test("insider bot needs two different buyers recently and skips falling knives", () => {
  const cal = days(220), now = Date.parse(cal[219] + "T21:00:00Z");
  const flat = toBars(Array(220).fill(50), cal), knife = toBars(Array.from({ length: 220 }, (_, i) => 100 - i * 0.3), cal);
  const ev = (symbol, buyers, ageDays = 1) => ({ symbol, buyers, lastAt: now - ageDays * 864e5, headline: `${symbol}: ${buyers} insiders bought $2M`, source: "SEC EDGAR Form 4" });
  assert.equal(X.insiderIdeas([ev("A", 3)], { A: flat }, cal[219], now).length, 1);
  assert.equal(X.insiderIdeas([ev("A", 1)], { A: flat }, cal[219], now).length, 0);
  assert.equal(X.insiderIdeas([ev("A", 3, 20)], { A: flat }, cal[219], now).length, 0);
  assert.equal(X.insiderIdeas([ev("K", 4)], { K: knife }, cal[219], now).length, 0);
});

test("runner: decisions after the close fill only at the next verified open, with costs", () => {
  const cal = days(262), base = Array.from({ length: 260 }, (_, i) => 100 + i * 0.2);
  const closes = [...base, base.at(-1) - 3, base.at(-1) - 6];
  const bars = { AAA: toBars(closes, cal), SPY: toBars(closes, cal) };
  const day = cal[261], next = "2030-01-02";
  let s = R.prepareExtraBots(null, { barsBySymbol: bars, signalDay: day, asOf: 1, nextSession: next, sessions: cal, universe: ["AAA"], earningsEvents: [], insiderEvents: [] });
  assert.equal(s.books.pullback.pending.length, 1);
  assert.equal(s.books.pullback.cash, R.START);
  // no verified open yet: nothing happens; late in the window the buy expires
  let o = R.openExtraBots(s, { day: next, openingBars: {}, now: 2, minute: 571 });
  assert.equal(o.books.pullback.pending.length, 1);
  o = R.openExtraBots(s, { day: next, openingBars: {}, now: 3, minute: 576 });
  assert.equal(o.books.pullback.pending.length, 0); assert.equal(o.books.pullback.skipped, 1);
  // verified open: whole shares, one 1/5 slot, cost above the open
  o = R.openExtraBots(s, { day: next, openingBars: { AAA: { o: 150 } }, now: 2, minute: 571 });
  const p = o.books.pullback.positions.AAA;
  assert.ok(p.shares > 0 && Number.isInteger(p.shares));
  assert.ok(p.entry > 150);
  assert.ok(p.shares * p.entry <= R.START / 5 + 1e-6);
  assert.ok(o.books.pullback.cash > 0);
});

test("runner: rotation rebalances once a month; unfilled sells carry over", () => {
  const cal = days(262), bars = { SPY: toBars(Array(262).fill(100), cal) };
  X.SECTORS.forEach((s, i) => { bars[s] = toBars(Array.from({ length: 262 }, (_, d) => 100 * Math.pow(1 + (i - 5) * 0.0005, d)), cal); });
  const day = cal[261];
  let s = R.prepareExtraBots(null, { barsBySymbol: bars, signalDay: day, asOf: 1, nextSession: "2030-01-02", sessions: cal, universe: [], earningsEvents: [], insiderEvents: [] });
  assert.deepEqual(s.books.rotation.pending.map((o) => o.symbol).sort(), ["XLB", "XLC", "XLRE"]);
  assert.equal(s.rotationMonth, day.slice(0, 7));
  s = R.openExtraBots(s, { day: "2030-01-02", openingBars: { XLB: { o: 120 }, XLC: { o: 120 }, XLRE: { o: 120 } }, now: 2, minute: 570 });
  assert.equal(Object.keys(s.books.rotation.positions).length, 3);
  // a sell that can't be filled is retried at the next session instead of being dropped
  s.books.rotation.pending.push({ side: "SELL", symbol: "XLB", openDay: "2030-01-02", reason: "test" });
  const again = R.prepareExtraBots(s, { barsBySymbol: bars, signalDay: "2030-01-02", asOf: 3, nextSession: "2030-01-03", sessions: [...cal, "2030-01-02"], universe: [], earningsEvents: [], insiderEvents: [] });
  assert.equal(again.books.rotation.pending.find((o) => o.symbol === "XLB").openDay, "2030-01-03");
});

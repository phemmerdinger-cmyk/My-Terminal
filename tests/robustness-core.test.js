const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../robustness-core.js");
const X = require("../extra-bots-core.js");
const R = require("../extra-bots-runner.js");

function days(n, start = "2024-01-02") {
  const out = [], d = new Date(start + "T12:00:00Z");
  while (out.length < n) { const w = d.getUTCDay(); if (w && w < 6) out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const bars = (closes, cal) => closes.map((c, i) => ({ day: cal[i], open: i ? closes[i - 1] : c, high: c, low: c, close: c }));

// an uptrend with a sharp 2-day dip every 15 sessions that recovers: the pullback rules should profit
function dippy(n, seed) {
  const c = []; let p = 100;
  for (let i = 0; i < n; i++) { const k = (i + seed) % 15; p *= k === 13 || k === 14 ? 0.97 : k === 0 || k === 1 ? 1.035 : 1.002; c.push(+p.toFixed(4)); }
  return c;
}

test("the replay profits from rules that fit the data and passes every check", () => {
  const cal = days(520), b = { SPY: bars(Array(520).fill(100), cal) }, uni = ["A", "B", "C", "D"];
  uni.forEach((s, i) => { b[s] = bars(dippy(520, i * 3), cal); });
  const v = T.toughness("pullback", b, { universe: uni });
  assert.ok(v.summary.trades >= T.MIN_TRADES, `trades ${v.summary.trades}`);
  assert.ok(v.summary.total > 0);
  assert.equal(v.status, "pass", JSON.stringify(v.checks));
  assert.match(v.limits, /survivorship/);
});

test("a losing replay fails and pauses new buys", () => {
  const base = { total: -0.05, later: -0.02, trades: 40, tradeList: [] }, ok = { total: 0.01 };
  const v = T.verdict(base, { lo: ok, hi: ok, dbl: ok, mc: { p05: -0.1, dd95: 0.1 } });
  assert.equal(v.status, "fail"); assert.equal(T.paused(v), true); assert.match(v.gate, /paused automatically/);
  const b = T.verdict({ total: 0.05, later: 0.01, trades: 40, tradeList: [] }, { lo: ok, hi: { total: -0.01 }, dbl: ok, mc: { p05: -0.1, dd95: 0.1 } });
  assert.equal(b.status, "borderline"); assert.equal(T.paused(b), false);
  assert.equal(T.verdict({ total: 0.5, later: 0.1, trades: 3, tradeList: [] }, { lo: ok, hi: ok, dbl: ok, mc: null }).status, "few-trades");
});

test("bad-luck reshuffles are reproducible", () => {
  const trades = Array.from({ length: 30 }, (_, i) => ({ ret: i % 3 ? 0.03 : -0.04, weight: 0.2 }));
  assert.deepEqual(T.monteCarlo(trades), T.monteCarlo(trades));
  assert.equal(T.monteCarlo(trades.slice(0, 5)), null);
});

test("±20% scales only the knobs being tested", () => {
  const lo = T.scale(X.RULES.pullback, 0.8, T.KNOBS.pullback);
  assert.equal(lo.rsiMax, 8); assert.equal(lo.slots, X.RULES.pullback.slots);
  assert.deepEqual(T.scale(X.RULES.rotation, 1.2, T.KNOBS.rotation).lookbacks, [76, 151]);
});

test("bots without free history are judged on their live paper record", () => {
  assert.equal(T.liveRecord({ closed: 5, wins: 1, realizedPnl: -300 }).status, "live-wait");
  assert.equal(T.liveRecord({ closed: 25, wins: 7, realizedPnl: -400 }).status, "fail");
  assert.equal(T.liveRecord({ closed: 25, wins: 7, realizedPnl: 400 }).status, "pass");
});

test("quant replay rebalances on its own schedule", () => {
  const n = 400, px = { SPY: Array.from({ length: n }, (_, i) => 100 * 1.0005 ** i), BIL: Array.from({ length: n }, () => 90) };
  const decide = (p) => ({ w: { SPY: 0.5, BIL: 0.5 } });
  const r = T.simulateQuant(decide, px);
  assert.ok(r.total > 0); assert.equal(r.unit, "monthly rebalances");
});

test("a paused bot queues no new buys but still exits", () => {
  const cal = days(262), base = Array.from({ length: 260 }, (_, i) => 100 + i * 0.2);
  const closes = [...base, base.at(-1) - 3, base.at(-1) - 6];
  const b = { AAA: bars(closes, cal), SPY: bars(closes, cal) };
  const s = R.prepareExtraBots(null, { barsBySymbol: b, signalDay: cal[261], asOf: 1, nextSession: "2030-01-02", sessions: cal, universe: ["AAA"], earningsEvents: [], insiderEvents: [], paused: { pullback: true } });
  assert.equal(s.books.pullback.pending.length, 0);
  assert.match(s.lastNotes.pullback, /paused/);
});

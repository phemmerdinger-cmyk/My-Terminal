const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../public/hq-core.js");

const swing = { startValue: 30000, value: 31500, spx0: 6000, spxNow: 6300, marketOpen: false, status: "Market closed",
  equity: [{ d: "2026-09-30", v: 30000, spx: 6000 }, { d: "2026-10-31", v: 30900, spx: 6100 }, { d: "2026-11-20", v: 31500, spx: 6300 }],
  trades: [{ t: Date.parse("2026-11-17T15:00:00Z"), side: "SELL", sym: "AAA", pnl: 120, why: "Trailing stop" }, { t: Date.parse("2026-11-18T19:30:00Z"), side: "SELL", sym: "BBB", pnl: -60, why: "Stop-loss" }, { t: Date.parse("2026-11-16T15:00:00Z"), side: "BUY", sym: "AAA", why: "Ranked #1" }],
  plan: { orders: [{ side: "BUY", sym: "CCC", amount: 3000, why: "Ranked #2" }] }, positions: [{ sym: "AAA", value: 3100, pnl: 100 }], lastScan: { riskOff: true } };

test("main bots map to one shape with benchmark and plans", () => {
  const b = C.fromMain("swing", swing);
  assert.equal(b.name, "Swing bot"); assert.equal(+b.ret.toFixed(3), 0.05); assert.equal(+b.benchRet.toFixed(3), 0.05);
  assert.equal(b.plans[0].sym, "CCC"); assert.match(b.detail, /200-day/);
  assert.equal(C.fromMain("swing", null), null);
});

test("monthly grid, drawdowns and when-it-works come from recorded data only", () => {
  const b = C.fromMain("swing", swing);
  assert.deepEqual(C.monthly(b.equity).map((m) => m.m), ["2026-09", "2026-10", "2026-11"]);
  assert.equal(+C.monthly(b.equity)[1].ret.toFixed(3), 0.03);
  assert.equal(+C.drawdowns([{ d: 1, v: 100 }, { d: 2, v: 90 }, { d: 3, v: 95 }])[1].dd.toFixed(4), -0.1);
  const w = C.whenItWorks(b.trades);
  assert.equal(w.weekday.find((x) => x.key === "Tue").pnl, 120);
  assert.equal(w.weekday.find((x) => x.key === "Wed").pnl, -60);
  assert.equal(w.hour.find((x) => x.key === 14).n, 1);
  const s = C.stats(b.trades); assert.equal(s.closed, 2); assert.equal(s.winRate, 0.5); assert.equal(s.profitFactor, 2);
});

test("lab experiments and the activity feed", () => {
  const lab = C.fromLab({ experiments: [{ id: "extra-insider", label: "Swing · insider buying", value: 30300, positions: 2, pending: 1, closed: 0, notice: "x", toughness: { status: "fail" } }] });
  assert.equal(lab[0].group, "lab"); assert.equal(+lab[0].ret.toFixed(3), 0.01); assert.equal(lab[0].toughness.status, "fail");
  const f = C.feed({ spider: { recent: [{ started: 5, label: "Researching NVDA", status: "done" }] }, bots: [C.fromMain("swing", swing)], checks: [{ t: 9, sym: "TGT", verdict: "veto", note: "Spider veto" }] });
  assert.equal(f[0].who, "Swing bot"); assert.ok(f.some((x) => x.kind === "veto")); assert.ok(f.some((x) => x.who === "Spider"));
  const p = C.pipeline({ spider: { stats: { total: 40, memory: 300 } }, signals: { items: [1, 2] }, swing: { trades: swing.trades, lastScan: { top: [1, 2, 3] }, teamwork: { checks: [1] } } }, Date.parse("2026-11-20T00:00:00Z"));
  assert.deepEqual(p.map((x) => x.value), [40, 300, 2, 3, 1, 3]);
});

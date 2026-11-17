const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../competition-core.js");

const ser = (vals, spx, d0 = "2026-01-01") => vals.map((v, i) => { const t = new Date(d0 + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + i); return { d: t.toISOString().slice(0, 10), v, spx: spx[i] }; });

test("lifetime window uses starting capital as the base and the S&P from the run's start", () => {
  const s = ser([30300, 30600], [101, 102]);
  const w = C.windowStats(s, { start: 30000, today: "2026-01-02", days: null, spx0: 100 });
  assert.equal(w.profit, 600);
  assert.ok(Math.abs(w.ret - 0.02) < 1e-12);
  assert.ok(Math.abs(w.spxRet - 0.02) < 1e-12);
  assert.ok(Math.abs(w.alpha) < 1e-12);
  assert.equal(w.sharpe, null); // too few days
  assert.match(w.confidence, /too few days/);
});

test("a short window starts from the last close before it — same dates for every trader", () => {
  const s = ser([30000, 31000, 30500, 30800], [100, 101, 100, 102]);
  const w = C.windowStats(s, { start: 30000, today: "2026-01-04", days: 1 });
  assert.equal(w.base, 30500); assert.equal(w.profit, 300);
  assert.ok(Math.abs(w.spxRet - 0.02) < 1e-12);
});

test("drawdown is measured inside the window", () => {
  const s = ser([30000, 33000, 29700, 31000], [1, 1, 1, 1]);
  const w = C.windowStats(s, { start: 30000, today: "2026-01-04", days: null, spx0: 1 });
  assert.ok(Math.abs(w.maxDrawdown - (29700 / 33000 - 1)) < 1e-12);
});

test("no data → not ok, never a made-up number", () => {
  assert.equal(C.windowStats([], { start: 30000, today: "2026-01-04", days: 7 }).ok, false);
  assert.equal(C.windowStats(ser([30000], [1], "2025-01-01"), { start: 30000, today: "2026-01-04", days: 7 }).ok, false);
});

test("Sharpe and confidence appear only with ≥ 20 days", () => {
  const vals = [], spx = []; let v = 30000, x = 100;
  for (let i = 0; i < 30; i++) { v *= 1 + (i % 2 ? 0.004 : -0.001); x *= 1.0005; vals.push(v); spx.push(x); }
  const w = C.windowStats(ser(vals, spx), { start: 30000, today: "2026-01-30", days: null, spx0: 100 });
  assert.ok(w.sharpe != null && w.sortino != null && w.tStat != null);
});

test("ranking: profit first, but a trader past the drawdown limit is ineligible and gets no place", () => {
  const r = C.rank([
    { key: "a", lifeDrawdown: -0.05, stats: { ok: true, profit: 100 } },
    { key: "b", lifeDrawdown: -0.25, stats: { ok: true, profit: 900 } },
    { key: "c", lifeDrawdown: -0.01, stats: { ok: true, profit: 200 } },
    { key: "d", lifeDrawdown: 0, stats: { ok: false } },
  ]);
  assert.deepEqual(r.map((x) => [x.key, x.place]), [["c", 1], ["a", 2], ["d", null], ["b", null]]);
  assert.match(r.find((x) => x.key === "b").ineligible[0], /drawdown/);
});

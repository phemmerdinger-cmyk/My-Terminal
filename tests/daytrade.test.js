// Day-trader rules: sweep detection, gap-and-go, sizing, limit fills and bracket exits.
const { test } = require("node:test");
const assert = require("node:assert");
const D = require("../daytrade-core.js");
const bar = (m, o, h, l, c, v = 1000) => ({ t: 1e9 + m * 60, m, o, h, l, c, v });
const session = (n, px = 100, start = D.OPEN) => Array.from({ length: n }, (_, i) => bar(start + i, px, px + 0.1, px - 0.1, px));

test("levels: prior day, pre-market and opening range", () => {
  const pre = Array.from({ length: 10 }, (_, i) => bar(8 * 60 + i, 100, 101 + i * 0.1, 99 - i * 0.1, 100));
  const reg = session(20);
  const L = Object.fromEntries(D.levels({ h: 105, l: 95 }, [...pre, ...reg]).map((x) => [x.k, x.p]));
  assert.equal(L.PDH, 105); assert.equal(L.PDL, 95); assert.equal(+L.PMH.toFixed(2), 101.9); assert.equal(+L.PML.toFixed(2), 98.1);
  assert.equal(+L.ORH.toFixed(2), 100.1); assert.equal(+L.ORL.toFixed(2), 99.9);
  assert.ok(!D.levels(null, session(10)).some((x) => x.k === "ORH"), "no opening range before 9:45");
});
test("sweep of a high on volume that closes back below → short idea", () => {
  const b = session(30); b.push(bar(D.OPEN + 30, 100, 105.6, 99.9, 104.9, 5000)); b.push(bar(D.OPEN + 31, 104.9, 105, 104, 104.2));
  const s = D.sweep(b, [{ k: "PDH", name: "prior-day high", p: 105, side: "high" }]);
  assert.equal(s.dir, "short"); assert.equal(s.entry, 105); assert.ok(s.stop > 105.6); assert.ok(s.volX >= 4.9);
});
test("no sweep without volume, or if price holds above the level", () => {
  const lv = [{ k: "PDH", name: "x", p: 105, side: "high" }];
  const quiet = session(30); quiet.push(bar(D.OPEN + 30, 100, 105.6, 99.9, 104.9, 1000));
  assert.equal(D.sweep(quiet, lv), null);
  const held = session(30); held.push(bar(D.OPEN + 30, 100, 105.6, 99.9, 105.4, 5000));
  assert.equal(D.sweep(held, lv), null);
});
test("sweep of a low → long idea", () => {
  const b = session(30); b.push(bar(D.OPEN + 30, 100, 100.2, 94.3, 95.3, 6000));
  const s = D.sweep(b, [{ k: "PDL", name: "prior-day low", p: 95, side: "low" }]);
  assert.equal(s.dir, "long"); assert.ok(s.stop < 94.3);
});
test("gap and go needs a ≥3% gap, a matching catalyst and a range break", () => {
  const b = [bar(D.OPEN, 104, 105, 103.5, 104.5), ...Array.from({ length: 4 }, (_, i) => bar(D.OPEN + 1 + i, 104.5, 105, 104, 104.6)), bar(D.OPEN + 5, 104.6, 105.5, 104.5, 105.3)];
  const g = D.gapGo(b, 100, 1); assert.equal(g.dir, "long"); assert.equal(g.entry, 105); assert.equal(g.stop, 103.5);
  assert.equal(D.gapGo(b, 100, -1), null, "catalyst must agree with the gap");
  assert.equal(D.gapGo(b, 103, 1), null, "gap under 3%");
});
test("position size = risk dollars ÷ stop distance, capped by buying power", () => {
  assert.equal(D.size(30000, 100, 98, 0.02, 1e9), 300); // $600 risk / $2
  assert.equal(D.size(30000, 100, 99.9, 0.02, 30000), 300); // 6000 shares wanted, capped at $30k notional
});
test("limit fills only when price trades through, at the better of limit and open", () => {
  assert.equal(D.fillOrder({ dir: "long", price: 100 }, bar(0, 101, 101.5, 100.5, 101)), null);
  assert.equal(D.fillOrder({ dir: "long", price: 100 }, bar(0, 101, 101.5, 99.8, 100.2)), 100);
  assert.equal(D.fillOrder({ dir: "long", price: 100 }, bar(0, 99, 99.5, 98.8, 99)), 99);
  assert.equal(D.fillOrder({ dir: "short", price: 105 }, bar(0, 104, 105.1, 103.9, 104.5)), 105);
});
test("bracket: stop first when both are hit, target, breakeven after +1R, P&L sign for shorts", () => {
  const p = { dir: "long", entry: 100, stop: 98, stop0: 98, target: 104, shares: 10 };
  assert.match(D.manage({ ...p }, bar(0, 100, 104.5, 97.5, 103)).why, /Stop/);
  assert.equal(D.manage({ ...p }, bar(0, 100, 104.2, 99, 104)).px, 104);
  const q = { ...p }; assert.equal(D.manage(q, bar(0, 100, 102.1, 100, 102)), null); assert.equal(q.stop, 100);
  assert.match(D.manage(q, bar(0, 101, 101, 99.9, 100)).why, /breakeven/);
  assert.equal(D.pnlOf({ dir: "short", entry: 50, shares: 10 }, 48), 20);
});
test("intraday levels: high/low of day and 30-minute swing, measured before the last 5 bars", () => {
  const b = session(60); b[10] = bar(D.OPEN + 10, 100, 103, 99.9, 100); b[50] = bar(D.OPEN + 50, 100, 101.5, 98.5, 100);
  const L = Object.fromEntries(D.levels(null, b).map((x) => [x.k, x.p]));
  assert.equal(L.HOD, 103); assert.equal(L.LOD, 98.5); assert.equal(L.SWH, 101.5); assert.equal(L.SWL, 98.5);
  assert.ok(!D.levels(null, session(12)).some((x) => x.k === "HOD"), "needs 15 bars of history first");
});
test("a sweep of the high of day on 1.3× volume is now enough", () => {
  const b = session(30); b.push(bar(D.OPEN + 30, 100, 103.2, 99.9, 99.95, 1300));
  const s = D.sweep(b, [{ k: "HOD", name: "high of day", p: 103, side: "high" }]);
  assert.equal(s.dir, "short");
});
test("gap and go: a ≥4% gap needs no catalyst, but never trades against one", () => {
  const b = [bar(D.OPEN, 104.5, 105, 104, 104.5), ...Array.from({ length: 4 }, (_, i) => bar(D.OPEN + 1 + i, 104.5, 105, 104.2, 104.6)), bar(D.OPEN + 5, 104.6, 105.5, 104.5, 105.3)];
  assert.equal(D.gapGo(b, 100, 0).dir, "long");
  assert.equal(D.gapGo(b, 100, -1), null);
  assert.equal(D.gapGo(b, 102, 0), null, "a 2.5% gap still needs a catalyst");
  assert.equal(D.gapGo(b, 102, 1).dir, "long");
});
test("scalper: EMA and average range", () => {
  assert.equal(D.ema([1, 1, 1], 9), 1);
  assert.ok(D.ema([1, 2, 3, 4], 3) > 3);
  const b = Array.from({ length: 20 }, (_, i) => bar(D.OPEN + i, 100, 100.5, 99.5, 100));
  assert.equal(+D.atr(b).toFixed(4), 1);
});
test("scalper: uptrend pullback to the 9-EMA closing green → long, with stop and target one range away", () => {
  const b = Array.from({ length: 30 }, (_, i) => bar(D.OPEN + i, 100 + i * 0.1, 100.15 + i * 0.1, 99.95 + i * 0.1, 100.1 + i * 0.1));
  const e9 = D.ema(b.map((x) => x.c), 9);
  b.push(bar(D.OPEN + 30, e9 + 0.02, e9 + 0.12, e9 - 0.01, e9 + 0.1));
  const s = D.scalpSignal(b);
  assert.equal(s.dir, "long"); assert.equal(s.kind, "pullback");
  assert.ok(s.stop < s.entry && s.target > s.entry);
  assert.ok(Math.abs((s.target - s.entry) / (s.entry - s.stop) - 1.2) < 0.01);
});
test("scalper: a quiet flat tape gives no trade", () => {
  assert.equal(D.scalpSignal(session(40)), null);
});
test("scalper: exits — stop, target, OHLC path rule when both are hit, then a 5-minute time stop", () => {
  const p = () => ({ dir: "short", entry: 100, stop: 100.2, target: 99.76, shares: 10 });
  assert.equal(D.scalpManage(p(), bar(0, 100, 100.3, 99.9, 100.1)).why, "Stop hit");
  assert.equal(D.scalpManage(p(), bar(0, 100, 100.3, 99.7, 99.8)).why, "Stop hit", "red bar: high came first");
  assert.equal(D.scalpManage(p(), bar(0, 100, 100.3, 99.7, 100.1)).why, "Target hit", "green bar: low came first");
  assert.equal(D.scalpManage(p(), bar(0, 100.4, 100.5, 99.7, 99.8)).px, 100.4, "gap through the stop fills at the open");
  assert.equal(D.scalpManage(p(), bar(0, 100, 100.1, 99.7, 99.8)).px, 99.76);
  const q = p(); for (let i = 0; i < 4; i++) assert.equal(D.scalpManage(q, bar(0, 100, 100.1, 99.9, 100)), null);
  assert.match(D.scalpManage(q, bar(0, 100, 100.1, 99.9, 99.95)).why, /Time stop/);
});

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

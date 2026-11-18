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
test("scalper: stop first if intrabar sequence is unknown, then a time stop", () => {
  const p = () => ({ dir: "short", entry: 100, stop: 100.2, target: 99.76, shares: 10 });
  assert.equal(D.scalpManage(p(), bar(0, 100, 100.3, 99.9, 100.1)).why, "Stop hit");
  assert.equal(D.scalpManage(p(), bar(0, 100, 100.3, 99.7, 99.8)).why, "Stop hit", "red bar with ambiguous path");
  assert.equal(D.scalpManage(p(), bar(0, 100, 100.3, 99.7, 100.1)).why, "Stop hit", "green bar with ambiguous path");
  assert.equal(D.scalpManage(p(), bar(0, 100.4, 100.5, 99.7, 99.8)).px, 100.4, "gap through the stop fills at the open");
  assert.equal(D.scalpManage(p(), bar(0, 100, 100.1, 99.7, 99.8)).px, 99.76);
  const q = p(); for (let i = 0; i < 4; i++) assert.equal(D.scalpManage(q, bar(0, 100, 100.1, 99.9, 100)), null);
  assert.match(D.scalpManage(q, bar(0, 100, 100.1, 99.9, 99.95)).why, /Time stop/);
});

const minute = { t: 6000, m: D.OPEN + 5, d: "sample session", o: 99, h: 101, l: 98, c: 100 };

test("paper entry advances beyond the actual decision and rejects partial, stale, or out-of-session bars", () => {
  assert.equal(D.paperEntryMinute(minute, 6_059_999, D.CLOSE, 90), null);
  assert.equal(D.paperEntryMinute(minute, 6_060_000, D.CLOSE, 90), 6120, "exactly on a boundary still requires a later open");
  assert.equal(D.paperEntryMinute(minute, 6_095_000, D.CLOSE, 90), 6120);
  assert.equal(D.paperEntryMinute(minute, 6_122_000, D.CLOSE, 90), 6180);
  assert.equal(D.paperEntryMinute(minute, 6_150_001, D.CLOSE, 90), null);
  assert.equal(D.paperEntryMinute({ ...minute, m: D.CLOSE - 2 }, 6_095_000, D.CLOSE, 90), null);
  assert.equal(D.paperEntryMinute({ ...minute, m: 13 * 60 - 2 }, 6_095_000, 13 * 60, 90), null);
  assert.equal(D.paperEntryMinute({ ...minute, o: null }, 6_095_000, D.CLOSE, 90), null);
  assert.equal(D.paperBarReady(minute, 6_150_000, 90), true);
  assert.equal(D.paperBarReady(minute, 6_150_001, 90), false);
});

test("paper entry requires the full ten-minute hold to fit the regular or early close", () => {
  for (const close of [D.CLOSE, 13 * 60]) {
    assert.equal(D.paperEntryMinute({ ...minute, m: close - 12 }, 6_095_000, close, 90, 10), 6120);
    assert.equal(D.paperEntryMinute({ ...minute, m: close - 11 }, 6_095_000, close, 90, 10), null);
  }
});

test("paper order fills only at its scheduled session open with a bracket based on that fill", () => {
  const order = { day: minute.d, decisionAt: 6_095_000, fillAt: 6120, idea: { dir: "long", stopDistance: 2, targetDistance: 3 } };
  const scheduled = { ...minute, t: 6120, m: minute.m + 2, o: 101, h: 104 };
  assert.deepEqual(D.paperOpen(order, scheduled), { entry: 101, stop: 99, target: 104, at: 6_120_000 });
  assert.deepEqual(D.paperOpen({ ...order, idea: { ...order.idea, dir: "short" } }, scheduled), { entry: 101, stop: 103, target: 98, at: 6_120_000 });
  assert.equal(D.paperOpen({ ...order, decisionAt: 6_120_000 }, scheduled), null);
  assert.equal(D.paperOpen(order, { ...scheduled, t: 6180 }), null, "missed order is never borrowed from a later bar");
  assert.equal(D.paperOpen(order, { ...scheduled, d: "next session" }), null);
  assert.equal(D.paperOpen(order, { ...scheduled, l: null }), null);
  assert.equal(D.paperOpen(order, { ...scheduled, h: 99 }), null);
  assert.equal(D.paperOpen({ ...order, idea: null }, scheduled), null);
  assert.equal(D.scalpManage({ dir: "long", stop: 99, target: 104 }, scheduled).why, "Stop hit", "long ambiguity also gives the stop priority");
});

test("paper position consumes only distinct, consecutive bars and closes on the tenth bar", () => {
  const position = { at: 6_120_000, dir: "long", stop: 97, target: 102 };
  assert.equal(D.managePaperPosition(position, minute, 10), null, "pre-entry bars are ignored");
  for (let i = 0; i < 10; i++) {
    const bar = { ...minute, t: 6120 + 60 * i, m: minute.m + 2 + i };
    const exit = D.managePaperPosition(position, bar, 10);
    assert.equal(position.lastProcessedBar, bar.t);
    assert.equal(position.bars, i + 1);
    if (i === 9) assert.deepEqual(exit, { px: bar.c, why: "Time stop — out after 10 minutes", t: bar.t + 60 });
    else {
      assert.equal(exit, null);
      assert.equal(D.managePaperPosition(position, bar, 10), null, "duplicate bars cannot advance the hold clock");
      assert.equal(position.bars, i + 1);
    }
  }
});

test("paper position settles a data gap at the first refreshed open", () => {
  const position = { at: 6_120_000, dir: "long", stop: 97, target: 102, lastProcessedBar: 6120, bars: 1 };
  const later = { ...minute, t: 6300, m: minute.m + 5, o: 100.25, h: 104, l: 93 };
  assert.equal(D.managePaperPosition(position, { ...later, o: null }, 10), null);
  assert.deepEqual(D.managePaperPosition(position, later, 10), { px: 100.25, why: "Data gap — closed at first freshly observed minute open", t: 6300 });
  assert.equal(position.lastProcessedBar, 6120);
  assert.equal(position.bars, 1);
  const nextSessionOpen = { ...later, d: "later session", t: 92_400, m: D.OPEN };
  assert.equal(D.managePaperPosition(position, nextSessionOpen, 10).px, nextSessionOpen.o);
});

test("a newer entry has its own opening print while an earlier forecast waits to be scored", () => {
  const research = { fillAt: 6_120, evalAt: 6_660, opening: 100 };
  const entry = { day: minute.d, fillAt: 6_240, decisionAt: 6_181_000, idea: { dir: "long", stopDistance: 1, targetDistance: 2 } };
  const bars = [6_240, 6_300].map((t) => ({ ...minute, t, m: minute.m + (t - minute.t) / 60 }));
  const first = D.paperObservations(bars, 6_365_000, 90, { research, entry });
  assert.deepEqual(first, { missedResearch: false, missedEntry: false, bars });
  assert.equal(D.paperOpen(entry, first.bars[0]).at, 6_240_000);
  assert.equal(D.paperOpen(entry, first.bars[1]), null);
  const answer = { ...minute, t: 6_660, m: minute.m + 11 };
  assert.deepEqual(D.paperObservations([answer], 6_723_000, 90, { research }).bars, [answer]);
});

test("missing research does not cancel a fresh entry, and future or late bars cannot fill it", () => {
  const research = { fillAt: 6_060, evalAt: 6_600 };
  const entry = { fillAt: 6_240 };
  const bar = { ...minute, t: 6_240, m: minute.m + 4 };
  assert.deepEqual(D.paperObservations([bar], 6_302_000, 90, { research, entry }),
    { missedResearch: true, missedEntry: false, bars: [bar] });
  assert.deepEqual(D.paperObservations([bar], 6_299_999, 90, { research, entry }).bars, []);
  assert.deepEqual(D.paperObservations([bar], 6_391_000, 90, { research, entry }),
    { missedResearch: true, missedEntry: true, bars: [] });
});

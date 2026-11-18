// Day-trader brain: features (no lookahead), online learning, scorecard, sizing and the portfolio guard.
const { test } = require("node:test");
const assert = require("node:assert");
const B = require("../daytrade-brain.js");
const D = require("../daytrade-core.js");

const bar = (i, c, v = 1000, w = 0.1) => ({ t: 1e9 + i * 60, m: D.OPEN + i, o: c - w / 3, h: c + w, l: c - w, c, v });
function walk(n, seed = 1, drift = 0) { let s = seed, px = 100; const out = []; for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; px *= 1 + drift + ((s / 2147483647) - 0.5) * 0.002; out.push(bar(i, px, 800 + (s % 900))); } return out; }

test("features: one finite value per feature, each within −1…+1; null with too few bars", () => {
  const bars = walk(60), spy = new Map(walk(60, 7).map((b) => [b.t, b.c]));
  const f = B.features(bars, { spy, breadth: 0.4, prev: { h: 101, l: 99, c: 100 }, info: { research: 0.5, spider: -0.2, swing: 0.1, quant: 0.3, sector: 2 }, market: -0.3 });
  assert.equal(f.x.length, B.KEYS.length);
  for (const v of f.x) assert.ok(isFinite(v) && v >= -1 && v <= 1, `bad feature ${v}`);
  assert.equal(f.x[B.KEYS.indexOf("sector")], 1, "clipped");
  assert.equal(B.features(walk(2), {}), null);
});

test("features use only bars up to the decision bar (no lookahead)", () => {
  const bars = walk(80, 3), spy = new Map(walk(80, 9).map((b) => [b.t, b.c]));
  const a = B.features(bars.slice(0, 50), { spy }), b = B.features(bars.slice(0, 50), { spy: new Map([...spy].filter(([t]) => t <= bars[49].t)) });
  assert.deepEqual(a.x, b.x, "future SPY prices don't change today's features");
});

test("beta and autocorrelation estimates", () => {
  const spyB = walk(70, 5), spy = new Map(spyB.map((b) => [b.t, b.c]));
  const stock = spyB.map((b, i) => bar(i, i ? 50 * (1 + 2 * (b.c / spyB[i - 1].c - 1)) : 50)); // compound 2× SPY's returns
  for (let i = 1; i < stock.length; i++) stock[i] = bar(i, stock[i - 1].c * (1 + 2 * (spyB[i].c / spyB[i - 1].c - 1)));
  const beta = B.betaOf(stock, spy); assert.ok(beta > 1.6 && beta < 2.05, `beta ${beta}`);
  assert.ok(B.autocorr(Array.from({ length: 60 }, (_, i) => (i % 2 ? 1 : -1))) < -0.5, "alternating → negative");
  assert.equal(B.autocorr([1, 2, 3]), 0, "too few → 0");
});

test("online learning finds a planted signal and the scorecard is out-of-sample", () => {
  const brain = B.fresh(); let s = 42; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const k = B.KEYS.indexOf("flow"), start = brain.w[k];
  for (let minute = 0; minute < 1500; minute++) {
    for (let j = 0; j < 40; j++) { const x = B.KEYS.map(() => rnd()); const y = 0.4 * x[k] + rnd() * 1.0; B.learn(brain, x, y, "2026-11-16"); }
    B.step(brain);
  }
  assert.ok(brain.w[k] > start + 0.1, `learned weight ${brain.w[k]}`);
  const sc = B.scorecard(brain);
  assert.equal(sc.n, 60000); assert.ok(sc.hitRate > 0.55, `hit rate ${sc.hitRate}`); assert.ok(sc.ic > 0.15, `ic ${sc.ic}`);
  assert.equal(sc.weights.length, B.KEYS.length); assert.equal(sc.today.n, 60000);
});

test("pure noise doesn't drift the weights far from the starting weights", () => {
  const brain = B.fresh(); let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let m = 0; m < 1000; m++) { for (let j = 0; j < 40; j++) B.learn(brain, B.KEYS.map(() => rnd()), rnd(), "d"); B.step(brain); }
  const far = brain.w.map((w, i) => Math.abs(w - B.PRIOR[i])); assert.ok(Math.max(...far) < 0.12, `max drift ${Math.max(...far)}`);
});

test("a delayed outcome scores the issued forecast and trains with current weights", () => {
  const delayed = B.fresh(), immediate = B.fresh();
  const x = B.KEYS.map((_, i) => i === 0 ? 1 : 0);
  delayed.w[0] = immediate.w[0] = 0.4;
  assert.equal(B.learn(delayed, x, 0.2, "d", -0.3), -0.3);
  assert.equal(B.learn(immediate, x, 0.2, "d"), 0.4);
  assert.equal(delayed.hits, 0);
  assert.equal(immediate.hits, 1);
  assert.equal(delayed.scored, 1);
  assert.equal(delayed.acc[0], 0.2);
  assert.deepEqual(delayed.acc, immediate.acc);
});

test("decide: always picks a side; minimum size when the edge doesn't clear costs; bigger when it does", () => {
  const brain = B.fresh(), x = B.KEYS.map(() => 0); x[B.KEYS.indexOf("research")] = 1; x[B.KEYS.indexOf("level")] = 1;
  const f = { x };
  const big = B.decide(brain, f, { costAtr: 0 }), small = B.decide(brain, f, { costAtr: 1 });
  assert.equal(big.dir, "long"); assert.ok(big.sizeX > 1, `size ${big.sizeX}`); assert.equal(small.sizeX, B.MIN_X);
  assert.ok(big.reasons.length >= 2 && /sweep|news/.test(big.reasons.join(" ")));
  const flat = B.decide(brain, { x: B.KEYS.map(() => 0) }, { mom: -1 }); assert.equal(flat.dir, "short"); assert.equal(flat.sizeX, B.MIN_X);
  const short = B.decide(brain, { x: x.map((v) => -v) }); assert.equal(short.dir, "short"); assert.ok(short.sizeX > 1);
});

test("guard keeps gross ≤ 4× and |net| ≤ cap, but never blocks a trade that fits as 1 share", () => {
  const eq = 30000;
  assert.equal(B.guard(100, 50, "long", { gross: 0, net: 0 }, eq), 100);
  assert.equal(B.guard(100, 50, "long", { gross: 4 * eq - 1000, net: 0 }, eq), 20, "gross room = $1,000");
  assert.equal(B.guard(100, 50, "long", { gross: 4 * eq, net: 0 }, eq), 0, "no gross room at all");
  assert.equal(B.guard(100, 50, "long", { gross: 50000, net: 1.5 * eq }, eq), 1, "net cap → minimum 1 share");
  assert.equal(B.guard(100, 50, "short", { gross: 50000, net: 1.5 * eq }, eq), 100, "a short reduces net exposure");
});

test("fix: garbage → fresh brain; saved brain keeps its weights; missing features get their prior", () => {
  assert.deepEqual(B.fix(null).w, B.PRIOR);
  const b = B.fresh(); b.w[0] = 0.3; b.n = 5; const f = B.fix(JSON.parse(JSON.stringify(b))); assert.equal(f.w[0], 0.3); assert.equal(f.n, 5);
  const short = { ...b, w: [0.1] }; assert.equal(B.fix(short).w[1], B.PRIOR[1]);
});

test("evidence tilt: strong news picks the side over a weak chart, agreeing evidence sizes up, opposing sizes down", () => {
  const t1 = B.evidenceTilt("short", -0.001, 0.02, 0.8); assert.equal(t1.dir, "long"); assert.ok(t1.flipped); assert.ok(t1.backed); assert.ok(Math.abs(t1.mult - 2.2) < 1e-9);
  const t2 = B.evidenceTilt("short", -0.05, 0.02, 0.8); assert.equal(t2.dir, "short", "a strong chart forecast keeps its side"); assert.ok(Math.abs(t2.mult - 0.25) < 1e-9); assert.ok(!t2.backed);
  const t3 = B.evidenceTilt("long", 0.01, 0.02, 0.1); assert.deepEqual(t3, { dir: "long", mult: 1, backed: false, flipped: false });
  assert.ok(B.evidenceTilt("long", 0.01, 0.02, 1).mult <= 2.5);
});

test("quantScores: cross-sectional factor scores within −1…+1; a steady winner ranks above a steady loser", () => {
  const mk = (g, wob = 0.004, n = 300, seed = 1) => { let s = seed, p = 100; return Array.from({ length: n }, () => { s = (s * 16807) % 2147483647; p *= 1 + g + ((s / 2147483647) - 0.5) * wob; return p; }); };
  const closes = { WIN: mk(0.002, 0.004, 300, 3), LOSE: mk(-0.002, 0.004, 300, 5), A: mk(0, 0.01, 300, 7), B: mk(0.0005, 0.02, 300, 9), C: mk(-0.0005, 0.015, 300, 11), SHORT: mk(0, 0.01, 50, 13) };
  const Q = B.quantScores(closes, mk(0.0003, 0.008, 300, 17));
  assert.ok(Q.WIN.score > Q.LOSE.score); assert.ok(Q.WIN.score > 0 && Q.LOSE.score < 0);
  assert.equal(Q.SHORT, undefined, "too little history → left out, not estimated");
  for (const x of Object.values(Q)) { assert.ok(x.score >= -1 && x.score <= 1); assert.ok(Object.values(x.z).every((z) => Math.abs(z) <= 3)); }
  assert.deepEqual(B.quantScores({ A: closes.A }, null), {}, "needs a cross-section");
});

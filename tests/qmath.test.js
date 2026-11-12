// Tests for public/qmath.js — every formula is checked against a hand calculation or a known identity.
const test = require("node:test"), assert = require("node:assert/strict");
const M = require("../public/qmath.js");
const near = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ""} expected ${b}, got ${a}`);

test("returns, mean, sample standard deviation", () => {
  const r = M.returns([100, 110, 99, 99]);
  near(r[0], 0.1); near(r[1], -0.1); near(r[2], 0);
  near(M.mean([1, 2, 3, 4]), 2.5);
  near(M.sd([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7)); // sample (n−1) variance = 32/7
});

test("annualized volatility and Sharpe use 252 days and a daily risk-free rate", () => {
  const r = [0.01, -0.005, 0.002, 0.004, -0.001];
  near(M.annVol(r), M.sd(r) * Math.sqrt(252));
  const rf = 0.0504, ex = r.map((x) => x - rf / 252);
  near(M.sharpe(r, rf), (M.mean(ex) / M.sd(ex)) * Math.sqrt(252));
  assert.ok(Number.isNaN(M.sharpe([0.01, 0.01, 0.01]))); // zero volatility → undefined, not Infinity
});

test("Sortino uses downside deviation over all observations", () => {
  const r = [0.02, -0.01, 0.03, -0.02];
  const dd = Math.sqrt((0.01 ** 2 + 0.02 ** 2) / 4);
  near(M.sortino(r, 0), (M.mean(r) / dd) * Math.sqrt(252));
});

test("maximum drawdown finds the worst peak-to-trough fall", () => {
  const d = M.maxDrawdown([100, 120, 90, 130, 104, 140]);
  near(d.mdd, 0.25); assert.equal(d.peak, 1); assert.equal(d.trough, 2);
  assert.deepEqual(M.drawdownSeries([100, 50, 100]).map((x) => +x.toFixed(2)), [0, -0.5, 0]);
});

test("historical VaR and expected shortfall", () => {
  const r = Array.from({ length: 100 }, (_, i) => (i - 50) / 1000); // -0.050 … 0.049
  const q = M.quantile(r, 0.05); near(q, -0.05 + 0.00495, 1e-12);
  near(M.varHist(r, 0.95), -q);
  const tail = r.filter((x) => x <= q); near(M.esHist(r, 0.95), -M.mean(tail));
  assert.ok(M.esHist(r) >= M.varHist(r)); // ES is never smaller than VaR
  near(M.invNorm(0.95), 1.6448536269514722, 1e-8); near(M.invNorm(0.5), 0, 1e-12);
});

test("covariance, correlation and beta", () => {
  const a = [1, 2, 3, 4, 5], b = [2, 4, 6, 8, 10], c = [5, 4, 3, 2, 1];
  near(M.covariance(a, b), 5); near(M.correlation(a, b), 1); near(M.correlation(a, c), -1);
  near(M.beta(b, a), 2); near(M.beta(a, b), 0.5);
  const C = M.covMatrix([a, b]); near(C[0][1], C[1][0]); near(C[0][0], 2.5);
  const K = M.corrMatrix([a, b, c]); near(K[0][2], -1); near(K[1][1], 1);
});

test("portfolio variance, risk contributions and diversification", () => {
  const C = [[0.04, 0.006], [0.006, 0.09]], w = [0.6, 0.4];
  near(M.pVar(w, C), 0.36 * 0.04 + 0.16 * 0.09 + 2 * 0.24 * 0.006);
  const rc = M.riskContrib(w, C); near(rc[0] + rc[1], 1);
  near(rc[0], (0.6 * (0.6 * 0.04 + 0.4 * 0.006)) / M.pVar(w, C));
  const d = M.diversification(w, C); assert.ok(d.ratio > 1); near(d.effectiveN, 1 / (0.36 + 0.16));
  const pr = M.portReturns([[0.01, 0.02], [0.03, -0.01]], [0.5, 0.5]); near(pr[0], 0.02); near(pr[1], 0.005);
});

test("OLS recovers known coefficients", () => {
  const x1 = Array.from({ length: 50 }, (_, i) => Math.sin(i)), x2 = Array.from({ length: 50 }, (_, i) => Math.cos(i * 1.7));
  const y = x1.map((v, i) => 0.002 + 1.3 * v - 0.4 * x2[i]);
  const f = M.ols(y, [x1, x2]); near(f.alpha, 0.002, 1e-9); near(f.betas[0], 1.3, 1e-9); near(f.betas[1], -0.4, 1e-9); near(f.r2, 1, 1e-9);
});

test("projection keeps weights inside bounds and summing to one", () => {
  const w = M.project([0.9, 0.5, -0.2, 0.1], 0.05, 0.4);
  near(w.reduce((a, b) => a + b, 0), 1, 1e-9); for (const x of w) assert.ok(x >= 0.05 - 1e-9 && x <= 0.4 + 1e-9);
});

test("optimizers respect constraints; min-variance matches the two-asset formula", () => {
  const C = [[0.04, 0.006], [0.006, 0.09]], mu = [0.08, 0.12];
  const o = M.optimize(mu, C, { lo: 0, hi: 1, rf: 0.02 });
  const wStar = (0.09 - 0.006) / (0.04 + 0.09 - 2 * 0.006); // analytic minimum-variance weight in asset 1
  near(o.minVar.w[0], wStar, 1e-4);
  for (const k of ["minVar", "maxSharpe", "riskParity", "equal"]) { near(o[k].w.reduce((a, b) => a + b, 0), 1, 1e-8, k); for (const x of o[k].w) assert.ok(x >= -1e-9 && x <= 1 + 1e-9, k); }
  assert.ok(o.maxSharpe.sharpe >= o.minVar.sharpe - 1e-9 && o.maxSharpe.sharpe >= o.equal.sharpe - 1e-9);
  const rc = M.riskContrib(o.riskParity.w, C); near(rc[0], 0.5, 1e-4); // equal risk contributions
  const capped = M.optimize([0.1, 0.1, 0.1, 0.3], [[0.04, 0, 0, 0], [0, 0.04, 0, 0], [0, 0, 0.04, 0], [0, 0, 0, 0.04]], { lo: 0, hi: 0.3 });
  for (const k of ["minVar", "maxSharpe", "riskParity"]) for (const x of capped[k].w) assert.ok(x <= 0.3 + 1e-8, k);
  assert.throws(() => M.optimize([0.1, 0.1], C, { lo: 0, hi: 0.3 }), /infeasible/);
});

test("turnover and trading costs", () => {
  near(M.turnover([0.5, 0.5], [0.8, 0.2]), 0.3);
  near(M.tradeCost([0.5, 0.5], [0.8, 0.2], 10000, 10), 0.6 * 10000 * 0.001);
});

test("Monte Carlo is reproducible with a seed and statistically sensible", () => {
  const a = M.monteCarlo({ start: 10000, mu: 0.07, sigma: 0.15, years: 5, paths: 1500, seed: 7 });
  const b = M.monteCarlo({ start: 10000, mu: 0.07, sigma: 0.15, years: 5, paths: 1500, seed: 7 });
  const c = M.monteCarlo({ start: 10000, mu: 0.07, sigma: 0.15, years: 5, paths: 1500, seed: 8 });
  assert.deepEqual(a.bands.p50, b.bands.p50); assert.notDeepEqual(a.bands.p50, c.bands.p50);
  assert.ok(a.bands.p5[60] < a.bands.p50[60] && a.bands.p50[60] < a.bands.p95[60]);
  // GBM median = S·exp((μ − σ²/2)·T)
  const med = 10000 * Math.exp((0.07 - 0.0225 / 2) * 5); assert.ok(Math.abs(a.terminal.p50 / med - 1) < 0.05);
  assert.equal(a.hist.reduce((s, h) => s + h.n, 0), 1500);
  const z = M.monteCarlo({ start: 100, mu: 0, sigma: 0, years: 1, paths: 10, contrib: 10 }); near(z.terminal.p50, 220, 1e-9); // contributions accumulate exactly with no risk
});

test("MDS places perfectly correlated assets together; clustering groups them", () => {
  const K = [[1, 0.95, -0.2], [0.95, 1, -0.1], [-0.2, -0.1, 1]];
  const P = M.mds(K, 2), d = (i, j) => Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
  assert.ok(d(0, 1) < d(0, 2) && d(0, 1) < d(1, 2));
  near(d(0, 1), Math.sqrt(2 * (1 - 0.95)), 0.02);
  const cl = M.cluster(K, 0.5); assert.ok(cl.clusters.some((g) => g.includes(0) && g.includes(1) && !g.includes(2)));
});

test("regime rules label a steady uptrend and a crash", () => {
  const up = Array.from({ length: 400 }, (_, i) => 100 * Math.exp(0.0005 * i + 0.003 * Math.sin(i)));
  assert.equal(M.regimeAt(up, 399).label, "Risk-on trend");
  const crash = up.slice(0, 360).concat(Array.from({ length: 40 }, (_, i) => up[359] * (1 - 0.008 * (i + 1)) * (1 + 0.02 * Math.sin(i * 2))));
  assert.match(M.regimeAt(crash, 399).label, /Risk-off|Correction/);
  assert.equal(M.regimeAt(up, 100), null);
});

test("align intersects dates and prefers adjusted closes", () => {
  const A = M.align({ X: { t: [86400, 172800, 259200], close: [10, 11, 12], adj: [5, 5.5, 6] }, Y: { t: [172800, 259200], close: [1, 2] } });
  assert.deepEqual(A.dates, [172800, 259200]); assert.deepEqual(A.px.X, [5.5, 6]); assert.deepEqual(A.px.Y, [1, 2]);
});

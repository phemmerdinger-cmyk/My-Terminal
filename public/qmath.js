/* QMATH — the numerical core of the Quant page. Plain functions, no dependencies, works in the browser, in a Web
   Worker and in Node (tests/qmath.test.js checks every formula). Conventions:
   - returns are simple daily returns r_t = P_t / P_{t-1} - 1 computed from split/dividend-adjusted closes
   - annualization uses 252 trading days; volatility = sample standard deviation (n − 1) × √252
   - risk-free rates are annual decimals (0.045 = 4.5%) and are converted to a daily rate rf/252
   - VaR / ES are reported as positive loss fractions (0.021 = a 2.1% one-day loss) */
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.QMATH = factory(); })(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const DAYS = 252;
  const sum = (a) => { let s = 0; for (const x of a) s += x; return s; };
  const mean = (a) => (a.length ? sum(a) / a.length : NaN);
  function sd(a) { const n = a.length; if (n < 2) return NaN; const m = mean(a); let s = 0; for (const x of a) s += (x - m) * (x - m); return Math.sqrt(s / (n - 1)); }
  function quantile(a, q) { const s = [...a].sort((x, y) => x - y); if (!s.length) return NaN; const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); }

  // ------------------------------------------------------------------ series
  function returns(px) { const r = []; for (let i = 1; i < px.length; i++) if (px[i - 1] > 0 && px[i] != null && px[i - 1] != null) r.push(px[i] / px[i - 1] - 1); return r; }
  // Align several {t, close, adj} histories on the dates every symbol traded. Uses adjusted closes when present.
  function align(series) {
    const syms = Object.keys(series).filter((s) => series[s] && series[s].t && series[s].t.length > 1); if (!syms.length) return { dates: [], px: {}, syms: [] };
    const day = (t) => Math.floor(t / 86400), maps = {};
    for (const s of syms) { const S = series[s], src = S.adj && S.adj.length === S.t.length ? S.adj : S.close, m = new Map(); S.t.forEach((t, i) => { if (src[i] != null && src[i] > 0) m.set(day(t), src[i]); }); maps[s] = m; }
    const dates = [...maps[syms[0]].keys()].filter((d) => syms.every((s) => maps[s].has(d))).sort((a, b) => a - b);
    const px = {}; for (const s of syms) px[s] = dates.map((d) => maps[s].get(d));
    return { dates: dates.map((d) => d * 86400), px, syms };
  }
  const annRet = (r) => mean(r) * DAYS;
  const annVol = (r) => sd(r) * Math.sqrt(DAYS);
  function cagr(eq, years) { return eq.length > 1 && years > 0 ? Math.pow(eq[eq.length - 1] / eq[0], 1 / years) - 1 : NaN; }
  function sharpe(r, rf = 0) { const ex = r.map((x) => x - rf / DAYS), s = sd(ex); return s > 0 ? (mean(ex) / s) * Math.sqrt(DAYS) : NaN; }
  // Sortino: mean excess return over downside deviation, where downside deviation uses every observation
  // (returns above the target count as zero), divided by n.
  function sortino(r, rf = 0) { const t = rf / DAYS, ex = r.map((x) => x - t); const dd = Math.sqrt(mean(ex.map((x) => (x < 0 ? x * x : 0)))); return dd > 0 ? (mean(ex) / dd) * Math.sqrt(DAYS) : NaN; }
  function maxDrawdown(eq) { let peak = eq[0], pi = 0, best = 0, bp = 0, bt = 0; for (let i = 0; i < eq.length; i++) { if (eq[i] > peak) { peak = eq[i]; pi = i; } const d = eq[i] / peak - 1; if (d < best) { best = d; bp = pi; bt = i; } } return { mdd: -best, peak: bp, trough: bt }; }
  function drawdownSeries(eq) { let peak = -Infinity; return eq.map((v) => { peak = Math.max(peak, v); return v / peak - 1; }); }
  // Historical VaR / ES at confidence c (0.95): VaR = −(5th percentile return); ES = −(mean of returns at or below it)
  function varHist(r, c = 0.95) { return -quantile(r, 1 - c); }
  function esHist(r, c = 0.95) { const q = quantile(r, 1 - c), tail = r.filter((x) => x <= q); return tail.length ? -mean(tail) : NaN; }
  // Parametric (normal) VaR for comparison: −(μ − z σ), z(95%) = 1.6449
  function varNormal(r, c = 0.95) { const z = invNorm(c); return -(mean(r) - z * sd(r)); }
  function invNorm(p) { // Acklam's rational approximation (|error| < 1.2e-9)
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239], b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572], c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783], d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425; let q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q; return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function covariance(a, b) { const n = Math.min(a.length, b.length); if (n < 2) return NaN; const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n)); let s = 0; for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb); return s / (n - 1); }
  function correlation(a, b) { const c = covariance(a, b), sa = sd(a), sb = sd(b); return sa > 0 && sb > 0 ? c / (sa * sb) : NaN; }
  function beta(r, m) { const v = covariance(m, m); return v > 0 ? covariance(r, m) / v : NaN; }
  function covMatrix(R) { const k = R.length; const C = Array.from({ length: k }, () => new Array(k).fill(0)); for (let i = 0; i < k; i++) for (let j = i; j < k; j++) C[i][j] = C[j][i] = covariance(R[i], R[j]); return C; }
  function corrMatrix(R) { const C = covMatrix(R), s = C.map((r, i) => Math.sqrt(r[i])); return C.map((r, i) => r.map((v, j) => (i === j ? 1 : s[i] > 0 && s[j] > 0 ? v / (s[i] * s[j]) : 0))); }
  function rollingCorr(a, b, w) { const out = []; for (let i = 0; i < a.length; i++) out.push(i + 1 < w ? null : correlation(a.slice(i + 1 - w, i + 1), b.slice(i + 1 - w, i + 1))); return out; }

  // ------------------------------------------------------------------ portfolio algebra
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const mv = (M, v) => M.map((r) => dot(r, v));
  const pVar = (w, C) => dot(w, mv(C, w));
  function normalize(w) { const s = sum(w.map((x) => Math.max(0, x))); return s > 0 ? w.map((x) => Math.max(0, x) / s) : w.map(() => 1 / w.length); }
  // Risk contribution of each asset to portfolio variance: RC_i = w_i (Σw)_i / (w'Σw); the shares sum to 1.
  function riskContrib(w, C) { const Cw = mv(C, w), v = dot(w, Cw); return w.map((x, i) => (v > 0 ? (x * Cw[i]) / v : 0)); }
  function portReturns(R, w) { const n = Math.min(...R.map((r) => r.length)), out = new Array(n).fill(0); for (let k = 0; k < R.length; k++) for (let i = 0; i < n; i++) out[i] += w[k] * R[k][i]; return out; }
  // Diversification ratio = Σ w_i σ_i / σ_p (1 = no diversification); effective number of holdings = 1 / Σ w_i²
  function diversification(w, C) { const sp = Math.sqrt(pVar(w, C)); return { ratio: sp > 0 ? dot(w, C.map((r, i) => Math.sqrt(r[i]))) / sp : NaN, effectiveN: 1 / sum(w.map((x) => x * x)) }; }

  // ------------------------------------------------------------------ OLS regression y = a + Xb (normal equations, Gauss-Jordan)
  function solve(A, b) { const n = A.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; if (Math.abs(M[p][c]) < 1e-14) return null; [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; } }
    return M.map((r, i) => r[n] / r[i]); }
  function inverse(A) { const n = A.length; const cols = []; for (let j = 0; j < n; j++) { const e = new Array(n).fill(0); e[j] = 1; const c = solve(A, e); if (!c) return null; cols.push(c); } return A.map((_, i) => cols.map((c) => c[i])); }
  function ols(y, X) { // X: array of factor columns
    const n = y.length, k = X.length + 1, rows = y.map((_, i) => [1, ...X.map((c) => c[i])]);
    const XtX = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => { let s = 0; for (const r of rows) s += r[a] * r[b]; return s; }));
    const Xty = Array.from({ length: k }, (_, a) => { let s = 0; rows.forEach((r, i) => (s += r[a] * y[i])); return s; });
    const b = solve(XtX, Xty); if (!b) return null;
    const fit = rows.map((r) => dot(r, b)), res = y.map((v, i) => v - fit[i]), my = mean(y), sst = sum(y.map((v) => (v - my) ** 2)), sse = sum(res.map((e) => e * e));
    const s2 = sse / Math.max(1, n - k), inv = inverse(XtX), se = inv ? inv.map((r, i) => Math.sqrt(Math.max(0, r[i] * s2))) : b.map(() => NaN);
    return { alpha: b[0], betas: b.slice(1), t: b.map((v, i) => v / se[i]), se, r2: sst > 0 ? 1 - sse / sst : NaN, n };
  }

  // ------------------------------------------------------------------ eigen / MDS / clustering
  function eigSym(A, k) { // eigenpairs of a symmetric matrix by cyclic Jacobi rotations (robust to repeated eigenvalues); top k by value
    const n = A.length, a = A.map((r) => [...r]), V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j]; if (off < 1e-22) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) { if (Math.abs(a[p][q]) < 1e-300) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), sn = t * c;
        for (let r = 0; r < n; r++) { const x = a[r][p], y = a[r][q]; a[r][p] = c * x - sn * y; a[r][q] = sn * x + c * y; }
        for (let r = 0; r < n; r++) { const x = a[p][r], y = a[q][r]; a[p][r] = c * x - sn * y; a[q][r] = sn * x + c * y; }
        for (let r = 0; r < n; r++) { const x = V[r][p], y = V[r][q]; V[r][p] = c * x - sn * y; V[r][q] = sn * x + c * y; } } }
    return Array.from({ length: n }, (_, i) => ({ value: a[i][i], vector: V.map((r) => r[i]) })).sort((x, y) => y.value - x.value).slice(0, Math.min(k, n));
  }
  // Classical multidimensional scaling of a correlation matrix: distance d_ij = √(2(1 − ρ_ij)), so assets that move
  // together sit close together. Returns k-dimensional coordinates.
  function mds(Cor, k = 3) {
    const n = Cor.length; if (n === 1) return [new Array(k).fill(0)];
    const D2 = Cor.map((r) => r.map((p) => 2 * (1 - p))), rm = D2.map(mean), gm = mean(rm);
    const B = D2.map((r, i) => r.map((x, j) => -0.5 * (x - rm[i] - rm[j] + gm)));
    const E = eigSym(B, k); return Array.from({ length: n }, (_, i) => Array.from({ length: k }, (_, d) => (E[d] && E[d].value > 0 ? E[d].vector[i] * Math.sqrt(E[d].value) : 0)));
  }
  // Average-linkage hierarchical clustering on d = 1 − ρ. Returns the leaf order (for the heatmap) and clusters cut at `cut`.
  function cluster(Cor, cut = 0.5) {
    let C = Cor.map((_, i) => ({ items: [i] })); const d = (a, b) => { let s = 0; for (const i of a.items) for (const j of b.items) s += 1 - Cor[i][j]; return s / (a.items.length * b.items.length); };
    const groups = []; let done = false;
    while (C.length > 1) { let bi = 0, bj = 1, bd = Infinity; for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) { const x = d(C[i], C[j]); if (x < bd) { bd = x; bi = i; bj = j; } }
      if (bd > cut && !done) { groups.push(...C.map((c) => c.items)); done = true; }
      const m = { items: [...C[bi].items, ...C[bj].items] }; C = C.filter((_, i) => i !== bi && i !== bj); C.push(m); }
    if (!done) groups.push(C[0].items);
    return { order: C[0].items, clusters: groups };
  }

  // ------------------------------------------------------------------ optimization (long-only, with per-asset bounds)
  // Euclidean projection onto { Σw = 1, lo ≤ w ≤ hi } by bisection on the shift λ.
  function project(v, lo, hi) { let a = Math.min(...v) - hi - 1, b = Math.max(...v) - lo + 1; const f = (l) => sum(v.map((x) => Math.min(hi, Math.max(lo, x - l)))) - 1;
    for (let it = 0; it < 100; it++) { const m = (a + b) / 2; if (f(m) > 0) a = m; else b = m; } const l = (a + b) / 2; return v.map((x) => Math.min(hi, Math.max(lo, x - l))); }
  function feasible(n, lo, hi) { return n * lo <= 1 + 1e-9 && n * hi >= 1 - 1e-9; }
  // minimize ½ w'Σw − λ μ'w by projected gradient descent (λ = 0 → minimum variance)
  function meanVar(mu, C, lam, lo, hi) { const n = mu.length; let w = project(new Array(n).fill(1 / n), lo, hi); const L = Math.max(1e-12, ...C.map((r) => sum(r.map(Math.abs)))), step = 1 / L;
    for (let it = 0; it < 3000; it++) { const g = mv(C, w).map((x, i) => x - lam * mu[i]); const nw = project(w.map((x, i) => x - step * g[i]), lo, hi); let ch = 0; for (let i = 0; i < n; i++) ch += Math.abs(nw[i] - w[i]); w = nw; if (ch < 1e-11) break; } return w; }
  const stats = (w, mu, C, rf) => { const r = dot(w, mu), v = Math.sqrt(pVar(w, C)); return { ret: r, vol: v, sharpe: v > 0 ? (r - rf) / v : NaN }; };
  // mu, C are annualized. Returns the efficient frontier and the four standard portfolios.
  function optimize(mu, C, { lo = 0, hi = 1, rf = 0 } = {}) {
    const n = mu.length; if (!feasible(n, lo, hi)) throw new Error(`Constraints are infeasible: ${n} assets can't sum to 100% with weights between ${lo * 100}% and ${hi * 100}%.`);
    const minVar = meanVar(mu, C, 0, lo, hi), frontier = [];
    const scale = Math.max(...C.map((r, i) => r[i])) / Math.max(1e-9, Math.max(...mu.map(Math.abs)));
    for (const k of [0, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2.5, 4, 7, 12, 25]) { const w = meanVar(mu, C, k * scale, lo, hi); frontier.push({ w, ...stats(w, mu, C, rf) }); }
    let best = frontier.reduce((a, b) => (b.sharpe > a.sharpe ? b : a));
    // refine max-Sharpe with a local search between frontier neighbours
    for (let k = 0; k < 2; k++) { const i = frontier.indexOf(best), a = frontier[Math.max(0, i - 1)], b = frontier[Math.min(frontier.length - 1, i + 1)];
      for (let t = 0; t <= 1; t += 0.1) { const w = project(a.w.map((x, j) => x * (1 - t) + b.w[j] * t), lo, hi), s = stats(w, mu, C, rf); if (s.sharpe > best.sharpe) best = { w, ...s }; } }
    const eq = project(new Array(n).fill(1 / n), lo, hi);
    return { minVar: { w: minVar, ...stats(minVar, mu, C, rf) }, maxSharpe: { w: best.w, ...stats(best.w, mu, C, rf) }, riskParity: (() => { const w = riskParity(C, lo, hi); return { w, ...stats(w, mu, C, rf) }; })(), equal: { w: eq, ...stats(eq, mu, C, rf) }, frontier: frontier.sort((a, b) => a.vol - b.vol) };
  }
  // Equal risk contribution: iterate w_i ← w_i · √((1/n) / RC_i), then project onto the bounds.
  function riskParity(C, lo = 0, hi = 1) { const n = C.length; let w = project(C.map((r, i) => 1 / Math.sqrt(Math.max(1e-12, r[i]))), lo, hi);
    for (let it = 0; it < 500; it++) { const rc = riskContrib(w, C); const nw = project(normalize(w.map((x, i) => x * Math.sqrt(1 / n / Math.max(1e-12, rc[i])))), lo, hi); let ch = 0; for (let i = 0; i < n; i++) ch += Math.abs(nw[i] - w[i]); w = nw; if (ch < 1e-10) break; } return w; }
  // One-way turnover and the cost of moving from w0 to w1 on a portfolio of `value` at `bps` per side.
  function turnover(w0, w1) { return sum(w0.map((x, i) => Math.abs(w1[i] - x))) / 2; }
  const tradeCost = (w0, w1, value, bps) => sum(w0.map((x, i) => Math.abs(w1[i] - x))) * value * (bps / 1e4);

  // ------------------------------------------------------------------ Monte Carlo (seeded, reproducible)
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function gauss(rand) { let u = 0; while (u === 0) u = rand(); const v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  // Geometric Brownian motion in monthly steps: V ← (V + contribution) · exp((μ − σ²/2)/12 + σ/√12 · Z).
  // Returns percentile bands per month, a sample of paths, the terminal distribution and loss probabilities.
  function monteCarlo({ start, mu, sigma, years = 10, paths = 2000, contrib = 0, seed = 42, keep = 60, onProgress }) {
    const rand = mulberry32(seed >>> 0), m = Math.round(years * 12), drift = (mu - (sigma * sigma) / 2) / 12, vol = sigma / Math.sqrt(12);
    const cols = Array.from({ length: m + 1 }, () => new Float64Array(paths)), sample = [];
    for (let p = 0; p < paths; p++) { let v = start; cols[0][p] = v; const keepIt = p < keep, path = keepIt ? [v] : null;
      for (let t = 1; t <= m; t++) { v = (v + contrib) * Math.exp(drift + vol * gauss(rand)); cols[t][p] = v; if (keepIt) path.push(v); }
      if (keepIt) sample.push(path); if (onProgress && p % 250 === 249) onProgress((p + 1) / paths); }
    const Q = [0.05, 0.25, 0.5, 0.75, 0.95], bands = Q.map(() => []);
    for (let t = 0; t <= m; t++) { const s = Array.from(cols[t]).sort((a, b) => a - b); Q.forEach((q, k) => bands[k].push(s[Math.min(paths - 1, Math.floor(q * (paths - 1)))])); }
    const term = Array.from(cols[m]).sort((a, b) => a - b), invested = start + contrib * m;
    const lo = term[0], hi = term[paths - 1], bins = 30, w = (Math.log(hi) - Math.log(lo)) / bins || 1, hist = new Array(bins).fill(0);
    for (const x of term) hist[Math.min(bins - 1, Math.floor((Math.log(x) - Math.log(lo)) / w))]++;
    return { months: m, bands: { p5: bands[0], p25: bands[1], p50: bands[2], p75: bands[3], p95: bands[4] }, sample, invested,
      probBelowStart: term.filter((x) => x < start).length / paths, probBelowInvested: term.filter((x) => x < invested).length / paths,
      terminal: { p5: bands[0][m], p50: bands[2][m], p95: bands[4][m], mean: mean(term) }, hist: hist.map((c, i) => ({ from: Math.exp(Math.log(lo) + i * w), to: Math.exp(Math.log(lo) + (i + 1) * w), n: c })), seed, paths };
  }

  // ------------------------------------------------------------------ market regime (transparent rules)
  // Inputs: benchmark prices (e.g. SPY), optional credit ratio (HYG/IEF) and a date index. Each day gets:
  // trend (price vs 200-day average, 50 vs 200), realized 21-day volatility vs its 1-year median, drawdown from the
  // 252-day high and the 63-day credit trend. The rules below turn those into one of four labels.
  function sma(a, n, i) { if (i + 1 < n) return null; let s = 0; for (let k = i + 1 - n; k <= i; k++) s += a[k]; return s / n; }
  function regimeAt(px, i, credit) {
    if (i < 275) return null; // needs a year of history plus the 21-day volatility window
    const p = px[i], m200 = sma(px, 200, i), m50 = sma(px, 50, i), r = []; for (let k = i - 20; k <= i; k++) r.push(px[k] / px[k - 1] - 1);
    const rv = sd(r) * Math.sqrt(DAYS), hist = []; for (let k = i - 251; k <= i; k += 5) { const rr = []; for (let j = k - 20; j <= k; j++) rr.push(px[j] / px[j - 1] - 1); hist.push(sd(rr) * Math.sqrt(DAYS)); }
    const volMed = quantile(hist, 0.5), high = Math.max(...px.slice(i - 251, i + 1)), dd = p / high - 1;
    const cr = credit && credit[i] != null && credit[i - 63] != null ? credit[i] / credit[i - 63] - 1 : null;
    const ind = { aboveTrend: p > m200, goldenCross: m50 > m200, vol: rv, volMedian: volMed, volHigh: rv > volMed * 1.4, drawdown: dd, credit: cr };
    let label, score = 0; score += ind.aboveTrend ? 1 : -1; score += ind.goldenCross ? 1 : -1; score += ind.volHigh ? -1 : 0.5; score += dd < -0.1 ? -1 : 0; score += cr == null ? 0 : cr > 0 ? 0.5 : -0.5;
    if (dd < -0.2 || (ind.volHigh && !ind.aboveTrend)) label = "Risk-off / high volatility";
    else if (!ind.aboveTrend || dd < -0.1) label = "Correction";
    else if (ind.aboveTrend && ind.goldenCross && !ind.volHigh) label = "Risk-on trend";
    else label = "Choppy / late-cycle";
    return { label, score, ind };
  }
  function regimes(px, credit, step = 5) { const out = []; for (let i = 275; i < px.length; i += step) out.push({ i, ...regimeAt(px, i, credit) }); if (px.length > 275 && (px.length - 1 - 275) % step) out.push({ i: px.length - 1, ...regimeAt(px, px.length - 1, credit) }); return out; }

  // ------------------------------------------------------------------ network & risk anatomy
  // Minimum spanning tree of the correlation distance d = √(2(1 − ρ)) (Mantegna 1999, "Hierarchical structure in
  // financial markets"): the n − 1 strongest links that connect every holding without loops. Prim's algorithm.
  function mst(Cor) { const n = Cor.length, D = (i, j) => Math.sqrt(Math.max(0, 2 * (1 - Cor[i][j]))), inT = new Array(n).fill(false), best = new Array(n).fill(Infinity), par = new Array(n).fill(-1), edges = []; if (!n) return edges; best[0] = 0;
    for (let it = 0; it < n; it++) { let u = -1; for (let i = 0; i < n; i++) if (!inT[i] && (u < 0 || best[i] < best[u])) u = i; inT[u] = true; if (par[u] >= 0) edges.push({ a: par[u], b: u, d: best[u], rho: Cor[par[u]][u] });
      for (let v = 0; v < n; v++) if (!inT[v] && D(u, v) < best[v]) { best[v] = D(u, v); par[v] = u; } }
    return edges; }
  // Principal components of a covariance matrix: eigenvalues (descending) and the share of total variance each explains.
  function pca(C) { const E = eigSym(C, C.length).filter((e) => e.value > 1e-14), tot = E.reduce((a, e) => a + e.value, 0); return E.map((e) => ({ value: e.value, share: e.value / tot, vector: e.vector })); }
  // Effective number of bets (Meucci 2009): split portfolio variance into uncorrelated principal-component bets,
  // p_k = (e_k·w)² λ_k / σ², then ENB = exp(−Σ p_k ln p_k). 1 = a single bet; n = n fully independent equal bets.
  function enb(w, C) { const P = pca(C), v = pVar(w, C); if (!(v > 0)) return { enb: NaN, p: [] }; const p = P.map((e) => (dot(e.vector, w) ** 2 * e.value) / v); const s = p.reduce((a, b) => a + b, 0), q = p.map((x) => x / s);
    return { enb: Math.exp(-q.reduce((a, x) => a + (x > 0 ? x * Math.log(x) : 0), 0)), p: q, pcs: P }; }
  // Volatility if every pairwise correlation became rho (a "correlation spike"), keeping each asset's own volatility.
  function stressVol(w, C, rho) { const s = C.map((r, i) => Math.sqrt(Math.max(0, r[i]))); let v = 0; for (let i = 0; i < w.length; i++) for (let j = 0; j < w.length; j++) v += w[i] * w[j] * s[i] * s[j] * (i === j ? 1 : rho); return Math.sqrt(Math.max(0, v)); }
  // Parametric component VaR: CVaR_i = z · w_i (Σw)_i / σ_p; the components sum exactly to the portfolio VaR z·σ_p.
  function componentVaR(w, C, c = 0.95) { const z = invNorm(c), Cw = mv(C, w), sp = Math.sqrt(dot(w, Cw)); return w.map((x, i) => (sp > 0 ? (z * x * Cw[i]) / sp : 0)); }

  return { mst, pca, enb, stressVol, componentVaR, DAYS, mean, sd, quantile, returns, align, annRet, annVol, cagr, sharpe, sortino, maxDrawdown, drawdownSeries, varHist, esHist, varNormal, invNorm,
    covariance, correlation, beta, covMatrix, corrMatrix, rollingCorr, dot, pVar, normalize, riskContrib, portReturns, diversification,
    solve, inverse, ols, eigSym, mds, cluster, project, optimize, riskParity, turnover, tradeCost, mulberry32, gauss, monteCarlo, regimeAt, regimes, sma };
});

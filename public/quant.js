/* Quantitative backtesting engine — runs in the browser (Backtest lab) and in Node (tests).
   Design rules that keep results honest:
   • No look-ahead: a signal on day t uses prices up to and including day t's close; the trade executes at day t+1's close.
   • Trading calendar = the benchmark's actual trading days (exchange holidays are simply absent from the data).
   • Prices: dividend- and split-adjusted closes (total return) when the source provides them, otherwise raw closes (flagged).
   • Costs on every trade: commission + half the bid-ask spread + slippage, in basis points of traded value.
   • Exposure limits: maximum weight per position and a minimum cash buffer; cash earns the risk-free rate.
   • Survivorship: the universe is today's tickers, and delisted securities aren't in the free data — always reported as a limitation.
   • Optimization is never presented as validation: optimized parameters are tested once on a later, unseen period,
     and walk-forward chains only out-of-sample periods. */
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.QUANT = factory(); })(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const DAYS = 252;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // ---------------------------------------------------------------- data alignment
  // series: { SYM: { t:[unix s], close:[], adj:[] | null } } → aligned arrays on the benchmark's trading days
  function align(series, bench, fromT = -Infinity, toT = Infinity) {
    const B = series[bench]; if (!B || !B.t || !B.t.length) throw new Error(`No price history for the benchmark ${bench}.`);
    const day = (t) => Math.floor(t / 86400);
    const dates = B.t.filter((t) => t >= fromT - 400 * 86400 && t <= toT); // keep ~400 days before the start for indicators
    const px = {}, raw = {}, adjusted = {}, gaps = {};
    for (const [s, S] of Object.entries(series)) {
      const m = new Map(), r = new Map(); const useAdj = !!(S.adj && S.adj.some((x) => x != null));
      S.t.forEach((t, i) => { const v = useAdj && S.adj[i] != null ? S.adj[i] : S.close[i]; if (v != null && v > 0) { m.set(day(t), v); r.set(day(t), S.close[i]); } });
      let last = null, lastI = -1, miss = 0; px[s] = []; raw[s] = []; adjusted[s] = useAdj;
      dates.forEach((t, i) => { const d = day(t); if (m.has(d)) { last = m.get(d); lastI = i; px[s].push(last); raw[s].push(r.get(d)); } else if (last != null && i - lastI <= 5) { px[s].push(last); raw[s].push(null); miss++; } else { px[s].push(null); raw[s].push(null); } });
      gaps[s] = miss;
    }
    const start = Math.max(0, dates.findIndex((t) => t >= fromT));
    return { dates, px, raw, adjusted, gaps, start };
  }

  // ---------------------------------------------------------------- indicators (cached per symbol)
  function indicators(px) {
    const cache = new Map();
    const memo = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };
    const sma = (n) => memo("sma" + n, () => { const o = new Array(px.length).fill(null); let s = 0, c = 0; for (let i = 0; i < px.length; i++) { if (px[i] == null) { s = 0; c = 0; continue; } s += px[i]; c++; if (c > n) { s -= px[i - n]; c = n; } if (c === n) o[i] = s / n; } return o; });
    const ema = (n) => memo("ema" + n, () => { const o = new Array(px.length).fill(null), k = 2 / (n + 1); let e = null, c = 0; for (let i = 0; i < px.length; i++) { if (px[i] == null) { e = null; c = 0; continue; } e = e == null ? px[i] : px[i] * k + e * (1 - k); if (++c >= n) o[i] = e; } return o; });
    const rsi = (n) => memo("rsi" + n, () => { const o = new Array(px.length).fill(null); let g = 0, l = 0, c = 0; for (let i = 1; i < px.length; i++) { if (px[i] == null || px[i - 1] == null) { g = l = c = 0; continue; } const d = px[i] - px[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); c++;
      if (c <= n) { g += up / n; l += dn / n; if (c < n) continue; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; } o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return o; }); // Wilder's smoothing
    const ret = (n, i) => (i - n >= 0 && px[i] != null && px[i - n] != null ? px[i] / px[i - n] - 1 : null);
    const vol = (n, i) => { if (i - n < 0) return null; const r = []; for (let k = i - n + 1; k <= i; k++) { if (px[k] == null || px[k - 1] == null) return null; r.push(Math.log(px[k] / px[k - 1])); } return sd(r) * Math.sqrt(DAYS); };
    return { sma, ema, rsi, ret, vol, hi: (n, i) => (i - n + 1 < 0 ? null : Math.max(...px.slice(i - n + 1, i + 1))), lo: (n, i) => (i - n + 1 < 0 ? null : Math.min(...px.slice(i - n + 1, i + 1))) };
  }

  // ---------------------------------------------------------------- custom rule language
  // e.g. entry "rsi(14) < 30 and price > sma(200)"   exit "rsi(14) > 55 or ret(20) < -0.1"
  // terms: number, price, sma(n), ema(n), rsi(n), ret(n), vol(n), high(n), low(n); operators < <= > >=; joined by and / or
  function compileRule(src) {
    const s = String(src || "").trim().toLowerCase(); if (!s) throw new Error("Write a rule, e.g. rsi(14) < 30");
    if (s.length > 200) throw new Error("Rule too long");
    const term = (t) => { t = t.trim(); let m;
      if (/^-?\d+(\.\d+)?%?$/.test(t)) { const v = parseFloat(t) / (t.endsWith("%") ? 100 : 1); return () => v; }
      if (t === "price") return (I, px, i) => px[i];
      if ((m = t.match(/^(sma|ema|rsi|ret|vol|high|low)\((\d{1,3})\)$/))) { const f = m[1], n = +m[2]; if (n < 1 || n > 400) throw new Error(`${f}(${n}): window must be 1–400`);
        return f === "sma" || f === "ema" || f === "rsi" ? (I, px, i) => I[f](n)[i] : f === "high" ? (I, px, i) => I.hi(n, i) : f === "low" ? (I, px, i) => I.lo(n, i) : (I, px, i) => I[f](n, i); }
      throw new Error(`Don't understand “${t}”. Use price, sma(n), ema(n), rsi(n), ret(n), vol(n), high(n), low(n) or a number.`); };
    const clause = (c) => { const m = c.match(/^(.+?)(<=|>=|<|>)(.+)$/); if (!m) throw new Error(`Each condition needs a comparison: “${c.trim()}”`); const a = term(m[1]), b = term(m[3]), op = m[2];
      return (I, px, i) => { const x = a(I, px, i), y = b(I, px, i); if (x == null || y == null) return false; return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y; }; };
    const ors = s.split(/\s+or\s+/).map((g) => g.split(/\s+and\s+/).map(clause));
    return (I, px, i) => ors.some((g) => g.every((f) => f(I, px, i)));
  }

  // ---------------------------------------------------------------- strategies
  // Each returns { freq, target(i, ctx) → { SYM: weight } | null (null = keep positions) }. ctx gives aligned prices and indicators.
  const periodKey = (t, f) => { const d = new Date(t * 1000), y = d.getUTCFullYear(), m = d.getUTCMonth(); return f === "monthly" ? y * 12 + m : f === "quarterly" ? y * 4 + Math.floor(m / 3) : f === "annual" ? y : f === "weekly" ? Math.floor((t / 86400 + 3) / 7) : t; };
  const topK = (scores, k) => scores.filter((x) => x.v != null && isFinite(x.v)).sort((a, b) => b.v - a.v).slice(0, k);
  const equal = (syms) => Object.fromEntries(syms.map((s) => [s, 1 / Math.max(1, syms.length)]));
  const STRATEGIES = {
    buyhold: { name: "Buy and hold", params: {}, make: (p, U) => ({ freq: "once", target: () => p.weights }) },
    rebalance: { name: "Fixed weights, rebalanced", params: { freq: "quarterly" }, make: (p) => ({ freq: p.freq || "quarterly", target: () => p.weights }) },
    momentum: { name: "Momentum (top performers)", params: { lookback: 126, skip: 21, top: 3, absolute: 1 }, grid: { lookback: [63, 126, 189, 252], top: [1, 2, 3, 4, 5] },
      make: (p, U) => ({ freq: "monthly", target: (i, c) => { const sc = topK(U.map((s) => ({ s, v: c.px[s][i - p.skip] != null && c.px[s][i - p.lookback] != null ? c.px[s][i - p.skip] / c.px[s][i - p.lookback] - 1 : null })), p.top);
        const keep = p.absolute ? sc.filter((x) => x.v > 0) : sc; return Object.fromEntries(keep.map((x) => [x.s, 1 / p.top])); } }) }, // absolute filter: losers' slots stay in cash
    meanrev: { name: "Mean reversion (buy short-term losers in uptrends)", params: { lookback: 5, top: 3, trend: 200 }, grid: { lookback: [3, 5, 10, 20], top: [1, 2, 3, 4, 5] },
      make: (p, U) => ({ freq: "weekly", target: (i, c) => { const sc = U.map((s) => { const I = c.ind[s], m = I.sma(p.trend)[i], r = I.ret(p.lookback, i); return { s, v: r != null && m != null && c.px[s][i] > m ? -r : null }; });
        return equal(topK(sc, p.top).filter((x) => x.v > 0).map((x) => x.s)); } }) },
    smacross: { name: "Moving-average crossover", params: { fast: 50, slow: 200 }, grid: { fast: [10, 20, 50, 100], slow: [100, 150, 200, 250] },
      make: (p, U) => ({ freq: "daily", target: (i, c) => { if (p.fast >= p.slow) return {}; const on = U.filter((s) => { const f = c.ind[s].sma(p.fast)[i], sl = c.ind[s].sma(p.slow)[i]; return f != null && sl != null && f > sl; }); return Object.fromEntries(on.map((s) => [s, 1 / U.length])); }, changeOnly: true }) },
    rsi: { name: "RSI oversold / recovery", params: { period: 14, buy: 30, sell: 55 }, grid: { buy: [20, 25, 30, 35, 40], sell: [50, 55, 60, 65, 70] },
      make: (p, U) => { const held = new Set(); return { freq: "daily", changeOnly: true, reset: () => held.clear(), target: (i, c) => { for (const s of U) { const r = c.ind[s].rsi(p.period)[i]; if (r == null) continue; if (!held.has(s) && r < p.buy) held.add(s); else if (held.has(s) && r > p.sell) held.delete(s); } return Object.fromEntries([...held].map((s) => [s, 1 / U.length])); } }; } },
    multifactor: { name: "Multi-factor (momentum + low volatility + trend)", params: { top: 3 }, grid: { top: [1, 2, 3, 4, 5, 6] },
      make: (p, U) => ({ freq: "monthly", target: (i, c) => { const z = (arr) => { const v = arr.filter((x) => x != null), m = mean(v), d = sd(v) || 1; return arr.map((x) => (x == null ? null : (x - m) / d)); };
        const mom = U.map((s) => (c.px[s][i - 21] != null && c.px[s][i - 252] != null ? c.px[s][i - 21] / c.px[s][i - 252] - 1 : null)), vol = U.map((s) => { const v = c.ind[s].vol(63, i); return v == null ? null : -v; }), tr = U.map((s) => { const m = c.ind[s].sma(200)[i]; return m ? c.px[s][i] / m - 1 : null; });
        const zm = z(mom), zv = z(vol), zt = z(tr), sc = U.map((s, k) => ({ s, v: zm[k] == null || zv[k] == null || zt[k] == null ? null : (zm[k] + zv[k] + zt[k]) / 3 }));
        return equal(topK(sc, p.top).map((x) => x.s)); } }) },
    riskparity: { name: "Risk parity (inverse volatility)", params: { window: 63 }, grid: { window: [21, 42, 63, 126, 252] },
      make: (p, U) => ({ freq: "monthly", target: (i, c) => { const iv = U.map((s) => { const v = c.ind[s].vol(p.window, i); return [s, v ? 1 / v : null]; }).filter((x) => x[1]); const t = iv.reduce((a, x) => a + x[1], 0); return t ? Object.fromEntries(iv.map(([s, v]) => [s, v / t])) : {}; } }) },
    custom: { name: "Custom rule", params: { entry: "rsi(14) < 30", exit: "rsi(14) > 55" },
      make: (p, U) => { const en = compileRule(p.entry), ex = compileRule(p.exit), held = new Set(); return { freq: "daily", changeOnly: true, reset: () => held.clear(), target: (i, c) => { for (const s of U) { if (c.px[s][i] == null) continue; if (!held.has(s) && en(c.ind[s], c.px[s], i)) held.add(s); else if (held.has(s) && ex(c.ind[s], c.px[s], i)) held.delete(s); } return Object.fromEntries([...held].map((s) => [s, 1 / U.length])); } }; } },
  };

  // ---------------------------------------------------------------- simulation
  function simulate(A, spec, range) {
    const U = spec.universe.filter((s) => A.px[s]), strat = STRATEGIES[spec.strategy];
    if (!strat) throw new Error("Unknown strategy");
    if (!U.length) throw new Error("No price history for the chosen symbols.");
    const P = { ...strat.params, ...(spec.params || {}) };
    if (spec.strategy === "buyhold" || spec.strategy === "rebalance") { const w = spec.weights || {}; const tot = Object.values(w).reduce((a, b) => a + Math.max(0, b), 0) || 1; P.weights = Object.fromEntries(Object.entries(w).filter(([s, v]) => v > 0 && A.px[s]).map(([s, v]) => [s, v / tot])); }
    const S = strat.make(P, U); if (S.reset) S.reset();
    const ind = spec._ind || Object.fromEntries(Object.keys(A.px).map((s) => [s, indicators(A.px[s])]));
    const ctx = { px: A.px, ind };
    const [i0, i1] = range || [A.start, A.dates.length - 1];
    const cost = ((spec.costs.commissionBps || 0) + (spec.costs.spreadBps || 0) / 2 + (spec.costs.slippageBps || 0)) / 1e4;
    const maxW = clamp(spec.limits.maxWeight || 1, 0.01, 1), minCash = clamp(spec.limits.minCash || 0, 0, 0.99), rfD = (spec.rf || 0) / DAYS;
    let cash = spec.initial, pending = null, lastKey = null, lastSig = "", costs = 0, traded = 0;
    const sh = {}, avg = {}, lastPx = {}, eq = [], trades = [], closed = [], expo = [];
    const price = (s, i) => { const v = A.px[s][i]; if (v != null) lastPx[s] = v; return v != null ? v : lastPx[s]; };
    for (let i = i0; i <= i1; i++) {
      if (i > i0) cash *= 1 + rfD;
      for (const s of Object.keys(A.px)) price(s, i);
      // 1) execute yesterday's decision at today's close (no look-ahead)
      if (pending) {
        const V = cash + Object.entries(sh).reduce((a, [s, n]) => a + n * (lastPx[s] || 0), 0);
        let w = Object.fromEntries(Object.entries(pending.w).filter(([s, v]) => v > 0 && A.px[s][i] != null));
        for (const s in w) w[s] = Math.min(w[s], maxW);
        const tot = Object.values(w).reduce((a, b) => a + b, 0); if (tot > 1 - minCash) for (const s in w) w[s] *= (1 - minCash) / tot;
        const orders = [...new Set([...Object.keys(sh), ...Object.keys(w)])].map((s) => ({ s, p: lastPx[s], d: (w[s] || 0) * V - (sh[s] || 0) * (lastPx[s] || 0) })).filter((o) => o.p && Math.abs(o.d) > Math.max(1, V * 0.0005));
        for (const o of orders.filter((o) => o.d < 0).concat(orders.filter((o) => o.d > 0))) { // sells first, then buys
          let val = o.d; if (val > 0) val = Math.min(val, Math.max(0, cash / (1 + cost))); if (Math.abs(val) < 1) continue;
          const n = val / o.p, fee = Math.abs(val) * cost;
          if (n < 0) { const q = Math.min(-n, sh[o.s] || 0), pnl = (o.p - (avg[o.s] || o.p)) * q - fee; closed.push({ s: o.s, pnl, ret: avg[o.s] ? o.p / avg[o.s] - 1 : 0, t: A.dates[i] }); sh[o.s] = (sh[o.s] || 0) - q; cash += q * o.p - fee; if (sh[o.s] < 1e-9) { delete sh[o.s]; delete avg[o.s]; } }
          else { avg[o.s] = ((avg[o.s] || 0) * (sh[o.s] || 0) + n * o.p) / ((sh[o.s] || 0) + n); sh[o.s] = (sh[o.s] || 0) + n; cash -= n * o.p + fee; }
          costs += fee; traded += Math.abs(val);
          trades.push({ t: A.dates[i], sym: o.s, side: n > 0 ? "BUY" : "SELL", shares: +Math.abs(n).toFixed(4), price: +o.p.toFixed(4), value: +Math.abs(val).toFixed(2), cost: +fee.toFixed(2), why: pending.why, signalDate: pending.t });
        }
        pending = null;
      }
      const V = cash + Object.entries(sh).reduce((a, [s, n]) => a + n * (lastPx[s] || 0), 0);
      eq.push(V); expo.push(V ? 1 - cash / V : 0);
      // 2) decide using data through today's close; execute tomorrow
      if (i < i1) {
        const key = S.freq === "daily" ? i : S.freq === "once" ? (i === i0 ? "x" : "x") : periodKey(A.dates[i], S.freq);
        const due = S.freq === "once" ? i === i0 : S.freq === "daily" ? true : key !== lastKey;
        if (due) { lastKey = key; const w = S.target(i, ctx); if (w) { const sig = JSON.stringify(Object.keys(w).sort()); if (!S.changeOnly || sig !== lastSig || i === i0) { pending = { w, t: A.dates[i], why: `${strat.name}: ${Object.keys(w).length ? Object.entries(w).map(([s, v]) => `${s} ${(v * 100).toFixed(0)}%`).join(", ") : "all cash"}` }; lastSig = sig; } } }
      }
    }
    return { dates: A.dates.slice(i0, i1 + 1), equity: eq, exposure: expo, trades, closed, costs, traded, params: P };
  }

  // ---------------------------------------------------------------- metrics
  function metrics(dates, eq, bench, rf = 0, extra = {}) {
    const r = eq.slice(1).map((v, i) => v / eq[i] - 1), b = bench ? bench.slice(1).map((v, i) => (bench[i] ? v / bench[i] - 1 : 0)) : null;
    const years = Math.max((dates[dates.length - 1] - dates[0]) / (365.25 * 86400), 1 / DAYS), rfD = rf / DAYS;
    const cagr = eq[0] > 0 ? (eq[eq.length - 1] / eq[0]) ** (1 / years) - 1 : null, vol = sd(r) * Math.sqrt(DAYS);
    const ex = r.map((x) => x - rfD), dd = Math.sqrt(mean(ex.map((x) => Math.min(0, x) ** 2))) * Math.sqrt(DAYS);
    let peak = eq[0], mdd = 0, ddS = []; for (const v of eq) { peak = Math.max(peak, v); const d = v / peak - 1; ddS.push(d); mdd = Math.min(mdd, d); }
    let beta = null, alpha = null, te = null, ir = null;
    if (b && b.length === r.length && r.length > 20) { const mb = mean(b), mr = mean(r); let cov = 0, vb = 0; for (let k = 0; k < r.length; k++) { cov += (r[k] - mr) * (b[k] - mb); vb += (b[k] - mb) ** 2; } beta = vb ? cov / vb : null;
      if (beta != null) alpha = ((mr - rfD) - beta * (mb - rfD)) * DAYS; const diff = r.map((x, k) => x - b[k]); te = sd(diff) * Math.sqrt(DAYS); ir = te ? (mean(diff) * DAYS) / te : null; }
    const sorted = r.slice().sort((x, y) => x - y), k5 = Math.max(0, Math.floor(sorted.length * 0.05) - 1), var95 = sorted.length ? -sorted[k5] : null, es95 = sorted.length ? -mean(sorted.slice(0, k5 + 1)) : null;
    const cl = extra.closed || [], wins = cl.filter((x) => x.pnl > 0), losses = cl.filter((x) => x.pnl <= 0), gw = wins.reduce((a, x) => a + x.pnl, 0), gl = -losses.reduce((a, x) => a + x.pnl, 0);
    const avgEq = mean(eq);
    return { start: dates[0], end: dates[dates.length - 1], years: +years.toFixed(2), finalValue: eq[eq.length - 1], totalReturn: eq[eq.length - 1] / eq[0] - 1, cagr, vol,
      sharpe: sd(r) ? (mean(ex) / sd(r)) * Math.sqrt(DAYS) : null, sortino: dd ? (mean(ex) * DAYS) / dd : null, maxDrawdown: mdd, calmar: mdd ? cagr / Math.abs(mdd) : null,
      beta, alpha, trackingError: te, infoRatio: ir, var95, es95, bestDay: sorted[sorted.length - 1] ?? null, worstDay: sorted[0] ?? null,
      trades: (extra.trades || []).length, closedTrades: cl.length, winRate: cl.length ? wins.length / cl.length : null, profitFactor: gl > 0 ? gw / gl : wins.length ? Infinity : null,
      avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null, turnover: avgEq && years ? (extra.traded || 0) / 2 / avgEq / years : null,
      costs: extra.costs || 0, avgExposure: extra.exposure ? mean(extra.exposure) : null, drawdown: ddS };
  }
  function monthly(dates, eq) {
    const out = {}; let prevEnd = eq[0], curKey = null, last = eq[0];
    dates.forEach((t, i) => { const d = new Date(t * 1000), k = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0"); if (curKey && k !== curKey) { out[curKey] = last / prevEnd - 1; prevEnd = last; } curKey = k; last = eq[i]; });
    if (curKey) out[curKey] = last / prevEnd - 1; return out;
  }
  function benchCurve(A, bench, i0, i1, initial) { const p = A.px[bench]; let base = null; return p.slice(i0, i1 + 1).map((v) => { if (v == null) return null; if (base == null) base = v; return (initial * v) / base; }); }

  // ---------------------------------------------------------------- one backtest
  function run(spec) {
    const A = spec._aligned || align(spec.series, spec.benchmark, spec.from, spec.to);
    spec._ind = spec._ind || Object.fromEntries(Object.keys(A.px).map((s) => [s, indicators(A.px[s])]));
    const R = simulate(A, spec, spec._range);
    const i0 = spec._range ? spec._range[0] : A.start, i1 = spec._range ? spec._range[1] : A.dates.length - 1;
    const bench = benchCurve(A, spec.benchmark, i0, i1, spec.initial).map((v, k, a) => v ?? a[k - 1] ?? spec.initial);
    const m = metrics(R.dates, R.equity, bench, spec.rf, R), mb = metrics(R.dates, bench, null, spec.rf);
    const lim = limitations(A, spec, R);
    return { kind: "backtest", label: "Backtested — hypothetical results from historical data", strategy: STRATEGIES[spec.strategy].name, params: R.params, dates: R.dates, equity: R.equity, bench, metrics: m, benchMetrics: mb,
      monthly: monthly(R.dates, R.equity), benchMonthly: monthly(R.dates, bench), trades: R.trades, limitations: lim,
      assumptions: { execution: "Signals use data through each day's close; trades execute at the next trading day's close.", prices: "Dividend- and split-adjusted closing prices (total return)", calendar: "The benchmark's actual trading days", costs: spec.costs, limits: spec.limits, rf: spec.rf, initial: spec.initial } };
  }
  function limitations(A, spec, R) {
    const L = ["Survivorship bias: the universe is today's tickers; companies that were delisted or went bankrupt aren't in the free price data, which tends to flatter results.",
      "Prices are daily closes from Yahoo Finance; intraday price paths, opening gaps and real order-book liquidity aren't modeled.", "No taxes, margin, short selling or borrowing costs."];
    const noAdj = spec.universe.filter((s) => A.px[s] && !A.adjusted[s]); if (noAdj.length) L.push(`No adjusted prices for ${noAdj.join(", ")}: dividends are not included for them.`);
    const late = spec.universe.filter((s) => A.px[s] && A.px[s][A.start] == null); if (late.length) L.push(`${late.join(", ")} started trading after the start date and only enter once data exists.`);
    const missing = spec.universe.filter((s) => !A.px[s]); if (missing.length) L.push(`No data at all for ${missing.join(", ")} — excluded.`);
    const gappy = Object.entries(A.gaps).filter(([, n]) => n > 10).map(([s]) => s); if (gappy.length) L.push(`Some missing days were filled with the previous close (up to 5 days) for ${gappy.join(", ")}.`);
    if (A.dates.length - A.start < DAYS) L.push("Less than one year of data: annualized figures are unreliable.");
    return L;
  }

  // ---------------------------------------------------------------- overfitting controls
  const cartesian = (grid) => Object.entries(grid).reduce((acc, [k, vals]) => acc.flatMap((a) => vals.map((v) => ({ ...a, [k]: v }))), [{}]);
  const valid = (spec, p) => !(spec.strategy === "smacross" && p.fast >= p.slow) && !(spec.strategy === "rsi" && p.buy >= p.sell) && !(p.top && p.top > spec.universe.length);
  function score(spec, params, range, A) { const R = simulate(A, { ...spec, params: { ...spec.params, ...params } }, range); return { params, m: metrics(R.dates, R.equity, null, spec.rf, R) }; }
  // optimize on the first part of the period, then test the chosen parameters ONCE on the unseen remainder
  function optimize(spec, split = 0.7) {
    const A = spec._aligned = spec._aligned || align(spec.series, spec.benchmark, spec.from, spec.to); spec._ind = spec._ind || Object.fromEntries(Object.keys(A.px).map((s) => [s, indicators(A.px[s])]));
    const grid = STRATEGIES[spec.strategy].grid; if (!grid) throw new Error("This strategy has no parameters to optimize.");
    const i0 = A.start, i1 = A.dates.length - 1, cut = i0 + Math.floor((i1 - i0) * split);
    if (cut - i0 < DAYS || i1 - cut < 126) throw new Error("Need at least ~1.5 years of data to split into in-sample and out-of-sample periods.");
    const tries = cartesian(grid).filter((p) => valid(spec, p)).map((p) => score(spec, p, [i0, cut], A)).filter((x) => x.m.sharpe != null);
    tries.sort((a, b) => b.m.sharpe - a.m.sharpe); const best = tries[0];
    const oos = run({ ...spec, params: { ...spec.params, ...best.params }, _range: [cut, i1] });
    return { inSample: { from: A.dates[i0], to: A.dates[cut], best: best.params, metrics: best.m, tried: tries.length }, outOfSample: oos, note: `Parameters were chosen on ${new Date(A.dates[i0] * 1000).getUTCFullYear()}–${new Date(A.dates[cut] * 1000).getUTCFullYear()} only and tested once on the later period they never saw. Only the out-of-sample result is evidence; the in-sample result is optimized and will look better.` };
  }
  // rolling windows: optimize on `train` years, apply to the next `test` year, step forward; chain only the test periods
  function walkForward(spec, train = 3, test = 1) {
    const A = spec._aligned = spec._aligned || align(spec.series, spec.benchmark, spec.from, spec.to); spec._ind = spec._ind || Object.fromEntries(Object.keys(A.px).map((s) => [s, indicators(A.px[s])]));
    const grid = STRATEGIES[spec.strategy].grid; if (!grid) throw new Error("This strategy has no parameters to optimize.");
    const combos = cartesian(grid).filter((p) => valid(spec, p)), win = [], tr = train * DAYS, te = test * DAYS;
    let eq = [spec.initial], dates = [], cur = spec.initial;
    for (let s = A.start; s + tr + 21 < A.dates.length; s += te) {
      const a = s, b = Math.min(s + tr, A.dates.length - 1), c = Math.min(b + te, A.dates.length - 1); if (c - b < 21) break;
      const best = combos.map((p) => score(spec, p, [a, b], A)).filter((x) => x.m.sharpe != null).sort((x, y) => y.m.sharpe - x.m.sharpe)[0]; if (!best) break;
      const R = simulate(A, { ...spec, initial: cur, params: { ...spec.params, ...best.params } }, [b, c]);
      const m = metrics(R.dates, R.equity, null, spec.rf, R);
      win.push({ trainFrom: A.dates[a], trainTo: A.dates[b], testFrom: A.dates[b], testTo: A.dates[c], params: best.params, inSampleSharpe: best.m.sharpe, outReturn: m.totalReturn, outSharpe: m.sharpe });
      const add = dates.length ? 1 : 0; dates = dates.concat(R.dates.slice(add)); eq = eq.concat(R.equity.slice(1)); cur = R.equity[R.equity.length - 1];
    }
    if (!win.length) throw new Error(`Walk-forward needs more than ${train + test} years of data.`);
    eq = eq.slice(1); const iB = A.dates.indexOf(dates[0]), bench = benchCurve(A, spec.benchmark, iB, iB + dates.length - 1, spec.initial).map((v, k, a2) => v ?? a2[k - 1] ?? spec.initial);
    return { windows: win, dates, equity: eq, bench, metrics: metrics(dates, eq, bench, spec.rf), benchMetrics: metrics(dates, bench, null, spec.rf), note: `Each year's parameters were chosen using only the previous ${train} years. The chained result contains only out-of-sample periods.` };
  }
  // sensitivity: how much the result depends on the parameter choice (descriptive, on the whole period — not validation)
  function sensitivity(spec) {
    const A = spec._aligned = spec._aligned || align(spec.series, spec.benchmark, spec.from, spec.to); spec._ind = spec._ind || Object.fromEntries(Object.keys(A.px).map((s) => [s, indicators(A.px[s])]));
    const grid = STRATEGIES[spec.strategy].grid; if (!grid) throw new Error("This strategy has no parameters.");
    const keys = Object.keys(grid), [kx, ky] = [keys[0], keys[1] || null];
    const rows = (ky ? grid[ky] : [null]).map((vy) => grid[kx].map((vx) => { const p = { [kx]: vx, ...(ky ? { [ky]: vy } : {}) }; if (!valid(spec, p)) return null; const m = score(spec, p, [A.start, A.dates.length - 1], A).m; return { sharpe: m.sharpe, cagr: m.cagr, mdd: m.maxDrawdown }; }));
    const all = rows.flat().filter(Boolean).map((x) => x.sharpe).filter((x) => x != null);
    return { x: { key: kx, values: grid[kx] }, y: ky ? { key: ky, values: grid[ky] } : null, rows, spread: all.length ? Math.max(...all) - Math.min(...all) : null, note: "Each cell is the full-period Sharpe ratio for one parameter choice. A strategy whose results swing a lot between neighboring cells is fragile. This view is descriptive; it is not out-of-sample evidence." };
  }

  return { align, indicators, compileRule, STRATEGIES, simulate, metrics, monthly, run, optimize, walkForward, sensitivity, _mean: mean, _sd: sd };
});

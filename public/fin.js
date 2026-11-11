/* Market Desk — financial math shared by the website and the automated tests (npm test).
   Pure functions only: no network, no page access. Every formula is written out so it can be checked. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FIN = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : NaN);
  const stdev = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(sum(a.map((x) => (x - m) ** 2)) / (a.length - 1)); };
  const div = (a, b) => (a == null || b == null || !isFinite(a) || !isFinite(b) || b === 0 ? null : a / b);

  /* ---------- ratios from one fiscal year (and the year before, for averages and growth) ---------- */
  function ratios(y, prev) {
    const avg = (k) => (prev && prev[k] != null && y[k] != null ? (y[k] + prev[k]) / 2 : y[k]);
    const taxRate = div(y.incomeTax, y.pretaxIncome);
    const t = taxRate != null && taxRate >= 0 && taxRate <= 0.5 ? taxRate : 0.21;
    const investedCapital = y.equity != null ? y.equity + (y.totalDebt || 0) - (y.cash || 0) : null;
    return {
      revenueGrowth: prev ? div(y.revenue - prev.revenue, Math.abs(prev.revenue)) : null,
      grossMargin: div(y.grossProfit, y.revenue),
      operatingMargin: div(y.operatingIncome, y.revenue),
      netMargin: div(y.netIncome, y.revenue),
      currentRatio: div(y.currentAssets, y.currentLiabilities),
      quickRatio: y.currentAssets != null ? div(y.currentAssets - (y.inventory || 0), y.currentLiabilities) : null,
      debtToEquity: div(y.totalDebt, y.equity),
      roe: div(y.netIncome, avg("equity")),
      roa: div(y.netIncome, avg("totalAssets")),
      roic: y.operatingIncome != null && investedCapital > 0 ? (y.operatingIncome * (1 - t)) / investedCapital : null,
      fcfMargin: div(y.fcf, y.revenue),
      effectiveTaxRate: taxRate,
    };
  }

  /* ---------- discounted cash flow ----------
     For each forecast year t = 1..N:
       Revenue_t = Revenue_{t-1} × (1 + g_t)
       EBIT_t    = Revenue_t × operating margin
       NOPAT_t   = EBIT_t × (1 − tax rate)
       UFCF_t    = NOPAT_t + D&A_t − CapEx_t − ΔNWC_t        (D&A, CapEx as % of revenue; ΔNWC = NWC% × ΔRevenue)
       PV_t      = UFCF_t / (1 + WACC)^t
     Terminal value (Gordon growth) = UFCF_N × (1 + g_terminal) / (WACC − g_terminal), discounted by (1 + WACC)^N
     Enterprise value = Σ PV_t + PV(terminal)
     Equity value = Enterprise value − total debt + cash;  per share = equity value / shares outstanding */
  function dcf(a) {
    const N = a.years || 5, growth = Array.isArray(a.growth) ? a.growth : Array(N).fill(a.growth);
    if (!(a.wacc > a.terminalGrowth)) return { error: "WACC must be higher than the terminal growth rate." };
    const rows = []; let rev = a.revenue, pvSum = 0;
    for (let t = 1; t <= N; t++) {
      const g = growth[t - 1] != null ? growth[t - 1] : growth[growth.length - 1];
      const prevRev = rev; rev = prevRev * (1 + g);
      const ebit = rev * a.operatingMargin, nopat = ebit * (1 - a.taxRate);
      const da = rev * a.daPct, capex = rev * a.capexPct, dNwc = (rev - prevRev) * a.nwcPct;
      const ufcf = nopat + da - capex - dNwc, df = 1 / (1 + a.wacc) ** t, pv = ufcf * df;
      pvSum += pv; rows.push({ t, growth: g, revenue: rev, ebit, nopat, da, capex, dNwc, ufcf, discountFactor: df, pv });
    }
    const last = rows[N - 1].ufcf;
    const terminalValue = (last * (1 + a.terminalGrowth)) / (a.wacc - a.terminalGrowth);
    const pvTerminal = terminalValue / (1 + a.wacc) ** N;
    const ev = pvSum + pvTerminal, equity = ev - (a.debt || 0) + (a.cash || 0);
    const perShare = a.shares ? equity / a.shares : null;
    return { rows, sumPv: pvSum, terminalValue, pvTerminal, enterpriseValue: ev, equityValue: equity, perShare,
      upside: perShare != null && a.price ? perShare / a.price - 1 : null, terminalShare: pvTerminal / ev };
  }
  // CAPM cost of equity and the weighted average cost of capital
  function wacc({ riskFree, beta, erp, costOfDebt, taxRate, equityValue, debtValue }) {
    const ke = riskFree + beta * erp, E = equityValue || 0, D = debtValue || 0, V = E + D;
    const we = V ? E / V : 1, wd = V ? D / V : 0;
    return { costOfEquity: ke, afterTaxCostOfDebt: costOfDebt * (1 - taxRate), weightEquity: we, weightDebt: wd, wacc: we * ke + wd * costOfDebt * (1 - taxRate) };
  }
  function sensitivity(base, waccs, gs) {
    return gs.map((g) => waccs.map((w) => { const r = dcf({ ...base, wacc: w, terminalGrowth: g }); return r.error ? null : r.perShare; }));
  }
  const cagr = (first, last, years) => (first > 0 && last > 0 && years > 0 ? (last / first) ** (1 / years) - 1 : null);

  /* ---------- returns, risk and regression ---------- */
  const returns = (prices) => prices.slice(1).map((p, i) => p / prices[i] - 1);
  function beta(assetRets, marketRets) {
    const n = Math.min(assetRets.length, marketRets.length); if (n < 10) return null;
    const a = assetRets.slice(-n), m = marketRets.slice(-n), ma = mean(a), mm = mean(m);
    let cov = 0, v = 0; for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (m[i] - mm); v += (m[i] - mm) ** 2; }
    return v ? cov / v : null;
  }
  function maxDrawdown(values) {
    let peak = -Infinity, mdd = 0, peakAt = 0, from = 0, to = 0;
    values.forEach((v, i) => { if (v > peak) { peak = v; peakAt = i; } const dd = v / peak - 1; if (dd < mdd) { mdd = dd; from = peakAt; to = i; } });
    return { maxDrawdown: mdd, from, to };
  }
  const drawdownSeries = (values) => { let peak = -Infinity; return values.map((v) => { peak = Math.max(peak, v); return v / peak - 1; }); };
  function correlation(a, b) {
    const n = Math.min(a.length, b.length); if (n < 3) return null;
    const x = a.slice(-n), y = b.slice(-n), mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }
  // historical VaR / expected shortfall: the loss not exceeded on `level` of days, and the average loss beyond it
  function varEs(rets, level = 0.95) {
    if (rets.length < 20) return { var: null, es: null };
    const s = rets.slice().sort((a, b) => a - b), k = Math.max(1, Math.floor(s.length * (1 - level)));
    const tail = s.slice(0, k);
    return { var: -s[k - 1], es: -mean(tail) };
  }

  /* ---------- portfolio backtest ----------
     series: { SYM: [{t, close}] } using dividend-adjusted closes when `adjusted` (total return) or plain closes (price only).
     Only dates where every holding has a price are used; the portfolio starts on the first such date (no look-ahead:
     each day's value uses that day's close only). Rebalancing: "none" (buy and hold) or "monthly"/"quarterly"/"annual". */
  function backtest({ series, weights, initial = 10000, rebalance = "none", benchmark }) {
    const syms = Object.keys(weights).filter((s) => weights[s] > 0 && series[s] && series[s].length);
    const wsum = sum(syms.map((s) => weights[s])); if (!syms.length || !wsum) return { error: "Add at least one holding with a weight above 0%." };
    const maps = Object.fromEntries(syms.map((s) => [s, new Map(series[s].map((p) => [p.t, p.close]))]));
    const dates = series[syms[0]].map((p) => p.t).filter((t) => syms.every((s) => maps[s].has(t))).sort((a, b) => a - b);
    if (dates.length < 2) return { error: "Not enough overlapping price history for these holdings and dates." };
    const w = Object.fromEntries(syms.map((s) => [s, weights[s] / wsum]));
    let shares = Object.fromEntries(syms.map((s) => [s, (initial * w[s]) / maps[s].get(dates[0])]));
    const period = (t) => { const d = new Date(t * 1000); return rebalance === "monthly" ? d.getUTCFullYear() * 12 + d.getUTCMonth() : rebalance === "quarterly" ? d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3) : rebalance === "annual" ? d.getUTCFullYear() : 0; };
    const values = []; let lastP = period(dates[0]);
    for (const t of dates) {
      let v = sum(syms.map((s) => shares[s] * maps[s].get(t)));
      if (rebalance !== "none" && period(t) !== lastP) { shares = Object.fromEntries(syms.map((s) => [s, (v * w[s]) / maps[s].get(t)])); lastP = period(t); }
      values.push(v);
    }
    let bench = null;
    if (benchmark && benchmark.length) {
      const bm = new Map(benchmark.map((p) => [p.t, p.close])); let last = null; const b0 = bm.get(dates[0]) || benchmark.find((p) => p.t >= dates[0])?.close;
      bench = dates.map((t) => { if (bm.has(t)) last = bm.get(t); return last != null && b0 ? (initial * last) / b0 : null; });
    }
    return { dates, values, bench, weights: w, stats: stats(dates, values, bench) };
  }
  function stats(dates, values, bench, rf = 0) {
    const yrs = (dates[dates.length - 1] - dates[0]) / (365.25 * 86400), rets = returns(values);
    const perYear = rets.length / Math.max(yrs, 1e-9);
    const vol = stdev(rets) * Math.sqrt(perYear), total = values[values.length - 1] / values[0] - 1, cg = cagr(values[0], values[values.length - 1], yrs);
    const out = { years: yrs, totalReturn: total, cagr: cg, volatility: vol, sharpe: vol ? (cg - rf) / vol : null, ...maxDrawdown(values) };
    const months = {}; dates.forEach((t, i) => { const d = new Date(t * 1000), k = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0"); months[k] = months[k] || { first: i, last: i }; months[k].last = i; });
    const mk = Object.keys(months).sort(), monthly = [];
    mk.forEach((k, i) => { const start = i ? values[months[mk[i - 1]].last] : values[0]; monthly.push({ month: k, ret: values[months[k].last] / start - 1 }); });
    const full = monthly.slice(1, -1).length >= 2 ? monthly.slice(1, -1) : monthly;
    out.bestMonth = full.reduce((a, b) => (b.ret > a.ret ? b : a), full[0]); out.worstMonth = full.reduce((a, b) => (b.ret < a.ret ? b : a), full[0]);
    const yearsMap = {}; dates.forEach((t, i) => { const y = new Date(t * 1000).getUTCFullYear(); yearsMap[y] = yearsMap[y] || { first: i, last: i }; yearsMap[y].last = i; });
    const yk = Object.keys(yearsMap).sort();
    out.annual = yk.map((y, i) => ({ year: +y, ret: values[yearsMap[y].last] / (i ? values[yearsMap[yk[i - 1]].last] : values[0]) - 1, partial: i === 0 || i === yk.length - 1 }));
    if (bench && bench.every((x) => x != null)) {
      const br = returns(bench), b = beta(rets, br), bc = cagr(bench[0], bench[bench.length - 1], yrs);
      out.benchmark = { totalReturn: bench[bench.length - 1] / bench[0] - 1, cagr: bc, volatility: stdev(br) * Math.sqrt(perYear), ...maxDrawdown(bench) };
      out.beta = b; out.correlation = correlation(rets, br);
      out.alpha = b != null && cg != null && bc != null ? cg - (rf + b * (bc - rf)) : null; // Jensen's alpha (annualized, CAPM)
      out.excessReturn = cg != null && bc != null ? cg - bc : null;
    }
    return out;
  }
  return { sum, mean, stdev, ratios, dcf, wacc, sensitivity, cagr, returns, beta, maxDrawdown, drawdownSeries, correlation, varEs, backtest, stats };
});

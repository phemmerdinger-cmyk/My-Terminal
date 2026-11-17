// Market Desk — financial-ratio indicators (pure; tested in tests/ratio-core.test.js).
// The four ratio families from the owner's Fin 370 units (Jeff Cerutti, Bryant University):
//   Unit 6 profitability — gross, operating and net margin, ROE and the 3-step DuPont analysis
//   Unit 7 leverage      — debt/equity, debt/assets, assets/equity, long-term debt/capital
//   Unit 8 efficiency    — receivables, inventory and asset turnover (on AVERAGE balances), cash conversion cycle
//   Unit 9 valuation     — P/E, P/S, P/B, PEG, price/cash flow, EV/EBITDA, dividend yield
// The units' rule: a ratio means little alone — compare it to the company's prior year and to competitors.
// So the indicator is (1) where each ratio ranks among the peers scored at the same time and (2) whether it improved
// on last year. Inputs are 10-K figures (SEC EDGAR XBRL) plus the current share price; missing inputs → null, never guessed.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RATIOS = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const ok = (x) => typeof x === "number" && isFinite(x);
  const div = (a, b) => (ok(a) && ok(b) && b !== 0 ? a / b : null);
  const avg = (a, b) => (ok(a) && ok(b) ? (a + b) / 2 : ok(a) ? a : null);
  const pos = (x) => (ok(x) && x > 0 ? x : null); // multiples are meaningless on negative earnings / cash flow

  // y = latest fiscal year, p = prior year (SEC keys: revenue, cogs, grossProfit, operatingIncome, netIncome, eps, da,
  // cfo, cash, inventory, receivables, payables, totalAssets, equity, totalLiabilities, totalDebt, ltDebt, ltDebtTotal,
  // dividends). mkt = { price, shares } (optional, for the valuation ratios).
  function compute(y, p = {}, mkt = {}) {
    y = y || {}; p = p || {};
    const gp = ok(y.grossProfit) ? y.grossProfit : ok(y.revenue) && ok(y.cogs) ? y.revenue - y.cogs : null;
    const liab = ok(y.totalLiabilities) ? y.totalLiabilities : ok(y.totalAssets) && ok(y.equity) ? y.totalAssets - y.equity : null;
    const ltd = ok(y.ltDebt) ? y.ltDebt : ok(y.ltDebtTotal) ? y.ltDebtTotal : null;
    // Unit 6 — profitability + DuPont (net margin × asset turnover = ROA; × equity multiplier = ROE)
    const npm = div(y.netIncome, y.revenue), tat = div(y.revenue, y.totalAssets), em = div(y.totalAssets, y.equity);
    const prof = { grossMargin: div(gp, y.revenue), operatingMargin: div(y.operatingIncome, y.revenue), netMargin: npm,
      roe: y.equity > 0 ? div(y.netIncome, y.equity) : null,
      dupont: { netMargin: npm, assetTurnover: tat, roa: npm != null && tat != null ? npm * tat : null, equityMultiplier: em,
        roe: npm != null && tat != null && em != null && y.equity > 0 ? npm * tat * em : null } };
    // Unit 7 — leverage (the units use total liabilities as "total debt")
    const lev = { debtToEquity: y.equity > 0 ? div(liab, y.equity) : null, debtToAssets: div(liab, y.totalAssets), assetsToEquity: y.equity > 0 ? em : null,
      ltDebtToCapital: ltd != null && ok(y.equity) && ltd + y.equity > 0 ? ltd / (ltd + y.equity) : null };
    // Unit 8 — efficiency on average balances; cash conversion cycle = DIO + DSO − DPO (days)
    const arT = div(y.revenue, avg(y.receivables, p.receivables)), invT = div(y.cogs, avg(y.inventory, p.inventory)), aT = div(y.revenue, avg(y.totalAssets, p.totalAssets));
    const dso = arT ? 365 / arT : null, dio = invT ? 365 / invT : null, apAvg = avg(y.payables, p.payables), dpo = ok(apAvg) && y.cogs > 0 ? (365 * apAvg) / y.cogs : null;
    const eff = { receivablesTurnover: arT, inventoryTurnover: invT, assetTurnover: aT, dso, dio, dpo, ccc: dso != null && dio != null && dpo != null ? dio + dso - dpo : null };
    // Unit 9 — valuation (needs today's price and shares outstanding)
    const sh = pos(mkt.shares), px = pos(mkt.price), mcap = sh && px ? sh * px : null;
    const epsNow = ok(y.eps) ? y.eps : div(y.netIncome, sh), epsPrev = ok(p.eps) ? p.eps : null;
    const pe = px && pos(epsNow) ? px / epsNow : null, epsG = epsPrev > 0 && ok(epsNow) ? (epsNow / epsPrev - 1) * 100 : null;
    const ebitda = ok(y.operatingIncome) && ok(y.da) ? y.operatingIncome + y.da : null, debt = ok(y.totalDebt) ? y.totalDebt : null;
    const ev = mcap != null && debt != null && ok(y.cash) ? mcap + debt - y.cash : null;
    const val = { pe, ps: mcap && pos(y.revenue) ? mcap / y.revenue : null, pb: mcap && pos(y.equity) ? mcap / y.equity : null,
      peg: pe != null && epsG != null && epsG > 0 ? pe / epsG : null, pcf: mcap && pos(y.cfo) ? mcap / y.cfo : null,
      evEbitda: ev != null && pos(ebitda) ? ev / ebitda : null, dividendYield: mcap && ok(y.dividends) ? Math.abs(y.dividends) / mcap : null };
    return { profitability: prof, leverage: lev, efficiency: eff, valuation: val };
  }

  // Direction of "better" for each ratio. Leverage: lower is safer. Valuation: lower multiple = cheaper (the units'
  // reading), higher dividend yield = more cash returned. CCC: shorter is better.
  const SPEC = {
    profitability: [["grossMargin", 1, "gross margin"], ["operatingMargin", 1, "operating margin"], ["netMargin", 1, "net margin"], ["roe", 1, "ROE"], ["dupont.roa", 1, "return on assets"]],
    leverage: [["debtToEquity", -1, "debt/equity"], ["debtToAssets", -1, "debt/assets"], ["assetsToEquity", -1, "assets/equity"], ["ltDebtToCapital", -1, "LT debt/capital"]],
    efficiency: [["receivablesTurnover", 1, "receivables turnover"], ["inventoryTurnover", 1, "inventory turnover"], ["assetTurnover", 1, "asset turnover"], ["ccc", -1, "cash conversion cycle"]],
    valuation: [["pe", -1, "P/E"], ["ps", -1, "P/S"], ["pb", -1, "P/B"], ["peg", -1, "PEG"], ["pcf", -1, "price/cash flow"], ["evEbitda", -1, "EV/EBITDA"], ["dividendYield", 1, "dividend yield"]],
  };
  const get = (o, path) => path.split(".").reduce((a, k) => (a == null ? null : a[k]), o);

  // items: [{ sym, now: compute(y,p,mkt), prev: compute(p, pp) | null }]. Peers = the other items.
  // Returns per sym: score −1…+1 (0 = middle of the peer group), per-family scores, and the strongest/weakest ratios.
  // Each ratio counts 75% for its rank among peers and 25% for improving (or worsening) on the prior year.
  function score(items, { minPeers = 8 } = {}) {
    const out = {};
    const fam = Object.keys(SPEC);
    const pct = {}; // fam.key → sorted values across peers
    for (const f of fam) for (const [k] of SPEC[f]) { const v = items.map((it) => get(it.now && it.now[f], k)).filter(ok).sort((a, b) => a - b); pct[f + "." + k] = v; }
    for (const it of items) {
      const famScore = {}, notes = []; let tot = 0, nTot = 0;
      for (const f of fam) {
        let s = 0, n = 0;
        for (const [k, dir, label] of SPEC[f]) {
          const v = get(it.now && it.now[f], k), all = pct[f + "." + k];
          if (!ok(v) || all.length < minPeers) continue;
          const r = (all.filter((x) => x < v).length + 0.5 * (all.filter((x) => x === v).length - 1)) / (all.length - 1); // 0…1
          let z = (r - 0.5) * 2 * dir; // −1…+1, + = better than peers
          const pv = get(it.prev && it.prev[f], k);
          const trend = ok(pv) && pv !== 0 ? Math.sign(v - pv) * dir : 0; // improved vs last year?
          const sc = 0.75 * z + 0.25 * trend; s += sc; n++;
          notes.push({ family: f, label, value: v, peerRank: dir > 0 ? r : 1 - r, trend, s: sc });
        }
        famScore[f] = n ? +(s / n).toFixed(3) : null; if (n) { tot += s / n; nTot++; }
      }
      notes.sort((a, b) => b.s - a.s);
      out[it.sym] = { score: nTot >= 2 ? +(tot / nTot).toFixed(3) : null, families: famScore, peers: items.length,
        best: notes.slice(0, 2).map(fmt), worst: notes.slice(-2).reverse().filter((x) => x.s < 0).map(fmt) };
    }
    return out;
  }
  const fmt = (x) => `${x.label} ${x.label.includes("margin") || x.label === "ROE" || x.label.includes("return") || x.label.includes("yield") || x.label.includes("/assets") || x.label.includes("capital") ? (x.value * 100).toFixed(1) + "%" : x.label.includes("cycle") ? Math.round(x.value) + " days" : x.value.toFixed(2)} (${x.peerRank >= 0.5 ? "top" : "bottom"} ${Math.max(1, Math.round((x.peerRank >= 0.5 ? 1 - x.peerRank : x.peerRank) * 100))}% of peers${x.trend > 0 ? ", improving" : x.trend < 0 ? ", worsening" : ""})`;

  return { compute, score, SPEC };
});

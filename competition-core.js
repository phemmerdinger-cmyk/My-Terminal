// Market Desk — the Three-Trader Challenge leaderboard (pure; tested in tests/competition-core.test.js).
// Ranks the three paper traders by net profit after modeled costs over the SAME window, with risk-adjusted measures
// beside it. A trader that breaks the competition risk limits stays on the board but is marked ineligible.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.COMP = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const LIMITS = { maxDrawdown: 0.2 }; // official championship limit, identical for all three
  const PERIODS = [["day", "Today", 1], ["week", "Week", 7], ["month", "Month", 30], ["quarter", "Quarter", 91], ["life", "Lifetime", null]];
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  const addDays = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

  // series: [{d: "YYYY-MM-DD", v: account value at that day's close (today's = live), spx}], oldest → newest, one per day.
  // start: starting capital; today: "YYYY-MM-DD"; days: window length in calendar days (null = whole run).
  // The base is the last close BEFORE the window (or the starting capital if the run began inside it).
  function windowStats(series, { start, today, days, spx0 }) {
    const s = (series || []).filter((p) => p && p.v > 0 && p.d);
    if (!s.length) return { ok: false, why: "no recorded values yet" };
    const from = days == null ? null : addDays(today, -(days - 1));
    const before = from ? s.filter((p) => p.d < from) : [], inside = from ? s.filter((p) => p.d >= from) : s;
    if (!inside.length) return { ok: false, why: "no values in this window" };
    const base = before.length ? before[before.length - 1] : { v: start, spx: spx0 };
    const pts = [base, ...inside], last = pts[pts.length - 1];
    const profit = last.v - base.v, ret = last.v / base.v - 1;
    const spxRet = base.spx > 0 && last.spx > 0 ? last.spx / base.spx - 1 : null;
    const dr = pts.slice(1).map((p, i) => p.v / pts[i].v - 1);
    let peak = pts[0].v, mdd = 0; for (const p of pts) { peak = Math.max(peak, p.v); mdd = Math.min(mdd, p.v / peak - 1); }
    const n = dr.length, enough = n >= 20, vol = n >= 5 ? sd(dr) * Math.sqrt(252) : null;
    const down = dr.filter((x) => x < 0), dsd = down.length >= 2 ? Math.sqrt(down.reduce((a, x) => a + x * x, 0) / dr.length) * Math.sqrt(252) : null;
    const ann = n >= 60 ? Math.pow(1 + ret, 252 / n) - 1 : null;
    // excess daily returns vs the S&P for a t-statistic ("statistical confidence")
    const ex = pts.slice(1).map((p, i) => (p.spx > 0 && pts[i].spx > 0 ? p.v / pts[i].v - p.spx / pts[i].spx : null)).filter((x) => x != null);
    const t = ex.length >= 20 && sd(ex) > 0 ? mean(ex) / (sd(ex) / Math.sqrt(ex.length)) : null;
    return { ok: true, from: from || (s[0] && s[0].d), to: last.d, days: n, base: +base.v.toFixed(2), value: +last.v.toFixed(2), profit: +profit.toFixed(2), ret, spxRet, alpha: spxRet == null ? null : ret - spxRet,
      // benchmark in dollars: what the same starting money in the S&P 500 made over the same dates (hypothetical)
      spxProfit: spxRet == null ? null : +(base.v * spxRet).toFixed(2), edge: spxRet == null ? null : +(profit - base.v * spxRet).toFixed(2),
      maxDrawdown: mdd, vol, sharpe: enough && vol ? (mean(dr) * 252) / vol : null, sortino: enough && dsd ? (mean(dr) * 252) / dsd : null,
      annualized: ann, calmar: ann != null && mdd < 0 ? ann / -mdd : null, tStat: t,
      confidence: t == null ? `too few days (${ex.length}) to judge` : Math.abs(t) >= 2 ? (t > 0 ? "beating the S&P beyond chance (t ≥ 2)" : "trailing the S&P beyond chance (t ≤ −2)") : "not distinguishable from the S&P" };
  }

  // rows: [{key, lifeDrawdown, busted, ...stats}] → ranked by profit; ineligible traders sorted after eligible ones.
  function rank(rows) {
    const out = rows.map((r) => {
      const why = [];
      if (r.lifeDrawdown != null && r.lifeDrawdown < -LIMITS.maxDrawdown) why.push(`drawdown ${(r.lifeDrawdown * 100).toFixed(1)}% beyond the ${LIMITS.maxDrawdown * 100}% limit`);
      if (r.busted) why.push("busted in this run");
      return { ...r, eligible: !why.length, ineligible: why };
    });
    const ok = (r) => r.stats && r.stats.ok;
    out.sort((a, b) => (b.eligible - a.eligible) || (ok(b) - ok(a)) || ((ok(b) ? b.stats.profit : 0) - (ok(a) ? a.stats.profit : 0)));
    let place = 0; for (const r of out) r.place = r.eligible && ok(r) ? ++place : null;
    return out;
  }

  return { windowStats, rank, PERIODS, LIMITS };
});

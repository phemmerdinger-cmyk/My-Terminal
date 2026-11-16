/* Home: pure, zero-API-cost logic (portfolio summary, relevance-ranked briefing, trading-bot scoreboard,
 * layout model, hypothetical 1-year risk). Every briefing item carries its source and timestamp; nothing is
 * estimated when data is missing. Relevance scores are personal-priority measures, not forecasts. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDHomeCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  const up = (s) => String(s || "").trim().toUpperCase();
  const DAY = 864e5;
  const etDay = (t) => new Date(t).toLocaleDateString("en-US", { timeZone: "America/New_York" });

  // ---------------------------------------------------------------- portfolio
  function summarize(pf, quotes, sectorOf, now = Date.now()) {
    quotes = quotes || {}; sectorOf = sectorOf || {};
    const merged = new Map();
    for (const h of (pf && Array.isArray(pf.holdings) ? pf.holdings : [])) {
      const s = up(h.symbol), sh = +h.shares; if (!s || !(sh > 0)) continue;
      const m = merged.get(s) || { symbol: s, shares: 0, costBasis: 0, addedToday: true };
      m.shares += sh; m.costBasis += sh * (+h.cost || 0); m.addedToday = m.addedToday && !!h.added && etDay(h.added) === etDay(now);
      merged.set(s, m);
    }
    const rows = [], unpriced = [];
    let value = 0, pricedCost = 0, cost = 0, day = 0, dayKnown = 0;
    for (const m of merged.values()) {
      const q = quotes[m.symbol], px = q && !q.error && num(q.price) ? q.price : null;
      cost += m.costBasis;
      const r = { symbol: m.symbol, shares: m.shares, costBasis: m.costBasis, price: px, value: null, unreal: null, unrealPct: null, day: null, dayPct: q && num(q.changePct) ? q.changePct : null, sector: sectorOf[m.symbol] || (/-USD$/.test(m.symbol) ? "Crypto" : "Other / unclassified"), quoteTime: q && q.marketTime || null };
      if (px == null) { unpriced.push(m.symbol); rows.push(r); continue; }
      r.value = px * m.shares; r.unreal = r.value - m.costBasis; r.unrealPct = m.costBasis ? r.unreal / m.costBasis * 100 : null;
      r.day = m.addedToday ? r.unreal : (num(q.change) ? q.change * m.shares : null);
      value += r.value; pricedCost += m.costBasis; if (r.day != null) { day += r.day; dayKnown++; }
      rows.push(r);
    }
    rows.forEach((r) => { r.weight = r.value != null && value ? r.value / value * 100 : null; });
    rows.sort((a, b) => (b.value || 0) - (a.value || 0));
    const sec = new Map(); rows.forEach((r) => { if (r.weight != null) sec.set(r.sector, (sec.get(r.sector) || 0) + r.weight); });
    const sectors = [...sec].map(([sector, weight]) => ({ sector, weight })).sort((a, b) => b.weight - a.weight);
    const hhi = rows.reduce((a, r) => a + (r.weight ? (r.weight / 100) ** 2 : 0), 0);
    return {
      name: pf && pf.name || "Portfolio", rows, unpriced, sectors, top: rows.filter((r) => r.value != null).slice(0, 5),
      value, cost, pricedCost, unreal: value - pricedCost, unrealPct: pricedCost ? (value - pricedCost) / pricedCost * 100 : null,
      day: dayKnown ? day : null, dayPct: dayKnown && value - day ? day / (value - day) * 100 : null,
      hhi, effectiveN: hhi ? 1 / hhi : null, maxWeight: rows.reduce((a, r) => Math.max(a, r.weight || 0), 0), positions: rows.length,
    };
  }
  function exposureShift(prev, cur, threshold = 5) {
    const p = new Map((prev || []).map((x) => [x.sector, x.weight])), out = [];
    const keys = new Set([...p.keys(), ...(cur || []).map((x) => x.sector)]);
    for (const k of keys) { const a = p.get(k) || 0, b = ((cur || []).find((x) => x.sector === k) || {}).weight || 0; if (Math.abs(b - a) >= threshold) out.push({ sector: k, from: a, to: b, delta: b - a }); }
    return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }

  // ---------------------------------------------------------------- hypothetical risk (today's shares held over the window)
  function risk(histBySym, shares, bench, rf = 0.04) {
    if (!bench || !Array.isArray(bench.t) || bench.t.length < 30) return { error: "Benchmark history unavailable" };
    const day = (t) => Math.floor(t / 86400);
    const dates = bench.t.map(day), bpx = bench.adj || bench.close, missing = [], cols = [];
    for (const [sym, n] of Object.entries(shares || {})) {
      const h = histBySym[sym]; if (!h || !h.t || !h.t.length) { missing.push(sym); continue; }
      const px = h.adj || h.close, map = new Map(h.t.map((t, i) => [day(t), px[i]]));
      let last = null; const col = dates.map((d) => { const v = map.get(d); if (num(v)) last = v; return last; });
      const first = col.findIndex((v) => v != null); if (first < 0 || first > dates.length * 0.2) { missing.push(sym); continue; } // too little history: exclude, don't backfill
      cols.push({ sym, n, col: col.map((v) => v == null ? col[first] : v) });
    }
    if (!cols.length) return { error: "No holding has a year of price history", missing };
    const vals = dates.map((_, i) => cols.reduce((a, c) => a + c.col[i] * c.n, 0));
    const rets = (a) => a.slice(1).map((v, i) => a[i] ? v / a[i] - 1 : 0);
    const rp = rets(vals), rm = rets(bpx), n = rp.length, mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const mp = mean(rp), mm = mean(rm), sd = Math.sqrt(rp.reduce((x, r) => x + (r - mp) ** 2, 0) / (n - 1));
    let cov = 0, vm = 0; for (let i = 0; i < n; i++) { cov += (rp[i] - mp) * (rm[i] - mm); vm += (rm[i] - mm) ** 2; }
    const mdd = (a) => { let pk = a[0], d = 0; for (const v of a) { if (v > pk) pk = v; d = Math.min(d, v / pk - 1); } return d; };
    const total = vals[vals.length - 1] / vals[0] - 1, years = n / 252, annRet = Math.pow(1 + total, 1 / years) - 1, vol = sd * Math.sqrt(252);
    const benchTotal = bpx[bpx.length - 1] / bpx[0] - 1;
    return { total, annRet, vol, sharpe: vol ? (annRet - rf) / vol : null, beta: vm ? cov / vm : null, mdd: mdd(vals), benchTotal, benchMdd: mdd(bpx), excess: total - benchTotal, days: n, from: bench.t[0] * 1000, to: bench.t[bench.t.length - 1] * 1000, missing, values: vals, bench: bpx };
  }

  // ---------------------------------------------------------------- briefing
  function context(summary, watchlist) {
    const hold = new Map((summary && summary.rows || []).map((r) => [r.symbol, r]));
    const wl = new Set((watchlist || []).map(up).filter((s) => !hold.has(s)));
    return { hold, wl };
  }
  function tickerReasons(tickers, ctx) {
    const reasons = []; let score = 0;
    for (const t of tickers || []) {
      const r = ctx.hold.get(up(t));
      if (r) { score += 40 + Math.min(30, (r.weight || 0)); reasons.push(`You hold ${r.symbol}${r.weight != null ? ` (${r.weight.toFixed(1)}% of this portfolio)` : ""}.`); }
      else if (ctx.wl.has(up(t))) { score += 20; reasons.push(`${up(t)} is on your watchlist.`); }
    }
    return { score, reasons };
  }
  const https = (u) => typeof u === "string" && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : null;
  function briefing({ news, discoveries, earnings, quotes, summary, watchlist, since = 0, now = Date.now(), limit = 25 } = {}) {
    const ctx = context(summary, watchlist), out = [];
    const add = (it) => { if (!it.source || !it.time) return; it.isNew = it.time > since; if (it.isNew) { it.score += 10; it.reasons.push("New since your last visit."); } out.push(it); };
    for (const n of (news && news.items) || []) {
      if (!n || !n.title || !n.time || !https(n.link)) continue;
      const age = now - n.time; const tr = tickerReasons(n.tickers, ctx);
      if (!tr.score && age > 2 * DAY) continue;
      if (age > 7 * DAY) continue;
      let score = tr.score + Math.max(0, 20 - age / 3600e3 / 2), reasons = tr.reasons.slice();
      const sec = n.source === "official" && /SEC/i.test(n.agency || "");
      if (n.source === "official") { score += sec ? 15 : 8; reasons.push(sec ? "Primary source: an SEC filing." : `Primary source: ${n.agency || "official release"}.`); }
      if (!tr.score && n.source !== "official") score -= 10; // general market headline
      add({ id: "n:" + (n.id || n.link), kind: sec ? "filing" : "news", title: n.title, summary: n.summary || "", source: n.source === "official" ? (n.agency || "Official") : (n.publisher || n.source), url: n.link, time: n.time, tickers: (n.tickers || []).map(up), score, reasons, nature: "fact" });
    }
    for (const d of (discoveries && discoveries.items) || []) {
      const src = (d.sources || []).find((s) => s && s.url) || (d.sources || [])[0]; if (!src || !d.u) continue;
      const tr = tickerReasons(d.tickers, ctx);
      const reasons = ["Found by the Spider" + (d.cat ? ` (${d.cat})` : "") + "."].concat(tr.reasons);
      add({ id: "d:" + d.id, kind: "spider", title: d.headline, summary: d.summary || "", source: "Spider · " + (src.name || "source"), url: https(src.url), go: "web", time: d.u, tickers: (d.tickers || []).map(up), score: tr.score + (d.importance || 0) / 3, reasons, nature: d.interp ? "fact + Spider interpretation" : "fact" });
    }
    if (earnings && Array.isArray(earnings.yours)) for (const e of earnings.yours) {
      const t = Date.parse(e.date + "T12:00:00Z"), days = Math.round((t - now) / DAY); if (!(days >= -1 && days <= 14)) continue;
      const tr = tickerReasons([e.symbol], ctx); if (!tr.score) continue;
      add({ id: "e:" + e.symbol + e.date, kind: "earnings", title: `${up(e.symbol)} reports earnings ${days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`} (${e.date})`, summary: num(e.epsEstimate) ? `Consensus EPS estimate ${e.epsEstimate.toFixed(2)}.` : "", source: (earnings.source || "Earnings calendar"), go: "data", time: earnings.updated || now, tickers: [up(e.symbol)], score: tr.score + Math.max(0, 25 - days * 2), reasons: tr.reasons.concat("Earnings releases often move the stock and can change a thesis."), nature: "fact" });
    }
    for (const r of ctx.hold.values()) {
      const q = quotes && quotes[r.symbol]; if (!q || q.error || !num(q.changePct) || !q.marketTime || Math.abs(q.changePct) < 3) continue;
      add({ id: "m:" + r.symbol, kind: "move", title: `${r.symbol} ${q.changePct >= 0 ? "up" : "down"} ${Math.abs(q.changePct).toFixed(1)}% today`, summary: r.day != null ? `About ${r.day >= 0 ? "+" : "−"}$${Math.abs(r.day).toFixed(0)} on your position.` : "", source: "Yahoo Finance quote", go: "research", sym: r.symbol, time: q.marketTime, tickers: [r.symbol], score: 45 + Math.abs(q.changePct) * 3, reasons: [`You hold ${r.symbol}${r.weight != null ? ` (${r.weight.toFixed(1)}% of this portfolio)` : ""}.`, `A ${Math.abs(q.changePct).toFixed(1)}% one-day move is large for most stocks.`], nature: "fact" });
    }
    const seen = new Set(), key = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    return out.sort((a, b) => b.score - a.score || b.time - a.time).filter((x) => { const k = key(x.title); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit)
      .map((x) => ({ ...x, score: Math.round(x.score) }));
  }

  // ---------------------------------------------------------------- trading bots (AI vs S&P 500)
  // One row per paper bot from the live scoreboard (/api/pub/botslive): value, return since its start, the S&P 500 over
  // the same period (from the S&P level at the bot's first trade), and the lead in dollars. No S&P start yet → null.
  const BOTS = [["swing", "Swing bot"], ["day", "Day trader"], ["quant", "Quant trader"]];
  function botBoard(snap) {
    if (!snap || typeof snap !== "object") return { rows: [], total: null };
    const spx = Number.isFinite(snap.spx) ? snap.spx : null, rows = [];
    for (const [k, name] of BOTS) {
      const b = snap[k]; if (!b || !Number.isFinite(b.value) || !(b.start > 0)) continue;
      const ret = b.value / b.start - 1, spxRet = spx && b.spx0 > 0 ? spx / b.spx0 - 1 : null;
      rows.push({ k, name, value: b.value, start: b.start, ret, spxRet, lead: spxRet == null ? null : b.value - b.start * (1 + spxRet), started: b.spx0 > 0 });
    }
    if (!rows.length) return { rows, total: null };
    const value = rows.reduce((x, r) => x + r.value, 0), start = rows.reduce((x, r) => x + r.start, 0), all = rows.every((r) => r.spxRet != null);
    const spxValue = all ? rows.reduce((x, r) => x + r.start * (1 + r.spxRet), 0) : null;
    return { rows, total: { value, start, ret: value / start - 1, spxRet: spxValue == null ? null : spxValue / start - 1, lead: spxValue == null ? null : value - spxValue } };
  }

  // ---------------------------------------------------------------- layout
  const WIDGETS = [
    { id: "trading", title: "AI vs S&P 500 · trading bots", span: 3, first: true },
    { id: "briefing", title: "Personal briefing", span: 2 },
    { id: "portfolio", title: "Portfolio command", span: 1 },
    { id: "allocation", title: "Allocation & concentration", span: 1 },
    { id: "risk", title: "Risk vs benchmark", span: 1 },
    { id: "catalysts", title: "Upcoming catalysts", span: 1 },
  ];
  const defaultLayout = () => WIDGETS.map((w) => ({ id: w.id, span: w.span, hidden: false }));
  function normalizeLayout(l) {
    const ids = new Set(WIDGETS.map((w) => w.id)), seen = new Set(), out = [];
    for (const x of Array.isArray(l) ? l : []) if (x && ids.has(x.id) && !seen.has(x.id)) { seen.add(x.id); out.push({ id: x.id, span: [1, 2, 3].includes(x.span) ? x.span : 1, hidden: !!x.hidden }); }
    for (const w of WIDGETS) if (!seen.has(w.id)) { const x = { id: w.id, span: w.span, hidden: false }; if (w.first && out.length) out.unshift(x); else out.push(x); } // a new headline module goes on top of saved layouts
    return out;
  }
  function moveWidget(l, id, to) {
    const L = normalizeLayout(l), i = L.findIndex((x) => x.id === id); if (i < 0) return L;
    const j = typeof to === "number" ? Math.max(0, Math.min(L.length - 1, to)) : i + (to === "up" ? -1 : 1);
    if (j < 0 || j >= L.length) return L;
    const [w] = L.splice(i, 1); L.splice(j, 0, w); return L;
  }
  const resizeWidget = (l, id) => normalizeLayout(l).map((x) => x.id === id ? { ...x, span: x.span % 3 + 1 } : x);
  const toggleWidget = (l, id, hidden) => normalizeLayout(l).map((x) => x.id === id ? { ...x, hidden: hidden == null ? !x.hidden : !!hidden } : x);

  return { summarize, exposureShift, risk, briefing, botBoard, WIDGETS, defaultLayout, normalizeLayout, moveWidget, resizeWidget, toggleWidget };
});

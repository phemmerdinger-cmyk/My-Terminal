/* Workspace: one ticker, several panels side by side (chart, key stats, news, SEC financials).
 * Pure helpers shared by the browser page (workspace.js) and the Node tests. Nothing here estimates or fills in
 * missing data: a value the source didn't give is shown as "—". */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDWorkspaceCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const DASH = "—";
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const RANGES = Object.freeze([["1mo", "1M"], ["6mo", "6M"], ["1y", "1Y"], ["5y", "5Y"]]);
  const LAYOUTS = Object.freeze(["grid", "focus", "multi"]); // grid = 2×2 panels; focus = big chart; multi = several site tools at once

  // ---- Multi-screen ("terminal") mode: any of the site's tools in 2–6 live panes, each its own window of the site
  const PANE_FUNCS = Object.freeze([
    ["news", "News"], ["data", "Market overview"], ["nyse", "Heatmap"], ["analysis", "Market analysis"], ["macro", "Macro"],
    ["research", "Stock research", true], ["fin", "Financials"], ["dcf", "DCF valuation"], ["portfolio", "My portfolio"], ["risk", "Risk & stress"],
    ["aitrade", "Bots vs S&P 500"], ["quant", "Quant Lab"], ["backtest", "Backtest Lab"], ["studio-graph", "Market charts"], ["studio-research", "Market intelligence"],
  ]);
  const GRIDS = Object.freeze({ 2: [2, 1], 3: [3, 1], 4: [2, 2], 6: [3, 2] }); // panes → [columns, rows]
  const DEFAULT_PANES = Object.freeze([{ fn: "news" }, { fn: "nyse" }, { fn: "research", sym: "SPY" }, { fn: "aitrade" }]);
  function normalizePanes(list, count = 4) {
    const n = GRIDS[count] ? count : 4, ok = new Set(PANE_FUNCS.map((f) => f[0])), out = [];
    for (let i = 0; i < n; i++) {
      const p = (Array.isArray(list) && list[i]) || DEFAULT_PANES[i] || { fn: PANE_FUNCS[i % PANE_FUNCS.length][0] };
      const fn = ok.has(p.fn) ? p.fn : "news";
      out.push(fn === "research" ? { fn, sym: normalizeSymbol(p.sym) || "SPY" } : { fn });
    }
    return out;
  }
  // The pane page is the normal site with ?pane=1, which hides the top bar, menus and watchlist.
  function paneUrl(pane, { path = "/", visitor = false } = {}) {
    const hash = pane.fn === "research" ? "research/" + encodeURIComponent(pane.sym || "SPY") : pane.fn;
    return `${path}?pane=1${visitor ? "&visitor" : ""}#${hash}`;
  }

  function compact(v, prefix = "") {
    v = num(v); if (v == null) return DASH;
    const a = Math.abs(v), s = v < 0 ? "-" : "";
    const f = (x, u) => s + prefix + x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2) + u;
    if (a >= 1e12) return f(a / 1e12, "T");
    if (a >= 1e9) return f(a / 1e9, "B");
    if (a >= 1e6) return f(a / 1e6, "M");
    if (a >= 1e3) return f(a / 1e3, "K");
    return s + prefix + a.toFixed(2);
  }
  const pctText = (v, digits = 1) => (num(v) == null ? DASH : (v > 0 ? "+" : "") + v.toFixed(digits) + "%");
  const fixed = (v, d = 2) => (num(v) == null ? DASH : v.toFixed(d));
  const tone = (v) => (num(v) == null || v === 0 ? "" : v > 0 ? "up" : "down");

  // Normalize what the user typed into a ticker the APIs accept (crypto names become COIN-USD like the rest of the site).
  const CRYPTO = new Set(["BTC", "ETH", "XRP", "SOL", "DOGE", "ADA", "AVAX", "BNB", "LTC", "LINK"]);
  function normalizeSymbol(v) {
    const s = String(v || "").trim().toUpperCase().replace(/^\$/, "");
    if (!/^[A-Z^][A-Z0-9.=\-^]{0,11}$/.test(s)) return null;
    return CRYPTO.has(s) ? s + "-USD" : s;
  }
  const isEquity = (s) => !!s && !/^\^|-USD$|=F$|=X$/.test(s);

  // Key stats from /api/quotes (quote) and /api/summary (summary). Each row: [label, text, tone].
  function keyStats(quote, summary) {
    const q = quote || {}, sd = (summary && summary.summaryDetail) || {}, ks = (summary && summary.defaultKeyStatistics) || {};
    const fd = (summary && summary.financialData) || {};
    const range52 = num(q.low52) != null && num(q.high52) != null ? `${fixed(q.low52)} – ${fixed(q.high52)}` : DASH;
    const rows = [
      ["Price", fixed(q.price), ""],
      ["Change today", num(q.change) == null ? DASH : `${q.change > 0 ? "+" : ""}${q.change.toFixed(2)} (${pctText(q.changePct, 2)})`, tone(q.changePct)],
      ["Day range", num(q.dayLow) != null && num(q.dayHigh) != null ? `${fixed(q.dayLow)} – ${fixed(q.dayHigh)}` : DASH, ""],
      ["52-week range", range52, ""],
      ["Volume", compact(q.volume), ""],
      ["Market cap", compact(sd.marketCap, "$"), ""],
      ["P/E (trailing)", fixed(sd.trailingPE, 1), ""],
      ["EPS (trailing)", fixed(ks.trailingEps), ""],
      ["Beta", fixed(sd.beta), ""],
      ["Dividend yield", num(sd.dividendYield) == null ? DASH : (sd.dividendYield * 100).toFixed(2) + "%", ""],
      ["Net margin", num(fd.profitMargins) == null ? DASH : (fd.profitMargins * 100).toFixed(1) + "%", tone(fd.profitMargins)],
    ];
    return rows;
  }

  // Where today's price sits inside the 52-week range, 0–100, or null when either end is missing.
  function rangePosition(quote) {
    const q = quote || {}, lo = num(q.low52), hi = num(q.high52), p = num(q.price);
    if (lo == null || hi == null || p == null || hi <= lo) return null;
    return Math.max(0, Math.min(100, ((p - lo) / (hi - lo)) * 100));
  }

  // Last few fiscal years from /api/pub/sec (years are oldest → newest). Growth and margins are computed only
  // from reported values in the same rows.
  function finSummary(sec, maxYears = 4) {
    if (!sec || !sec.available || !Array.isArray(sec.years) || !sec.years.length) return null;
    const ys = sec.years.slice(-maxYears);
    const all = sec.years;
    const cols = ys.map((y) => {
      const i = all.indexOf(y), prev = i > 0 ? all[i - 1] : null;
      const rev = num(y.revenue), ni = num(y.netIncome), fcf = num(y.fcf);
      const prevRev = prev ? num(prev.revenue) : null;
      return {
        label: "FY" + String(y._fy || String(y.end || "").slice(0, 4)),
        end: y.end || null,
        revenue: rev, netIncome: ni, fcf,
        netMargin: rev && ni != null ? (ni / rev) * 100 : null,
        revenueGrowth: rev != null && prevRev ? ((rev - prevRev) / Math.abs(prevRev)) * 100 : null,
      };
    });
    const last = sec.years[sec.years.length - 1];
    return { name: sec.name || null, currency: sec.currency || "USD", cols, filed: last._filed || null, form: last._form || null };
  }

  // News for one ticker: items tagged with it, newest first, one per headline.
  function pickNews(items, sym, limit = 12) {
    const seen = new Set(), out = [];
    const list = (items || []).filter((i) => i && i.title && Array.isArray(i.tickers) && i.tickers.includes(sym))
      .sort((a, b) => (b.time || 0) - (a.time || 0));
    for (const i of list) {
      const k = String(i.title).toLowerCase().replace(/\W+/g, "").slice(0, 80);
      if (seen.has(k)) continue; seen.add(k); out.push(i);
      if (out.length >= limit) break;
    }
    return out;
  }

  // Closes for the chart: [{time, value}] in time order, dropping bars without a close.
  function chartPoints(candles) {
    return (candles || []).filter((c) => c && Number.isFinite(c.time) && num(c.close) != null)
      .sort((a, b) => a.time - b.time).map((c) => ({ time: c.time, value: c.close }));
  }

  // Return over the charted period, from the first and last close actually shown.
  function periodReturn(points) {
    if (!points || points.length < 2 || !points[0].value) return null;
    return ((points[points.length - 1].value - points[0].value) / points[0].value) * 100;
  }

  function relTime(t, now = Date.now()) {
    if (!num(t)) return "";
    const m = Math.floor((now - t) / 60000);
    if (m < 1) return "just now"; if (m < 60) return m + "m ago";
    const h = Math.round(m / 60); if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  return { DASH, RANGES, LAYOUTS, PANE_FUNCS, GRIDS, DEFAULT_PANES, normalizePanes, paneUrl, compact, pctText, tone, normalizeSymbol, isEquity, keyStats, rangePosition, finSummary, pickNews, chartPoints, periodReturn, relTime };
});

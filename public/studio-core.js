/* Intelligence Studio: zero-API-cost decision math, evidence and browser-open alerts.
 * All scenario outputs are hypothetical; relevance scores are not price forecasts. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDStudioCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const symbol = (v) => String(v || "").trim().toUpperCase();
  function holdings(portfolio, quotes, sectorBySymbol) {
    const rows = [], bad = [], totals = new Map();
    for (const h of (portfolio && Array.isArray(portfolio.holdings) ? portfolio.holdings : [])) {
      const sym = symbol(h.symbol), shares = Number(h.shares);
      if (!/^[A-Z0-9.^=-]{1,18}$/.test(sym) || !finite(shares) || shares <= 0) continue;
      totals.set(sym, (totals.get(sym) || 0) + shares);
    }
    for (const [sym, shares] of totals) {
      const q = (quotes || {})[sym], price = q && Number(q.price);
      if (!q || q.error || !finite(price) || price <= 0) { bad.push(sym); continue; }
      const value = price * shares;
      rows.push({ symbol: sym, shares, price, value, sector: (sectorBySymbol || {})[sym] || "Unclassified", quoteTime: q.time || q.timestamp || null });
    }
    return { rows, unpriced: bad, total: rows.reduce((a, r) => a + r.value, 0), totalPositions: totals.size };
  }
  function shockPortfolio(snapshot, opts) {
    const o = opts || {}, market = clamp(Number(o.market) || 0, -100, 300), tech = clamp(Number(o.tech) || 0, -100, 300),
      custom = clamp(Number(o.custom) || 0, -100, 300), target = symbol(o.symbol), rows = [];
    for (const p of (snapshot && snapshot.rows) || []) {
      const techExtra = /^(Information Technology|Technology)$/i.test(p.sector) ? tech : 0;
      const specific = p.symbol === target ? custom : 0;
      const move = clamp(market + techExtra + specific, -100, 300);
      rows.push({ ...p, shockPct: move, pnl: p.value * move / 100, future: p.value * (1 + move / 100) });
    }
    const pnl = rows.reduce((a, r) => a + r.pnl, 0), value = rows.reduce((a, r) => a + r.value, 0);
    return { rows: rows.sort((a, b) => a.pnl - b.pnl), before: value, after: value + pnl, pnl,
      pct: value > 0 ? pnl / value * 100 : null, unpriced: snapshot ? snapshot.unpriced.slice() : [],
      partial: !!(snapshot && snapshot.unpriced.length) };
  }
  function freshness(at, now, warnMs = 15 * 60e3, staleMs = 90 * 60e3) {
    const t = Number(at);
    if (!Number.isFinite(t) || t <= 0) return { state: "unavailable", label: "Timestamp unavailable", age: null };
    const delta = Math.max(0, (now || Date.now()) - t);
    const age = Math.round(delta / 60000);
    return { state: delta <= warnMs ? "current" : delta <= staleMs ? "delayed" : "stale",
      label: delta <= warnMs ? "Checked " + age + " min ago" : "Last checked " + age + " min ago", age };
  }
  function evidence(items, symbols, now) {
    const relevant = new Set((symbols || []).map(symbol));
    return (Array.isArray(items) ? items : []).filter((d) => d && typeof d.headline === "string")
      .map((d) => {
        const linked = (d.tickers || []).filter((s) => relevant.has(symbol(s)));
        const sources = (d.sources || []).filter((s) => s && s.name);
        const ts = Number(d.u || d.t || 0), age = ts > 0 ? Math.max(0, (now || Date.now()) - ts) : Infinity;
        const official = sources.some((s) => /SEC|EDGAR|Federal Reserve|FRED|Treasury|BLS|BEA/i.test(s.name));
        const score = Math.round((linked.length ? 65 : 0) + clamp(Number(d.importance) || 0, 0, 100) * 0.22 +
          (official ? 10 : 0) + (sources.length ? 8 : 0) + (age < 48 * 3600e3 ? 8 : 0));
        return { ...d, matched: linked, score, sourceCount: sources.length, verifiedUrl: sources.find((s) => /^https:\/\//i.test(s.url || ""))?.url || null,
          evidenceStatus: !sources.length ? "Unattributed" : age > 7 * 864e5 ? "Older research" : "Sourced" };
      }).sort((a, b) => b.score - a.score || (b.u || 0) - (a.u || 0));
  }
  function validateBacktest(run) {
    if (!run || typeof run !== "object") return { level: "none", reasons: ["No saved backtest yet."] };
    const reasons = [];
    const kind = String(run.kind || "").toLowerCase();
    const oos = kind.includes("walk") || kind.includes("out-of-sample") || kind.includes("oos");
    if (oos) reasons.push("Includes an out-of-sample evaluation according to the recorded run type.");
    else reasons.push("In-sample backtest only: performance has not been validated on unseen dates.");
    const costs = run.costs || {};
    const spread = Number(costs.spreadBps), slip = Number(costs.slippageBps), commission = Number(costs.commissionBps);
    if ([spread, slip, commission].some((n) => !Number.isFinite(n))) reasons.push("Trading-cost assumptions not fully recorded.");
    else if (spread + slip + commission === 0) reasons.push("Zero trading costs assumed; real execution would differ.");
    else reasons.push("Cost settings recorded (spread " + spread + ", slippage " + slip + ", commission " + commission + " bps).");
    if (!run.from || !run.to) reasons.push("Backtest dates missing.");
    reasons.push("Historical prices, today's investable universe and parameter selection can bias results.");
    return { level: oos ? "out-of-sample" : "in-sample", reasons };
  }
  function alerts({ holdings: H, discoveries: D, quotes, preferences: P, lastSeen: L, now, quoteAt }) {
    const nowT = Number(now) || Date.now(), p = P || {}, seen = L || {}, events = [], next = { ...seen };
    const tracked = new Set((H || []).map((x) => symbol(x.symbol))), threshold = clamp(Number(p.priceMove) || 5, 1, 50),
      minImportance = clamp(Number(p.importance) || 75, 30, 100), sixHours = 6 * 3600e3;
    const quoteFresh = Number.isFinite(quoteAt) && nowT - quoteAt >= 0 && nowT - quoteAt < 30 * 60e3; // terminal connection freshness alone is insufficient; every market quote must also be recent
    if (p.price !== false && quoteFresh) {
      const keyDay = new Date(nowT).toISOString().slice(0, 10);
      for (const sym of tracked) {
        const q = (quotes || {})[sym], pct = q && Number(q.changePct);
        if (!q || q.error || !Number.isFinite(pct) || Math.abs(pct) < threshold || !Number.isFinite(q.marketTime) || nowT - q.marketTime < 0 || nowT - q.marketTime > 30 * 60e3) continue;
        const sign = pct >= 0 ? "up" : "down", key = "move:" + keyDay + ":" + sym + ":" + sign;
        if (next[key]) continue;
        events.push({ key, time: nowT, kind: "Price move", symbol: sym,
          title: sym + " " + sign + " " + Math.abs(pct).toFixed(2) + "%", detail: "A recent quote update crossed your " + threshold + "% daily move threshold." });
        next[key] = nowT;
      }
    }
    if (p.research !== false) for (const d of (D || [])) {
      if (!d || !d.id || (Number(d.importance) || 0) < minImportance || !(d.tickers || []).some((s) => tracked.has(symbol(s)))) continue;
      const t = Number(d.u || d.t), k = "research:" + d.id + ":" + t;
      if (!Number.isFinite(t) || t <= 0 || nowT - t < 0 || nowT - t > sixHours || next[k]) continue;
      events.push({ key: k, time: nowT, kind: "Spider research", symbol: (d.tickers || []).find((s) => tracked.has(symbol(s))) || "",
        title: String(d.headline).slice(0, 180), detail: "New sourced research on a holding; importance " + d.importance + "/100." });
      next[k] = nowT;
    }
    // Trim stored keys by age so a browser open for years cannot grow unbounded.
    const trimmed = Object.fromEntries(Object.entries(next).filter(([k, t]) => nowT - t <= 30 * 864e5).slice(-1200));
    return { events: events.slice(0, 20), lastSeen: trimmed };
  }
  return { holdings, shockPortfolio, freshness, evidence, validateBacktest, alerts };
});

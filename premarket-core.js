// Pre-Market Desk: reads real pre-market / after-hours prints (from Yahoo's extended-hours candles) while the bots are
// awake (6:00–9:30 AM and 4:00–5:00 PM ET) and hands the bots what they mean:
//  - a gap list (who's moving before the open, measured from yesterday's close),
//  - alerts on bot holdings that are already through their stop before the open,
//  - an opening guard: the swing bot doesn't chase a big gap (up or down) in the first minutes of the session,
//  - a priority order for the day trader's scan (big gappers first).
// Pure functions only; nothing here fetches or estimates prices. No print → "no pre-market trades yet".
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MDPremarket = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const MIN = 60_000;
  const CFG = {
    preStart: 6 * 60, open: 9 * 60 + 30, close: 16 * 60, afterEnd: 17 * 60, // ET minutes
    freshMin: 45,      // a print older than this isn't "current" pre-market
    bigGapPct: 5,      // |gap| at or above this is a big gap
    guardMin: 30,      // the swing bot waits this long after the open before buying a big gapper
    moverPct: 2,       // listed as a mover from here
  };
  const num = (x) => Number.isFinite(x);

  // "pre" 6:00–9:30, "after" 16:00–17:00 on a trading day, otherwise "off". `t` = { wd: "Mon".., min, holiday }
  function phase(t) {
    if (!t || t.holiday || t.wd === "Sat" || t.wd === "Sun") return "off";
    if (t.min >= CFG.preStart && t.min < CFG.open) return "pre";
    if (t.min >= CFG.close && t.min < CFG.afterEnd) return "after";
    return "off";
  }

  // one row per symbol: the latest extended-hours print and its move from the right reference close
  function row(sym, q, now, ph) {
    if (!q || q.error) return { sym, status: "no-quote" };
    const x = ph === "after" ? q.postMarket : q.preMarket;
    const ref = q.price; // before the open q.price is still yesterday's close; after it, today's close
    if (!x || !(x.price > 0)) return { sym, status: "no-print", close: num(ref) ? ref : null, name: q.name || sym };
    const ageMin = (now - x.marketTime) / MIN;
    const gapPct = num(x.changePct) ? x.changePct : ref > 0 ? (x.price / ref - 1) * 100 : null;
    return { sym, name: q.name || sym, status: ageMin <= CFG.freshMin ? "live" : "stale", price: x.price, close: num(ref) ? ref : null,
      gapPct: num(gapPct) ? +gapPct.toFixed(2) : null, at: x.marketTime, ageMin: Math.round(ageMin) };
  }

  function scan(quotes, symbols, { now = Date.now(), phase: ph = "pre" } = {}) {
    const rows = [...new Set(symbols)].map((s) => row(s, quotes && quotes[s], now, ph));
    const live = rows.filter((r) => r.status === "live" && num(r.gapPct));
    const up = live.filter((r) => r.gapPct >= CFG.moverPct).sort((a, b) => b.gapPct - a.gapPct);
    const down = live.filter((r) => r.gapPct <= -CFG.moverPct).sort((a, b) => a.gapPct - b.gapPct);
    return { t: now, phase: ph, rows, up: up.slice(0, 15), down: down.slice(0, 15), live: live.length, noPrint: rows.filter((r) => r.status === "no-print").length };
  }

  // holdings: [{ bot, sym, shares, cost, stop (price) }] → alerts for positions moving hard before the open
  function holdingAlerts(report, holdings) {
    const by = Object.fromEntries((report.rows || []).map((r) => [r.sym, r]));
    const out = [];
    for (const h of holdings || []) {
      const r = by[h.sym]; if (!r || r.status !== "live" || !num(r.gapPct)) continue;
      const dollars = num(h.shares) && num(r.close) ? +((r.price - r.close) * h.shares).toFixed(2) : null;
      if (num(h.stop) && r.price <= h.stop) out.push({ ...h, kind: "stop", price: r.price, gapPct: r.gapPct, dollars,
        text: `${h.bot} ${h.sym} is at ${r.price.toFixed(2)} pre-market (${r.gapPct > 0 ? "+" : ""}${r.gapPct}%), under its stop ${h.stop.toFixed(2)}: the stop will sell it at the open if it stays there` });
      else if (Math.abs(r.gapPct) >= CFG.bigGapPct) out.push({ ...h, kind: r.gapPct > 0 ? "gapUp" : "gapDown", price: r.price, gapPct: r.gapPct, dollars,
        text: `${h.bot} ${h.sym} ${r.gapPct > 0 ? "up" : "down"} ${Math.abs(r.gapPct)}% pre-market (${dollars != null ? (dollars >= 0 ? "+$" : "−$") + Math.abs(dollars).toFixed(2) : "?"} on the position)` });
    }
    return out;
  }

  // Swing-bot opening guard: during the first CFG.guardMin minutes, no NEW buys in a stock that gapped ≥ bigGapPct
  // either way this morning (chasing a gap-up or catching a gap-down). Returns a reason string or "".
  function openingGuard(report, sym, t) {
    if (!report || !t || t.min < CFG.open || t.min >= CFG.open + CFG.guardMin || report.day !== t.day) return "";
    const r = (report.rows || []).find((x) => x.sym === sym);
    if (!r || !num(r.gapPct) || Math.abs(r.gapPct) < CFG.bigGapPct) return "";
    return `Pre-Market Desk: ${sym} gapped ${r.gapPct > 0 ? "up" : "down"} ${Math.abs(r.gapPct)}% before the open; waiting until ${Math.floor((CFG.open + CFG.guardMin) / 60)}:${String((CFG.open + CFG.guardMin) % 60).padStart(2, "0")} for the gap to settle`;
  }

  // day-trader scan order: today's biggest live gappers first, the rest in their usual order
  function prioritize(universe, report, t) {
    if (!report || !t || report.day !== t.day) return universe;
    const gap = new Map((report.rows || []).filter((r) => r.status === "live" && num(r.gapPct)).map((r) => [r.sym, Math.abs(r.gapPct)]));
    const movers = universe.filter((s) => (gap.get(s) || 0) >= CFG.moverPct).sort((a, b) => gap.get(b) - gap.get(a));
    return [...movers, ...universe.filter((s) => !movers.includes(s))];
  }

  function summary(report, alerts) {
    if (!report || !report.rows) return "Pre-Market Desk hasn't run yet today.";
    const f = (r) => `${r.sym} ${r.gapPct > 0 ? "+" : ""}${r.gapPct}%`;
    const L = [`${report.phase === "after" ? "After-hours" : "Pre-market"} (${report.live} of ${report.rows.length} with live prints)`];
    if (report.up.length) L.push("Up: " + report.up.slice(0, 6).map(f).join(", "));
    if (report.down.length) L.push("Down: " + report.down.slice(0, 6).map(f).join(", "));
    for (const a of (alerts || []).slice(0, 6)) L.push("Holding: " + a.text);
    return L.join("\n");
  }

  return { CFG, phase, row, scan, holdingAlerts, openingGuard, prioritize, summary };
});

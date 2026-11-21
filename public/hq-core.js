/* Bot HQ — pure helpers for the bot control room (public/hq.html). Turns the bots' own API answers into one
 * common shape and computes the per-bot breakdowns (monthly grid, weekday/hour, drawdown, pipeline). Nothing is
 * estimated: a number the bots didn't record shows as missing. Shared with the Node tests. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDHQCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23" });
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

  // ---- one shape for every bot: { id, name, group, value, start, ret, benchRet, equity:[{d,v,b}], positions, trades, plans, status }
  function fromMain(kind, j) {
    if (!j || j.error) return null;
    const name = { swing: "Swing bot", day: "Day trader", quant: "Quant trader" }[kind];
    const start = num(j.startValue) || 30000;
    const eq = (j.equity || []).map((p) => ({ d: p.d, v: num(p.v), b: num(p.spx ?? p.s) })).filter((p) => p.v != null);
    const b0 = num(j.spx0) || (eq.find((p) => p.b != null) || {}).b || null, bNow = num(j.spxNow);
    const trades = (j.trades || []).slice(0, 400).map((t) => ({ t: num(t.t), side: t.side, sym: t.sym, shares: num(t.shares), price: num(t.price), pnl: num(t.pnl), why: t.why || t.reason || "" }));
    const plans = kind === "swing" ? ((j.plan && j.plan.orders) || []).map((o) => ({ side: o.side, sym: o.sym, amount: num(o.amount), why: o.why, when: "at the open" }))
      .concat(((j.pending && j.pending.orders) || []).map((o) => ({ side: o.side, sym: o.sym, amount: null, why: o.why, when: "waiting for a fresh quote" })))
      : kind === "quant" ? ((j.pending && j.pending.orders) || []).map((o) => ({ side: o.side, sym: o.sym, amount: num(o.shares) && num(o.referencePrice) ? o.shares * o.referencePrice : null, why: j.pending.why, when: "next open" }))
      : Object.entries(j.entries || {}).map(([sym, f]) => ({ side: f.side > 0 ? "BUY" : "SHORT", sym, amount: null, why: "approved entry waiting for its bar", when: "next bar" }));
    const positions = (j.positions || []).map((p) => ({ sym: p.sym, value: num(p.value), pnl: num(p.pnl), weight: num(p.weight), note: p.setup || p.name || null }));
    const value = num(j.value) ?? (eq.length ? eq[eq.length - 1].v : start);
    return { id: kind, name, group: "main", value, start, ret: value / start - 1, benchRet: b0 && bNow ? bNow / b0 - 1 : null,
      equity: eq, positions, trades, plans, status: j.status || (j.marketOpen ? "Trading live" : "Market closed"),
      detail: kind === "quant" && j.latest ? `Regime: ${j.latest.regime}${j.latest.rawRegime && j.latest.rawRegime !== j.latest.regime ? ` (raw ${j.latest.rawRegime})` : ""}` : kind === "swing" && j.lastScan ? (j.lastScan.stress ? `Defense mode: ${j.lastScan.stress}` : j.lastScan.caution ? `Caution: ${j.lastScan.caution}` : j.lastScan.riskOff ? "S&P below its 200-day: keeps 20% cash" : "Normal mode") : null,
      teamwork: j.teamwork || null };
  }
  function fromLab(lab) {
    return (lab && lab.experiments || []).map((e) => ({ id: e.id, name: e.label, group: "lab", value: num(e.value), start: 30000, ret: num(e.value) != null ? e.value / 30000 - 1 : null,
      benchRet: null, equity: [], positions: [], trades: [], plans: [], status: e.notice || "", openCount: num(e.positions), queued: num(e.pending), closed: num(e.closed),
      toughness: e.toughness || null, shadowReturn: num(e.shadowReturn), drawdown: num(e.drawdown) }));
  }

  // ---- breakdowns
  function drawdowns(eq) { let hi = -Infinity; return eq.map((p) => { hi = Math.max(hi, p.v); return { d: p.d, dd: hi > 0 ? p.v / hi - 1 : 0 }; }); }
  function monthly(eq) {
    const last = new Map(), first = new Map();
    for (const p of eq) { const m = String(p.d).slice(0, 7); if (!first.has(m)) first.set(m, p.v); last.set(m, p.v); }
    const months = [...last.keys()]; let prev = null;
    return months.map((m) => { const start = prev ?? first.get(m), end = last.get(m); prev = end; return { m, ret: start ? end / start - 1 : null }; });
  }
  // closed trades (with P&L) grouped by New York weekday and hour of the exit
  function whenItWorks(trades) {
    const by = (k) => { const o = {}; for (const t of trades) { if (t.pnl == null || !t.t) continue; const key = k(t); const b = o[key] || (o[key] = { n: 0, wins: 0, pnl: 0 }); b.n++; b.wins += t.pnl > 0; b.pnl += t.pnl; } return o; };
    const parts = (t) => { const f = Object.fromEntries(ET.formatToParts(new Date(t.t)).map((x) => [x.type, x.value])); return f; };
    const wd = by((t) => parts(t).weekday), hr = by((t) => +parts(t).hour);
    return { weekday: WEEKDAYS.map((d) => ({ key: d, ...(wd[d] || { n: 0, wins: 0, pnl: 0 }) })),
      hour: Array.from({ length: 7 }, (_, i) => i + 9).map((h) => ({ key: h, ...(hr[h] || { n: 0, wins: 0, pnl: 0 }) })) };
  }
  function stats(trades) {
    const c = trades.filter((t) => t.pnl != null), w = c.filter((t) => t.pnl > 0), l = c.filter((t) => t.pnl <= 0);
    const gw = w.reduce((a, t) => a + t.pnl, 0), gl = -l.reduce((a, t) => a + t.pnl, 0);
    return { closed: c.length, winRate: c.length ? w.length / c.length : null, profitFactor: gl > 0 ? gw / gl : null, net: gw - gl };
  }

  // ---- the research → trade pipeline, counted from what the spider and bots actually recorded
  function pipeline({ spider, signals, swing } = {}, now = Date.now()) {
    const st = spider && spider.stats || {};
    const scanned = swing && swing.lastScan ? (swing.lastScan.top || []).length : null;
    const checks = swing && swing.teamwork ? swing.teamwork.checks || [] : [];
    const filled = swing ? (swing.trades || []).filter((t) => now - (t.t || 0) < 7 * 864e5).length : null;
    return [
      { key: "jobs", label: "Research jobs", value: num(st.total ?? st.jobs), note: "spider jobs run" },
      { key: "findings", label: "Findings", value: num(st.memory), note: "in research memory" },
      { key: "signals", label: "Signals", value: signals && signals.items ? signals.items.length : null, note: "named research signals" },
      { key: "ranked", label: "Ranked", value: scanned, note: "top swing candidates" },
      { key: "checked", label: "Checked", value: checks.length, note: "pre-buy vetoes/cautions" },
      { key: "traded", label: "Traded", value: filled, note: "swing fills, last 7 days" },
    ];
  }

  // ---- one live feed: spider jobs, bot trades, pre-buy checks (newest first)
  function feed({ spider, bots = [], checks = [] } = {}, limit = 40) {
    const out = [];
    for (const j of (spider && spider.recent) || []) out.push({ t: j.ended || j.started, who: "Spider", kind: j.status === "error" ? "error" : "research", text: j.label + (j.summary ? ` — ${j.summary}` : "") });
    for (const b of bots) for (const t of (b.trades || []).slice(0, 15)) out.push({ t: t.t, who: b.name, kind: t.side === "BUY" || t.side === "SHORT" ? "buy" : "sell", text: `${t.side} ${t.sym}${t.pnl != null ? ` (${t.pnl >= 0 ? "+" : "−"}$${Math.abs(t.pnl).toFixed(0)})` : ""} — ${String(t.why || "").slice(0, 120)}` });
    for (const c of checks) out.push({ t: c.t, who: "Swing bot", kind: c.verdict === "veto" ? "veto" : "check", text: `${c.sym}: ${c.note}` });
    return out.filter((x) => x.t).sort((a, b) => b.t - a.t).slice(0, limit);
  }

  // ---- counts per time bucket (for the source/output sparklines): oldest → newest
  function buckets(times, { now = Date.now(), size = 30 * 60e3, n = 12 } = {}) {
    const out = Array(n).fill(0);
    for (const t of times) { const k = Math.floor((now - t) / size); if (k >= 0 && k < n) out[n - 1 - k]++; }
    return out;
  }
  // which spider categories feed which brain input
  const SOURCES = [["SEC filings", ["filing", "insider", "fundamentals"]], ["News & movers", ["news", "mover", "company"]], ["Earnings", ["earnings"]], ["Macro & markets", ["macro", "policy", "market", "sector", "pattern"]]];
  function sourceCounts(finds, now = Date.now()) {
    return SOURCES.map(([label, cats]) => { const ds = finds.filter((d) => cats.includes(d.cat)); return { label, n: ds.length, spark: buckets(ds.map((d) => d.u || d.t || 0), { now }) }; });
  }
  // Reshuffle a bot's own closed trades (with replacement) to show the range of paths the same trades could take.
  function fan(trades, { start = 30000, paths = 60, seed = 11 } = {}) {
    const rets = trades.filter((t) => t.pnl != null).map((t) => t.pnl); if (rets.length < 5) return null;
    let s = seed >>> 0; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const out = []; for (let p = 0; p < paths; p++) { let v = start; const path = [v]; for (let i = 0; i < rets.length; i++) { v += rets[Math.floor(r() * rets.length)]; path.push(v); } out.push(path); }
    const actual = [start]; let v = start; for (const x of rets.slice().reverse()) { v += x; actual.push(v); }
    const finals = out.map((p) => p[p.length - 1]).sort((a, b) => a - b);
    return { paths: out, actual, p05: finals[Math.floor(0.05 * finals.length)], p50: finals[Math.floor(0.5 * finals.length)], p95: finals[Math.floor(0.95 * finals.length) - 1] ?? finals[finals.length - 1] };
  }
  // the five toughness checks as dots (true / false / null = not run)
  const dots = (t) => (t && Array.isArray(t.checks) ? t.checks.map((c) => !!c.ok) : [null, null, null, null, null]);

  return { fromMain, fromLab, drawdowns, monthly, whenItWorks, stats, pipeline, feed, WEEKDAYS, buckets, sourceCounts, SOURCES, fan, dots };
});

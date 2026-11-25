// System Doctor: checks the live site the way the owner would notice problems (wrong pre-market math, charts that don't
// cover their window or are out of order, stale quotes, stalled bots, server errors, errors in the owner's browser) and
// sorts each finding into: "auto" (the server can heal it itself: clear a cache, restart a stalled loop, re-pick the
// AI model) or "code" (needs a code change: reported, and filed as a GitHub issue for the scheduled fixer when configured).
// Pure functions only; the runner in server.js gathers the inputs and applies the heals.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MDDoctor = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const MIN = 60_000;
  const pos = (x) => Number.isFinite(x) && x > 0;
  const f = (key, sev, area, fix, text, evidence = {}) => ({ key, sev, area, fix, text, evidence });

  // session phase from ET wall clock { wd, min, holiday }
  function phase(t) {
    if (!t || t.holiday || t.wd === "Sat" || t.wd === "Sun") return "closed";
    if (t.min >= 4 * 60 && t.min < 9 * 60 + 30) return "pre";
    if (t.min >= 9 * 60 + 30 && t.min < 16 * 60) return "regular";
    if (t.min >= 16 * 60 && t.min < 20 * 60) return "after";
    return "closed";
  }

  // a liquid stock/ETF quote (SPY, AAPL…): price present, fresh in session, pre-market math from the right close
  function checkQuote(sym, q, { now, phase: ph }) {
    const out = [];
    if (!q || q.error || !pos(q.price)) return [f(`quote-missing:${sym}`, "warn", "quotes", "auto", `${sym} has no quote right now`, { sym })];
    const age = (now - (q.marketTime || 0)) / MIN, allow = 5 + (q.delayMin || 0);
    if (ph === "regular" && age > allow) out.push(f(`quote-stale:${sym}`, "warn", "quotes", "auto", `${sym} quote is ${Math.round(age)} min old during market hours`, { sym, ageMin: Math.round(age) }));
    const pre = q.preMarket, rs = q.regularSession;
    if (pre && pos(pre.price) && rs && now < rs.start && Number.isFinite(pre.changePct)) {
      // before the open q.price is yesterday's close: the pre-market % must be measured from it
      const want = (pre.price / q.price - 1) * 100;
      if (Math.abs(want - pre.changePct) > 0.05) out.push(f("premarket-baseline", "bug", "quotes", "code",
        `Pre-market change for ${sym} is ${pre.changePct.toFixed(2)}% but measured from yesterday's close it is ${want.toFixed(2)}%`, { sym, shown: +pre.changePct.toFixed(2), expected: +want.toFixed(2) }));
    }
    if (ph === "pre" && sym === "SPY" && !(pre && pos(pre.price))) out.push(f("premarket-missing", "warn", "quotes", "auto", "No pre-market price for SPY during pre-market (data feed may be lagging)", { sym }));
    if (pre && pos(pre.price) && (now - pre.marketTime) / MIN > 45 && ph === "pre") out.push(f(`premarket-stale:${sym}`, "warn", "quotes", "auto", `${sym} pre-market price is ${Math.round((now - pre.marketTime) / MIN)} min old`, { sym }));
    return out;
  }

  // the owner's 1D chart (last 24 h incl. extended hours): ordered, covering ~a day, recent, extended bars marked
  function checkChart(sym, h, { now, phase: ph }) {
    const c = (h && h.candles) || [];
    if (!c.length) return [f(`chart-empty:${sym}`, "bug", "charts", "auto", `${sym} 1D chart came back empty`, { sym })];
    const out = [];
    for (let i = 1; i < c.length; i++) if (!(c[i].time > c[i - 1].time)) { out.push(f("chart-order", "bug", "charts", "code", `${sym} 1D chart bars are out of order at bar ${i}`, { sym, i })); break; }
    const spanH = (c[c.length - 1].time - c[0].time) / 3600;
    if (spanH < 18 && ph !== "closed") out.push(f("chart-24h", "bug", "charts", "code", `${sym} 1D chart covers only ${spanH.toFixed(1)} h, not the last 24 h`, { sym, spanH: +spanH.toFixed(1) }));
    const lastAge = (now / 1000 - c[c.length - 1].time) / 60;
    if (ph !== "closed" && lastAge > 20) out.push(f(`chart-stale:${sym}`, "warn", "charts", "auto", `${sym} 1D chart's newest bar is ${Math.round(lastAge)} min old`, { sym, ageMin: Math.round(lastAge) }));
    if (h.extended && ph === "pre" && c[c.length - 1].ext !== "pre") out.push(f("chart-ext-mark", "bug", "charts", "code", `${sym} pre-market bars aren't marked as pre-market on the chart`, { sym }));
    if (h.extended && ph !== "closed" && !c.some((x) => x.ext)) out.push(f("chart-no-ext", "bug", "charts", "code", `${sym} 1D chart has no pre-market/after-hours bars`, { sym }));
    return out;
  }

  // bots: their loops tick every minute; long silences in their hours mean a stalled loop
  function checkBots(d, { now, phase: ph, awake }) {
    const out = [], age = (t) => (t ? (now - t) / MIN : Infinity);
    if (ph === "regular") {
      if (age(d.swingTick) > 6) out.push(f("bot-swing-stalled", "bug", "bots", "auto", `Swing bot hasn't run for ${Math.round(age(d.swingTick))} min during market hours`, { min: Math.round(age(d.swingTick)) }));
      if (age(d.dayTick) > 6) out.push(f("bot-day-stalled", "bug", "bots", "auto", `Day trader hasn't run for ${Math.round(age(d.dayTick))} min during market hours`, { min: Math.round(age(d.dayTick)) }));
    }
    if (awake && (ph === "pre" || ph === "after") && d.pmPhaseOn && age(d.pmAt) > 12) out.push(f("premarket-desk-stalled", "bug", "bots", "auto", `Pre-Market Desk last scanned ${age(d.pmAt) === Infinity ? "never" : Math.round(age(d.pmAt)) + " min ago"}`, {}));
    for (const [bot, errs] of Object.entries(d.errors || {})) {
      const recent = (errs || []).filter((e) => now - e.t < 30 * MIN);
      if (recent.length >= 5) out.push(f(`bot-errors:${bot}`, "bug", "bots", "code", `${bot} bot hit ${recent.length} errors in 30 min (latest: ${String(recent[0].e).slice(0, 140)})`, { bot, sample: String(recent[0].e).slice(0, 300) }));
    }
    return out;
  }

  // server 5xx responses per route over the last 15 minutes
  function checkServer(errors, { now }) {
    const by = {};
    for (const e of errors || []) if (now - e.t < 15 * MIN) (by[e.path] = by[e.path] || []).push(e);
    return Object.entries(by).filter(([, l]) => l.length >= 3).map(([p, l]) => f(`server-5xx:${p}`, "bug", "server", "code",
      `${p} failed ${l.length} times in 15 min (${l[l.length - 1].status}: ${String(l[l.length - 1].msg || "").slice(0, 140)})`, { path: p, count: l.length, sample: String(l[l.length - 1].msg || "").slice(0, 300) }));
  }

  // JavaScript errors and failed calls reported by the owner's browser
  function checkClient(reports, { now }) {
    const by = {};
    for (const r of reports || []) if (now - r.t < 60 * MIN) { const k = (r.kind + ":" + String(r.msg).slice(0, 90)); (by[k] = by[k] || []).push(r); }
    return Object.values(by).map((l) => { const r = l[l.length - 1];
      return f(`client:${r.kind}:${String(r.msg).replace(/\W+/g, "-").slice(0, 60)}`, "bug", "browser", "code",
        `${r.kind === "js" ? "Page error" : "Request failed"} on ${r.page || "?"}: ${String(r.msg).slice(0, 160)}${l.length > 1 ? ` (×${l.length})` : ""}`,
        { msg: String(r.msg).slice(0, 400), where: String(r.where || "").slice(0, 200), page: r.page || null, count: l.length }); });
  }

  function checkAi(ai) {
    if (!ai || !ai.on || !ai.lastError) return [];
    return [f("ai-error", "warn", "ai", "auto", `Gemini's last call failed: ${String(ai.lastError).slice(0, 140)}`, {})];
  }

  // which safe automatic action heals a finding (null = nothing automatic)
  function healFor(x) {
    if (x.fix !== "auto") return null;
    if (/^quote-|^premarket-stale|^premarket-missing/.test(x.key)) return { action: "clear-quote", sym: x.evidence.sym || "SPY" };
    if (/^chart-/.test(x.key)) return { action: "clear-chart", sym: x.evidence.sym };
    if (x.key === "bot-swing-stalled") return { action: "restart-swing" };
    if (x.key === "bot-day-stalled") return { action: "restart-day" };
    if (x.key === "premarket-desk-stalled") return { action: "rerun-premarket" };
    if (x.key === "ai-error") return { action: "repick-ai-model" };
    return null;
  }

  // GitHub issue for a code finding (stable title, so the same bug is filed once)
  function issueFor(x) {
    return { title: `[doctor] ${x.key}: ${x.text}`.slice(0, 200),
      body: `The System Doctor found this on the live site and couldn't fix it without a code change.\n\n- Area: ${x.area}\n- Finding: ${x.text}\n- First seen: ${new Date(x.first || Date.now()).toISOString()}\n- Evidence:\n\n\`\`\`json\n${JSON.stringify(x.evidence, null, 2).slice(0, 3000)}\n\`\`\`\n\nRules for the fix: small targeted change, add a test, \`npm test\` must pass, follow AGENTS.md (free only, no fabricated data, owner/visitor rules).`,
      labels: ["doctor"] };
  }

  return { phase, checkQuote, checkChart, checkBots, checkServer, checkClient, checkAi, healFor, issueFor };
});

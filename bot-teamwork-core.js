// Bot + spider teamwork: pure rules that let the paper bots use THE WEB spider's research, and a few rules that
// make the bots learn from their own record. No I/O here; server.js supplies the data. Every rule returns its
// reasons so the site can show why it fired. Paper trading only.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MDTeamwork = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const DAY = 864e5;
  const r2 = (x) => Math.round(x * 100) / 100;

  // ---------------------------------------------------------------- 1) spider check before a swing buy
  // signals: the spider's named research signals for this stock (researchSignals items with sym === stock)
  // trader: the spider's trader signal ({ score −1…+1, conf 0…1, n, reasons })
  // researchedAt: when the spider last researched the stock (null = never)
  // Hard red flags veto the buy. Softer ones are logged as cautions. A stock the spider hasn't looked at is
  // allowed (the spider is asked to research it) so a slow research queue never freezes the bot.
  const HARD = new Set(["Negative regulatory development", "Negative earnings development"]);
  function preBuyCheck({ sym, signals = [], trader = null, researchedAt = null, now = Date.now() } = {}) {
    const mine = signals.filter((s) => s && s.sym === sym);
    const vetoes = [], cautions = [], evidence = [];
    const take = (s) => (s.inputs || []).slice(0, 2).forEach((i) => evidence.push({ headline: i.headline, at: i.at, source: (i.sources && i.sources[0] && i.sources[0].name) || null }));
    for (const s of mine) {
      if (HARD.has(s.name)) { vetoes.push(s.name); take(s); }
      else if (s.name === "Important financial filing change" && s.dir < 0) { vetoes.push("Negative financial filing change"); take(s); }
      else if (s.name === "Insider selling" || s.name === "Elevated company-specific news activity") { cautions.push(s.name); take(s); }
    }
    if (trader && trader.n >= 2 && trader.score <= -0.4 && trader.conf >= 0.3) {
      vetoes.push(`Spider research leans negative (${trader.score.toFixed(2)})`);
      (trader.reasons || []).slice(0, 2).forEach((h) => evidence.push({ headline: String(h).replace(/^[▲▼] /, ""), at: null, source: "spider findings" }));
    }
    const unchecked = !researchedAt || now - researchedAt > 7 * DAY;
    const verdict = vetoes.length ? "veto" : unchecked && !mine.length ? "unchecked" : cautions.length ? "caution" : "ok";
    const note = verdict === "veto" ? `Spider veto: ${vetoes.join("; ")}` : verdict === "caution" ? `Spider caution: ${cautions.join("; ")}` :
      verdict === "unchecked" ? "Spider hasn't researched this stock in the last 7 days (research requested)" : "Spider found no red flags";
    return { sym, verdict, vetoes, cautions, evidence: evidence.slice(0, 4), note, wantResearch: unchecked };
  }

  // ---------------------------------------------------------------- 2) quant regime with confirmation
  // Lower equity split = more defensive. A new regime is adopted after it shows up on 3 trading days in a row,
  // or right away when it's MORE defensive and the spider's own market research agrees there is stress.
  const ORDER = { "Risk-on trend": 3, "Choppy / late-cycle": 2, Correction: 1, "Risk-off / high volatility": 0 };
  const CONFIRM_DAYS = 3;
  function confirmRegime(state, raw, day, { spiderStress = null } = {}) {
    const s = state && state.label ? { ...state } : null;
    if (!s) return { label: raw, state: { label: raw, since: day, pending: null }, changed: true, note: `Started in ${raw}` };
    if (raw === s.label) return { label: s.label, state: { ...s, pending: null }, changed: false, note: s.pending ? `${s.pending.label} signal faded after ${s.pending.days} day(s); staying ${s.label}` : null };
    if (s.pending && s.pending.lastDay === day) return { label: s.label, state: s, changed: false, note: null }; // same day re-run
    const days = s.pending && s.pending.label === raw ? s.pending.days + 1 : 1;
    const safer = (ORDER[raw] ?? 1) < (ORDER[s.label] ?? 1);
    if (days >= CONFIRM_DAYS || (safer && spiderStress)) {
      const note = days >= CONFIRM_DAYS ? `Switched to ${raw} after ${days} days in a row` : `Switched to ${raw} early: spider research agrees (${spiderStress})`;
      return { label: raw, state: { label: raw, since: day, pending: null }, changed: true, note };
    }
    return { label: s.label, state: { ...s, pending: { label: raw, days, lastDay: day } }, changed: false,
      note: `Raw signal says ${raw} (day ${days} of ${CONFIRM_DAYS}); staying ${s.label} until it's confirmed` };
  }

  // ---------------------------------------------------------------- 3) post-mortems on losing trades
  // Pattern tags come from the buy reason the bot wrote, so old trades can be reviewed too.
  function tagsFromWhy(why) {
    const w = String(why || ""), t = [];
    t.push(/safe pick/.test(w) ? "safe" : "high-risk");
    if (/earnings beat/.test(w)) t.push("earnings-beat");
    if (/good news/.test(w)) t.push("news-driven");
    if (/Spider research/.test(w)) t.push("spider-boost");
    const m = w.match(/([+-]\d+)% over 3 months/); if (m && +m[1] >= 25) t.push("hot-momentum");
    const d = w.match(/([+-]\d+(\.\d)?)% today/); if (d && +d[1] >= 3) t.push("chased-gap");
    if (/put\/call buy signal/.test(w)) t.push("contrarian");
    return t;
  }
  function candidateTags(x) {
    const t = [x.sleeve === "safe" ? "safe" : "high-risk"];
    if (x.earn && x.earn.kind === "beat") t.push("earnings-beat");
    if (x.news >= 1) t.push("news-driven");
    if (x.spider && x.spider.adj > 0 && x.spider.note) t.push("spider-boost");
    if (x.mom >= 0.25) t.push("hot-momentum");
    if (x.day >= 3) t.push("chased-gap");
    return t;
  }
  function lossCause(sellWhy, ctx = {}) {
    const w = String(sellWhy || "");
    if (/earnings/i.test(w)) return { cause: "earnings", label: "Earnings report went against it" };
    if (/^Bad news|Spider veto/i.test(w)) return { cause: "bad-news", label: "Company-specific bad news" };
    if (/Defense mode|black-swan|VIX|S&P 500 down/i.test(w) || (ctx.spxDay != null && ctx.spxDay <= -1.5)) return { cause: "market", label: "Market-wide selloff" };
    if (/Stop-loss|Trailing stop/i.test(w)) return { cause: "stopped", label: "Hit its stop (price reversal)" };
    if (/average/i.test(w)) return { cause: "trend-break", label: "Trend broke down" };
    if (/Swapped out|Fell to #|ranking/i.test(w)) return { cause: "rank-decay", label: "Faded in the ranking" };
    return { cause: "other", label: "Other" };
  }
  // trades: newest first (the bot's ledger). Pairs each closed SELL with the BUY before it.
  function postMortems(trades, { limit = 400 } = {}) {
    const asc = (trades || []).slice(0, limit).slice().reverse(), open = {}, closed = [];
    for (const tr of asc) {
      if (tr.side === "BUY") { if (!open[tr.sym]) open[tr.sym] = tr; }
      else if (tr.side === "SELL" && tr.pnl != null) {
        const buy = open[tr.sym]; const full = !/^Trimmed|^Defense mode/.test(tr.why || "");
        if (!buy) continue;
        closed.push({ sym: tr.sym, at: tr.t, boughtAt: buy.t, pnl: tr.pnl, pnlPct: tr.pnlPct, days: Math.max(0, Math.round((tr.t - buy.t) / DAY)), tags: tagsFromWhy(buy.why), buyWhy: buy.why, sellWhy: tr.why, ...lossCause(tr.why) });
        if (full) delete open[tr.sym];
      }
    }
    const losses = closed.filter((c) => c.pnl < 0).reverse(); // newest first
    const stats = {};
    for (const c of closed) for (const tag of c.tags) { const s = stats[tag] || (stats[tag] = { tag, n: 0, wins: 0, pnl: 0 }); s.n++; s.wins += c.pnl > 0 ? 1 : 0; s.pnl += c.pnl; }
    const causes = {}; for (const c of losses) causes[c.cause] = (causes[c.cause] || 0) + 1;
    const lessons = Object.values(stats).map((s) => ({ ...s, pnl: r2(s.pnl), winRate: s.n ? r2(s.wins / s.n) : null, penalty: penaltyFor(s) }))
      .filter((s) => s.penalty < 0).sort((a, b) => a.penalty - b.penalty);
    return { closed: closed.length, losses: losses.slice(0, 30), causes, lessons, rule: "A pattern with at least 4 closed trades, a win rate under 40% and a net loss lowers the score of new picks that share it (up to −0.06)." };
  }
  function penaltyFor(s) {
    if (s.tag === "high-risk" || s.tag === "safe" || s.n < 4) return 0; // sleeves are the strategy itself, not a lesson
    const wr = s.wins / s.n; if (wr >= 0.4 || s.pnl >= 0) return 0;
    return -r2(Math.min(0.06, 0.02 + (0.4 - wr) * 0.1 + Math.min(0.02, s.n / 400)));
  }
  function lessonPenalty(lessons, tags) {
    let p = 0; const hit = [];
    for (const l of lessons || []) if (tags.includes(l.tag)) { p += l.penalty; hit.push(l.tag); }
    return { penalty: Math.max(-0.08, r2(p)), tags: hit };
  }

  // ---------------------------------------------------------------- 4) earnings early warning
  function tradingDaysUntil(today, date) {
    if (!today || !date || date < today) return null;
    let n = 0; const d = new Date(today + "T12:00:00Z"), end = Date.parse(date + "T12:00:00Z");
    while (d.getTime() < end) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) n++; }
    return n;
  }
  // held: is the bot holding it; days: trading days until the report (0 = today); research: spider trader signal
  function earningsAction({ held, days, pnlPct = 0, sleeve = "risk", research = null } = {}) {
    if (days == null || days > 5) return { action: "none" };
    const neg = research && research.n && research.score <= -0.2 && research.conf >= 0.2, pos = research && research.n && research.score >= 0.3 && research.conf >= 0.3;
    const when = days === 0 ? "today" : days === 1 ? "in 1 trading day" : `in ${days} trading days`;
    if (held) {
      if (neg) return { action: "trim", fraction: 0.5, reason: `Earnings ${when} and spider research leans negative — trimmed half before the report` };
      if (days <= 1 && sleeve === "risk" && pnlPct >= 0.15) return { action: "trim", fraction: 0.33, reason: `Earnings ${when} after a ${Math.round(pnlPct * 100)}% gain — locked in a third before the report` };
      return { action: "hold", reason: `Earnings ${when}; research ${pos ? "leans positive" : "shows no red flags"} — holding through it` };
    }
    if (days <= 1) return { action: "skip", reason: `Earnings ${when} — no new buys right before a report` };
    if (pos) return { action: "ok", reason: `Earnings ${when}, but spider research leans positive` };
    return { action: "skip", reason: `Earnings ${when} — waiting for the report before buying` };
  }

  // ---------------------------------------------------------------- 6) smarter defense mode
  // Full defense needs a broad selloff, or at least two INDEPENDENT warnings. One warning = caution: no new
  // high-risk buys, nothing sold for it.
  function defenseDecision({ vix = null, vixChg = null, spxDay = null, swan = null, spider = null, breadth = null } = {}) {
    const src = [];
    if (vix != null && (vix >= 30 || (vixChg != null && vixChg >= 20))) src.push({ k: "vix", t: `VIX fear index at ${vix.toFixed(1)}${vixChg != null && vixChg >= 20 ? ` (+${vixChg.toFixed(0)}% today)` : ""}` });
    if (spxDay != null && spxDay <= -2) src.push({ k: "spx", t: `S&P 500 down ${spxDay.toFixed(1)}% today` });
    if (swan) src.push({ k: "swan", t: `black-swan headline: “${String(swan).slice(0, 100)}”` });
    if (spider) src.push({ k: "spider", t: `spider research: ${spider}` });
    const broad = (spxDay != null && spxDay <= -3) || (breadth != null && breadth >= 0.75 && spxDay != null && spxDay <= -1.5);
    if (broad && breadth != null && breadth >= 0.75) src.push({ k: "breadth", t: `${Math.round(breadth * 100)}% of tracked stocks down 2%+` });
    const on = broad || src.length >= 2;
    const reason = src.map((s) => s.t).join(" + ");
    return { on, caution: !on && src.length === 1, sources: src.map((s) => s.k), reason: on ? (broad ? `Broad selloff — ${reason}` : reason) : src.length ? reason : null };
  }

  // ---------------------------------------------------------------- 5) spider-off twin: compare results
  function twinCompare(real, twin) {
    if (!real || !twin || !(real.start > 0) || !(twin.start > 0)) return null;
    const rr = real.value / real.start - 1, tr = twin.value / twin.start - 1;
    const diff = rr - tr;
    return { realRet: r2(rr * 100), twinRet: r2(tr * 100), diffPts: r2(diff * 100),
      verdict: Math.abs(diff) < 0.0025 ? "About even so far" : diff > 0 ? "Spider research is helping so far" : "Spider research is hurting so far",
      note: "Hypothetical paper comparison. The twin starts from the same holdings and fills at scan prices without the spider's score nudges, pre-buy checks or spider defense input." };
  }

  // ---------------------------------------------------------------- 8) morning brief
  function buildBrief(i = {}) {
    const flags = [];
    if (i.defense && i.defense.on) flags.push({ level: "high", text: `Swing bot defense mode: ${i.defense.reason}` });
    else if (i.defense && i.defense.caution) flags.push({ level: "med", text: `Caution (high-risk buys paused): ${i.defense.reason}` });
    if (i.riskOff) flags.push({ level: "med", text: "S&P 500 is below its 200-day average — swing bot keeps 20% cash" });
    if (i.regime && i.regime.pending) flags.push({ level: "low", text: `Quant regime may change: raw signal says ${i.regime.pending.label} (day ${i.regime.pending.days} of 3)` });
    if (i.desk && i.desk.mode && i.desk.mode !== "armed") flags.push({ level: i.desk.mode === "locked" || i.desk.mode === "paused" ? "high" : "med", text: `Desk risk: ${i.desk.reason || i.desk.mode}` });
    for (const v of (i.vetoes || []).slice(0, 4)) flags.push({ level: "med", text: `${v.sym}: ${v.note}` });
    for (const s of (i.heldSignals || []).filter((x) => x.dir < 0).slice(0, 5)) flags.push({ level: "med", text: `${s.sym} (held): ${s.name}` });
    for (const e of (i.earningsHeld || []).slice(0, 6)) flags.push({ level: e.days <= 1 ? "med" : "low", text: `${e.sym} reports ${e.days === 0 ? "today" : `in ${e.days} trading day${e.days === 1 ? "" : "s"}`} (${e.bots.join(", ")}): ${e.action}` });
    const order = { high: 0, med: 1, low: 2 };
    return {
      day: i.day, generatedAt: i.now || Date.now(),
      overnight: (i.findings || []).slice(0, 8),
      plans: i.plans || [],
      earningsToday: (i.earningsToday || []).slice(0, 20),
      flags: flags.sort((a, b) => order[a.level] - order[b.level]),
      note: "Paper trading only. Findings are the spider's stored research with their sources; plans are what the bots intend to do at the open and can change with the opening prices.",
    };
  }

  return { preBuyCheck, confirmRegime, CONFIRM_DAYS, REGIME_ORDER: ORDER, tagsFromWhy, candidateTags, lossCause, postMortems, lessonPenalty, penaltyFor,
    tradingDaysUntil, earningsAction, defenseDecision, twinCompare, buildBrief };
});

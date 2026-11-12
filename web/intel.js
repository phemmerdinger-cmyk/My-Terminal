// THE WEB — Market Intelligence Network (graph) and the Spider research assistant (chat).
// Both work only from stored research and real data: every graph edge carries a plain-language reason,
// and every chat answer cites the discoveries it used. Nothing is generated from thin air.
"use strict";
const DAY = 864e5, HOUR = 3600e3;
const uniq = (a) => [...new Set(a.filter(Boolean))];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pctS = (x, d = 1) => (x == null || !isFinite(x) ? "n/a" : (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(d) + "%");

// ---------------------------------------------------------------- network
function graph({ ST, DISC, sectorOf, industryOf, nameOf, held, tracked, traderHeld, MACRO_LINKS, now, focus }) {
  const N = new Map(), E = [], eKey = new Set();
  const node = (id, o) => { if (!N.has(id)) N.set(id, { id, ...o }); return N.get(id); };
  const edge = (a, b, type, why, w = 1) => { const k = a < b ? a + "|" + b + "|" + type : b + "|" + a + "|" + type; if (a === b || eKey.has(k) || !N.has(a) || !N.has(b)) return; eKey.add(k); E.push({ a, b, type, why, w: Math.round(w * 100) / 100 }); };
  const ex = ST.exposure || { pfs: [], corr: [], sectorWeight: {} };
  const H = new Set(held), W = new Set(tracked), TH = new Set(traderHeld || []);
  const top = DISC.filter((d) => d.u >= now - 72 * HOUR).sort((a, b) => b.importance - a.importance).slice(0, 36);
  const coSet = uniq([...held, ...tracked, ...(traderHeld || []), ...top.flatMap((d) => d.tickers)]).slice(0, 48);
  const coId = (s) => "co:" + s;
  for (const p of ex.pfs || []) node("pf:" + p.id, { type: "portfolio", label: p.name, sub: `$${Math.round(p.value).toLocaleString()}${p.dayPct == null ? "" : ` · ${pctS(p.dayPct, 2)} today`}`, size: 18, go: "#portfolio" });
  if ((traderHeld || []).length) node("ai:trader", { type: "trader", label: "AI Trader", sub: `${traderHeld.length} paper positions`, size: 16, go: "#aitrade" });
  for (const s of coSet) {
    const ds = DISC.filter((d) => d.tickers.includes(s) && d.u >= now - 7 * DAY), tone = ds.reduce((a, d) => a + d.tone, 0);
    node(coId(s), { type: H.has(s) ? "holding" : W.has(s) ? "watch" : "company", label: s, sub: nameOf(s), size: H.has(s) ? 11 + Math.min(8, ((ex.symWeight || {})[s] || 0) * 30) : 8, tone: clamp(tone, -3, 3), n: ds.length, go: "q:" + s });
    const sec = sectorOf(s);
    if (sec) { node("sec:" + sec, { type: "sector", label: sec, sub: ex.sectorWeight && ex.sectorWeight[sec] ? `up to ${Math.round(ex.sectorWeight[sec] * 100)}% of a portfolio` : "sector", size: 12 }); edge(coId(s), "sec:" + sec, "sector", `${s} is classified in ${sec}${/Broad|Bonds|International|Commodities|Small|Nasdaq|Thematic/.test(sec) ? " (fund category)" : " (GICS sector)"}`); }
    const ind = industryOf(s);
    if (ind && (H.has(s) || W.has(s))) { node("ind:" + ind, { type: "industry", label: ind, sub: sec || "", size: 7 }); edge(coId(s), "ind:" + ind, "industry", `${s} is in the ${ind} industry`); if (sec) edge("ind:" + ind, "sec:" + sec, "sector", `${ind} is part of ${sec}`); }
    if (TH.has(s)) edge("ai:trader", coId(s), "trader", `AI Trader currently holds ${s} (paper)`);
  }
  for (const p of ex.pfs || []) for (const [s, w] of Object.entries(p.weights || {})) edge("pf:" + p.id, coId(s), "holds", `${p.name} holds ${s}: ${(w * 100).toFixed(1)}% of its value`, clamp(w * 4, 0.3, 2));
  for (const [a, b, r] of ex.corr || []) if (r >= 0.6) edge(coId(a), coId(b), "correlation", `${a} and ${b} daily returns correlate ${r.toFixed(2)} over ~6 months`, clamp((r - 0.5) * 3, 0.3, 1.5));
  // economic indicators linked to sectors that are in play (held, or named by a recent macro finding)
  const hotSecs = new Set([...Object.entries(ex.sectorWeight || {}).filter(([, w]) => w >= 0.08).map(([k]) => k), ...DISC.filter((d) => ["macro", "policy"].includes(d.cat) && d.u >= now - 7 * DAY).flatMap((d) => d.sectors)]);
  for (const m of MACRO_LINKS) {
    const secs = Object.keys(m.sectors).filter((s) => hotSecs.has(s) && N.has("sec:" + s)); if (!secs.length) continue;
    const latest = ST.macro && ST.macro.rows ? ST.macro.rows.find((r) => (m.series || []).includes(r.id)) : null;
    node("mac:" + m.id, { type: "macro", label: m.name, sub: latest ? `${latest.name}: ${(+latest.value).toFixed(2)} (${latest.date})` : "economic indicator", size: 11, go: "#macro" });
    for (const s of secs) edge("mac:" + m.id, "sec:" + s, "sensitivity", `${m.name} → ${s}: ${m.sectors[s]} (rule of thumb)`);
  }
  // scheduled events
  for (const e of ((ST.earnings && ST.earnings.upcoming) || []).filter((e) => N.has(coId(e.symbol))).slice(0, 14)) {
    node("ev:earn:" + e.symbol, { type: "event", label: `${e.symbol} earnings`, sub: e.date + (e.hour === "bmo" ? " · before open" : e.hour === "amc" ? " · after close" : ""), size: 8 });
    edge("ev:earn:" + e.symbol, coId(e.symbol), "event", `${e.symbol} reports earnings on ${e.date}`);
  }
  // discoveries and how they connect
  for (const d of top) {
    node("d:" + d.id, { type: "discovery", cat: d.cat, label: d.headline.length > 54 ? d.headline.slice(0, 52) + "…" : d.headline, sub: d.cat, size: 5 + d.importance / 14, tone: d.tone, importance: d.importance, disc: d.id });
    for (const t of d.tickers) edge("d:" + d.id, coId(t), "mentions", `Discovery about ${t}`);
    if (!d.tickers.length) for (const s of d.sectors) { if (!N.has("sec:" + s)) node("sec:" + s, { type: "sector", label: s, sub: "sector", size: 10 }); edge("d:" + d.id, "sec:" + s, "affects", `${d.cat === "macro" || d.cat === "policy" ? "Economic finding" : "Finding"} relevant to ${s}`); }
    if (d.cat === "ai_trader" && N.has("ai:trader")) edge("d:" + d.id, "ai:trader", "trader", "Research flagged for AI Trader");
    const ml = MACRO_LINKS.find((m) => N.has("mac:" + m.id) && d.sectors.some((s) => m.sectors[s]) && (d.cat === "macro" || d.cat === "policy"));
    if (ml) edge("d:" + d.id, "mac:" + ml.id, "about", `Finding about ${ml.name.toLowerCase()}`);
  }
  for (const d of top) for (const r of d.rel || []) if (N.has("d:" + r)) edge("d:" + d.id, "d:" + r, "related", "Related finding about the same company or sector");
  let nodes = [...N.values()], edges = E;
  if (focus && N.has(focus)) { // a node and its neighborhood
    const keep = new Set([focus]); for (const e of E) { if (e.a === focus) keep.add(e.b); if (e.b === focus) keep.add(e.a); }
    nodes = nodes.filter((n) => keep.has(n.id)); edges = E.filter((e) => keep.has(e.a) && keep.has(e.b));
  }
  return { t: now, nodes, edges, counts: nodes.reduce((a, n) => ((a[n.type] = (a[n.type] || 0) + 1), a), {}) };
}

// ---------------------------------------------------------------- research assistant
const SECTOR_WORDS = [["Information Technology", /\b(tech|technology|software|semis?|semiconductors?|chips?)\b/i], ["Financials", /\b(banks?|financials?|insurers?|brokers?)\b/i], ["Energy", /\b(energy|oil|gas)\b/i], ["Health Care", /\b(health ?care|pharma|biotech|drug ?makers?|medical)\b/i],
  ["Utilities", /\butilit(y|ies)\b/i], ["Real Estate", /\b(real estate|reits?|property)\b/i], ["Industrials", /\b(industrials?|airlines?|defen[cs]e|transports?)\b/i], ["Materials", /\b(materials?|miners?|mining|chemicals?|steel)\b/i],
  ["Consumer Discretionary", /\b(consumer discretionary|retail(ers)?|autos?|automakers?)\b/i], ["Consumer Staples", /\b(consumer staples|staples|grocer(s|ies)?|beverages?)\b/i], ["Communication Services", /\b(communication services|media|telecoms?|social media)\b/i]];
let NAME_MAP = null;
function nameMap(SP) {
  if (NAME_MAP) return NAME_MAP;
  const m = new Map(), first = new Map();
  for (const r of SP.values()) {
    const clean = r.name.toLowerCase().replace(/[,.]/g, "").replace(/\b(inc|corp(oration)?|co|company|holdings?|plc|ltd|group|the|class [a-c])\b/g, "").replace(/\s+/g, " ").trim();
    if (clean.length >= 3) m.set(clean, r.sym);
    const f = clean.split(" ")[0]; if (f.length >= 4) first.set(f, first.has(f) ? null : r.sym);
  }
  for (const [f, s] of first) if (s && !m.has(f)) m.set(f, s);
  for (const [k, v] of Object.entries({ google: "GOOGL", alphabet: "GOOGL", facebook: "META", "berkshire": "BRK-B", "jp morgan": "JPM", jpmorgan: "JPM", "coca cola": "KO", "coca-cola": "KO" })) m.set(k, v);
  return (NAME_MAP = m);
}
function tickersIn(q, SP, tracked) {
  const out = [], known = new Set([...SP.keys(), ...tracked]);
  for (const m of q.matchAll(/\$?\b([A-Z]{1,5}(?:[.\-][A-Z])?)\b/g)) { const s = m[1].replace(".", "-"); if (known.has(s) && !/^(I|A|AI|THE|WHAT|WHY|HOW|AND|OR|FOR|ME|MY|IS|IT|ON|IN|TO|DO|ARE|ALL|ANY|NEW|NOW|CAN|BE|AT)$/.test(m[1])) out.push(s); }
  const lower = q.toLowerCase();
  for (const [name, s] of nameMap(SP)) if (name.length >= 4 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}('s)?\\b`).test(lower)) out.push(s);
  return uniq(out).slice(0, 4);
}

async function ask({ question, spider, ST, DISC, BIDX, SP, sectorOf, nameOf, held, tracked, now, claude }) {
  const q = String(question || "").trim().slice(0, 600);
  if (!q) return { answer: "Ask me about the market, your portfolio, a company or a sector.", citations: [], did: [], mode: "rules" };
  const C = [], did = [];
  const cite = (d) => { let i = C.findIndex((x) => x.id === d.id); if (i < 0) { C.push({ id: d.id, headline: d.headline, cat: d.cat, u: d.u, sources: d.sources, kind: require("./spider").kindOf(d) }); i = C.length - 1; } return `[${i + 1}]`; };
  const line = (d) => `${d.headline} ${cite(d)}`;
  const recent = (hrs, f = () => true) => DISC.filter((d) => d.u >= now - hrs * HOUR && f(d)).sort((a, b) => b.importance - a.importance);
  const lines = []; let intent = "search";
  const syms = tickersIn(q, SP, tracked);
  const secHit = SECTOR_WORDS.find(([, re]) => re.test(q));
  const has = (re) => re.test(q);

  if (syms.length && !has(/\bportfolio\b/i)) {
    intent = "company";
    for (const s of syms.slice(0, 2)) {
      const last = ST.researched[s];
      if (!last || now - last > 6 * HOUR) {
        try { let h; const r = await Promise.race([spider.runNow("company_snapshot", s, { reason: "you asked about " + s }), new Promise((ok) => { h = setTimeout(() => ok(null), 25000); })]).finally(() => clearTimeout(h)); if (r) did.push(`ran fresh research on ${s} (${r.status === "error" ? "failed: " + r.error : r.result || "done"})`); } catch (e) { did.push(`fresh research on ${s} failed: ${e.message}`); }
      }
      const P = spider.packet(s), days = /\b(month|30 days|4 weeks)\b/i.test(q) ? 31 : /\bweek\b/i.test(q) ? 7 : /\b(year|12 months)\b/i.test(q) ? 365 : 30;
      const ds = DISC.filter((d) => d.tickers.includes(s) && d.u >= now - days * DAY).sort((a, b) => b.u - a.u);
      lines.push(`**${s}${P.name && P.name !== s ? ` — ${P.name}` : ""}** (${P.sector || "sector n/a"}) · ${ds.length} finding${ds.length === 1 ? "" : "s"} in the last ${days} days`);
      const changed = ds.filter((d) => d.v > 1);
      for (const d of ds.slice(0, 6)) lines.push(`- ${new Date(d.u).toLocaleDateString("en-US", { month: "short", day: "numeric" })}: ${line(d)}${d.v > 1 ? ` (updated ${d.v - 1}×; earlier: “${(d.prev[0] || {}).headline || ""}”)` : ""}`);
      if (P.financialChanges) lines.push(`- 10-K health: grade ${P.financialChanges.grade || "n/a"} (FY${P.financialChanges.fiscalYear}), revenue growth ${pctS((P.financialChanges.revenueGrowth || 0) * 100)}, source SEC EDGAR.`);
      if (P.earnings.upcoming) lines.push(`- Next earnings: ${P.earnings.upcoming.date}.`);
      if (P.signal.n) lines.push(`- Research signal for AI Trader: ${P.signal.score >= 0.3 ? "positive" : P.signal.score <= -0.3 ? "negative" : "neutral"} (${P.signal.score.toFixed(2)} on −1…+1, ${P.signal.n} directional findings).`);
      if (!ds.length) lines.push("- I have no stored findings for this period yet.");
      if (changed.length) lines.push(`- What changed: ${changed.length} finding${changed.length > 1 ? "s were" : " was"} revised as new data came in.`);
    }
  } else if (has(/research everything|affecting my portfolio|my (portfolio|holdings|positions|investments)|portfolio/i) && !has(/\brisk/i)) {
    intent = "portfolio";
    for (const t of ["portfolio_scan", "news_sweep", "filings_watch", "earnings_watch"]) { const j = spider.enqueue(t, null, { boost: 0.8, reason: "you asked for a portfolio research sweep", force: true }); if (j) did.push(`queued: ${typeof spider._internal.JOBS[t].label === "string" ? spider._internal.JOBS[t].label.toLowerCase() : t}`); }
    if (!held.length) lines.push("I can't see any holdings yet — open the Portfolio tab once so your browser shares them with the Spider.");
    const ex = ST.exposure;
    if (ex) for (const p of ex.pfs) lines.push(`**${p.name}** — $${Math.round(p.value).toLocaleString()}, ${p.dayPct == null ? "today's change unknown (no live prices)" : pctS(p.dayPct, 2) + " today"}. Top sectors: ${Object.entries(p.sectors).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, w]) => `${k} ${(w * 100).toFixed(0)}%`).join(", ")}.`);
    const ds = recent(72, (d) => d.pf && d.pf.rel >= 0.45);
    const bySym = {}; for (const d of ds) for (const s of d.cat === "portfolio" || !d.pf.syms.length ? ["(portfolio-wide)"] : d.pf.syms) (bySym[s] = bySym[s] || []).push(d);
    for (const [s, list] of Object.entries(bySym).slice(0, 8)) lines.push(`- **${s}**: ${list.slice(0, 2).map(line).join("; ")}`);
    if (!ds.length && held.length) lines.push("No findings touching your holdings in the last 3 days. A full sweep is queued now — check the activity panel in a few minutes.");
  } else if (has(/\b(risks?|danger|worr(y|ied)|threats?|downside|exposed)\b/i)) {
    intent = "risks";
    const ds = recent(96, (d) => (d.tone < 0 || (d.cat === "portfolio" && d.mag >= 0.6) || (d.cat === "macro" && /recession|inverted/i.test(d.headline))) && (d.pf.rel >= 0.3 || ["macro", "policy", "market"].includes(d.cat)))
      .sort((a, b) => b.pf.rel * 50 + b.importance - (a.pf.rel * 50 + a.importance));
    lines.push(ds.length ? "The biggest risks in stored research, ranked by how much of your portfolio they touch:" : "I haven't found elevated risks touching your portfolio in the last 4 days.");
    for (const d of ds.slice(0, 7)) lines.push(`- ${line(d)}${d.pf.why[0] ? ` — ${d.pf.why[0]}` : ""}`);
    const conc = DISC.find((d) => /^exposure:/.test(d.key) && d.mag >= 0.6); if (conc && !ds.includes(conc)) lines.push(`- Concentration: ${line(conc)}`);
  } else if (has(/\b(ai trader|trader|bot|autopilot)\b/i)) {
    intent = "trader";
    const T = ST.trader;
    if (T) { lines.push(`AI Trader holds ${T.held.length} stock${T.held.length === 1 ? "" : "s"}${T.held.length ? ` (${T.held.join(", ")})` : ""}. Mode: ${T.stress ? "defense" : T.riskOff ? "risk-off" : "normal"}.`);
      const strong = Object.values(T.packets).filter((p) => Math.abs(p.score) >= 0.3).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 6);
      for (const p of strong) lines.push(`- **${p.sym}** research signal ${p.score >= 0 ? "+" : ""}${p.score.toFixed(2)}${T.held.includes(p.sym) ? " (held)" : ""}: ${p.reasons.slice(0, 2).join("; ")}`); }
    const ds = recent(48, (d) => d.ai && d.ai.rel >= 0.5).slice(0, 6);
    if (ds.length) { lines.push("Discoveries AI Trader should pay attention to:"); for (const d of ds) lines.push(`- ${line(d)} — ${d.ai.why || ""}`); }
    if (!T && !ds.length) lines.push("I haven't synced with AI Trader yet; the sync runs every 10 minutes during market hours.");
  } else if (has(/interesting|haven'?t (researched|looked)|new (ideas|companies|stocks)|\bdiscover (new|some)|outside my|something new/i)) {
    intent = "explore";
    for (let i = 0; i < 2; i++) { const j = spider.enqueue("explore", null, { boost: 0.6, force: true, reason: "you asked for new companies" }); if (j && !i) did.push("queued more exploration of the S&P 500"); }
    const ds = DISC.filter((d) => d.cat === "company" && d.explore && d.u >= now - 7 * DAY).sort((a, b) => b.mag - a.mag || b.u - a.u);
    const movers = recent(48, (d) => ["mover", "earnings", "insider"].includes(d.cat) && d.tickers.length && !d.tickers.some((t) => tracked.includes(t)) && d.tone > 0);
    lines.push(ds.length || movers.length ? "Companies outside your watchlist that stood out in my research (leads, not recommendations):" : "I haven't explored enough companies yet — exploration is queued now.");
    for (const d of [...ds.slice(0, 5), ...movers.slice(0, 3)]) lines.push(`- ${line(d)}`);
  } else if (secHit && has(/\b(why|what happened|fell|fall|drop|down|rose|rise|up|rall|move)/i)) {
    intent = "sector";
    const [sec] = secHit, row = ST.market && (ST.market.sectors || []).find((x) => x.name === sec);
    lines.push(row ? `**${sec}** (${row.etf}) ${row.chg >= 0 ? "is up" : "is down"} ${Math.abs(row.chg).toFixed(2)}% (as of ${new Date(ST.market.fresh.latest || ST.market.at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET; ${ST.market.fresh.status}).` : `I don't have today's ${sec} performance yet.`);
    const dir = row ? Math.sign(row.chg) : 0, order = { pattern: 3, mover: 3, news: 2, policy: 2, macro: 2, sector: 2, earnings: 1 };
    const ds = recent(30, (d) => d.cat !== "portfolio" && d.cat !== "ai_trader" && (d.sectors.includes(sec) || d.tickers.some((t) => sectorOf(t) === sec)))
      .sort((a, b) => ((Math.sign(b.tone) === dir) * 2 + (order[b.cat] || 0) + b.importance / 50) - ((Math.sign(a.tone) === dir) * 2 + (order[a.cat] || 0) + a.importance / 50));
    if (ds.length) { lines.push("Findings that could explain it:"); for (const d of ds.slice(0, 6)) lines.push(`- ${line(d)}`); }
    const re = secHit[1], news = ((ST.newsDigest || {}).top || []).filter((n) => re.test(n.title)).slice(0, 3);
    for (const n of news) lines.push(`- Headline: “${n.title}” (${n.source})`);
    if (!ds.length && !news.length) lines.push("I couldn't find a stored finding or headline that explains the move. That doesn't mean there's no cause — only that my sources don't show one.");
    lines.push("_Causation from headlines is an interpretation; timing alone doesn't prove what moved the sector._");
  } else if (has(/what happened|market today|today'?s market|how('s| is| did) the market|today in|summar(y|ize)|brief/i)) {
    intent = "today";
    const b = BIDX[0] ? await spider.briefing(BIDX[0].id) : null;
    if (b && now - b.generatedAt < 10 * HOUR) { lines.push(`From the **${b.label} briefing** (${new Date(b.generatedAt).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET · ${b.freshness.quotes.label}):`); for (const s of b.exec) lines.push(`- ${s}`); }
    else if (ST.market && ST.market.idx["^GSPC"]) { const x = ST.market.idx["^GSPC"]; lines.push(`S&P 500 ${pctS(x.chg, 2)} (${ST.market.fresh.status}).`); }
    else lines.push("I haven't collected market data yet this session.");
    const ds = recent(24, (d) => d.importance >= 45).slice(0, 6);
    if (ds.length) { lines.push("Most important findings in the last 24 hours:"); for (const d of ds) lines.push(`- ${line(d)}`); }
  } else {
    const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !/^(what|which|when|where|about|there|their|should|would|could|have|been|does|tell|show|give|with|from|that|this|spider)$/.test(w));
    const ds = DISC.filter((d) => words.some((w) => (d.headline + " " + d.summary).toLowerCase().includes(w))).sort((a, b) => b.importance - a.importance || b.u - a.u).slice(0, 8);
    if (ds.length) { lines.push(`Stored research matching “${words.slice(0, 4).join(", ")}”:`); for (const d of ds) lines.push(`- ${line(d)}`); }
    else lines.push("I don't have stored research that matches that. Try asking about a company (“What has changed about Tesla this month?”), a sector (“Why did tech fall today?”), your portfolio, risks, AI Trader, or today's market.");
  }

  let answer = lines.join("\n"), mode = "rules";
  if (claude && C.length) {
    try {
      const ev = C.map((c, i) => `[${i + 1}] (${c.cat}, ${new Date(c.u).toISOString().slice(0, 16)}Z, ${c.kind}) ${c.headline} — sources: ${c.sources.map((s) => s.name).join(", ")}`).join("\n");
      const txt = await claude(`You are the Spider, the research agent in a personal market terminal. Answer the user's question using ONLY the numbered evidence below and the rules-based draft. Cite evidence as [n]. If the evidence doesn't answer something, say so. Never invent prices, numbers or events. Under 200 words, plain text with '- ' bullets allowed.\n\nQUESTION: ${q}\n\nEVIDENCE:\n${ev}\n\nRULES-BASED DRAFT:\n${answer}`);
      if (txt && txt.trim()) { answer = txt.trim(); mode = "claude"; }
    } catch (e) { did.push("Claude narrative unavailable (" + String(e.message || e).slice(0, 80) + ") — showing the rules-based answer"); }
  }
  return { answer, citations: C, did, intent, mode, tickers: syms, t: now };
}

module.exports = { graph, ask, tickersIn };

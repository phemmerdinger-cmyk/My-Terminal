// THE WEB — Daily Market Intelligence Briefing.
// Built only from data the Spider has actually collected and stored (no AI text, no invented numbers).
// Every line is tagged fact / interpretation / estimate / speculation and carries its source and time.
// If an input is missing or stale, the section says so instead of filling the gap.
"use strict";
const DAY = 864e5, HOUR = 3600e3;
const uniq = (a) => [...new Set(a.filter(Boolean))];
const pctS = (x, d = 1) => (x == null || !isFinite(x) ? "n/a" : (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(d) + "%");
const money = (x) => (x == null || !isFinite(x) ? "n/a" : (x < 0 ? "−$" : "$") + (Math.abs(x) >= 1e6 ? (Math.abs(x) / 1e6).toFixed(2) + "M" : Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })));
const etTime = (t) => (t ? new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET" : "n/a");
const etDate = (t) => new Date(t).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });

function buildBriefing({ slot, slots, session, dataDay, ST, DISC, trader, now, sectorOf, held, tracked, manual }) {
  const S = slots[slot] || { label: "On-demand", title: "On-demand briefing" };
  const mk = ST.market, nd = ST.newsDigest, ex = ST.exposure, er = ST.earnings, mc = ST.macro;
  const since = now - (slot === "morning" ? 18 : slot === "midday" ? 8 : 26) * HOUR;
  const recent = (cats, hrs) => DISC.filter((d) => cats.includes(d.cat) && d.u >= (hrs ? now - hrs * HOUR : since)).sort((a, b) => b.importance - a.importance);
  const H = new Set(held), T = new Set(tracked);
  const fromDisc = (d, extra = {}) => ({ text: d.headline, detail: d.summary, kind: (d.facts || []).some((f) => f.kind === "fact") ? "fact" : ((d.facts || [])[0] || {}).kind || (d.interp && d.interp.kind) || "fact", src: (d.sources[0] || {}).name || null, url: (d.sources[0] || {}).url || null, at: (d.sources[0] || {}).at || d.u, tickers: d.tickers, disc: d.id, importance: d.importance, tone: d.tone, ...extra });

  // ---- freshness: never present delayed or stale data as live
  const fr = mk ? mk.fresh : { status: "unavailable", latest: null };
  const marketAge = mk ? now - mk.at : null;
  const qStatus = !mk || fr.status === "unavailable" ? "unavailable" : marketAge > 2 * HOUR && session.open ? "stale" : fr.status;
  const qLabel = { live: `Live quotes as of ${etTime(fr.latest)}`, delayed: `Quotes delayed — last price update ${etTime(fr.latest)}`, close: `Last prices from the ${dataDay} session (as of ${etTime(fr.latest)})`, stale: `Stale: market data last collected ${etTime(mk && mk.at)}`, unavailable: "Price data unavailable" }[qStatus];
  const age = (t) => (t ? (now - t < HOUR ? `${Math.round((now - t) / 60000)} min ago` : `${(Math.round(((now - t) / HOUR) * 10) / 10)} h ago`) : "never");
  const freshness = { quotes: { status: qStatus, label: qLabel, at: fr.latest }, news: { at: nd && nd.at, label: nd ? `${nd.count} headlines from ${nd.outlets.length} outlets, collected ${age(nd.at)}` : "News not collected yet" },
    macro: { at: mc && mc.at, label: mc ? `Economic data checked ${age(mc.at)}` : "Economic data not checked yet" }, earnings: { at: er && er.at, label: er ? `Earnings calendar (${er.source || "n/a"}) checked ${age(er.at)}` : "Earnings calendar not checked yet" },
    portfolio: { at: ex && ex.at, label: ex ? `Portfolio exposure computed ${age(ex.at)}` : held.length ? "Portfolio not analyzed yet" : "No holdings shared with the Spider" }, notes: [] };
  if (!session.trading) freshness.notes.push(`Markets are ${session.phase}. Figures are from the last session (${dataDay}).`);
  if (qStatus === "delayed") freshness.notes.push("The price feed has not updated for 20+ minutes during market hours; treat moves as delayed.");
  if (qStatus === "stale") freshness.notes.push("Market data is more than 2 hours old.");

  const sections = [];
  const add = (key, title, items, why, empty) => sections.push({ key, title, why: why || null, items: items.filter(Boolean), empty: items.filter(Boolean).length ? null : empty || "Nothing notable found in the collected data." });
  const idx = (mk && mk.idx) || {}, spx = idx["^GSPC"], ndx = idx["^IXIC"], dji = idx["^DJI"], rut = idx["^RUT"], vix = idx["^VIX"], tnx = idx["^TNX"];
  const verb = session.open ? "is" : "was", br = mk && mk.breadth;

  // 1) overall market
  const s1 = [];
  if (spx) s1.push({ text: `S&P 500 ${spx.price.toFixed(2)}, ${pctS(spx.chg, 2)} ${session.open ? "today" : `on ${dataDay}`}`, kind: "fact", src: "Yahoo Finance", at: spx.t });
  if (br) s1.push({ text: `Breadth: ${br.up} of ${br.n} S&P 500 stocks ${session.open ? "are" : "were"} higher (${Math.round((br.up / br.n) * 100)}%)`, kind: "fact", src: "Yahoo Finance S&P 500 snapshot", at: br.at });
  if (vix) s1.push({ text: `VIX ${vix.price.toFixed(1)} (${pctS(vix.chg)})`, kind: "fact", src: "Cboe via Yahoo Finance", at: vix.t });
  if (spx) s1.push({ text: Math.abs(spx.chg) < 0.3 ? "A quiet session for the index overall." : br && ((spx.chg > 0 && br.up / br.n < 0.45) || (spx.chg < 0 && br.up / br.n > 0.55)) ? "The index move is narrow — a handful of large companies are doing most of the work, so the typical stock is behaving differently from the headline number." : `The move is broad-based${vix && vix.price >= 22 ? ", with volatility elevated" : ""}.`, kind: "interpretation" });
  add("overall", "Overall market performance", s1, "Sets the backdrop for every holding: most stocks move with the market on a typical day.", "Index data not collected yet.");

  // 2) indexes
  const IXN = [["^GSPC", "S&P 500"], ["^IXIC", "Nasdaq Composite"], ["^DJI", "Dow Jones"], ["^RUT", "Russell 2000"], ["^VIX", "VIX"], ["^TNX", "10-yr Treasury yield"], ["CL=F", "Crude oil"], ["GC=F", "Gold"], ["DX-Y.NYB", "US dollar index"], ["BTC-USD", "Bitcoin"]];
  const table = IXN.filter(([s]) => idx[s]).map(([s, n]) => ({ sym: s, name: n, price: idx[s].price, chg: idx[s].chg, at: idx[s].t }));
  const s2 = table.map((r) => ({ text: `${r.name}: ${r.sym === "^TNX" ? r.price.toFixed(2) + "%" : r.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} (${pctS(r.chg, 2)})`, kind: "fact", src: "Yahoo Finance", at: r.at }));
  if (ndx && dji && Math.abs(ndx.chg - dji.chg) >= 0.7) s2.push({ text: ndx.chg > dji.chg ? "Growth and tech-heavy Nasdaq is outpacing the Dow." : "The Dow's value and industrial names are holding up better than tech-heavy Nasdaq.", kind: "interpretation" });
  if (rut && spx && Math.abs(rut.chg - spx.chg) >= 0.8) s2.push({ text: rut.chg > spx.chg ? "Small caps are beating large caps — a sign of broad risk appetite." : "Small caps are lagging — investors prefer the safety of larger companies.", kind: "interpretation" });
  sections.push({ key: "indexes", title: "Major index movements", why: "Comparing indexes shows which part of the market (growth, value, small caps, rates, commodities) is driving the day.", items: s2, table, empty: table.length ? null : "Index data not collected yet." });

  // 3) news
  const s3 = (nd ? nd.top : []).slice(0, 7).map((n) => ({ text: n.title, kind: "fact", src: n.source, url: n.link, at: n.time, tickers: n.tickers, tone: n.tone, tag: n.trending ? "top story" : null }));
  if (nd && nd.themes.length) s3.push({ text: `Most-covered themes: ${nd.themes.map((t) => `${t.name} (${t.n})`).join(", ")}`, kind: "fact", src: "Market Desk news feeds", at: nd.at });
  add("news", "Most important market news", s3, "Ranked by Google/CNBC top-story status, headline tone, recency and whether it names a stock you hold.", "News has not been collected yet.");

  // 4) sectors
  const secs = (mk && mk.sectors) || [];
  const s4 = [];
  if (secs.length) {
    secs.slice(0, 3).forEach((x) => s4.push({ text: `▲ ${x.name} ${pctS(x.chg)} (${x.etf})`, kind: "fact", src: "Yahoo Finance", at: mk.fresh.latest, tag: "winner" }));
    secs.slice(-3).reverse().forEach((x) => s4.push({ text: `▼ ${x.name} ${pctS(x.chg)} (${x.etf})`, kind: "fact", src: "Yahoo Finance", at: mk.fresh.latest, tag: "loser" }));
    const def = ["Utilities", "Consumer Staples", "Health Care", "Real Estate"], d3 = secs.slice(0, 3).filter((x) => def.includes(x.name)).length;
    s4.push({ text: d3 >= 2 ? "Defensive sectors lead — investors are positioning for safety." : secs.slice(0, 3).some((x) => ["Information Technology", "Consumer Discretionary", "Communication Services"].includes(x.name)) ? "Growth-oriented sectors lead — a risk-on tone." : "No clear defensive or growth tilt in sector leadership.", kind: "interpretation" });
    const mine = ex ? secs.filter((x) => (ex.sectorWeight[x.name] || 0) >= 0.1) : [];
    if (mine.length) s4.push({ text: `Your biggest sector exposures today: ${mine.map((x) => `${x.name} ${pctS(x.chg)} (${Math.round(ex.sectorWeight[x.name] * 100)}% of a portfolio)`).join(", ")}`, kind: "fact", src: "Your portfolio + Yahoo Finance" });
  }
  sections.push({ key: "sectors", title: "Sector winners and losers", why: "Sector leadership reveals what investors are rewarding (growth, defense, rates, commodities).", items: s4, table: secs.map((x) => ({ name: x.name, etf: x.etf, chg: x.chg })), empty: s4.length ? null : "Sector data not collected yet." });

  // 5) economic developments
  const s5 = recent(["macro", "policy"]).slice(0, 7).map((d) => fromDisc(d));
  if (mc && mc.rows) for (const id of ["FEDFUNDS", "CPIAUCSL", "UNRATE"]) { const r = mc.rows.find((x) => x.id === id); if (r) s5.push({ text: `${r.name}: ${(+r.value).toFixed(2)}${r.unit === "%" ? "%" : ""} (latest reading, ${r.date})`, kind: "fact", src: r.src || "FRED", at: mc.at, tag: "reference" }); }
  add("economic", "Significant economic developments", s5, "Rates, inflation and jobs data set the discount rate and earnings outlook for every stock.", "No new economic releases or policy announcements since the last briefing.");

  // 6) company announcements
  const s6 = recent(["filing", "insider", "fundamentals"], 36).concat(recent(["earnings"], 36).filter((d) => /release/.test(d.key))).sort((a, b) => b.importance - a.importance).slice(0, 8).map((d) => fromDisc(d));
  add("companies", "Important company announcements", s6, "Primary-source disclosures (SEC filings, earnings releases, insider trades) from the companies you follow.", "No new SEC filings or releases from your companies in the last 36 hours.");

  // 7) earnings
  const s7 = [];
  for (const r of (er && er.reported) || []) s7.push({ text: `${r.sym} ${r.surprise >= 0.03 ? "beat" : r.surprise <= -0.03 ? "missed" : "matched"} EPS estimates by ${Math.abs(r.surprise * 100).toFixed(0)}% ($${(+r.actual).toFixed(2)} vs $${(+r.est).toFixed(2)}, ${r.date})`, kind: "fact", src: "Finnhub earnings calendar", tickers: [r.sym], tag: H.has(r.sym) ? "you hold" : T.has(r.sym) ? "watchlist" : null });
  const upc = ((er && er.upcoming) || []).filter((e) => e.date >= dataDay).sort((a, b) => (b.held - a.held) || a.date.localeCompare(b.date)).slice(0, 10);
  for (const e of upc) s7.push({ text: `Upcoming: ${e.symbol} reports ${e.date}${e.hour === "bmo" ? " before the open" : e.hour === "amc" ? " after the close" : ""}${e.eps != null ? ` (EPS est. $${(+e.eps).toFixed(2)})` : ""}`, kind: e.eps != null ? "estimate" : "fact", src: er.source || "Earnings calendar", tickers: [e.symbol], tag: e.held ? "you hold" : e.mine ? "watchlist" : null });
  add("earnings", "Earnings surprises and upcoming earnings", s7, "Earnings and guidance are the biggest scheduled company-specific catalysts.", er ? "No fresh results or reports in the next week for the companies tracked." : "Earnings calendar not checked yet.");

  // 8) unusual moves
  const s8 = recent(["mover"], 24).slice(0, 6).map((d) => fromDisc(d));
  const covered = new Set(s8.flatMap((x) => x.tickers || []));
  for (const m of ((mk && mk.movers) || []).filter((m) => !covered.has(m.sym)).slice(0, 6)) s8.push({ text: `${m.sym} ${pctS(m.chg)} (${sectorOf(m.sym) || "S&P 500"})`, kind: "fact", src: "Yahoo Finance S&P 500 snapshot", tickers: [m.sym], tag: "not yet investigated" });
  recent(["pattern"], 24).slice(0, 3).forEach((d) => s8.push(fromDisc(d)));
  add("unusual", "Unusual market movements", s8, "Large single-stock and sector moves often signal news the broader market hasn't priced yet.", "No S&P 500 stock moved 5% or more.");

  // 9) risks and catalysts
  const s9 = [];
  recent(["market", "macro", "policy", "portfolio", "pattern", "news", "mover", "earnings", "insider", "fundamentals", "ai_trader"], 30).filter((d) => d.tone < 0 && d.importance >= 45).slice(0, 5).forEach((d) => s9.push(fromDisc(d, { tag: "risk" })));
  DISC.filter((d) => d.cat === "portfolio" && /^(exposure|corr):/.test(d.key) && d.mag >= 0.6).slice(0, 2).forEach((d) => s9.push(fromDisc(d, { tag: "risk" })));
  upc.filter((e) => e.held).slice(0, 3).forEach((e) => s9.push({ text: `Catalyst: ${e.symbol} (a holding) reports ${e.date}`, kind: "fact", src: er.source, tickers: [e.symbol], tag: "catalyst" }));
  recent(["policy"], 30).filter((d) => d.mag >= 0.8).slice(0, 2).forEach((d) => s9.push(fromDisc(d, { tag: "catalyst" })));
  add("risks", "Major risks or catalysts", s9, "What could move your portfolio next — negative developments first, then scheduled events.", "No elevated risks found in the collected data.");

  // 10) portfolio
  const s10 = [];
  for (const p of (ex && ex.pfs) || []) s10.push(p.dayPct == null ? { text: `${p.name}: ${money(p.value)} at cost — live prices unavailable, so today's change is unknown`, kind: "fact", src: "Your holdings", at: ex.at }
    : { text: `${p.name}: ${money(p.value)}, ${p.day >= 0 ? "+" : "−"}${money(Math.abs(p.day))} (${pctS(p.dayPct, 2)}) ${session.open ? "today" : `on ${dataDay}`}${spx ? ` vs. S&P 500 ${pctS(spx.chg, 2)}` : ""}${p.priced < p.holdings ? ` · ${p.holdings - p.priced} holding(s) unpriced` : ""}`, kind: "fact", src: "Your holdings + Yahoo Finance", at: ex.at });
  DISC.filter((d) => d.pf && d.pf.rel >= 0.45 && d.u >= since && d.cat !== "portfolio").sort((a, b) => b.importance - a.importance).slice(0, 7).forEach((d) => s10.push(fromDisc(d, { tag: d.pf.why[0] || null })));
  add("portfolio", "Developments relevant to your portfolio", s10, "Spider findings ranked by how much of your money they touch.", held.length ? "No new developments touching your holdings since the last briefing." : "Open the Portfolio tab once so the Spider can see your holdings.");

  // 11) worth researching
  const s11 = [];
  DISC.filter((d) => d.cat === "company" && d.explore && d.mag >= 0.5 && d.u >= now - 3 * DAY).sort((a, b) => b.importance - a.importance).slice(0, 4).forEach((d) => s11.push(fromDisc(d, { tag: "new to you" })));
  recent(["mover", "earnings", "insider"], 30).filter((d) => d.tickers.length && !d.tickers.some((t) => T.has(t)) && d.tone > 0).slice(0, 4).forEach((d) => s11.push(fromDisc(d, { tag: "outside your portfolio" })));
  add("research", "Stocks worth researching further", s11.slice(0, 7), "Companies outside your watchlist that stood out. Leads for research, not recommendations.", "No standout companies outside your watchlist yet — the Spider explores a few per hour.");

  // 12) AI Trader
  const s12 = [];
  if (trader) {
    const sc = trader.lastScan || {}, pos = Object.keys(trader.positions || {}), t0 = new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    s12.push({ text: `Market mode: ${sc.stress ? `defense — ${sc.stress}` : sc.riskOff ? "risk-off (S&P 500 below its 200-day average, holding extra cash)" : "normal (fully invested)"}`, kind: "interpretation", src: "AI Trader (rules-based swing bot)", at: sc.t });
    s12.push({ text: `Holding ${pos.length} stock${pos.length === 1 ? "" : "s"}: ${pos.slice(0, 10).join(", ") || "none"}`, kind: "fact", src: "AI Trader paper account" });
    if ((sc.top || []).length) s12.push({ text: `Top-ranked now: ${sc.top.slice(0, 5).map((x) => `${x.sym} (#${x.rank})`).join(", ")}`, kind: "interpretation", src: "AI Trader ranking model", at: sc.t });
    const today = (trader.trades || []).filter((x) => new Date(x.t).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === t0).slice(0, 6);
    today.forEach((x) => s12.push({ text: `${x.side} ${x.sym}: ${x.why}`, kind: "fact", src: "AI Trader trade log", at: x.t, tickers: [x.sym] }));
    if (trader.plan && (trader.plan.orders || []).length) s12.push({ text: `Planned for the next open: ${trader.plan.orders.slice(0, 5).map((o) => `${o.side} ${o.sym}`).join(", ")}`, kind: "estimate", src: "AI Trader overnight plan", at: trader.plan.t });
    recent(["ai_trader"], 30).slice(0, 4).forEach((d) => s12.push(fromDisc(d, { kind: "interpretation" })));
  }
  add("ai", "AI Trader's interpretation", s12, "How the rules-based swing bot reads the same market, and where Spider research agrees or disagrees with its holdings. Paper money; the Spider never trades.", "AI Trader state not available yet.");

  // next-session catalysts
  const nextDay = upc.filter((e) => e.date > dataDay).map((e) => e.date).sort()[0];
  const s13 = upc.filter((e) => e.date === nextDay).slice(0, 8).map((e) => ({ text: `${e.symbol} reports ${e.date}${e.hour === "bmo" ? " before the open" : e.hour === "amc" ? " after the close" : ""}`, kind: "fact", src: er.source, tickers: [e.symbol], tag: e.held ? "you hold" : null }));
  if (trader && trader.plan && (trader.plan.orders || []).length) s13.push({ text: `AI Trader plans ${trader.plan.orders.length} order${trader.plan.orders.length > 1 ? "s" : ""} at the open`, kind: "estimate", src: "AI Trader overnight plan" });
  add("next", "Next session's catalysts", s13, "Scheduled events for the next trading session.", "No scheduled earnings for the next session among tracked companies.");

  // ---- executive summary (rules-based sentences from the sections above)
  const exec = [];
  if (spx) exec.push(`The S&P 500 ${session.open ? "is" : "closed"} ${spx.chg >= 0 ? "up" : "down"} ${Math.abs(spx.chg).toFixed(2)}%${br ? ` with ${Math.round((br.up / br.n) * 100)}% of its members higher` : ""}${qStatus === "delayed" ? " (delayed data)" : qStatus === "stale" ? " (stale data)" : !session.trading ? ` in the last session (${dataDay})` : ""}.`);
  else exec.push("Market prices could not be collected for this briefing, so market sections are incomplete.");
  if (secs.length >= 2) exec.push(`${secs[0].name} led (${pctS(secs[0].chg)}) and ${secs[secs.length - 1].name} lagged (${pctS(secs[secs.length - 1].chg)}).`);
  if (nd && nd.themes.length) exec.push(`The most-covered theme was ${nd.themes[0].name.toLowerCase()}${nd.top[0] ? `; top story: “${nd.top[0].title}”` : ""}.`);
  const p0 = ex && ex.pfs && ex.pfs.filter((p) => p.dayPct != null).sort((a, b) => b.value - a.value)[0];
  if (p0) exec.push(`${p0.name} ${verb} ${p0.dayPct >= 0 ? "up" : "down"} ${Math.abs(p0.dayPct).toFixed(2)}%${spx ? `, ${p0.dayPct >= spx.chg ? "ahead of" : "behind"} the index` : ""}.`);
  const topRisk = s9.find((x) => x.tag === "risk"); if (topRisk) exec.push(`Biggest flagged risk: ${topRisk.text}.`);
  const cat0 = s13[0] || (upc.find((e) => e.held) ? { text: `${upc.find((e) => e.held).symbol} reports ${upc.find((e) => e.held).date}` } : null);
  if (cat0) exec.push(`Next catalyst: ${cat0.text}.`);
  const headline = (exec[0] || "Briefing").replace(/\.$/, "");

  const tickers = uniq(sections.flatMap((s) => s.items.flatMap((i) => i.tickers || []))).slice(0, 40);
  const id = `${session.day}-${slot}${manual ? "-" + new Date(now).toISOString().slice(11, 16).replace(":", "") : ""}`;
  return {
    id, day: session.day, dataDay, slot, label: manual ? `${S.label} (on demand)` : S.label, title: session.trading ? S.title : `${S.title} · ${session.phase}`, date: etDate(now), generatedAt: now, trading: session.trading, manual,
    headline, exec, freshness, sections, tickers,
    keywords: [headline, ...exec, ...(nd ? nd.themes.map((t) => t.name) : []), ...tickers].join(" ").slice(0, 1500),
    method: "Rules-based summary of data the Spider collected from free public sources. No AI-written text, no invented figures.",
  };
}
module.exports = { buildBriefing };

/* Market Desk · HOME — the personalized home page.
 * Thin UI over existing data (S.pfs, S.quotes, S.news, MD.earnings, MD.discoveries, MD.hist) and
 * MDHomeCore (pure logic). Layout/preferences persist through MDDesk ("home" section).
 * Never calls a paid model; nothing is shown that isn't sourced. */
(function () {
  "use strict";
  const C = window.MDHomeCore, D = window.MDDesk;
  if (!C || !D || typeof S === "undefined") return;
  const el = () => document.getElementById("tab-home");
  const h = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const money = (n) => Number.isFinite(n) ? (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }) : "—";
  const pc = (n, d = 2) => Number.isFinite(n) ? (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(d) + "%" : "—";
  const cl = (n) => Number.isFinite(n) ? (n >= 0 ? "up" : "down") : "";
  const ago = (t) => { if (!t) return "time unknown"; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + "m ago" : m < 1440 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago"; };
  const when = (t) => new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
  const VIEWER = document.documentElement.classList.contains("viewonly");

  const defaults = () => ({ layout: C.defaultLayout(), presets: {}, preset: "", density: "expanded", pf: "", visit: { prev: 0, cur: 0 }, lastSectors: null, limits: { maxPosition: 25, maxSector: 40 }, bench: "SPY" });
  let cfg = Object.assign(defaults(), D.get("home", {}));
  cfg.layout = C.normalizeLayout(cfg.layout);
  const M = { mounted: false, sectors: null, earn: null, disc: null, discErr: null, risk: null, riskKey: "", riskBusy: false, since: 0, drag: null, shift: [] };
  let saving = false;
  const save = () => { saving = true; try { D.set("home", cfg); } finally { saving = false; } };
  D.on((s) => { if (s === "home" && !saving) { cfg = Object.assign(defaults(), D.get("home", {})); cfg.layout = C.normalizeLayout(cfg.layout); if (S.tab === "home") render(); } });

  // Investor DNA (Phase 2) can override limits/benchmark; fall back to Home's own settings.
  const limits = () => { const dna = D.get("dna", null); return { maxPosition: (dna && +dna.maxPosition) || cfg.limits.maxPosition, maxSector: (dna && +dna.maxSector) || cfg.limits.maxSector }; };
  const bench = () => { const dna = D.get("dna", null); return String((dna && dna.benchmark) || cfg.bench || "SPY").toUpperCase(); };
  const pf = () => (S.pfs || []).find((p) => p.id === cfg.pf) || (S.pfs || []).find((p) => p.id === S.pfActive) || (S.pfs || [])[0] || { name: "Portfolio", holdings: [] };
  const summary = () => C.summarize(pf(), S.quotes, M.sectors || {});

  function visit() { // "since your last visit" = the previous session that was at least 30 minutes ago
    const now = Date.now(), v = cfg.visit || { prev: 0, cur: 0 };
    if (!v.cur || now - v.cur > 30 * 60e3) { v.prev = v.cur || 0; }
    v.cur = now; cfg.visit = v; M.since = v.prev || now - 864e5;
  }
  async function loadSide() {
    const sym = [...new Set([...(S.wl || []), ...pf().holdings.map((x) => x.symbol)])].filter((s) => !/[\^=]|-USD$/.test(s)).slice(0, 40);
    const jobs = [];
    if (!M.sectors) jobs.push(MD.cached("sp500file", 864e5, () => fetch("/sp500.json").then((r) => r.json())).then((j) => { M.sectors = Object.fromEntries((j.rows || []).map((r) => [r[0], r[2]])); }).catch(() => { M.sectors = {}; }));
    jobs.push(MD.earnings(sym).then((j) => { M.earn = j; }).catch(() => { M.earn = { error: true }; }));
    if (!VIEWER) jobs.push(MD.discoveries(60).then((j) => { M.disc = j; M.discErr = null; }).catch((e) => { M.discErr = String(e.message || e); }));
    await Promise.all(jobs); render();
  }
  async function loadRisk() {
    const s = summary(), shares = {}; s.rows.forEach((r) => { if (!/[\^=]/.test(r.symbol)) shares[r.symbol] = r.shares; });
    const key = JSON.stringify([shares, bench()]); if (key === M.riskKey || M.riskBusy) return;
    if (!Object.keys(shares).length) { M.risk = { error: "No holdings in this portfolio" }; M.riskKey = key; return render(); }
    M.riskBusy = true; render();
    try {
      const syms = Object.keys(shares).slice(0, 25), hist = {};
      const [b, ...hs] = await Promise.all([bench(), ...syms].map((x) => MD.histDays(x, 366).catch(() => null)));
      syms.forEach((x, i) => { hist[x] = hs[i]; });
      const irx = S.quotes["^IRX"], rf = irx && !irx.error && irx.price > 0 ? irx.price / 100 : 0.04;
      M.risk = C.risk(hist, shares, b, rf); M.risk.rf = rf; if (Object.keys(shares).length > 25) M.risk.capped = Object.keys(shares).length - 25;
    } catch (e) { M.risk = { error: String(e.message || e) }; }
    M.riskBusy = false; M.riskKey = key; render();
  }

  // ---------------------------------------------------------------- widgets
  // AI vs S&P 500: the three paper bots from the live scoreboard (/api/pub/botslive, public, polled while Home is open)
  async function loadBots() {
    if (M.botsBusy) return; M.botsBusy = true;
    try { const r = await fetch("/api/pub/botslive", { cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status); M.bots = await r.json(); M.botsErr = null; M.botsAt = Date.now(); }
    catch (e) { M.botsErr = String(e.message || e); } finally { M.botsBusy = false; }
    if (S.tab === "home") { const w = el() && el().querySelector('[data-mc-id="trading"] .mc-wb'); if (w) w.innerHTML = wTrading(); else render(); }
  }
  function wTrading() {
    if (!M.bots) return M.botsErr ? `<p class="mc-empty">Trading bots unavailable right now (${h(M.botsErr)}).</p>` : `<div class="mc-skel"></div><div class="mc-skel"></div>`;
    const B = C.botBoard(M.bots), sn = M.bots, ICON = { swing: "🤖", day: "⚡", quant: "📐" };
    if (!B.rows.length) return `<p class="mc-empty">No bot data yet.</p>`;
    const extra = (r) => { const b = sn[r.k] || {};
      if (r.k === "swing") return `${b.n || 0} holding${b.n === 1 ? "" : "s"} · run #${b.run || 1}`;
      if (r.k === "day") return `${(b.tradesToday || 0).toLocaleString()} trades today${b.hitRate != null ? ` · forecast right ${(b.hitRate * 100).toFixed(1)}%` : ""} · run #${b.run || 1}`;
      return b.error ? `waiting for data` : `${b.n || 0} holdings${b.regime ? ` · ${h(b.regime)}` : ""}`; };
    const lead = (x) => x == null ? `<span class="mc-note">S&amp;P starts at first trade</span>` : `<b class="${cl(x)}">${x >= 0 ? "+" : "−"}${money(Math.abs(x)).replace(/^−/, "")}</b>`;
    const T = B.total;
    return `<table class="mc-tbl"><thead><tr><th>Bot</th><th>Value</th><th>Return</th><th>S&amp;P same period</th><th>vs S&amp;P</th></tr></thead><tbody>
      ${B.rows.map((r) => `<tr><td><button type="button" class="mc-link" data-mc-go="aitrade" data-mc-bot="${r.k}">${ICON[r.k]} ${h(r.name)}</button><small class="mc-note" style="display:block">${extra(r)}</small></td><td>${money(r.value)}</td><td class="${cl(r.ret)}">${pc(r.ret * 100)}</td><td class="${r.spxRet == null ? "" : cl(r.spxRet)}">${r.spxRet == null ? "—" : pc(r.spxRet * 100)}</td><td>${lead(r.lead)}</td></tr>`).join("")}
      <tr><td><b>All three</b><small class="mc-note" style="display:block">${money(T.start)} started</small></td><td><b>${money(T.value)}</b></td><td class="${cl(T.ret)}"><b>${pc(T.ret * 100)}</b></td><td class="${T.spxRet == null ? "" : cl(T.spxRet)}">${T.spxRet == null ? "—" : pc(T.spxRet * 100)}</td><td>${lead(T.lead)}</td></tr></tbody></table>
      <p class="mc-note">Paper money only (simulated trades). ${sn.open ? "Market open · live prices" : "Market closed · last prices"}, updated ${ago(M.botsAt)}. S&amp;P column = the index over each bot's own run. <button type="button" class="mc-link" data-mc-go="aitrade">Open AI vs S&amp;P 500 →</button></p>`;
  }
  function wBriefing(s) {
    if (!S.news && !M.earn) return `<div class="mc-skel"></div><div class="mc-skel"></div><div class="mc-skel"></div>`;
    const L = C.briefing({ news: S.news, discoveries: M.disc, earnings: M.earn, quotes: S.quotes, summary: s, watchlist: S.wl, since: M.since });
    const fresh = L.filter((x) => x.isNew).length;
    const head = `<p class="mc-sub">${fresh} new since your last visit (${M.since ? when(M.since) : "first visit"}) · ranked by relevance to your holdings and watchlist, not by time${VIEWER ? "" : M.discErr ? ` · Spider research unavailable (${h(M.discErr)})` : ""}.</p>`;
    if (!L.length) return head + `<p class="mc-empty">No sourced items match your holdings or watchlist yet. Add holdings in <button type="button" class="mc-link" data-mc-go="portfolio">My portfolio</button> or tickers to the watchlist.</p>`;
    return head + `<ul class="mc-brief">${L.map((x) => `<li class="k-${x.kind}">
      <div class="mc-bt">${x.isNew ? '<span class="mc-tag new">NEW</span>' : ""}<span class="mc-tag">${h(x.kind === "spider" ? "SPIDER" : x.kind === "filing" ? "FILING" : x.kind === "earnings" ? "EARNINGS" : x.kind === "move" ? "PRICE" : "NEWS")}</span>
      ${x.url ? `<a href="${h(x.url)}" target="_blank" rel="noopener">${h(x.title)}</a>` : `<button type="button" class="mc-link" data-mc-go="${h(x.go || "news")}"${x.sym ? ` data-mc-sym="${h(x.sym)}"` : ""}>${h(x.title)}</button>`}</div>
      <div class="mc-meta">${h(x.source)} · ${h(when(x.time))} (${ago(x.time)})${x.tickers.length ? " · " + x.tickers.slice(0, 4).map(h).join(" ") : ""} · <i>${h(x.nature)}</i></div>
      <details><summary>Why this matters</summary><ul>${x.reasons.map((r) => `<li>${h(r)}</li>`).join("")}</ul>${x.summary ? `<p>${h(x.summary)}</p>` : ""}<p class="mc-note">Relevance ${x.score} is a personal-priority score (holding weight, watchlist, primary source, recency), not a price forecast.</p></details></li>`).join("")}</ul>`;
  }
  function wPortfolio(s) {
    if (!s.positions) return `<p class="mc-empty">${h(s.name)} has no holdings. <button type="button" class="mc-link" data-mc-go="portfolio">Add holdings →</button></p>`;
    if (s.unpriced.length === s.positions) return `<p class="mc-empty">Live quotes are unavailable for all ${s.positions} holdings right now, so value and gains aren't shown (nothing is estimated). Recorded cost: ${money(s.cost)}.</p>`;
    const stale = s.rows.filter((r) => r.quoteTime && Date.now() - r.quoteTime > 4 * 86400e3).length;
    return `<div class="mc-kpis">
      <div><span>Market value</span><b>${money(s.value)}</b><small>${s.positions - s.unpriced.length}/${s.positions} priced</small></div>
      <div><span>Today</span><b class="${cl(s.day)}">${s.day == null ? "—" : (s.day < 0 ? "−" : "+") + money(Math.abs(s.day))}</b><small class="${cl(s.dayPct)}">${pc(s.dayPct)}</small></div>
      <div><span>Unrealized gain/loss</span><b class="${cl(s.unreal)}">${(s.unreal < 0 ? "−" : "+") + money(Math.abs(s.unreal))}</b><small class="${cl(s.unrealPct)}">${pc(s.unrealPct)} on cost ${money(s.pricedCost)}</small></div>
    </div>
    <table class="mc-tbl"><thead><tr><th>Largest positions</th><th>Weight</th><th>Today</th><th>Unrealized</th></tr></thead><tbody>${s.top.map((r) => `<tr><td><button type="button" class="mc-link" data-mc-go="research" data-mc-sym="${h(r.symbol)}">${h(r.symbol)}</button></td><td>${r.weight.toFixed(1)}%</td><td class="${cl(r.dayPct)}">${pc(r.dayPct)}</td><td class="${cl(r.unrealPct)}">${pc(r.unrealPct, 1)}</td></tr>`).join("")}</tbody></table>
    <p class="mc-note">Unrealized = current quote vs your recorded cost. Realized gains aren't tracked by the portfolio page.${s.unpriced.length ? ` Excluded (no quote): ${h(s.unpriced.join(", "))}.` : ""}${stale ? ` ${stale} quote(s) older than 4 days.` : ""} <button type="button" class="mc-link" data-mc-go="portfolio">Open portfolio →</button></p>`;
  }
  function wAllocation(s) {
    if (!s.positions || !s.top.length) return `<p class="mc-empty">${s.positions ? "Weights need live quotes; none are available right now." : "No allocation to show."}</p>`;
    const lim = limits(), bar = (label, w, over) => `<div class="mc-bar${over ? " over" : ""}"><span>${h(label)}</span><i style="--w:${Math.min(100, w).toFixed(1)}%"></i><b>${w.toFixed(1)}%</b></div>`;
    return `<h4>Sectors</h4>${s.sectors.slice(0, 8).map((x) => bar(x.sector, x.weight, x.weight > lim.maxSector && x.sector !== "Other / unclassified")).join("")}
      <h4>Positions</h4>${s.top.map((r) => bar(r.symbol, r.weight, r.weight > lim.maxPosition)).join("")}
      <p class="mc-note">Effective number of positions ${s.effectiveN ? s.effectiveN.toFixed(1) : "—"} (1/HHI) · limits ${lim.maxPosition}% per position, ${lim.maxSector}% per sector${D.get("dna", null) ? " (from Investor DNA)" : ""}. Sectors from the S&amp;P 500 list; others are “unclassified”. <button type="button" class="mc-link" data-mc-go="risk">Risk &amp; stress →</button></p>`;
  }
  function spark(a, b) {
    const n = a.length, all = a.map((v) => v / a[0]).concat(b.map((v) => v / b[0])), lo = Math.min(...all), hi = Math.max(...all), y = (v) => (40 - (v - lo) / (hi - lo || 1) * 38).toFixed(1);
    const path = (arr) => arr.map((v, i) => (i ? "L" : "M") + (i / (n - 1) * 300).toFixed(1) + " " + y(v / arr[0])).join("");
    return `<svg class="mc-spark" viewBox="0 0 300 42" preserveAspectRatio="none" role="img" aria-label="Hypothetical portfolio vs benchmark, past year"><path d="${path(b)}" class="b"/><path d="${path(a)}" class="a"/></svg>`;
  }
  function wRisk() {
    if (M.riskBusy) return `<div class="mc-skel"></div><div class="mc-skel"></div><p class="mc-note">Loading a year of daily prices (shared cache)…</p>`;
    const r = M.risk; if (!r) return `<p class="mc-empty">Loading…</p>`;
    if (r.error) return `<p class="mc-empty">Risk unavailable: ${h(r.error)}.</p>`;
    const f = (x) => Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "—";
    return `<div class="mc-kpis"><div><span>1Y return (hypothetical)</span><b class="${cl(r.total)}">${f(r.total)}</b><small>${h(bench())} ${f(r.benchTotal)}</small></div>
      <div><span>Volatility (ann.)</span><b>${f(r.vol)}</b><small>Sharpe ${Number.isFinite(r.sharpe) ? r.sharpe.toFixed(2) : "—"}</small></div>
      <div><span>Max drawdown</span><b class="down">${f(r.mdd)}</b><small>${h(bench())} ${f(r.benchMdd)} · β ${Number.isFinite(r.beta) ? r.beta.toFixed(2) : "—"}</small></div></div>
      ${spark(r.values, r.bench)}<p class="mc-legend"><span class="a">■</span> today's holdings <span class="b">■</span> ${h(bench())}</p>
      <details><summary>Assumptions</summary><p class="mc-note">Today's share counts held constant over ${r.days} trading days (${new Date(r.from).toISOString().slice(0, 10)} → ${new Date(r.to).toISOString().slice(0, 10)}), adjusted daily closes from Yahoo Finance. This is a <b>hypothetical</b> backward look, not your realized return. Risk-free ${(r.rf * 100).toFixed(2)}% (13-week T-bill${S.quotes["^IRX"] ? "" : ", default 4%"}).${r.missing.length ? ` Excluded for insufficient history: ${h(r.missing.join(", "))}.` : ""}${r.capped ? ` ${r.capped} smallest-listed holdings beyond 25 not loaded.` : ""}</p></details>`;
  }
  function wCatalysts(s) {
    const e = M.earn; if (!e) return `<div class="mc-skel"></div>`;
    if (e.error) return `<p class="mc-empty">Earnings calendar unavailable right now.</p>`;
    const mine = new Set(s.rows.map((r) => r.symbol)), today = new Date().toISOString().slice(0, 10);
    const L = (e.yours || []).filter((x) => x.date >= today).slice(0, 10);
    const filings = ((S.news && S.news.items) || []).filter((n) => n.source === "official" && /SEC/i.test(n.agency || "") && (n.tickers || []).some((t) => mine.has(t))).slice(0, 5);
    return `${L.length ? `<table class="mc-tbl"><thead><tr><th>Date</th><th>Earnings</th><th>EPS est.</th></tr></thead><tbody>${L.map((x) => `<tr><td>${h(x.date)}</td><td><button type="button" class="mc-link" data-mc-go="research" data-mc-sym="${h(x.symbol)}">${h(x.symbol)}</button>${mine.has(x.symbol) ? ' <span class="mc-tag">HELD</span>' : ""}</td><td>${Number.isFinite(x.epsEstimate) ? x.epsEstimate.toFixed(2) : "—"}</td></tr>`).join("")}</tbody></table>` : `<p class="mc-empty">No scheduled earnings for your holdings or watchlist.</p>`}
      ${filings.length ? `<h4>Recent SEC filings (holdings)</h4><ul class="mc-list">${filings.map((n) => `<li><a href="${h(n.link)}" target="_blank" rel="noopener">${h(n.title)}</a> <small>${h(when(n.time))}</small></li>`).join("")}</ul>` : ""}
      <p class="mc-note">Source: ${h(e.source || "earnings calendar")}, updated ${ago(e.updated)}. Economic releases live in <button type="button" class="mc-link" data-mc-go="macro">Macro →</button></p>`;
  }
  const BODY = { trading: wTrading, briefing: wBriefing, portfolio: wPortfolio, allocation: wAllocation, risk: wRisk, catalysts: wCatalysts };

  // ---------------------------------------------------------------- shell
  function toolbar() {
    const hidden = cfg.layout.filter((x) => x.hidden), names = Object.keys(cfg.presets || {}), st = D.state();
    return `<div class="mc-bar-top" role="toolbar" aria-label="Home settings">
      <label>Portfolio <select id="mcPf">${(S.pfs || []).map((p) => `<option value="${h(p.id)}"${p.id === pf().id ? " selected" : ""}>${h(p.name)}</option>`).join("")}</select></label>
      <div class="mc-seg" role="group" aria-label="Information density"><button type="button" data-mc-density="compact" aria-pressed="${cfg.density === "compact"}">Compact</button><button type="button" data-mc-density="expanded" aria-pressed="${cfg.density !== "compact"}">Expanded</button></div>
      ${VIEWER ? "" : `<label>Layout <select id="mcPreset"><option value="">— current —</option>${names.map((n) => `<option${n === cfg.preset ? " selected" : ""}>${h(n)}</option>`).join("")}</select></label>
      <form id="mcSave" class="mc-inline"><input id="mcPresetName" maxlength="30" placeholder="Save layout as…" aria-label="Layout name"><button class="btn">Save</button></form>
      ${cfg.preset ? `<button type="button" class="btn ghost" id="mcDelPreset">Delete “${h(cfg.preset)}”</button>` : ""}`}
      <button type="button" class="btn ghost" id="mcReset">Reset layout</button>
      ${hidden.length ? `<span class="mc-hidden">Hidden: ${hidden.map((x) => `<button type="button" class="mc-chip" data-mc-show="${x.id}">+ ${h(C.WIDGETS.find((w) => w.id === x.id).title)}</button>`).join("")}</span>` : ""}
      <span class="mc-sync" title="${h(st.error || "")}">${VIEWER ? "Demo: changes aren't saved" : st.status === "synced" ? `Saved · ${st.durable ? "server (durable)" : "browser + server temp"}` : st.status === "offline" ? "Saved in this browser (server unreachable)" : "Saved in this browser"}</span>
      ${VIEWER ? "" : `<button type="button" class="btn ghost" id="mcExport">Export my data</button><label class="btn ghost mc-file">Import<input type="file" id="mcImport" accept="application/json" hidden></label>`}
    </div>`;
  }
  function render() {
    const root = el(); if (!root || S.tab !== "home") return;
    const s = summary();
    if (!M.shiftDone && s.positions && !s.unpriced.length && M.sectors) { // compare sector exposure with the last fully-priced visit, once per session
      M.shiftDone = true; const id = pf().id || "default", prev = cfg.lastSectors && !Array.isArray(cfg.lastSectors) ? cfg.lastSectors[id] : null;
      if (prev) M.shift = C.exposureShift(prev, s.sectors);
      cfg.lastSectors = { ...(cfg.lastSectors && !Array.isArray(cfg.lastSectors) ? cfg.lastSectors : {}), [id]: s.sectors.map((x) => ({ sector: x.sector, weight: +x.weight.toFixed(2) })) }; save();
    }
    root.dataset.density = cfg.density;
    const grid = cfg.layout.filter((x) => !x.hidden).map((x, i, arr) => {
      const w = C.WIDGETS.find((y) => y.id === x.id);
      return `<section class="mc-w span-${x.span}" data-mc-id="${x.id}" aria-labelledby="mcH-${x.id}">
        <header class="mc-wh" draggable="true" title="Drag to move"><span class="mc-grip" aria-hidden="true">⋮⋮</span><h3 id="mcH-${x.id}">${h(w.title)}</h3>
        <span class="mc-ctl"><button type="button" data-mc-move="up" aria-label="Move ${h(w.title)} earlier"${i === 0 ? " disabled" : ""}>↑</button><button type="button" data-mc-move="down" aria-label="Move ${h(w.title)} later"${i === arr.length - 1 ? " disabled" : ""}>↓</button><button type="button" data-mc-size aria-label="Resize ${h(w.title)} (width ${x.span} of 3)">⇔${x.span}</button><button type="button" data-mc-hide aria-label="Hide ${h(w.title)}">✕</button></span></header>
        <div class="mc-wb">${BODY[x.id](s)}</div></section>`;
    }).join("");
    const html = `<div class="mc-head"><div><div class="mc-eye">◈ HOME</div><h2>${h(s.name)} · ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</h2></div></div>${toolbar()}<div class="mc-grid">${grid || '<p class="mc-empty">All modules are hidden. Use “Reset layout” or the Hidden list above.</p>'}</div>`;
    if (typeof put === "function") put(root, html); else root.innerHTML = html;
  }
  function act(fn) { cfg.layout = fn(cfg.layout); cfg.preset = ""; save(); render(); }
  function bind() {
    const root = el();
    root.addEventListener("click", (e) => {
      const b = e.target.closest("button,[data-mc-go]"); if (!b) return;
      const w = b.closest("[data-mc-id]"), id = w && w.dataset.mcId;
      if (b.dataset.mcBot) { try { localStorage.setItem("md_bot", b.dataset.mcBot); } catch {} if (typeof BOTS !== "undefined") BOTS.sel = b.dataset.mcBot; }
      if (b.dataset.mcGo) { if (b.dataset.mcSym && typeof openQuote === "function" && b.dataset.mcGo === "research") openQuote(b.dataset.mcSym); else setTab(b.dataset.mcGo); return; }
      if (b.dataset.mcMove && id) return act((l) => C.moveWidget(l, id, b.dataset.mcMove));
      if (b.hasAttribute("data-mc-size") && id) return act((l) => C.resizeWidget(l, id));
      if (b.hasAttribute("data-mc-hide") && id) return act((l) => C.toggleWidget(l, id, true));
      if (b.dataset.mcShow) return act((l) => C.toggleWidget(l, b.dataset.mcShow, false));
      if (b.dataset.mcDensity) { cfg.density = b.dataset.mcDensity; save(); return render(); }
      if (b.id === "mcReset") { cfg.layout = C.defaultLayout(); cfg.preset = ""; save(); return render(); }
      if (b.id === "mcDelPreset") { delete cfg.presets[cfg.preset]; cfg.preset = ""; save(); return render(); }
      if (b.id === "mcExport") { const blob = new Blob([JSON.stringify(D.exportDoc(), null, 1)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `market-desk-personal-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
    });
    root.addEventListener("change", async (e) => {
      if (e.target.id === "mcPf") { cfg.pf = e.target.value; M.shiftDone = false; M.shift = []; save(); M.riskKey = ""; render(); loadRisk(); }
      if (e.target.id === "mcPreset") { const n = e.target.value; if (n && cfg.presets[n]) { cfg.layout = C.normalizeLayout(cfg.presets[n].layout); cfg.density = cfg.presets[n].density || cfg.density; } cfg.preset = n; save(); render(); }
      if (e.target.id === "mcImport" && e.target.files[0]) {
        try { const got = D.importDoc(JSON.parse(await e.target.files[0].text())); if (typeof toast === "function") toast("Restored: " + (got.join(", ") || "nothing")); } catch (x) { if (typeof toast === "function") toast(String(x.message || x)); }
        e.target.value = "";
      }
    });
    root.addEventListener("submit", (e) => {
      if (e.target.id !== "mcSave") return; e.preventDefault();
      const n = document.getElementById("mcPresetName").value.trim().slice(0, 30); if (!n) return;
      cfg.presets = { ...cfg.presets, [n]: { layout: cfg.layout, density: cfg.density } }; cfg.preset = n; save(); render();
    });
    // drag & drop (pointer users); ↑/↓ buttons cover keyboard users
    root.addEventListener("dragstart", (e) => { const w = e.target.closest("[data-mc-id]"); if (!w) return; M.drag = w.dataset.mcId; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", M.drag); } catch {} w.classList.add("dragging"); });
    root.addEventListener("dragover", (e) => { if (M.drag && e.target.closest("[data-mc-id]")) e.preventDefault(); });
    root.addEventListener("drop", (e) => { const w = e.target.closest("[data-mc-id]"); if (!M.drag || !w) return; e.preventDefault(); const to = cfg.layout.findIndex((x) => x.id === w.dataset.mcId), from = M.drag; M.drag = null; if (from !== w.dataset.mcId) act((l) => C.moveWidget(l, from, to)); });
    root.addEventListener("dragend", () => { M.drag = null; root.querySelectorAll(".dragging").forEach((x) => x.classList.remove("dragging")); });
  }
  window.homeOpen = function () {
    if (!M.mounted) { M.mounted = true; bind(); visit(); save(); setInterval(() => { if (S.tab === "home" && !document.hidden) loadBots(); }, 10e3); }
    render(); loadSide(); loadRisk(); loadBots();
  };
  if (S.tab === "home") window.homeOpen(); // the first setTab() ran before this file loaded
  window.homeLive = function () { if (S.tab === "home") { render(); if (!M.riskKey) loadRisk(); } };
})();

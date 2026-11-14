/* Market Desk · Intelligence Studio.
 * An integrated UI over the EXISTING Spider, Backtest, Health and Portfolio engines.
 * Never trades, never calls paid models, never claims a scenario is a forecast. */
(function () {
  "use strict";
  const Core = window.MDStudioCore, STRAT = window.MDStrategyLibrary;
  if (!Core || typeof S === "undefined") return;
  const byId = (s) => document.getElementById(s);
  const clean = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const fmt = (n) => Number.isFinite(n) ? (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—";
  const pct = (n) => Number.isFinite(n) ? (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2) + "%" : "—";
  const age = (t) => { if (!t) return "unknown time"; const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? m + "m ago" : m < 1440 ? (m / 60).toFixed(1) + "h ago" : (m / 1440).toFixed(1) + "d ago"; };
  const link = (url) => typeof url === "string" && /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
  const safeStorage = { get(k, d) { try { const r = JSON.parse(localStorage.getItem(k)); return r == null ? d : r; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
  const LS = { options: "md_studio_opts_v1", seen: "md_studio_seen_v1", events: "md_studio_alerts_v1" };
  const defaults = { price: true, research: true, priceMove: 5, importance: 75, density: "comfortable", color: "cyan", motion: "system" };
  const opts = { ...defaults, ...safeStorage.get(LS.options, {}) };
  const E = { mounted: false, tab: "strategies", pf: null, market: -15, tech: -5, custom: 0, symbol: "NVDA",
    sec: {}, research: [], trader: null, graph: null, focus: null, loading: false, initialized: false, seen: safeStorage.get(LS.seen, {}), events: safeStorage.get(LS.events, []), fetched: 0, graphInfo: "", strategyResults: safeStorage.get("md_studio_strategy_results_v1", {}), strategyBusy: false, strategyHistory: new Map(), strategyAuto: false };
  const SCENARIOS = [
    ["Broad selloff", -20, 0, 0], ["Tech-specific stress", -8, -25, 0],
    ["Single-stock shock", 0, 0, -30], ["Broad rally", 12, 5, 0], ["Reset", 0, 0, 0]
  ];
  function preferences() {
    document.documentElement.dataset.mdDensity = opts.density === "compact" ? "compact" : "comfortable";
    document.documentElement.dataset.mdAccent = opts.color === "amber" ? "amber" : "cyan";
    document.documentElement.dataset.mdMotion = opts.motion === "reduced" ? "reduced" : "system";
    safeStorage.set(LS.options, opts);
  }
  preferences();
  function portfolios() { return Array.isArray(S.pfs) ? S.pfs : []; }
  function activePf() { return portfolios().find((p) => p.id === E.pf) || portfolios().find((p) => p.id === S.pfActive) || portfolios()[0] || null; }
  function tracked() { return [...new Set([...portfolios().flatMap((p) => (p.holdings || []).filter((h) => +h.shares > 0).map((h) => h.symbol)), ...(S.wl || [])])].filter(Boolean); }
  function currentHoldings() { return portfolios().flatMap((p) => p.holdings || []).filter((h) => +h.shares > 0); }
  function menu() {
    const el = byId("tab-studio");
    if (E.mounted && byId("mdsModes")) return;
    E.mounted = true;
    el.innerHTML = `<div class="mds-hero">
      <div class="mds-hero-copy"><div class="mds-eyebrow">◈ THE WEB / RESEARCH OPERATIONS</div>
      <div class="mds-title-line"><h1>Intelligence Studio</h1><span class="mds-beacon" aria-label="Studio ready"></span></div>
      <p>Portfolio intelligence, researched connections and quant strategies in one workspace. All projections are hypothetical and no orders are placed.</p></div>
      <div class="mds-hero-actions" aria-label="Connected terminal tools"><button type="button" data-msgo="web">◉ Spider network</button><button type="button" data-msgo="quant">∑ Quant Lab</button><button type="button" data-msgo="backtest">↗ Backtest Lab</button><button type="button" data-msgo="health">▤ System Health</button></div>
      </div>
      <div class="mds-nav" id="mdsModes" role="tablist" aria-label="Intelligence Studio modules">
        ${[["strategies","Strategies"],["scenario","Shock simulator"],["research","Research bridge"],["graph","Knowledge network"],["quant","Quant audit"],["ask","Ask Spider"],["alerts","Smart alerts"],["settings","Appearance"]].map(([id,n])=>`<button type="button" data-msmode="${id}" role="tab" aria-selected="false">${n}</button>`).join("")}</div>
      <div id="mdsFeedback" class="mds-feedback" aria-live="polite"></div>
      <section id="mdsStrategies" data-mspanel="strategies" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Strategy research lab <span class="mds-section-tag">14 executable models</span></h2>
          <p>Explore different investing rules, then compare their actual historical backtests. Every figure appears only after downloading price data and calculating performance — never from preset sample returns.</p></div>
        <div class="mds-strategy-toolbar"><label for="mdsStrategyFilter">Filter family</label><select class="field" id="mdsStrategyFilter"><option value="all">All models</option><option value="trend">Trend &amp; momentum</option><option value="reversal">Mean reversion &amp; RSI</option><option value="factors">Multi-factor</option><option value="allocation">Portfolio allocation</option></select>
          <button type="button" id="mdsRunSamples" class="mds-strategy-primary">▶ Run 5 examples</button><button type="button" id="mdsRunAll">Run all 14 backtests</button></div>
        <div id="mdsStrategyProgress" class="mds-strategy-progress" role="status" aria-live="polite">Historical results will appear beneath each strategy once calculated.</div>
        <div id="mdsStrategyCards" class="mds-strategy-grid"></div>
        <p class="mds-caption">Same 5-year window, SPY benchmark and $10,000 simulated capital; 5 bps spread, 5 bps slippage, 0 commission, and a 2% cash floor. This is research, not live trading. Survivorship bias and free data availability affect backtest reliability.</p>
      </section>
      <section id="mdsScenario" data-mspanel="scenario" class="mds-panel">
        <div class="mds-intro"><h2>Portfolio shock simulator</h2><p>Test <b>synthetic</b> scenarios, not price predictions or historical replays. P&amp;L is computed from the available quoted positions; missing quotes are excluded and clearly reported.</p></div>
        <div class="mds-controls"><label>Portfolio<select class="field" id="mdsPf"></select></label><label>Single-stock override<input id="mdsSym" class="field" placeholder="NVDA" maxlength="12"></label></div>
        <div class="mds-presets">${SCENARIOS.map((a,i)=>`<button type="button" data-mspreset="${i}">${a[0]}</button>`).join("")}</div>
        <div class="mds-controls mds-sliders">${[["Market","Broad-market shock"],["Tech","Technology-sector extra shock"],["Custom","Selected-stock extra shock"]].map(([k,n])=>`<label>${n}<div class="mds-slide"><input type="range" id="mds${k}" min="-80" max="80" step="1"><output id="mds${k}Val"></output></div></label>`).join("")}</div>
        <div id="mdsScenarioOut" aria-live="polite"></div></section>
      <section id="mdsResearch" data-mspanel="research" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Research → portfolio → trading experiments</h2><p>Spider discoveries are ranked by holdings, importance, source evidence and recency. These are research leads, not trading signals.</p></div>
        <div class="mds-toolbar"><button type="button" id="mdsResearchReload">↻ Refresh research</button><button type="button" data-msgo="aitrade">Inspect paper AI Trader</button><span id="mdsResearchAge"></span></div><div id="mdsResearchOut"></div><div id="mdsTraderOut"></div></section>
      <section id="mdsGraph" data-mspanel="graph" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Knowledge network explorer</h2><p>A focused preview of the existing Spider knowledge graph. Edges show the recorded reason for each connection; this is not a causal model.</p></div>
        <form id="mdsGraphForm" class="mds-toolbar"><label for="mdsFocus">Focus company</label><input id="mdsFocus" class="field" placeholder="NVDA" maxlength="12"><button type="submit">Explore connections</button><button type="button" data-msgo="web">Open full graph</button></form>
        <div id="mdsGraphOut" class="mds-graph" role="group" aria-label="Interactive company relationship graph"></div><p id="mdsGraphDetail" class="mds-graph-detail" aria-live="polite">Select a node or connection to inspect its reason.</p></section>
      <section id="mdsQuant" data-mspanel="quant" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Quant validation audit</h2><p>Read your actual saved Backtest Lab experiments and their assumptions. Validation flags are descriptive, not statistical proof of future returns.</p></div><div class="mds-toolbar"><button type="button" data-msgo="backtest">Run a new backtest</button><button type="button" data-msgo="quant">Open Monte Carlo / factors</button></div><div id="mdsQuantOut"></div></section>
      <section id="mdsAsk" data-mspanel="ask" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Ask the Spider — $0 inference</h2><p>Questions run through your existing <b>rules-based</b> Spider assistant and stored research. Claude is <b>not</b> called; no API key or credits are used. Answers cite available evidence and acknowledge gaps.</p></div>
        <div class="mds-ask-suggestions">${["What are the biggest risks facing my investments?","What has changed about NVDA this month?","What is the spider seeing in the market today?","What is the AI Trader reading from research?"].map((s,i)=>`<button type="button" data-msquestion="${i}">${clean(s)}</button>`).join("")}</div>
        <form id="mdsAskForm" class="mds-ask"><textarea id="mdsQuestion" rows="3" maxlength="600" placeholder="Ask about holdings, companies, filings or market risks…" required></textarea><button type="submit">Research answer</button></form>
        <div id="mdsAskOut" role="status" aria-live="polite"></div></section>
      <section id="mdsAlerts" data-mspanel="alerts" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Explainable smart alerts</h2><p>Alerts are calculated in your browser while the site is open, based on quote changes and new, important Spider findings affecting your holdings. No push service, paid API, background guarantees or automatic trading.</p></div>
        <div class="mds-controls"><label>Daily move threshold (%)<input type="number" id="mdsMove" class="field" min="1" max="50" step="1"></label><label>Spider importance minimum (30–100)<input type="number" id="mdsImp" class="field" min="30" max="100" step="5"></label></div>
        <div class="mds-toolbar"><label><input type="checkbox" id="mdsPriceOn"> Monitor quoted price moves</label><label><input type="checkbox" id="mdsResearchOn"> Monitor important Spider findings</label><button id="mdsAlertClear" type="button">Clear history</button></div>
        <p id="mdsAlertFreshness" class="mds-caption"></p><div id="mdsAlertOut"></div></section>
      <section id="mdsSettings" data-mspanel="settings" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Appearance &amp; workspace</h2><p>Change how the terminal looks on this device without affecting investments or research.</p></div>
        <div class="mds-controls"><label>Information density<select class="field" id="mdsDensity"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
          <label>Accent theme<select class="field" id="mdsAccent"><option value="cyan">Cyber cyan</option><option value="amber">Terminal amber</option></select></label>
          <label>Motion<select class="field" id="mdsMotion"><option value="system">Follow system</option><option value="reduced">Reduced motion</option></select></label></div>
        <div class="mds-settings-note"><span class="mds-settings-symbol">◈</span><div><strong>Visual preferences only</strong><p>Your portfolios, watchlist, saved backtests, research findings and paper-trading controls remain untouched.</p></div></div></section>`;
    el.querySelectorAll("[data-msgo]").forEach((b) => b.onclick = () => { if (typeof setTab === "function") setTab(b.dataset.msgo); });
    byId("mdsModes").onclick = (e) => { const b = e.target.closest("[data-msmode]"); if (b) mode(b.dataset.msmode); };
    byId("mdsStrategyFilter").onchange = renderStrategies;
    byId("mdsRunSamples").onclick = () => runStrategyBatch(5);
    byId("mdsRunAll").onclick = () => runStrategyBatch(14);
    byId("mdsStrategyCards").onclick = (e) => {
      const btn = e.target.closest("[data-ms-strategy], [data-ms-report]");
      if (!btn) return;
      if (btn.dataset.msStrategy) runStrategy(btn.dataset.msStrategy);
      if (btn.dataset.msReport) fullStrategyReport(btn.dataset.msReport);
    };
    byId("mdsPf").onchange = (e) => { E.pf = e.target.value; renderScenario(); };
    byId("mdsSym").onchange = (e) => { E.symbol = String(e.target.value || "").toUpperCase().replace(/[^A-Z0-9.\-]/g,"").slice(0,12); renderScenario(); };
    for (const [k, p] of [["Market","market"],["Tech","tech"],["Custom","custom"]]) byId("mds"+k).oninput = (e) => { E[p] = Number(e.target.value); renderScenario(); };
    el.querySelector(".mds-presets").onclick = (e) => { const b = e.target.closest("[data-mspreset]"); if (!b) return; const p = SCENARIOS[+b.dataset.mspreset]; E.market = p[1]; E.tech = p[2]; E.custom = p[3]; renderScenario(); };
    byId("mdsResearchReload").onclick = () => fetchResearch(true);
    byId("mdsGraphForm").onsubmit = (e) => { e.preventDefault(); E.focus = String(byId("mdsFocus").value || "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g,"").slice(0,12); fetchGraph(); };
    byId("mdsGraphOut").onclick = (e) => { const hit = e.target.closest("[data-msnode], [data-msedge]"); if (!hit) return;
      if (hit.dataset.msnode) { const n = (E.graph && E.graph.nodes || []).find((n) => n.id === hit.dataset.msnode); if (!n) return;
        byId("mdsGraphDetail").textContent = n.label + " — " + (n.sub || n.type) + ". " + (n.id.startsWith("co:") ? "Select Explore connections to center this company." : "Related through stored Spider data.");
        if (n.id.startsWith("co:")) { E.focus = n.id.slice(3); byId("mdsFocus").value = E.focus; fetchGraph(); }
      } else { const n = (E.graph && E.graph.edges || [])[+hit.dataset.msedge]; if (n) byId("mdsGraphDetail").textContent = n.why || "No reason recorded."; } };
    byId("mdsAskForm").onsubmit = (e) => { e.preventDefault(); ask(byId("mdsQuestion").value); };
    const prompts = ["What are the biggest risks facing my investments?","What has changed about NVDA this month?","What is the spider seeing in the market today?","What is the AI Trader reading from research?"];
    el.querySelector(".mds-ask-suggestions").onclick = (e) => { const b = e.target.closest("[data-msquestion]"); if (!b) return; byId("mdsQuestion").value = prompts[+b.dataset.msquestion]; ask(byId("mdsQuestion").value); };
    for (const [id,k] of [["mdsMove","priceMove"],["mdsImp","importance"]]) byId(id).onchange = (e) => { const v = +e.target.value; opts[k] = k === "priceMove" ? Math.max(1, Math.min(50, v || 5)) : Math.max(30, Math.min(100, v || 75)); preferences(); renderAlerts(); };
    for (const [id,k] of [["mdsPriceOn","price"],["mdsResearchOn","research"]]) byId(id).onchange = (e) => { opts[k] = !!e.target.checked; preferences(); renderAlerts(); };
    byId("mdsAlertClear").onclick = () => { E.events = []; safeStorage.set(LS.events, E.events); renderAlerts(); };
    for (const [id,k] of [["mdsDensity","density"],["mdsAccent","color"],["mdsMotion","motion"]]) byId(id).onchange = (e) => { opts[k] = e.target.value; preferences(); };
    byId("mdsDensity").value = opts.density; byId("mdsAccent").value = opts.color; byId("mdsMotion").value = opts.motion;
    byId("mdsMove").value = opts.priceMove; byId("mdsImp").value = opts.importance; byId("mdsPriceOn").checked = opts.price; byId("mdsResearchOn").checked = opts.research;
    mode(E.tab);
  }
  function mode(next) {
    E.tab = next;
    document.querySelectorAll("#mdsModes [data-msmode]").forEach((b) => { const on = b.dataset.msmode === next; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
    document.querySelectorAll("#tab-studio [data-mspanel]").forEach((p) => { p.hidden = p.dataset.mspanel !== next; });
    if (next === "strategies") renderStrategies();
    if (next === "scenario") renderScenario();
    if (next === "research") { renderResearch(); if (Date.now() - E.fetched > 90000) fetchResearch(); }
    if (next === "graph") { if (!E.graph) fetchGraph(); else renderGraph(); }
    if (next === "quant") renderQuant();
    if (next === "alerts") renderAlerts();
  }
  function renderScenario() {
    if (!E.mounted) return;
    const options = portfolios().map((p) => `<option value="${clean(p.id)}"${p.id === (activePf() || {}).id ? " selected" : ""}>${clean(p.name)}</option>`).join("");
    if (byId("mdsPf").innerHTML !== options) byId("mdsPf").innerHTML = options;
    byId("mdsSym").value = E.symbol;
    for (const [k, val] of [["Market",E.market],["Tech",E.tech],["Custom",E.custom]]) { byId("mds"+k).value = val; byId("mds"+k+"Val").textContent = pct(val); }
    const snap = Core.holdings(activePf(), S.quotes, E.sec), res = Core.shockPortfolio(snap, E);
    const out = byId("mdsScenarioOut");
    if (!snap.rows.length) { out.innerHTML = `<p class="mds-empty">No currently priced positions in this portfolio. Open Portfolio to add holdings or let the quotes load.${snap.unpriced.length ? " Missing: " + clean(snap.unpriced.join(", ")) : ""}</p>`; return; }
    const curr = (v) => fmt(v);
    out.innerHTML = `<div class="mds-kpis"><div><small>Priced positions</small><strong>${snap.rows.length} / ${snap.totalPositions}</strong></div><div><small>Quoted exposure</small><strong>${curr(res.before)}</strong></div><div><small>Scenario P&amp;L</small><strong class="${res.pnl < 0 ? "mds-down" : "mds-up"}">${curr(res.pnl)}</strong></div><div><small>Scenario return</small><strong class="${res.pnl < 0 ? "mds-down" : "mds-up"}">${pct(res.pct)}</strong></div></div>
      ${res.partial ? `<p class="mds-warning">Partial result — no valid quote for ${clean(res.unpriced.join(", "))}; excluded from totals. This is not the whole portfolio.</p>` : ""}
      <div class="mds-tablewrap"><table><thead><tr><th>Ticker</th><th>Sector</th><th>Quoted exposure</th><th>Combined shock</th><th>Hypothetical P&amp;L</th></tr></thead><tbody>${res.rows.map((r) => `<tr><td><b>${clean(r.symbol)}</b></td><td>${clean(r.sector)}</td><td>${curr(r.value)}</td><td>${pct(r.shockPct)}</td><td class="${r.pnl < 0 ? "mds-down" : "mds-up"}">${curr(r.pnl)}</td></tr>`).join("")}</tbody></table></div>
      <p class="mds-caption">Combined shock = broad market + technology add-on (if applicable) + selected ticker add-on, floored at −100%. Other sectors receive only the broad-market shock. This is a deterministic what-if, not a beta forecast or a statistical VaR estimate. Open Risk &amp; stress for the historical models.</p>
      <button type="button" class="mds-inline" data-msrisk="1">Open full risk models →</button>`;
    out.querySelector("[data-msrisk]").onclick = () => setTab("risk");
  }
  async function fetchResearch(force) {
    if (E.loading || (Date.now() - E.fetched < 90000 && !force)) return;
    E.loading = true; const syms = tracked().slice(0, 25);
    if (byId("mdsResearchAge")) byId("mdsResearchAge").textContent = "Loading source evidence…";
    try {
      const q = syms.length ? "&symbols=" + encodeURIComponent(syms.join(",")) : "";
      const [d, t] = await Promise.allSettled([
        api("/api/web/discoveries?limit=75&since=" + (Date.now() - 14 * 864e5) + q),
        api("/api/web/trader")
      ]);
      if (d.status === "fulfilled") { E.research = d.value.items || []; E.fetched = Date.now(); }
      else if (byId("mdsResearchAge")) byId("mdsResearchAge").textContent = "Spider research unavailable: " + String(d.reason && d.reason.message || "sign in first");
      if (t.status === "fulfilled") E.trader = t.value;
    } finally { E.loading = false; renderResearch(); scanAlerts(); }
  }
  function renderResearch() {
    if (!E.mounted) return;
    const findings = Core.evidence(E.research, tracked(), Date.now()).slice(0, 30);
    const ageEl = byId("mdsResearchAge"); if (E.fetched && ageEl) ageEl.textContent = "Checked " + age(E.fetched) + " · ranked using saved source evidence";
    const out = byId("mdsResearchOut"); if (!out) return;
    out.innerHTML = findings.length ? `<div class="mds-findings">${findings.map((d) => {
      const url = link(d.verifiedUrl), evidenceKind = d.kind || (d.facts || []).some((f) => f.kind === "fact") ? (d.kind || "mixed") : "interpretation";
      return `<article class="mds-find"><div class="mds-find-meta"><span>${clean(d.cat || "research")}</span><span>${clean(d.evidenceStatus)} · ${d.sourceCount} source(s)</span><span>${age(d.u || d.t)} · importance ${Math.round(+d.importance || 0)}/100</span></div>
        <strong>${clean(d.headline)}</strong><p>${clean(d.summary || "")}</p><div class="mds-find-foot"><span>Related: ${clean(d.matched.join(", ") || "market-wide")}</span><span>Evidence: ${clean(evidenceKind)}</span>${url ? `<a target="_blank" rel="noopener noreferrer" href="${clean(url)}">Original source ↗</a>` : ""}</div></article>`;
    }).join("")}</div>` : '<p class="mds-empty">No recent spider research found for your holdings or watchlist, or the research endpoint is unavailable. THE WEB can start an owner-authorized scan.</p>';
    const trader = E.trader, el = byId("mdsTraderOut"); if (!el) return;
    el.innerHTML = trader ? `<div class="mds-connect"><h3>Spider ↔ paper AI Trader</h3><p>${clean(trader.explain || "")}</p><p><b>${trader.weight > 0 ? "Research weighting enabled (" + trader.weight + ")" : "Research display-only; scoring weight 0"}.</b> Last sync: ${trader.at ? age(trader.at) : "not available"}. The Spider never sends real orders.</p><button type="button" data-msgo2="aitrade">Inspect actual paper trades →</button></div>` : "";
    const b=el.querySelector("[data-msgo2]"); if (b) b.onclick=()=>setTab("aitrade");
  }
  async function fetchGraph() {
    const out=byId("mdsGraphOut"); if (!out) return;
    out.innerHTML = '<p class="mds-empty">Loading graph recorded by the Spider…</p>';
    const focus = E.focus || (activePf() && (activePf().holdings || []).find((h) => +h.shares > 0)?.symbol) || (S.wl || [])[0] || "";
    E.focus = focus; byId("mdsFocus").value = focus;
    try { E.graph = await api("/api/web/graph" + (focus ? "?focus=" + encodeURIComponent("co:" + focus) : "")); renderGraph(); }
    catch (e) { out.innerHTML = '<p class="mds-empty">The graph is unavailable: ' + clean(e.message || "Spider not connected") + '.</p>'; }
  }
  function renderGraph() {
    const host = byId("mdsGraphOut"); if (!host || !E.graph) return;
    const data = E.graph, nodes = (data.nodes || []).slice(0, 28), centerId = "co:" + (E.focus || "");
    const center = nodes.find((n) => n.id === centerId) || nodes[0];
    if (!center) { host.innerHTML='<p class="mds-empty">No source-linked network data yet. Let THE WEB research your holdings first.</p>'; return; }
    const others = nodes.filter((n) => n !== center);
    const coord = { [center.id]: [450,220] };
    others.forEach((n, i) => { const a = 2 * Math.PI * i / Math.max(1, others.length) - Math.PI/2;
      const ring = i % 3 === 0 ? 165 : i % 3 === 1 ? 260 : 205;
      coord[n.id] = [450 + Math.cos(a)*ring*1.4,220+Math.sin(a)*ring*.77]; });
    const edges = (data.edges || []).filter((e) => coord[e.a] && coord[e.b]).slice(0,110);
    const typedColor = { portfolio:"#d7abef", holding:"#45e7b5", watch:"#f9b849", company:"#7dd3fc", sector:"#61a1ff", industry:"#8f9db0", discovery:"#ed709a", macro:"#aaa4ff", trader:"#ffa773", event:"#f5d36a" };
    host.innerHTML = `<svg viewBox="0 0 900 440" role="img" aria-label="Source-linked graph centered on ${clean(center.label)}" preserveAspectRatio="xMidYMid meet">
      <defs><radialGradient id="mdsGlow"><stop stop-color="#32d9d6" stop-opacity=".20"/><stop offset="1" stop-color="#32d9d6" stop-opacity="0"/></radialGradient></defs>
      <circle cx="450" cy="220" r="175" fill="url(#mdsGlow)"/>
      ${edges.map((e,i)=>`<line data-msedge="${(data.edges || []).indexOf(e)}" x1="${coord[e.a][0]}" y1="${coord[e.a][1]}" x2="${coord[e.b][0]}" y2="${coord[e.b][1]}" stroke="#4f728a" stroke-opacity=".45" stroke-width="1.8"><title>${clean(e.why || e.type)}</title></line>`).join("")}
      ${nodes.map((n)=>{const [x,y]=coord[n.id];return `<g data-msnode="${clean(n.id)}" tabindex="0" role="button" aria-label="${clean(n.label)}" style="cursor:pointer"><circle cx="${x}" cy="${y}" r="${n===center?21:10}" fill="${typedColor[n.type] || "#8aafc4"}" fill-opacity=".82" stroke="#10151b" stroke-width="2"/><text x="${x}" y="${y+(n===center?39:25)}" fill="#dfe7f0" font-size="${n===center?17:12}" font-family="sans-serif" text-anchor="middle">${clean(n.label).slice(0,26)}</text><title>${clean(n.sub || n.type)}</title></g>`;}).join("")}
      </svg><p class="mds-caption">${nodes.length} visible nodes / ${edges.length} visible links. Tap any node; links have an evidence reason. Open THE WEB for the full interactive network.</p>`;
    host.querySelectorAll("[data-msnode]").forEach((n)=>n.onkeydown=(e)=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();n.click();}});
  }
  function renderQuant() {
    const host=byId("mdsQuantOut");if (!host) return;
    let runs=[];try {runs=JSON.parse(localStorage.getItem("md_qb_runs") || "[]");}catch{}
    if(!Array.isArray(runs))runs=[];
    host.innerHTML = runs.length ? `<div class="mds-findings">${runs.slice(0,8).map((r)=>{
      const v=Core.validateBacktest(r);
      return `<article class="mds-find"><div class="mds-find-meta"><span>${clean(r.kind || "backtest")}</span><span>${clean(r.from || "?")} → ${clean(r.to || "?")}</span></div>
        <strong>${clean(r.strategy || "Saved strategy")}</strong><p>${clean(r.universe || "")}</p>
        <div class="mds-metrics"><span>CAGR <b>${pct(Number(r.cagr)*100)}</b></span><span>Sharpe <b>${Number.isFinite(r.sharpe)?r.sharpe.toFixed(2):"—"}</b></span><span>Max DD <b>${pct(Number(r.mdd)*100)}</b></span></div>
        <ul>${v.reasons.map((s)=>`<li>${clean(s)}</li>`).join("")}</ul></article>`;
      }).join("")}</div>` : '<p class="mds-empty">No saved strategy experiments on this device. The existing Backtest Lab already supports trading costs, walk-forward and out-of-sample evaluation; run an experiment there to populate this audit.</p>';
  }
  async function ask(question) {
    const out=byId("mdsAskOut"); if(!out) return;
    const q=String(question || "").trim().slice(0,600); if (!q) return;
    out.textContent="Spider is checking saved research and citations…";
    try{
      const r=await api("/api/web/ask",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question:q,useClaude:false})});
      out.innerHTML = '<div class="mds-answer"><h3>Spider research answer <small>rules-based · $0 model cost</small></h3><pre id="mdsAnswerText"></pre><div id="mdsAnswerCites"></div></div>';
      byId("mdsAnswerText").textContent=r.answer || "No sourced answer available.";
      const c=byId("mdsAnswerCites");
      if(r.citations && r.citations.length)c.innerHTML='<h4>Evidence cited</h4>'+r.citations.slice(0,12).map((d,i)=>`<div class="mds-cite">[${i+1}] ${clean(d.headline || d.title || d.id || "Finding")}${(d.sources||[]).filter((s)=>link(s.url)).slice(0,2).map((s)=>` · <a href="${clean(s.url)}" target="_blank" rel="noopener noreferrer">${clean(s.name)}</a>`).join("")}</div>`).join("");
      else c.innerHTML='<p class="mds-caption">No cited research in the response. Treat the answer as a statement of insufficient evidence.</p>';
    }catch(e){out.innerHTML='<p class="mds-warning">'+clean(e.message || "Spider unavailable; check System Health")+'</p>';}
  }
  function scanAlerts() {
    if (document.hidden || !E.initialized || (window.__VISITOR || (typeof VIEW !== "undefined" && VIEW))) return;
    const newEvents=Core.alerts({holdings:currentHoldings(),discoveries:E.research,quotes:S.quotes,preferences:opts,lastSeen:E.seen,now:Date.now(),quoteAt:S.lastOk});
    E.seen=newEvents.lastSeen;safeStorage.set(LS.seen,E.seen);
    if(newEvents.events.length){
      E.events=[...newEvents.events,...E.events].slice(0,80);
      safeStorage.set(LS.events,E.events);
      if(typeof toast==="function" && Date.now()-(E.toastAt||0)>10*60e3){E.toastAt=Date.now();toast("◈ Intelligence Studio: "+newEvents.events[0].title);}
    }
    if(E.mounted)renderAlerts();
  }
  function renderAlerts() {
    const host=byId("mdsAlertOut"); if(!host) return;
    byId("mdsAlertFreshness").textContent = Core.freshness(S.lastOk,Date.now()).label + " (terminal fetch, not exchange timestamp). Alerts run only while this browser is open; no guaranteed 24/7 monitoring.";
    host.innerHTML=E.events.length ? `<div class="mds-findings">${E.events.slice(0,45).map((a)=>`<article class="mds-find"><div class="mds-find-meta"><span>${clean(a.kind)}</span><span>${age(a.time)}</span></div><strong>${clean(a.title)}</strong><p>${clean(a.detail || "")}</p>${a.symbol?`<button type="button" data-mssym="${clean(a.symbol)}">Research ${clean(a.symbol)} →</button>`:""}</article>`).join("")}</div>` : '<p class="mds-empty">No alerts have been recorded on this device. Configure thresholds above; only new qualifying events are logged.</p>';
    host.querySelectorAll("[data-mssym]").forEach((b)=>b.onclick=()=>{if(typeof openQuote==="function")openQuote(b.dataset.mssym);else setTab("research");});
  }
  window.studioOpen=function(){
    menu();E.initialized=true;
    if (!E.pf) E.pf=S.pfActive;
    if (!E.focus) E.focus=(activePf() && (activePf().holdings || []).find((h)=>+h.shares>0)?.symbol) || (S.wl || [])[0] || "NVDA";
    mode(E.tab);
    if (E.tab === "strategies") firstStrategyExamples();
    if (!Object.keys(E.sec).length) fetch("/sp500.json").then((r)=>r.json()).then((j)=>{E.sec=Object.fromEntries((j.rows||[]).map((r)=>[r[0],r[2]]));renderScenario();}).catch(()=>{});
    if(Date.now()-E.fetched>90000)fetchResearch();
    scanAlerts();
  };
  // Browser-open monitoring, throttled; no notifications or external scheduling.
  E.initialized=true;
  const check=async()=>{if(document.hidden||window.__VISITOR||(typeof VIEW!=="undefined"&&VIEW))return;
    if(Date.now()-E.fetched>3*60e3)await fetchResearch();else scanAlerts();};
  setInterval(check,3*60e3);
  // Delay first poll so normal startup loads prices before attempting an alert check.
  setTimeout(check,16e3);
  if(S.tab==="studio")window.studioOpen();
})();

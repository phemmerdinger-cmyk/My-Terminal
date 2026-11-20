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
  const defaults = { price: true, research: true, priceMove: 5, importance: 75, density: "comfortable", color: "amber", motion: "system" };
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
    if (E.mounted && byId("mdsStrategies")) return;
    E.mounted = true;
    // Render only the selected tool within its destination section; no stand-alone Intelligence hub.
    el.innerHTML = `<div id="mdsFeedback" class="mds-feedback" aria-live="polite"></div>
      <section id="mdsStrategies" data-mspanel="strategies" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Strategy Research Lab <span class="mds-section-tag">14 executable models</span></h2>
          <p>Explore different investing rules, then compare their actual historical backtests. Every figure appears only after downloading price data and calculating performance — never from preset sample returns.</p></div>
        <div class="mds-strategy-toolbar"><label for="mdsStrategyFilter">Filter family</label><select class="field" id="mdsStrategyFilter"><option value="all">All models</option><option value="trend">Trend &amp; momentum</option><option value="reversal">Mean reversion &amp; RSI</option><option value="factors">Multi-factor</option><option value="allocation">Portfolio allocation</option></select>
          <button type="button" id="mdsRunSamples" class="mds-strategy-primary">▶ Run 5 examples</button><button type="button" id="mdsRunAll">Run all 14 backtests</button></div>
        <div id="mdsStrategyProgress" class="mds-strategy-progress" role="status" aria-live="polite">Historical results will appear beneath each strategy once calculated.</div>
        <div id="mdsStrategyCards" class="mds-strategy-grid"></div>
        <p class="mds-caption">Same 5-year window, SPY benchmark and $10,000 simulated capital; 5 bps spread, 5 bps slippage, 0 commission, and a 2% cash floor. This is research, not live trading. Survivorship bias and free data availability affect backtest reliability.</p>
      </section>
      <section id="mdsScenario" data-mspanel="scenario" class="mds-panel">
        <div class="mds-intro"><h2>Portfolio Shock Simulator</h2><p>Test <b>synthetic</b> scenarios, not price predictions or historical replays. P&amp;L is computed from the available quoted positions; missing quotes are excluded and clearly reported.</p></div>
        <div class="mds-controls"><label>Portfolio<select class="field" id="mdsPf"></select></label><label>Single-stock override<input id="mdsSym" class="field" placeholder="NVDA" maxlength="12"></label></div>
        <div class="mds-presets">${SCENARIOS.map((a,i)=>`<button type="button" data-mspreset="${i}">${a[0]}</button>`).join("")}</div>
        <div class="mds-controls mds-sliders">${[["Market","Broad-market shock"],["Tech","Technology-sector extra shock"],["Custom","Selected-stock extra shock"]].map(([k,n])=>`<label>${n}<div class="mds-slide"><input type="range" id="mds${k}" min="-80" max="80" step="1"><output id="mds${k}Val"></output></div></label>`).join("")}</div>
        <div id="mdsScenarioOut" aria-live="polite"></div></section>
      <section id="mdsResearch" data-mspanel="research" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Market Intelligence</h2><p>Company and market research ranked by portfolio relevance, evidence quality, impact and freshness. Findings inform research, not automatic trade decisions.</p></div>
        <div class="mds-toolbar"><button type="button" id="mdsResearchReload">↻ Refresh research</button><button type="button" data-msgo="aitrade">Inspect paper AI Trader</button><span id="mdsResearchAge"></span></div><div id="mdsResearchOut"></div><div id="mdsTraderOut"></div></section>
      <section id="mdsGraph" data-mspanel="graph" class="mds-panel" hidden><div id="mdcHost"></div></section>
      <section id="mdsQuant" data-mspanel="quant" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Quant Validation Audit</h2><p>Read your actual saved Backtest Lab experiments and their assumptions. Validation flags are descriptive, not statistical proof of future returns.</p></div><div class="mds-toolbar"><button type="button" data-msgo="backtest">Run a new backtest</button><button type="button" data-msgo="quant">Open Monte Carlo / factors</button></div><div id="mdsQuantOut"></div></section>
      <section id="mdsAsk" data-mspanel="ask" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Market Research Assistant</h2><p>Ask questions about market developments, holdings, or financial research using available source-linked evidence. This assistant is <b>rules-based</b>, not a paid AI model; Claude is not called and the feature costs $0 in model usage.</p></div>
        <div class="mds-ask-suggestions">${["What are the biggest risks facing my investments?","What has changed about NVDA this month?","What major risks are emerging in the market today?","What is the AI Trader reading from research?"].map((s,i)=>`<button type="button" data-msquestion="${i}">${clean(s)}</button>`).join("")}</div>
        <form id="mdsAskForm" class="mds-ask"><textarea id="mdsQuestion" rows="3" maxlength="600" placeholder="Ask about holdings, companies, filings or market risks…" required></textarea><button type="submit">Research answer</button></form>
        <div id="mdsAskOut" role="status" aria-live="polite"></div></section>
      <section id="mdsAlerts" data-mspanel="alerts" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Smart Alerts</h2><p>Alerts are calculated in your browser while the site is open, based on quote changes and new, important market research affecting your holdings. No push service, paid API, background guarantees or automatic trading.</p></div>
        <div class="mds-controls"><label>Daily move threshold (%)<input type="number" id="mdsMove" class="field" min="1" max="50" step="1"></label><label>Research importance minimum (30–100)<input type="number" id="mdsImp" class="field" min="30" max="100" step="5"></label></div>
        <div class="mds-toolbar"><label><input type="checkbox" id="mdsPriceOn"> Monitor quoted price moves</label><label><input type="checkbox" id="mdsResearchOn"> Monitor important market findings</label><button id="mdsAlertClear" type="button">Clear history</button></div>
        <p id="mdsAlertFreshness" class="mds-caption"></p><div id="mdsAlertOut"></div></section>
      <section id="mdsSettings" data-mspanel="settings" class="mds-panel" hidden>
        <div class="mds-intro"><h2>Appearance &amp; Workspace</h2><p>Change how the terminal looks on this device without affecting investments or research.</p></div>
        <div class="mds-controls"><label>Information density<select class="field" id="mdsDensity"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
          <label>Accent theme<select class="field" id="mdsAccent"><option value="amber">Black &amp; orange</option><option value="cyan">Legacy cyber cyan</option></select></label>
          <label>Motion<select class="field" id="mdsMotion"><option value="system">Follow system</option><option value="reduced">Reduced motion</option></select></label></div>
        <div class="mds-settings-note"><span class="mds-settings-symbol">◈</span><div><strong>Visual preferences only</strong><p>Your portfolios, watchlist, saved backtests, research findings and paper-trading controls remain untouched.</p></div></div></section>`;
    el.querySelectorAll("[data-msgo]").forEach((b) => b.onclick = () => { if (typeof setTab === "function") setTab(b.dataset.msgo); });
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
    byId("mdsAskForm").onsubmit = (e) => { e.preventDefault(); ask(byId("mdsQuestion").value); };
    const prompts = ["What are the biggest risks facing my investments?","What has changed about NVDA this month?","What major risks are emerging in the market today?","What is the AI Trader reading from research?"];
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
    document.querySelectorAll("#tab-studio [data-mspanel]").forEach((p) => { p.hidden = p.dataset.mspanel !== next; });
    if (next === "strategies") renderStrategies();
    if (next === "scenario") renderScenario();
    if (next === "research") { renderResearch(); if (Date.now() - E.fetched > 90000) fetchResearch(); }
    if (next === "graph" && window.MDMarketCharts) window.MDMarketCharts.open();
    if (next === "quant") renderQuant();
    if (next === "alerts") renderAlerts();
  }

  // Source-linked, actually computed backtests. No embedded or random performance claims.
  const STRATEGY_STORAGE = "md_studio_strategy_results_v1";
  const STRATEGY_INITIAL = "md_studio_strategy_autorun_v1";
  function strategyNum(n, digits=1) { return Number.isFinite(n) ? (n >= 0 ? "+" : "−") + Math.abs(n * 100).toFixed(digits) + "%" : "—"; }
  function strategyCurve(points) {
    if (!Array.isArray(points) || points.length < 2 || !points.every((n)=>Number.isFinite(n) && n > 0)) return "";
    const lo=Math.min(...points),hi=Math.max(...points),delta=Math.max(.0001,hi-lo);
    const d=points.map((v,i)=>(i ? "L" : "M") + (i/(points.length-1)*288).toFixed(1) + " " + (70-60*(v-lo)/delta).toFixed(1)).join(" ");
    const rising=points[points.length-1]>=points[0];
    return '<svg class="mds-sparkline" viewBox="0 0 288 80" preserveAspectRatio="none" role="img" aria-label="Historical simulated equity path"><path d="' + d + '" stroke="' + (rising?"#4de5b0":"#ff808e") + '" fill="none" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
  }
  function renderStrategies() {
    const host=byId("mdsStrategyCards"); if (!host || !STRAT) return;
    const filter=byId("mdsStrategyFilter").value;
    const list=STRAT.CATALOG.filter((x)=>filter==="all"||x.category===filter);
    const state=E.strategyResults || {};
    host.innerHTML = list.map((item) => {
      const r=state[item.id], ok=r && r.status==="done" && r.result && r.to===STRAT.makeSpec(item).to;
      const error=r && r.status==="error", busy=r && r.status==="running" && E.strategyBusy;
      return `<article class="mds-strategy-card"><div class="mds-strategy-top"><span class="mds-strategy-family">${clean(item.category)}</span><span class="mds-strategy-state ${ok?"is-done":error?"is-error":""}">${ok?"✓ HISTORICAL":error?"DATA UNAVAILABLE":busy?"CALCULATING":"NOT RUN"}</span></div>
        <h3>${clean(item.title)}</h3><p>${clean(item.summary)}</p>
        <div class="mds-strategy-rule"><span>ENTRY / ALLOCATION RULE</span><strong>${clean(item.trigger)}</strong></div>
        <p class="mds-strategy-universe">Universe: ${clean(item.universe.join(" · "))}</p>
        ${ok ? `<div class="mds-strategy-numbers"><div><small>Total return</small><b class="${r.result.totalReturn>=0?"mds-up":"mds-down"}">${strategyNum(r.result.totalReturn)}</b></div>
        <div><small>CAGR</small><b>${strategyNum(r.result.cagr)}</b></div><div><small>Sharpe</small><b>${Number.isFinite(r.result.sharpe)?r.result.sharpe.toFixed(2):"—"}</b></div>
        <div><small>Max drawdown</small><b class="mds-down">${strategyNum(r.result.maxDrawdown)}</b></div></div>
        ${strategyCurve(r.result.curve)}
        <p class="mds-strategy-computed">Ending value ${fmt(r.result.finalValue)} · ${r.result.trades} orders · ${age(r.at)}</p>` :
         error ? `<p class="mds-warning">${clean(r.error || "Missing historical prices.")}</p>` :
         '<div class="mds-strategy-no-result">Run to calculate real historical returns.</div>'}
        <div class="mds-strategy-actions"><button type="button" data-ms-strategy="${clean(item.id)}" ${E.strategyBusy?"disabled":""}>${ok?"↻ Recalculate":"▶ Run backtest"}</button>
        <button type="button" data-ms-report="${clean(item.id)}" ${E.strategyBusy?"disabled":""}>${ok?"Full report ↗":"Open in Backtest Lab ↗"}</button></div>
      </article>`;
    }).join("");
    const progress=byId("mdsStrategyProgress");
    if(progress && !E.strategyBusy){
      const num=STRAT.CATALOG.filter((item)=>state[item.id]&&state[item.id].status==="done"&&state[item.id].to===STRAT.makeSpec(item).to).length;
      progress.textContent=num+" of "+STRAT.CATALOG.length+" strategy examples have actual historical results on this device. This is a fixed five-year backtest, not a live trading signal.";
    }
    for(const id of ["mdsRunSamples","mdsRunAll"]){const b=byId(id);if(b)b.disabled=E.strategyBusy;}
  }
  async function strategyHistory(spec) {
    if (!window.MD || typeof window.MD.hist!=="function") throw new Error("Free historical-price provider is not available");
    const pad = new Date(Date.parse(spec.from + "T00:00:00Z") - 420*864e5).toISOString().slice(0,10);
    const symbols=[...new Set([...spec.universe,spec.benchmark])], data={}, failures=[];
    for(let i=0;i<symbols.length;i+=3)await Promise.all(symbols.slice(i,i+3).map(async (sym)=>{
      const key=sym+"|"+pad+"|"+spec.to;
      try {
        if(!E.strategyHistory.has(key)){
          const h=await window.MD.hist(sym,pad,spec.to);
          if(!Array.isArray(h.t)||h.t.length<252||!Array.isArray(h.close)||h.close.length!==h.t.length)
            throw new Error("insufficient historical observations");
          E.strategyHistory.set(key,{t:h.t,close:h.close,adj:h.adj});
        }
        data[sym]=E.strategyHistory.get(key);
      } catch(e){failures.push(sym+": "+String(e.message||e).slice(0,80));}
    }));
    if(failures.length)throw new Error("History unavailable for "+failures.join("; ")+". No partial-performance substitution.");
    return data;
  }
  function saveStrategyResult(item, r, spec) {
    const m=r.metrics;
    const take=35,curve=[];
    for(let i=0;i<take;i++) curve.push(r.equity[Math.round(i*(r.equity.length-1)/(take-1))]);
    E.strategyResults[item.id]={status:"done",at:Date.now(),from:spec.from,to:spec.to,
      result:{totalReturn:m.totalReturn,cagr:m.cagr,sharpe:m.sharpe,maxDrawdown:m.maxDrawdown,finalValue:m.finalValue,
        trades:r.trades.length,curve,benchmarkReturn:r.benchMetrics.totalReturn}};
    safeStorage.set(STRATEGY_STORAGE,E.strategyResults);
    try {
      const runs=JSON.parse(localStorage.getItem("md_qb_runs")||"[]");
      if(Array.isArray(runs)){
        const existing=runs.filter(x=>!(x.studioId===item.id && x.to===spec.to));
        existing.unshift({at:Date.now(),kind:"backtest",strategy:item.title,studioId:item.id,title:item.title,
          universe:spec.universe.join(", "),params:Object.entries(spec.params).map(([k,v])=>k+" "+v).join(", "),
          from:spec.from,to:spec.to,costs:spec.costs,cagr:m.cagr,sharpe:m.sharpe,
          mdd:m.maxDrawdown,vol:m.vol,var95:m.var95});
        localStorage.setItem("md_qb_runs",JSON.stringify(existing.slice(0,25)));
      }
    }catch{}
  }
  async function computeStrategy(item) {
    const spec=STRAT.makeSpec(item), now=Date.now();
    E.strategyResults[item.id]={status:"running",at:now,to:spec.to};
    renderStrategies();
    try {
      const series=await strategyHistory(spec);
      const result=window.QUANT.run({...spec,series,from:Date.parse(spec.from+"T00:00:00Z")/1000,to:Date.parse(spec.to+"T23:59:59Z")/1000});
      if(!result||result.dates.length<252||!Number.isFinite(result.metrics.finalValue)||!Number.isFinite(result.metrics.cagr))
        throw new Error("Insufficient data or non-finite performance; results not saved.");
      saveStrategyResult(item,result,spec);
      return true;
    }catch(e){
      E.strategyResults[item.id]={status:"error",at:Date.now(),to:spec.to,error:String(e.message||e).slice(0,240)};
      safeStorage.set(STRATEGY_STORAGE,E.strategyResults);
      return false;
    }finally{renderStrategies();}
  }
  async function runStrategy(id) {
    if(!STRAT || E.strategyBusy)return;
    const item=STRAT.CATALOG.find(x=>x.id===id);if(!item)return;
    E.strategyBusy=true;
    try{
      const status=byId("mdsStrategyProgress");
      if(status) status.textContent="Calculating "+item.title+" from real historical data…";
      await computeStrategy(item);
    }finally{E.strategyBusy=false;renderStrategies();}
  }
  async function runStrategyBatch(count) {
    if(!STRAT || E.strategyBusy || window.__VISITOR || (typeof VIEW!=="undefined"&&VIEW))return;
    E.strategyBusy=true;
    try{
      const list=STRAT.CATALOG.slice(0,count), status=byId("mdsStrategyProgress");let done=0,failed=0;
      for(let i=0;i<list.length;i++){
        if(status)status.textContent="Calculating real backtests: "+(i+1)+" / "+list.length+" · "+list[i].title+"…";
        // Allow progress to paint between potentially expensive CPU simulations.
        await new Promise(r=>setTimeout(r,20));
        if(await computeStrategy(list[i]))done++;else failed++;
      }
      if(status)status.textContent="Finished "+done+" historical backtests"+(failed?" · "+failed+" could not load required data":"")+". Every successful result was saved on this device.";
    }finally{E.strategyBusy=false;renderStrategies();}
  }
  function fullStrategyReport(id) {
    if(!STRAT||E.strategyBusy)return;
    const item=STRAT.CATALOG.find(x=>x.id===id);if(!item)return;
    try{sessionStorage.setItem("md_qb_pending_spec_v1",JSON.stringify(STRAT.makeSpec(item)));}
    catch{return toast("Unable to pass the strategy to Backtest Lab on this device.");}
    setTab("backtest");
  }
  function firstStrategyExamples() {
    if(E.strategyAuto||!STRAT||window.__VISITOR||(typeof VIEW!=="undefined"&&VIEW))return;
    E.strategyAuto=true;
    let completed=false;
    try{completed=!!localStorage.getItem(STRATEGY_INITIAL);}catch{return;}
    if(completed)return;
    try{localStorage.setItem(STRATEGY_INITIAL,String(Date.now()));}catch{return;}
    setTimeout(()=>{if(S.tab==="studio-strategies"&&E.tab==="strategies")runStrategyBatch(5);},350);
  }

  function renderScenario() {
    if (!E.mounted) return;
    const options = portfolios().map((p) => `<option value="${clean(p.id)}"${p.id === (activePf() || {}).id ? " selected" : ""}>${clean(p.name)}</option>`).join("");
    if (byId("mdsPf").innerHTML !== options) byId("mdsPf").innerHTML = options;
    byId("mdsSym").value = E.symbol;
    for (const [k, val] of [["Market",E.market],["Tech",E.tech],["Custom",E.custom]]) { byId("mds"+k).value = val; byId("mds"+k+"Val").textContent = pct(val); }
    const snap = Core.holdings(activePf(), S.quotes, E.sec), res = Core.shockPortfolio(snap, E);
    const out = byId("mdsScenarioOut");
    if (!snap.rows.length) { out.innerHTML = `<p class="mds-empty">No currently priced positions in this portfolio. Add holdings or let prices load.${snap.unpriced.length ? " Missing: " + clean(snap.unpriced.join(", ")) : ""}</p>
      <div class="mds-example-panel"><h4>Illustrative scenario: a 12% market decline</h4><p>A purely hypothetical $10,000 equity portfolio exposed to a uniform −12% shock would lose $1,200 and finish at $8,800. This is an arithmetic example, <b>not</b> your holdings or a market prediction.</p>
      <div class="mds-examples"><button type="button" data-msdemo-pf>Open my portfolio</button></div></div>`;
      const b=out.querySelector("[data-msdemo-pf]");if(b)b.onclick=()=>setTab("portfolio");
      return; }
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
      else if (byId("mdsResearchAge")) byId("mdsResearchAge").textContent = "Market intelligence unavailable: " + String(d.reason && d.reason.message || "sign in first");
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
    }).join("")}</div>` : '<p class="mds-empty">No recent source-linked market findings for this watchlist yet. This view never invents research.</p><div class="mds-example-panel"><h4>Research examples to try</h4><p>Compare NVDA, AMD or JPM with market benchmarks in Market Charts. These are suggested research questions, not findings.</p><div class="mds-examples"><button type="button" data-ms-example-web>Open Market Charts →</button></div></div>';
    const exampleButton=out.querySelector("[data-ms-example-web]");if(exampleButton)exampleButton.onclick=()=>setTab("studio-graph");
    const trader = E.trader, el = byId("mdsTraderOut"); if (!el) return;
    el.innerHTML = trader ? `<div class="mds-connect"><h3>Market Intelligence ↔ Paper AI Trader</h3><p>${clean(trader.explain || "")}</p><p><b>${trader.weight > 0 ? "Research weighting enabled (" + trader.weight + ")" : "Research display-only; scoring weight 0"}.</b> Last sync: ${trader.at ? age(trader.at) : "not available"}. Research never sends real orders.</p><button type="button" data-msgo2="aitrade">Inspect actual paper trades →</button></div>` : "";
    const b=el.querySelector("[data-msgo2]"); if (b) b.onclick=()=>setTab("aitrade");
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
      }).join("")}</div>` : '<p class="mds-empty">No saved quant experiments on this device yet. Performance metrics appear here only after a real historical simulation runs.</p><div class="mds-example-panel"><h4>Start with a tested model</h4><p>Example: compare six-month momentum, 50/200-day trend following and RSI 30/55. Each is already implemented in the strategy library.</p><div class="mds-examples"><button type="button" data-ms-example-strategies>Open 14 strategies →</button></div></div>';
    const starter=host.querySelector("[data-ms-example-strategies]");if(starter)starter.onclick=()=>setTab("studio-strategies");
  }
  async function ask(question) {
    const out=byId("mdsAskOut"); if(!out) return;
    const q=String(question || "").trim().slice(0,600); if (!q) return;
    out.textContent="Spider is checking saved research and citations…";
    try{
      const r=await api("/api/web/ask",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question:q,useClaude:false})});
      out.innerHTML = '<div class="mds-answer"><h3>Research Answer <small>rules-based · $0 model cost</small></h3><pre id="mdsAnswerText"></pre><div id="mdsAnswerCites"></div></div>';
      byId("mdsAnswerText").textContent=r.answer || "No sourced answer available.";
      const c=byId("mdsAnswerCites");
      if(r.citations && r.citations.length)c.innerHTML='<h4>Evidence Cited</h4>'+r.citations.slice(0,12).map((d,i)=>`<div class="mds-cite">[${i+1}] ${clean(d.headline || d.title || d.id || "Finding")}${(d.sources||[]).filter((s)=>link(s.url)).slice(0,2).map((s)=>` · <a href="${clean(s.url)}" target="_blank" rel="noopener noreferrer">${clean(s.name)}</a>`).join("")}</div>`).join("");
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
    host.innerHTML=E.events.length ? `<div class="mds-findings">${E.events.slice(0,45).map((a)=>`<article class="mds-find"><div class="mds-find-meta"><span>${clean(a.kind)}</span><span>${age(a.time)}</span></div><strong>${clean(a.title)}</strong><p>${clean(a.detail || "")}</p>${a.symbol?`<button type="button" data-mssym="${clean(a.symbol)}">Research ${clean(a.symbol)} →</button>`:""}</article>`).join("")}</div>` : '<p class="mds-empty">No alerts recorded yet. Nothing has crossed the configured thresholds while this browser was monitoring.</p><div class="mds-example-panel"><h4>Example alert settings</h4><p>Price move: 3% daily change on a currently updated holding. Spider discovery: importance 80/100 or higher on an owned ticker. This does not create sample alerts.</p><div class="mds-examples"><button type="button" data-ms-alert-example>Use these thresholds</button></div></div>';
    host.querySelectorAll("[data-mssym]").forEach((b)=>b.onclick=()=>{if(typeof openQuote==="function")openQuote(b.dataset.mssym);else setTab("research");});
    const example=host.querySelector("[data-ms-alert-example]");if(example)example.onclick=()=>{opts.priceMove=3;opts.importance=80;byId("mdsMove").value=3;byId("mdsImp").value=80;preferences();renderAlerts();};
  }
  window.studioSelectMode=function(next){menu();if(["strategies","scenario","research","graph","quant","ask","alerts","settings"].includes(next))mode(next);};
  window.studioOpen=function(){
    menu();E.initialized=true;
    if (!E.pf) E.pf=S.pfActive;
    if (!E.focus) E.focus=(activePf() && (activePf().holdings || []).find((h)=>+h.shares>0)?.symbol) || (S.wl || [])[0] || "NVDA";
    mode(E.tab);
    // Strategy runs are manual, so loading another section never starts backtests.
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
  if(window.STUDIO_ROUTES && window.STUDIO_ROUTES[S.tab]) { window.studioOpen(); window.studioSelectMode(window.STUDIO_ROUTES[S.tab]); }
  else if(S.tab && S.tab.startsWith("studio-")) { const p=S.tab.slice(7); window.studioOpen(); window.studioSelectMode(p); }
})();

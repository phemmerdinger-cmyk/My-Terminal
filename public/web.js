/* THE WEB — dashboard for the autonomous research Spider.
   Everything shown here comes from the server's real research jobs (/api/web/*). Nothing is simulated:
   the spider's animation follows the phase of the job actually running, and an empty state says it's empty. */
(function () {
  if (typeof VIEW !== "undefined" && VIEW) return; // the public demo doesn't get THE WEB (it holds the owner's research)
  const W = { open: false, poll: null, navPoll: null, st: null, stAt: 0, offline: false, brief: null, histOpen: false, hist: null,
    feed: { group: "all", mine: false, min: 0, q: "", sort: "latest", sig: "", seen: null }, graph: null, sel: null, chat: [], busy: false,
    ctxSent: "", ctxTimer: null, lastDisc: null, toastAt: 0, genAt: 0, pfAt: 0, pfSig: "", apAt: 0 };
  const STATE = { researching: "Researching", analyzing: "Analyzing", connecting: "Connecting information", discovering: "Discovering", updating: "Updating intelligence", idle: "Idle", error: "Error", offline: "Disconnected" };
  const CATN = { portfolio: "Portfolio", market: "Market", sector: "Sector", news: "News", macro: "Macro", policy: "Policy", earnings: "Earnings", filing: "SEC filing", fundamentals: "Fundamentals", insider: "Insiders", mover: "Unusual move", pattern: "Pattern", company: "Research note", ai_trader: "AI Trader" };
  const et = (t, o) => (t ? new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", ...(o || { hour: "numeric", minute: "2-digit" }) }) : "—");
  const etD = (t) => et(t, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const since = (t) => { if (!t) return "never"; const s = (Date.now() - t) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago"; };
  const dur = (a, b) => { if (!a || !b) return ""; const s = (b - a) / 1000; return s < 60 ? s.toFixed(0) + "s" : (s / 60).toFixed(1) + "m"; };
  const mineSet = () => new Set([...(S.pfs || []).flatMap((p) => p.holdings.map((h) => h.symbol))]);
  const go = (g) => { if (!g) return; closeModal(); if (g.startsWith("q:")) return openQuote(g.slice(2)); if (g.startsWith("#")) { location.hash = g.slice(1); const h = g.slice(1); if (TABS.includes(h)) setTab(h); } };
  const goAttr = (g) => (g ? ` data-twgo="${esc(g)}"` : "");
  const kindB = (k) => `<span class="tw-kind ${esc(k || "fact")}">${esc(k === "interpretation" ? "interp." : k === "speculation" ? "specul." : k || "fact")}</span>`;
  const tick = (s, mine) => `<button type="button" class="tw-tk${mine && mine.has(s) ? " mine" : ""}" data-twgo="q:${esc(s)}" title="Open ${esc(s)}">${esc(s)}</button>`;
  const impC = (v) => (v >= 70 ? "" : v >= 45 ? "m" : "l");
  const toneI = (t) => (t > 0 ? '<span class="tn up">▲</span>' : t < 0 ? '<span class="tn down">▼</span>' : "");

  // ---------------------------------------------------------------- context: let the server see portfolios + watchlist
  function ctxPayload() { return { portfolios: (S.pfs || []).map((p) => ({ id: p.id, name: p.name, holdings: p.holdings.map((h) => ({ symbol: h.symbol, shares: h.shares, cost: h.cost })) })), watchlist: S.wl || [], active: S.pfActive }; }
  function pushCtx(force) {
    clearTimeout(W.ctxTimer);
    W.ctxTimer = setTimeout(async () => {
      const body = JSON.stringify(ctxPayload()); if (!force && body === W.ctxSent) return;
      try { await api("/api/web/context", { method: "POST", headers: { "content-type": "application/json" }, body }); W.ctxSent = body; } catch {}
    }, force ? 50 : 1500);
  }
  const _set = store.set; store.set = function (k, v) { _set.call(store, k, v); if (k === "portfolios" || k === "wl" || k === "pfActive") pushCtx(); };

  // ---------------------------------------------------------------- shell
  function shell() {
    const root = $("tab-web"); if (root.dataset.ready) return; root.dataset.ready = "1";
    root.innerHTML = `
      <div class="tw-hud tw-panel" id="twHud"></div>
      <div class="tw-mininav" id="twNav"><button data-twj="twBrief">Daily briefing</button><button data-twj="twAct">Live activity</button><button data-twj="twFeedP">Discoveries</button><button data-twj="twNetP">Intelligence network</button><button data-twj="twChatP">Ask the Spider</button></div>
      <div class="tw-row tw-r1">
        <section class="tw-panel" id="twBrief"><div class="tw-ph">◈ Daily market intelligence briefing<span class="sp"></span><button class="tw-btn ghost" id="twHistBtn" type="button">History</button><button class="tw-btn" id="twGen" type="button">Generate briefing</button></div><div id="twHist" hidden></div><div id="twBriefBody"><div class="skeleton"></div></div></section>
        <section class="tw-panel" id="twAct"><div class="tw-ph">◉ Live research activity<span class="sp"></span><em id="twActNote"></em></div><div id="twActBody"><div class="skeleton"></div></div></section>
      </div>
      <div class="tw-row tw-r2">
        <section class="tw-panel" id="twFeedP"><div class="tw-ph">✦ Research discovery feed<span class="sp"></span><em id="twFeedN"></em></div>
          <div class="tw-filters"><div class="tw-seg" id="twGroups">${[["all", "All"], ["stocks", "Stocks"], ["sectors", "Sectors"], ["macro", "Macro"], ["earnings", "Earnings"], ["portfolio", "Portfolio"], ["ai", "AI Trader"], ["explore", "New to me"]].map(([k, l]) => `<button type="button" data-g="${k}" class="${k === "all" ? "on" : ""}">${l}</button>`).join("")}</div></div>
          <div class="tw-filters"><label class="tw-tg"><input type="checkbox" id="twMine"> Only my portfolio</label>
            <select class="tw-in" id="twMin"><option value="0">Any importance</option><option value="40">Importance 40+</option><option value="60">60+</option><option value="75">75+</option></select>
            <select class="tw-in" id="twSort"><option value="latest">Latest first</option><option value="importance">Most important</option></select>
            <input class="tw-in" id="twQ" placeholder="Search ticker, sector, word…" style="flex:1;min-width:140px"></div>
          <div class="tw-feed" id="twFeed"><div class="skeleton"></div></div></section>
        <section class="tw-panel" id="twNetP"><div class="tw-ph">⌬ Market intelligence network<span class="sp"></span><em id="twNetN"></em><button class="tw-btn ghost" type="button" id="twNetR">Refresh</button></div>
          <div class="tw-net" id="twNet"><div class="tw-empty">Loading the network…</div></div>
          <div class="tw-legend">${[["portfolio", "#f5c518", "Portfolio"], ["holding", "#4da3ff", "Holding"], ["watch", "#22d3ee", "Watchlist"], ["company", "#8b95a3", "Company"], ["sector", "#a78bfa", "Sector / industry"], ["macro", "#ff9f43", "Economic indicator"], ["event", "#5eead4", "Event"], ["discovery", "#e7e9ec", "Discovery (▲ green / ▼ red)"], ["trader", "#ff6fae", "AI Trader"]].map(([, c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join("")}</div></section>
      </div>
      <section class="tw-panel" id="twChatP"><div class="tw-ph">⟁ Ask the Spider<span class="sp"></span><em>answers come from stored research, with citations · new research runs when needed</em></div>
        <div class="tw-chat"><div class="tw-thread" id="twThread"></div>
          <div class="tw-qchips" id="twChips">${["Spider, what happened in the market today?", "Research everything affecting my portfolio.", "What are the biggest risks facing my investments?", "Find interesting companies I haven't researched.", "What has changed about Tesla over the last month?", "What discoveries should my AI Trader pay attention to?", "Why did technology stocks fall today?"].map((q) => `<button type="button">${esc(q)}</button>`).join("")}</div>
          <div class="tw-askrow"><textarea id="twAskIn" rows="2" placeholder="Ask about the market, your portfolio, a company or a sector…"></textarea><div style="display:flex;flex-direction:column;gap:6px"><button class="tw-btn" id="twAskGo" type="button">Ask</button>${hasKey() ? '<label class="tw-tg tw-small" title="Optional: Claude rewrites the answer from the same evidence. Uses Claude credits and your Claude password."><input type="checkbox" id="twUseClaude"> ✦ Claude</label>' : ""}</div></div></div></section>
      <div class="disc">THE WEB is a research system, not a trading system: the Spider reads public sources (SEC EDGAR, FRED, the Federal Reserve, Treasury, BLS, exchange data via Yahoo Finance, Finnhub's free tier and the five news outlets) and this site's own services, on a server-side schedule with rate limits and time limits. Facts carry their source and time; interpretations, estimates and speculation are labeled. Rules-based — no AI credits unless you tick ✦ Claude. Not financial advice.</div>
      <div class="tw-modal" id="twModal" hidden><div class="tw-mbox" id="twMbox"></div></div>`;
    root.addEventListener("click", onClick);
    $("twGen").onclick = generate; $("twHistBtn").onclick = toggleHist; $("twNetR").onclick = () => loadGraph(true);
    $("twGroups").onclick = (e) => { const b = e.target.closest("[data-g]"); if (!b) return; W.feed.group = b.dataset.g; [...$("twGroups").children].forEach((x) => x.classList.toggle("on", x === b)); loadFeed(true); };
    $("twMine").onchange = (e) => { W.feed.mine = e.target.checked; loadFeed(true); };
    $("twMin").onchange = (e) => { W.feed.min = +e.target.value; loadFeed(true); };
    $("twSort").onchange = (e) => { W.feed.sort = e.target.value; loadFeed(true); };
    let qt; $("twQ").oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { W.feed.q = e.target.value.trim(); loadFeed(true); }, 300); };
    $("twChips").onclick = (e) => { const b = e.target.closest("button"); if (b) ask(b.textContent); };
    $("twAskGo").onclick = () => ask($("twAskIn").value);
    $("twAskIn").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask($("twAskIn").value); } };
    $("twNav").onclick = (e) => { const b = e.target.closest("[data-twj]"); if (b) $(b.dataset.twj).scrollIntoView({ behavior: "smooth", block: "start" }); };
    $("twModal").onclick = (e) => { if (e.target.id === "twModal" || e.target.closest(".x")) closeModal(); };
    if (!W.chat.length) W.chat.push({ who: "sp", html: "I'm the Spider. I research the market on a schedule from the server — even when this page is closed — and remember what I find. Ask me anything below, or pick a question." });
    renderChat();
  }
  function onClick(e) {
    const g = e.target.closest("[data-twgo]"); if (g) { e.stopPropagation(); e.preventDefault(); return go(g.dataset.twgo); }
    const d = e.target.closest("[data-twd]"); if (d) { e.preventDefault(); return openDisc(d.dataset.twd); }
    const c = e.target.closest("[data-twc]"); if (c) { const m = W.chat[+c.dataset.twm]; const ci = m && m.cites && m.cites[+c.dataset.twc - 1]; if (ci) openDisc(ci.id); return; }
    const hb = e.target.closest("[data-twb]"); if (hb) return loadBrief(hb.dataset.twb);
  }

  // ---------------------------------------------------------------- status: HUD + activity (real backend jobs)
  async function loadStatus() {
    try { W.st = await api("/api/web/status"); W.stAt = Date.now(); W.offline = false; }
    catch (e) { W.offline = true; }
    if (W.open) { renderHud(); renderAct(); }
    const s = W.st; if (!s) return;
    // react to completed work: new discoveries refresh the feed; a finished briefing reloads the briefing
    const n = s.stats.memory + ":" + s.stats.discoveries;
    if (W.lastDisc !== null && n !== W.lastDisc) { if (W.open) loadFeed(); else notifyNew(); }
    W.lastDisc = n;
    const lastB = (s.recent || []).find((j) => j.type === "briefing" && j.status === "done");
    if (W.open && lastB && (!W.brief || (lastB.ended || 0) > (W.brief.generatedAt || 0) + 1000) && (!W.viewing || W.viewing === "latest")) loadBrief("latest");
  }
  async function notifyNew() {
    if (Date.now() - W.toastAt < 5 * 60e3 || document.hidden) return;
    try { const r = await api(`/api/web/discoveries?mine=1&min=70&since=${Date.now() - 15 * 60e3}&limit=1`); const d = r.items[0];
      if (d) { W.toastAt = Date.now(); toast(`🕸 Spider: ${d.headline}`); } } catch {}
  }
  function spiderSvg(state) {
    const legs = [[-1, -1], [-1, -0.35], [-1, 0.35], [-1, 1], [1, -1], [1, -0.35], [1, 0.35], [1, 1]].map(([sx, sy], i) => { const x1 = 32 + sx * 8, y1 = 32 + sy * 6, kx = 32 + sx * 19, ky = 32 + sy * 12 - 6, x2 = 32 + sx * 27, y2 = 32 + sy * 18 + 4; return `<path class="leg" d="M${x1} ${y1} Q${kx} ${ky} ${x2} ${y2}"/>`; }).join("");
    return `<div class="tw-spider ${esc(state)}" title="Spider: ${esc(STATE[state] || state)}"><svg viewBox="0 0 64 64" aria-hidden="true"><circle class="ring" cx="32" cy="32" r="31"/><line class="thread" x1="32" y1="-14" x2="32" y2="22"/><g class="legs">${legs}</g><ellipse class="body" cx="32" cy="33" rx="9" ry="11"/><circle class="eye" cx="28.5" cy="27" r="1.8"/><circle class="eye" cx="35.5" cy="27" r="1.8"/></svg></div>`;
  }
  function renderHud() {
    const s = W.st, el = $("twHud"); if (!el) return;
    const state = W.offline ? "offline" : s ? s.state : "idle";
    const r = s && s.running, top = s && s.queue[0];
    const order = ["researching", "analyzing", "connecting", "discovering", "updating"], idx = r ? order.indexOf(r.phase) : -1;
    const now = W.offline ? `<div class="lbl">Can't reach the Spider</div><div class="note">The server may be waking up (free hosting sleeps when idle). Retrying…</div>`
      : r ? `<div class="lbl">${esc(r.label)}</div><div class="note">${esc(r.note || "")}</div><div class="tw-phases">${order.map((p, i) => `<i class="${i <= idx ? "on" : ""}" title="${STATE[p]}"></i>`).join("")}</div><div class="area">${esc(r.area || "")}${r.go ? ` · <a href="#" data-twgo="${esc(r.go)}">open</a>` : ""} · priority ${r.prio ? r.prio.score : "—"} · running ${dur(r.started, Date.now())}</div>`
      : s ? `<div class="lbl">${s.note ? esc(s.note) : "Idle — waiting for the next scheduled check"}</div><div class="note">${top ? `Next up: ${esc(top.label)} (priority ${top.score}${top.why.length ? " · " + esc(top.why.slice(0, 2).join(", ")) : ""})` : "Nothing queued — the planner adds work as freshness windows expire."}</div><div class="area">${esc(s.session.phase)} · checks every 15 s${s.scheduler.lastTick ? " · last check " + since(s.scheduler.lastTick) : ""}</div>` : "";
    const st = s && s.stats, sto = s && s.storage, ctx = s && s.context;
    const chips = s ? [
      `<span class="tw-chip ${s.session.open ? "ok" : ""}">Market <b>${esc(s.session.phase)}</b></span>`,
      `<span class="tw-chip">Jobs today <b>${st.jobs}</b></span>`, `<span class="tw-chip">New findings today <b>${st.discoveries}</b></span>`,
      `<span class="tw-chip">Memory <b>${st.memory}</b></span>`, `<span class="tw-chip">Queue <b>${s.queued}</b></span>`,
      `<span class="tw-chip" title="Hard cap on research jobs per hour">Budget <b>${st.budget.used}/${st.budget.max}</b>/h</span>`,
      `<span class="tw-chip" title="Directional findings are graded against the S&P 500 after a week">Hypotheses <b>${st.hypotheses.supported}✓ ${st.hypotheses.refuted}✗</b> · ${st.hypotheses.open} open</span>`,
      s.scheduler.nextBriefing ? `<span class="tw-chip">Next briefing <b>${esc(s.scheduler.nextBriefing.label)}</b> ~${Math.floor(s.scheduler.nextBriefing.at / 60) % 12 || 12}:${String(s.scheduler.nextBriefing.at % 60).padStart(2, "0")} ${s.scheduler.nextBriefing.at >= 720 ? "PM" : "AM"}</span>` : "",
      ctx && !ctx.holdings ? `<span class="tw-chip warn" title="Open the Portfolio tab so your browser shares holdings with the Spider">No holdings shared yet</span>` : ctx ? `<span class="tw-chip">Tracking <b>${ctx.holdings}</b> holdings · <b>${ctx.watchlist}</b> watchlist</span>` : "",
      sto && sto.durable ? `<span class="tw-chip ok" title="Research survives restarts">Memory: ${esc(sto.backend)}</span>` : `<span class="tw-chip warn" title="Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Render (free) so research survives redeploys and overnight sleep">Memory: temporary — add free Upstash</span>`,
    ].join("") : "";
    el.innerHTML = `<div class="tw-id">${spiderSvg(state)}<div><div class="tw-kick">AUTONOMOUS RESEARCH</div><h1>THE <span>WEB</span></h1><div class="tw-state">Spider · <b>${esc(STATE[state] || state)}</b></div></div></div><div class="tw-now">${now}</div><div class="tw-chips">${chips}</div>`;
  }
  function renderAct() {
    const s = W.st, el = $("twActBody"); if (!el || !s) return;
    $("twActNote").textContent = s.scheduler.error ? "last error: " + s.scheduler.error.slice(0, 60) : "";
    const q = s.queue.slice(0, 7).map((j) => `<div class="tw-qi"><span class="sc">${j.score}</span><div><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(j.label)}${j.waiting ? ` <span class="tw-muted tw-small">· retry ${et(j.waiting)}</span>` : ""}</div><div class="bar"><i style="width:${Math.min(100, j.score)}%"></i></div><div class="w">${esc(j.why.join(" · ") || j.area)}</div></div></div>`).join("");
    const log = (s.recent || []).slice(0, 24).map((j) => `<div class="tw-li"><span class="st ${j.status}">${j.status === "done" ? "✓" : j.status === "error" ? "✕" : "●"}</span><div style="min-width:0"><span${j.go ? ` data-twgo="${esc(j.go)}" style="cursor:pointer"` : ""}>${esc(j.label)}</span>${j.found || j.updated ? ` <span class="f">+${j.found}${j.updated ? ` ↻${j.updated}` : ""}</span>` : ""}<span class="r">${esc(j.status === "error" ? "Error: " + (j.error || "") : j.result || (j.status === "running" ? j.note || "running…" : ""))}</span></div><span class="t">${et(j.started)}<br>${dur(j.started, j.ended)}</span></div>`).join("");
    el.innerHTML = `<h2 class="h" style="margin-top:0">Research queue · re-ranked every 15 s</h2><div class="tw-q">${q || '<div class="tw-muted tw-small">Queue empty — every source is fresh.</div>'}</div>
      <h2 class="h">Completed jobs</h2><div class="tw-log">${log || '<div class="tw-empty">No research has run since the server started. The first jobs begin about a minute after a restart.</div>'}</div>`;
  }

  // ---------------------------------------------------------------- briefing
  async function loadBrief(id) {
    W.viewing = id;
    try { W.brief = await api("/api/web/briefing?id=" + encodeURIComponent(id)); }
    catch (e) { W.brief = null; $("twBriefBody").innerHTML = `<div class="tw-empty">No briefing yet. The Spider writes one each trading day at about 7:45 AM (pre-market), noon and 4:10 PM ET — or press <b>Generate briefing</b> for one now.</div>`; return; }
    renderBrief();
    if (W.histOpen) renderHist();
  }
  function itemHtml(i, mine) {
    const main = i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.text)}</a>` : i.disc ? `<a href="#" data-twd="${esc(i.disc)}">${esc(i.text)}</a>` : esc(i.text);
    return `<li>${kindB(i.kind)}<span class="tx">${main}${i.tag ? `<span class="tw-tag">· ${esc(i.tag)}</span>` : ""}${i.detail ? `<span class="det">${esc(i.detail)}</span>` : ""}<span class="meta">${[i.src ? esc(i.src) : "", i.at ? etD(i.at) + " ET" : ""].filter(Boolean).join(" · ")} ${(i.tickers || []).slice(0, 4).map((t) => tick(t, mine)).join(" ")}</span></span></li>`;
  }
  function renderBrief() {
    const b = W.brief, el = $("twBriefBody"); if (!b || !el) return;
    const mine = mineSet(), f = b.freshness;
    const fb = [[f.quotes.status, f.quotes.label], ["", f.news.label], ["", f.macro.label], ["", f.earnings.label], ["", f.portfolio.label]].map(([c, l]) => `<span class="${esc(c)}">${esc(l)}</span>`).join("");
    const secs = b.sections.map((s, n) => `<details class="tw-sec"${n === 0 ? " open" : ""}><summary>${esc(s.title)} <span class="n">${s.items.length || "—"}</span><span class="car">›</span></summary>${s.why ? `<div class="why">Why it matters: ${esc(s.why)}</div>` : ""}
      ${s.table && s.key === "indexes" && s.table.length ? `<table class="tw-tbl">${s.table.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.sym === "^TNX" ? r.price.toFixed(2) + "%" : r.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td><td class="${cls(r.chg)}">${pct(r.chg)}</td></tr>`).join("")}</table>` : ""}
      ${s.items.length ? `<ul class="tw-items">${s.items.filter((i) => !(s.key === "indexes" && i.kind === "fact")).map((i) => itemHtml(i, mine)).join("")}</ul>` : `<div class="tw-muted tw-small" style="margin-bottom:12px">${esc(s.empty)}</div>`}</details>`).join("");
    el.innerHTML = `<div class="tw-bhead"><div style="flex:1;min-width:0"><h2>${esc(b.title)}</h2><div class="tw-bmeta">${esc(b.date)} · generated ${et(b.generatedAt)} ET (${since(b.generatedAt)})${b.manual ? " · on demand" : " · scheduled"}${W.viewing && W.viewing !== "latest" ? ' · <a href="#" data-twb="latest" style="color:var(--tw-c)">back to latest</a>' : ""}</div></div></div>
      <div class="tw-fresh">${fb}</div>${(f.notes || []).map((n) => `<div class="tw-fnote">⚠ ${esc(n)}</div>`).join("")}
      <div class="tw-exec">${b.exec.map((x) => `<p>${esc(x)}</p>`).join("")}</div>${secs}<div class="disc" style="margin-top:8px">${esc(b.method)}</div>`;
  }
  async function generate() {
    const btn = $("twGen"); btn.disabled = true; btn.textContent = "Starting…";
    try { await api("/api/web/briefing/generate", { method: "POST" }); W.genAt = Date.now(); btn.textContent = "Writing…"; toast("🕸 The Spider is refreshing its data and writing a briefing — about a minute."); W.viewing = "latest"; }
    catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Generate briefing"; return; }
    const wait = setInterval(() => { const j = W.st && (W.st.recent || []).find((x) => x.type === "briefing" && x.started >= W.genAt - 2000 && x.status !== "running");
      if (j || Date.now() - W.genAt > 6 * 60e3) { clearInterval(wait); btn.disabled = false; btn.textContent = "Generate briefing"; if (j && j.status === "error") toast("Briefing failed: " + j.error); loadBrief("latest"); } }, 3000);
  }
  async function toggleHist() { W.histOpen = !W.histOpen; $("twHist").hidden = !W.histOpen; if (W.histOpen) renderHist(true); }
  async function renderHist(reload) {
    const el = $("twHist");
    if (!el.dataset.ready) { el.dataset.ready = "1"; el.innerHTML = `<div class="tw-hist"><input class="tw-in" id="twHq" placeholder="Search briefings (ticker, theme, word)…" style="flex:1;min-width:160px"><input class="tw-in" type="date" id="twHf" title="From"><input class="tw-in" type="date" id="twHt" title="To"></div><div class="tw-hlist" id="twHl"></div>`;
      let t; const re = () => { clearTimeout(t); t = setTimeout(() => renderHist(true), 250); }; $("twHq").oninput = re; $("twHf").onchange = re; $("twHt").onchange = re; }
    if (reload || !W.hist) { try { W.hist = await api(`/api/web/briefings?q=${encodeURIComponent($("twHq").value)}&from=${$("twHf").value}&to=${$("twHt").value}&limit=120`); } catch { W.hist = { items: [] }; } }
    $("twHl").innerHTML = W.hist.items.length ? W.hist.items.map((b) => `<button type="button" data-twb="${esc(b.id)}" class="${W.brief && W.brief.id === b.id ? "on" : ""}">${esc(b.day)} · ${esc(b.label)}<small>${esc(b.headline)}</small></button>`).join("") : '<div class="tw-empty">No briefings match.</div>';
  }

  // ---------------------------------------------------------------- discovery feed
  async function loadFeed(reset) {
    const f = W.feed, grp = f.group === "explore" || f.group === "ai" || f.group === "all" ? "" : f.group;
    const url = `/api/web/discoveries?limit=80&sort=${f.sort}${grp ? "&group=" + grp : ""}${f.group === "explore" ? "&explore=1" : ""}${f.group === "ai" ? "&ai=1" : ""}${f.mine ? "&mine=1" : ""}${f.min ? "&min=" + f.min : ""}${f.q ? "&q=" + encodeURIComponent(f.q) : ""}`;
    let r; try { r = await api(url); } catch (e) { $("twFeed").innerHTML = `<div class="tw-empty">Couldn't load discoveries (${esc(e.message)}).</div>`; return; }
    const sig = r.items.map((d) => d.id + d.v).join(","); if (!reset && sig === f.sig) return; f.sig = sig;
    const firstLoad = !f.seen; f.seen = f.seen || new Set(); const mine = mineSet();
    $("twFeedN").textContent = `${r.total} finding${r.total === 1 ? "" : "s"}`;
    $("twFeed").innerHTML = r.items.length ? r.items.map((d) => { const nw = !firstLoad && !reset && !f.seen.has(d.id + d.v); f.seen.add(d.id + d.v);
      return `<article class="tw-d${nw ? " new" : ""}" data-twd="${esc(d.id)}"><div class="top"><span class="imp ${impC(d.importance)}" title="Importance">${d.importance}</span><span class="cat">${esc(CATN[d.cat] || d.cat)}</span><span>${etD(d.u)} ET</span>${d.v > 1 ? `<span title="Updated as new data arrived">v${d.v}</span>` : ""}${d.hyp ? `<span class="tw-hyp ${esc(d.hyp.status)}" title="${esc(d.hyp.claim || "")}">hypothesis: ${esc(d.hyp.status)}</span>` : ""}</div>
        <h4>${toneI(d.tone)}${esc(d.headline)}</h4><p>${esc(d.summary)}</p>
        <div class="bot">${d.tickers.slice(0, 5).map((t) => tick(t, mine)).join(" ")}<span>${esc((d.sources[0] || {}).name || "")}</span>${d.pf.rel ? `<span class="tw-rel" title="Portfolio relevance: ${esc(d.pf.why.join("; "))}"><i><b style="width:${Math.round(d.pf.rel * 100)}%"></b></i>portfolio</span>` : ""}${d.ai.rel ? `<span class="tw-rel ai" title="AI Trader relevance: ${esc(d.ai.why || "")}"><i><b style="width:${Math.round(d.ai.rel * 100)}%"></b></i>AI Trader</span>` : ""}<span style="margin-left:auto;color:var(--tw-c)">full research ›</span></div></article>`; }).join("")
      : `<div class="tw-empty">${f.mine || f.q || f.min || f.group !== "all" ? "Nothing matches these filters yet." : "No discoveries yet. The Spider starts about a minute after the server boots; the first market and news sweeps usually produce findings within 10 minutes."}</div>`;
  }
  async function openDisc(id) {
    let d; try { d = await api("/api/web/discovery?id=" + encodeURIComponent(id)); } catch (e) { return toast("That finding has expired from research memory."); }
    const mine = mineSet();
    $("twMbox").innerHTML = `<button class="x" type="button" aria-label="Close">✕</button>
      <div class="tw-d" style="border:0;padding:0;cursor:default"><div class="top"><span class="imp ${impC(d.importance)}">${d.importance}</span><span class="cat">${esc(CATN[d.cat] || d.cat)}</span><span>found ${etD(d.t)} ET${d.v > 1 ? ` · updated ${etD(d.u)} (v${d.v})` : ""}</span></div></div>
      <h3>${toneI(d.tone)}${esc(d.headline)}</h3><p style="color:var(--muted);margin:0;line-height:1.5">${esc(d.summary)}</p>
      <div style="margin-top:8px">${d.tickers.map((t) => tick(t, mine)).join(" ")} ${d.sectors.map((s) => `<span class="tw-chip">${esc(s)}</span>`).join(" ")}</div>
      ${d.facts.length ? `<h6>Evidence</h6><ul class="tw-items">${d.facts.map((f) => `<li>${kindB(f.kind)}<span class="tx">${esc(f.text)}<span class="meta">${[f.src, f.at ? etD(f.at) + " ET" : ""].filter(Boolean).map(esc).join(" · ")}</span></span></li>`).join("")}</ul>` : ""}
      ${d.interp ? `<h6>${d.interp.kind === "speculation" ? "Speculation" : "Interpretation"}</h6><ul class="tw-items"><li>${kindB(d.interp.kind)}<span class="tx">${esc(d.interp.text)}</span></li></ul>` : ""}
      <h6>Scores</h6><div class="tw-scores"><span>Importance <b>${d.importance}</b>/100</span><span>Portfolio relevance <b>${Math.round(d.pf.rel * 100)}%</b>${d.pf.why.length ? " — " + esc(d.pf.why.join("; ")) : ""}</span><span>AI Trader relevance <b>${Math.round(d.ai.rel * 100)}%</b>${d.ai.why ? " — " + esc(d.ai.why) : ""}</span><span>Confidence <b>${Math.round(d.conf * 100)}%</b></span></div>
      ${d.hyp ? `<h6>Hypothesis being tracked</h6><p style="margin:0;font-size:13px">${esc(d.hyp.claim || "")} <span class="tw-hyp ${esc(d.hyp.status)}">${esc(d.hyp.status)}${d.hyp.rel != null ? ` · ${pct(d.hyp.rel)} vs S&P 500` : ` · graded ${etD(d.hyp.due)}`}</span></p>` : ""}
      ${d.sources.length ? `<h6>Sources</h6><ul class="tw-items">${d.sources.map((s) => `<li><span class="tx">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}<span class="meta">${s.at ? "data time " + etD(s.at) + " ET" : ""}</span></span></li>`).join("")}</ul>` : ""}
      ${d.related && d.related.length ? `<h6>Connected findings</h6><ul class="tw-items">${d.related.map((r) => `<li><span class="tx"><a href="#" data-twd="${esc(r.id)}">${esc(r.headline)}</a><span class="meta">${esc(CATN[r.cat] || r.cat)} · ${etD(r.u)}</span></span></li>`).join("")}</ul>` : ""}
      ${d.prev && d.prev.length ? `<h6>Earlier versions</h6><ul class="tw-items">${d.prev.map((p) => `<li><span class="tx">v${p.v}: ${esc(p.headline)}<span class="det">${esc(p.summary)}</span><span class="meta">${etD(p.u)} ET</span></span></li>`).join("")}</ul>` : ""}
      <div class="links">${(d.links || []).map((l) => `<button class="tw-btn" type="button" data-twgo="${esc(l.go)}">${esc(l.label)} →</button>`).join("")}${d.tickers[0] ? `<button class="tw-btn ghost" type="button" data-twrun="${esc(d.tickers[0])}">Research ${esc(d.tickers[0])} again</button>` : ""}</div>`;
    const m = $("twModal"); m.hidden = false;
    m.onclick = (e) => { if (e.target.id === "twModal" || e.target.closest(".x")) return closeModal(); const g = e.target.closest("[data-twgo]"); if (g) return go(g.dataset.twgo); const dd = e.target.closest("[data-twd]"); if (dd) { e.preventDefault(); return openDisc(dd.dataset.twd); } const r = e.target.closest("[data-twrun]"); if (r) runResearch(r.dataset.twrun); };
  }
  function closeModal() { const m = $("twModal"); if (m) m.hidden = true; }
  async function runResearch(sym) { try { await api("/api/web/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "company_snapshot", symbol: sym }) }); toast(`🕸 Queued fresh research on ${sym} — watch the activity panel.`); closeModal(); } catch (e) { toast(e.message); } }

  // ---------------------------------------------------------------- network
  const NCOL = { portfolio: "#f5c518", holding: "#4da3ff", watch: "#22d3ee", company: "#8b95a3", sector: "#a78bfa", industry: "#7c6bb8", macro: "#ff9f43", event: "#5eead4", trader: "#ff6fae" };
  const ncol = (n) => (n.type === "discovery" ? (n.tone > 0 ? "#0fbf7d" : n.tone < 0 ? "#f6465d" : "#c9ced6") : NCOL[n.type] || "#888");
  async function loadGraph(force) {
    if (!force && W.graph && Date.now() - W.graph.t < 120e3) return;
    let g; try { g = await api("/api/web/graph"); } catch (e) { $("twNet").innerHTML = `<div class="tw-empty">Couldn't load the network (${esc(e.message)}).</div>`; return; }
    W.graph = g; layout(g); drawGraph();
  }
  // Brain layout: the left hemisphere holds YOUR world (portfolios, holdings, watchlist, AI Trader), the right holds the
  // MARKET (sectors, economic indicators, events, discoveries). Connections that cross the middle are the links between them.
  const LEFT = new Set(["portfolio", "holding", "watch", "trader", "company"]);
  const HEMI = { L: { cx: -205, cy: 0, rx: 255, ry: 235 }, R: { cx: 205, cy: 0, rx: 255, ry: 235 } };
  function keepInside(n) { // pull a node back inside its hemisphere (an ellipse, slightly flattened at the bottom)
    const h = HEMI[n.hemi], ry = n.y > h.cy ? h.ry * 0.86 : h.ry, dx = (n.x - h.cx) / (h.rx - 14), dy = (n.y - h.cy) / (ry - 14), d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1) { n.x = h.cx + (n.x - h.cx) / d; n.y = h.cy + (n.y - h.cy) / d; }
    if (n.hemi === "L" && n.x > -16) n.x = -16; if (n.hemi === "R" && n.x < 16) n.x = 16;
  }
  function layout(g) {
    const nodes = g.nodes, idx = new Map(nodes.map((n, i) => [n.id, i]));
    const band = { portfolio: [-0.15, 0], trader: [-0.55, 0.45], holding: [0, 0], watch: [0.35, 0.3], company: [0.5, -0.4], sector: [0.05, 0], industry: [0.35, 0.35], macro: [-0.6, 0], event: [0.6, 0], discovery: [0, 0] };
    nodes.forEach((n) => { n.hemi = LEFT.has(n.type) ? "L" : "R"; const h = HEMI[n.hemi], [by] = band[n.type] || [0], a = Math.random() * Math.PI * 2, r = Math.random() * 0.75;
      n.x = h.cx + Math.cos(a) * h.rx * r * (n.type === "sector" || n.type === "industry" ? 0.5 : 1) + (n.type === "sector" ? -h.cx * 0.55 : 0); n.y = h.cy + by * h.ry + Math.sin(a) * h.ry * r * 0.6; n.vx = 0; n.vy = 0; keepInside(n); });
    const E = g.edges.map((e) => [idx.get(e.a), idx.get(e.b), { holds: 70, sector: 95, industry: 55, mentions: 75, correlation: 60, sensitivity: 110, related: 55, event: 45, trader: 80, affects: 90, about: 90 }[e.type] || 85]).filter((e) => e[0] != null && e[1] != null);
    const N = nodes.length;
    for (let it = 0; it < 300; it++) {
      const cool = 1 - it / 320;
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const a = nodes[i], b = nodes[j]; let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01; if (d2 > 120000) continue; const f = 1700 / d2, d = Math.sqrt(d2); dx /= d; dy /= d; a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f; }
      for (const [i, j, L] of E) { const a = nodes[i], b = nodes[j], cross = a.hemi !== b.hemi, dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - (cross ? L * 2.2 : L)) * (cross ? 0.004 : 0.012); a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f; }
      for (const n of nodes) { const h = HEMI[n.hemi]; n.vx -= (n.x - h.cx) * 0.0012; n.vy -= (n.y - h.cy) * 0.0012; if (n.type === "portfolio") { n.vx -= (n.x - h.cx * 0.75) * 0.05; n.vy -= n.y * 0.05; } if (n.type === "sector") n.vx += (n.hemi === "R" ? -1 : 1) * 0.6; // sectors sit near the bridge
        n.x += Math.max(-10, Math.min(10, n.vx)) * cool; n.y += Math.max(-10, Math.min(10, n.vy)) * cool; n.vx *= 0.6; n.vy *= 0.6; keepInside(n); }
    }
    g.box = [-500, -300, 1000, 600]; g.view = g.box.slice();
  }
  // decorative anatomy (hemisphere outlines + wavy cortex folds); everything data-driven sits on top of it
  function lobePath(k) { // same geometry keepInside() uses, so every neuron sits inside its lobe
    const h = HEMI[k], pts = [];
    for (let i = 0; i <= 140; i++) { const t = (i / 140) * Math.PI * 2, ry = Math.sin(t) > 0 ? h.ry * 0.86 : h.ry; let x = h.cx + Math.cos(t) * h.rx, y = h.cy + Math.sin(t) * ry;
      x += Math.sin(t * 9) * 4; y += Math.cos(t * 7) * 3; // a slightly bumpy cortex edge
      if (k === "L" && x > -8) x = -8; if (k === "R" && x < 8) x = 8; pts.push(`${x.toFixed(1)} ${y.toFixed(1)}`); }
    return "M" + pts.join(" L") + "Z";
  }
  function brainArt() {
    const folds = [];
    for (const k of ["L", "R"]) { const h = HEMI[k], s = k === "L" ? -1 : 1;
      for (let r = 0; r < 11; r++) { const y0 = h.cy - h.ry + 24 + r * ((h.ry * 1.86) / 11), amp = 7 + (r % 3) * 3, lam = 26 + (r % 4) * 7, ph = r * 1.7, pts = [];
        for (let x = 10; x <= h.rx * 2.05; x += 6) pts.push(`${(s * x).toFixed(1)} ${(y0 + Math.sin(x / lam + ph) * amp + Math.sin(x / 9 + r) * 2).toFixed(1)}`);
        folds.push(`<path class="fold" d="M${pts.join(" L")}"/>`); }
      for (let r = 0; r < 5; r++) { const x0 = s * (60 + r * 85), pts = []; for (let y = -h.ry; y <= h.ry; y += 6) pts.push(`${(x0 + Math.sin(y / 30 + r * 2) * 10).toFixed(1)} ${y}`); folds.push(`<path class="fold v" d="M${pts.join(" L")}"/>`); } }
    return `<defs><radialGradient id="twCortex" cx="50%" cy="42%" r="62%"><stop offset="0" stop-color="#5eead4" stop-opacity=".10"/><stop offset=".7" stop-color="#a78bfa" stop-opacity=".035"/><stop offset="1" stop-color="#a78bfa" stop-opacity=".01"/></radialGradient>
      <clipPath id="twClipL"><path d="${lobePath("L")}"/></clipPath><clipPath id="twClipR"><path d="${lobePath("R")}"/></clipPath>
      <filter id="twBlur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4"/></filter></defs>
      <g class="brain"><path class="lobe" d="${lobePath("L")}"/><path class="lobe" d="${lobePath("R")}"/>
      <g clip-path="url(#twClipL)">${folds.filter((_, i) => i < 16).join("")}</g><g clip-path="url(#twClipR)">${folds.filter((_, i) => i >= 16).join("")}</g>
      <path class="fold mid" d="M0 -232 C-6 -120 6 -10 0 205"/>
      <text class="hemi-l" x="-205" y="-252" text-anchor="middle">YOUR PORTFOLIO</text><text class="hemi-l" x="205" y="-252" text-anchor="middle">THE MARKET</text></g>`;
  }
  function curve(a, b) { const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, k = a.hemi !== b.hemi ? 0.28 : 0.16; return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${(mx - dy * k).toFixed(1)} ${(my + dx * k).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`; }
  function drawGraph() {
    const g = W.graph, el = $("twNet"); if (!g || !el) return;
    $("twNetN").textContent = `${g.nodes.length} nodes · ${g.edges.length} connections`;
    if (!g.nodes.length) { el.innerHTML = '<div class="tw-empty">The network grows as the Spider researches. Share your portfolio (open the Portfolio tab) and give it a few minutes.</div>'; return; }
    const pos = new Map(g.nodes.map((n) => [n.id, n])), motion = !(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
    let pulses = 0;
    const edges = g.edges.map((e, i) => { const a = pos.get(e.a), b = pos.get(e.b), d = curve(a, b), lv = e.type === "mentions" || e.type === "affects" || e.type === "trader";
      // a pulse travels only along connections to real discoveries / AI Trader positions
      const pulse = lv && motion && pulses++ < 28 ? `<circle class="pulse" r="1.6"><animateMotion dur="${(2.6 + (i % 7) * 0.45).toFixed(2)}s" begin="${((i * 0.37) % 3).toFixed(2)}s" repeatCount="indefinite" path="${d}"/></circle>` : "";
      return `<g class="syn${a.hemi !== b.hemi ? " cross" : ""}" data-i="${i}"><path class="glow" d="${d}"/><path class="e" d="${d}"><title>${esc(e.why)}</title></path>${pulse}</g>`; }).join("");
    const nodes = g.nodes.map((n) => { const lab = ["portfolio", "holding", "sector", "macro", "trader"].includes(n.type);
      const r = n.type === "portfolio" ? 5.5 : n.type === "trader" || n.type === "holding" ? 3.6 + Math.min(1.6, (n.size || 11) / 12) : n.type === "discovery" ? 1.8 + (n.importance || 40) / 40 : n.type === "industry" ? 2 : 2.8;
      const c = ncol(n), tip = n.label + (n.sub ? " — " + n.sub : "");
      return `<g class="n${lab ? " lab" : ""}" data-id="${esc(n.id)}" transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})" tabindex="0" role="button" aria-label="${esc(n.type + ": " + tip)}"><circle class="hit" r="11"/><circle class="halo" r="${(r * 3.4).toFixed(1)}" fill="${c}"/><circle class="core" r="${r.toFixed(1)}" fill="${c}"/><text x="${(r + 4).toFixed(1)}" y="3">${esc(n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label)}</text><title>${esc(tip)}</title></g>`; }).join("");
    el.innerHTML = `<svg id="twSvg" viewBox="${g.view.join(" ")}">${brainArt()}<g id="twE">${edges}</g><g id="twN">${nodes}</g></svg><div class="tw-nhint">click or tab to a neuron · drag to pan · scroll to zoom</div><div class="tw-ninfo" id="twNinfo" hidden></div>`;
    const svg = $("twSvg"); let drag = null, moved = false;
    svg.onpointerdown = (e) => { const hit = e.target.closest(".n"); drag = { x: e.clientX, y: e.clientY, v: g.view.slice(), node: hit ? hit.dataset.id : null }; moved = false; svg.classList.add("drag"); try { svg.setPointerCapture(e.pointerId); } catch {} };
    svg.onpointermove = (e) => { if (!drag) return; const k = g.view[2] / svg.clientWidth; const dx = (e.clientX - drag.x) * k, dy = (e.clientY - drag.y) * k; if (Math.abs(dx) + Math.abs(dy) > 2) moved = true; g.view[0] = drag.v[0] - dx; g.view[1] = drag.v[1] - dy; svg.setAttribute("viewBox", g.view.join(" ")); };
    // pointer capture retargets pointerup to the <svg>, so use the node that was under the pointer when it went down
    svg.onpointerup = () => { svg.classList.remove("drag"); const d = drag; drag = null; if (!d || moved) return; selectNode(d.node || null); };
    svg.onkeydown = (e) => { const n = e.target.closest && e.target.closest(".n"); if (n && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectNode(n.dataset.id); } if (e.key === "Escape") selectNode(null); };
    svg.onwheel = (e) => { e.preventDefault(); const s = e.deltaY > 0 ? 1.12 : 1 / 1.12, r = svg.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      const w = Math.min(g.box[2] * 2.5, Math.max(140, g.view[2] * s)), h = w * (g.view[3] / g.view[2]); g.view = [g.view[0] + (g.view[2] - w) * px, g.view[1] + (g.view[3] - h) * py, w, h]; svg.setAttribute("viewBox", g.view.join(" ")); };
    // keep every neuron's click/tap target at least ~24 px across on screen, whatever the zoom
    const fitHits = () => { const k = g.view[2] / Math.max(1, svg.clientWidth), r = Math.max(9, 12 * k).toFixed(1); svg.querySelectorAll(".hit").forEach((c) => c.setAttribute("r", r)); };
    fitHits(); svg.addEventListener("wheel", fitHits, { passive: true });
    if (W.sel && pos.has(W.sel)) selectNode(W.sel);
  }
  async function selectNode(id) {
    W.sel = id; const g = W.graph, info = $("twNinfo"), svg = $("twSvg"); if (!svg) return;
    if (!id) { svg.querySelectorAll(".dim,.sel,.hl").forEach((x) => x.classList.remove("dim", "sel", "hl")); svg.classList.remove("focus"); info.hidden = true; return; }
    const nb = new Set([id]), es = [];
    g.edges.forEach((e, i) => { if (e.a === id || e.b === id) { nb.add(e.a); nb.add(e.b); es.push([i, e]); } });
    svg.querySelectorAll(".n").forEach((x) => { x.classList.toggle("dim", !nb.has(x.dataset.id)); x.classList.toggle("sel", x.dataset.id === id); });
    const hl = new Set(es.map(([i]) => String(i))); svg.querySelectorAll(".syn").forEach((x) => { x.classList.toggle("hl", hl.has(x.dataset.i)); x.classList.toggle("dim", !hl.has(x.dataset.i)); });
    svg.classList.add("focus");
    const n = g.nodes.find((x) => x.id === id), name = (x) => (g.nodes.find((y) => y.id === x) || {}).label || x;
    info.hidden = false;
    info.innerHTML = `<button class="x" type="button" aria-label="Close">✕</button><div class="tw-kick" style="font-size:10px">${esc(n.type.toUpperCase())}</div><h5>${esc(n.label)}</h5><div class="tw-muted tw-small">${esc(n.sub || "")}</div>
      <ul>${es.slice(0, 8).map(([, e]) => `<li>${esc(e.why)} <span class="tw-muted">(${esc(name(e.a === id ? e.b : e.a))})</span></li>`).join("")}${es.length > 8 ? `<li class="tw-muted">+${es.length - 8} more connections</li>` : ""}</ul><div id="twNdisc" style="margin-top:8px"><span class="spin"></span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${n.go ? `<button class="tw-btn" type="button" data-twgo="${esc(n.go)}">Open in Terminal →</button>` : ""}${n.disc ? `<button class="tw-btn" type="button" data-twd="${esc(n.disc)}">Full research →</button>` : ""}</div>`;
    info.onclick = (e) => { if (e.target.closest(".x")) return selectNode(null); const gg = e.target.closest("[data-twgo]"); if (gg) return go(gg.dataset.twgo); const d = e.target.closest("[data-twd]"); if (d) { e.preventDefault(); openDisc(d.dataset.twd); } };
    let url = null;
    if (n.type === "holding" || n.type === "watch" || n.type === "company") url = `/api/web/discoveries?symbols=${encodeURIComponent(n.label)}&limit=6`;
    else if (n.type === "sector" || n.type === "industry") url = `/api/web/discoveries?q=${encodeURIComponent(n.label)}&limit=6`;
    else if (n.type === "macro") url = `/api/web/discoveries?group=macro&limit=6`;
    else if (n.type === "portfolio") url = `/api/web/discoveries?group=portfolio&limit=6`;
    else if (n.type === "trader") url = `/api/web/discoveries?ai=1&limit=6`;
    const box = $("twNdisc"); if (!url) { box.innerHTML = ""; return; }
    try { const r = await api(url); if (W.sel !== id) return; box.innerHTML = r.items.length ? `<div class="tw-muted tw-small" style="margin-bottom:4px">Linked discoveries</div>` + r.items.map((d) => `<div style="margin-bottom:5px"><a href="#" data-twd="${esc(d.id)}" style="color:var(--text)">${toneI(d.tone)}${esc(d.headline)}</a> <span class="tw-muted tw-small">${etD(d.u)}</span></div>`).join("") : '<div class="tw-muted tw-small">No stored discoveries linked yet.</div>'; } catch { box.innerHTML = ""; }
  }

  // ---------------------------------------------------------------- chat
  function fmtAnswer(txt, m) {
    const lines = esc(txt).split("\n"); let html = "", inL = false;
    for (let l of lines) {
      l = l.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1<i>$2</i>").replace(/\[(\d{1,2})\]/g, (_, n) => `<button type="button" class="cite" data-twc="${n}" data-twm="${m}">[${n}]</button>`);
      if (/^- /.test(l)) { if (!inL) { html += "<ul>"; inL = true; } html += `<li>${l.slice(2)}</li>`; } else { if (inL) { html += "</ul>"; inL = false; } if (l.trim()) html += `<div>${l}</div>`; }
    }
    return html + (inL ? "</ul>" : "");
  }
  function renderChat() {
    const el = $("twThread"); if (!el) return;
    el.innerHTML = W.chat.map((m, i) => m.who === "me" ? `<div class="tw-msg me">${esc(m.text)}</div>` : `<div class="tw-msg sp"><div class="who">SPIDER${m.mode === "claude" ? " · ✦ Claude narrative" : ""}${m.t ? " · " + et(m.t) + " ET" : ""}</div>${m.html || fmtAnswer(m.answer || "", i)}
      ${(m.did || []).length ? `<div class="did">↳ ${m.did.map(esc).join(" · ")}</div>` : ""}${(m.cites || []).length ? `<div class="tw-cites">${m.cites.map((c, n) => `<div><button type="button" class="cite" data-twc="${n + 1}" data-twm="${i}">[${n + 1}]</button> ${esc(c.headline)} — ${esc(c.sources.map((s) => s.name).join(", ") || "THE WEB")} · ${etD(c.u)} ${kindB(c.kind)}</div>`).join("")}</div>` : ""}</div>`).join("") + (W.busy ? '<div class="tw-msg sp"><span class="spin"></span>Searching research memory…</div>' : "");
    el.scrollTop = el.scrollHeight;
  }
  async function ask(q) {
    q = String(q || "").trim(); if (!q || W.busy) return;
    const useClaude = $("twUseClaude") && $("twUseClaude").checked;
    if (useClaude && clNeed(() => ask(q))) return;
    $("twAskIn").value = ""; W.chat.push({ who: "me", text: q }); W.busy = true; renderChat();
    try {
      const headers = { "content-type": "application/json" }; if (useClaude && CL.pass) headers["x-claude-pass"] = CL.pass;
      const r = await api("/api/web/ask", { method: "POST", headers, body: JSON.stringify({ question: q, useClaude }) });
      W.chat.push({ who: "sp", answer: r.answer, cites: r.citations, did: r.did, mode: r.mode, t: r.t });
      if ((r.did || []).length) setTimeout(loadStatus, 800);
    } catch (e) { W.chat.push({ who: "sp", html: `Couldn't answer: ${esc(e.message)}` }); }
    W.busy = false; W.chat = W.chat.slice(-30); renderChat();
  }

  // ---------------------------------------------------------------- Spider cards on Portfolio and AI vs S&P 500
  async function pfCard() {
    const side = document.querySelector("#tab-portfolio .pf-side"); if (!side) return;
    let el = $("webPfCard"); if (!el) { el = document.createElement("div"); el.id = "webPfCard"; el.className = "tw-mini"; side.appendChild(el); }
    const syms = (S.port || []).map((h) => h.symbol), sig = syms.join(",") + "|" + S.pfActive;
    if (sig === W.pfSig && Date.now() - W.pfAt < 60e3) return; W.pfSig = sig; W.pfAt = Date.now();
    if (!syms.length) { el.innerHTML = `<div class="tw-ph">🕸 Spider research<span class="sp"></span></div><div class="tw-muted tw-small">Add holdings and the Spider will start researching them.</div>`; return; }
    try {
      const [r, ex] = await Promise.all([api(`/api/web/discoveries?symbols=${encodeURIComponent(syms.join(","))}&limit=6&since=${Date.now() - 7 * 864e5}&sort=importance`), api(`/api/web/discoveries?group=portfolio&limit=20`)]);
      const mine = new Set(syms), own = ex.items.filter((d) => d.key && (d.key.endsWith(":" + S.pfActive) || d.key.includes(":" + S.pfActive + ":"))).slice(0, 2);
      const list = [...own, ...r.items.filter((d) => d.cat !== "portfolio")].slice(0, 6);
      el.innerHTML = `<div class="tw-ph">🕸 Spider research · this portfolio<span class="sp"></span><button class="tw-btn ghost" type="button" data-twgo="#web">Open THE WEB</button></div>
        ${list.length ? `<div style="display:flex;flex-direction:column;gap:6px">${list.map((d) => `<article class="tw-d" data-twpd="${esc(d.id)}"><div class="top"><span class="imp ${impC(d.importance)}">${d.importance}</span><span class="cat">${esc(CATN[d.cat] || d.cat)}</span><span>${etD(d.u)}</span></div><h4>${toneI(d.tone)}${esc(d.headline)}</h4><div class="bot">${d.tickers.slice(0, 4).map((t) => tick(t, mine)).join(" ")}</div></article>`).join("")}</div>` : '<div class="tw-muted tw-small">No findings on these holdings in the last 7 days yet — the Spider re-checks them every 15 minutes during market hours.</div>'}`;
      el.onclick = (e) => { const g = e.target.closest("[data-twgo]"); if (g) { e.stopPropagation(); return go(g.dataset.twgo); } const d = e.target.closest("[data-twpd]"); if (d) { setTab("web"); setTimeout(() => openDisc(d.dataset.twpd), 300); } };
    } catch { el.innerHTML = ""; }
  }
  async function apCard() {
    const host = $("tab-aitrade"); if (!host || Date.now() - W.apAt < 30e3) return; W.apAt = Date.now();
    let el = $("webApCard"); if (!el) { el = document.createElement("div"); el.id = "webApCard"; el.className = "tw-mini"; const after = $("apMore"); after.parentNode.insertBefore(el, after.nextSibling); }
    try {
      const t = await api("/api/web/trader");
      const P = Object.values(t.packets || {}).sort((a, b) => (t.held.includes(b.sym) - t.held.includes(a.sym)) || Math.abs(b.score) - Math.abs(a.score)).slice(0, 12);
      el.innerHTML = `<div class="tw-ph">🕸 Spider → AI Trader<span class="sp"></span><em>${t.at ? "synced " + since(t.at) : "not synced yet"}</em><button class="tw-btn ghost" type="button" data-twgo="#web">Open THE WEB</button></div>
        <p class="tw-muted tw-small" style="margin:0 0 10px">${esc(t.explain)}</p>
        ${P.length ? `<div class="row">${P.map((p) => `<div class="tw-d" data-twsym="${esc(p.sym)}"><div class="top"><span class="imp ${p.score >= 0.3 ? "" : p.score <= -0.3 ? "l" : "m"}" style="${p.score <= -0.3 ? "background:var(--down);color:#fff" : ""}">${p.score >= 0 ? "+" : ""}${p.score.toFixed(2)}</span><span class="cat">${esc(p.sym)}${t.held.includes(p.sym) ? " · held" : " · candidate"}</span><span>${p.n} finding${p.n === 1 ? "" : "s"}</span></div><p style="margin-top:4px">${esc((p.reasons[0] || "No directional research yet").replace(/^[▲▼] /, ""))}</p></div>`).join("")}</div>` : '<div class="tw-muted tw-small">The Spider hasn\'t synced research with AI Trader yet — it does every 10 minutes during market hours.</div>'}`;
      el.onclick = (e) => { const g = e.target.closest("[data-twgo]"); if (g) return go(g.dataset.twgo); const s = e.target.closest("[data-twsym]"); if (s) { setTab("web"); setTimeout(() => ask(`What has changed about ${s.dataset.twsym} over the last month?`), 300); } };
    } catch { el.innerHTML = ""; }
  }
  const _rp = renderPortfolio; renderPortfolio = function () { const r = _rp.apply(this, arguments); try { pfCard(); } catch {} return r; };
  const _ap = apLoadView; apLoadView = async function () { const r = await _ap.apply(this, arguments); try { apCard(); } catch {} return r; };


  // ---------------------------------------------------------------- the crawling Spider
  // It walks the edges of the visible part of THE WEB page. Fast while a research job is really running, a slow
  // wander when the backend is idle, stopped (red) on an error or lost connection; it turns around when a new job starts.
  const CR = { el: null, raf: 0, s: 0, dir: 1, last: 0, job: null, flip: 0 };
  function crawlerEl() {
    if (CR.el) return CR.el;
    const legs = [[-1, -1, "la"], [-1, -0.35, "lb"], [-1, 0.35, "la"], [-1, 1, "lb"], [1, -1, "lb"], [1, -0.35, "la"], [1, 0.35, "lb"], [1, 1, "la"]].map(([sx, sy, g]) =>
      `<g class="${g}"><path class="leg" d="M${15 + sx * 3} ${15 + sy * 3} Q${15 + sx * 9} ${15 + sy * 5 - 4} ${15 + sx * 13} ${15 + sy * 10 + 1}"/></g>`).join("");
    const el = document.createElement("div"); el.className = "tw-crawler idle"; el.setAttribute("role", "button"); el.setAttribute("tabindex", "0");
    el.innerHTML = `<svg viewBox="0 0 30 30" aria-hidden="true">${legs}<ellipse class="body" cx="15" cy="17" rx="4.6" ry="6"/><circle class="body" cx="15" cy="9.5" r="3"/><circle class="eye" cx="13.8" cy="8.6" r=".9"/><circle class="eye" cx="16.2" cy="8.6" r=".9"/></svg><span class="tip"></span>`;
    el.onclick = () => { const a = $("twAct"); if (a) a.scrollIntoView({ behavior: "smooth", block: "start" }); };
    document.body.appendChild(el); return (CR.el = el);
  }
  function crawlStep(t) {
    const el = CR.el, root = $("tab-web"); if (!el || !W.open || !root) return;
    const dt = Math.min(0.05, (t - (CR.last || t)) / 1000); CR.last = t;
    const nav = document.getElementById("tabs"), top0 = nav ? nav.getBoundingClientRect().bottom : 0, r = root.getBoundingClientRect();
    const L = Math.max(r.left, 0) + 4, R = Math.min(r.right, innerWidth) - 34, T = Math.max(r.top, top0) + 4, B = Math.min(r.bottom, innerHeight) - 34;
    if (R - L < 60 || B - T < 60) { el.style.display = "none"; CR.raf = requestAnimationFrame(crawlStep); return; }
    el.style.display = "";
    const s0 = W.offline ? "offline" : W.st ? W.st.state : "idle", busy = !["idle", "error", "offline"].includes(s0);
    const job = W.st && W.st.running ? W.st.running.id : null;
    if (job && job !== CR.job) CR.dir = -CR.dir; // a new job started: turn around
    CR.job = job;
    const speed = s0 === "error" || s0 === "offline" ? 0 : busy ? 95 : 22, w = R - L, h = B - T, P = 2 * (w + h);
    const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) CR.s = (((CR.s + CR.dir * speed * dt) % P) + P) % P;
    let x, y, ang, d = CR.s;
    if (d < w) { x = L + d; y = T; ang = 90; } else if ((d -= w) < h) { x = R; y = T + d; ang = 180; } else if ((d -= h) < w) { x = R - d; y = B; ang = 270; } else { d -= w; x = L; y = B - d; ang = 0; }
    if (CR.dir < 0) ang += 180;
    el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${ang}deg)`;
    el.style.setProperty("--gait", busy ? ".16s" : ".55s");
    el.className = "tw-crawler " + (busy ? "busy" : s0) + (speed === 0 || reduce ? " stopped" : "");
    const tip = el.querySelector(".tip"), label = W.offline ? "Disconnected — retrying" : W.st && W.st.running ? `${STATE[s0] || s0}: ${W.st.running.label}` : `${STATE[s0] || s0}${W.st && W.st.queue[0] ? " — next: " + W.st.queue[0].label : ""}`;
    if (tip.textContent !== label) { tip.textContent = label; el.setAttribute("aria-label", "Spider: " + label); }
    tip.style.transform = `rotate(${-ang}deg)`; tip.style.transformOrigin = "-19px 13px";
    CR.raf = requestAnimationFrame(crawlStep);
  }
  function crawlStart() { crawlerEl(); cancelAnimationFrame(CR.raf); CR.last = 0; CR.raf = requestAnimationFrame(crawlStep); }
  function crawlStop() { cancelAnimationFrame(CR.raf); if (CR.el) CR.el.style.display = "none"; }

  // ---------------------------------------------------------------- open / close
  window.webOpen = function () {
    shell(); W.open = true; crawlStart(); loadStatus(); loadFeed(true); loadBrief(W.viewing || "latest"); loadGraph(); pushCtx(true);
    clearInterval(W.poll); W.poll = setInterval(() => { if (!document.hidden) loadStatus(); }, 4000);
    W.feedPoll = W.feedPoll || setInterval(() => { if (W.open && !document.hidden) loadFeed(); }, 30e3);
  };
  window.webClose = function () { W.open = false; crawlStop(); clearInterval(W.poll); W.poll = null; };
  // background: keep the nav indicator honest and share context once the page loads
  if (S.tab === "web") window.webOpen(); // the page opened straight on #web (setTab ran before this script loaded)
  setTimeout(() => { pushCtx(true); loadStatus(); }, 2500);
  W.navPoll = setInterval(() => { if (!W.open && !document.hidden) loadStatus(); }, 30e3);
})();

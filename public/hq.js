/* Bot HQ — the bots' control room, laid out like an agentic trading desk: brain core, research map, strategies,
 * rulebook and an agent room. Reads only the bots' and the spider's own APIs; calculations live in hq-core.js. */
(function () {
  "use strict";
  const C = window.MDHQCore, RULES = window.MDHQRules || [];
  const $ = (id) => document.getElementById(id);
  const h = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n, d = 0) => (Number.isFinite(n) ? (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }) : "—");
  const pct = (n, d = 2) => (Number.isFinite(n) ? (n >= 0 ? "+" : "−") + Math.abs(n * 100).toFixed(d) + "%" : "—");
  const cls = (n) => (Number.isFinite(n) && n !== 0 ? (n > 0 ? "up" : "down") : "");
  const fmtN = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "—");
  const tm = (t) => (t ? new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
  const when = (t) => (t ? new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  const get = (p) => fetch(p, { credentials: "same-origin", cache: "no-store" }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; });
  const D = { raw: {}, bots: [], spider: null, view: "globe", botId: null, sel: "swing", tab: "overview", rule: 0, agent: null, rot: 0.12 };
  const OR = "#ff991f", UP = "#3ddc84", DN = "#ff5a5a", AM = "#ffb85c", GR = "#cfcfcf";

  // ---------------------------------------------------------------- canvas helpers
  function setup(cv) {
    if (!cv) return null; const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; if (!r.width || !r.height) return null;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, r.width, r.height); return { c, w: r.width, hh: r.height };
  }
  function spark(cv, vals, color = OR) {
    const k = setup(cv); if (!k || !vals || vals.length < 2) return; const { c, w, hh } = k, mn = Math.min(...vals), mx = Math.max(...vals);
    c.strokeStyle = color; c.lineWidth = 1.2; c.beginPath(); vals.forEach((v, i) => { const x = (i / (vals.length - 1)) * w, y = hh - 2 - ((v - mn) / (mx - mn || 1)) * (hh - 4); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
  }
  function line(cv, series, { fmt = (v) => v.toFixed(0), zero = false } = {}) {
    const k = setup(cv); if (!k) return; const { c, w, hh } = k, P = { l: 56, r: 10, t: 10, b: 14 };
    const all = series.flatMap((s) => s.values.filter(Number.isFinite)); if (all.length < 2) { c.fillStyle = "#565656"; c.font = "12px sans-serif"; c.fillText("Builds as the bot trades", 14, 24); return; }
    let mn = Math.min(...all), mx = Math.max(...all); if (zero) { mn = Math.min(mn, 0); mx = Math.max(mx, 0); }
    const n = Math.max(...series.map((s) => s.values.length)), X = (i) => P.l + (i / Math.max(1, n - 1)) * (w - P.l - P.r), Y = (v) => P.t + (1 - (v - mn) / (mx - mn || 1)) * (hh - P.t - P.b);
    c.font = "10px monospace"; for (let q = 0; q <= 3; q++) { const v = mn + ((mx - mn) * q) / 3; c.strokeStyle = "#181818"; c.beginPath(); c.moveTo(P.l, Y(v)); c.lineTo(w - P.r, Y(v)); c.stroke(); c.fillStyle = "#565656"; c.fillText(fmt(v), 4, Y(v) + 3); }
    for (const s of series) {
      c.beginPath(); let st = false; s.values.forEach((v, i) => { if (!Number.isFinite(v)) return; if (st) c.lineTo(X(i), Y(v)); else { c.moveTo(X(i), Y(v)); st = true; } });
      c.strokeStyle = s.color; c.lineWidth = s.width || 1.5; c.globalAlpha = s.alpha || 1; c.stroke(); c.globalAlpha = 1;
      if (s.fill) { const base = Y(zero ? 0 : mn); c.lineTo(X(s.values.length - 1), base); c.lineTo(X(0), base); c.closePath(); const g = c.createLinearGradient(0, P.t, 0, hh); g.addColorStop(0, s.fill); g.addColorStop(1, "rgba(0,0,0,0)"); c.fillStyle = g; c.fill(); }
    }
  }

  // ---------------------------------------------------------------- navigation
  document.querySelectorAll("nav.side [data-v]").forEach((b) => (b.onclick = () => show(b.dataset.v)));
  function show(v) {
    D.view = v;
    document.querySelectorAll("nav.side [data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.id === "v-" + v));
    document.body.classList.toggle("home", v === "globe");
    $("backbar").hidden = v === "globe";
    $("crumb").textContent = ({ overview: "Overview", lab: "Lab", research: "Research", strategies: "Strategies", rules: "Rulebook", room: "Inside the globe", paper: "Paper & live", decisions: "Decisions", costs: "Costs", machines: "Machines", bot: "Agent" })[v] || "";
    try { history.replaceState(null, "", "#" + v + (v === "bot" && D.botId ? "/" + D.botId : "")); } catch {}
    render();
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && D.agent) { D.agent = null; agentCard(); } });

  // ---------------------------------------------------------------- data
  async function loadBots() {
    const names = ["autopilot", "daytrader", "quanttrader", "strategy-lab", "desk-risk", "brief", "web/signals", "web/discoveries?limit=200", "system/health"];
    const res = await Promise.allSettled(names.map((n) => get("/api/" + n)));
    // a request that fails (e.g. while the public server restarts after an update) keeps the last good answer
    const keys = ["swing", "day", "quant", "lab", "desk", "brief", "signals", "finds", "sys"], prev = D.raw || {};
    const v = (i) => (res[i].status === "fulfilled" ? res[i].value : prev[keys[i]] || null);
    D.raw = { swing: v(0), day: v(1), quant: v(2), lab: v(3), desk: v(4), brief: v(5), signals: v(6), finds: v(7), sys: v(8) };
    const bad = res.filter((r) => r.status === "rejected");
    $("errBox").innerHTML = bad.length === names.length ? `<div class="err">Bot HQ can't reach the bots (${h(bad[0].reason && bad[0].reason.message)}). Keep Market Desk running, or sign in.</div>` : "";
    D.bots = [C.fromMain("swing", D.raw.swing), C.fromMain("day", D.raw.day), C.fromMain("quant", D.raw.quant), ...C.fromLab(D.raw.lab)].filter(Boolean);
    render();
  }
  // ---- chat with the Coach (VP of Finance): plain-English instructions the bots obey (coach-orders-core.js on the server)
  D.chat = { messages: [], instructions: [], busy: false, err: null };
  async function loadChat() { try { const j = await get("/api/coach/chat"); D.chat.messages = j.messages || []; D.chat.instructions = j.instructions || []; D.chat.ai = j.ai || null; D.chat.err = null; } catch (e) { D.chat.err = e.message; } if (D.view === "bot" && D.botId === "coach") paintChat(); }
  async function sendChat(text) {
    D.chat.busy = true; D.chat.messages = [...D.chat.messages, { t: Date.now(), who: "you", text }]; paintChat();
    try {
      const r = await fetch("/api/coach/chat", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      D.chat.messages = j.messages || D.chat.messages; D.chat.instructions = j.instructions || []; D.chat.ai = j.ai || D.chat.ai; D.chat.err = null;
    } catch (e) { D.chat.err = e.message; }
    D.chat.busy = false; paintChat(); const i = $("chatIn"); if (i) i.focus();
  }
  function chatHtml() {
    const c = D.chat, msgs = c.messages.slice(-30);
    return `<div class="card" style="margin-top:12px"><div class="ch">Talk to the Coach <em>· tell any bot what to buy, avoid or stop doing</em></div><div class="cb">
      <div id="chatLog" class="chatlog">${msgs.length ? msgs.map((m) => `<div class="msg ${m.who === "you" ? "me" : "coach"}"><small>${m.who === "you" ? "YOU" : "COACH"} · ${h(when(m.t))}</small><div>${h(m.text).replace(/\n/g, "<br>")}</div></div>`).join("") : '<div class="note">Try: “tell swing trader to buy nvda”, “swing bot invest $2,000 in microsoft”, “never buy TSLA for 2 weeks”, “day trader no shorts”, “pause the quant”, “half size”, “list”.</div>'}${c.busy ? '<div class="msg coach"><small>COACH</small><div>…</div></div>' : ""}</div>
      ${c.err ? `<div class="err" style="margin-top:6px">${h(c.err)}</div>` : ""}
      <form id="chatForm" class="chatform"><input id="chatIn" autocomplete="off" maxlength="300" placeholder="e.g. tell swing trader to buy nvda" ${c.busy ? "disabled" : ""}><button ${c.busy ? "disabled" : ""}>Send</button></form>
      <div class="dim mono" style="font-size:10px;letter-spacing:.14em;margin-top:12px">YOUR STANDING INSTRUCTIONS</div>
      ${c.instructions.length ? c.instructions.map((x) => `<div class="row"><span><b class="or">#${x.id}</b> ${h(x.text)}${x.status === "queued" ? ' <span class="tag warn">order sent</span>' : ""}</span></div>`).join("") : '<div class="note">None. The bots follow their own rules and the Coach\'s fixes.</div>'}
      <div class="note">${c.ai && c.ai.on ? `Understands plain English and answers questions with Google Gemini (free tier${c.ai.model ? ", " + h(c.ai.model) : ""}) · ${c.ai.usedToday || 0} of ${c.ai.cap} messages today${c.ai.lastError ? ` · last problem: ${h(c.ai.lastError)}` : ""}. Every instruction it reads still goes through the Coach's rules, and it repeats back what it understood.` : "Basic mode: a free rule-based interpreter that follows instructions but can't answer open questions. Add a free GEMINI_API_KEY on Render to let it understand any phrasing and answer questions."} Paper money only. Your instructions outrank the Coach's fixes; stops still protect anything you ask a bot to buy.</div></div></div>`;
  }
  function paintChat() {
    const box = $("chatBox"); if (!box) return; box.innerHTML = chatHtml();
    const log = $("chatLog"); if (log) log.scrollTop = log.scrollHeight;
    const f = $("chatForm"); if (f) f.onsubmit = (e) => { e.preventDefault(); const v = $("chatIn").value.trim(); if (v && !D.chat.busy) sendChat(v); };
  }
  async function loadPm() { try { D.pm = await get("/api/premarket?run=1"); D.pmErr = null; } catch (e) { D.pmErr = e.message; } const b = $("pmBox"); if (b) b.innerHTML = pmHtml(); }
  // Pre-Market Desk: real pre-market / after-hours prints and what the bots do with them
  function pmHtml() {
    const p = D.pm; if (!p) return `<div class="card" style="margin-top:12px"><div class="ch">Pre-Market Desk</div><div class="cb">${D.pmErr ? `<div class="err">${h(D.pmErr)}</div>` : '<div class="empty">Loading…</div>'}</div></div>`;
    const r = p.report, ph = { pre: "PRE-MARKET · LIVE", after: "AFTER-HOURS · LIVE", off: "OFF · next run 6:00 AM ET" }[p.phase] || p.phase;
    const pct = (x) => `<span class="mono ${x >= 0 ? "up" : "down"}">${x >= 0 ? "+" : ""}${x.toFixed(2)}%</span>`;
    const list = (a) => a.length ? a.slice(0, 10).map((x) => `<div class="row"><span>${h(x.sym)} <span class="dim">${h(x.name || "")}</span></span><span class="mono">$${x.price.toFixed(2)} ${pct(x.gapPct)}</span></div>`).join("") : '<div class="note">None at ±2% or more.</div>';
    return `<div class="card" style="margin-top:12px"><div class="ch">Pre-Market Desk <em>· ${h(ph)}${r ? ` · scanned ${h(when(r.t))} · ${r.live} with live prints` : ""}</em></div><div class="cb">
      ${p.alerts.length ? `<div class="dim mono" style="font-size:10px;letter-spacing:.14em">BOT HOLDINGS MOVING</div>${p.alerts.map((a) => `<div class="row" style="display:block"><span class="tag ${a.kind === "gapUp" ? "ok" : "bad"}">${a.kind === "stop" ? "Under stop" : a.kind === "gapUp" ? "Gap up" : "Gap down"}</span> ${h(a.text)}</div>`).join("")}` : r ? '<div class="note">No bot holding is moving 5%+ or sitting under its stop.</div>' : ""}
      ${r ? `<div class="grid g2" style="margin-top:8px"><div><div class="dim mono" style="font-size:10px;letter-spacing:.14em">GAPPING UP</div>${list(r.up)}</div><div><div class="dim mono" style="font-size:10px;letter-spacing:.14em">GAPPING DOWN</div>${list(r.down)}</div></div>` : '<div class="empty">No scan yet today.</div>'}
      ${p.guarded.length ? `<div class="note">Swing bot won't open new positions in ${p.guarded.map(h).join(", ")} until ${p.rules.guardMin} min after the open (gap of ${p.rules.bigGapPct}%+).</div>` : ""}
      <div class="note">Runs ${h(p.rules.window)} every 5 minutes. Gaps are real extended-hours trades vs yesterday's close; prints older than ${p.rules.freshMin} min are ignored. The day trader scans the biggest gappers first at the open. Paper money only.</div>
    </div></div>`;
  }
  async function loadDr(run) { try { D.dr = await get("/api/doctor" + (run ? "?run=1" : "")); D.drErr = null; } catch (e) { D.drErr = e.message; } const b = $("drBox"); if (b) b.innerHTML = drHtml(); const btn = $("drRun"); if (btn) btn.onclick = () => { btn.disabled = true; btn.textContent = "Checking…"; loadDr(true); }; }
  // System Doctor: what it checked, what it fixed on its own, and what needs a code change
  function drHtml() {
    const d = D.dr; if (!d) return `<div class="card" style="margin-top:12px"><div class="ch">System Doctor</div><div class="cb">${D.drErr ? `<div class="err">${h(D.drErr)}</div>` : '<div class="empty">Loading…</div>'}</div></div>`;
    const tag = (x) => x.fix === "auto" ? '<span class="tag ok">Fixed itself</span>' : x.fix === "code" ? '<span class="tag bad">Needs code fix</span>' : '<span class="tag warn">Watching</span>';
    const fs = d.findings.map((x) => `<div class="row" style="display:block">${tag(x)} ${h(x.text)}${x.issue ? ` · <a href="${h(x.issue.url)}" target="_blank" rel="noopener">issue #${x.issue.number}</a>` : ""}${x.healed && x.healed.action ? `<div class="note">Action: ${h(x.healed.action.replace(/-/g, " "))}</div>` : ""}</div>`).join("");
    return `<div class="card" style="margin-top:12px"><div class="ch">System Doctor <em>· ${d.at ? "last check " + h(when(d.at)) : "no check yet"} · ${h(d.schedule)}</em> <button class="btn" id="drRun" style="float:right;font-size:11px;padding:2px 8px">Check now</button></div><div class="cb">
      ${d.at ? (fs || '<div class="note">All clear: quotes, pre-market math, the 1D chart, bot loops, server errors and your browser all checked out.</div>') : '<div class="empty">The first check runs a few minutes after the server starts.</div>'}
      ${d.heals.length ? `<div class="dim mono" style="font-size:10px;letter-spacing:.14em;margin-top:10px">RECENT AUTOMATIC FIXES</div>${d.heals.slice(0, 6).map((x) => `<div class="note">${h(when(x.t))} · ${h(x.action.replace(/-/g, " "))} · ${h(x.text)}</div>`).join("")}` : ""}
      <div class="note">${d.github.on ? "Code-level bugs are filed as GitHub issues for the scheduled fixer." : "Code-level bugs are listed here. Add a GITHUB_TOKEN on Render to have them filed for the scheduled fixer."}${d.github.error ? " GitHub: " + h(d.github.error) : ""}</div>
    </div></div>`;
  }
  async function loadCoach() { try { D.coach = await get("/api/coach"); D.coachErr = null; } catch (e) { D.coachErr = e.message; } if (D.view === "bot" && D.botId === "coach") botPage(); }
  async function loadSpider() { try { D.spider = await get("/api/web/status"); } catch { D.spider = null; } render(true); }
  const finds = () => ((D.raw.finds && D.raw.finds.items) || []);
  const checks = () => ((D.raw.swing && D.raw.swing.teamwork && D.raw.swing.teamwork.checks) || []);
  function gates() {
    const out = [], lab = D.raw.lab && D.raw.lab.toughness;
    for (const m of (lab && lab.mainBots) || []) out.push({ name: m.bot, ...m });
    for (const b of D.bots.filter((x) => x.toughness)) out.push({ name: b.name, ...b.toughness });
    return out;
  }

  // ---------------------------------------------------------------- top bar + tape
  function top() {
    const sp = D.spider, run = sp && sp.running;
    $("pSpider").className = "pill hs " + (run ? "busy" : sp ? "on" : ""); $("pSpider").lastChild.textContent = run ? "SPIDER reads" : sp ? "SPIDER idle" : "SPIDER offline";
    const open = D.raw.swing && D.raw.swing.marketOpen; $("pBots").className = "pill hs " + (open ? "on" : D.bots.length ? "busy" : "");
    $("pBots").lastChild.textContent = `${D.bots.length} BOTS ${open ? "trading" : "waiting for the open"}`;
    $("sJobs").textContent = fmtN(sp && sp.stats ? sp.stats.total : null);
    const paused = gates().filter((g) => g.status === "fail").length, vetoes = checks().filter((c) => c.verdict === "veto").length;
    $("sDec").textContent = paused + vetoes; $("nDec").textContent = paused + vetoes; $("nRules").textContent = RULES.length;
    $("resDot").className = "dot" + (run ? " on" : "");
    $("footState").textContent = run ? "brain running" : sp ? "brain idle" : "brain offline";
  }
  setInterval(() => { $("clock").innerHTML = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }) + "<small>ET</small>"; }, 1000);
  function events() {
    const out = [];
    for (const j of (D.spider && D.spider.recent) || []) out.push({ t: j.ended || j.started, v: j.status === "error" ? "veto" : "read", verb: j.status === "error" ? "FAILED" : "READ", text: `${j.label}${j.summary ? " · " + j.summary : ""}` });
    for (const b of D.bots.filter((x) => x.group === "main")) for (const t of b.trades.slice(0, 12)) out.push({ t: t.t, v: "trade", verb: t.side, text: `${b.name} · ${t.sym}${t.pnl != null ? ` (${money(t.pnl)})` : ""} · ${String(t.why || "").slice(0, 90)}` });
    for (const c of checks()) out.push({ t: c.t, v: c.verdict === "veto" ? "veto" : "check", verb: c.verdict === "veto" ? "VETO" : "CHECK", text: `${c.sym} · ${c.note}` });
    return out.filter((x) => x.t).sort((a, b) => b.t - a.t);
  }
  let tapeKey = "";
  function tape(ev) {
    const row = ev.slice(0, 16).map((x) => `<span><span class="dim">${h(tm(x.t))}</span> <span class="v ${x.v}">${h(x.verb)}</span>${h(x.text.slice(0, 120))}</span>`).join("");
    if (row === tapeKey) return; tapeKey = row; $("tape").innerHTML = row ? row + row : "<span>Waiting for the first activity…</span>";
  }

  // ---------------------------------------------------------------- render switch
  function render(light) {
    top(); tape(events());
    if (D.view === "overview") overview(light);
    else if (D.view === "globe") globeUi(light);
    else if (D.view === "bot") botPage(light);
    else if (D.view === "lab" && !light) lab();
    else if (D.view === "research") research();
    else if (D.view === "strategies" && !light) strategies();
    else if (D.view === "rules" && !light) rule();
    else if (D.view === "room") agentCard();
    else if (D.view === "paper" && !light) paper();
    else if (D.view === "decisions" && !light) declog();
    else if (D.view === "costs" && !light) costs();
    else if (D.view === "machines" && !light) machines();
  }

  // ---------------------------------------------------------------- OVERVIEW
  const brain = { a: 0, left: [], right: [], busy: false, pts: null };
  function overview(light) {
    const sp = D.spider || {}, st = sp.stats || {}, sig = (D.raw.signals && D.raw.signals.items) || [], g = gates(), tested = g.filter((x) => x.checks);
    const passed = tested.filter((x) => x.status === "pass").length, trading = D.bots.filter((b) => !(b.toughness && b.toughness.status === "fail")).length;
    const cell = (k, v, sub, dot, extra = "") => `<div><small>${dot ? `<i style="background:${dot}"></i>` : ""}${k}</small><b>${v}</b><span>${sub}</span>${extra}</div>`;
    $("strip").innerHTML = cell("RESEARCHED", fmtN(st.total), "spider jobs run") + cell("FINDINGS", fmtN(st.memory), "in research memory") + cell("SIGNALS", fmtN(sig.length), `${sig.filter((s) => s.dir < 0).length} negative`, OR)
      + cell("CHECKED", fmtN(checks().length), `${checks().filter((c) => c.verdict === "veto").length} vetoed`, AM) + cell("PASSED TEST", tested.length ? `${passed}` : "—", tested.length ? `of ${tested.length} tested` : "first test after a close", UP)
      + cell("ON PAPER", String(trading), `of ${D.bots.length} bots`, "", `<div class="bar"><s style="width:${D.bots.length ? (trading / D.bots.length) * 100 : 0}%"></s></div>`)
      + cell("LIVE", "—", "", "", '<div class="wait">paper money only</div>') + cell("AI BUDGET", "$0", "of $0 · free data", "", '<div class="bar"><s style="width:0"></s></div>');
    // brain inputs (left) and outputs (right), each with a sparkline of the last six hours
    const now = Date.now(), ins = C.sourceCounts(finds(), now), trades7 = D.bots.flatMap((b) => b.trades).filter((t) => t.t && now - t.t < 7 * 864e5);
    const outs = [{ label: "SIGNALS", n: sig.length, sub: "named research signals", spark: C.buckets(sig.map((s) => (s.inputs && s.inputs[0] && s.inputs[0].at) || 0), { now }), color: OR },
      { label: "PRE-BUY CHECKS", n: checks().length, sub: "vetoes and cautions", spark: C.buckets(checks().map((c) => c.t), { now }), color: AM },
      { label: "TRADES", n: trades7.length, sub: "paper fills, last 7 days", spark: C.buckets(trades7.map((t) => t.t), { now, size: 864e5 / 2, n: 14 }), color: UP }];
    const wrap = $("brainWrap"), W = wrap.clientWidth;
    wrap.querySelectorAll(".src,.colhead,.nowline").forEach((n) => n.remove());
    const run = sp.running; brain.busy = !!run;
    $("brainState").innerHTML = run ? '<span class="or">● brain running</span>' : "● brain idle";
    const add = (html, style) => { const d = document.createElement("div"); d.innerHTML = html; const n = d.firstChild; Object.assign(n.style, style); wrap.appendChild(n); return n; };
    add(`<div class="nowline"><b>NOW</b>${h(run ? `the spider: ${run.label}` : "the spider is idle")}</div>`, { top: "14px" });
    add(`<div class="nowline"><b>READING</b>${h(run ? run.note || run.phase || run.label : ((sp.queue && sp.queue[0] && "next: " + sp.queue[0].label) || "nothing queued"))}</div>`, { bottom: "10px" });
    add(`<div class="colhead">SOURCES TODAY &nbsp; Σ ${ins.reduce((a, x) => a + x.n, 0)}</div>`, { left: "18px", top: "60px" });
    add('<div class="colhead">OUTPUT</div>', { right: "148px", top: "60px" });
    brain.left = ins.map((x, i) => { const y = 82 + i * 84; const n = add(`<div class="src"><small>${h(x.label.toUpperCase())}</small><b>${x.n}</b><canvas></canvas></div>`, { left: "18px", top: y + "px" }); spark(n.querySelector("canvas"), x.spark, GR); return { x: 18 + 172, y: y + 30, n: x.n }; });
    brain.right = outs.map((x, i) => { const y = 92 + i * 102; const n = add(`<div class="src out"><small>${h(x.label)}</small><b>${x.n}</b><canvas></canvas><div class="sub">${h(x.sub)}</div></div>`, { right: "18px", top: y + "px" }); spark(n.querySelector("canvas"), x.spark, x.color); return { x: W - 18 - 172, y: y + 30, n: x.n, color: x.color }; });
    // jobs per minute, last 30 minutes
    const per = Array(30).fill(0); for (const j of sp.recent || []) { const k = Math.floor((now - (j.started || 0)) / 60e3); if (k >= 0 && k < 30) per[29 - k]++; }
    const mx = Math.max(1, ...per); $("epm").innerHTML = per.map((v) => `<i class="${v ? "h" : ""}" style="height:${Math.max(2, (v / mx) * 22)}px"></i>`).join("");
    if (light) return;
    const b = D.raw.brief, col = (t) => `<div class="dim mono" style="font-size:10px;letter-spacing:.14em;margin-bottom:6px">${t}</div>`;
    $("report").innerHTML = b ? `<div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div>${col("WHAT CAME IN OVERNIGHT")}${b.overnight.length ? b.overnight.slice(0, 5).map((d) => `<div class="row"><span>${h(d.headline)}</span></div>`).join("") : '<div class="empty">Nothing new since the close.</div>'}</div>
      <div>${col("PLANS FOR THE OPEN")}${b.plans.map((p) => `<div class="row"><span>${h(p.bot)}</span><span class="muted">${p.orders.length ? p.orders.slice(0, 4).map((o) => `${h(o.side)} ${h(o.sym)}`).join(", ") : h(p.empty)}</span></div>`).join("")}</div>
      <div>${col("RISK FLAGS")}${b.flags.length ? b.flags.slice(0, 6).map((f) => `<div class="row"><span class="${f.level === "high" ? "down" : f.level === "med" ? "or" : ""}">${h(f.text)}</span></div>`).join("") : '<div class="empty">None this morning.</div>'}</div></div>`
      : '<div class="empty">Not measured yet: the report fills in once the spider and the bots have run.</div>';
    const pp = C.pipeline({ spider: D.spider, signals: D.raw.signals, swing: D.raw.swing }); pp.push({ label: "On paper", value: trading });
    $("pipe").innerHTML = pp.map((s, i) => `<div class="st ${i >= pp.length - 2 ? "ok" : i >= 2 ? "hot" : ""}"><div class="n"></div><small>${h(s.label.toUpperCase())}</small><b>${s.value == null ? "—" : fmtN(s.value)}</b></div>`).join("");
    $("decCount").textContent = `${g.filter((x) => x.status === "fail").length} paused`;
    $("decisions").innerHTML = g.length ? g.slice(0, 6).map((x) => `<div class="decision ${x.status === "fail" ? "pause" : x.status === "pass" ? "pass" : ""}"><small>${x.status === "fail" ? "NEW BUYS PAUSED" : x.status === "pass" ? "TRADING · PASSED" : "TRADING · WAITING FOR DATA"}</small><h4>${h(x.name)}</h4><p>${h(x.label || "")}${x.detail ? " · " + h(x.detail) : ""}</p></div>`).join("") : '<div class="empty">The first toughness results arrive after the next market close.</div>';
  }
  function drawBrain() {
    if (D.view !== "overview") return; const k = setup($("brain")); if (!k) return; const { c, w, hh } = k;
    const cx = w / 2, cy = hh / 2 + 6, R = Math.min(w * 0.19, hh * 0.36); brain.a += brain.busy ? 0.006 : 0.0025;
    const flows = [...brain.left.map((p) => ({ from: [p.x, p.y], to: [cx - R * 0.95, cy + (p.y - cy) * 0.35], color: GR, n: p.n })), ...brain.right.map((p) => ({ from: [cx + R * 0.95, cy + (p.y - cy) * 0.35], to: [p.x, p.y], color: p.color, n: p.n }))];
    for (const f of flows) {
      const [x1, y1] = f.from, [x2, y2] = f.to, mx = (x1 + x2) / 2;
      for (let s = -2; s <= 2; s++) { c.strokeStyle = f.color; c.globalAlpha = s === 0 ? 0.22 : 0.07; c.beginPath(); c.moveTo(x1, y1 + s * 2); c.bezierCurveTo(mx, y1 + s * 2, mx, y2 + s * 3, x2, y2 + s * 3); c.stroke(); }
      c.globalAlpha = 1;
      const count = Math.min(6, 1 + Math.floor(Math.log2(1 + (f.n || 0))));
      for (let i = 0; i < count; i++) {
        const t = (brain.a * (brain.busy ? 20 : 9) + i / count + (y1 % 7) / 7) % 1, u = 1 - t;
        const x = u * u * u * x1 + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * x2, y = u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2;
        c.fillStyle = f.color; c.shadowColor = f.color; c.shadowBlur = 8; c.beginPath(); c.arc(x, y, 1.7, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0;
      }
    }
    if (!brain.pts) { brain.pts = []; for (let i = 0; i < 1500; i++) { const y = 1 - (i / 1499) * 2, r = Math.sqrt(1 - y * y), th = i * 2.39996; brain.pts.push([Math.cos(th) * r, y, Math.sin(th) * r]); } }
    const sa = Math.sin(brain.a), ca = Math.cos(brain.a);
    for (const [x, y, z] of brain.pts) { const X = x * ca + z * sa, Z = -x * sa + z * ca, d = (Z + 1) / 2, s = 0.5 + d; c.fillStyle = `rgba(${brain.busy ? "255,196,130" : "225,225,225"},${0.05 + d * 0.62})`; c.fillRect(cx + X * R, cy + y * R, s, s); }
    c.strokeStyle = "rgba(120,120,120,.14)"; const L = 14, bx = R * 1.25, by = R * 1.12; [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => { c.beginPath(); c.moveTo(cx + sx * bx, cy + sy * by + -sy * L); c.lineTo(cx + sx * bx, cy + sy * by); c.lineTo(cx + sx * bx - sx * L, cy + sy * by); c.stroke(); });
  }

  // ---------------------------------------------------------------- GLOBE (home): sources funnel in, results flow out, agents inside
  const G = { open: false, z: 0, pts: null, a: 0, nodes: [], hover: null, chips: [], uiKey: "" };
  const PORTS = [["overview", "Overview"], ["strategies", "Strategies"], ["lab", "Lab"], ["rules", "Rulebook"], ["costs", "Costs"], ["machines", "Machines"]];
  const portX = (i, W) => Math.round(W / 2 + (i - (PORTS.length - 1) / 2) * Math.min(150, (W - 440) / PORTS.length));
  const portN = (v) => (v === "strategies" ? D.bots.length : v === "lab" ? gates().filter((g) => g.checks).length : v === "rules" ? RULES.length : v === "costs" ? "$0 AI" : v === "machines" ? (D.raw.sys ? "ok" : "—") : "all numbers");
  function globeUi() {
    const ui = $("globeUi"), wrap = ui.parentElement, W = wrap.clientWidth, H = wrap.clientHeight, sp = D.spider || {}, run = sp.running, now = Date.now();
    const sig = (D.raw.signals && D.raw.signals.items) || [], trades7 = D.bots.flatMap((b) => b.trades).filter((t) => t.t && now - t.t < 7 * 864e5);
    const ins = C.sourceCounts(finds(), now), outs = [{ label: "SIGNALS", n: sig.length, sub: "named research signals", spark: C.buckets(sig.map((x) => (x.inputs && x.inputs[0] && x.inputs[0].at) || 0), { now }), color: OR },
      { label: "PRE-BUY CHECKS", n: checks().length, sub: "vetoes and cautions", spark: C.buckets(checks().map((c) => c.t), { now }), color: AM },
      { label: "TRADES", n: trades7.length, sub: "paper fills, last 7 days", spark: C.buckets(trades7.map((t) => t.t), { now, size: 864e5 / 2, n: 14 }), color: UP }];
    const key = [G.open, W, H, run ? run.label : "", ins.map((x) => x.n).join(), outs.map((x) => x.n).join(), PORTS.map(([v]) => portN(v)).join()].join("|");
    if (key === G.uiKey) return; G.uiKey = key;
    const ly = (i, n) => Math.round(H / 2 - 34 - ((n - 1) * 88) / 2 + i * 88 - 30);
    ui.innerHTML = ""
      + `<div class="nowline" style="top:22px"><b>NOW</b>${h(run ? `the spider: ${run.label}` : "the spider is idle")}</div>`
      + `<div class="nowline" style="bottom:22px"><b>CLICK THE GLOBE</b>to go inside, where the agents sit at their desks · <span class="dim">${h(run ? run.note || run.phase || "" : (sp.queue && sp.queue[0] ? "next: " + sp.queue[0].label : "nothing queued"))}</span></div>`
      + PORTS.map(([v, l], i) => `<div class="gport" data-go="${v}" style="left:${portX(i, W)}px;top:${H - 92}px">${h(l.toUpperCase())}<b>${portN(v)}</b></div>`).join("")
      + `<div class="colhead" style="left:24px;top:${ly(0, ins.length) - 22}px">SOURCES TODAY &nbsp; Σ ${ins.reduce((a, x) => a + x.n, 0)}</div>`
      + ins.map((x, i) => `<div class="src gsrc" data-kind="${["sec", "company", "earnings", "macro"][i]}" title="Open these findings" style="left:24px;top:${ly(i, ins.length)}px"><small>${h(x.label.toUpperCase())}</small><b>${x.n}</b><canvas></canvas></div>`).join("")
      + `<div class="colhead" style="right:24px;top:${ly(0, outs.length) - 22}px">OUTPUT</div>`
      + outs.map((x, i) => `<div class="src out gsrc" data-go="${["research", "decisions", "paper"][i]}" title="Open" style="right:24px;top:${ly(i, outs.length)}px"><small>${h(x.label)}</small><b>${x.n}</b><canvas></canvas><div class="sub">${h(x.sub)}</div></div>`).join("");
    ui.querySelectorAll("[data-go]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); show(b.dataset.go); }));
    ui.querySelectorAll(".gsrc[data-kind]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); R2.kind = b.dataset.kind; R2.fkey = ""; show("research"); }));
    G.ports = PORTS.map((_, i) => ({ x: portX(i, W), y: H - 92, n: 1, color: OR, side: "port" }));
    const cards = [...ui.querySelectorAll(".gsrc")];
    ins.forEach((x, i) => spark(cards[i].querySelector("canvas"), x.spark, GR));
    outs.forEach((x, i) => spark(cards[ins.length + i].querySelector("canvas"), x.spark, x.color));
    G.flows = [...ins.map((x, i) => ({ side: "in", x: 24 + 172, y: ly(i, ins.length) + 30, n: x.n, color: GR })), ...outs.map((x, i) => ({ side: "out", x: W - 24 - 172, y: ly(i, outs.length) + 30, n: x.n, color: x.color }))];
    const back = $("gBack"); if (back) back.onclick = (e) => { e.stopPropagation(); G.open = false; G.uiKey = ""; globeUi(); };
  }
  function drawGlobe() {
    if (D.view !== "globe") return; const k = setup($("globeCv")); if (!k) return; const { c, w, hh } = k, t = performance.now() / 1000;
    G.z += ((G.open ? 1 : 0) - G.z) * 0.1; G.a += 0.003 + (D.spider && D.spider.running ? 0.003 : 0);
    const cx = w / 2, cy = hh / 2 - 34, R = Math.min(w * 0.2, hh * 0.3) * (1 + 2.5 * G.z * G.z), busy0 = !!(D.spider && D.spider.running);
    // sources funnel into the globe; signals, checks and trades flow out of it
    const fade = 1 - G.z * 0.6;
    for (const f of G.flows || []) {
      const x1 = f.side === "in" ? f.x : cx + R * 0.97, y1 = f.side === "in" ? f.y : cy + (f.y - cy) * 0.3, x2 = f.side === "in" ? cx - R * 0.97 : f.x, y2 = f.side === "in" ? cy + (f.y - cy) * 0.3 : f.y, mx = (x1 + x2) / 2;
      for (let s2 = -2; s2 <= 2; s2++) { c.strokeStyle = f.color; c.globalAlpha = (s2 === 0 ? 0.24 : 0.08) * fade; c.beginPath(); c.moveTo(x1, y1 + s2 * 2); c.bezierCurveTo(mx, y1 + s2 * 2, mx, y2 + s2 * 3, x2, y2 + s2 * 3); c.stroke(); }
      c.globalAlpha = fade; const count = Math.min(7, 2 + Math.floor(Math.log2(1 + (f.n || 0))));
      for (let i = 0; i < count; i++) { const u0 = (t * (busy0 ? 0.32 : 0.16) + i / count + (f.y % 7) / 7) % 1, u = 1 - u0;
        const x = u * u * u * x1 + 3 * u * u * u0 * mx + 3 * u * u0 * u0 * mx + u0 * u0 * u0 * x2, y = u * u * u * y1 + 3 * u * u * u0 * y1 + 3 * u * u0 * u0 * y2 + u0 * u0 * u0 * y2;
        c.fillStyle = f.color; c.shadowColor = f.color; c.shadowBlur = 8; c.beginPath(); c.arc(x, y, 1.8, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0; }
      c.globalAlpha = 1;
    }
    for (const pt of G.ports || []) {
      const x1 = cx + (pt.x - cx) * 0.25, y1 = cy + R * 0.92, x2 = pt.x, y2 = pt.y, my = (y1 + y2) / 2;
      c.strokeStyle = "rgba(255,153,31,.18)"; c.globalAlpha = fade; c.beginPath(); c.moveTo(x1, y1); c.bezierCurveTo(x1, my, x2, my, x2, y2); c.stroke();
      const u0 = (t * 0.22 + pt.x * 0.003) % 1, u = 1 - u0, px = u * u * u * x1 + 3 * u * u * u0 * x1 + 3 * u * u0 * u0 * x2 + u0 * u0 * u0 * x2, py = u * u * u * y1 + 3 * u * u * u0 * my + 3 * u * u0 * u0 * my + u0 * u0 * u0 * y2;
      c.fillStyle = OR; c.shadowColor = OR; c.shadowBlur = 8; c.beginPath(); c.arc(px, py, 1.8, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0; c.globalAlpha = 1;
    }
    $("globeUi").querySelectorAll(".gsrc,.colhead,.gport").forEach((el) => (el.style.opacity = String(0.35 + 0.65 * fade)));
    // the particle sphere
    if (!G.pts) { G.pts = []; for (let i = 0; i < 2600; i++) { const y = 1 - (i / 2599) * 2, r = Math.sqrt(1 - y * y), th = i * 2.39996; G.pts.push([Math.cos(th) * r, y, Math.sin(th) * r]); } }
    const sa = Math.sin(G.a), ca = Math.cos(G.a), busy = !!(D.spider && D.spider.running), shell = 1 - G.z * 0.55;
    for (const [x, y, z] of G.pts) { const X = x * ca + z * sa, Z = -x * sa + z * ca, d = (Z + 1) / 2, s = 0.5 + d * 1.1; c.fillStyle = `rgba(${busy ? "255,196,130" : "228,228,228"},${(0.05 + d * 0.6) * shell})`; c.fillRect(cx + X * R, cy + y * R, s, s); }
    const glow = c.createRadialGradient(cx, cy, 0, cx, cy, R); glow.addColorStop(0, `rgba(255,153,31,${0.05 + 0.12 * G.z})`); glow.addColorStop(1, "rgba(255,153,31,0)"); c.fillStyle = glow; c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fill();
    G.nodes = [];
  }
  (() => {
    const cv = $("globeCv"), pick = (e) => { const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; return { x, y, node: G.nodes.find((n) => Math.hypot(n.x - x, n.y - y) < n.r) }; };
    cv.addEventListener("mousemove", (e) => { const { node } = pick(e); G.hover = node ? node.id : null; });
    cv.addEventListener("click", (e) => {
      const { x, y, node } = pick(e), r = cv.getBoundingClientRect(), cx = r.width / 2, cy = r.height / 2 - 34, R = Math.min(r.width * 0.2, r.height * 0.3);
      if (Math.hypot(x - cx, y - cy) > R || G.open) return;
      G.open = true; setTimeout(() => { show("room"); G.open = false; G.z = 0; G.uiKey = ""; }, 650);
    });
  })();

  // ---------------------------------------------------------------- BOT PAGE: one agent's research, then its numbers
  function researchRows(syms) {
    const fs = finds(), sig = (D.raw.signals && D.raw.signals.items) || [], ch = checks();
    return syms.map(([sym, role]) => {
      const f = fs.filter((d) => (d.tickers || []).includes(sym)).slice(0, 2), s = sig.filter((x) => x.sym === sym), k = ch.find((x) => x.sym === sym);
      return `<div class="rs-row"><div class="sym">${h(sym)}</div><div class="role">${h(role)}</div>
        <div class="ev">${f.length ? f.map((d) => `<div><span class="${d.tone > 0 ? "up" : d.tone < 0 ? "down" : "or"}">${d.tone > 0 ? "▲" : d.tone < 0 ? "▼" : "●"}</span> ${h(d.headline)}<small>${h(((d.sources || [])[0] || {}).name || "spider")} · ${h(when(d.u))}</small></div>`).join("") : '<span class="dim">No spider findings on it yet.</span>'}</div>
        <div>${s.map((x) => `<span class="tag ${x.dir < 0 ? "bad" : x.dir > 0 ? "ok" : ""}">${h(x.name)}</span>`).join("")}${k ? `<span class="tag ${k.verdict === "veto" ? "bad" : "warn"}">${h(k.verdict)}</span>` : ""}</div></div>`;
    }).join("") || '<div class="empty">Nothing on its list right now.</div>';
  }
  function botPage(light) {
    const a = agents().find((x) => x.id === D.botId) || agents()[0]; if (!a) return;
    if (light && a.id !== "spider") return;
    const el = $("botPage"), head = `<div class="card"><div class="bothead"><button class="gback" style="position:static;margin-right:4px" id="bpBack">‹ agent room</button><div class="ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#ff991f" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg></div>
      <div><h2>${h(a.name)}</h2><p>${h(a.role)}</p></div><div class="st"><span class="tag ${a.busy ? "warn" : ""}">${a.busy ? "working" : "idle"}</span><div style="margin-top:6px">${h(String(a.now).slice(0, 80))}</div></div></div></div>`;
    let body = "";
    if (a.id === "spider") {
      const sp = D.spider || {}, run = sp.running;
      body = `<div class="grid g2" style="margin-top:12px"><div class="card"><div class="ch">Now reading</div><div class="cb reading">${run ? `<h4>${h(run.label)}</h4><div class="dim mono" style="font-size:11px">${h(run.note || run.phase || "")}</div>` : "<h4>Resting between jobs</h4>"}</div></div>
        <div class="card"><div class="ch">Up next</div><div class="cb">${(sp.queue || []).slice(0, 6).map((j) => `<div class="qi"><span>${h(j.label)}<small>${h((j.why || [])[0] || "")}</small></span></div>`).join("") || '<div class="empty">Nothing waiting.</div>'}</div></div></div>
        <div class="card" style="margin-top:12px"><div class="ch">Latest findings <em>· open the Research section for search and filters</em></div><div class="cb flist">${finds().slice(0, 25).map((d) => `<div class="fi"><div class="fh"><span class="ar ${d.tone > 0 ? "up" : d.tone < 0 ? "down" : "or"}">${d.tone > 0 ? "▲" : d.tone < 0 ? "▼" : "●"}</span><span>${h(d.headline)}</span></div><div class="meta">${(d.tickers || []).slice(0, 4).map((x) => `<span class="tk">${h(x)}</span>`).join("")}${h(d.cat)} · ${h(((d.sources || [])[0] || {}).name || "spider")} · ${h(when(d.u))}</div></div>`).join("") || '<div class="empty">No findings stored yet.</div>'}</div></div>
        <div class="card" style="margin-top:12px"><div class="ch">Thought stream</div><div class="cb stream">${(sp.recent || []).slice(0, 20).map((j) => `<div><span class="t">${h(tm(j.started))}</span><span>${h(j.label)}${j.summary ? ` · <span class="dim">${h(j.summary)}</span>` : ""}</span></div>`).join("") || '<div class="empty">No jobs yet.</div>'}</div></div>`;
    } else if (a.b) {
      const b = a.b, raw = D.raw[a.id] || {}, list = new Map();
      b.positions.forEach((p) => list.set(p.sym, "holding")); b.plans.forEach((p) => list.has(p.sym) || list.set(p.sym, `planned ${p.side.toLowerCase()}`));
      if (a.id === "swing") ((raw.lastScan && raw.lastScan.top) || []).slice(0, 10).forEach((x) => list.has(x.sym) || list.set(x.sym, `candidate #${x.rank}`));
      if (a.id === "day") ((raw.quantFactors && raw.quantFactors.top) || []).slice(0, 6).forEach((x) => list.has(x.sym) || list.set(x.sym, "top intraday score"));
      if (a.id === "quant") ((raw.latest && raw.latest.ranked) || []).filter((x) => x.picked).forEach((x) => list.has(x.s) || list.set(x.s, "picked by factors"));
      const extra = a.id === "quant" && raw.latest ? `<div class="note">Regime: ${h(raw.latest.regime)}${raw.latest.regimeNote ? " · " + h(raw.latest.regimeNote) : ""}</div>` : a.id === "swing" && raw.lastScan ? `<div class="note">${h(b.detail || "")}${(raw.lastScan.lessons || []).length ? ` · lessons applied: ${raw.lastScan.lessons.map((l) => l.tag).join(", ")}` : ""}</div>` : "";
      body = `<div class="card" style="margin-top:12px"><div class="ch">Its research <em>· what it holds, plans and is weighing, with the spider's findings on each</em></div><div class="cb">${researchRows([...list.entries()].slice(0, 16))}${extra}</div></div><div id="bpDetail" style="margin-top:12px"></div>`;
    } else if (a.id === "coach") {
      body = coachBody();
    } else if (a.id === "lab") {
      const labs = D.bots.filter((x) => x.group === "lab");
      body = `<div class="card" style="margin-top:12px"><div class="ch">Its research <em>· what each experiment scanned last</em></div><div class="cb">${labs.map((x) => `<div class="row"><span><b style="font-weight:500">${h(x.name)}</b><div class="note" style="margin:2px 0 0">${h(x.status)}</div></span><span class="mono ${cls(x.ret)}">${pct(x.ret, 1)}<div class="dim" style="font-size:11px">${x.openCount || 0} open · ${x.queued || 0} queued</div></span></div>`).join("") || '<div class="empty">No experiments reported yet.</div>'}</div></div>`;
    } else {
      const dk = D.raw.desk;
      body = `<div class="card" style="margin-top:12px"><div class="ch">Its research <em>· the shared risk budget</em></div><div class="cb">${dk ? `<div class="row"><span>Mode</span><b style="font-weight:500">${h(dk.mode)}</b></div><div class="row"><span>Why</span><span class="muted">${h(dk.reason || "")}</span></div>${dk.state ? `<div class="row"><span>Daily loss</span><span class="mono">${money(dk.state.dailyLoss)} of ${money(dk.policy && dk.policy.hardDaily)}</span></div><div class="row"><span>Drawdown from high</span><span class="mono">${money(dk.state.drawdown)} of ${money(dk.policy && dk.policy.peakStop)}</span></div>` : ""}${dk.exposure ? `<div class="row"><span>Open stop risk</span><span class="mono">${money(dk.exposure.stopRisk)}</span></div>` : ""}` : '<div class="empty">Desk risk unavailable.</div>'}</div></div>`;
    }
    el.innerHTML = head + body;
    $("bpBack").onclick = () => show("room");
    if (a.b && $("bpDetail")) { botDetail(a.b, $("bpDetail"), () => botPage()); const dup = $("bpDetail").querySelector(".head"); if (dup) dup.closest(".card").remove(); }
  }

  // ---------------------------------------------------------------- COACH (its own page; data from /api/coach)
  function coachBody() {
    const k = D.coach;
    if (!k) return `<div class="card" style="margin-top:12px"><div class="cb">${D.coachErr ? `<div class="err">The Coach is unavailable: ${h(D.coachErr)}</div>` : '<div class="empty">Reading charts and trade logs… the first review takes about a minute.</div>'}</div></div>`;
    const sig = (x) => `<span class="tag ${x === "Buy" ? "ok" : x === "Sell" ? "bad" : "warn"}">${h(x)}</span>`;
    // the VP of Finance's report: what it fixed on its own, and what it reviewed and deliberately left alone
    const fixed = k.fixed || [], noted = k.noted || [], until = (x) => (x.until ? ` · until ${new Date(x.until).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : " · until it's no longer needed");
    const flags = `<div class="card" style="margin-top:12px"><div class="ch">What I fixed <em>· reviewed ${h(when(k.at))} · ${h(k.headline || "")}</em></div><div class="cb">${fixed.map((x) => `<div class="row" style="display:block"><span><span class="tag ok">FIXED</span> <b>${h(x.fix)}</b> <span class="dim">(${h(x.bot)}${h(until(x))})</span></span><div class="note" style="margin:2px 0 0">Why: ${h(x.why)}</div></div>`).join("") || '<div class="empty">Nothing needed fixing.</div>'}
      ${noted.length ? `<div class="dim mono" style="font-size:10px;letter-spacing:.14em;margin-top:12px">REVIEWED, LEFT ALONE ON PURPOSE</div>${noted.map((x) => `<div class="row" style="display:block"><span>${h(x.bot)}: ${h(x.finding)}</span><div class="note" style="margin:2px 0 0">${h(x.why)}</div></div>`).join("")}` : ""}
      <div class="note">${h(k.note)}</div></div></div>`;
    const jr = k.journals.map((j) => `<div class="card"><div class="ch">${h(j.bot)} · trade journal <em>· last ${j.closed || 0} closed</em></div><div class="cb">${j.ok ? `
      <div class="row"><span>Win rate</span><span class="mono">${(j.winRate * 100).toFixed(0)}% (${j.wins}W / ${j.losses}L)</span></div>
      <div class="row"><span>Profit factor</span><span class="mono">${j.profitFactor == null ? "no losses" : j.profitFactor.toFixed(2)}</span></div>
      <div class="row"><span>Net</span><span class="mono ${cls(j.net)}">${money(j.net)}</span></div>
      <div class="row"><span>Avg win / avg loss</span><span class="mono">${money(j.avgWin)} / ${money(-j.avgLoss)}</span></div>
      ${j.best ? `<div class="row"><span>Best setup</span><span class="mono">${h(j.best.setup)} · ${money(j.best.pnl)} over ${j.best.n}</span></div>` : ""}
      <div class="dim mono" style="font-size:10px;letter-spacing:.14em;margin-top:10px">RECURRING MISTAKES</div>${j.mistakes.map((m) => `<div class="note">• ${h(m)}</div>`).join("") || '<div class="note">None stand out.</div>'}
      <div class="dim mono" style="font-size:10px;letter-spacing:.14em;margin-top:10px">RULES TO FOLLOW</div>${j.rules.map((r, i) => `<div class="row"><span><b class="or">${i + 1}.</b> ${h(r)}</span></div>`).join("")}${j.enough ? `<div class="note">${h(j.enough)}</div>` : ""}` : `<div class="empty">${h(j.why)}</div>`}</div></div>`).join("");
    const st = k.stress;
    const stress = `<div class="card" style="margin-top:12px"><div class="ch">If the market fell 20% <em>· hypothetical</em></div><div class="cb">${st.ok ? `
      <div class="row"><span>Estimated hit, all bots</span><span class="mono down">${money(st.totalHit)}</span></div>
      ${st.bots.map((b) => `<div class="row"><span>${h(b.bot)} <span class="dim">· ${money(b.invested)} invested</span>${b.over.map((o) => ` <span class="tag warn">${h(o.sym)} ${o.weight}%</span>`).join("")}</span><span class="mono down">${money(b.hit)}${b.hitPct != null ? ` (${b.hitPct.toFixed(1)}%)` : ""}</span></div>`).join("")}
      <div class="dim mono" style="font-size:10px;letter-spacing:.14em;margin-top:10px">HEDGE / REBALANCE</div><div class="note">${h(st.hedge.text)}</div>
      ${st.trims.map((t) => `<div class="row"><span>Trim ${h(t.sym)} <span class="dim">(${h(t.bot)}, beta ${t.beta})</span></span><span class="mono">halving saves ~${money(t.trimHalfSaves)}</span></div>`).join("")}
      <div class="dim mono" style="font-size:10px;letter-spacing:.14em;margin-top:10px">HIDDEN CORRELATIONS</div>${st.pairs.map((p) => `<div class="row"><span>${h(p.a)} ↔ ${h(p.b)}</span><span class="mono">${p.corr.toFixed(2)}</span></div>`).join("") || '<div class="note">No pair of holdings moves together above 0.80.</div>'}
      ${st.shared.length ? `<div class="note">Held by more than one bot: ${st.shared.map((x) => `${h(x.sym)} (${x.bots.map(h).join(", ")})`).join(" · ")}</div>` : ""}
      ${st.missing.length ? `<div class="note">No price history for ${st.missing.map(h).join(", ")}, so they're left out of the estimate.</div>` : ""}
      <div class="note">${h(st.note)}</div>` : `<div class="empty">${h(st.why)}</div>`}</div></div>`;
    const charts = `<div class="card" style="margin-top:12px"><div class="ch">Chart reads <em>· every stock held or near the top of the swing list</em></div><div class="cb">${k.charts.map((c) => c.ok ? `<details class="row" style="display:block"><summary style="display:flex;justify-content:space-between;gap:10px;cursor:pointer"><span><b style="font-weight:500">${h(c.sym)}</b> <span class="dim">${h(c.role)}</span></span><span class="mono">${sig(c.signal)}$${c.price.toFixed(2)} · ${h(c.trend || "")} · RSI ${c.rsi ?? "—"}</span></summary>
      <div class="note">Support ${c.support ? "$" + c.support.price.toFixed(2) + ` (${c.support.touches} touches)` : "none found"} · resistance ${c.resistance ? "$" + c.resistance.price.toFixed(2) + ` (${c.resistance.touches} touches)` : "none found"} · 50-day $${c.sma50 ?? "—"} · 200-day ${c.sma200 != null ? "$" + c.sma200 : "—"}</div>
      ${c.plan.stop != null || c.plan.target != null ? `<div class="note">Stop under support ${c.plan.stop != null ? "$" + c.plan.stop.toFixed(2) : "—"} · target at resistance ${c.plan.target != null ? "$" + c.plan.target.toFixed(2) : "—"}${c.plan.rewardRisk != null ? ` · reward/risk ${c.plan.rewardRisk}` : ""}</div>` : ""}
      ${c.points.map((p) => `<div class="note"><span class="${p.n > 0 ? "up" : p.n < 0 ? "down" : "or"}">${p.n > 0 ? "▲" : p.n < 0 ? "▼" : "●"}</span> ${h(p.text)}</div>`).join("")}</details>` : `<div class="row"><span><b style="font-weight:500">${h(c.sym)}</b> <span class="dim">${h(c.role)}</span></span><span class="dim">${h(c.why)}</span></div>`).join("") || '<div class="empty">Nothing held or ranked yet.</div>'}<div class="note">Rule-based read of daily closes: moving averages, RSI, 3-month momentum, support/resistance. Not advice.</div></div></div>`;
    setTimeout(() => { paintChat(); loadChat(); }, 0);
    setTimeout(loadPm, 0); setTimeout(() => loadDr(false), 0);
    return `<div id="chatBox">${chatHtml()}</div><div id="pmBox">${pmHtml()}</div><div id="drBox">${drHtml()}</div>` + flags + `<div class="grid g2" style="margin-top:12px">${jr}</div>` + stress + charts;
  }

  // ---------------------------------------------------------------- LAB
  function lab() {
    const items = D.bots.map((b) => ({ b, t: b.toughness || gates().find((g) => g.name === b.name) || null, fan: C.fan(b.trades, { start: b.start }) }));
    $("lab").innerHTML = items.map(({ b, t, fan }, i) => `<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);padding:12px 0;border-top:${i ? "1px solid var(--line)" : "0"}">
      <div><div style="font-size:16px;font-weight:500">${h(b.name)} <span class="tag ${t && t.status === "pass" ? "ok" : t && t.status === "fail" ? "bad" : "warn"}">${h(t ? (t.status === "fail" ? "paused" : t.status) : "untested")}</span></div>
        <div class="muted" style="font-size:12.5px;margin:4px 0 8px">${h(t ? t.label : "No toughness result yet")}</div>
        ${t && t.checks ? t.checks.map((c) => `<div class="row"><span>${c.ok ? '<span class="tag ok">✓</span>' : '<span class="tag bad">✗</span>'}${h(c.label)}</span><span class="mono">${h(c.value)}</span></div>`).join("") : `<div class="note">${h((t && (t.why || t.detail)) || "Judged once its first test runs after a market close.")}</div>`}
        ${t && t.gate ? `<div class="note">${h(t.gate)}</div>` : ""}</div>
      <div><div class="dim mono" style="font-size:10px;letter-spacing:.14em">BAD-LUCK RESHUFFLES OF ITS OWN CLOSED TRADES</div>${fan ? `<canvas class="chart" data-fan="${i}"></canvas><div class="note">Orange: what actually happened · grey: ${fan.paths.length} reshuffles · 1 in 20 ends below ${money(fan.p05)}, median ${money(fan.p50)}.</div>` : '<div class="empty">Needs at least 5 closed trades.</div>'}</div></div>`).join("") || '<div class="empty">No bots reported yet.</div>';
    document.querySelectorAll("[data-fan]").forEach((cv) => { const f = items[+cv.dataset.fan].fan; line(cv, [...f.paths.map((p) => ({ values: p, color: "#9a9a9a", width: 1, alpha: 0.18 })), { values: f.actual, color: OR, width: 2 }], { fmt: (v) => "$" + (v / 1000).toFixed(1) + "k" }); });
  }

  // ---------------------------------------------------------------- RESEARCH
  const CLUSTERS = [["company", "Company & movers", ["company", "mover", "news"]], ["sec", "SEC filings", ["filing", "insider", "fundamentals"]], ["earnings", "Earnings", ["earnings"]],
    ["macro", "Macro & policy", ["macro", "policy", "market"]], ["sectors", "Sectors & patterns", ["sector", "pattern"]], ["portfolio", "Your portfolio", ["portfolio", "ai_trader"]]];
  const STEPS = [["fetch", "Fetching sources"], ["analyze", "Analyzing"], ["connect", "Connecting to what it knows"], ["discover", "Writing findings"], ["save", "Saving"]];
  const hash = (s) => { let x = 2166136261; for (const ch of String(s)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); return (x >>> 0) / 4294967296; };
  const R2 = { kind: "all", q: "", open: null, stars: [], hover: null };
  const clusterOf = (d) => (CLUSTERS.find((c) => c[2].includes(d.cat)) || CLUSTERS[0])[0];
  const ago = (t) => { if (!t) return ""; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
  function shown() {
    const q = R2.q.trim().toLowerCase();
    return finds().filter((d) => (R2.kind === "all" || clusterOf(d) === R2.kind) && (!q || (d.headline + " " + (d.tickers || []).join(" ") + " " + d.cat).toLowerCase().includes(q)));
  }
  function research() {
    const fs = finds(), sp = D.spider || {}, run = sp.running;
    // kind filter buttons
    const count = (k) => (k === "all" ? fs.length : fs.filter((d) => clusterOf(d) === k).length);
    $("kinds").innerHTML = [["all", "Everything"], ...CLUSTERS.map((c) => [c[0], c[1]])].map(([k, l]) => `<button data-kind="${k}" class="${R2.kind === k ? "on" : ""}">${h(l)} <b>${count(k)}</b></button>`).join("");
    document.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => { R2.kind = b.dataset.kind; R2.open = null; research(); }));
    // now reading
    const log = run ? (sp.recent || []).find((j) => j.id === run.id) : null, doneSteps = new Set(((log && log.phases) || []).map((x) => x.p)), cur = run && run.phase;
    const secs = run && run.started ? Math.round((Date.now() - run.started) / 1000) : 0;
    $("readSrc").textContent = run ? run.area || "" : "";
    const rel = run && run.sym ? fs.filter((d) => (d.tickers || []).includes(run.sym)).slice(0, 3) : [];
    $("reading").innerHTML = run ? `<h4>${h(run.label)}</h4><div class="dim mono" style="font-size:11px">${h(run.note || "working")} · ${secs}s</div>
      <div class="steps">${STEPS.map(([k, l]) => `<div class="${k === cur ? "on" : doneSteps.has(k) ? "done" : ""}">${h(l)}</div>`).join("")}</div>
      ${rel.length ? `<div class="quote">${rel.map((d, i) => `<span class="${i === 0 ? "cur" : ""}">${h(d.headline)}</span>`).join("<br>")}</div>` : ""}
      ${(run.why || []).length ? `<div class="note">Why now: ${h(run.why.join(" · "))}</div>` : ""}`
      : `<h4>Resting between jobs</h4><div class="muted" style="font-size:13px">${sp.stats && sp.stats.budget ? `${sp.stats.budget.used} of ${sp.stats.budget.max} research jobs used this hour.` : ""} Next job starts on its schedule.</div>`;
    // queue
    const q = sp.queue || []; $("queueN").textContent = q.length ? `${sp.queued || q.length} waiting` : "";
    $("queue").innerHTML = q.length ? q.slice(0, 6).map((j) => `<div class="qi"><span>${h(j.label)}<small>${h((j.why || [])[0] || j.area || "")}</small></span><span class="sc" title="priority score">${Number.isFinite(j.score) ? j.score.toFixed(2) : ""}</span></div>`).join("") : '<div class="empty">Nothing waiting.</div>';
    // findings list
    const L = shown().slice(0, 60), fkey = L.map((d) => d.id + d.u).join("|") + R2.open;
    if (fkey !== R2.fkey) { R2.fkey = fkey; $("flist").innerHTML = L.length ? L.map((d) => { const open = R2.open === d.id, src = (d.sources || [])[0] || {};
      return `<div class="fi ${open ? "sel" : ""}" data-f="${h(d.id)}"><div class="fh"><span class="ar ${d.tone > 0 ? "up" : d.tone < 0 ? "down" : "or"}">${d.tone > 0 ? "▲" : d.tone < 0 ? "▼" : "●"}</span><span>${h(d.headline)}</span></div>
        <div class="meta">${(d.tickers || []).slice(0, 4).map((t) => `<span class="tk">${h(t)}</span>`).join("")}${h(d.cat)} · ${h(src.name || "spider")} · ${h(ago(d.u))}</div>
        ${open ? `<div class="more">${h(d.summary || "")}${d.interp && d.interp.text ? `<div style="margin-top:6px"><b style="font-weight:500;color:var(--text)">What it means:</b> ${h(d.interp.text)}</div>` : ""}<div style="margin-top:6px">${(d.sources || []).filter((x) => x.url && /^https?:\/\//.test(x.url)).slice(0, 3).map((x) => `<a href="${h(x.url)}" target="_blank" rel="noopener noreferrer">${h(x.name)} ↗</a>`).join("")}</div></div>` : ""}</div>`; }).join("")
      : `<div class="empty">${fs.length ? "No findings match." : "The spider hasn't stored any findings yet."}</div>`;
    document.querySelectorAll("[data-f]").forEach((el) => (el.onclick = (e) => { if (e.target.closest("a")) return; R2.open = R2.open === el.dataset.f ? null : el.dataset.f; research(); })); }
    // thought stream
    $("stream").innerHTML = (sp.recent || []).slice(0, 30).map((j) => `<div><span class="t">${h(tm(j.started))}</span><span>${h(j.label)}${j.summary ? `<br><span class="dim">${h(j.summary)}</span>` : ""}${j.status === "error" ? ' <span class="down">failed</span>' : j.status === "running" ? ' <span class="or">running</span>' : ""}</span></div>`).join("") || '<div class="empty">No jobs yet.</div>';
  }
  $("findQ").addEventListener("input", (e) => { R2.q = e.target.value; research(); });
  // ---------------------------------------------------------------- STRATEGIES
  function strategies() {
    if (!D.bots.find((b) => b.id === D.sel) && D.bots[0]) D.sel = D.bots[0].id;
    $("slist").innerHTML = D.bots.map((b) => { const ds = C.dots(b.toughness || gates().find((g) => g.name === b.name)); return `<div class="srow ${b.id === D.sel ? "on" : ""}" data-s="${h(b.id)}"><div><b>${h(b.name)}</b><small>${h(b.group === "main" ? b.detail || b.status : (b.status || "").split(" · ")[0])}</small><div class="dots">${ds.map((x) => `<i class="${x === true ? "y" : x === false ? "n" : ""}"></i>`).join("")}</div></div><canvas data-sp="${h(b.id)}"></canvas><div class="v ${cls(b.ret)}">${pct(b.ret, 1)}</div></div>`; }).join("") || '<div class="cb empty">No bots reported yet.</div>';
    document.querySelectorAll("[data-s]").forEach((el) => (el.onclick = () => { D.sel = el.dataset.s; D.tab = "overview"; strategies(); }));
    document.querySelectorAll("[data-sp]").forEach((cv) => { const b = D.bots.find((x) => x.id === cv.dataset.sp); if (b && b.equity.length > 1) spark(cv, b.equity.map((p) => p.v), b.ret >= 0 ? UP : DN); });
    const b = D.bots.find((x) => x.id === D.sel); if (!b) { $("sdetail").innerHTML = ""; return; }
    botDetail(b, $("sdetail"), strategies);
  }
  // one bot's numbers, charts, toughness, holdings, plans and trades (used by Strategies and the bot pages)
  function botDetail(b, root, rerender) {
    const st = C.stats(b.trades), closed = b.trades.filter((t) => t.pnl != null), wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl <= 0);
    const avgW = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : null, avgL = losses.length ? -losses.reduce((a, t) => a + t.pnl, 0) / losses.length : null;
    const dd = b.equity.length ? Math.min(...C.drawdowns(b.equity).map((d) => d.dd)) : null, hi = b.equity.length ? Math.max(...b.equity.map((p) => p.v)) : null;
    const months = C.monthly(b.equity).slice(-12), wk = C.whenItWorks(b.trades), t = b.toughness || gates().find((g) => g.name === b.name);
    const bar = (arr, lab) => { const m = Math.max(1, ...arr.map((x) => Math.abs(x.pnl))); return `<div class="bars">${arr.map((x) => `<div title="${x.n} trades · ${money(x.pnl)}"><i class="${x.pnl > 0 ? "w" : x.pnl < 0 ? "l" : ""}" style="height:${Math.round((Math.abs(x.pnl) / m) * 70)}px"></i>${h(lab(x.key))}</div>`).join("")}</div>`; };
    const trades = `<div class="card"><div class="cb">${b.trades.length ? `<table><tr><th>WHEN</th><th>SIDE</th><th>STOCK</th><th>P&amp;L</th><th style="text-align:left">WHY</th></tr>${b.trades.slice(0, 80).map((x) => `<tr><td class="mono">${h(when(x.t))}</td><td>${h(x.side)}</td><td>${h(x.sym)}</td><td class="${cls(x.pnl)}">${x.pnl == null ? "" : money(x.pnl)}</td><td class="why">${h(x.why)}</td></tr>`).join("")}</table>` : '<div class="empty">No trades yet.</div>'}</div></div>`;
    const over = `<div class="card"><div class="ch">Key numbers <em>· all trades, after costs</em><span class="r">${closed.length} closed</span></div><div class="kc">
        <div><small>WIN RATE</small><b>${st.winRate == null ? "—" : (st.winRate * 100).toFixed(1) + "%"}</b><span>${wins.length} won · ${losses.length} lost</span><div class="bar"><s style="width:${(st.winRate || 0) * 100}%"></s><u style="width:${st.winRate == null ? 0 : (1 - st.winRate) * 100}%"></u></div></div>
        <div><small>AVG WIN : LOSS</small><b>${avgW && avgL ? "1 : " + (avgW / avgL).toFixed(2) : "—"}</b><span>win ${money(avgW)} · loss ${money(avgL)}</span></div>
        <div><small>EXPECTANCY</small><b class="${cls(closed.length ? st.net / closed.length : null)}">${closed.length ? money(st.net / closed.length) : "—"}</b><span>per trade, after costs</span></div>
        <div><small>TRADES</small><b>${b.trades.length || b.closed || 0}</b><span>${b.group === "main" ? "fills recorded" : `${b.openCount || 0} open · ${b.queued || 0} queued`}</span></div>
        <div><small>MAX DRAWDOWN</small><b class="${dd ? "down" : ""}">${dd == null ? (b.drawdown != null ? "−" + (b.drawdown * 100).toFixed(1) + "%" : "—") : (dd * 100).toFixed(1) + "%"}</b><span>${hi ? "below its high of " + money(hi) : "from its own high"}</span></div></div></div>
      <div class="card" style="margin-top:12px"><div class="ch">Equity curve <em>· paper dollars, after costs · grey: S&amp;P 500</em><span class="r ${cls(b.ret)}">${pct(b.ret)}${b.benchRet != null ? ` · S&amp;P ${pct(b.benchRet)}` : ""}</span></div><div class="cb">${b.group === "main" ? '<canvas class="chart sEq"></canvas><canvas class="chart sm sDd" style="margin-top:6px"></canvas>' : '<div class="empty">Strategy Lab books record a daily snapshot; their curve shows in the main site\'s Strategy Lab table after two sessions.</div>'}</div></div>
      <div class="grid g2" style="margin-top:12px"><div class="card"><div class="ch">Monthly robustness <em>· win or loss per month</em></div><div class="cb">${months.length ? `<div class="months">${months.map((m) => `<div class="${m.ret > 0 ? "w" : m.ret < 0 ? "l" : ""}">${h(m.m.slice(2))}<br>${pct(m.ret, 1)}</div>`).join("")}</div>` : '<div class="empty">Waiting for data: twelve boxes, green a winning month, red a losing one.</div>'}</div></div>
        <div class="card"><div class="ch">When does it work <em>· New York time</em></div><div class="cb">${closed.length ? bar(wk.weekday, (x) => x) + bar(wk.hour, (x) => (x > 12 ? x - 12 : x) + (x >= 12 ? "p" : "a")) : '<div class="empty">Waiting for data: results per weekday and hour appear after closed trades.</div>'}</div></div></div>
      ${t ? `<div class="card" style="margin-top:12px"><div class="ch">Toughness test <em>· ${h(t.label || t.status)}</em></div><div class="cb">${(t.checks || []).map((x) => `<div class="row"><span>${x.ok ? '<span class="tag ok">✓</span>' : '<span class="tag bad">✗</span>'}${h(x.label)}</span><span class="mono">${h(x.value)}</span></div>`).join("") || `<div class="muted">${h(t.detail || t.why || "")}</div>`}<div class="note">${h(t.gate || "")}</div></div></div>` : ""}
      <div class="grid g2" style="margin-top:12px"><div class="card"><div class="ch">Holding now</div><div class="cb">${b.positions.length ? `<table><tr><th>STOCK</th><th>VALUE</th><th>P&amp;L</th></tr>${b.positions.map((p) => `<tr><td>${h(p.sym)}</td><td>${money(p.value)}</td><td class="${cls(p.pnl)}">${money(p.pnl)}</td></tr>`).join("")}</table>` : '<div class="empty">No open positions.</div>'}</div></div>
        <div class="card"><div class="ch">Working on next</div><div class="cb">${b.plans.length ? b.plans.slice(0, 10).map((o) => `<div class="row"><span><span class="tag ${o.side === "BUY" ? "ok" : "bad"}">${h(o.side)}</span>${h(o.sym)} ${o.amount ? money(o.amount) : ""}<div class="note" style="margin:2px 0 0">${h(String(o.why || "").slice(0, 160))}</div></span><span class="dim">${h(o.when)}</span></div>`).join("") : '<div class="empty">Nothing queued right now.</div>'}</div></div></div>`;
    root.innerHTML = `<div class="card"><div class="cb head"><h2>${h(b.name)}</h2><p>${h(b.group === "main" ? "Main bot · paper account racing the S&P 500" : "Strategy Lab experiment · $30,000 paper book")}${b.detail ? " · " + h(b.detail) : ""}</p></div></div>
      <div class="tabs"><button data-t="overview" class="${D.tab === "overview" ? "on" : ""}">OVERVIEW</button><button data-t="trades" class="${D.tab === "trades" ? "on" : ""}">TRADES · ${b.trades.length}</button></div>${D.tab === "trades" ? trades : over}`;
    root.querySelectorAll("[data-t]").forEach((x) => (x.onclick = () => { D.tab = x.dataset.t; rerender(); }));
    if (D.tab === "overview" && root.querySelector(".sEq")) {
      const b0 = (b.equity.find((p) => p.b != null) || {}).b;
      line(root.querySelector(".sEq"), [{ values: b.equity.map((p) => (p.b != null && b0 ? (p.b / b0) * b.start : NaN)), color: "#5a5a5a", width: 1 }, { values: b.equity.map((p) => p.v), color: UP, width: 1.8, fill: "rgba(61,220,132,.22)" }], { fmt: (v) => "$" + (v / 1000).toFixed(1) + "k" });
      line(root.querySelector(".sDd"), [{ values: C.drawdowns(b.equity).map((d) => d.dd * 100), color: DN, fill: "rgba(255,90,90,.25)" }], { fmt: (v) => v.toFixed(1) + "%", zero: true });
    }
  }

  // ---------------------------------------------------------------- RULEBOOK
  function rule() {
    const r = RULES[D.rule]; if (!r) { $("rule").innerHTML = '<div class="empty">No rules loaded.</div>'; return; }
    $("ruleN").textContent = `CARD ${D.rule + 1} OF ${RULES.length}`;
    $("rule").innerHTML = `<div class="rule"><div><canvas id="rulePic"></canvas><div class="note">Illustration of the idea, not market data.</div></div>
      <div><div>${r.tags.map((t) => `<span class="tag">${h(t)}</span>`).join("")}<span class="tag ok">in the code</span></div><h3>${h(r.title)}</h3><div class="kick">IN PLAIN WORDS</div><p style="margin:0;font-size:15px;line-height:1.5">${h(r.plain)}</p>
        <pre class="code">${h(r.code)}</pre><div class="dim mono" style="font-size:11px">from ${h(r.src)}</div></div></div>
      <div class="pager"><button data-rp="-1">‹ previous</button>${RULES.map((_, i) => `<i class="${i === D.rule ? "on" : ""}"></i>`).join("")}<button data-rp="1">next ›</button></div>
      <div class="rulelist">${RULES.map((x, i) => `<button data-ri="${i}" class="${i === D.rule ? "on" : ""}">${h(x.title)}</button>`).join("")}</div>`;
    document.querySelectorAll("[data-rp]").forEach((b) => (b.onclick = () => { D.rule = (D.rule + +b.dataset.rp + RULES.length) % RULES.length; rule(); }));
    document.querySelectorAll("[data-ri]").forEach((b) => (b.onclick = () => { D.rule = +b.dataset.ri; rule(); }));
    pic($("rulePic"), r.pic);
  }
  function pic(cv, kind) {
    const k = setup(cv); if (!k) return; const { c, w, hh } = k; let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const label = (t, x, y, col = "#8a8a8a") => { c.fillStyle = col; c.font = "11px monospace"; c.fillText(t, x, y); };
    const walk = (n, start, drift, vol) => { const out = []; let p = start; for (let i = 0; i < n; i++) { const o = p; p = p * (1 + drift + (rnd() - 0.5) * vol); out.push([o, Math.max(o, p) * (1 + (rnd() * vol) / 3), Math.min(o, p) * (1 - (rnd() * vol) / 3), p]); } return out; };
    const candles = (arr, hiIdx = []) => {
      const x0 = 20, x1 = w - 20, y0 = 34, y1 = hh - 40, mn = Math.min(...arr.map((a) => a[2])), mx = Math.max(...arr.map((a) => a[1]));
      const X = (i) => x0 + (i + 0.5) * ((x1 - x0) / arr.length), Y = (v) => y1 - ((v - mn) / (mx - mn || 1)) * (y1 - y0), bw = Math.max(3, ((x1 - x0) / arr.length) * 0.55);
      arr.forEach(([o, hv, lo, cl], i) => { c.strokeStyle = c.fillStyle = hiIdx.includes(i) ? OR : cl >= o ? "#cfcfcf" : "#6b6b6b"; c.beginPath(); c.moveTo(X(i), Y(hv)); c.lineTo(X(i), Y(lo)); c.stroke(); c.fillRect(X(i) - bw / 2, Math.min(Y(o), Y(cl)), bw, Math.max(1.5, Math.abs(Y(o) - Y(cl)))); });
      return { X, Y };
    };
    if (kind === "pullback") { const a = walk(22, 100, 0.006, 0.02), p = a[21][3]; a.push([p, p, p * 0.96, p * 0.965]); const q = a[22][3]; a.push([q, q, q * 0.96, q * 0.962]); a.push(...walk(6, a[23][3], 0.012, 0.015)); const { X, Y } = candles(a, [22, 23]); label("2-day dip, RSI(2) < 10", X(13), Y(a[23][2]) + 24, OR); label("bounce above the 5-day average → sell", 24, 22); }
    else if (kind === "rotation") { const names = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB", "XLC", "XLRE"], v = names.map(() => rnd() * 0.3 - 0.08).sort((a, b) => b - a), bw = (w - 40) / names.length, y0 = hh / 2; v.forEach((x, i) => { c.fillStyle = i < 3 ? OR : "#2e2e2e"; c.fillRect(20 + i * bw + 4, x > 0 ? y0 - x * 500 : y0, bw - 8, Math.abs(x * 500)); label(names[i], 20 + i * bw + 4, hh - 14); }); label("hold the top 3 (only if above their 200-day)", 24, 22, OR); }
    else if (kind === "drift") { const a = walk(12, 100, 0.001, 0.015), l = a[11][3]; a.push([l * 1.03, l * 1.06, l * 1.02, l * 1.05]); a.push(...walk(14, l * 1.05, 0.005, 0.012)); const { X } = candles(a, [12]); label("EPS beat, stock +5% on the report", X(3), 22, OR); label("then it drifts", X(18), 40); }
    else if (kind === "insider") { const a = walk(30, 100, -0.002, 0.02), { X, Y } = candles(a); [8, 11, 13].forEach((i) => { c.fillStyle = UP; c.beginPath(); c.arc(X(i), Y(a[i][2]) + 14, 5, 0, Math.PI * 2); c.fill(); label("buy", X(i) - 10, Y(a[i][2]) + 32, UP); }); label("3 different insiders buy (SEC Form 4)", 24, 22, OR); }
    else if (kind === "fan") { const paths = []; for (let p = 0; p < 40; p++) { let v = 0; const a = [0]; for (let i = 0; i < 60; i++) { v += (rnd() - 0.47) * 2; a.push(v); } paths.push(a); } const all = paths.flat(), mn = Math.min(...all), mx = Math.max(...all); paths.forEach((a, j) => { c.strokeStyle = j === 0 ? OR : "rgba(180,180,180,.2)"; c.lineWidth = j === 0 ? 2 : 1; c.beginPath(); a.forEach((v, i) => { const x = 20 + (i / 60) * (w - 40), y = hh - 30 - ((v - mn) / (mx - mn)) * (hh - 60); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke(); }); c.lineWidth = 1; label("bad-luck reshuffles of the same trades", 24, 22, OR); }
    else {
      const a = walk(34, 100, kind === "defense" ? -0.004 : 0.003, kind === "defense" ? 0.03 : 0.018), { X, Y } = candles(a, kind === "check" ? [26] : []);
      const words = { rank: "every candidate gets one score", check: "spider finds a red flag → buy vetoed", defense: "VIX spikes and the S&P drops → defense", earn: "report in 3 days → hold or trim", regime: "a new regime must last 3 days", stops: "the trailing stop follows the high" }; label(words[kind] || "", 24, 22, OR);
      if (kind === "stops") { let pk = 0; c.strokeStyle = DN; c.setLineDash([4, 4]); c.beginPath(); a.forEach((x, i) => { pk = Math.max(pk, x[3]); i ? c.lineTo(X(i), Y(pk * 0.92)) : c.moveTo(X(i), Y(pk * 0.92)); }); c.stroke(); c.setLineDash([]); }
      if (kind === "regime") ["calm", "calm", "choppy?", "choppy?", "choppy ✓"].forEach((t, i) => label(t, X(18 + i * 3), hh - 14, i === 4 ? OR : "#6b6b6b"));
    }
  }

  // ---------------------------------------------------------------- AGENT ROOM (2.5D, drawn in code)
  function agents() {
    const sp = D.spider || {}, bot = (id) => D.bots.find((x) => x.id === id), lab = D.bots.filter((x) => x.group === "lab"), open = !!(D.raw.swing && D.raw.swing.marketOpen);
    const botAgent = (id, name, role, x, z, next) => { const b = bot(id); return { id, name, role, x, z, b, busy: !!(b && (b.plans.length || open)),
      now: b ? (b.plans.length ? `Queued ${b.plans.length} order${b.plans.length > 1 ? "s" : ""}: ${b.plans.slice(0, 3).map((o) => `${o.side} ${o.sym}`).join(", ")}` : b.positions.length ? `Watching ${b.positions.length} open position${b.positions.length > 1 ? "s" : ""}` : "Waiting for a setup") : "Offline",
      why: b ? b.detail || b.status : "", found: b && b.trades[0] ? `Last trade: ${b.trades[0].side} ${b.trades[0].sym} — ${String(b.trades[0].why || "").slice(0, 120)}` : "No trades yet", next }; };
    return [
      { id: "spider", name: "SPIDER", role: "researcher · SEC filings, news, earnings, macro", x: 0, z: 0, busy: !!sp.running,
        now: sp.running ? sp.running.label : "Idle", why: sp.running ? sp.running.note || sp.running.phase || "" : "Waiting for its next scheduled job",
        found: (sp.recent || [])[0] ? `${sp.recent[0].label}${sp.recent[0].summary ? " — " + sp.recent[0].summary : ""}` : "—", next: (sp.queue || [])[0] ? sp.queue[0].label : "Nothing queued", jobs: sp.recent || [] },
      botAgent("swing", "SWING BOT", "trader · ranks ~60 stocks, holds 10", -3.2, -2.6, "Re-scores every 10 minutes while open; plans the open overnight."),
      botAgent("day", "DAY TRADER", "trader · intraday setups on 5-minute bars", 3.2, -2.6, "Checks every 5-minute bar while the market is open."),
      botAgent("quant", "QUANT", "allocator · regime, momentum, risk parity", -3.2, 2.6, "Plans its rebalance after the close; fills at the next open."),
      { id: "lab", name: `STRATEGY LAB · ${lab.length}`, role: "nine experiments on paper", x: 3.2, z: 2.6, busy: lab.some((x) => x.queued),
        now: `${lab.reduce((a, x) => a + (x.openCount || 0), 0)} open positions · ${lab.filter((x) => x.toughness && x.toughness.status === "fail").length} paused by the toughness test`,
        why: "Each experiment tests one idea with $30,000 of paper money.", found: lab.filter((x) => x.ret).map((x) => `${x.name}: ${pct(x.ret, 1)}`).slice(0, 3).join(" · ") || "No results yet", next: "Decides after the close, fills at the next open." },
      { id: "risk", name: "RISK DESK", role: "guard · loss stop, drawdown lock, exposure", x: 0, z: 5, busy: !!(D.raw.desk && D.raw.desk.mode !== "armed"),
        now: D.raw.desk ? `${D.raw.desk.mode}: ${D.raw.desk.reason || ""}` : "—", why: "One shared risk budget for every bot.",
        found: D.raw.desk && D.raw.desk.state ? `Daily loss ${money(D.raw.desk.state.dailyLoss)} · drawdown ${money(D.raw.desk.state.drawdown)}` : "—", next: "Approves or shrinks every new entry." },
      coachAgent(),
    ];
  }
  function coachAgent() {
    const k = D.coach, held = k ? k.charts.filter((c) => c.ok && /held/.test(c.role)) : [];
    return { id: "coach", name: "COACH", role: "VP of Finance · fixes what the bots do wrong, reports to you", x: 0, z: -5, busy: !k && !D.coachErr,
      now: k ? `${(k.fixed || []).length} fix${(k.fixed || []).length === 1 ? "" : "es"} in place · ${(k.noted || []).length} reviewed and left alone` : D.coachErr ? "Offline" : "Reviewing the other bots…",
      why: "VP of Finance: reviews every bot's trades, risk and charts, fixes what they're doing wrong by itself, and reports to you.", found: k && k.fixed && k.fixed[0] ? `Fixed: ${k.fixed[0].fix}` : "Nothing needed fixing.", next: "Re-reviews and re-fixes every 2 hours." };
  }
  const room = { hits: [], drag: null };
  function P(x, y, z, w, hh) { const a = D.rot, X = x * Math.cos(a) - z * Math.sin(a), Z = x * Math.sin(a) + z * Math.cos(a), s = Math.min(w / 17.5, hh / 15); return [w / 2 + (X - Z) * 0.87 * s, hh * 0.57 + (X + Z) * 0.5 * s - y * s, X + Z]; }
  // draw flat 2D content (w × h local pixels) onto a 3D rectangle: o = top-left corner, ex = top-right, ey = bottom-left (all projected)
  function onPlane(c, o, ex, ey, w, h, fn) { c.save(); c.transform((ex[0] - o[0]) / w, (ex[1] - o[1]) / w, (ey[0] - o[0]) / h, (ey[1] - o[1]) / h, o[0], o[1]); try { fn(c); } finally { c.restore(); } }
  function lineIn(c, vals, x, y, w, h, color, width = 2) {
    const v = vals.filter(Number.isFinite); if (v.length < 2) return false; const mn = Math.min(...v), mx = Math.max(...v), rg = mx - mn || 1;
    c.strokeStyle = color; c.lineWidth = width; c.beginPath(); v.forEach((q, i) => { const X = x + (i / (v.length - 1)) * w, Y = y + h - ((q - mn) / rg) * h; i ? c.lineTo(X, Y) : c.moveTo(X, Y); }); c.stroke(); c.lineWidth = 1; return true;
  }
  const UPC = "#3ddc84", DNC = "#ff5f5f";
  // what each agent's three screens show — real numbers only; "NO DATA" when there are none
  function screens(a) {
    if (a.b) {
      const b = a.b, eq = b.equity.map((p) => p.v), bench = b.equity.map((p) => p.b);
      return [{ title: "EQUITY", kind: "line", vals: eq, color: b.ret >= 0 ? UPC : DNC, foot: pct(b.ret, 1) },
        { title: "POSITIONS", kind: "bars", bars: b.positions.filter((x) => Number.isFinite(x.pnl)).slice(0, 8).map((x) => ({ k: x.sym, v: x.pnl })) },
        { title: "VS S&P 500", kind: "line", vals: bench.filter(Number.isFinite).length > 1 ? eq.map((v, i) => (Number.isFinite(bench[i]) && bench[i] > 0 ? v / bench[i] : NaN)) : [], color: OR, foot: b.benchRet != null ? "S&P " + pct(b.benchRet, 1) : "" }];
    }
    if (a.id === "spider") { const fs = finds(), up = fs.filter((d) => d.tone > 0).length, dn = fs.filter((d) => d.tone < 0).length, sp = D.spider || {};
      return [{ title: "FINDINGS", kind: "big", text: String(fs.length), sub: `${up}▲ ${dn}▼` }, { title: "TONE", kind: "bars", bars: fs.length ? [{ k: "UP", v: up }, { k: "DOWN", v: -dn }] : [] },
        { title: "JOBS", kind: "big", text: String((sp.recent || []).length), sub: sp.running ? "RUNNING" : "IDLE" }]; }
    if (a.id === "lab") { const L = D.bots.filter((x) => x.group === "lab");
      return [{ title: "EXPERIMENTS", kind: "big", text: String(L.length), sub: `${L.reduce((s, x) => s + (x.openCount || 0), 0)} OPEN` },
        { title: "RETURNS", kind: "bars", bars: L.filter((x) => Number.isFinite(x.ret)).map((x) => ({ k: x.name.split(" ")[0].slice(0, 6).toUpperCase(), v: x.ret })) },
        { title: "PAUSED", kind: "big", text: String(L.filter((x) => x.toughness && x.toughness.status === "fail").length), sub: "TOUGHNESS" }]; }
    if (a.id === "risk") { const dk = D.raw.desk, st = dk && dk.state, pol = dk && dk.policy;
      return [{ title: "MODE", kind: "big", text: dk ? String(dk.mode).toUpperCase() : "—", sub: "" },
        { title: "DAILY LOSS", kind: "gauge", v: st && pol && pol.hardDaily ? st.dailyLoss / pol.hardDaily : null, sub: st ? money(st.dailyLoss) : "" },
        { title: "DRAWDOWN", kind: "gauge", v: st && pol && pol.peakStop ? st.drawdown / pol.peakStop : null, sub: st ? money(st.drawdown) : "" }]; }
    if (a.id === "coach") { const k = D.coach, st = k && k.stress, ch = k ? k.charts.filter((c) => c.ok) : [];
      return [{ title: "FIXED", kind: "big", text: k ? String((k.fixed || []).length) : "—", sub: "IN PLACE" },
        { title: "CHART READS", kind: "bars", bars: k ? [{ k: "BUY", v: ch.filter((c) => c.signal === "Buy").length }, { k: "SELL", v: -ch.filter((c) => c.signal === "Sell").length }] : [] },
        { title: "−20% TEST", kind: "big", text: st && st.ok ? money(st.totalHit) : "—", sub: "HYPOTHETICAL" }]; }
    return [];
  }
  function drawScreen(c, sc, W, H, on, t) {
    c.fillStyle = "#07090b"; c.fillRect(0, 0, W, H);
    c.strokeStyle = on ? "rgba(255,153,31,.55)" : "#2a2a2a"; c.lineWidth = 3; c.strokeRect(1.5, 1.5, W - 3, H - 3); c.lineWidth = 1;
    c.fillStyle = on ? OR : "#7a7a7a"; c.font = "600 11px monospace"; c.textAlign = "left"; c.fillText(sc.title, 8, 15);
    let drew = false;
    if (sc.kind === "line") { drew = lineIn(c, sc.vals || [], 8, 22, W - 16, H - 44, sc.color); if (sc.foot) { c.fillStyle = sc.color; c.font = "600 12px monospace"; c.textAlign = "right"; c.fillText(sc.foot, W - 8, H - 7); } }
    else if (sc.kind === "bars" && sc.bars && sc.bars.length) { drew = true; const n = sc.bars.length, mx = Math.max(...sc.bars.map((b) => Math.abs(b.v))) || 1, mid = 22 + (H - 40) / 2, bw = (W - 16) / n;
      c.strokeStyle = "#333"; c.beginPath(); c.moveTo(8, mid); c.lineTo(W - 8, mid); c.stroke();
      sc.bars.forEach((b, i) => { const hgt = (Math.abs(b.v) / mx) * (H - 44) / 2; c.fillStyle = b.v >= 0 ? UPC : DNC; c.fillRect(8 + i * bw + 2, b.v >= 0 ? mid - hgt : mid, bw - 4, Math.max(1, hgt));
        if (n <= 8) { c.fillStyle = "#8a8a8a"; c.font = "9px monospace"; c.textAlign = "center"; c.fillText(String(b.k).slice(0, 5), 8 + i * bw + bw / 2, H - 5); } }); }
    else if (sc.kind === "big") { drew = true; c.textAlign = "center"; c.fillStyle = "#f2f2f2"; c.font = `600 ${sc.text.length > 6 ? 22 : 34}px monospace`; c.fillText(sc.text, W / 2, H / 2 + 10); c.fillStyle = "#8a8a8a"; c.font = "10px monospace"; c.fillText(sc.sub || "", W / 2, H - 9); }
    else if (sc.kind === "gauge" && Number.isFinite(sc.v)) { drew = true; const f = Math.max(0, Math.min(1, sc.v)), cx = W / 2, cy = H - 18, r = Math.min(W / 2 - 12, H - 34);
      c.lineWidth = 8; c.strokeStyle = "#222"; c.beginPath(); c.arc(cx, cy, r, Math.PI, 0); c.stroke(); c.strokeStyle = f > 0.75 ? DNC : f > 0.4 ? OR : UPC; c.beginPath(); c.arc(cx, cy, r, Math.PI, Math.PI + f * Math.PI); c.stroke(); c.lineWidth = 1;
      c.fillStyle = "#d0d0d0"; c.font = "10px monospace"; c.textAlign = "center"; c.fillText(sc.sub || "", cx, cy + 2); }
    if (!drew) { c.fillStyle = "#4a4a4a"; c.font = "10px monospace"; c.textAlign = "center"; c.fillText("NO DATA", W / 2, H / 2 + 6); }
    c.fillStyle = "rgba(255,255,255,.035)"; const sl = (t * 40) % H; c.fillRect(0, sl, W, 3); c.textAlign = "left"; // scanline
  }
  // the big wall: every bot's return since start, and a board of what they hold
  function drawWall(c, W, H, t) {
    c.fillStyle = "#06080a"; c.fillRect(0, 0, W, H); c.strokeStyle = "rgba(255,153,31,.6)"; c.lineWidth = 4; c.strokeRect(2, 2, W - 4, H - 4); c.lineWidth = 1;
    c.fillStyle = OR; c.font = "600 18px monospace"; c.fillText("MARKET DESK · TRADING FLOOR", 18, 30);
    const main = D.bots.filter((x) => x.group === "main"), tot = main.reduce((s, x) => s + (x.value || 0), 0), st = main.reduce((s, x) => s + (x.start || 0), 0);
    c.textAlign = "right"; c.fillStyle = "#e8e8e8"; c.font = "600 18px monospace"; c.fillText(main.length ? `PAPER ${money(tot)}  ${pct(st ? tot / st - 1 : null, 2)}` : "PAPER —", W - 18, 30); c.textAlign = "left";
    // left: return curves (% since each bot's start)
    const cw = W * 0.56, x0 = 18, y0 = 48, ch = H - 70, cols = [OR, "#f2f2f2", "#9a9a9a"];
    c.strokeStyle = "#1c1c1c"; for (let i = 0; i <= 4; i++) { c.beginPath(); c.moveTo(x0, y0 + (i * ch) / 4); c.lineTo(x0 + cw, y0 + (i * ch) / 4); c.stroke(); }
    const series = main.map((b) => b.equity.map((p) => p.v / (b.start || 1) - 1)), all = series.flat().filter(Number.isFinite);
    if (all.length > 1) { const mn = Math.min(0, ...all), mx = Math.max(0, ...all), rg = mx - mn || 1, Y = (v) => y0 + ch - ((v - mn) / rg) * ch;
      c.strokeStyle = "#444"; c.setLineDash([4, 4]); c.beginPath(); c.moveTo(x0, Y(0)); c.lineTo(x0 + cw, Y(0)); c.stroke(); c.setLineDash([]);
      series.forEach((sr, k) => { const v = sr.filter(Number.isFinite); if (v.length < 2) return; c.strokeStyle = cols[k % 3]; c.lineWidth = 2.5; c.beginPath(); v.forEach((q, i) => { const X = x0 + (i / (v.length - 1)) * cw; i ? c.lineTo(X, Y(q)) : c.moveTo(X, Y(q)); }); c.stroke(); c.lineWidth = 1;
        c.fillStyle = cols[k % 3]; c.font = "12px monospace"; c.fillText(`${main[k].name.toUpperCase()} ${pct(main[k].ret, 1)}`, x0 + 6 + k * (cw / 3), y0 + ch + 18); });
      c.fillStyle = "#6b6b6b"; c.font = "10px monospace"; c.fillText(pct(mx, 1), x0 + 2, y0 + 10); c.fillText(pct(mn, 1), x0 + 2, y0 + ch - 2);
    } else { c.fillStyle = "#4a4a4a"; c.font = "14px monospace"; c.fillText("NO EQUITY HISTORY YET", x0 + 10, y0 + ch / 2); }
    // right: holdings board
    const bx = x0 + cw + 24, bw = W - bx - 18, rows = [];
    for (const b of main) for (const p of b.positions) if (Number.isFinite(p.pnl)) rows.push({ sym: p.sym, bot: b.name.split(" ")[0].toUpperCase(), pnl: p.pnl, val: p.value });
    rows.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
    c.fillStyle = "#8a8a8a"; c.font = "600 11px monospace"; c.fillText("SYM", bx, y0 + 8); c.fillText("BOT", bx + bw * 0.28, y0 + 8); c.textAlign = "right"; c.fillText("VALUE", bx + bw * 0.74, y0 + 8); c.fillText("P&L", bx + bw, y0 + 8); c.textAlign = "left";
    const rh = 19, fit = Math.floor((H - y0 - 30) / rh), list = rows.length > fit ? rows.concat(rows) : rows, off = rows.length > fit ? (t * 8) % (rows.length * rh) : 0;
    c.save(); c.beginPath(); c.rect(bx - 4, y0 + 14, bw + 8, H - y0 - 30); c.clip();
    list.forEach((r, i) => { const y = y0 + 30 + i * rh - off; if (y < y0 || y > H) return; c.font = "13px monospace"; c.fillStyle = "#f2f2f2"; c.fillText(r.sym, bx, y); c.fillStyle = "#8a8a8a"; c.fillText(r.bot, bx + bw * 0.28, y);
      c.textAlign = "right"; c.fillText(money(r.val), bx + bw * 0.74, y); c.fillStyle = r.pnl >= 0 ? UPC : DNC; c.fillText((r.pnl >= 0 ? "+" : "") + money(r.pnl), bx + bw, y); c.textAlign = "left"; });
    if (!rows.length) { c.fillStyle = "#4a4a4a"; c.font = "13px monospace"; c.fillText("NO OPEN POSITIONS", bx, y0 + 40); }
    c.restore();
  }
  function hud() {
    const el = $("roomHud"); if (!el) return; const main = D.bots.filter((x) => x.group === "main"), tot = main.reduce((s, x) => s + (x.value || 0), 0), st = main.reduce((s, x) => s + (x.start || 0), 0);
    const open = main.reduce((s, x) => s + x.positions.length, 0), today = Date.now() - 864e5, fills = main.reduce((s, x) => s + x.trades.filter((t) => t.t > today).length, 0);
    const q = D.raw.quant && D.raw.quant.latest, dk = D.raw.desk, k = D.coach;
    const cell = (l, v, c = "") => `<div><small>${l}</small><b class="${c}">${v}</b></div>`;
    const html = cell("PAPER EQUITY", main.length ? money(tot) : "—") + cell("SINCE START", main.length && st ? pct(tot / st - 1, 2) : "—", cls(tot - st)) + cell("OPEN POSITIONS", String(open)) + cell("FILLS · 24H", String(fills))
      + cell("REGIME", q ? h(String(q.regime).toUpperCase()) : "—") + cell("RISK DESK", dk ? h(String(dk.mode).toUpperCase()) : "—", dk && dk.mode !== "armed" ? "or" : "") + cell("COACH FIXES", k ? String((k.fixed || []).length) : "—", k && (k.fixed || []).length ? "or" : "")
      + cell("SPIDER", D.spider && D.spider.running ? "WORKING" : "IDLE", D.spider && D.spider.running ? "or" : "");
    if (el.innerHTML !== html) el.innerHTML = html;
  }
  function drawRoom() {
    if (D.view !== "room") return; const k = setup($("room")); if (!k) return; const { c, w, hh } = k, t = performance.now() / 1000, p = (x, y, z) => P(x, y, z, w, hh);
    if (!drawRoom.hudAt || t - drawRoom.hudAt > 1) { drawRoom.hudAt = t; hud(); }
    const bg = c.createRadialGradient(w / 2, hh * 0.45, 40, w / 2, hh / 2, w * 0.75); bg.addColorStop(0, "#15110b"); bg.addColorStop(1, "#030303"); c.fillStyle = bg; c.fillRect(0, 0, w, hh);
    const quad = (pts, fill, stroke) => { c.beginPath(); pts.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]))); c.closePath(); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.stroke(); } };
    // floor: polished dark tiles, a fine grid and the orange rim
    quad([p(-6, 0, -6), p(6, 0, -6), p(6, 0, 6), p(-6, 0, 6)], "#0a0907");
    c.strokeStyle = "rgba(255,153,31,.06)"; for (let i = -6; i <= 6; i += 0.5) { let a = p(i, 0, -6), b = p(i, 0, 6); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); a = p(-6, 0, i); b = p(6, 0, i); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
    c.strokeStyle = "rgba(255,153,31,.5)"; c.lineWidth = 2; c.beginPath(); [[-6, -6], [6, -6], [6, 6], [-6, 6], [-6, -6]].forEach(([x, z], i) => { const q = p(x, 0, z); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }); c.stroke(); c.lineWidth = 1;
    // back walls: a video wall (left) and an LED ticker ribbon (right)
    const back = p(-6, 0, -6)[2] < p(6, 0, 6)[2];
    if (back) {
      quad([p(-6, 0, -6), p(-6, 0, 6), p(-6, 2.9, 6), p(-6, 2.9, -6)], "#0b0a09", "#2a2016");
      quad([p(-6, 0, -6), p(6, 0, -6), p(6, 2.9, -6), p(-6, 2.9, -6)], "#0d0b09", "#2a2016");
      onPlane(c, p(-6, 2.7, 5.4), p(-6, 2.7, -5.4), p(-6, 0.35, 5.4), 1100, 300, (g) => drawWall(g, 1100, 300, t));
      // ticker ribbon: every holding with its P&L, scrolling
      const items = []; for (const b of D.bots.filter((x) => x.group === "main")) for (const q of b.positions) if (Number.isFinite(q.pnl)) items.push(q);
      onPlane(c, p(-5.6, 2.75, -6), p(5.6, 2.75, -6), p(-5.6, 2.35, -6), 1400, 56, (g) => {
        g.fillStyle = "#050505"; g.fillRect(0, 0, 1400, 56); g.strokeStyle = "rgba(255,153,31,.5)"; g.strokeRect(1, 1, 1398, 54); g.font = "600 26px monospace";
        if (!items.length) { g.fillStyle = "#4a4a4a"; g.fillText("NO OPEN POSITIONS", 20, 38); return; }
        const segs = items.map((q) => [q.sym + " ", (q.pnl >= 0 ? "▲ +" : "▼ −") + "$" + Math.abs(q.pnl).toFixed(0) + "    ", q.pnl >= 0 ? UPC : DNC]);
        const width = segs.reduce((s, x) => s + g.measureText(x[0] + x[1]).width, 0); let x = 20 - ((t * 60) % Math.max(width, 1));
        g.save(); g.beginPath(); g.rect(4, 2, 1392, 52); g.clip();
        while (x < 1400) { for (const [a2, b2, col] of segs) { g.fillStyle = "#f2f2f2"; g.fillText(a2, x, 38); x += g.measureText(a2).width; g.fillStyle = col; g.fillText(b2, x, 38); x += g.measureText(b2).width; } if (width <= 0) break; }
        g.restore();
      });
      // a second, smaller panel on the right wall: the Coach's latest flag and the desk mode
      onPlane(c, p(-5.6, 2.2, -6), p(5.6, 2.2, -6), p(-5.6, 1.15, -6), 1400, 190, (g) => {
        g.fillStyle = "#07090b"; g.fillRect(0, 0, 1400, 190); g.strokeStyle = "#2a2016"; g.strokeRect(1, 1, 1398, 188);
        g.fillStyle = OR; g.font = "600 22px monospace"; g.fillText("VP OF FINANCE · FIXED", 20, 36);
        g.font = "20px monospace"; g.fillStyle = "#d8d8d8"; const f = ((D.coach && D.coach.fixed) || []).map((x) => x.fix);
        (f.length ? f.slice(0, 4) : [D.coach ? "Nothing needed fixing." : "Reviewing…"]).forEach((x, i) => g.fillText("• " + String(x).slice(0, 110), 20, 72 + i * 30));
      });
    }
    const A = agents(); room.hits = [];
    // spotlights under each desk, tinted by that bot's result
    for (const a of A) { const q = p(a.x, 0, a.z + 0.3), r = Math.min(w / 17.5, hh / 15) * 2.4, tone = a.b ? (a.b.ret >= 0 ? "61,220,132" : "255,95,95") : "255,153,31";
      const gr = c.createRadialGradient(q[0], q[1], 2, q[0], q[1], r); gr.addColorStop(0, `rgba(${tone},.16)`); gr.addColorStop(1, "rgba(0,0,0,0)"); c.fillStyle = gr; c.beginPath(); c.ellipse(q[0], q[1], r, r * 0.5, 0, 0, Math.PI * 2); c.fill(); }
    // data flowing from the spider to every desk
    const s0 = A[0];
    for (const [n, a] of A.slice(1).entries()) { const p1 = p(s0.x, 0.05, s0.z), p2 = p(a.x, 0.05, a.z); c.setLineDash([3, 6]); c.lineDashOffset = -t * 18; c.strokeStyle = "rgba(255,153,31,.3)"; c.beginPath(); c.moveTo(p1[0], p1[1]); c.lineTo(p2[0], p2[1]); c.stroke(); c.setLineDash([]);
      for (let k2 = 0; k2 < 2; k2++) { const f = (t * 0.35 + n * 0.17 + k2 * 0.5) % 1, X = p1[0] + (p2[0] - p1[0]) * f, Y = p1[1] + (p2[1] - p1[1]) * f; c.fillStyle = "rgba(255,153,31,.9)"; c.beginPath(); c.arc(X, Y, 2.2, 0, Math.PI * 2); c.fill(); c.fillStyle = "rgba(255,153,31,.18)"; c.beginPath(); c.arc(X, Y, 6, 0, Math.PI * 2); c.fill(); } }
    A.slice().sort((a, b) => p(a.x, 0, a.z)[2] - p(b.x, 0, b.z)[2]).forEach((a) => {
      const dx = 1.3, dz = 0.65, top = 0.75, on = a.busy, sc = screens(a);
      // desk: body, side, glass top with an orange edge light
      quad([p(a.x - dx, 0, a.z + dz), p(a.x + dx, 0, a.z + dz), p(a.x + dx, top, a.z + dz), p(a.x - dx, top, a.z + dz)], "#101010", "#2a2a2a");
      quad([p(a.x + dx, 0, a.z - dz), p(a.x + dx, 0, a.z + dz), p(a.x + dx, top, a.z + dz), p(a.x + dx, top, a.z - dz)], "#0b0b0b", "#222");
      const topPts = [[-dx, -dz], [dx, -dz], [dx, dz], [-dx, dz]].map(([x, z]) => p(a.x + x, top, a.z + z)); quad(topPts, "#181818", on ? OR : "#3a3a3a");
      // name plate on the desk front: name and result
      onPlane(c, p(a.x - dx + 0.12, top - 0.08, a.z + dz), p(a.x + dx - 0.12, top - 0.08, a.z + dz), p(a.x - dx + 0.12, top - 0.42, a.z + dz), 260, 40, (g) => {
        g.fillStyle = "#050505"; g.fillRect(0, 0, 260, 40); g.strokeStyle = on ? "rgba(255,153,31,.6)" : "#2a2a2a"; g.strokeRect(0.5, 0.5, 259, 39);
        g.font = "600 15px monospace"; g.fillStyle = on ? OR : "#bdbdbd"; g.fillText(a.name.slice(0, 16), 8, 26);
        if (a.b) { g.textAlign = "right"; g.fillStyle = a.b.ret >= 0 ? UPC : DNC; g.fillText(pct(a.b.ret, 1), 252, 26); g.textAlign = "left"; } });
      // keyboard
      quad([p(a.x - 0.45, top + 0.01, a.z + 0.05), p(a.x + 0.45, top + 0.01, a.z + 0.05), p(a.x + 0.45, top + 0.01, a.z + 0.35), p(a.x - 0.45, top + 0.01, a.z + 0.35)], "#222", "#333");
      // three monitors on stands, slightly angled, each showing real data
      [-0.86, 0, 0.86].forEach((m, i) => {
        const mw = 0.4, y0 = top + 0.18, y1 = top + 1.0, ang = m * 0.18, z = a.z - dz + 0.12 + Math.abs(m) * 0.12;
        const L = [a.x + m - mw, z + ang * mw], R = [a.x + m + mw, z - ang * mw];
        quad([p(a.x + m - 0.04, top, a.z - dz + 0.25), p(a.x + m + 0.04, top, a.z - dz + 0.25), p(a.x + m + 0.04, y0, z), p(a.x + m - 0.04, y0, z)], "#1a1a1a");
        quad([p(L[0], y0 - 0.02, L[1] - 0.02), p(R[0], y0 - 0.02, R[1] - 0.02), p(R[0], y1 + 0.02, R[1] - 0.02), p(L[0], y1 + 0.02, L[1] - 0.02)], "#111", on ? "rgba(255,153,31,.4)" : "#2c2c2c");
        if (sc[i]) onPlane(c, p(L[0], y1, L[1]), p(R[0], y1, R[1]), p(L[0], y0, L[1]), 200, 150, (g) => drawScreen(g, sc[i], 200, 150, on, t + i));
      });
      // the agent in a chair, facing the screens
      const bob = a.busy ? Math.sin(t * 3 + a.x) * 0.04 : 0, sx = a.x, sz = a.z + dz + 0.6, r = Math.min(w / 17.5, hh / 15) * 0.26;
      quad([p(sx - 0.35, 0.55, sz + 0.3), p(sx + 0.35, 0.55, sz + 0.3), p(sx + 0.35, 1.45, sz + 0.38), p(sx - 0.35, 1.45, sz + 0.38)], "#151515", "#2a2a2a"); // chair back
      const head = p(sx, 1.3 + bob, sz), body = p(sx, 0.85 + bob, sz);
      c.fillStyle = "#2b2b2b"; c.beginPath(); c.ellipse(body[0], body[1], r * 1.15, r * 1.3, 0, 0, Math.PI * 2); c.fill(); // jacket
      c.fillStyle = "#d9d9d9"; c.beginPath(); c.moveTo(body[0] - r * 0.25, body[1] - r * 1.1); c.lineTo(body[0] + r * 0.25, body[1] - r * 1.1); c.lineTo(body[0], body[1] - r * 0.2); c.closePath(); c.fill(); // shirt
      c.fillStyle = on ? OR : "#666"; c.fillRect(body[0] - r * 0.08, body[1] - r * 0.95, r * 0.16, r * 0.9); // tie
      c.fillStyle = "#e8e8e8"; c.beginPath(); c.arc(head[0], head[1], r, 0, Math.PI * 2); c.fill();
      c.strokeStyle = on ? OR : "#7a7a7a"; c.lineWidth = 3; c.beginPath(); c.arc(head[0], head[1], r * 1.1, Math.PI * 1.05, Math.PI * 1.95); c.stroke(); c.lineWidth = 1; // headset
      c.fillStyle = on ? OR : "#7a7a7a"; c.beginPath(); c.arc(head[0] - r * 1.05, head[1], r * 0.22, 0, Math.PI * 2); c.fill();
      if (a.busy) { c.strokeStyle = "rgba(255,153,31,.45)"; c.beginPath(); c.arc(head[0], head[1], r * (1.6 + (t % 1)), 0, Math.PI * 2); c.stroke(); }
      // label above everything
      const lp = [head[0], head[1] - r * 2.6]; c.textAlign = "center"; c.font = "600 11px monospace"; c.fillStyle = a.busy ? OR : "#9a9a9a"; c.fillText(a.name, lp[0], lp[1]);
      c.font = "11px sans-serif"; c.fillStyle = "#bdbdbd"; c.fillText(String(a.now).slice(0, 48), lp[0], lp[1] + 14); c.textAlign = "left";
      const xs = [...topPts.map((q) => q[0]), head[0]], ys = [...topPts.map((q) => q[1]), head[1] + r * 2, lp[1] - 12];
      room.hits.push({ id: a.id, x0: Math.min(...xs) - 12, x1: Math.max(...xs) + 12, y0: Math.min(...ys) - 60, y1: Math.max(...ys) });
    });
  }
  const rc = $("room");
  rc.addEventListener("mousedown", (e) => { room.drag = { x: e.clientX, rot: D.rot, moved: false }; });
  window.addEventListener("mousemove", (e) => { if (!room.drag) return; const dx = e.clientX - room.drag.x; if (Math.abs(dx) > 3) room.drag.moved = true; D.rot = room.drag.rot + dx / 240; });
  window.addEventListener("mouseup", (e) => {
    const d = room.drag; room.drag = null; if (!d || d.moved || e.target !== rc) return;
    const r = rc.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, hit = room.hits.slice().reverse().find((k) => x >= k.x0 && x <= k.x1 && y >= k.y0 && y <= k.y1);
    if (hit) { D.botId = hit.id; D.tab = "overview"; show("bot"); }
  });
  function agentCard() {
    const el = $("agent"), a = agents().find((x) => x.id === D.agent); if (!a) { el.hidden = true; return; } el.hidden = false;
    el.innerHTML = `<span class="state ${a.busy ? "" : "idle"}">${a.busy ? "WORKING" : "IDLE"}</span><h4>${h(a.name)}</h4><div class="role">${h(a.role)}</div>
      <small>NOW</small><p class="now">${h(a.now)}</p><small>WHY</small><p>${h(a.why || "—")}</p><small>FOUND</small><p>${h(a.found || "—")}</p><small>NEXT STEP</small><p>${h(a.next || "—")}</p>
      <small>ON ITS SCREEN</small><canvas id="agentPic"></canvas><button class="back" id="agentBack">Back to the room · Esc</button>`;
    $("agentBack").onclick = () => { D.agent = null; agentCard(); };
    if (a.b && a.b.equity.length > 1) line($("agentPic"), [{ values: a.b.equity.map((q) => q.v), color: OR, fill: "rgba(255,153,31,.2)" }], { fmt: (v) => "$" + (v / 1000).toFixed(0) + "k" });
    else { const k = setup($("agentPic")); if (k) { k.c.font = "11px monospace"; k.c.fillStyle = "#8a8a8a"; (a.jobs || []).slice(0, 6).forEach((j, i) => k.c.fillText(`${tm(j.started)} ${String(j.label).slice(0, 40)}`, 10, 18 + i * 17)); if (!(a.jobs || []).length) k.c.fillText("Nothing on screen yet", 10, 20); } }
  }

  // ---------------------------------------------------------------- PAPER, DECISIONS, COSTS, MACHINES
  function paper() {
    const rows = D.bots.flatMap((b) => b.positions.map((q) => ({ ...q, bot: b.name })));
    $("paper").innerHTML = `<div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:12px">${D.bots.filter((b) => b.group === "main").map((b) => `<div class="card"><div class="cb"><div class="dim mono" style="font-size:10px;letter-spacing:.14em">${h(b.name.toUpperCase())} · PAPER</div><div class="mono" style="font-size:24px;margin:4px 0">${money(b.value)}</div><div class="${cls(b.ret)} mono">${pct(b.ret)}${b.benchRet != null ? ` <span class="dim">vs S&amp;P ${pct(b.benchRet)}</span>` : ""}</div></div></div>`).join("")}</div>
      ${rows.length ? `<table><tr><th>BOT</th><th>STOCK</th><th>VALUE</th><th>P&amp;L</th><th>WEIGHT</th></tr>${rows.map((q) => `<tr><td>${h(q.bot)}</td><td>${h(q.sym)}</td><td>${money(q.value)}</td><td class="${cls(q.pnl)}">${money(q.pnl)}</td><td>${q.weight != null ? (q.weight * 100).toFixed(1) + "%" : ""}</td></tr>`).join("")}</table>` : '<div class="empty">No open positions.</div>'}
      <div class="note">Live trading: none. Every account here is paper money; fills use real quotes with modeled costs.</div>`;
  }
  function declog() {
    const items = [...gates().map((g) => ({ t: null, kind: g.status === "fail" ? "PAUSED" : g.status === "pass" ? "PASSED" : "WAITING", cls: g.status === "fail" ? "bad" : g.status === "pass" ? "ok" : "warn", text: `${g.name}: ${g.label}`, sub: g.gate || g.detail || "" })),
      ...checks().map((c) => ({ t: c.t, kind: c.verdict === "veto" ? "VETO" : "CAUTION", cls: c.verdict === "veto" ? "bad" : "warn", text: `${c.sym} (#${c.rank}) · ${c.note}`, sub: (c.evidence || []).map((e) => e.headline + (e.source ? ` (${e.source})` : "")).join(" · ") }))];
    const q = D.raw.quant && D.raw.quant.latest; if (q && q.regimeNote) items.unshift({ t: q.t, kind: "REGIME", cls: "warn", text: `Quant trader: ${q.regimeNote}`, sub: q.spiderStress ? `Spider: ${q.spiderStress}` : "" });
    const sw = D.raw.swing && D.raw.swing.lastScan; if (sw && (sw.stress || sw.caution)) items.unshift({ t: sw.t, kind: sw.stress ? "DEFENSE" : "CAUTION", cls: sw.stress ? "bad" : "warn", text: `Swing bot: ${sw.stress || sw.caution}`, sub: sw.stress ? "High-risk holdings trimmed first; no new high-risk buys today." : "New high-risk buys paused." });
    $("declog").innerHTML = items.length ? items.map((x) => `<div class="row"><span><span class="tag ${x.cls}">${x.kind}</span>${h(x.text)}${x.sub ? `<div class="note" style="margin:3px 0 0">${h(x.sub)}</div>` : ""}</span><span class="dim mono" style="white-space:nowrap">${x.t ? h(when(x.t)) : ""}</span></div>`).join("") + '<div class="note">All of these are made by fixed rules on their own. Nothing waits for your approval.</div>' : '<div class="empty">No decisions yet.</div>';
  }
  function costs() {
    const sum = (j) => ((j && j.trades) || []).reduce((a, t) => a + (Number.isFinite(t.cost) ? t.cost : 0), 0);
    const rows = [["Swing bot", sum(D.raw.swing)], ["Day trader", sum(D.raw.day)], ["Quant trader", sum(D.raw.quant)], ...((D.raw.lab && D.raw.lab.experiments) || []).map((e) => [e.label, e.costs])];
    const total = rows.reduce((a, r) => a + (r[1] || 0), 0), box = (k, v, s) => `<div class="card"><div class="cb"><div class="dim mono" style="font-size:10px;letter-spacing:.14em">${k}</div><div class="mono" style="font-size:26px">${v}</div><div class="dim" style="font-size:11.5px">${s}</div></div></div>`;
    $("costs").innerHTML = `<div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:12px">${box("AI MODEL SPEND", "$0", "no paid AI in the bots or the spider")}${box("DATA", "$0", "SEC, FRED, Treasury, Yahoo, Finnhub free tiers")}${box("TRADING COSTS (MODELED)", money(total), "spread + slippage on paper fills")}</div>
      ${rows.map(([n, c]) => `<div class="row"><span>${h(n)}</span><span class="mono">${money(c, 2)}</span></div>`).join("")}`;
  }
  function machines() {
    const s = D.raw.sys; if (!s) { $("machines").innerHTML = '<div class="empty">System health unavailable.</div>'; return; }
    const ok = (t) => (t ? `<span class="up">● ${h(when(t))}</span>` : '<span class="dim">● never</span>'), col = (t) => `<div class="dim mono" style="font-size:10px;letter-spacing:.14em;margin-bottom:6px">${t}</div>`;
    $("machines").innerHTML = `<div class="grid g2"><div>${col("PUBLIC SERVER · RUNS THE BOTS AND THE SPIDER")}
      <div class="row"><span>Version</span><span class="mono">${h(((s.deployed && s.deployed.commit) || "—").slice(0, 7))} · node ${h(s.deployed && s.deployed.node)}</span></div>
      <div class="row"><span>Up for</span><span class="mono">${s.deployed && s.deployed.uptimeSec != null ? (s.deployed.uptimeSec / 3600).toFixed(1) + " h" : "—"}</span></div>
      <div class="row"><span>Durable storage</span><span>${s.config && s.config.durableStorage ? '<span class="up">on</span>' : '<span class="down">off</span>'}</span></div>
      <div class="row"><span>Spider scheduler</span><span>${h(s.scheduler ? `${s.scheduler.state}${s.scheduler.running ? " · " + s.scheduler.running : ""}` : "—")}</span></div>
      <div class="row"><span>Swing bot last tick</span><span>${ok(s.trader && s.trader.swing && s.trader.swing.lastTick)}</span></div></div>
      <div>${col("DATA SOURCES")}${(s.sources || []).map((x) => `<div class="row"><span>${h(x.name)}</span><span>${x.lastFail && (!x.lastOk || x.lastFail > x.lastOk) ? '<span class="down">● failing</span>' : ok(x.lastOk)}</span></div>`).join("")}</div></div>
      <div class="note">This laptop runs Market Desk and Bot HQ; the always-on public server runs the bots and the spider.</div>`;
  }

  // ---------------------------------------------------------------- animation loop + start
  function frame() { try { drawGlobe(); drawBrain(); drawRoom(); } catch (e) { console.warn(e); } requestAnimationFrame(frame); }
  window.addEventListener("resize", () => render());
  window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (/^bot\/[a-z]+$/.test(v)) { if (D.view !== "bot" || D.botId !== v.slice(4)) { D.botId = v.slice(4); show("bot"); } } else if (v !== D.view && document.getElementById("v-" + v)) show(v); });
  get("/api/health").then((x) => { if (x.mainUrl && /^https?:\/\//.test(x.mainUrl)) { $("backLink").href = x.mainUrl; $("backLink").hidden = false; } if (x.mode === "local") $("signOut").hidden = true; }).catch(() => {});
  $("homeBtn").onclick = () => { G.open = false; show("globe"); };
  $("toGlobe").onclick = () => show("globe");
  const start = location.hash.slice(1); if (/^bot\/[a-z]+$/.test(start)) { D.botId = start.slice(4); show("bot"); } else if (["globe", "overview", "lab", "research", "strategies", "rules", "room", "paper", "decisions", "costs", "machines"].includes(start)) show(start); else show("globe");
  loadBots(); loadSpider(); loadCoach(); setInterval(loadCoach, 10 * 60_000); setInterval(loadBots, 30_000); setInterval(loadSpider, 5_000);
  requestAnimationFrame(frame);
})();

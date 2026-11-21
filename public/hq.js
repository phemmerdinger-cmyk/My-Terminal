/* Bot HQ — the bot control room. Reads the bots' and the spider's own APIs (owner / private desk only) and draws
 * them; all calculations live in hq-core.js. Refreshes the bots every 30 s and the spider every 6 s. */
(function () {
  "use strict";
  const C = window.MDHQCore;
  const $ = (id) => document.getElementById(id);
  const h = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => (Number.isFinite(n) ? (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—");
  const pct = (n, d = 2) => (Number.isFinite(n) ? (n >= 0 ? "+" : "−") + Math.abs(n * 100).toFixed(d) + "%" : "—");
  const cls = (n) => (Number.isFinite(n) ? (n >= 0 ? "up" : "down") : "");
  const tm = (t) => (t ? new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "");
  const when = (t) => (t ? new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  const get = (p) => fetch(p, { credentials: "same-origin", cache: "no-store" }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "HTTP " + r.status); return j; });
  const D = { bots: [], raw: {}, spider: null, sel: "swing", view: "overview" };

  // ---------------------------------------------------------------- navigation
  document.querySelectorAll("nav.side [data-v]").forEach((b) => (b.onclick = () => show(b.dataset.v)));
  function show(v) {
    D.view = v;
    document.querySelectorAll("nav.side [data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.id === "v-" + v));
    try { history.replaceState(null, "", "#" + v); } catch {}
    render();
  }

  // ---------------------------------------------------------------- data
  async function loadBots() {
    const names = ["autopilot", "daytrader", "quanttrader", "strategy-lab", "desk-risk", "brief", "web/signals", "web/discoveries?limit=40&sort=importance"];
    const res = await Promise.allSettled(names.map((n) => get("/api/" + n)));
    const v = (i) => (res[i].status === "fulfilled" ? res[i].value : null);
    D.raw = { swing: v(0), day: v(1), quant: v(2), lab: v(3), desk: v(4), brief: v(5), signals: v(6), finds: v(7) };
    const failed = res.filter((r) => r.status === "rejected").map((r) => r.reason && r.reason.message);
    $("errBox").innerHTML = failed.length === names.length ? `<div class="err">Bot HQ can't reach the bots right now (${h(failed[0])}). It needs the private desk or the owner sign-in.</div>` : "";
    D.bots = [C.fromMain("swing", D.raw.swing), C.fromMain("day", D.raw.day), C.fromMain("quant", D.raw.quant), ...C.fromLab(D.raw.lab)].filter(Boolean);
    render();
  }
  async function loadSpider() {
    try { D.spider = await get("/api/web/status"); } catch { D.spider = null; }
    pills(); if (D.view === "overview" || D.view === "research" || D.view === "room") render(true);
  }

  // ---------------------------------------------------------------- top bar + tape
  function pills() {
    const sp = D.spider, run = sp && sp.running;
    $("pSpider").className = "pill hide-s " + (run ? "busy" : sp ? "on" : "");
    $("pSpider").lastChild.textContent = run ? "Spider researching" : sp ? "Spider idle" : "Spider offline";
    const open = D.raw.swing && D.raw.swing.marketOpen;
    $("pMarket").className = "pill hide-s " + (open ? "on" : ""); $("pMarket").lastChild.textContent = open ? "Market open" : "Market closed";
    const dk = D.raw.desk; $("pDesk").className = "pill hide-s " + (dk && dk.mode === "armed" ? "on" : dk ? "busy" : "");
    $("pDesk").lastChild.textContent = dk ? `Desk ${dk.mode}` : "Desk risk —";
  }
  function tape(items) {
    const row = items.slice(0, 14).map((x) => `<span><span class="dim">${h(tm(x.t))}</span> <em>${h(x.who.toUpperCase())}</em> ${h(x.text.slice(0, 110))}</span>`).join("");
    $("tape").innerHTML = row ? row + row : "<span>No activity recorded yet.</span>";
  }
  setInterval(() => { $("kClock").textContent = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }); }, 1000);

  // ---------------------------------------------------------------- render
  function render(spiderOnly) {
    const swingRaw = D.raw.swing || {};
    const items = C.feed({ spider: D.spider, bots: D.bots.filter((b) => b.group === "main"), checks: (swingRaw.teamwork && swingRaw.teamwork.checks) || [] });
    tape(items);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    $("kToday").textContent = D.bots.reduce((a, b) => a + b.trades.filter((t) => t.t && new Date(t.t).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === today).length, 0);
    const paused = D.bots.filter((b) => b.toughness && b.toughness.status === "fail").length;
    $("kPaused").textContent = paused; $("nBots").textContent = D.bots.length;
    pills();
    if (D.view === "overview") overview(items, spiderOnly);
    if (D.view === "bots" && !spiderOnly) bots();
    if (D.view === "research") research();
    if (D.view === "room") room();
    if (D.view === "risk" && !spiderOnly) risk();
  }

  function overview(items, spiderOnly) {
    const main = D.bots.filter((b) => b.group === "main"), total = D.bots.reduce((a, b) => a + (b.value || 0), 0), start = D.bots.reduce((a, b) => a + (b.value != null ? b.start : 0), 0);
    const best = D.bots.filter((b) => b.ret != null).sort((a, b) => b.ret - a.ret)[0];
    const open = D.bots.reduce((a, b) => a + (b.positions.length || b.openCount || 0), 0);
    const sp = D.spider && D.spider.stats || {};
    if (!spiderOnly) $("kpis").innerHTML = [
      ["ALL BOTS (PAPER)", money(total), `${pct(start ? total / start - 1 : null)} on ${money(start)}`, cls(total - start)],
      ["BEST BOT", best ? pct(best.ret) : "—", best ? best.name : "", best ? cls(best.ret) : ""],
      ["OPEN POSITIONS", String(open), `${D.bots.length} bots`, ""],
      ["MAIN BOTS VS S&P", main.map((b) => b.benchRet != null ? pct(b.ret - b.benchRet, 1) : "—").join(" · "), "swing · day · quant (excess return)", ""],
      ["SPIDER MEMORY", String(sp.memory ?? "—"), `${sp.total ?? "—"} jobs run · ${sp.errors ?? 0} errors`, ""],
    ].map(([k, v, s, c]) => `<div class="kpi"><small>${k}</small><b class="${c}">${h(v)}</b><span>${h(s)}</span></div>`).join("");
    // brain counters
    const finds = (D.raw.finds && D.raw.finds.items) || [], byCat = {};
    for (const d of finds) byCat[d.cat] = (byCat[d.cat] || 0) + 1;
    const sig = (D.raw.signals && D.raw.signals.items) || [], checks = (D.raw.swing && D.raw.swing.teamwork && D.raw.swing.teamwork.checks) || [];
    const counter = (k, v, hot) => `<div class="counter ${hot ? "hot" : ""}"><small>${k}</small><b>${v}</b></div>`;
    $("brainL").innerHTML = counter("SEC FILINGS", (byCat.filing || 0) + (byCat.insider || 0) + (byCat.fundamentals || 0)) + counter("NEWS & MOVERS", (byCat.news || 0) + (byCat.mover || 0) + (byCat.company || 0)) + counter("EARNINGS", byCat.earnings || 0) + counter("MACRO & POLICY", (byCat.macro || 0) + (byCat.policy || 0) + (byCat.market || 0));
    $("brainR").innerHTML = counter("SIGNALS", sig.length, sig.length) + counter("NEGATIVE", sig.filter((s) => s.dir < 0).length) + counter("PRE-BUY CHECKS", checks.length, checks.length) + counter("VETOES", checks.filter((c) => c.verdict === "veto").length);
    const run = D.spider && D.spider.running;
    $("brainNow").innerHTML = run ? `NOW <b>${h(run.label)}</b> · ${h(run.note || run.phase || "")}` : D.spider ? `Idle · next: ${h((D.spider.queue && D.spider.queue[0] && D.spider.queue[0].label) || "nothing queued")}` : "Spider offline";
    globe.busy = !!run;
    $("feed").innerHTML = items.length ? items.map((x) => `<div class="it"><span class="t">${h(tm(x.t))}</span><span class="who">${h(x.who)}</span><span class="${x.kind === "veto" || x.kind === "error" ? "down" : x.kind === "buy" ? "up" : ""}">${h(x.text)}</span></div>`).join("") : '<div class="empty">No activity yet.</div>';
    if (spiderOnly) return;
    $("pipe").innerHTML = C.pipeline({ spider: D.spider, signals: D.raw.signals, swing: D.raw.swing }).map((s, i) => `<div class="st"><div class="dot">${i + 1}</div><b>${s.value == null ? "—" : s.value.toLocaleString("en-US")}</b><small>${h(s.label)}<br><span class="dim">${h(s.note)}</span></small></div>`).join("");
    const lab = D.raw.lab && D.raw.lab.toughness, gates = [];
    for (const m of (lab && lab.mainBots) || []) gates.push([m.bot, m.status, m.label, m.gate]);
    for (const b of D.bots.filter((x) => x.toughness)) gates.push([b.name, b.toughness.status, b.toughness.label, b.toughness.gate]);
    $("gates").innerHTML = gates.length ? gates.map(([n, s, l, g]) => `<div class="row"><span><span class="tag ${s === "pass" ? "pass" : s === "fail" ? "fail" : "warn"}">${h(s === "pass" ? "PASS" : s === "fail" ? "PAUSED" : s === "borderline" ? "BORDER" : "WAIT")}</span>${h(n)}</span><span class="muted" style="text-align:right">${h(l)}</span></div>`).join("") + `<div class="note">${h((lab && lab.rule) || "")}</div>` : '<div class="empty">The first toughness results arrive after the next market close.</div>';
    const b = D.raw.brief;
    $("report").innerHTML = b ? `<div class="grid g3">
      <div><div class="dim mono" style="font-size:11px;margin-bottom:6px">RISK FLAGS</div>${b.flags.length ? b.flags.slice(0, 6).map((f) => `<div class="row"><span class="${f.level === "high" ? "down" : ""}">${h(f.text)}</span></div>`).join("") : '<div class="empty">None.</div>'}</div>
      <div><div class="dim mono" style="font-size:11px;margin-bottom:6px">PLANS FOR THE OPEN</div>${b.plans.map((p) => `<div class="row"><b>${h(p.bot)}</b><span class="muted">${p.orders.length ? p.orders.slice(0, 4).map((o) => `${h(o.side)} ${h(o.sym)}`).join(", ") + (p.orders.length > 4 ? "…" : "") : h(p.empty)}</span></div>`).join("")}</div>
      <div><div class="dim mono" style="font-size:11px;margin-bottom:6px">OVERNIGHT FINDINGS</div>${b.overnight.length ? b.overnight.slice(0, 5).map((d) => `<div class="row"><span>${h(d.headline)}</span></div>`).join("") : '<div class="empty">Nothing new since the close.</div>'}</div></div>` : '<div class="empty">Morning report unavailable.</div>';
  }

  // ---------------------------------------------------------------- bots
  function spark(cv, values, color) {
    const ctx = setup(cv); if (!ctx || values.length < 2) return;
    const { w, hh } = ctx, mn = Math.min(...values), mx = Math.max(...values), sx = w / (values.length - 1), sy = (v) => hh - 2 - ((v - mn) / (mx - mn || 1)) * (hh - 4);
    ctx.c.strokeStyle = color; ctx.c.lineWidth = 1.5; ctx.c.beginPath(); values.forEach((v, i) => (i ? ctx.c.lineTo(i * sx, sy(v)) : ctx.c.moveTo(0, sy(v)))); ctx.c.stroke();
  }
  function setup(cv) {
    if (!cv) return null; const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return null; cv.width = r.width * dpr; cv.height = r.height * dpr;
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, r.width, r.height); return { c, w: r.width, hh: r.height };
  }
  function lineChart(cv, series, { fmt = (v) => v.toFixed(0), zero = false } = {}) {
    const ctx = setup(cv); if (!ctx) return; const { c, w, hh } = ctx, pad = { l: 52, r: 8, t: 8, b: 18 };
    const all = series.flatMap((s) => s.values.filter(Number.isFinite)); if (all.length < 2) { c.fillStyle = "#5c5c5c"; c.font = "12px sans-serif"; c.fillText("Not enough history yet", 12, 22); return; }
    let mn = Math.min(...all), mx = Math.max(...all); if (zero) { mn = Math.min(mn, 0); mx = Math.max(mx, 0); }
    const n = Math.max(...series.map((s) => s.values.length)), X = (i) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r), Y = (v) => pad.t + (1 - (v - mn) / (mx - mn || 1)) * (hh - pad.t - pad.b);
    c.strokeStyle = "#1e1e1e"; c.fillStyle = "#5c5c5c"; c.font = "10px monospace";
    for (let k = 0; k <= 3; k++) { const v = mn + ((mx - mn) * k) / 3, y = Y(v); c.beginPath(); c.moveTo(pad.l, y); c.lineTo(w - pad.r, y); c.stroke(); c.fillText(fmt(v), 2, y + 3); }
    for (const s of series) {
      c.strokeStyle = s.color; c.lineWidth = s.width || 1.6; c.beginPath(); let started = false;
      s.values.forEach((v, i) => { if (!Number.isFinite(v)) return; if (!started) { c.moveTo(X(i), Y(v)); started = true; } else c.lineTo(X(i), Y(v)); }); c.stroke();
      if (s.fill) { c.lineTo(X(s.values.length - 1), Y(Math.max(mn, 0))); c.lineTo(X(0), Y(Math.max(mn, 0))); c.closePath(); c.fillStyle = s.fill; c.fill(); }
    }
  }
  function bots() {
    if (!D.bots.find((b) => b.id === D.sel) && D.bots[0]) D.sel = D.bots[0].id;
    $("botList").innerHTML = D.bots.map((b) => `<div class="bot ${b.id === D.sel ? "on" : ""}" data-bot="${h(b.id)}"><div><b>${h(b.name)}</b><small>${h(b.group === "main" ? b.detail || b.status : (b.status || "").split(" · ")[0])}</small></div><canvas data-spark="${h(b.id)}"></canvas><div class="r ${cls(b.ret)}">${pct(b.ret, 1)}</div></div>`).join("");
    document.querySelectorAll("[data-bot]").forEach((el) => (el.onclick = () => { D.sel = el.dataset.bot; bots(); }));
    document.querySelectorAll("[data-spark]").forEach((cv) => { const b = D.bots.find((x) => x.id === cv.dataset.spark); if (b && b.equity.length > 1) spark(cv, b.equity.map((p) => p.v), b.ret >= 0 ? "#3ddc84" : "#ff5a5a"); });
    const b = D.bots.find((x) => x.id === D.sel); if (!b) { $("botDetail").innerHTML = '<div class="empty">No bots reported yet.</div>'; return; }
    const st = C.stats(b.trades), months = C.monthly(b.equity).slice(-12), wk = C.whenItWorks(b.trades);
    const bar = (arr, lab) => { const mx = Math.max(1, ...arr.map((x) => Math.abs(x.pnl))); return `<div class="bars">${arr.map((x) => `<div title="${x.n} trades, ${money(x.pnl)}"><i class="${x.pnl > 0 ? "w" : x.pnl < 0 ? "l" : ""}" style="height:${Math.round((Math.abs(x.pnl) / mx) * 70)}px"></i>${h(lab(x.key))}</div>`).join("")}</div>`; };
    const tough = b.toughness || (D.raw.lab && D.raw.lab.toughness && (D.raw.lab.toughness.mainBots || []).find((m) => m.bot === b.name)) || null;
    $("botDetail").innerHTML = `
      <div class="kpis" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="kpi"><small>VALUE</small><b>${money(b.value)}</b><span>started ${money(b.start)}</span></div>
        <div class="kpi"><small>RETURN</small><b class="${cls(b.ret)}">${pct(b.ret)}</b><span>${b.benchRet != null ? `S&P ${pct(b.benchRet)} same period` : "paper money"}</span></div>
        <div class="kpi"><small>WIN RATE</small><b>${st.winRate == null ? "—" : Math.round(st.winRate * 100) + "%"}</b><span>${st.closed} closed trades</span></div>
        <div class="kpi"><small>PROFIT FACTOR</small><b>${st.profitFactor == null ? "—" : st.profitFactor.toFixed(2)}</b><span>wins ÷ losses</span></div></div>
      <div class="card"><h3>${h(b.name)} <em>${h(b.detail || b.status || "")}</em></h3>
        ${b.group === "main" ? `<canvas class="chart" id="cEq"></canvas><div class="note">Orange: the bot · grey: the S&P 500 scaled to the same start.</div><canvas class="chart sm" id="cDd" style="margin-top:8px"></canvas><div class="note">Drawdown: how far below its own high the account was.</div>`
        : `<div class="empty">Strategy Lab book · ${b.openCount ?? 0} open · ${b.queued ?? 0} queued · ${b.closed ?? 0} closed. Daily snapshots build its curve on the main site's Strategy Lab table.</div>`}</div>
      <div class="grid g2" style="margin-top:12px">
        <div class="card"><h3>Month by month <em>green = winning month</em></h3>${months.length ? `<div class="months">${months.map((m) => `<div class="${m.ret > 0 ? "w" : m.ret < 0 ? "l" : ""}" title="${m.m}: ${pct(m.ret)}">${h(m.m.slice(5))}<br>${pct(m.ret, 1)}</div>`).join("")}</div>` : '<div class="empty">Builds as the bot trades.</div>'}</div>
        <div class="card"><h3>When it works <em>P&L of closed trades, New York time</em></h3>${st.closed ? bar(wk.weekday, (k) => k) + bar(wk.hour, (k) => (k > 12 ? k - 12 : k) + (k >= 12 ? "p" : "a")) : '<div class="empty">No closed trades yet.</div>'}</div>
      </div>
      ${tough ? `<div class="card" style="margin-top:12px"><h3>Toughness test <em>${h(tough.label || tough.status)}</em></h3>${(tough.checks || []).map((c) => `<div class="row"><span>${c.ok ? '<span class="tag pass">✓</span>' : '<span class="tag fail">✗</span>'}${h(c.label)}</span><span class="mono">${h(c.value)}</span></div>`).join("") || `<div class="muted">${h(tough.detail || tough.why || "")}</div>`}<div class="note">${h(tough.gate || "")} ${h(tough.limits || "")}</div></div>` : ""}
      <div class="grid g2" style="margin-top:12px">
        <div class="card"><h3>Holding now</h3>${b.positions.length ? `<table><tr><th>Stock</th><th>Value</th><th>P&L</th></tr>${b.positions.map((p) => `<tr><td>${h(p.sym)}${p.note ? ` <span class="dim">${h(p.note)}</span>` : ""}</td><td>${money(p.value)}</td><td class="${cls(p.pnl)}">${money(p.pnl)}</td></tr>`).join("")}</table>` : '<div class="empty">No open positions.</div>'}</div>
        <div class="card"><h3>Working on next</h3>${b.plans.length ? b.plans.slice(0, 12).map((o) => `<div class="row"><span><span class="tag ${o.side === "BUY" ? "pass" : "fail"}">${h(o.side)}</span>${h(o.sym)} ${o.amount ? money(o.amount) : ""} <span class="dim">${h(o.when)}</span></span></div><div class="note" style="margin:0 0 4px">${h(String(o.why || "").slice(0, 200))}</div>`).join("") : '<div class="empty">Nothing queued right now.</div>'}</div>
      </div>
      <div class="card" style="margin-top:12px"><h3>Recent trades <em>with the bot's own reason</em></h3>${b.trades.length ? `<table><tr><th>When</th><th>Side</th><th>Stock</th><th>P&L</th><th style="text-align:left">Why</th></tr>${b.trades.slice(0, 25).map((t) => `<tr><td class="mono">${h(when(t.t))}</td><td>${h(t.side)}</td><td>${h(t.sym)}</td><td class="${cls(t.pnl)}">${t.pnl == null ? "" : money(t.pnl)}</td><td class="why">${h(t.why)}</td></tr>`).join("")}</table>` : '<div class="empty">No trades yet.</div>'}</div>`;
    if (b.group === "main") {
      const v = b.equity.map((p) => p.v), b0 = (b.equity.find((p) => p.b != null) || {}).b, bench = b.equity.map((p) => (p.b != null && b0 ? (p.b / b0) * b.start : NaN));
      lineChart($("cEq"), [{ values: bench, color: "#5c5c5c", width: 1.2 }, { values: v, color: "#ff991f", width: 2 }], { fmt: (x) => "$" + (x / 1000).toFixed(1) + "k" });
      lineChart($("cDd"), [{ values: C.drawdowns(b.equity).map((d) => d.dd * 100), color: "#ff5a5a", fill: "rgba(255,90,90,.15)" }], { fmt: (x) => x.toFixed(1) + "%", zero: true });
    }
  }

  // ---------------------------------------------------------------- research
  function research() {
    const s = D.spider;
    if (!s) { $("spNow").innerHTML = '<div class="empty">The spider isn\'t reachable.</div>'; return; }
    const r = s.running;
    $("spNow").innerHTML = `<div class="row"><span>Status</span><b class="${r ? "" : "muted"}">${r ? "Researching" : "Idle"}</b></div>${r ? `<div class="row"><span>Job</span><span>${h(r.label)}</span></div><div class="row"><span>Step</span><span class="muted">${h(r.note || r.phase || "")}</span></div>` : ""}
      <div class="row"><span>Budget</span><span class="mono">${s.stats && s.stats.budget ? `${s.stats.budget.used} / ${s.stats.budget.max} jobs this hour` : "—"}</span></div>
      <div class="dim mono" style="font-size:11px;margin:12px 0 4px">QUEUE (${s.queued || 0})</div>${(s.queue || []).slice(0, 8).map((q) => `<div class="row"><span>${h(q.label)}</span><span class="dim">${h((q.why || [])[0] || "")}</span></div>`).join("") || '<div class="empty">Empty.</div>'}`;
    $("spJobs").innerHTML = (s.recent || []).slice(0, 30).map((j) => `<div class="it"><span class="t">${h(tm(j.started))}</span><span class="who">${h(j.area || "")}</span>${h(j.label)} ${j.status === "error" ? '<span class="down">failed</span>' : `<span class="dim">${h(j.summary || j.status || "")}</span>`}</div>`).join("") || '<div class="empty">No jobs yet.</div>';
    const f = (D.raw.finds && D.raw.finds.items) || [];
    $("spFind").innerHTML = f.length ? f.slice(0, 25).map((d) => `<div class="row"><span><span class="tag">${h(d.cat)}</span><span class="${d.tone > 0 ? "up" : d.tone < 0 ? "down" : ""}">${d.tone > 0 ? "▲" : d.tone < 0 ? "▼" : "•"}</span> ${h(d.headline)}</span><span class="dim" style="white-space:nowrap">${h(((d.sources || [])[0] || {}).name || "")} · ${h(when(d.u))}</span></div>`).join("") : '<div class="empty">No findings stored yet.</div>';
  }

  // ---------------------------------------------------------------- risk & costs
  function risk() {
    const dk = D.raw.desk;
    $("riskBox").innerHTML = dk ? `<div class="row"><span>Mode</span><b>${h(dk.mode)}</b></div><div class="row"><span>Why</span><span class="muted">${h(dk.reason || "")}</span></div>
      ${dk.state ? `<div class="row"><span>Daily loss</span><span class="mono">${money(dk.state.dailyLoss)} of ${money(dk.policy && dk.policy.hardDaily)} stop</span></div><div class="row"><span>Drawdown from high</span><span class="mono">${money(dk.state.drawdown)} of ${money(dk.policy && dk.policy.peakStop)} lock</span></div>` : ""}
      ${dk.exposure ? `<div class="row"><span>Open stop risk</span><span class="mono">${money(dk.exposure.stopRisk)}</span></div><div class="row"><span>Market beta $</span><span class="mono">${money(dk.exposure.betaDollars)}</span></div>` : ""}
      <div class="note">One shared risk budget for every bot: a daily loss stop, a drawdown lock and limits on market exposure.</div>` : '<div class="empty">Desk risk unavailable.</div>';
    const cost = (j) => ((j && j.trades) || []).reduce((a, t) => a + (Number.isFinite(t.cost) ? t.cost : 0), 0);
    const labRows = ((D.raw.lab && D.raw.lab.experiments) || []).map((e) => [e.label, e.costs]);
    $("costBox").innerHTML = [["Swing bot", cost(D.raw.swing)], ["Day trader", cost(D.raw.day)], ["Quant trader", cost(D.raw.quant)], ...labRows].map(([n, c]) => `<div class="row"><span>${h(n)}</span><span class="mono">${money(c)}</span></div>`).join("")
      + `<div class="row"><span><b>AI model spend</b></span><b class="mono">$0</b></div><div class="note">Trading costs are modeled (spread + slippage) on paper fills. No paid AI runs in the bots or the spider.</div>`;
  }

  // ---------------------------------------------------------------- globe (research brain)
  const globe = { a: 0, busy: false, pts: [] };
  for (let i = 0; i < 520; i++) { const y = 1 - (i / 519) * 2, r = Math.sqrt(1 - y * y), th = i * 2.39996; globe.pts.push([Math.cos(th) * r, y, Math.sin(th) * r]); }
  function drawGlobe() {
    const cv = $("globe"); if (cv && D.view === "overview") {
      const ctx = setup(cv); if (ctx) {
        const { c, w, hh } = ctx, R = Math.min(w, hh) * 0.42, cx = w / 2, cy = hh / 2, sa = Math.sin(globe.a), ca = Math.cos(globe.a);
        for (const [x, y, z] of globe.pts) { const X = x * ca + z * sa, Z = -x * sa + z * ca, k = (Z + 1.4) / 2.4; c.fillStyle = globe.busy ? `rgba(255,153,31,${0.15 + 0.7 * k})` : `rgba(200,200,200,${0.08 + 0.45 * k})`; c.fillRect(cx + X * R, cy + y * R, 1.6 * k + 0.4, 1.6 * k + 0.4); }
        c.strokeStyle = globe.busy ? "rgba(255,153,31,.35)" : "rgba(120,120,120,.2)"; c.beginPath(); c.arc(cx, cy, R * 1.08, 0, Math.PI * 2); c.stroke();
      }
      globe.a += globe.busy ? 0.012 : 0.004;
    }
    if (D.view === "room") drawRoom();
    requestAnimationFrame(drawGlobe);
  }

  // ---------------------------------------------------------------- agent room
  const desks = [];
  function room() { /* drawn every frame by drawRoom */ }
  function deskList() {
    const sp = D.spider, b = (id) => D.bots.find((x) => x.id === id);
    const say = (x) => (x ? (x.plans.length ? `${x.plans.length} order${x.plans.length > 1 ? "s" : ""} queued` : x.positions.length ? `holding ${x.positions.length}` : "watching") : "offline");
    const lab = D.bots.filter((x) => x.group === "lab");
    return [
      { id: "spider", name: "SPIDER", text: sp && sp.running ? sp.running.label : sp ? "idle" : "offline", busy: !!(sp && sp.running), go: "research" },
      { id: "swing", name: "SWING BOT", text: b("swing") ? [b("swing").detail, say(b("swing"))].filter(Boolean).join(" · ") : "offline", busy: !!(b("swing") && b("swing").plans.length), go: "swing" },
      { id: "day", name: "DAY TRADER", text: say(b("day")), busy: !!(b("day") && b("day").positions.length), go: "day" },
      { id: "quant", name: "QUANT", text: b("quant") ? [b("quant").detail, say(b("quant"))].filter(Boolean).join(" · ") : "offline", busy: !!(b("quant") && b("quant").plans.length), go: "quant" },
      { id: "lab", name: `STRATEGY LAB · ${lab.length}`, text: `${lab.reduce((a, x) => a + (x.openCount || 0), 0)} open · ${lab.filter((x) => x.toughness && x.toughness.status === "fail").length} paused`, busy: lab.some((x) => x.queued), go: lab[0] ? lab[0].id : null },
      { id: "risk", name: "RISK DESK", text: D.raw.desk ? `${D.raw.desk.mode}: ${D.raw.desk.reason || ""}` : "—", busy: !!(D.raw.desk && D.raw.desk.mode !== "armed"), go: "risk" },
    ];
  }
  let roomT = 0;
  function drawRoom() {
    const cv = $("room"), ctx = setup(cv); if (!ctx) return; const { c, w, hh } = ctx; roomT += 0.03;
    const L = deskList(), cols = 3, cw = w / cols, rh = hh / 2; desks.length = 0;
    // floor grid (isometric lines)
    c.strokeStyle = "rgba(255,153,31,.06)"; for (let x = -hh; x < w; x += 40) { c.beginPath(); c.moveTo(x, hh); c.lineTo(x + hh * 0.9, 0); c.stroke(); c.beginPath(); c.moveTo(x + hh * 0.9, hh); c.lineTo(x, 0); c.stroke(); }
    // links to the spider
    const pos = L.map((d, i) => [cw * (i % cols) + cw / 2, rh * Math.floor(i / cols) + rh / 2]);
    c.setLineDash([4, 6]); c.lineDashOffset = -roomT * 20; c.strokeStyle = "rgba(255,153,31,.25)";
    for (let i = 1; i < pos.length; i++) { c.beginPath(); c.moveTo(pos[0][0], pos[0][1]); c.lineTo(pos[i][0], pos[i][1]); c.stroke(); }
    c.setLineDash([]);
    L.forEach((d, i) => {
      const [x, y] = pos[i], dw = Math.min(200, cw - 30), dh = 54;
      // desk
      c.fillStyle = "#141414"; c.strokeStyle = d.busy ? "#ff991f" : "#2e2e2e"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x - dw / 2, y + 8); c.lineTo(x, y + 8 + dh / 2); c.lineTo(x + dw / 2, y + 8); c.lineTo(x, y + 8 - dh / 2); c.closePath(); c.fill(); c.stroke();
      // screen
      c.fillStyle = d.busy ? "rgba(255,153,31,.18)" : "rgba(255,255,255,.05)"; c.fillRect(x - 26, y - 30, 52, 30); c.strokeStyle = "#3a3a3a"; c.strokeRect(x - 26, y - 30, 52, 30);
      for (let k = 0; k < 4; k++) { c.fillStyle = d.busy ? "rgba(255,153,31,.7)" : "rgba(200,200,200,.25)"; c.fillRect(x - 20, y - 25 + k * 6, 10 + ((Math.sin(roomT * 3 + k + i) + 1) * 14 * (d.busy ? 1 : 0.3)), 2); }
      // agent
      const bob = d.busy ? Math.sin(roomT * 4 + i) * 2 : 0;
      c.fillStyle = "#d9d9d9"; c.beginPath(); c.arc(x + dw / 4, y - 4 + bob, 7, 0, Math.PI * 2); c.fill(); c.fillStyle = "#9a9a9a"; c.fillRect(x + dw / 4 - 7, y + 4 + bob, 14, 12);
      if (d.busy) { c.strokeStyle = "rgba(255,153,31,.6)"; c.beginPath(); c.arc(x + dw / 4, y - 4, 13 + (roomT * 8 % 10), 0, Math.PI * 2); c.stroke(); }
      // labels
      c.fillStyle = d.busy ? "#ff991f" : "#8a8a8a"; c.font = "600 11px monospace"; c.textAlign = "center"; c.fillText(d.name, x, y + dh / 2 + 26);
      c.fillStyle = "#cfcfcf"; c.font = "11.5px sans-serif"; const t = String(d.text || "").slice(0, 60); c.fillText(t, x, y + dh / 2 + 42);
      desks.push({ x: x - dw / 2, y: y - 40, w: dw, h: dh + 90, go: d.go });
    });
    c.textAlign = "left";
  }
  $("room").addEventListener("click", (e) => {
    const r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, d = desks.find((k) => x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h);
    if (!d || !d.go) return; if (d.go === "research" || d.go === "risk") show(d.go); else { D.sel = d.go; show("bots"); }
  });

  // ---------------------------------------------------------------- start
  window.addEventListener("resize", () => render());
  const start = location.hash.slice(1); if (["overview", "bots", "room", "research", "risk"].includes(start)) show(start);
  get("/api/health").then((x) => { if (x.mainUrl && /^https?:\/\//.test(x.mainUrl)) { $("backLink").href = x.mainUrl; $("backLink").hidden = false; } if (x.mode === "local") $("signOut").hidden = true; }).catch(() => {});
  loadBots(); loadSpider(); setInterval(loadBots, 30_000); setInterval(loadSpider, 6_000);
  requestAnimationFrame(drawGlobe);
})();

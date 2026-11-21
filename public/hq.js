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
  const D = { raw: {}, bots: [], spider: null, view: "overview", sel: "swing", tab: "overview", rule: 0, agent: null, rot: 0.12 };
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
    try { history.replaceState(null, "", "#" + v); } catch {}
    render();
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && D.agent) { D.agent = null; agentCard(); } });

  // ---------------------------------------------------------------- data
  async function loadBots() {
    const names = ["autopilot", "daytrader", "quanttrader", "strategy-lab", "desk-risk", "brief", "web/signals", "web/discoveries?limit=200", "system/health"];
    const res = await Promise.allSettled(names.map((n) => get("/api/" + n)));
    const v = (i) => (res[i].status === "fulfilled" ? res[i].value : null);
    D.raw = { swing: v(0), day: v(1), quant: v(2), lab: v(3), desk: v(4), brief: v(5), signals: v(6), finds: v(7), sys: v(8) };
    const bad = res.filter((r) => r.status === "rejected");
    $("errBox").innerHTML = bad.length === names.length ? `<div class="err">Bot HQ can't reach the bots (${h(bad[0].reason && bad[0].reason.message)}). Keep Market Desk running, or sign in.</div>` : "";
    D.bots = [C.fromMain("swing", D.raw.swing), C.fromMain("day", D.raw.day), C.fromMain("quant", D.raw.quant), ...C.fromLab(D.raw.lab)].filter(Boolean);
    render();
  }
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
  const CLUSTERS = [["Company & movers", ["company", "mover", "news"]], ["SEC filings", ["filing", "insider", "fundamentals"]], ["Earnings", ["earnings"]], ["Macro & policy", ["macro", "policy", "market"]], ["Sectors & patterns", ["sector", "pattern"]], ["Your portfolio", ["portfolio", "ai_trader"]]];
  const hash = (s) => { let x = 2166136261; for (const ch of String(s)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); return (x >>> 0) / 4294967296; };
  function research() {
    const fs = finds(), sp = D.spider || {}, run = sp.running; $("mapNote").textContent = `${fs.length} recent findings`;
    const sym = run && run.sym ? run.sym : null, rel = fs.filter((d) => (sym ? (d.tickers || []).includes(sym) : true)).slice(0, 5);
    const done = run && run.started ? Math.min(0.95, (Date.now() - run.started) / 90e3) : 0;
    $("readSrc").textContent = run ? (run.area || "") : "";
    $("reading").innerHTML = run ? `<h4>${h(run.label)}</h4><div class="prog"><s style="width:${Math.round(done * 100)}%"></s></div><div class="dim mono" style="font-size:11px">${h(run.note || run.phase || "working")}</div>
      <div class="quote">${rel.map((d, i) => `<span class="${i === 0 ? "cur" : ""}">${h(d.headline).replace(/\b([A-Z]{2,5})\b/g, (m) => ((d.tickers || []).includes(m) ? `<span class="hl">${m}</span>` : m))}</span>`).join("<br>") || "Collecting sources…"}</div>
      <div class="chips">${[...new Set(rel.flatMap((d) => d.tickers || []))].slice(0, 6).map((t) => `<span>${h(t)}</span>`).join("")}</div>`
      : `<h4>Idle</h4><div class="muted" style="font-size:13px">Next up: ${h((sp.queue && sp.queue[0] && sp.queue[0].label) || "nothing queued")}</div>`;
    $("stream").innerHTML = (sp.recent || []).slice(0, 30).map((j) => `<div><span class="t">${h(tm(j.started))}</span><span>${h(j.label)}${j.summary ? ` · <span class="dim">${h(j.summary)}</span>` : ""}${j.status === "error" ? ' <span class="down">failed</span>' : ""}</span></div>`).join("") || '<div class="empty">No jobs yet.</div>';
  }
  function drawMap() {
    if (D.view !== "research") return; const k = setup($("map")); if (!k) return; const { c, w, hh } = k, t = performance.now() / 1000, fs = finds();
    const pos = [[0.32, 0.36], [0.64, 0.26], [0.74, 0.68], [0.24, 0.74], [0.5, 0.56], [0.86, 0.42]];
    CLUSTERS.forEach(([label, cats], i) => {
      const items = fs.filter((d) => cats.includes(d.cat)), cx = pos[i][0] * w, cy = pos[i][1] * hh;
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, 130); g.addColorStop(0, "rgba(255,153,31,.10)"); g.addColorStop(1, "rgba(255,153,31,0)"); c.fillStyle = g; c.fillRect(cx - 130, cy - 130, 260, 260);
      items.forEach((d, j) => {
        const a = hash(d.id || d.headline) * Math.PI * 2 + t * 0.02, r = 18 + hash((d.id || d.headline) + "r") * 85, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.8;
        c.strokeStyle = "rgba(255,153,31,.10)"; c.beginPath(); c.moveTo(cx, cy); c.lineTo(x, y); c.stroke();
        const tw = 0.6 + 0.4 * Math.sin(t * 2 + j), col = d.tone > 0 ? "61,220,132" : d.tone < 0 ? "255,90,90" : "255,184,92";
        c.fillStyle = `rgba(${col},${0.5 + 0.5 * tw})`; c.shadowColor = `rgb(${col})`; c.shadowBlur = 6; c.beginPath(); c.arc(x, y, 1.6 + (d.importance || 0.3) * 2, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0;
      });
      c.fillStyle = "#fff"; c.shadowColor = OR; c.shadowBlur = 18; c.beginPath(); c.arc(cx, cy, 3.5, 0, Math.PI * 2); c.fill(); c.shadowBlur = 0;
      c.strokeStyle = "rgba(255,255,255,.22)"; c.beginPath(); c.moveTo(cx - 60, cy); c.lineTo(cx + 60, cy); c.stroke();
      c.textAlign = "center"; c.font = "12px sans-serif"; c.fillStyle = "#d8d8d8"; c.fillText(label, cx, cy - 16); c.font = "10px monospace"; c.fillStyle = "#6b6b6b"; c.fillText(`${items.length} findings`, cx, cy - 4); c.textAlign = "left";
    });
  }

  // ---------------------------------------------------------------- STRATEGIES
  function strategies() {
    if (!D.bots.find((b) => b.id === D.sel) && D.bots[0]) D.sel = D.bots[0].id;
    $("slist").innerHTML = D.bots.map((b) => { const ds = C.dots(b.toughness || gates().find((g) => g.name === b.name)); return `<div class="srow ${b.id === D.sel ? "on" : ""}" data-s="${h(b.id)}"><div><b>${h(b.name)}</b><small>${h(b.group === "main" ? b.detail || b.status : (b.status || "").split(" · ")[0])}</small><div class="dots">${ds.map((x) => `<i class="${x === true ? "y" : x === false ? "n" : ""}"></i>`).join("")}</div></div><canvas data-sp="${h(b.id)}"></canvas><div class="v ${cls(b.ret)}">${pct(b.ret, 1)}</div></div>`; }).join("") || '<div class="cb empty">No bots reported yet.</div>';
    document.querySelectorAll("[data-s]").forEach((el) => (el.onclick = () => { D.sel = el.dataset.s; D.tab = "overview"; strategies(); }));
    document.querySelectorAll("[data-sp]").forEach((cv) => { const b = D.bots.find((x) => x.id === cv.dataset.sp); if (b && b.equity.length > 1) spark(cv, b.equity.map((p) => p.v), b.ret >= 0 ? UP : DN); });
    const b = D.bots.find((x) => x.id === D.sel); if (!b) { $("sdetail").innerHTML = ""; return; }
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
      <div class="card" style="margin-top:12px"><div class="ch">Equity curve <em>· paper dollars, after costs · grey: S&amp;P 500</em><span class="r ${cls(b.ret)}">${pct(b.ret)}${b.benchRet != null ? ` · S&amp;P ${pct(b.benchRet)}` : ""}</span></div><div class="cb">${b.group === "main" ? '<canvas class="chart" id="sEq"></canvas><canvas class="chart sm" id="sDd" style="margin-top:6px"></canvas>' : '<div class="empty">Strategy Lab books record a daily snapshot; their curve shows in the main site\'s Strategy Lab table after two sessions.</div>'}</div></div>
      <div class="grid g2" style="margin-top:12px"><div class="card"><div class="ch">Monthly robustness <em>· win or loss per month</em></div><div class="cb">${months.length ? `<div class="months">${months.map((m) => `<div class="${m.ret > 0 ? "w" : m.ret < 0 ? "l" : ""}">${h(m.m.slice(2))}<br>${pct(m.ret, 1)}</div>`).join("")}</div>` : '<div class="empty">Waiting for data: twelve boxes, green a winning month, red a losing one.</div>'}</div></div>
        <div class="card"><div class="ch">When does it work <em>· New York time</em></div><div class="cb">${closed.length ? bar(wk.weekday, (x) => x) + bar(wk.hour, (x) => (x > 12 ? x - 12 : x) + (x >= 12 ? "p" : "a")) : '<div class="empty">Waiting for data: results per weekday and hour appear after closed trades.</div>'}</div></div></div>
      ${t ? `<div class="card" style="margin-top:12px"><div class="ch">Toughness test <em>· ${h(t.label || t.status)}</em></div><div class="cb">${(t.checks || []).map((x) => `<div class="row"><span>${x.ok ? '<span class="tag ok">✓</span>' : '<span class="tag bad">✗</span>'}${h(x.label)}</span><span class="mono">${h(x.value)}</span></div>`).join("") || `<div class="muted">${h(t.detail || t.why || "")}</div>`}<div class="note">${h(t.gate || "")}</div></div></div>` : ""}
      <div class="grid g2" style="margin-top:12px"><div class="card"><div class="ch">Holding now</div><div class="cb">${b.positions.length ? `<table><tr><th>STOCK</th><th>VALUE</th><th>P&amp;L</th></tr>${b.positions.map((p) => `<tr><td>${h(p.sym)}</td><td>${money(p.value)}</td><td class="${cls(p.pnl)}">${money(p.pnl)}</td></tr>`).join("")}</table>` : '<div class="empty">No open positions.</div>'}</div></div>
        <div class="card"><div class="ch">Working on next</div><div class="cb">${b.plans.length ? b.plans.slice(0, 10).map((o) => `<div class="row"><span><span class="tag ${o.side === "BUY" ? "ok" : "bad"}">${h(o.side)}</span>${h(o.sym)} ${o.amount ? money(o.amount) : ""}<div class="note" style="margin:2px 0 0">${h(String(o.why || "").slice(0, 160))}</div></span><span class="dim">${h(o.when)}</span></div>`).join("") : '<div class="empty">Nothing queued right now.</div>'}</div></div></div>`;
    $("sdetail").innerHTML = `<div class="card"><div class="cb head"><h2>${h(b.name)}</h2><p>${h(b.group === "main" ? "Main bot · paper account racing the S&P 500" : "Strategy Lab experiment · $30,000 paper book")}${b.detail ? " · " + h(b.detail) : ""}</p></div></div>
      <div class="tabs"><button data-t="overview" class="${D.tab === "overview" ? "on" : ""}">OVERVIEW</button><button data-t="trades" class="${D.tab === "trades" ? "on" : ""}">TRADES · ${b.trades.length}</button></div>${D.tab === "trades" ? trades : over}`;
    document.querySelectorAll("[data-t]").forEach((x) => (x.onclick = () => { D.tab = x.dataset.t; strategies(); }));
    if (D.tab === "overview" && $("sEq")) {
      const b0 = (b.equity.find((p) => p.b != null) || {}).b;
      line($("sEq"), [{ values: b.equity.map((p) => (p.b != null && b0 ? (p.b / b0) * b.start : NaN)), color: "#5a5a5a", width: 1 }, { values: b.equity.map((p) => p.v), color: UP, width: 1.8, fill: "rgba(61,220,132,.22)" }], { fmt: (v) => "$" + (v / 1000).toFixed(1) + "k" });
      line($("sDd"), [{ values: C.drawdowns(b.equity).map((d) => d.dd * 100), color: DN, fill: "rgba(255,90,90,.25)" }], { fmt: (v) => v.toFixed(1) + "%", zero: true });
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
    ];
  }
  const room = { hits: [], drag: null };
  function P(x, y, z, w, hh) { const a = D.rot, X = x * Math.cos(a) - z * Math.sin(a), Z = x * Math.sin(a) + z * Math.cos(a), s = Math.min(w / 17, hh / 12.5); return [w / 2 + (X - Z) * 0.87 * s, hh * 0.44 + (X + Z) * 0.5 * s - y * s, X + Z]; }
  function drawRoom() {
    if (D.view !== "room") return; const k = setup($("room")); if (!k) return; const { c, w, hh } = k, t = performance.now() / 1000, p = (x, y, z) => P(x, y, z, w, hh);
    const bg = c.createRadialGradient(w / 2, hh / 2, 40, w / 2, hh / 2, w * 0.7); bg.addColorStop(0, "#16110a"); bg.addColorStop(1, "#050505"); c.fillStyle = bg; c.fillRect(0, 0, w, hh);
    c.strokeStyle = "rgba(255,153,31,.07)"; for (let i = -6; i <= 6; i++) { let a = p(i, 0, -6), b = p(i, 0, 6); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); a = p(-6, 0, i); b = p(6, 0, i); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
    c.strokeStyle = "rgba(255,153,31,.45)"; c.lineWidth = 2; c.beginPath(); [[-6, -6], [6, -6], [6, 6], [-6, 6], [-6, -6]].forEach(([x, z], i) => { const q = p(x, 0, z); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }); c.stroke(); c.lineWidth = 1;
    const A = agents(); room.hits = [];
    const s0 = A[0]; for (const a of A.slice(1)) { const p1 = p(s0.x, 0.05, s0.z), p2 = p(a.x, 0.05, a.z); c.setLineDash([3, 6]); c.lineDashOffset = -t * 18; c.strokeStyle = "rgba(255,153,31,.35)"; c.beginPath(); c.moveTo(p1[0], p1[1]); c.lineTo(p2[0], p2[1]); c.stroke(); c.setLineDash([]); }
    const quad = (pts, fill, stroke) => { c.beginPath(); pts.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]))); c.closePath(); if (fill) { c.fillStyle = fill; c.fill(); } if (stroke) { c.strokeStyle = stroke; c.stroke(); } };
    A.slice().sort((a, b) => p(a.x, 0, a.z)[2] - p(b.x, 0, b.z)[2]).forEach((a) => {
      const sel = D.agent === a.id, dx = 1.2, dz = 0.6, top = 0.75, on = a.busy || sel;
      quad([p(a.x - dx, 0, a.z + dz), p(a.x + dx, 0, a.z + dz), p(a.x + dx, top, a.z + dz), p(a.x - dx, top, a.z + dz)], "#0e0e0e", "#262626");
      quad([p(a.x + dx, 0, a.z - dz), p(a.x + dx, 0, a.z + dz), p(a.x + dx, top, a.z + dz), p(a.x + dx, top, a.z - dz)], "#0b0b0b", "#222");
      const topPts = [[-dx, -dz], [dx, -dz], [dx, dz], [-dx, dz]].map(([x, z]) => p(a.x + x, top, a.z + z)); quad(topPts, "#161616", on ? OR : "#333");
      for (const m of [-0.75, 0, 0.75]) {
        const mw = 0.32, y0 = top + 0.12, y1 = top + 0.85, z = a.z - dz + 0.05;
        quad([p(a.x + m - mw, y0, z), p(a.x + m + mw, y0, z), p(a.x + m + mw, y1, z), p(a.x + m - mw, y1, z)], on ? "rgba(255,153,31,.14)" : "rgba(255,255,255,.04)", "#3a3a3a");
        c.strokeStyle = on ? OR : "#5a5a5a"; c.beginPath(); for (let i = 0; i <= 12; i++) { const u = i / 12, q = p(a.x + m - mw + u * mw * 2, y0 + 0.15 + 0.45 * (0.5 + 0.4 * Math.sin(i * 1.3 + t * (a.busy ? 2 : 0.4) + m * 4)), z); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); } c.stroke();
      }
      const bob = a.busy ? Math.sin(t * 3 + a.x) * 0.04 : 0, head = p(a.x, 1.25 + bob, a.z + dz + 0.55), body = p(a.x, 0.78 + bob, a.z + dz + 0.55), r = Math.min(w / 17, hh / 12.5) * 0.27;
      c.fillStyle = "#bdbdbd"; c.beginPath(); c.ellipse(body[0], body[1], r * 1.05, r * 1.25, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = "#e8e8e8"; c.beginPath(); c.arc(head[0], head[1], r, 0, Math.PI * 2); c.fill();
      c.strokeStyle = on ? OR : "#7a7a7a"; c.lineWidth = 3; c.beginPath(); c.arc(head[0], head[1], r * 1.1, Math.PI * 1.05, Math.PI * 1.95); c.stroke(); c.lineWidth = 1;
      if (a.busy) { c.strokeStyle = "rgba(255,153,31,.5)"; c.beginPath(); c.arc(head[0], head[1], r * (1.6 + (t % 1)), 0, Math.PI * 2); c.stroke(); }
      const lp = p(a.x, 0, a.z + dz + 1.5); c.textAlign = "center"; c.font = "600 11px monospace"; c.fillStyle = sel ? "#fff" : a.busy ? OR : "#8a8a8a"; c.fillText(a.name, lp[0], lp[1]);
      c.font = "11px sans-serif"; c.fillStyle = "#bdbdbd"; c.fillText(String(a.now).slice(0, 48), lp[0], lp[1] + 15); c.textAlign = "left";
      const xs = [...topPts.map((q) => q[0]), head[0]], ys = [...topPts.map((q) => q[1]), head[1] - r, lp[1] + 18];
      room.hits.push({ id: a.id, x0: Math.min(...xs) - 12, x1: Math.max(...xs) + 12, y0: Math.min(...ys) - 50, y1: Math.max(...ys) });
    });
  }
  const rc = $("room");
  rc.addEventListener("mousedown", (e) => { room.drag = { x: e.clientX, rot: D.rot, moved: false }; });
  window.addEventListener("mousemove", (e) => { if (!room.drag) return; const dx = e.clientX - room.drag.x; if (Math.abs(dx) > 3) room.drag.moved = true; D.rot = room.drag.rot + dx / 240; });
  window.addEventListener("mouseup", (e) => {
    const d = room.drag; room.drag = null; if (!d || d.moved || e.target !== rc) return;
    const r = rc.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, hit = room.hits.slice().reverse().find((k) => x >= k.x0 && x <= k.x1 && y >= k.y0 && y <= k.y1);
    D.agent = hit ? hit.id : null; agentCard();
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
  function frame() { try { drawBrain(); drawMap(); drawRoom(); } catch (e) { console.warn(e); } requestAnimationFrame(frame); }
  window.addEventListener("resize", () => render());
  get("/api/health").then((x) => { if (x.mainUrl && /^https?:\/\//.test(x.mainUrl)) { $("backLink").href = x.mainUrl; $("backLink").hidden = false; } if (x.mode === "local") $("signOut").hidden = true; }).catch(() => {});
  const start = location.hash.slice(1); if (["overview", "lab", "research", "strategies", "rules", "room", "paper", "decisions", "costs", "machines"].includes(start)) show(start); else render();
  loadBots(); loadSpider(); setInterval(loadBots, 30_000); setInterval(loadSpider, 5_000);
  requestAnimationFrame(frame);
})();

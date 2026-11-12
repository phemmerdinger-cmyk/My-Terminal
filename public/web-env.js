/* THE WEB — financial intelligence environment.
   Layers on top of the living network (public/web.js):
   • Market radar: a sweeping radar whose blips are real events — large movers, breaking news, most-active volume,
     upcoming earnings, macro/policy findings — around a sector heat ring, with a volatility gauge. Click a blip.
   • Intel panel: click any company on the web for its price history, news, fundamentals (SEC), research findings,
     your exposure across portfolios and related companies.
   • Spider console: click the spider (or 🕷 Console) for its live task queue, recent work and findings, and send it
     to research a stock, sector, portfolio or economic event — real jobs on the server.
   • Workstation mode: draggable, resizable glass panels — chart with indicators, comparison, portfolio performance,
     economic data, event timeline, sourced research summary, Quant & AI traders.
   • Modes: Network / Workstation / Cinematic, switched without losing context. Performance & motion settings.
   Everything uses free data the site already serves; nothing here trades. */
(function () {
  "use strict";
  if (typeof VIEW !== "undefined" && VIEW) return;
  const X = () => window.TWX, E = { mode: "net", mounted: false, sig: [], radarRaf: 0, intelSym: null, spcPoll: 0, wsLayout: null, cache: {} };
  // no display-settings panel any more: full quality, motion follows the operating system's reduced-motion setting
  const cfg = { perf: "high", motion: "auto" }; try { localStorage.removeItem("tw_env"); } catch {}
  const saveCfg = () => { try { localStorage.setItem("tw_env", JSON.stringify(cfg)); } catch {} };
  const reduced = () => cfg.motion === "reduced" || (cfg.motion === "auto" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const pct = (x, d = 2) => (x == null || !isFinite(x) ? "—" : (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(d) + "%");
  const money = (x) => (x == null || !isFinite(x) ? "—" : x >= 1e12 ? "$" + (x / 1e12).toFixed(2) + "T" : x >= 1e9 ? "$" + (x / 1e9).toFixed(1) + "B" : x >= 1e6 ? "$" + (x / 1e6).toFixed(1) + "M" : "$" + Math.round(x).toLocaleString());
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const cls = (x) => (x == null ? "" : x >= 0 ? "u" : "d");
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 90 ? "just now" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; };
  const cached = (key, ms, fn) => window.MD.cached("we:" + key, ms, fn); // shared data layer (public/data.js)
  const histOf = (sym, days) => window.MD.histDays(sym, days);
  function applyCfg() { const h = document.documentElement; h.classList.toggle("tw-low", cfg.perf === "low"); h.classList.toggle("tw-bal", cfg.perf === "balanced"); h.classList.toggle("tw-rm", reduced());
    const T = X(); if (T) { T.ROT.speed = cfg.perf === "low" ? 0 : 1; if (E.mounted && T.drawWeb) T.drawWeb(); } }

  // ================================================================ mount
  function mount() {
    const T = X(), box = $("twb"); if (!T || !box) return; if (E.mounted && box.querySelector("#twbModes")) return;
    E.mounted = true;
    box.insertAdjacentHTML("beforeend", `<div class="twb-modes" id="twbModes">${["net:◉ Network", "ws:▦ Workstation"].map((x) => { const [k, t] = x.split(":"); return `<button data-m="${k}" class="${E.mode === k ? "on" : ""}">${t}</button>`; }).join("")}<button data-m="spc" title="Spider console">🕷 Console</button></div>
      <div class="twg twb-intel" id="twbIntel" hidden></div>
      <div class="twg twb-spc" id="twbSpc" hidden></div>
      <div class="twg twb-cfg" id="twbCfg" hidden></div>
      <div class="twb-ws" id="twbWs" hidden></div>
      <button class="twb-cine-x" id="twbCineX" hidden>Exit cinematic · Esc</button>`);
    $("twbModes").onclick = (e) => { const m = e.target.closest("[data-m]"); if (!m) return; const k = m.dataset.m; if (k === "spc") return toggleSpc(); if (k === "cfg") return toggleCfg(); setMode(k); };
    box.addEventListener("click", (e) => { const mn = e.target.closest("[data-min]"); if (mn) { const p = $(mn.dataset.min); p.classList.toggle("min"); mn.textContent = p.classList.contains("min") ? "+" : "–"; dispatchEvent(new Event("resize")); } });
    setTimeout(() => dispatchEvent(new Event("resize")), 0); // dock the radar under the summary panel
    $("twbCineX").onclick = () => setMode("net");
    addEventListener("keydown", (e) => { if (e.key === "Escape" && S.tab === "web") { if (E.mode === "cine") setMode("net"); else if (!$("twbIntel").hidden) closeIntel(); } });
    // the spider itself opens its console
    document.addEventListener("click", (e) => { if (e.target.closest(".tw-crawler") && S.tab === "web") toggleSpc(true); });
    applyCfg();
  }
  function setMode(m) {
    E.mode = m; const box = $("twb"); $("twbModes").querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    box.classList.toggle("cine", m === "cine"); $("twbCineX").hidden = m !== "cine"; $("twbWs").hidden = m !== "ws"; box.classList.toggle("wsmode", m === "ws");
    const T = X(); if (T) T.ROT.speed = m === "cine" ? 4 : cfg.perf === "low" ? 0 : 1;
    const sp = T && T.SPD; if (sp && sp.el) for (const e2 of [sp.el, sp.cap, sp.fx]) e2.style.visibility = m === "ws" ? "hidden" : ""; // the spider steps aside while panels are up
    if (m === "ws") wsOpen();
  }

  // ================================================================ settings
  function toggleCfg() { const p = $("twbCfg"); p.hidden = !p.hidden; if (p.hidden) return;
    const opt = (k, v, t) => `<button data-k="${k}" data-v="${v}" class="${cfg[k] === v ? "on" : ""}">${t}</button>`;
    p.innerHTML = `<div class="twg-h"><b>Display settings</b><button class="twg-x" id="cfgX">✕</button></div><div class="twg-b">
      <h5>Performance</h5><div class="twg-seg">${opt("perf", "high", "High")}${opt("perf", "balanced", "Balanced")}${opt("perf", "low", "Low-power")}</div><p class="twg-note">Low-power turns off rotation, information pulses, shimmer and the radar sweep. Balanced halves animation rates.</p>
      <h5>Motion</h5><div class="twg-seg">${opt("motion", "auto", "Follow system")}${opt("motion", "reduced", "Reduced motion")}</div></div>`;
    $("cfgX").onclick = () => (p.hidden = true);
    p.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { cfg[b.dataset.k] = b.dataset.v; saveCfg(); applyCfg(); p.hidden = true; toggleCfg(); })); }

  // ================================================================ market radar
  const SECS = ["Information Technology", "Communication Services", "Consumer Discretionary", "Consumer Staples", "Health Care", "Financials", "Real Estate", "Utilities", "Energy", "Materials", "Industrials", "Macro & news"];
  async function refreshSignals() {
    const T = X(); if (!T) return; await T.loadSnap(); if (!T.W.sec) { try { const j = await fetch("/sp500.json").then((r) => r.json()); T.W.sec = Object.fromEntries((j.rows || []).map((r) => [r[0], r[2]])); T.W.nm = Object.fromEntries((j.rows || []).map((r) => [r[0], r[1]])); } catch {} } const W = T.W, q = (W.snap && W.snap.quotes) || {}, sec = W.sec || {}, nm = W.nm || {}, sig = [], mine = T.myStocks();
    // 1 · large moves
    Object.entries(q).filter(([, v]) => v[2] != null && Math.abs(v[2]) >= 2.5).sort((a, b) => Math.abs(b[1][2]) - Math.abs(a[1][2])).slice(0, 14)
      .forEach(([s, v]) => sig.push({ kind: "move", sym: s, sec: sec[s] || "Macro & news", strength: Math.min(1, Math.abs(v[2]) / 8), label: `${s} ${pct(v[2], 1)}`, sub: nm[s] || "", c: v[2] >= 0 ? "#22e39a" : "#ff4d6d", mine: mine.has(s) }));
    // 2 · breaking news (last 90 minutes)
    for (const i of ((S.news && S.news.items) || []).filter((i) => Date.now() - (i.time || 0) < 90 * 60e3).slice(0, 10)) { const s = (i.tickers || [])[0];
      sig.push({ kind: "news", sym: s || null, sec: (s && sec[s]) || "Macro & news", strength: 0.35 + 0.4 * (1 - (Date.now() - i.time) / (90 * 60e3)), label: i.title.slice(0, 70), sub: `${i.source || "news"} · ${ago(i.time)}`, c: "#38e1ff", url: i.link || i.url }); }
    // 3 · most active volume, 4 · upcoming earnings, 5 · macro/policy findings
    try { const mv = await cached("movers", 120e3, () => api("/api/movers")); (mv.active || []).slice(0, 6).forEach((a) => sig.push({ kind: "volume", sym: a.symbol, sec: sec[a.symbol] || "Macro & news", strength: 0.55, label: `${a.symbol} heavy volume`, sub: a.volume ? `${(a.volume / 1e6).toFixed(1)}M shares · ${pct(a.changePct, 1)}` : "most active", c: "#a78bfa", mine: mine.has(a.symbol) })); } catch {}
    try { const syms = [...mine, ...(S.wl || [])].slice(0, 40); if (syms.length) { const er = await window.MD.earnings(syms);
      for (const e of [...(er.yours || []), ...(er.notable || []).slice(0, 6)].slice(0, 14)) { const d = Date.parse(e.date || e.when || ""); if (!isFinite(d) || d < Date.now() - 864e5 || d > Date.now() + 14 * 864e5) continue;
        sig.push({ kind: "earnings", sym: e.symbol, sec: sec[e.symbol] || "Macro & news", strength: 0.9 - Math.min(0.6, (d - Date.now()) / (14 * 864e5)), label: `${e.symbol} earnings ${new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, sub: (er.yours || []).includes(e) ? "your holding / watchlist" : "notable report", c: "#ffb020", mine: mine.has(e.symbol) }); } } } catch {}
    try { const ds = await window.MD.discoveries(30); (ds.items || []).filter((d) => /macro|policy|fed|econom/i.test(d.cat || "")).slice(0, 5).forEach((d) => sig.push({ kind: "macro", sym: null, sec: "Macro & news", strength: Math.min(1, (d.importance || 50) / 100), label: d.headline.slice(0, 70), sub: `${d.cat} · ${ago(d.u || d.t)}`, c: "#5b8cff", disc: d.id })); } catch {}
    // place: angle inside the sector's wedge, stronger signals nearer the centre
    const hash = (s) => { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 997; return h / 997; };
    sig.forEach((g) => { const i = Math.max(0, SECS.indexOf(g.sec)); g.ang = ((i + 0.12 + 0.76 * hash(g.label)) / SECS.length) * Math.PI * 2 - Math.PI / 2; g.r = 0.16 + 0.78 * (1 - g.strength); });
    E.sig = sig;
    // sector heat ring + volatility gauge
    E.secMove = Object.fromEntries(SECS.slice(0, 11).map((sc) => { const xs = Object.entries(q).filter(([s]) => sec[s] === sc && q[s][2] != null).map(([, v]) => [v[2], v[3] || 1]); const w = xs.reduce((a, [, c]) => a + c, 0); return [sc, w ? xs.reduce((a, [p, c]) => a + p * c, 0) / w : null]; }));
    try { const v = await cached("vix", 60e3, () => api("/api/quotes?symbols=%5EVIX")); const x = v.quotes && v.quotes["^VIX"]; if (x && x.price) { const lvl = x.price < 16 ? ["calm", "#22e39a"] : x.price < 22 ? ["normal", "#38e1ff"] : x.price < 30 ? ["elevated", "#ffb020"] : ["stressed", "#ff4d6d"]; $("rdVix").innerHTML = `VIX <b style="color:${lvl[1]}">${x.price.toFixed(1)}</b> ${lvl[0]}`; } } catch {}
    const top = [...sig].sort((a, b) => b.strength - a.strength).slice(0, 7), ic = { move: "◆", news: "●", volume: "▲", earnings: "◷", macro: "◎" };
    $("rdList").innerHTML = top.length ? top.map((g, i) => `<button data-i="${sig.indexOf(g)}"><i style="color:${g.c}">${ic[g.kind]}</i><span>${esc(g.label)}</span><em>${esc(g.sub)}</em></button>`).join("") : `<p class="twg-note">No unusual signals right now.</p>`;
    $("rdList").onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) openSignal(E.sig[+b.dataset.i]); };
  }
  function openSignal(g) { if (!g) return; if (g.sym) return typeof openQuote === "function" ? openQuote(g.sym) : intel(g.sym); if (g.url) return window.open(g.url, "_blank", "noopener"); }
  // ---- the radar is an Overview card: what's unusual across the market right now (moves, breaking news, volume, earnings, macro)
  function radarMount() {
    const host = $("ovRadar"); if (!host || host.dataset.ready || !X()) return; host.dataset.ready = "1";
    host.innerHTML = `<div class="ov-h"><h2 class="h">Market radar</h2><span id="rdVix" class="rd-vix"></span></div><div class="rd-b"><canvas id="rdCv"></canvas><div class="rd-list" id="rdList"><p class="twg-note">Scanning…</p></div></div>
      <div class="rd-key"><span><i style="color:#22e39a">◆</i>big move</span><span><i style="color:#38e1ff">●</i>breaking news</span><span><i>▲</i>volume</span><span><i>◷</i>earnings</span><span><i>◎</i>macro</span><span><i style="color:#f5c518">○</i>yours</span></div>`;
    radarStart(); refreshSignals(); setInterval(() => { if (S.tab === "data" && !document.hidden) refreshSignals(); }, 60e3);
  }
  const rdWait = setInterval(() => { if (typeof S !== "undefined" && $("ovRadar") && X()) { clearInterval(rdWait); if (typeof VIEW !== "undefined" && VIEW) { $("ovRadar").hidden = true; return; } radarMount(); } }, 300);
  function radarStart() {
    const cv = $("rdCv"); if (!cv || E.radarRaf) return; const ctx = cv.getContext("2d"); let last = 0;
    cv.onclick = (e) => { const r = cv.getBoundingClientRect(), R = r.width / 2, x = e.clientX - r.left - R, y = e.clientY - r.top - R; let best = null, bd = 14;
      for (const g of E.sig) { const gx = Math.cos(g.ang) * g.r * R * 0.86, gy = Math.sin(g.ang) * g.r * R * 0.86, d = Math.hypot(gx - x, gy - y); if (d < bd) { bd = d; best = g; } } if (best) openSignal(best); };
    cv.onmousemove = (e) => { const r = cv.getBoundingClientRect(), R = r.width / 2, x = e.clientX - r.left - R, y = e.clientY - r.top - R; let best = null, bd = 12; for (const g of E.sig) { const d = Math.hypot(Math.cos(g.ang) * g.r * R * 0.86 - x, Math.sin(g.ang) * g.r * R * 0.86 - y); if (d < bd) { bd = d; best = g; } } cv.title = best ? `${best.label} — ${best.sub}` : ""; cv.style.cursor = best ? "pointer" : "default"; };
    const draw = (t) => {
      E.radarRaf = requestAnimationFrame(draw); if (S.tab !== "data" || document.hidden) return; // the radar lives on the Overview dashboard
      const fpsCap = cfg.perf === "low" ? 4 : cfg.perf === "balanced" ? 24 : 60; if (t - last < 1000 / fpsCap) return; last = t;
      const d = Math.min(2, devicePixelRatio || 1), size = cv.clientWidth; if (cv.width !== size * d) { cv.width = cv.height = size * d; } const R = size / 2, ctx2 = ctx; ctx2.setTransform(d, 0, 0, d, 0, 0); ctx2.clearRect(0, 0, size, size);
      const cx = R, cy = R, Rr = R * 0.86, sweep = reduced() || cfg.perf === "low" ? -Math.PI / 2 : ((t / 4200) % 1) * Math.PI * 2 - Math.PI / 2;
      // sector heat ring
      SECS.forEach((sc, i) => { const a0 = (i / SECS.length) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 1) / SECS.length) * Math.PI * 2 - Math.PI / 2, m = E.secMove && E.secMove[sc];
        ctx2.strokeStyle = m == null ? "rgba(91,140,255,.25)" : X().moveCol(m); ctx2.lineWidth = R * 0.07; ctx2.beginPath(); ctx2.arc(cx, cy, R * 0.94, a0 + 0.02, a1 - 0.02); ctx2.stroke();
        ctx2.strokeStyle = "rgba(56,225,255,.08)"; ctx2.lineWidth = 1; ctx2.beginPath(); ctx2.moveTo(cx, cy); ctx2.lineTo(cx + Math.cos(a0) * Rr, cy + Math.sin(a0) * Rr); ctx2.stroke(); });
      for (const f of [0.25, 0.5, 0.75, 1]) { ctx2.strokeStyle = `rgba(56,225,255,${f === 1 ? 0.28 : 0.1})`; ctx2.beginPath(); ctx2.arc(cx, cy, Rr * f, 0, Math.PI * 2); ctx2.stroke(); }
      // sweep
      if (!(reduced() || cfg.perf === "low")) { const g = ctx2.createConicGradient ? ctx2.createConicGradient(sweep - 0.9, cx, cy) : null; if (g) { g.addColorStop(0, "rgba(56,225,255,0)"); g.addColorStop(0.143, "rgba(56,225,255,.22)"); g.addColorStop(0.1431, "rgba(56,225,255,0)"); ctx2.fillStyle = g; ctx2.beginPath(); ctx2.moveTo(cx, cy); ctx2.arc(cx, cy, Rr, sweep - 0.9, sweep); ctx2.closePath(); ctx2.fill(); }
        ctx2.strokeStyle = "rgba(160,240,255,.8)"; ctx2.lineWidth = 1.4; ctx2.beginPath(); ctx2.moveTo(cx, cy); ctx2.lineTo(cx + Math.cos(sweep) * Rr, cy + Math.sin(sweep) * Rr); ctx2.stroke(); }
      // blips: brighten as the sweep passes
      for (const g of E.sig) { const x = cx + Math.cos(g.ang) * g.r * Rr, y = cy + Math.sin(g.ang) * g.r * Rr; let since = ((sweep - g.ang) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2); const glow = reduced() ? 0.7 : Math.max(0.25, 1 - since / (Math.PI * 1.4));
        ctx2.globalAlpha = glow; ctx2.fillStyle = g.c; ctx2.shadowColor = g.c; ctx2.shadowBlur = cfg.perf === "high" ? 10 * glow : 0; ctx2.beginPath(); ctx2.arc(x, y, 2.6 + g.strength * 3.2, 0, Math.PI * 2); ctx2.fill(); ctx2.shadowBlur = 0;
        if (g.mine) { ctx2.strokeStyle = "#f5c518"; ctx2.lineWidth = 1.2; ctx2.beginPath(); ctx2.arc(x, y, 7 + g.strength * 3, 0, Math.PI * 2); ctx2.stroke(); }
        if (since < 0.25 && g.strength > 0.5) { ctx2.strokeStyle = g.c; ctx2.globalAlpha = 1 - since / 0.25; ctx2.beginPath(); ctx2.arc(x, y, 6 + 18 * (since / 0.25), 0, Math.PI * 2); ctx2.stroke(); } }
      ctx2.globalAlpha = 1; ctx2.fillStyle = "rgba(56,225,255,.9)"; ctx2.beginPath(); ctx2.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx2.fill();
    };
    E.radarRaf = requestAnimationFrame(draw);
  }

  // ================================================================ intel panel (a company expands)
  async function intel(sym) {
    const T = X(); if (!T) return; sym = String(sym).toUpperCase(); E.intelSym = sym; const p = $("twbIntel"); p.hidden = false; T.searchWeb(sym);
    const W = T.W, q = (W.snap && W.snap.quotes && W.snap.quotes[sym]) || null, sec = (W.sec && W.sec[sym]) || "", nm = (W.nm && W.nm[sym]) || "";
    // exposure across every portfolio
    const exp = (S.pfs || []).map((pf) => { const h = (pf.holdings || []).filter((x) => String(x.symbol).toUpperCase() === sym); if (!h.length) return null; const sh = h.reduce((a, x) => a + +x.shares, 0), px = q ? q[0] : null;
      const tot = (pf.holdings || []).reduce((a, x) => { const qq = W.snap && W.snap.quotes && W.snap.quotes[String(x.symbol).toUpperCase()]; return a + (+x.shares) * ((qq && qq[0]) || +x.cost || 0); }, 0); return { name: pf.name, sh, val: px ? sh * px : null, w: px && tot ? (sh * px) / tot : null }; }).filter(Boolean);
    const peers = Object.keys(W.place || {}).filter((x) => x !== sym && W.sec && W.sec[x] === sec).sort((a, b) => (((W.snap && W.snap.quotes[b]) || [])[3] || 0) - (((W.snap && W.snap.quotes[a]) || [])[3] || 0)).slice(0, 6);
    p.innerHTML = `<div class="twg-h"><b>${esc(sym)}</b><span class="in-nm">${esc(nm)}</span><button class="twg-x" id="inX">✕</button></div><div class="twg-b in-b">
      <div class="in-top"><div><span class="in-sec" style="--c:${(T.SC && T.SC[sec]) || "#64748b"}">${esc(sec || "—")}</span>${exp.length ? `<span class="in-mine">★ in ${exp.length} portfolio${exp.length > 1 ? "s" : ""}</span>` : ""}</div>
        <div class="in-px">${q ? `<b>$${(+q[0]).toFixed(2)}</b><em class="${cls(q[2])}">${pct(q[2])}</em>` : "<em>no quote</em>"}</div><div class="in-cap">${q && q[3] ? "Market cap " + money(q[3]) : ""}</div></div>
      <div id="inChart" class="in-chart"><span class="spin"></span></div>
      ${exp.length ? `<h5>Your exposure</h5>${exp.map((x) => `<div class="in-row"><span>${esc(x.name)}</span><b>${(+x.sh).toLocaleString()} sh</b><em>${money(x.val)}${x.w != null ? ` · ${(x.w * 100).toFixed(1)}%` : ""}</em></div>`).join("")}` : ""}
      <h5>Fundamentals · SEC</h5><div id="inSec" class="in-grid"><span class="twg-note">Loading…</span></div>
      <h5>News</h5><div id="inNews"><span class="twg-note">Loading…</span></div>
      <h5>THE WEB research</h5><div id="inDisc"><span class="twg-note">Loading…</span></div>
      ${peers.length ? `<h5>Related · ${esc(sec)}</h5><div class="in-peers">${peers.map((x) => { const qq = W.snap && W.snap.quotes[x]; return `<button data-sym="${esc(x)}"><b>${esc(x)}</b><em class="${cls(qq && qq[2])}">${qq ? pct(qq[2], 1) : ""}</em></button>`; }).join("")}</div>` : ""}
      <div class="in-act"><button data-go="quote">Full quote</button><button data-go="research">Research</button><button data-go="dcf">DCF</button><button data-go="spider">🕷 Send spider</button></div></div>`;
    $("inX").onclick = closeIntel;
    p.querySelectorAll(".in-peers [data-sym]").forEach((b) => (b.onclick = () => { T.focusSym(b.dataset.sym); intel(b.dataset.sym); }));
    p.querySelectorAll("[data-go]").forEach((b) => (b.onclick = async () => { const g = b.dataset.go;
      if (g === "quote") openQuote(sym); else if (g === "research") { setTab("research"); setTimeout(() => { try { openQuote(sym); } catch {} }, 80); } else if (g === "dcf") { setTab("dcf"); setTimeout(() => { try { $("dcfSym").value = sym; dcfLoad(); } catch {} }, 80); }
      else if (g === "spider") { try { await api("/api/web/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "company_snapshot", symbol: sym }) }); b.textContent = "✓ Spider sent"; toggleSpc(true); } catch (e) { b.textContent = "Couldn't send"; } } }));
    if (!X().placeXY(sym)) {} else T.focusSym(sym);
    histOf(sym, 190).then((h) => { if (E.intelSym !== sym) return; const c = h.close || [], n = c.length; if (n < 5) { $("inChart").innerHTML = ""; return; }
      const lo = Math.min(...c), hi = Math.max(...c), w = 300, ht = 74, path = c.map((v, i) => `${i ? "L" : "M"}${((i / (n - 1)) * w).toFixed(1)},${(ht - 4 - ((v - lo) / (hi - lo || 1)) * (ht - 8)).toFixed(1)}`).join(""), up = c[n - 1] >= c[0];
      $("inChart").innerHTML = `<svg viewBox="0 0 ${w} ${ht}" preserveAspectRatio="none"><defs><linearGradient id="inG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${up ? "#22e39a" : "#ff4d6d"}" stop-opacity=".35"/><stop offset="1" stop-color="${up ? "#22e39a" : "#ff4d6d"}" stop-opacity="0"/></linearGradient></defs><path d="${path}L${w},${ht}L0,${ht}Z" fill="url(#inG)"/><path d="${path}" fill="none" stroke="${up ? "#22e39a" : "#ff4d6d"}" stroke-width="1.6"/></svg><span>6 months · ${pct((c[n - 1] / c[0] - 1) * 100, 1)}</span>`; }).catch(() => ($("inChart").innerHTML = ""));
    api(`/api/pub/sec?symbol=${encodeURIComponent(sym)}`).then((j) => { if (E.intelSym !== sym) return; if (!j.available) { $("inSec").innerHTML = `<span class="twg-note">${esc(j.reason || "Not available (fund or non-US filer).")}</span>`; return; } const y = j.years[j.years.length - 1], pv = j.years[j.years.length - 2];
      const t = (k, v, sub) => `<div><span>${k}</span><b>${v}</b>${sub ? `<em>${sub}</em>` : ""}</div>`; $("inSec").innerHTML = t("Revenue", money(y.revenue), pv && pv.revenue ? pct((y.revenue / pv.revenue - 1) * 100, 1) + " y/y" : "") + t("Net income", money(y.netIncome)) + t("Free cash flow", money(y.fcf)) + t("Debt", money(y.totalDebt)) + `<em class="in-src">${esc(y._form || "10-K")} · fiscal ${esc(String(y._fy || (y.end || "").slice(0, 4)))} · SEC EDGAR</em>`; }).catch(() => ($("inSec").innerHTML = `<span class="twg-note">SEC data unavailable.</span>`));
    const local = ((S.news && S.news.items) || []).filter((i) => (i.tickers || []).includes(sym)).slice(0, 6);
    (local.length ? Promise.resolve({ items: local }) : api("/api/news?tickers=" + encodeURIComponent(sym))).then((j) => { if (E.intelSym !== sym) return; const it = (j.items || []).filter((i) => !i.tickers || i.tickers.includes(sym)).slice(0, 6);
      $("inNews").innerHTML = it.length ? it.map((i) => `<a class="in-news" href="${esc(i.link || i.url || "#")}" target="_blank" rel="noopener"><i class="${i.mood > 0 ? "u" : i.mood < 0 ? "d" : ""}">●</i>${esc(i.title)}<em>${esc(i.source || "")} · ${i.time ? ago(i.time) : ""}</em></a>`).join("") : `<span class="twg-note">No recent headlines.</span>`; }).catch(() => ($("inNews").innerHTML = `<span class="twg-note">News unavailable.</span>`));
    api(`/api/web/discoveries?symbols=${encodeURIComponent(sym)}&limit=4`).then((j) => { if (E.intelSym !== sym) return; const it = j.items || []; $("inDisc").innerHTML = it.length ? it.map((d) => `<div class="in-disc"><b>${esc(d.headline)}</b><em>${esc(d.cat || "")} · ${ago(d.u || d.t)}${d.sources && d.sources.length ? ` · ${d.sources.length} source${d.sources.length > 1 ? "s" : ""}` : ""}</em></div>`).join("") : `<span class="twg-note">No findings yet — send the spider.</span>`; }).catch(() => ($("inDisc").innerHTML = `<span class="twg-note">Sign in to see research.</span>`));
  }
  function closeIntel() { $("twbIntel").hidden = true; E.intelSym = null; const T = X(); if (T) T.searchWeb(""); }

  // ================================================================ spider console
  const JOBTYPES = [["company_snapshot", "Company snapshot"], ["fundamentals", "Fundamentals"], ["insiders", "Insider trades"], ["earnings_release", "Earnings release"], ["investigate_mover", "Investigate a move"], ["portfolio_scan", "Portfolio scan"], ["macro_check", "Economic data"], ["policy_watch", "Policy & Fed"], ["news_sweep", "News sweep"], ["filings_watch", "SEC filings"], ["explore", "Explore a sector"]];
  function toggleSpc(force) { const p = $("twbSpc"); if (!p) return; p.hidden = force === true ? false : !p.hidden; clearInterval(E.spcPoll); if (p.hidden) return;
    p.innerHTML = `<div class="twg-h"><b>🕷 Spider console</b><span id="spSt"></span><button class="twg-x" id="spX">✕</button></div><div class="twg-b">
      <form class="sp-dir" id="spDir"><input id="spQ" placeholder="Ticker, sector, ‘portfolio’ or ‘Fed’…" autocomplete="off"><select id="spT">${JOBTYPES.map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select><button>Send</button></form><div class="twg-note" id="spMsg"></div>
      <h5>Working on</h5><div id="spRun"></div><h5>Queue</h5><div id="spQueue"></div><h5>Recently finished</h5><div id="spRecent"></div><h5>Latest findings</h5><div id="spFind"></div></div>`;
    $("spX").onclick = () => toggleSpc(); $("spQ").oninput = () => { const v = $("spQ").value.trim().toLowerCase(); if (/^portfolio|holdings/.test(v)) $("spT").value = "portfolio_scan"; else if (/fed|rate|inflation|cpi|jobs|economy|gdp/.test(v)) $("spT").value = /fed|rate/.test(v) ? "policy_watch" : "macro_check"; else if (/^[a-z]{1,5}$/.test(v)) $("spT").value = "company_snapshot"; else if (v.length > 5) $("spT").value = "explore"; };
    $("spDir").onsubmit = async (e) => { e.preventDefault(); const v = $("spQ").value.trim(), type = $("spT").value, symOk = /^[A-Za-z][A-Za-z.\-]{0,6}$/.test(v) && !["explore", "portfolio_scan", "macro_check", "policy_watch", "news_sweep", "filings_watch"].includes(type);
      try { const j = await api("/api/web/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, symbol: symOk ? v.toUpperCase() : undefined }) }); $("spMsg").textContent = j.queued ? `Queued: ${JOBTYPES.find((x) => x[0] === type)[1]}${symOk ? " · " + v.toUpperCase() : ""}. The spider will crawl to it.` : "Queued."; spcLoad(); }
      catch (err) { $("spMsg").textContent = String(err.message || err).replace(/^Error: /, ""); } };
    spcLoad(); E.spcPoll = setInterval(() => { if (!document.hidden && !$("twbSpc").hidden) spcLoad(); }, 5000); }
  async function spcLoad() { let st; try { st = await api("/api/web/status"); } catch { $("spRun").innerHTML = `<span class="twg-note">Sign in to see the spider's work.</span>`; return; }
    $("spSt").innerHTML = `<i class="sp-dot ${st.state}"></i>${esc(st.state)}${st.stats && st.stats.budget ? ` · ${st.stats.budget.used}/${st.stats.budget.max} jobs this hour` : ""}`;
    $("spRun").innerHTML = st.running ? `<div class="sp-job on"><b>${esc(st.running.label)}</b><em>${esc(st.running.area || "")} · ${esc(st.running.phase || "")}${st.running.note ? " · " + esc(st.running.note) : ""}</em><div class="sp-bar"><i></i></div></div>` : `<span class="twg-note">Idle — next job starts on its schedule.</span>`;
    $("spQueue").innerHTML = (st.queue || []).slice(0, 6).map((j) => `<div class="sp-job"><b>${esc(j.label)}</b><em>priority ${Math.round(j.score)} · ${esc(j.why || j.area || "")}</em></div>`).join("") || `<span class="twg-note">Queue empty.</span>`;
    $("spRecent").innerHTML = (st.recent || []).slice(0, 6).map((j) => `<div class="sp-job done"><b>${esc(j.label || j.type)}</b><em>${j.found != null ? j.found + " found · " : ""}${j.status || ""}${j.ended ? " · " + ago(j.ended) : ""}</em></div>`).join("") || `<span class="twg-note">Nothing yet.</span>`;
    try { const d = await cached("spfind", 30e3, () => api("/api/web/discoveries?limit=6")); $("spFind").innerHTML = (d.items || []).map((x) => `<div class="sp-job"><b>${esc(x.headline)}</b><em>${esc(x.cat || "")} · ${ago(x.u || x.t)}</em></div>`).join("") || `<span class="twg-note">No findings yet.</span>`; } catch {} }

  // ================================================================ workstation: draggable, resizable panels
  // THE WEB owns research: each panel shows what the spider found, and links to the page that owns the full tool
  // (portfolio analytics → Portfolio, economic series → Macro, comparisons → Research, models → Quant).
  const PANELS = [["sum", "Research summary"], ["hold", "Holdings intel"], ["time", "Event timeline"], ["chart", "Chart & indicators"], ["mac", "Macro intel"], ["labs", "Quant & AI traders"]];
  function wsDefault() { const box = $("twb").getBoundingClientRect(), W = box.width - 24, H = box.height - 104, cw = W / 3, rh = H / 2, L = {};
    PANELS.forEach(([id], i) => { const c = i % 3, r = Math.floor(i / 3) % 2; L[id] = { x: 12 + c * cw, y: 92 + r * rh, w: cw - 10, h: rh - 10, open: i < 6 }; }); return L; }
  function wsOpen() {
    const ws = $("twbWs"); if (!E.wsLayout) { try { E.wsLayout = JSON.parse(localStorage.getItem("tw_ws3") || "null"); } catch {} if (!E.wsLayout) E.wsLayout = wsDefault(); }
    if (!ws.dataset.ready) { ws.dataset.ready = "1"; ws.innerHTML = `<div class="ws-bar">${PANELS.map(([id, t]) => `<button data-p="${id}" class="${E.wsLayout[id] && E.wsLayout[id].open ? "on" : ""}">${t}</button>`).join("")}<button data-p="reset">Reset layout</button></div>` + PANELS.map(([id, t]) => `<section class="ws-p twg" data-id="${id}"><div class="twg-h ws-h"><b>${t}</b><button class="twg-x" data-close="${id}">✕</button></div><div class="twg-b ws-b" id="ws-${id}"></div></section>`).join("");
      ws.querySelector(".ws-bar").onclick = (e) => { const b = e.target.closest("[data-p]"); if (!b) return; if (b.dataset.p === "reset") { E.wsLayout = wsDefault(); wsSave(); wsPlace(); return; } const L = E.wsLayout[b.dataset.p]; L.open = !L.open; b.classList.toggle("on", L.open); wsSave(); wsPlace(); if (L.open) wsRender(b.dataset.p); };
      ws.addEventListener("click", (e) => { const c = e.target.closest("[data-close]"); if (!c) return; E.wsLayout[c.dataset.close].open = false; ws.querySelector(`.ws-bar [data-p="${c.dataset.close}"]`).classList.remove("on"); wsSave(); wsPlace(); });
      let drag = null; ws.addEventListener("pointerdown", (e) => { const h = e.target.closest(".ws-h"); if (!h || e.target.closest("button")) return; const p = h.parentElement, L = E.wsLayout[p.dataset.id]; drag = { p, L, x: e.clientX, y: e.clientY, ox: L.x, oy: L.y }; p.classList.add("drag"); ws.querySelectorAll(".ws-p").forEach((x) => (x.style.zIndex = x === p ? 3 : 2)); h.setPointerCapture(e.pointerId); });
      ws.addEventListener("pointermove", (e) => { if (!drag) return; drag.L.x = Math.max(0, drag.ox + e.clientX - drag.x); drag.L.y = Math.max(88, drag.oy + e.clientY - drag.y); drag.p.style.left = drag.L.x + "px"; drag.p.style.top = drag.L.y + "px"; });
      ws.addEventListener("pointerup", () => { if (drag) { drag.p.classList.remove("drag"); wsSave(); drag = null; } });
      const ro = new ResizeObserver((ents) => { for (const en of ents) { const id = en.target.dataset.id, L = E.wsLayout[id]; if (!L || !L.open) continue; const r = en.target.getBoundingClientRect(); if (Math.abs(L.w - r.width) > 2 || Math.abs(L.h - r.height) > 2) { L.w = r.width; L.h = r.height; wsSave(); clearTimeout(en.target._t); en.target._t = setTimeout(() => wsRender(id), 220); } } });
      ws.querySelectorAll(".ws-p").forEach((p) => ro.observe(p)); }
    wsPlace(); PANELS.forEach(([id]) => E.wsLayout[id] && E.wsLayout[id].open && wsRender(id));
  }
  const wsSave = () => { try { localStorage.setItem("tw_ws3", JSON.stringify(E.wsLayout)); } catch {} };
  function wsPlace() { $("twbWs").querySelectorAll(".ws-p").forEach((p) => { const L = E.wsLayout[p.dataset.id]; p.hidden = !L || !L.open; if (L) Object.assign(p.style, { left: L.x + "px", top: L.y + "px", width: L.w + "px", height: L.h + "px" }); }); }
  function wsRender(id) { const el = $("ws-" + id); if (!el) return; ({ chart: wsChart, hold: wsHold, mac: wsMac, time: wsTime, sum: wsSum, labs: wsLabs }[id])(el); }
  // ---- a small interactive line chart with crosshair, used by several panels
  function lineChart(el, series, { dates, fmt = (v) => v.toFixed(2), sub, h } = {}) {
    const W2 = Math.max(200, el.clientWidth - 4), H2 = h || Math.max(120, el.clientHeight - 6), L = 46, R = 8, T2 = 8, B2 = 18, all = series.flatMap((s) => s.v.filter((x) => x != null && isFinite(x))); if (!all.length) { el.innerHTML = `<span class="twg-note">No data.</span>`; return; }
    const lo = Math.min(...all), hi = Math.max(...all), n = Math.max(...series.map((s) => s.v.length)), X2 = (i) => L + (i / Math.max(1, n - 1)) * (W2 - L - R), Y2 = (v) => T2 + (1 - (v - lo) / (hi - lo || 1)) * (H2 - T2 - B2);
    const grid = [0, 0.5, 1].map((f) => { const v = lo + f * (hi - lo); return `<line x1="${L}" x2="${W2 - R}" y1="${Y2(v)}" y2="${Y2(v)}" class="lc-g"/><text x="${L - 5}" y="${Y2(v) + 3}" text-anchor="end" class="lc-a">${fmt(v)}</text>`; }).join("");
    const lines = series.map((s) => { let d = "", pen = false; s.v.forEach((v, i) => { if (v == null || !isFinite(v)) { pen = false; return; } d += (pen ? "L" : "M") + X2(i).toFixed(1) + "," + Y2(v).toFixed(1); pen = true; }); return `<path d="${d}" fill="none" stroke="${s.c}" stroke-width="${s.w || 1.5}" ${s.dash ? 'stroke-dasharray="4 3"' : ""} opacity="${s.op || 1}"/>`; }).join("");
    const xt = dates ? [0, 0.5, 1].map((f) => { const i = Math.round(f * (n - 1)); return `<text x="${X2(i)}" y="${H2 - 4}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}" class="lc-a">${day(dates[i] * 1000)}</text>`; }).join("") : "";
    el.innerHTML = `<svg class="lc" viewBox="0 0 ${W2} ${H2}" width="100%" height="${H2}">${grid}${(sub || "")}${lines}${xt}<line class="lc-x" y1="${T2}" y2="${H2 - B2}" x1="-10" x2="-10"/></svg><div class="lc-tip" hidden></div>`;
    const sv = el.querySelector("svg"), tip = el.querySelector(".lc-tip"), xl = el.querySelector(".lc-x");
    sv.onmousemove = (e) => { const r = sv.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * W2, i = Math.max(0, Math.min(n - 1, Math.round(((vx - L) / (W2 - L - R)) * (n - 1)))); xl.setAttribute("x1", X2(i)); xl.setAttribute("x2", X2(i));
      tip.hidden = false; tip.innerHTML = `${dates ? `<b>${day(dates[i] * 1000)}</b>` : ""}${series.filter((s) => s.name && s.v[i] != null).map((s) => `<div><i style="background:${s.c}"></i>${esc(s.name)}<span>${(s.fmt || fmt)(s.v[i])}</span></div>`).join("")}`; tip.style.left = Math.min(r.width - 150, e.clientX - r.left + 12) + "px"; tip.style.top = "6px"; };
    sv.onmouseleave = () => { tip.hidden = true; xl.setAttribute("x1", -10); xl.setAttribute("x2", -10); };
  }
  const sma = (a, n) => a.map((_, i) => (i + 1 < n ? null : a.slice(i + 1 - n, i + 1).reduce((x, y) => x + y, 0) / n));
  const ema = (a, n) => { const k = 2 / (n + 1), o = []; a.forEach((v, i) => o.push(i ? v * k + o[i - 1] * (1 - k) : v)); return o; };
  const rsi = (a, n = 14) => { const o = [null]; let g = 0, l = 0; for (let i = 1; i < a.length; i++) { const d = a[i] - a[i - 1]; if (i <= n) { g += Math.max(0, d); l += Math.max(0, -d); o.push(i === n ? 100 - 100 / (1 + g / (l || 1e-9)) : null); if (i === n) { g /= n; l /= n; } } else { g = (g * (n - 1) + Math.max(0, d)) / n; l = (l * (n - 1) + Math.max(0, -d)) / n; o.push(100 - 100 / (1 + g / (l || 1e-9))); } } return o; };
  function wsChart(el) {
    const st = (E.chart = E.chart || { sym: [...X().myStocks()][0] || "SPY", days: 365, ind: { sma50: true, sma200: true, bb: false, rsi: true, macd: false } });
    el.innerHTML = `<div class="ws-ctl"><input class="ws-in" id="chSym" value="${esc(st.sym)}" maxlength="8"><div class="twg-seg sm">${[[182, "6M"], [365, "1Y"], [1095, "3Y"]].map(([d, t]) => `<button data-d="${d}" class="${st.days === d ? "on" : ""}">${t}</button>`).join("")}</div><div class="twg-seg sm">${[["sma50", "SMA 50"], ["sma200", "SMA 200"], ["bb", "Bollinger"], ["rsi", "RSI"], ["macd", "MACD"]].map(([k, t]) => `<button data-i="${k}" class="${st.ind[k] ? "on" : ""}">${t}</button>`).join("")}</div></div><div class="ws-c" id="chMain"></div><div class="ws-c sub" id="chSub"></div>`;
    $("chSym").onkeydown = (e) => { if (e.key === "Enter") { st.sym = e.target.value.trim().toUpperCase() || "SPY"; wsChart(el); } };
    el.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => { st.days = +b.dataset.d; wsChart(el); })); el.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { st.ind[b.dataset.i] = !st.ind[b.dataset.i]; wsChart(el); }));
    histOf(st.sym, st.days + 300).then((h) => { const all = h.adj && h.adj.length === h.t.length ? h.adj : h.close, cut = Math.max(0, h.t.length - Math.round(st.days * 0.69)), c = all.slice(cut), D = h.t.slice(cut), pre = all;
      const s50 = sma(pre, 50).slice(cut), s200 = sma(pre, 200).slice(cut), sd20 = pre.map((_, i) => (i < 19 ? null : Math.sqrt(pre.slice(i - 19, i + 1).reduce((a, v, _2, arr) => a + (v - arr.reduce((x, y) => x + y, 0) / 20) ** 2, 0) / 20))).slice(cut), m20 = sma(pre, 20).slice(cut);
      const ser = [{ v: c, c: "#e6f6ff", w: 1.7, name: st.sym, fmt: (v) => "$" + v.toFixed(2) }];
      if (st.ind.sma50) ser.push({ v: s50, c: "#38e1ff", w: 1.1, name: "SMA 50", fmt: (v) => "$" + v.toFixed(2) }); if (st.ind.sma200) ser.push({ v: s200, c: "#a78bfa", w: 1.1, name: "SMA 200", fmt: (v) => "$" + v.toFixed(2) });
      if (st.ind.bb) { ser.push({ v: m20.map((m, i) => (m == null ? null : m + 2 * sd20[i])), c: "#5b8cff", dash: true, w: 1, name: "BB upper", fmt: (v) => "$" + v.toFixed(2) }, { v: m20.map((m, i) => (m == null ? null : m - 2 * sd20[i])), c: "#5b8cff", dash: true, w: 1, name: "BB lower", fmt: (v) => "$" + v.toFixed(2) }); }
      const main = $("chMain"), sub = $("chSub"), showSub = st.ind.rsi || st.ind.macd; sub.hidden = !showSub;
      lineChart(main, ser, { dates: D, fmt: (v) => "$" + v.toFixed(0), h: Math.max(110, el.clientHeight - 64 - (showSub ? 86 : 0)) });
      if (st.ind.rsi) { const r = rsi(pre).slice(cut); lineChart(sub, [{ v: r, c: "#ffb020", name: "RSI 14", fmt: (v) => v.toFixed(1) }, { v: r.map(() => 70), c: "#ff4d6d", dash: true, w: 0.8, op: 0.5 }, { v: r.map(() => 30), c: "#22e39a", dash: true, w: 0.8, op: 0.5 }], { dates: D, fmt: (v) => v.toFixed(0), h: 80 }); }
      else if (st.ind.macd) { const e12 = ema(pre, 12), e26 = ema(pre, 26), m = e12.map((v, i) => v - e26[i]), sg = ema(m, 9); lineChart(sub, [{ v: m.slice(cut), c: "#38e1ff", name: "MACD", fmt: (v) => v.toFixed(2) }, { v: sg.slice(cut), c: "#ffb020", name: "Signal", fmt: (v) => v.toFixed(2) }, { v: m.slice(cut).map(() => 0), c: "#64748b", w: 0.6 }], { dates: D, fmt: (v) => v.toFixed(1), h: 80 }); }
    }).catch(() => ($("chMain").innerHTML = `<span class="twg-note">No history for ${esc(st.sym)}.</span>`));
  }
  // findings + headlines about the active portfolio's holdings (the analytics themselves live on the Portfolio page)
  async function wsHold(el) {
    const mine = [...X().myStocks()];
    if (!mine.length) { el.innerHTML = `<span class="twg-note">No holdings yet. Add them on the Portfolio page and the spider will research them.</span>`; return; }
    el.innerHTML = `<span class="spin"></span>`; let d = null; try { d = await window.MD.discoveries(40); } catch {}
    const mset = new Set(mine), find = ((d && d.items) || []).filter((x) => (x.tickers || []).some((t) => mset.has(t)) || x.cat === "portfolio").slice(0, 6);
    const news = ((S.news && S.news.items) || []).filter((i) => (i.tickers || []).some((t) => mset.has(t)) && Date.now() - i.time < 2 * 864e5).slice(0, 6);
    const tag = (ts) => (ts || []).filter((t) => mset.has(t)).slice(0, 3).map((t) => `<a class="ws-tk" data-int="${esc(t)}">${esc(t)}</a>`).join("");
    el.innerHTML = `<div class="ws-feed">${find.map((x) => `<div class="wf"><span class="wf-k">finding</span><b>${esc(x.headline)}</b>${tag(x.tickers)}</div>`).join("")}
      ${news.map((i) => `<div class="wf"><span class="wf-k">${esc((i.source || "news"))} · ${X().since(i.time)}</span><a href="${esc(i.link || "#")}" target="_blank" rel="noopener">${esc(i.title)}</a>${tag(i.tickers)}</div>`).join("") || (find.length ? "" : `<span class="twg-note">Nothing new on your holdings in the last two days.</span>`)}</div>
      <button class="ov-go ws-out" data-go="portfolio">Performance & risk → Portfolio</button>`;
    el.querySelectorAll("[data-int]").forEach((a) => (a.onclick = () => intel(a.dataset.int))); el.querySelector("[data-go]").onclick = () => setTab("portfolio");
  }
  // the spider's macro / policy findings (the economic series themselves live on the Macro page)
  async function wsMac(el) {
    el.innerHTML = `<span class="spin"></span>`; let d = null; try { d = await window.MD.discoveries(40); } catch {}
    const it = ((d && d.items) || []).filter((x) => /macro|policy|fed|econom|rate|inflat/i.test((x.cat || "") + " " + (x.headline || ""))).slice(0, 7);
    el.innerHTML = `<div class="ws-feed">${it.map((x) => `<div class="wf"><span class="wf-k">${esc(x.cat || "macro")}</span><b>${esc(x.headline)}</b>${x.summary ? `<em>${esc(String(x.summary).slice(0, 160))}</em>` : ""}</div>`).join("") || `<span class="twg-note">No macro findings logged yet today.</span>`}</div>
      <button class="ov-go ws-out" data-go="macro">Rates, inflation & jobs data → Macro</button>`;
    el.querySelector("[data-go]").onclick = () => setTab("macro");
  }
  async function wsTime(el) {
    const mine = [...X().myStocks()], syms = [...new Set([...mine, ...(S.wl || [])])].slice(0, 40), ev = [], now = Date.now();
    try { const er = await window.MD.earnings(syms); for (const e of [...(er.yours || [])]) { const d = Date.parse(e.date || ""); if (isFinite(d)) ev.push({ t: d, kind: "earnings", label: `${e.symbol} earnings`, sym: e.symbol, c: "#ffb020" }); } } catch {}
    for (const i of ((S.news && S.news.items) || []).filter((i) => (i.tickers || []).some((t) => mine.includes(t)) && now - i.time < 3 * 864e5).slice(0, 25)) ev.push({ t: i.time, kind: "news", label: i.title, sym: i.tickers[0], c: "#38e1ff", url: i.link || i.url });
    try { const d = await window.MD.discoveries(20); for (const x of d.items || []) ev.push({ t: x.u || x.t, kind: "finding", label: x.headline, c: "#a78bfa" }); } catch {}
    const t0 = now - 3 * 864e5, t1 = now + 30 * 864e5, inR = ev.filter((e) => e.t >= t0 && e.t <= t1).sort((a, b) => a.t - b.t), W2 = Math.max(300, el.clientWidth - 8), X2 = (t) => 10 + ((t - t0) / (t1 - t0)) * (W2 - 20), lanes = { earnings: 30, news: 60, finding: 90 };
    const ticks = Array.from({ length: 12 }, (_, i) => t0 + (i * (t1 - t0)) / 11).map((t) => `<line x1="${X2(t)}" x2="${X2(t)}" y1="14" y2="104" class="lc-g"/><text x="${X2(t)}" y="118" text-anchor="middle" class="lc-a">${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</text>`).join("");
    el.innerHTML = `<svg class="lc tl" viewBox="0 0 ${W2} 124" width="100%" height="124">${ticks}<line x1="${X2(now)}" x2="${X2(now)}" y1="8" y2="108" stroke="#38e1ff" stroke-width="1.5"/><text x="${X2(now) + 4}" y="12" class="lc-a" style="fill:#38e1ff">now</text>
      ${Object.entries(lanes).map(([k, y]) => `<text x="4" y="${y - 8}" class="lc-a">${k}</text>`).join("")}${inR.map((e, i) => `<circle cx="${X2(e.t)}" cy="${lanes[e.kind]}" r="${e.kind === "earnings" ? 5 : 3.5}" fill="${e.c}" class="tl-e" data-i="${ev.indexOf(e)}"><title>${esc(new Date(e.t).toLocaleString())} — ${esc(e.label)}</title></circle>`).join("")}</svg>
      <div class="tl-list">${inR.filter((e) => e.t >= now - 864e5).slice(0, 8).map((e) => `<div><i style="color:${e.c}">●</i><b>${new Date(e.t).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</b><span>${esc(e.label)}</span></div>`).join("") || `<span class="twg-note">No events for your holdings in this window.</span>`}</div>`;
    el.querySelectorAll(".tl-e").forEach((c) => (c.onclick = () => { const e = ev[+c.dataset.i]; if (e.url) window.open(e.url, "_blank", "noopener"); else if (e.sym) intel(e.sym); }));
  }
  async function wsSum(el) {
    el.innerHTML = `<span class="spin"></span>`; let s = null, d = null;
    try { s = await api("/api/web/summary"); } catch {} try { d = await window.MD.discoveries(8); } catch {}
    if (!s || !s.lines) { el.innerHTML = `<span class="twg-note">Sign in to see THE WEB's research summary.</span>`; return; }
    const src = (d && d.items) || [];
    el.innerHTML = `<div class="sum-k">${s.live ? "LIVE" : "FINAL"} · ${esc(s.day || "")}</div><ol class="sum-l">${s.lines.map((l) => `<li><span class="sum-a">${esc(l.area || "")}</span>${esc(l.t)}</li>`).join("")}</ol>
      ${src.length ? `<h5>Sources · findings behind this</h5>${src.map((x, i) => `<div class="sum-s"><b>[${i + 1}]</b> ${esc(x.headline)} <em>${esc(x.cat || "")}${x.sources && x.sources[0] ? ` · ${esc(x.sources[0].name || x.sources[0].title || "")}` : ""} · ${ago(x.u || x.t)}</em></div>`).join("")}` : ""}<p class="twg-note">Built from THE WEB's stored research and live data; every finding keeps its sources.</p>`;
  }
  async function wsLabs(el) {
    el.innerHTML = `<span class="spin"></span>`; let qt = null, ap = null; try { qt = await api("/api/quanttrader"); } catch {} try { ap = await api("/api/autopilot"); } catch {}
    const r = (d) => (d && d.value && d.startValue ? d.value / d.startValue - 1 : null);
    el.innerHTML = `<div class="labs">
      <button class="lab" data-go="quant"><span>∑ Quant Lab</span><b>Risk, factors, Monte Carlo, optimization</b><em>Open →</em></button>
      <button class="lab" data-go="aitrade" data-bot="quant"><span>📐 Quant trader</span><b>${qt ? money(qt.value) : "—"} <i class="${cls(r(qt))}">${r(qt) != null ? pct(r(qt) * 100, 1) : ""}</i></b><em>${qt && qt.latest ? esc(qt.latest.regime) + " · " + Math.round(qt.latest.split * 100) + "% equity" : "systematic, paper"}</em></button>
      <button class="lab" data-go="aitrade" data-bot="swing"><span>🤖 AI swing trader</span><b>${ap && ap.value ? money(ap.value) : "—"} <i class="${cls(r(ap))}">${r(ap) != null ? pct(r(ap) * 100, 1) : ""}</i></b><em>${ap ? (ap.positions || []).length + " paper positions" : "paper money"}</em></button>
      <button class="lab" data-go="backtest"><span>⟲ Backtest lab</span><b>Test a strategy on real history</b><em>Open →</em></button></div>`;
    el.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { if (b.dataset.bot) try { localStorage.setItem("md_bot", b.dataset.bot); } catch {} setTab(b.dataset.go); }));
  }

  // ================================================================ hook into THE WEB's open
  const orig = window.webOpen; window.webOpen = function () { if (orig) orig(); setTimeout(mount, 0); };
  window.TWX && (window.TWX.intel = intel); const waitT = setInterval(() => { if (window.TWX) { window.TWX.intel = intel; clearInterval(waitT); } }, 200);
  if (typeof S !== "undefined" && S.tab === "web") setTimeout(mount, 300);
})();

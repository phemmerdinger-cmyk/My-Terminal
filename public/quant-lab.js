/* Quant › Quant Lab — a fully automatic quant desk for the active portfolio.
   Opening the tab is the only input: the engine loads the portfolio, pulls free daily history (/api/pub/hist,
   Yahoo, adjusted closes), and runs nine analyses in sequence. Every number comes from public/qmath.js or
   public/quant.js on real prices; the "research assistant" is a rule-based analyst over those computed
   outputs (no paid AI model) and labels each statement as Calculated or Interpretation.
   Nothing here trades or rebalances anything. */
(function () {
  "use strict";
  const M = window.QMATH, Q = window.QUANT;
  if (!M || !Q) return;
  const QL = { busy: false, res: null, sig: "", at: 0, st: {}, ms: {}, view: "3d", color: "vol", sector: "", rot: { yaw: 0.6, pitch: -0.35, zoom: 1, auto: true }, hover: -1, sel: null };
  const MODS = [["cc", "Command center"], ["uni", "Portfolio risk universe"], ["bt", "Strategy tournament & replay"], ["mc", "Monte Carlo"], ["fx", "Factor exposure"], ["cor", "Correlation lab"], ["opt", "Portfolio optimization"], ["reg", "Market regime"], ["ai", "Quant research assistant"]];
  const FACTORS = [["MKT", "Market", "SPY minus cash"], ["SIZE", "Size (small caps)", "IWM − SPY"], ["VALUE", "Value", "IWD − IWF (value minus growth)"], ["MOM", "Momentum", "MTUM − SPY"], ["QUAL", "Quality", "QUAL − SPY"], ["LOWVOL", "Low volatility", "USMV − SPY"]];
  const PROXIES = ["SPY", "IWM", "IWD", "IWF", "MTUM", "QUAL", "USMV", "HYG", "IEF"];
  const SAMPLE = [["SPY", 0.4], ["QQQ", 0.2], ["AGG", 0.2], ["GLD", 0.1], ["IWM", 0.1]];
  const ERP = 0.05; // equity risk premium used for CAPM expected returns (stated on the page)

  // ---------------------------------------------------------------- formatting
  const pct = (x, d = 1) => (x == null || !isFinite(x) ? "—" : (x * 100).toFixed(d) + "%");
  const sgn = (x, d = 1) => (x == null || !isFinite(x) ? "—" : (x >= 0 ? "+" : "−") + Math.abs(x * 100).toFixed(d) + "%");
  const num = (x, d = 2) => (x == null || !isFinite(x) ? "—" : (+x).toFixed(d));
  const usd = (x, d = 0) => (x == null || !isFinite(x) ? "—" : (x < 0 ? "−$" : "$") + Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const big = (x) => (x == null || !isFinite(x) ? "—" : Math.abs(x) >= 1e9 ? usd(x / 1e9, 1) + "B" : Math.abs(x) >= 1e6 ? usd(x / 1e6, 1) + "M" : usd(x));
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const cls = (x) => (x == null || !isFinite(x) ? "" : x >= 0 ? "up" : "down");
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ---------------------------------------------------------------- status chips (tied to real conditions)
  const ST = { ONLINE: ["ONLINE", "ok"], CALCULATING: ["CALCULATING", "calc"], STALE: ["STALE", "stale"], UNAVAILABLE: ["UNAVAILABLE", "na"], ERROR: ["ERROR", "err"] };
  function setSt(m, s, why) { QL.st[m] = { s, why: why || "" }; const e = document.querySelector(`[data-qst="${m}"]`); if (e) { e.className = "ql-chip " + ST[s][1]; e.textContent = ST[s][0]; e.title = why || ""; } overall(); }
  function overall() { const e = $("qlOverall"); if (!e) return; const v = Object.values(QL.st).map((x) => x.s); const s = v.includes("CALCULATING") ? "CALCULATING" : v.includes("ERROR") ? "ERROR" : v.includes("STALE") ? "STALE" : v.length && v.every((x) => x === "UNAVAILABLE") ? "UNAVAILABLE" : "ONLINE"; e.className = "ql-chip " + ST[s][1]; e.textContent = ST[s][0]; }
  const chip = (m) => `<span class="ql-chip calc" data-qst="${m}">CALCULATING</span>`;

  // ---------------------------------------------------------------- shared, de-duplicated history cache (also used by other pages)
  const HC = (window.QHIST = window.QHIST || new Map());
  function hist(sym, from, to) { const k = `${sym}|${from}|${to}`; if (!HC.has(k)) { const p = api(`/api/pub/hist?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&interval=1d`); HC.set(k, p); p.catch(() => HC.delete(k)); } return HC.get(k); }
  async function loadAll(syms, from, to, onEach) { const out = {}, failed = [], todo = [...syms]; let n = 0;
    const one = async () => { while (todo.length) { const s = todo.shift(); try { const j = await hist(s, from, to); if (j && j.t && j.t.length > 30) out[s] = j; else failed.push(s); } catch { failed.push(s); } onEach && onEach(++n, syms.length); } };
    await Promise.all([one(), one(), one(), one()]); return { out, failed }; }

  // ---------------------------------------------------------------- shell
  function shell() {
    const el = $("tab-quant"); if (el.dataset.ready) return; el.dataset.ready = "1";
    el.innerHTML = `<div class="fx-head"><div><div class="fx-kick">∑ QUANT · AUTOMATED</div><h1>Quant Lab</h1>
      <p class="fx-sub">Open this page and the engine does the rest: it loads your active portfolio, pulls free daily price history, and runs risk, factor, correlation, optimization, Monte Carlo, regime and strategy analyses on its own. Every number is calculated from real adjusted prices; the written analysis is a rule-based engine over those numbers (no paid AI) and marks each statement as <b>Calculated</b> or <b>Interpretation</b>. Nothing here places or suggests real trades.</p></div>
      <div class="ql-hstat"><span id="qlOverall" class="ql-chip calc">CALCULATING</span><span id="qlFresh" class="tw-muted"></span><button class="btn ghost" type="button" id="qlRe" title="Recalculate with the latest prices">↻ Recalculate</button></div></div>
      <div id="qlProg" class="ql-prog"></div>
      ${MODS.map(([k, n], i) => `<section class="fx-card ql-mod" id="qm-${k}"><div class="ql-mh"><h2><span class="ql-n">${i + 1}</span>${n}</h2>${chip(k)}</div><div class="ql-body" id="qb-${k}"><div class="fx-empty"><span class="spin"></span> Waiting for data…</div></div></section>`).join("")}
      <div class="ql-foot" id="qlFoot"></div>`;
    $("qlRe").onclick = () => run(true);
  }

  // ---------------------------------------------------------------- the pipeline
  function portfolio() {
    const pf = (S.pfs || []).find((p) => p.id === S.pfActive), h = ((pf && pf.holdings) || []).filter((x) => x && x.symbol && +x.shares > 0 && !/^\^|=/.test(x.symbol));
    if (h.length) { const m = {}; for (const x of h) m[x.symbol.toUpperCase()] = (m[x.symbol.toUpperCase()] || 0) + +x.shares; return { name: pf.name, sample: false, shares: m }; }
    return { name: "Sample portfolio (your active portfolio is empty)", sample: true, w: Object.fromEntries(SAMPLE) };
  }
  async function run(force) {
    if (QL.busy) return; const P = portfolio(), sig = JSON.stringify(P) + new Date().toISOString().slice(0, 13);
    if (!force && QL.res && QL.sig === sig && Date.now() - QL.at < 15 * 60e3) return;
    QL.busy = true; QL.sig = sig; QL.ms = {}; const T0 = performance.now();
    for (const [k] of MODS) setSt(k, "CALCULATING", "Running");
    try {
      const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 4.2 * 365.25 * 864e5).toISOString().slice(0, 10);
      const held = P.sample ? Object.keys(P.w) : Object.keys(P.shares).slice(0, 30);
      const syms = [...new Set([...held, ...PROXIES, "^IRX"])];
      const t0 = performance.now();
      const { out, failed } = await loadAll(syms, from, to, (n, of) => { $("qlProg").innerHTML = `<div class="ql-bar"><i style="width:${((n / of) * 100).toFixed(0)}%"></i></div><span>Loading daily price history… ${n}/${of}</span>`; });
      QL.ms.load = performance.now() - t0; $("qlProg").innerHTML = "";
      const have = held.filter((s) => out[s]); if (!have.length) throw new Error("No price history could be loaded for any holding" + (failed.length ? ` (${failed.join(", ")})` : "") + ".");
      if (!out.SPY) throw new Error("Couldn't load SPY, which every module uses as the market benchmark.");
      const irx = out["^IRX"], rf = irx && irx.close.length ? Math.min(0.1, Math.max(0, irx.close[irx.close.length - 1] / 100)) : 0.04, rfSrc = irx ? "13-week T-bill yield (^IRX)" : "assumed 4.0% (T-bill yield unavailable)";
      const lastT = Math.max(...have.map((s) => out[s].t[out[s].t.length - 1])), ageD = (Date.now() / 1000 - lastT) / 86400, stale = ageD > 4;
      const base = compute(P, have, out, rf, failed.filter((s) => held.includes(s)));
      Object.assign(base, { rf, rfSrc, lastT, stale, ageD, failedHeld: failed.filter((s) => held.includes(s)), failedProxy: failed.filter((s) => PROXIES.includes(s)) });
      QL.res = base; QL.at = Date.now();
      $("qlFresh").textContent = `Prices through ${day(lastT)}${stale ? ` · ${Math.floor(ageD)} days old` : ""} · risk-free ${pct(rf, 2)} (${rfSrc})`;
      const mark = (k) => setSt(k, stale ? "STALE" : "ONLINE", stale ? `Latest price is ${Math.floor(ageD)} days old` : "Calculated from the latest daily closes");
      const steps = [["cc", renderCC], ["uni", renderUni], ["cor", renderCor], ["fx", renderFx], ["opt", renderOpt], ["reg", renderReg], ["bt", renderBt], ["mc", renderMC]];
      for (const [k, fn] of steps) { const t = performance.now(); try { const r = await fn(base); if (r === "na") continue; mark(k); } catch (e) { setSt(k, "ERROR", e.message); $("qb-" + k).innerHTML = `<div class="fx-empty">⚠ ${esc(e.message)}</div>`; } QL.ms[k] = performance.now() - t; await tick(); }
      const t = performance.now(); await renderAI(base); mark("ai"); QL.ms.ai = performance.now() - t;
      QL.ms.total = performance.now() - T0; foot();
    } catch (e) {
      for (const [k] of MODS) if (!QL.st[k] || QL.st[k].s === "CALCULATING") { setSt(k, "ERROR", e.message); $("qb-" + k).innerHTML = `<div class="fx-empty">⚠ ${esc(e.message)}</div>`; }
      $("qlProg").innerHTML = "";
    } finally { QL.busy = false; }
  }

  // core statistics shared by every module
  function compute(P, have, out, rf, missing) {
    const A = M.align({ ...Object.fromEntries(have.map((s) => [s, out[s]])), SPY: out.SPY }); // holdings + benchmark on one calendar
    const N = Math.min(A.dates.length - 1, 756); // three years of daily returns
    const R = have.map((s) => M.returns(A.px[s]).slice(-N)), dates = A.dates.slice(-N), eqDates = A.dates.slice(-(N + 1)), spR = M.returns(A.px.SPY).slice(-N);
    const last = Object.fromEntries(have.map((s) => [s, out[s].close[out[s].close.length - 1]]));
    let w, value, shares = null;
    if (P.sample) { w = M.normalize(have.map((s) => P.w[s] || 0)); value = 10000; }
    else { shares = P.shares; const v = have.map((s) => shares[s] * last[s]); value = v.reduce((a, b) => a + b, 0); w = v.map((x) => x / value); }
    const pr = M.portReturns(R, w), eq = [1]; for (const r of pr) eq.push(eq[eq.length - 1] * (1 + r));
    const C = M.covMatrix(R), Cor = M.corrMatrix(R), Cann = C.map((r) => r.map((x) => x * M.DAYS));
    const beta = M.beta(pr, spR);
    const rc = M.riskContrib(w, C);
    const assets = have.map((s, i) => { const r = R[i], ys = r.slice(-252), b = M.beta(r, spR); return { sym: s, w: w[i], vol: M.annVol(r), ret1y: ys.reduce((a, x) => a * (1 + x), 1) - 1, sharpe: M.sharpe(r, rf), rc: rc[i], beta: b, mu: rf + (isFinite(b) ? b : 1) * ERP, last: last[s], value: shares ? shares[s] * last[s] : value * w[i] }; });
    const y1 = pr.slice(-252), stats = { value, ret1y: y1.reduce((a, x) => a * (1 + x), 1) - 1, ret3y: eq[eq.length - 1] - 1, cagr: M.cagr(eq, N / M.DAYS), vol: M.annVol(pr), sharpe: M.sharpe(pr, rf), sortino: M.sortino(pr, rf), mdd: M.maxDrawdown(eq).mdd, beta, var95: M.varHist(pr, 0.95), es95: M.esHist(pr, 0.95), varN: M.varNormal(pr, 0.95), years: N / M.DAYS };
    return { P, have, out, A, R, dates, eqDates, spR, w, pr, eq, C, Cor, Cann, assets, stats, value, missing };
  }

  // ---------------------------------------------------------------- small SVG chart helpers
  function lineSVG(series, { w = 760, h = 220, fmtY = (v) => pct(v, 0), dates, markers = [], zero = false, band, log = false } = {}) {
    const all = series.flatMap((s) => s.v.filter((x) => x != null && isFinite(x))).concat(band ? band.flatMap((b) => [...b.lo, ...b.hi]) : []); if (!all.length) return "";
    const tf = log ? (v) => Math.log(Math.max(1e-9, v)) : (v) => v;
    let lo = Math.min(...all.map(tf)), hi = Math.max(...all.map(tf)); if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); } if (hi === lo) hi = lo + 1;
    const L = 52, Rr = 10, T = 10, B = 24, n = Math.max(...series.map((s) => s.v.length)), X = (i) => L + (i / Math.max(1, n - 1)) * (w - L - Rr), Y = (v) => T + (1 - (tf(v) - lo) / (hi - lo)) * (h - T - B);
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => { const tv = lo + f * (hi - lo), v = log ? Math.exp(tv) : tv; return `<line x1="${L}" x2="${w - Rr}" y1="${Y(v)}" y2="${Y(v)}" class="ql-grid"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="ql-ax">${fmtY(v)}</text>`; }).join("");
    const xt = dates ? [0, 0.5, 1].map((f) => { const i = Math.round(f * (n - 1)); return `<text x="${X(i)}" y="${h - 6}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}" class="ql-ax">${day(dates[i]).slice(0, 7)}</text>`; }).join("") : "";
    const bands = (band || []).map((b) => `<path class="ql-band" style="fill:${b.c}" d="M${b.lo.map((v, i) => `${X(i)},${Y(v)}`).join("L")}L${b.hi.map((v, i) => `${X(b.hi.length - 1 - i)},${Y(b.hi[b.hi.length - 1 - i])}`).join("L")}Z"/>`).join("");
    const lines = series.map((s) => { let d = "", pen = false; s.v.forEach((v, i) => { if (v == null || !isFinite(v)) { pen = false; return; } d += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); pen = true; }); return `<path d="${d}" class="ql-line" style="stroke:${s.c};stroke-width:${s.sw || 1.6};${s.dash ? "stroke-dasharray:4 3" : ""};opacity:${s.op || 1}"/>`; }).join("");
    const mk = markers.map((m) => `<circle cx="${X(m.i)}" cy="${Y(m.v)}" r="3.2" class="ql-mk ${m.side === "BUY" ? "buy" : "sell"}"><title>${esc(m.title || "")}</title></circle>`).join("");
    const z = zero && lo < 0 && hi > 0 ? `<line x1="${L}" x2="${w - Rr}" y1="${Y(0)}" y2="${Y(0)}" class="ql-zero"/>` : "";
    return `<svg viewBox="0 0 ${w} ${h}" class="ql-svg" preserveAspectRatio="none">${ticks}${z}${bands}${lines}${mk}${xt}</svg>`;
  }
  const legend = (items) => `<div class="ql-leg">${items.map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join("")}</div>`;
  const kpi = (k, v, sub, c) => `<div class="ql-kpi"><span>${k}</span><b class="${c || ""}">${v}</b>${sub ? `<em>${sub}</em>` : ""}</div>`;
  const note = (t) => `<p class="ql-note">${t}</p>`;

  // ---------------------------------------------------------------- 1. command center
  async function renderCC(b) {
    const s = b.stats, top = [...b.assets].sort((a, c) => c.rc - a.rc)[0];
    let ap = null; try { ap = await api("/api/autopilot"); } catch {}
    const apEq = ap && ap.equity && ap.equity.length ? ap.equity[ap.equity.length - 1] : null, apV = apEq == null ? null : typeof apEq === "number" ? apEq : (apEq.v ?? apEq.value ?? apEq[1] ?? null);
    b.ap = ap;
    $("qb-cc").innerHTML = `<div class="ql-src">${esc(b.P.name)} · ${b.have.length} holdings analysed${b.missing.length ? ` · <span class="down">no history for ${esc(b.missing.join(", "))}</span>` : ""} · ${num(s.years, 1)} years of daily returns at today's weights</div>
      <div class="ql-kpis">${kpi("Portfolio value", usd(s.value), b.P.sample ? "sample $10,000" : "shares × last close")}${kpi("1-year return", sgn(s.ret1y), "today's weights, held", cls(s.ret1y))}${kpi("Volatility", pct(s.vol), "annualized")}${kpi("Sharpe", num(s.sharpe), `rf ${pct(b.rf, 2)}`)}${kpi("Sortino", num(s.sortino))}${kpi("Max drawdown", pct(-s.mdd), "3-year window", "down")}
      ${kpi("Beta vs S&P 500", num(s.beta), "SPY")}${kpi("1-day VaR 95%", usd(s.var95 * s.value), pct(s.var95, 2) + " historical")}${kpi("1-day ES 95%", usd(s.es95 * s.value), pct(s.es95, 2) + " avg tail loss")}${kpi("Market regime", '<span id="qlRegK">…</span>')}${kpi("Simulation", '<span id="qlMcK">queued</span>')}${kpi("Data freshness", day(b.lastT), b.stale ? `${Math.floor(b.ageD)} days old` : "latest daily close", b.stale ? "down" : "")}</div>
      <div class="ql-two"><div>${lineSVG([{ v: b.eq.map((x) => x - 1), c: "#5eead4" }], { dates: b.eqDates, zero: true, h: 180 })}${legend([["#5eead4", "Growth of today's portfolio over the window (hypothetical: assumes today's weights all along)"]])}</div>
      <div class="ql-side"><h4>Largest risk source</h4><p><b>${esc(top.sym)}</b> carries <b>${pct(top.rc)}</b> of portfolio risk with ${pct(top.w)} of the money.</p>
      <h4>AI Trader (paper)</h4><p>${ap ? `${apV != null ? `Paper equity ${usd(apV)} · ` : ""}${(ap.positions || []).length} open paper positions${ap.lastScan && ap.lastScan.riskOff ? " · currently <b>risk-off</b>" : ""}. Simulated only.` : "Not reachable right now."}</p></div></div>`;
  }

  // ---------------------------------------------------------------- 2. 3D portfolio risk universe
  const COLOR = { vol: ["Volatility", (a) => a.vol, pct], ret1y: ["1-year return", (a) => a.ret1y, sgn], rc: ["Risk contribution", (a) => a.rc, pct], sharpe: ["Sharpe", (a) => a.sharpe, num], beta: ["Beta", (a) => a.beta, num] };
  function ramp(t) { t = Math.max(0, Math.min(1, t)); const stops = [[77, 163, 255], [94, 234, 212], [250, 204, 21], [246, 70, 93]], k = Math.min(2, Math.floor(t * 3)), f = t * 3 - k, a = stops[k], c = stops[k + 1]; return `rgb(${a.map((x, i) => Math.round(x + (c[i] - x) * f)).join(",")})`; }
  async function renderUni(b) {
    const n = b.have.length, P = M.mds(b.Cor, 3), m = Math.max(1e-9, ...P.flat().map(Math.abs)); b.pos = P.map((p) => p.map((x) => x / m));
    for (const a of b.assets) a.sector = await (typeof sectorOf === "function" ? Promise.resolve(sectorOf(a.sym)).catch(() => "Other") : "Other");
    const secs = [...new Set(b.assets.map((a) => a.sector || "Other"))].sort();
    $("qb-uni").innerHTML = `<div class="ql-ctl"><div class="ql-seg" id="qlView"><button data-v="3d" class="on">3D correlation map</button><button data-v="rr">Risk vs return</button></div>
      <label>Color by <select class="field" id="qlColor">${Object.entries(COLOR).map(([k, [nm]]) => `<option value="${k}">${nm}</option>`).join("")}</select></label>
      <label>Sector <select class="field" id="qlSector"><option value="">All sectors</option>${secs.map((s) => `<option>${esc(s)}</option>`).join("")}</select></label><span class="tw-muted ql-hint">Drag to rotate · scroll to zoom · click a holding</span></div>
      <div class="ql-uni"><div class="ql-cv"><canvas id="qlCv"></canvas><div class="ql-tip" id="qlTip" hidden></div><div class="ql-scale" id="qlScale"></div></div><div class="ql-det" id="qlDet"><p class="tw-muted">Click a holding to see its risk numbers, THE WEB's research on it and SEC fundamentals.</p></div></div>
      ${note(`Layout: classical multidimensional scaling of the correlation matrix (distance = √(2(1 − ρ))), so holdings that move together sit together. Node size = portfolio weight. Lines connect pairs with |ρ| ≥ 0.6 (cyan = move together, orange = move opposite). ${n < 3 ? "With fewer than three holdings the map is flat." : ""}`)}`;
    $("qlView").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; QL.view = v; $("qlView").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v)); };
    $("qlColor").onchange = (e) => (QL.color = e.target.value); $("qlSector").onchange = (e) => (QL.sector = e.target.value);
    universe(b);
  }
  function universe(b) {
    const cv = $("qlCv"), ctx = cv.getContext("2d"); let drag = null, proj = [];
    const size = () => { const r = cv.parentElement.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1); cv.width = r.width * d; cv.height = r.height * d; cv.style.width = r.width + "px"; cv.style.height = r.height + "px"; QL.cvD = d; };
    size(); if (QL.onResize) removeEventListener("resize", QL.onResize); QL.onResize = size; addEventListener("resize", size);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; if (reduce) QL.rot.auto = false;
    cv.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY, moved: false, ...QL.rot }; cv.setPointerCapture(e.pointerId); QL.rot.auto = false; };
    cv.onpointermove = (e) => { const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; QL.rot.yaw = drag.yaw + dx * 0.008; QL.rot.pitch = Math.max(-1.4, Math.min(1.4, drag.pitch + dy * 0.008)); }
      let best = -1, bd = 1e9; proj.forEach((p, i) => { const d = Math.hypot(p.x - mx, p.y - my); if (d < p.r + 4 && d < bd) { bd = d; best = i; } }); QL.hover = best;
      const tip = $("qlTip"); if (best >= 0) { const a = b.assets[best]; tip.hidden = false; tip.style.left = mx + 14 + "px"; tip.style.top = my + 10 + "px"; tip.innerHTML = `<b>${esc(a.sym)}</b> · ${pct(a.w)} weight<br>Vol ${pct(a.vol)} · 1y ${sgn(a.ret1y)} · risk ${pct(a.rc)}`; } else tip.hidden = true; };
    cv.onpointerup = (e) => { if (drag && !drag.moved && QL.hover >= 0) detail(b, QL.hover); drag = null; };
    cv.onpointerleave = () => { QL.hover = -1; $("qlTip").hidden = true; };
    cv.onwheel = (e) => { e.preventDefault(); QL.rot.zoom = Math.max(0.5, Math.min(2.5, QL.rot.zoom * (e.deltaY > 0 ? 0.92 : 1.08))); };
    const draw = () => {
      if (!document.body.contains(cv)) return; QL.raf = requestAnimationFrame(draw);
      if (S.tab !== "quant" || document.hidden) return;
      const d = QL.cvD, W = cv.width / d, H = cv.height / d; ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, W, H);
      if (QL.rot.auto) QL.rot.yaw += 0.0025;
      const [cn, fmt] = [COLOR[QL.color][1], COLOR[QL.color][2]], vals = b.assets.map(cn).filter(isFinite), lo = Math.min(...vals), hi = Math.max(...vals);
      const cy = Math.cos(QL.rot.yaw), sy = Math.sin(QL.rot.yaw), cp = Math.cos(QL.rot.pitch), sp = Math.sin(QL.rot.pitch), S0 = Math.min(W, H) * 0.36 * QL.rot.zoom;
      if (QL.view === "3d") proj = b.pos.map((p) => { const x = p[0] * cy - (p[2] || 0) * sy, z0 = p[0] * sy + (p[2] || 0) * cy, y = p[1] * cp - z0 * sp, z = p[1] * sp + z0 * cp, f = 3 / (3 + z); return { x: W / 2 + x * S0 * f, y: H / 2 + y * S0 * f, z, f }; });
      else { const vs = b.assets.map((a) => a.vol), rs = b.assets.map((a) => a.ret1y), v0 = Math.min(...vs), v1 = Math.max(...vs) || 1, r0 = Math.min(0, ...rs), r1 = Math.max(...rs, 0.01), L = 56, Bm = 34;
        ctx.strokeStyle = "rgba(148,163,184,.25)"; ctx.fillStyle = "rgba(148,163,184,.8)"; ctx.font = "11px ui-monospace,monospace"; ctx.beginPath(); ctx.moveTo(L, 10); ctx.lineTo(L, H - Bm); ctx.lineTo(W - 10, H - Bm); ctx.stroke();
        ctx.fillText("Volatility →", W - 90, H - 12); ctx.save(); ctx.translate(14, 90); ctx.rotate(-Math.PI / 2); ctx.fillText("1-year return →", 0, 0); ctx.restore();
        const X = (v) => L + 20 + ((v - v0) / (v1 - v0 || 1)) * (W - L - 50), Y = (r) => H - Bm - 16 - ((r - r0) / (r1 - r0 || 1)) * (H - Bm - 40);
        if (r0 < 0) { ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(W - 10, Y(0)); ctx.stroke(); ctx.setLineDash([]); }
        proj = b.assets.map((a) => ({ x: X(a.vol), y: Y(a.ret1y), z: 0, f: 1 })); }
      proj.forEach((p, i) => (p.r = (5 + Math.sqrt(b.assets[i].w) * 34) * p.f));
      const vis = (i) => !QL.sector || b.assets[i].sector === QL.sector;
      if (QL.view === "3d") for (let i = 0; i < proj.length; i++) for (let j = i + 1; j < proj.length; j++) { const r = b.Cor[i][j]; if (Math.abs(r) < 0.6) continue; const dim = !vis(i) || !vis(j);
        ctx.strokeStyle = r > 0 ? `rgba(94,234,212,${dim ? 0.06 : (Math.abs(r) - 0.5) * 0.9})` : `rgba(251,146,60,${dim ? 0.06 : (Math.abs(r) - 0.5) * 0.9})`; ctx.lineWidth = 1 + (Math.abs(r) - 0.6) * 4; ctx.beginPath(); ctx.moveTo(proj[i].x, proj[i].y); ctx.lineTo(proj[j].x, proj[j].y); ctx.stroke(); }
      [...proj.keys()].sort((a, c) => proj[c].z - proj[a].z).forEach((i) => { const p = proj[i], a = b.assets[i], v = cn(a), col = isFinite(v) ? ramp((v - lo) / (hi - lo || 1)) : "#64748b", dim = !vis(i);
        ctx.globalAlpha = dim ? 0.15 : 1; const g = ctx.createRadialGradient(p.x - p.r * 0.3, p.y - p.r * 0.3, 1, p.x, p.y, p.r); g.addColorStop(0, "#fff"); g.addColorStop(0.25, col); g.addColorStop(1, "rgba(10,14,20,.9)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); if (i === QL.hover || (QL.sel === i)) { ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 2; ctx.stroke(); }
        ctx.fillStyle = "#e2e8f0"; ctx.font = `${Math.round(10 + p.f * 2)}px ui-monospace,monospace`; ctx.textAlign = "center"; ctx.fillText(a.sym, p.x, p.y - p.r - 5); ctx.globalAlpha = 1; });
      const sk = QL.color + lo + hi; if (QL.scaleKey !== sk) { QL.scaleKey = sk; $("qlScale").innerHTML = `<span>${COLOR[QL.color][0]}</span><i></i><em>${fmt(lo)}</em><em>${fmt(hi)}</em>`; }
    };
    cancelAnimationFrame(QL.raf); draw();
  }
  async function detail(b, i) {
    QL.sel = i; const a = b.assets[i], el = $("qlDet");
    el.innerHTML = `<h3>${esc(a.sym)} <small class="tw-muted">${esc(a.sector || "")}</small></h3><div class="ql-mini">${kpi("Weight", pct(a.w))}${kpi("Value", usd(a.value))}${kpi("Risk share", pct(a.rc))}${kpi("Volatility", pct(a.vol))}${kpi("1-year", sgn(a.ret1y), "", cls(a.ret1y))}${kpi("Beta", num(a.beta))}</div>
      <div class="ql-btns"><button class="btn ghost" data-go="dcf">Open DCF →</button><button class="btn ghost" data-go="fin">Financials →</button><button class="btn ghost" data-go="research">Research →</button></div>
      <h4>THE WEB's research</h4><div id="qlDW" class="tw-muted">Loading…</div><h4>SEC fundamentals</h4><div id="qlDS" class="tw-muted">Loading…</div>`;
    el.querySelectorAll("[data-go]").forEach((x) => (x.onclick = () => { const t = x.dataset.go; setTab(t); setTimeout(() => { try { if (t === "dcf") { $("dcfSym").value = a.sym; dcfLoad(); } else if (t === "fin") { $("finSym").value = a.sym; finLoad(); } else if (typeof openQuote === "function") openQuote(a.sym); } catch {} }, 60); }));
    api(`/api/web/discoveries?symbols=${encodeURIComponent(a.sym)}&limit=3`).then((j) => { $("qlDW").innerHTML = (j.items || []).length ? (j.items || []).map((d) => `<p class="ql-disc"><b>${esc(d.headline)}</b><br><span class="tw-muted">${esc(d.cat || "")} · ${new Date(d.u || d.t).toLocaleDateString()}</span></p>`).join("") : "No findings on this holding yet."; }).catch(() => ($("qlDW").textContent = "THE WEB is only available when signed in."));
    api(`/api/pub/sec?symbol=${encodeURIComponent(a.sym)}`).then((j) => { if (!j.available) { $("qlDS").textContent = j.reason || "Not available."; return; } const y = j.years[j.years.length - 1], p = j.years[j.years.length - 2];
      $("qlDS").innerHTML = `<div class="ql-mini">${kpi("Revenue", big(y.revenue), p && p.revenue ? sgn(y.revenue / p.revenue - 1) + " y/y" : "")}${kpi("Net income", big(y.netIncome))}${kpi("Free cash flow", big(y.fcf))}${kpi("Debt", big(y.totalDebt))}</div><span class="tw-muted">${esc(y._form || "10-K")} for fiscal ${esc(String(y._fy || (y.end || "").slice(0, 4)))} · SEC EDGAR</span>`; }).catch(() => ($("qlDS").textContent = "SEC data unavailable right now."));
  }

  // ---------------------------------------------------------------- 6. correlation lab
  async function renderCor(b) {
    const n = b.have.length; if (n < 2) { setSt("cor", "UNAVAILABLE", "Needs at least two holdings"); $("qb-cor").innerHTML = `<div class="fx-empty">Correlations need at least two holdings.</div>`; return "na"; }
    const cl = M.cluster(b.Cor, 0.5), ord = cl.order, dv = M.diversification(b.w, b.C), pairs = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push(b.Cor[i][j]);
    const avg = M.mean(pairs), cs = Math.max(14, Math.min(34, 520 / n)), Wd = 70 + cs * n, Hd = 70 + cs * n;
    const col = (r) => (r >= 0 ? `rgba(94,234,212,${(0.12 + r * 0.85).toFixed(2)})` : `rgba(251,146,60,${(0.12 - r * 0.85).toFixed(2)})`);
    const cells = ord.map((i, y) => ord.map((j, x) => `<rect x="${70 + x * cs}" y="${70 + y * cs}" width="${cs - 1}" height="${cs - 1}" fill="${col(b.Cor[i][j])}" data-i="${i}" data-j="${j}" class="ql-cell"><title>${b.have[i]} / ${b.have[j]}: ${b.Cor[i][j].toFixed(2)}</title></rect>${cs >= 26 ? `<text x="${70 + x * cs + cs / 2}" y="${70 + y * cs + cs / 2 + 3}" class="ql-cvt" style="fill:${Math.abs(b.Cor[i][j]) > 0.55 ? "#0b1117" : "#cbd5e1"}">${Math.abs(b.Cor[i][j]) < 0.05 ? "0" : b.Cor[i][j].toFixed(1)}</text>` : ""}`).join("")).join("");
    const lab = ord.map((i, k) => `<text x="64" y="${70 + k * cs + cs / 2 + 3}" text-anchor="end" class="ql-ax">${b.have[i]}</text><text transform="translate(${70 + k * cs + cs / 2},64) rotate(-50)" class="ql-ax">${b.have[i]}</text>`).join("");
    const groups = cl.clusters.filter((g) => g.length > 1).map((g) => g.map((i) => b.have[i]).join(" · "));
    let worst = [0, 1, -2]; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (b.Cor[i][j] > worst[2]) worst = [i, j, b.Cor[i][j]];
    b.corr = { avg, dv, groups, top: worst };
    $("qb-cor").innerHTML = `<div class="ql-two"><div class="ql-heat"><svg viewBox="0 0 ${Wd} ${Hd}" class="ql-svg" style="max-width:${Math.round(Wd * 1.25)}px">${lab}${cells}</svg>${note("Daily-return correlations over the window, re-ordered by average-linkage clustering so similar holdings sit together. Click any cell for the pair's rolling correlation.")}</div>
      <div class="ql-side"><div class="ql-mini">${kpi("Avg pairwise ρ", num(avg))}${kpi("Diversification ratio", num(dv.ratio), "Σwσ / σp")}${kpi("Effective holdings", num(dv.effectiveN, 1), "1 / Σw²")}${kpi("Most similar pair", `${b.have[worst[0]]}/${b.have[worst[1]]}`, "ρ " + num(worst[2]))}</div>
      <h4>Clusters (ρ-distance &lt; 0.5)</h4><p>${groups.length ? groups.map((g) => `<span class="ql-tag">${esc(g)}</span>`).join(" ") : "No tight clusters — holdings behave fairly independently."}</p><div id="qlPair"></div></div></div>`;
    const pair = (i, j) => { const rc = M.rollingCorr(b.R[i], b.R[j], 63); $("qlPair").innerHTML = `<h4>${b.have[i]} vs ${b.have[j]} — rolling 63-day correlation</h4>${lineSVG([{ v: rc, c: "#4da3ff" }], { dates: b.dates, h: 150, fmtY: (v) => v.toFixed(1), zero: true })}<p class="tw-muted">Full-window correlation ${num(b.Cor[i][j])}; range over time ${num(Math.min(...rc.filter((x) => x != null)))} to ${num(Math.max(...rc.filter((x) => x != null)))}.</p>`; };
    $("qb-cor").querySelector("svg").onclick = (e) => { const t = e.target.closest(".ql-cell"); if (t && t.dataset.i !== t.dataset.j) pair(+t.dataset.i, +t.dataset.j); };
    pair(worst[0], worst[1]);
  }

  // ---------------------------------------------------------------- 5. factor exposure (ETF proxies, OLS)
  async function renderFx(b) {
    const need = ["SPY", "IWM", "IWD", "IWF", "MTUM", "QUAL", "USMV"], have = need.filter((s) => b.out[s]);
    const A = M.align({ ...Object.fromEntries(b.have.map((s) => [s, b.out[s]])), ...Object.fromEntries(have.map((s) => [s, b.out[s]])) });
    const N = Math.min(A.dates.length - 1, 756), r = (s) => M.returns(A.px[s]).slice(-N), rfD = b.rf / M.DAYS;
    const pr = M.portReturns(b.have.map(r), b.w), y = pr.map((x) => x - rfD), F = [];
    const add = (k, ok, col) => { if (ok) F.push([k, col]); };
    add("MKT", have.includes("SPY"), r("SPY").map((x) => x - rfD)); add("SIZE", have.includes("IWM"), have.includes("IWM") && r("IWM").map((x, i) => x - r("SPY")[i]));
    add("VALUE", have.includes("IWD") && have.includes("IWF"), have.includes("IWD") && have.includes("IWF") && r("IWD").map((x, i) => x - r("IWF")[i]));
    add("MOM", have.includes("MTUM"), have.includes("MTUM") && r("MTUM").map((x, i) => x - r("SPY")[i])); add("QUAL", have.includes("QUAL"), have.includes("QUAL") && r("QUAL").map((x, i) => x - r("SPY")[i])); add("LOWVOL", have.includes("USMV"), have.includes("USMV") && r("USMV").map((x, i) => x - r("SPY")[i]));
    const fit = M.ols(y, F.map((f) => f[1])); if (!fit) throw new Error("The factor regression couldn't be solved (the factor series are collinear).");
    const roll = F.map(() => []), rd = []; for (let e = 126; e <= y.length; e += 10) { const f = M.ols(y.slice(e - 126, e), F.map((x) => x[1].slice(e - 126, e))); if (f) { f.betas.forEach((v, k) => roll[k].push(v)); rd.push(A.dates.slice(-N)[e - 1]); } }
    const C = ["#5eead4", "#4da3ff", "#facc15", "#f472b6", "#a78bfa", "#fb923c"];
    b.fx = { fit, names: F.map((f) => f[0]) };
    const row = (k, i) => { const meta = FACTORS.find((f) => f[0] === k), v = fit.betas[i], t = fit.t[i + 1]; return `<tr><td><b>${meta[1]}</b><br><span class="tw-muted">${meta[2]}</span></td><td class="${cls(v)}">${num(v)}</td><td>${num(t, 1)}</td><td>${Math.abs(t) >= 2 ? '<span class="ql-tag ok">significant</span>' : '<span class="ql-tag">weak</span>'}</td><td><div class="ql-hb"><i style="${v >= 0 ? `left:50%;width:${Math.min(50, Math.abs(v) * 40)}%` : `right:50%;width:${Math.min(50, Math.abs(v) * 40)}%`};background:${v >= 0 ? "#5eead4" : "#fb923c"}"></i></div></td></tr>`; };
    $("qb-fx").innerHTML = `<div class="ql-two"><div><table class="ql-tbl"><thead><tr><th>Factor (ETF proxy)</th><th>Exposure β</th><th>t-stat</th><th></th><th></th></tr></thead><tbody>${F.map((f, i) => row(f[0], i)).join("")}</tbody></table>
      <p class="tw-muted">R² ${pct(fit.r2)} · annual alpha ${sgn(fit.alpha * M.DAYS, 2)} (t ${num(fit.t[0], 1)}) · ${fit.n} days${b.failedProxy.length ? ` · missing proxies: ${esc(b.failedProxy.join(", "))}` : ""}</p></div>
      <div><h4>Rolling 6-month exposures</h4>${lineSVG(roll.map((v, k) => ({ v, c: C[k] })), { dates: rd, h: 190, fmtY: (v) => v.toFixed(1), zero: true })}${legend(F.map((f, k) => [C[k], FACTORS.find((x) => x[0] === f[0])[1]]))}</div></div>
      ${note("Method: ordinary least squares of the portfolio's daily excess return on long-short ETF return spreads (free proxies for the academic Fama-French / AQR factors, which are not available as free daily data here). Exposures are relative: a size β of 0.3 means the portfolio behaves like it holds 30% extra small-caps-minus-large-caps. The ETF spreads overlap, so individual betas can shift when factors are added or removed; t-stats above 2 are conventionally treated as significant.")}`;
  }

  // ---------------------------------------------------------------- 7. optimization
  async function renderOpt(b) {
    const n = b.have.length; if (n < 2) { setSt("opt", "UNAVAILABLE", "Needs at least two holdings"); $("qb-opt").innerHTML = `<div class="fx-empty">Optimization needs at least two holdings.</div>`; return "na"; }
    const hi = Math.min(1, Math.max(0.25, 1.5 / n)), histMu = b.R.map((r) => M.mean(r) * M.DAYS), capm = b.assets.map((a) => a.mu), mu = histMu.map((h, i) => 0.5 * h + 0.5 * capm[i]);
    const o = M.optimize(mu, b.Cann, { lo: 0, hi, rf: b.rf }), cur = { w: b.w, ret: M.dot(b.w, mu), vol: Math.sqrt(M.pVar(b.w, b.Cann)) }; cur.sharpe = (cur.ret - b.rf) / cur.vol;
    const half = Math.floor(b.R[0].length / 2), seg = (a, z) => { const R = b.R.map((r) => r.slice(a, z)), C = M.covMatrix(R).map((r) => r.map((x) => x * M.DAYS)), m = R.map((r, i) => 0.5 * M.mean(r) * M.DAYS + 0.5 * capm[i]); return M.optimize(m, C, { lo: 0, hi, rf: b.rf }); };
    const o1 = seg(0, half), o2 = seg(half, b.R[0].length), BPS = 10;
    const P = [["Current", cur, null], ["Minimum variance", o.minVar, "minVar"], ["Maximum Sharpe", o.maxSharpe, "maxSharpe"], ["Risk parity", o.riskParity, "riskParity"], ["Equal weight", o.equal, "equal"]];
    const unstable = (k) => (k ? M.turnover(o1[k].w, o2[k].w) : 0);
    b.opt = { o, cur, hi, unstable: Object.fromEntries(P.filter((p) => p[2]).map((p) => [p[2], unstable(p[2])])) };
    const fr = o.frontier, vs = [...fr.map((f) => f.vol), cur.vol, ...b.assets.map((a) => a.vol)], rs = [...fr.map((f) => f.ret), cur.ret, ...mu], W = 520, H = 260, L = 50, B = 30;
    const v0 = Math.min(...vs) * 0.9, v1 = Math.max(...vs) * 1.05, r0 = Math.min(...rs, 0), r1 = Math.max(...rs) * 1.1, X = (v) => L + ((v - v0) / (v1 - v0)) * (W - L - 12), Y = (r) => H - B - ((r - r0) / (r1 - r0)) * (H - B - 12);
    const pts = (P.slice(1).map(([nm, p], k) => `<circle cx="${X(p.vol)}" cy="${Y(p.ret)}" r="6" fill="${["#5eead4", "#facc15", "#a78bfa", "#94a3b8"][k]}"><title>${nm}</title></circle>`)).join("") + `<circle cx="${X(cur.vol)}" cy="${Y(cur.ret)}" r="7" fill="none" stroke="#f472b6" stroke-width="2.5"><title>Current portfolio</title></circle>` + b.assets.map((a, i) => `<text x="${X(a.vol)}" y="${Y(mu[i])}" class="ql-ax" text-anchor="middle">${a.sym}</text>`).join("");
    const frontier = `<svg viewBox="0 0 ${W} ${H}" class="ql-svg"><line x1="${L}" y1="${H - B}" x2="${W}" y2="${H - B}" class="ql-grid"/><line x1="${L}" y1="0" x2="${L}" y2="${H - B}" class="ql-grid"/><path d="M${fr.map((f) => `${X(f.vol)},${Y(f.ret)}`).join("L")}" class="ql-line" style="stroke:#4da3ff;stroke-width:2"/>${pts}<text x="${W - 4}" y="${H - 8}" text-anchor="end" class="ql-ax">volatility → ${pct(v1, 0)}</text><text x="${L - 4}" y="12" text-anchor="end" class="ql-ax">${pct(r1, 0)}</text><text x="${L - 4}" y="${H - B}" text-anchor="end" class="ql-ax">${pct(r0, 0)}</text></svg>`;
    $("qb-opt").innerHTML = `<div class="ql-scroll"><table class="ql-tbl"><thead><tr><th>Portfolio</th><th>Exp. return</th><th>Volatility</th><th>Sharpe</th><th>Turnover vs now</th><th>Est. cost</th><th>Stability</th>${b.have.map((s) => `<th>${s}</th>`).join("")}</tr></thead><tbody>
      ${P.map(([nm, p, k]) => { const to = k ? M.turnover(b.w, p.w) : 0, u = unstable(k); return `<tr class="${k ? "" : "cur"}"><td><b>${nm}</b></td><td>${pct(p.ret)}</td><td>${pct(p.vol)}</td><td>${num(p.sharpe)}</td><td>${k ? pct(to) : "—"}</td><td>${k ? usd(M.tradeCost(b.w, p.w, b.value, BPS)) : "—"}</td><td>${k ? (u > 0.3 ? `<span class="ql-tag warn" title="Weights from the first and second half of the window differ by ${pct(u)}">unstable ${pct(u, 0)}</span>` : `<span class="ql-tag ok">stable ${pct(u, 0)}</span>`) : ""}</td>${p.w.map((x, i) => `<td class="${k && Math.abs(x - b.w[i]) > 0.05 ? (x > b.w[i] ? "up" : "down") : ""}">${pct(x, 0)}</td>`).join("")}</tr>`; }).join("")}</tbody></table></div>
      <div class="ql-two"><div>${frontier}${legend([["#4da3ff", "Efficient frontier"], ["#5eead4", "Min variance"], ["#facc15", "Max Sharpe"], ["#a78bfa", "Risk parity"], ["#94a3b8", "Equal"], ["#f472b6", "Current"]])}</div>
      <div>${note(`Constraints applied automatically: long-only, each holding between 0% and ${pct(hi, 0)}, fully invested. Expected returns are a 50/50 blend of each holding's historical return and its CAPM return (risk-free + β × ${pct(ERP, 0)} equity premium) — historical means alone are too noisy to optimize on. Covariances are the sample covariance of daily returns × 252. Costs assume ${BPS} bps per side. <b>Stability</b> re-runs each optimizer on the first and second half of the window; turnover above 30% between the two means the result is fragile and shouldn't be trusted much. These are research outputs, not instructions — nothing is rebalanced.`)}</div></div>`;
  }

  // ---------------------------------------------------------------- 8. market regime
  async function renderReg(b) {
    const A = M.align({ SPY: b.out.SPY, ...(b.out.HYG && b.out.IEF ? { HYG: b.out.HYG, IEF: b.out.IEF } : {}) }), px = A.px.SPY, credit = A.px.HYG ? A.px.HYG.map((v, i) => v / A.px.IEF[i]) : null;
    const tl = M.regimes(px, credit, 5); if (!tl.length) throw new Error("Not enough SPY history for regime detection (needs about 13 months).");
    const now = tl[tl.length - 1], C = { "Risk-on trend": "#0fbf7d", "Choppy / late-cycle": "#facc15", Correction: "#fb923c", "Risk-off / high volatility": "#f6465d" };
    b.regime = now; const k = $("qlRegK"); if (k) k.innerHTML = `<span style="color:${C[now.label]}">${esc(now.label)}</span>`;
    const t0 = tl[0].i, t1 = tl[tl.length - 1].i, x = (i) => ((i - t0) / Math.max(1, t1 - t0)) * 100;
    const strip = tl.map((r, k) => `<i style="left:${x(r.i)}%;width:${(k < tl.length - 1 ? x(tl[k + 1].i) - x(r.i) : 0.6) + 0.05}%;background:${C[r.label]}" title="${day(A.dates[r.i])}: ${r.label}"></i>`).join("");
    const ind = now.ind, row = (n, v, ok, why) => `<tr><td>${n}</td><td>${v}</td><td>${ok == null ? "—" : ok ? '<span class="ql-tag ok">supportive</span>' : '<span class="ql-tag warn">warning</span>'}</td><td class="tw-muted">${why}</td></tr>`;
    $("qb-reg").innerHTML = `<div class="ql-regnow" style="border-color:${C[now.label]}"><b style="color:${C[now.label]}">${esc(now.label)}</b><span>as of ${day(A.dates[now.i])} · score ${num(now.score, 1)}</span></div>
      ${lineSVG([{ v: px.slice(t0), c: "#e2e8f0", sw: 1.3 }], { dates: A.dates.slice(t0), h: 170, fmtY: (v) => "$" + v.toFixed(0), log: true })}<div class="ql-strip">${strip}</div>${legend(Object.entries(C).map(([n, c]) => [c, n]))}
      <table class="ql-tbl"><thead><tr><th>Indicator (S&P 500 via SPY)</th><th>Now</th><th></th><th>Rule</th></tr></thead><tbody>
      ${row("Price vs 200-day average", ind.aboveTrend ? "above" : "below", ind.aboveTrend, "Long-term trend")}${row("50-day vs 200-day average", ind.goldenCross ? "50 above 200" : "50 below 200", ind.goldenCross, "Medium-term trend")}
      ${row("21-day realized volatility", `${pct(ind.vol)} (1y median ${pct(ind.volMedian)})`, !ind.volHigh, "Warning above 1.4× its 1-year median")}${row("Drawdown from 52-week high", pct(ind.drawdown), ind.drawdown > -0.1, "Correction below −10%, risk-off below −20%")}
      ${row("Credit (HYG/IEF, 3-month)", ind.credit == null ? "unavailable" : sgn(ind.credit), ind.credit == null ? null : ind.credit > 0, "High-yield bonds outperforming Treasuries = healthy risk appetite")}</tbody></table>
      ${note("Rules, checked weekly: Risk-off if the drawdown is beyond −20% or volatility is high while price is below its 200-day average; Correction if below the 200-day or down more than 10%; Risk-on if above the 200-day with the 50-day above the 200-day and normal volatility; otherwise Choppy. Transparent and deliberately simple — regimes are only obvious in hindsight, and this does not predict the next move.")}`;
  }

  // ---------------------------------------------------------------- 3. strategy tournament + replay
  async function renderBt(b) {
    const U = b.have, n = U.length, top = Math.max(1, Math.min(3, Math.floor(n / 2))), from = b.dates[0], to = b.dates[b.dates.length - 1];
    const series = Object.fromEntries([...new Set([...U, "SPY"])].map((s) => [s, { t: b.out[s].t, close: b.out[s].close, adj: b.out[s].adj }]));
    const wts = Object.fromEntries(U.map((s, i) => [s, b.w[i] * 100]));
    const base = { universe: U, benchmark: "SPY", from, to, initial: Math.round(b.value), costs: { commissionBps: 0, spreadBps: 5, slippageBps: 2 }, limits: { maxWeight: 1, minCash: 0 }, rf: b.rf, series };
    const entries = [["rebalance", { freq: "quarterly" }, wts, "Your weights, rebalanced quarterly"], ["buyhold", {}, wts, "Your weights, never rebalanced"], ["riskparity", {}, null, "Risk parity (inverse volatility)"]];
    if (n >= 2) entries.push(["momentum", { top }, null, `Momentum: top ${top}`], ["multifactor", { top }, null, `Multi-factor: top ${top}`]);
    entries.push(["smacross", {}, null, "Trend filter (50/200-day)"]);
    const rows = [];
    for (const [k, params, weights, label] of entries) { await tick(); try { const r = Q.run({ ...base, strategy: k, params, weights }); const cut = Math.floor(r.dates.length * 0.7);
      const ins = Q.metrics(r.dates.slice(0, cut + 1), r.equity.slice(0, cut + 1), r.bench.slice(0, cut + 1), b.rf), oos = Q.metrics(r.dates.slice(cut), r.equity.slice(cut), r.bench.slice(cut), b.rf);
      rows.push({ k, label, r, ins, oos, cut }); } catch (e) { rows.push({ k, label, err: e.message }); } }
    const ok = rows.filter((x) => !x.err); if (!ok.length) throw new Error("No strategy could be simulated on this portfolio.");
    const rank = (key) => { const s = [...ok].sort((a, c) => (c[key].sharpe ?? -9) - (a[key].sharpe ?? -9)); s.forEach((x, i) => (x[key + "Rank"] = i + 1)); };
    rank("ins"); rank("oos"); ok.sort((a, c) => (c.oos.sharpe ?? -9) - (a.oos.sharpe ?? -9)); const win = ok[0];
    let tuned = null; if (n >= 2) { await tick(); try { tuned = Q.optimize({ ...base, strategy: "momentum", params: {} }); } catch {} }
    b.bt = { rows: ok, win, tuned, failed: rows.filter((x) => x.err) };
    const cutDate = day(win.r.dates[win.cut]);
    $("qb-bt").innerHTML = `<div class="qb-banner">Backtested — hypothetical results on ${day(from)} → ${day(to)} with 5 bps spread + 2 bps slippage, next-day execution and adjusted prices. The engine ranks strategies on the <b>last 30%</b> of the window (${cutDate} onward) and flags any whose early ranking doesn't hold up later.</div>
      <div class="ql-scroll"><table class="ql-tbl"><thead><tr><th>#</th><th>Strategy (auto-selected)</th><th>CAGR</th><th>Sharpe — first 70%</th><th>Sharpe — last 30%</th><th>Max DD</th><th>Trades</th><th>Check</th></tr></thead><tbody>
      ${ok.map((x, i) => `<tr class="${i === 0 ? "cur" : ""}"><td>${i + 1}</td><td><b>${esc(x.label)}</b></td><td class="${cls(x.r.metrics.cagr)}">${sgn(x.r.metrics.cagr)}</td><td>${num(x.ins.sharpe)} <span class="tw-muted">#${x.insRank}</span></td><td><b>${num(x.oos.sharpe)}</b> <span class="tw-muted">#${x.oosRank}</span></td><td class="down">${pct(x.r.metrics.maxDrawdown)}</td><td>${x.r.metrics.trades}</td><td>${x.insRank <= 2 && x.oosRank - x.insRank >= 2 ? '<span class="ql-tag warn">faded out-of-sample</span>' : x.oos.sharpe != null && x.ins.sharpe != null && x.oos.sharpe < 0 && x.ins.sharpe > 0.5 ? '<span class="ql-tag warn">broke down</span>' : '<span class="ql-tag ok">consistent</span>'}</td></tr>`).join("")}
      <tr class="tw-muted"><td></td><td>S&P 500 (SPY) benchmark</td><td>${sgn(win.r.benchMetrics.cagr)}</td><td colspan="5"></td></tr></tbody></table></div>
      ${tuned ? `<p class="tw-muted">Parameter tuning check (momentum): best lookback/top chosen on ${day(tuned.inSample.from)}–${day(tuned.inSample.to)} had Sharpe ${num(tuned.inSample.metrics.sharpe)}; on the unseen remainder it scored <b>${num(tuned.outOfSample.metrics.sharpe)}</b>. ${tuned.outOfSample.metrics.sharpe < tuned.inSample.metrics.sharpe * 0.5 ? "Most of the tuned edge disappeared — classic overfitting." : "The tuned edge mostly held."}</p>` : ""}
      <h4>Replay: ${esc(win.label)} vs S&P 500</h4><div class="ql-replay"><button class="btn ghost" id="qlPlay">▶ Play</button><input type="range" id="qlScrub" min="10" max="${win.r.dates.length - 1}" value="${win.r.dates.length - 1}"><span id="qlRDate" class="tw-muted"></span></div>
      <div id="qlReplay"></div><div id="qlRTrades" class="ql-rtr"></div>`;
    replay(win.r);
  }
  function replay(r) {
    const tIdx = new Map(r.dates.map((t, i) => [t, i])), marks = r.trades.map((t) => ({ i: tIdx.get(t.t), side: t.side, t })).filter((m) => m.i != null);
    const draw = (k) => { const cut = (a) => a.map((v, i) => (i <= k ? v : null)); const mk = marks.filter((m) => m.i <= k).slice(-80).map((m) => ({ i: m.i, v: r.equity[m.i], side: m.side, title: `${day(m.t.t)} ${m.side} ${m.t.sym} ${usd(m.t.value)}` }));
      $("qlReplay").innerHTML = lineSVG([{ v: cut(r.bench), c: "#94a3b8", sw: 1.2, dash: true }, { v: cut(r.equity), c: "#5eead4", sw: 1.8 }], { dates: r.dates, h: 220, fmtY: (v) => usd(v), markers: mk }) + legend([["#5eead4", "Strategy"], ["#94a3b8", "S&P 500"], ["#0fbf7d", "Buy"], ["#f6465d", "Sell"]]);
      $("qlRDate").textContent = `${day(r.dates[k])} · strategy ${usd(r.equity[k])} vs S&P ${usd(r.bench[k])}`;
      const recent = marks.filter((m) => m.i <= k).slice(-4).reverse(); $("qlRTrades").innerHTML = recent.map((m) => `<span class="${m.side === "BUY" ? "up" : "down"}">${day(m.t.t)} ${m.side} ${esc(m.t.sym)} ${usd(m.t.value)}</span>`).join(""); };
    const sc = $("qlScrub"); sc.oninput = () => draw(+sc.value); draw(+sc.value);
    $("qlPlay").onclick = () => { if (QL.play) { clearInterval(QL.play); QL.play = null; $("qlPlay").textContent = "▶ Play"; return; } let k = +sc.value >= r.dates.length - 1 ? 10 : +sc.value; $("qlPlay").textContent = "❚❚ Pause";
      QL.play = setInterval(() => { k = Math.min(r.dates.length - 1, k + Math.max(1, Math.round(r.dates.length / 240))); sc.value = k; draw(k); if (k >= r.dates.length - 1 || S.tab !== "quant") { clearInterval(QL.play); QL.play = null; $("qlPlay").textContent = "▶ Play"; } }, 40); };
  }

  // ---------------------------------------------------------------- 4. Monte Carlo (Web Worker, seeded)
  function renderMC(b) {
    const mu = b.rf + (isFinite(b.stats.beta) ? b.stats.beta : 1) * ERP, sigma = b.stats.vol, seed = +day(b.lastT).replace(/-/g, ""), spec = { start: b.value, mu, sigma, years: 10, paths: 5000, contrib: 0, seed, keep: 80 };
    $("qb-mc").innerHTML = `<div class="ql-bar"><i id="qlMcBar" style="width:0%"></i></div><span class="tw-muted" id="qlMcTxt">Simulating 5,000 paths in a background worker…</span>`;
    const mcK = $("qlMcK"); if (mcK) mcK.textContent = "running";
    return new Promise((resolve, reject) => {
      const done = (res, ms) => { QL.ms.mcWorker = ms; b.mc = { res, spec }; if (mcK) mcK.textContent = `${res.paths.toLocaleString()} paths`; showMC(b, res, spec, ms); resolve(); };
      let w; try { w = new Worker("/qmc-worker.js"); } catch { const t = performance.now(); return done(M.monteCarlo(spec), performance.now() - t); }
      const to = setTimeout(() => { w.terminate(); const t = performance.now(); done(M.monteCarlo(spec), performance.now() - t); }, 20000);
      w.onmessage = (e) => { const d = e.data; if (d.progress != null) { const bar = $("qlMcBar"); if (bar) bar.style.width = (d.progress * 100).toFixed(0) + "%"; } else if (d.done) { clearTimeout(to); w.terminate(); done(d.result, d.ms); } else if (d.error) { clearTimeout(to); w.terminate(); reject(new Error(d.error)); } };
      w.onerror = () => { clearTimeout(to); w.terminate(); const t = performance.now(); done(M.monteCarlo(spec), performance.now() - t); };
      w.postMessage(spec);
    });
  }
  function showMC(b, r, spec, ms) {
    const yrs = Array.from({ length: r.months + 1 }, (_, i) => i), maxH = Math.max(...r.hist.map((h) => h.n));
    const hist = `<svg viewBox="0 0 300 150" class="ql-svg">${r.hist.map((h, i) => `<rect x="${i * 10}" y="${130 - (h.n / maxH) * 120}" width="9" height="${(h.n / maxH) * 120}" fill="${h.to < spec.start ? "#f6465d" : "#5eead4"}" opacity=".8"><title>${usd(h.from)}–${usd(h.to)}: ${h.n} paths</title></rect>`).join("")}<text x="0" y="146" class="ql-ax">${usd(r.hist[0].from)}</text><text x="300" y="146" text-anchor="end" class="ql-ax">${usd(r.hist[r.hist.length - 1].to)}</text></svg>`;
    $("qb-mc").innerHTML = `<div class="ql-two"><div><div id="qlFan"></div>${legend([["rgba(94,234,212,.18)", "5th–95th percentile"], ["rgba(94,234,212,.35)", "25th–75th"], ["#5eead4", "Median"], ["rgba(148,163,184,.5)", "Sample paths"]])}</div>
      <div class="ql-side"><div class="ql-mini">${kpi("Median in 10y", usd(r.terminal.p50))}${kpi("Bad case (5th pct)", usd(r.terminal.p5), "", "down")}${kpi("Good case (95th pct)", usd(r.terminal.p95), "", "up")}${kpi("P(end below start)", pct(r.probBelowStart), "after 10 years")}</div><h4>Ending values (log scale)</h4>${hist}</div></div>
      ${note(`Model: geometric Brownian motion in monthly steps. Expected return ${pct(spec.mu)} = risk-free ${pct(b.rf, 2)} + portfolio β ${num(b.stats.beta)} × ${pct(ERP, 0)} equity premium (CAPM, not the recent past); volatility ${pct(spec.sigma)} = the portfolio's realized volatility. Seed ${spec.seed} (the date of the latest price), so the same day always gives the same result. ${r.paths.toLocaleString()} paths computed in ${ms.toFixed(0)} ms off the main thread. Real markets have fatter tails and changing volatility than this model; treat the 5th percentile as optimistic.`)}`;
    // progressive reveal: sample paths draw in, then the bands
    const band = (k) => [{ lo: r.bands.p5.slice(0, k), hi: r.bands.p95.slice(0, k), c: "rgba(94,234,212,.14)" }, { lo: r.bands.p25.slice(0, k), hi: r.bands.p75.slice(0, k), c: "rgba(94,234,212,.28)" }];
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; let k = reduce ? r.months + 1 : 2;
    const frame = () => { const el = $("qlFan"); if (!el) return; const ser = r.sample.slice(0, 40).map((p) => ({ v: p.slice(0, k).concat(new Array(r.months + 1 - k).fill(null)), c: "rgba(148,163,184,.5)", sw: 0.6, op: 0.6 })); ser.push({ v: r.bands.p50.slice(0, k).concat(new Array(r.months + 1 - k).fill(null)), c: "#5eead4", sw: 2 });
      el.innerHTML = lineSVG(ser, { h: 240, fmtY: (v) => big(v), band: band(k).map((x) => ({ ...x, lo: x.lo, hi: x.hi })), log: true }) + `<div class="ql-xl"><span>today</span><span>year 5</span><span>year 10</span></div>`; if (k <= r.months) { k = Math.min(r.months + 1, k + 4); requestAnimationFrame(frame); } };
    frame(); void yrs;
  }

  // ---------------------------------------------------------------- 9. quant research assistant (rule-based, labelled)
  async function renderAI(b) {
    const out = [], C = (t) => out.push(["calc", t]), I = (t) => out.push(["interp", t]), s = b.stats, A = [...b.assets].sort((a, c) => c.rc - a.rc), top = A[0];
    C(`Over the last ${num(s.years, 1)} years at today's weights the portfolio returned ${sgn(s.ret3y)} in total (${sgn(s.cagr)} a year) with ${pct(s.vol)} volatility, a Sharpe ratio of ${num(s.sharpe)} and a worst fall of ${pct(-s.mdd)}.`);
    if (isFinite(s.beta)) { C(`Its beta to the S&P 500 is ${num(s.beta)}.`); I(s.beta > 1.15 ? `That means it tends to amplify market moves — a 10% S&P drop has historically meant roughly ${pct(s.beta * 0.1, 0)} for this portfolio.` : s.beta < 0.8 ? "It has been noticeably more defensive than the market." : "It has moved roughly in line with the market."); }
    C(`On a typical bad day (95% VaR) it loses about ${usd(s.var95 * s.value)} (${pct(s.var95, 2)}); on the worst 5% of days the average loss is ${usd(s.es95 * s.value)}.`);
    if (top && top.rc > top.w * 1.3 && top.rc > 0.2) { C(`${top.sym} is ${pct(top.w)} of the money but ${pct(top.rc)} of the risk.`); I(`Risk is more concentrated than the dollar weights suggest; ${top.sym}'s moves dominate how the whole portfolio behaves.`); }
    if (b.corr) { C(`Average correlation between holdings is ${num(b.corr.avg)}; the diversification ratio is ${num(b.corr.dv.ratio)} and the portfolio behaves like ${num(b.corr.dv.effectiveN, 1)} equally weighted positions.`); if (b.corr.top[2] > 0.8) I(`${b.have[b.corr.top[0]]} and ${b.have[b.corr.top[1]]} (ρ ${num(b.corr.top[2])}) have moved almost as one — owning both adds little diversification.`); if (b.corr.avg < 0.3) I("Holdings move fairly independently, which is a genuine source of diversification."); }
    if (b.fx) { const f = b.fx, sig = f.names.map((n, i) => [n, f.fit.betas[i], f.fit.t[i + 1]]).filter((x) => x[0] !== "MKT" && Math.abs(x[2]) >= 2 && Math.abs(x[1]) >= 0.1).sort((a, c) => Math.abs(c[1]) - Math.abs(a[1]));
      C(`The six ETF factors explain ${pct(f.fit.r2, 0)} of daily moves.${sig.length ? " Statistically meaningful tilts: " + sig.map(([n, v]) => `${FACTORS.find((x) => x[0] === n)[1].toLowerCase()} ${num(v)}`).join(", ") + "." : " No style tilt beyond the market is both statistically significant (|t| ≥ 2) and economically meaningful (|β| ≥ 0.1)."}`);
      if (sig.length) { const [n, v] = sig[0]; I({ MOM: v > 0 ? "The momentum tilt means the portfolio leans on recent winners; these tilts have historically suffered sharp reversals when market leadership changes." : "A negative momentum loading means it leans away from recent winners.", VALUE: v > 0 ? "A value tilt tends to help when rates rise and hurt in growth-led rallies." : "A growth tilt (negative value) tends to do well in growth-led rallies and poorly when rates jump.", SIZE: v > 0 ? "A small-cap tilt adds economic sensitivity." : "A large-cap tilt (negative size) has favored mega-caps.", QUAL: v > 0 ? "A quality tilt has historically held up better in downturns." : "Negative quality loading means it leans toward weaker balance sheets.", LOWVOL: v > 0 ? "A low-volatility tilt usually lags in strong rallies and protects in selloffs." : "Negative low-vol loading means the holdings are jumpier than the average stock." }[n]); } }
    if (b.opt) { const o = b.opt, gain = o.o.maxSharpe.sharpe - o.cur.sharpe, ms = o.unstable.maxSharpe, mv = o.unstable.minVar;
      C(`Under the stated assumptions, the max-Sharpe mix scores ${num(o.o.maxSharpe.sharpe)} vs ${num(o.cur.sharpe)} for current weights; minimum-variance would cut volatility to ${pct(o.o.minVar.vol)} from ${pct(o.cur.vol)}.`);
      I(ms > 0.3 ? `The max-Sharpe weights changed by ${pct(ms, 0)} between the two halves of the window, so that "improvement" is mostly estimation noise. ${mv <= 0.3 ? "The minimum-variance mix is more stable and is the more trustworthy of the two." : ""}` : gain > 0.2 ? "The optimized weights were stable across both halves, which makes the improvement more credible — still an estimate, not a forecast." : "Current weights are already close to efficient under these assumptions."); }
    if (b.regime) { C(`Market regime: ${b.regime.label} (S&P ${b.regime.ind.aboveTrend ? "above" : "below"} its 200-day average, ${pct(b.regime.ind.drawdown)} from its high, 21-day volatility ${pct(b.regime.ind.vol)}).`); I(b.regime.label === "Risk-on trend" ? "Trend conditions are supportive; historically the bigger risk in this regime is complacency about concentration." : b.regime.label === "Correction" || b.regime.label.startsWith("Risk-off") ? `Conditions are defensive. With a beta of ${num(s.beta)}, this portfolio would feel a continued decline ${s.beta > 1 ? "more" : "less"} than the index.` : "Signals are mixed; trend-following strategies tend to whipsaw in this kind of market."); }
    if (b.bt) { const w = b.bt.win, fade = b.bt.rows.filter((x) => x.insRank <= 2 && x.oosRank - x.insRank >= 2); C(`Strategy tournament: "${w.label}" had the best Sharpe (${num(w.oos.sharpe)}) on the most recent 30% of the window.`); I(fade.length ? `${fade.map((x) => `"${x.label}"`).join(" and ")} looked best early but faded — a reminder that backtest leaders often don't stay leaders.` : "Rankings were fairly consistent between the early and late parts of the window, though a 3-year test is short."); }
    if (b.mc) { const r = b.mc.res; C(`Monte Carlo (5,000 paths, CAPM return ${pct(b.mc.spec.mu)}): median ${usd(r.terminal.p50)} in 10 years, 5th percentile ${usd(r.terminal.p5)}, ${pct(r.probBelowStart)} chance of ending below today's value.`); }
    if (b.ap && b.ap.positions) { const mine = new Set(b.have), ov = (b.ap.positions || []).map((p) => p.symbol || p.sym).filter((x) => mine.has(x)); C(`AI Trader's paper account holds ${(b.ap.positions || []).length} positions${ov.length ? `, ${ov.length} of which you also own (${ov.join(", ")})` : ""}.`); }
    if (b.missing.length) C(`Excluded for lack of price history: ${b.missing.join(", ")}.`);
    const checks = selfTest(b);
    $("qb-ai").innerHTML = `<div class="ql-eng">Automated quant engine · rule-based analysis of the numbers above · no paid AI model · refreshed ${new Date().toLocaleTimeString()}</div>
      <ul class="ql-ai">${out.map(([k, t]) => `<li class="${k}"><span class="ql-tag ${k === "calc" ? "ok" : "int"}">${k === "calc" ? "Calculated" : "Interpretation"}</span>${esc(t)}</li>`).join("")}</ul>
      <p class="tw-muted">Self-check: ${checks.filter((c) => c[1]).length}/${checks.length} validation tests passed in your browser${checks.some((c) => !c[1]) ? " — failed: " + checks.filter((c) => !c[1]).map((c) => c[0]).join(", ") : ""}. Not investment advice; nothing here is traded.</p>`;
    b.checks = checks;
  }
  function selfTest(b) {
    const near = (a, c, t = 1e-6) => Math.abs(a - c) < t, sw = (w) => near(w.reduce((x, y) => x + y, 0), 1);
    const mc1 = M.monteCarlo({ start: 100, mu: 0.05, sigma: 0.2, years: 1, paths: 200, seed: 3 }), mc2 = M.monteCarlo({ start: 100, mu: 0.05, sigma: 0.2, years: 1, paths: 200, seed: 3 });
    return [["weights sum to 100%", sw(b.w)], ["risk contributions sum to 100%", near(M.riskContrib(b.w, b.C).reduce((a, c) => a + c, 0), 1)], ["correlation diagonal = 1", b.Cor.every((r, i) => near(r[i], 1))],
      ["ES ≥ VaR", !(b.stats.es95 < b.stats.var95)], ["optimizer weights within bounds", !b.opt || ["minVar", "maxSharpe", "riskParity"].every((k) => sw(b.opt.o[k].w) && b.opt.o[k].w.every((x) => x >= -1e-9 && x <= b.opt.hi + 1e-6))], ["Monte Carlo reproducible", mc1.terminal.p50 === mc2.terminal.p50]];
  }

  function foot() { const m = QL.ms, f = (x) => (x == null ? "—" : x < 1000 ? x.toFixed(0) + " ms" : (x / 1000).toFixed(1) + " s");
    $("qlFoot").innerHTML = `Computed in ${f(m.total)} · data ${f(m.load)} · risk ${f(m.cc)} · map ${f(m.uni)} · correlations ${f(m.cor)} · factors ${f(m.fx)} · optimization ${f(m.opt)} · regime ${f(m.reg)} · tournament ${f(m.bt)} · Monte Carlo ${f(m.mcWorker)} (worker) · Sources: Yahoo Finance daily adjusted closes via /api/pub/hist, SEC EDGAR, THE WEB. Free data, no paid services.`; window.QL_TIMINGS = m; }

  window.qlOpen = function () { shell(); run(false); };
  if (S.tab === "quant") window.qlOpen();
})();

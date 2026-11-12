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
  const QL = { busy: false, res: null, sig: "", at: 0, st: {}, ms: {}, view: "net", color: "cluster", scen: "none", sector: "", rot: { yaw: 0.6, pitch: -0.35, zoom: 1, auto: true }, hover: -1, sel: null };
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

  // ---------------------------------------------------------------- 2. portfolio risk universe
  // Three views of the same risk model. Network: 3D classical MDS of correlations, holdings linked by their
  // minimum spanning tree (Mantegna 1999), clusters from average linkage, a ring on every node = its share of
  // portfolio risk. Risk budget: where the money is (inner ring) against where the risk is (outer ring).
  // Risk vs return: volatility against 1-year return. Scenarios re-colour every view with stressed numbers.
  const CLC = ["#5eead4", "#4da3ff", "#facc15", "#f472b6", "#a78bfa", "#fb923c", "#34d399", "#f87171", "#93c5fd", "#fde68a"];
  const COLOR = { cluster: ["Cluster", null, null], vol: ["Volatility", (a) => a.vol, pct], rc: ["Risk share", (a) => a.rc, pct], ret1y: ["1-year return", (a) => a.ret1y, sgn], beta: ["Beta", (a) => a.beta, num], sharpe: ["Sharpe", (a) => a.sharpe, num] };
  const SCEN = { none: "Normal", crash: "Market −20%", spike: "Correlation spike", worst: "Worst day" };
  function ramp(t) { t = Math.max(0, Math.min(1, t)); const stops = [[77, 163, 255], [94, 234, 212], [250, 204, 21], [246, 70, 93]], k = Math.min(2, Math.floor(t * 3)), f = t * 3 - k, a = stops[k], c = stops[k + 1]; return `rgb(${a.map((x, i) => Math.round(x + (c[i] - x) * f)).join(",")})`; }
  const rgba = (hex, a) => { if (hex.startsWith("rgb(")) return hex.replace("rgb(", "rgba(").replace(")", `,${a})`); const v = parseInt(hex.slice(1), 16); return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`; };
  async function renderUni(b) {
    const n = b.have.length, P = M.mds(b.Cor, 3), m = Math.max(1e-9, ...P.flat().map(Math.abs)); b.pos = P.map((p) => p.map((x) => x / m));
    for (const a of b.assets) a.sector = await (typeof sectorOf === "function" ? Promise.resolve(sectorOf(a.sym)).catch(() => "Other") : "Other");
    // risk anatomy
    const cl = M.cluster(b.Cor, 0.6); b.cl = new Array(n).fill(0); cl.clusters.forEach((g, k) => g.forEach((i) => (b.cl[i] = k)));
    b.tree = n > 1 ? M.mst(b.Cor) : []; b.nbr = Array.from({ length: n }, () => []); b.tree.forEach((e) => { b.nbr[e.a].push(e.b); b.nbr[e.b].push(e.a); });
    const E = M.enb(b.w, b.C), sp = Math.sqrt(M.pVar(b.w, b.C)), Cw = b.C.map((r) => M.dot(r, b.w)), cv = M.componentVaR(b.w, b.C);
    b.an = { enb: E.enb, p: E.p, pcs: E.pcs, cvar: cv.map((x) => x * b.value), varP: cv.reduce((x, y) => x + y, 0) * b.value, mcr: Cw.map((x) => (sp > 0 ? (x / sp) * Math.sqrt(M.DAYS) : 0)), effRisk: 1 / b.assets.reduce((x, a) => x + a.rc * a.rc, 0), dr: M.diversification(b.w, b.C).ratio };
    b.assets.forEach((a, i) => { a.cvar = b.an.cvar[i]; a.mcr = b.an.mcr[i]; a.cluster = b.cl[i]; });
    // stress scenarios (all computed, none assumed beyond what's stated)
    const crash = b.assets.map((a) => a.value * (isFinite(a.beta) ? a.beta : 1) * -0.2);
    const sv = (rho) => M.stressVol(b.w, b.C, rho) * Math.sqrt(M.DAYS), s = b.C.map((r, i) => Math.sqrt(r[i])), Cs = b.C.map((r, i) => r.map((v, j) => (i === j ? v : s[i] * s[j] * 0.9)));
    let wk = 0; b.pr.forEach((x, k) => { if (x < b.pr[wk]) wk = k; });
    b.scen = { crash: { pnl: crash, total: crash.reduce((x, y) => x + y, 0) }, spike: { vol0: b.stats.vol, vol1: sv(0.9), var0: M.invNorm(0.95) * sp * b.value, var1: M.invNorm(0.95) * Math.sqrt(M.pVar(b.w, Cs)) * b.value, rc: M.riskContrib(b.w, Cs) },
      worst: { date: b.dates[wk], ret: b.pr[wk], pnl: b.assets.map((a, i) => a.value * b.R[i][wk]), total: b.pr[wk] * b.value } };
    const secs = [...new Set(b.assets.map((a) => a.sector || "Other"))].sort(), seg = (id, items, on) => `<div class="ql-seg" id="${id}">${items.map(([k, t]) => `<button data-v="${k}" class="${k === on ? "on" : ""}">${t}</button>`).join("")}</div>`;
    $("qb-uni").innerHTML = `<div class="ql-ctl">${seg("qlView", [["net", "Correlation network"], ["budget", "Risk budget"], ["rr", "Risk vs return"]], QL.view)}${seg("qlScenB", Object.entries(SCEN), QL.scen || "none")}
      <label>Color <select class="field" id="qlColor">${Object.entries(COLOR).map(([k, [nm]]) => `<option value="${k}" ${k === QL.color ? "selected" : ""}>${nm}</option>`).join("")}</select></label>
      <label>Sector <select class="field" id="qlSector"><option value="">All</option>${secs.map((x) => `<option>${esc(x)}</option>`).join("")}</select></label></div>
      <div class="ql-uni"><div class="ql-cv"><canvas id="qlCv"></canvas><div class="ql-tip" id="qlTip" hidden></div><div class="ql-scale" id="qlScale"></div><div class="ql-scen" id="qlScen"></div><div class="ql-cvhint">drag · scroll · click</div></div>
      <div class="ql-det"><div id="qlDetB"></div><div id="qlAnat">${anatomy(b)}</div></div></div>
      ${note(`<b>Network:</b> holdings placed by classical multidimensional scaling of the correlation matrix (distance √(2(1 − ρ))) and connected by its minimum spanning tree — the ${Math.max(0, n - 1)} strongest links that join everything without loops (Mantegna, 1999). Flow along a link speeds up with correlation. Halos are correlation clusters (average linkage). Node size = weight; the ring = share of portfolio risk, amber where risk outruns capital. <b>Effective bets</b> is Meucci's (2009) entropy of the portfolio's variance across uncorrelated principal components. <b>Component VaR</b> splits the parametric 1-day 95% VaR exactly across holdings. Scenarios: market −20% scaled by each holding's beta; every pairwise correlation set to 0.9 with volatilities unchanged; and the worst actual day in the window replayed.`)}`;
    const segWire = (id, key, after) => ($(id).onclick = (e) => { const v = e.target.dataset.v; if (!v) return; QL[key] = v; $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v)); after && after(); });
    if (!["net", "budget", "rr"].includes(QL.view)) QL.view = "net"; if (!COLOR[QL.color]) QL.color = "cluster"; QL.scen = QL.scen || "none";
    segWire("qlView", "view"); segWire("qlScenB", "scen", () => scenText(b));
    $("qlColor").onchange = (e) => (QL.color = e.target.value); $("qlSector").onchange = (e) => (QL.sector = e.target.value);
    $("qlView").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === QL.view));
    scenText(b); universe(b);
  }
  function anatomy(b) {
    const A = b.an, n = b.have.length, pcs = (A.pcs || []).slice(0, Math.min(6, n)), mx = Math.max(...pcs.map((p) => p.share), ...A.p.slice(0, 6), 0.01);
    const scree = `<svg viewBox="0 0 260 96" class="ql-svg">${pcs.map((p, k) => `<rect x="${8 + k * 42}" y="${80 - (p.share / mx) * 66}" width="16" height="${(p.share / mx) * 66}" fill="rgba(148,163,184,.45)"><title>PC${k + 1}: ${pct(p.share)} of total variance</title></rect><rect x="${25 + k * 42}" y="${80 - ((A.p[k] || 0) / mx) * 66}" width="16" height="${((A.p[k] || 0) / mx) * 66}" fill="#5eead4"><title>PC${k + 1}: ${pct(A.p[k] || 0)} of your portfolio's variance</title></rect><text x="${24 + k * 42}" y="93" text-anchor="middle" class="ql-ax">PC${k + 1}</text>`).join("")}</svg>`;
    const top = [...b.assets].sort((x, y) => y.cvar - x.cvar).slice(0, 6), cmax = Math.max(...top.map((a) => a.cvar), 1);
    return `<h4>Risk anatomy</h4><div class="ql-gauge"><div><b>${num(A.enb, 1)}</b><span>effective bets</span></div><div class="ql-gbar"><i style="width:${Math.min(100, (A.enb / n) * 100).toFixed(0)}%"></i></div><em>of ${n} holdings · Meucci ENB</em></div>
      <div class="ql-mini">${kpi("Market mode", pct(pcs[0] ? pcs[0].share : NaN, 0), "PC1 share of variance")}${kpi("Risk holdings", num(A.effRisk, 1), "1 / Σ risk share²")}${kpi("Diversification", num(A.dr), "Σwσ / σp")}${kpi("1-day VaR 95%", usd(A.varP), "parametric")}</div>
      <h4>Principal components</h4>${scree}${legend([["rgba(148,163,184,.6)", "share of all variance"], ["#5eead4", "share of your portfolio's variance"]])}
      <h4>Component VaR (1-day, 95%)</h4>${top.map((a) => `<div class="ql-cvr"><span>${esc(a.sym)}</span><div><i style="width:${((a.cvar / cmax) * 100).toFixed(0)}%;background:${a.rc > a.w * 1.3 ? "#facc15" : "#5eead4"}"></i></div><b>${usd(a.cvar)}</b><em>${pct(a.cvar / A.varP, 0)}</em></div>`).join("")}`;
  }
  function scenText(b) {
    const e = $("qlScen"); if (!e) return; const S0 = b.scen, k = QL.scen;
    if (k === "crash") { const i = S0.crash.pnl.indexOf(Math.min(...S0.crash.pnl)); e.innerHTML = `<b>Market −20%</b> (each holding moves β × −20%)<br>Portfolio <span class="down">${usd(S0.crash.total)} (${sgn(S0.crash.total / b.value)})</span> · biggest hit ${esc(b.have[i])} ${usd(S0.crash.pnl[i])}`; }
    else if (k === "spike") e.innerHTML = `<b>Correlation spike</b> (every ρ → 0.9, as in a panic)<br>Volatility ${pct(S0.spike.vol0)} → <span class="down">${pct(S0.spike.vol1)}</span> · 1-day VaR ${usd(S0.spike.var0)} → <span class="down">${usd(S0.spike.var1)}</span>`;
    else if (k === "worst") { const i = S0.worst.pnl.indexOf(Math.min(...S0.worst.pnl)); e.innerHTML = `<b>Worst day in the window</b> · ${day(S0.worst.date)}<br>Portfolio <span class="down">${sgn(S0.worst.ret)} (${usd(S0.worst.total)})</span> · worst holding ${esc(b.have[i])} ${usd(S0.worst.pnl[i])}`; }
    else e.innerHTML = `<b>${num(b.an.enb, 1)} effective bets</b> across ${b.have.length} holdings · ${b.tree.length} spanning links · ${new Set(b.cl).size} clusters`;
  }
  function universe(b) {
    const cv = $("qlCv"), ctx = cv.getContext("2d"), n = b.have.length; let drag = null, proj = [], hitBudget = null;
    const size = () => { const r = cv.parentElement.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1); cv.width = r.width * d; cv.height = r.height * d; cv.style.width = r.width + "px"; cv.style.height = r.height + "px"; QL.cvD = d; };
    size(); if (QL.onResize) removeEventListener("resize", QL.onResize); QL.onResize = size; addEventListener("resize", size);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; if (reduce) QL.rot.auto = false;
    QL.cam = QL.cam || { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0 }; QL.sel = null;
    const rnd = M.mulberry32(11), stars = Array.from({ length: 160 }, () => { const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = 2.2 + rnd() * 1.6; return [Math.sqrt(1 - u * u) * Math.cos(th) * r, u * r, Math.sqrt(1 - u * u) * Math.sin(th) * r, 0.3 + rnd() * 0.7]; });
    const pnlOf = (i) => (QL.scen === "crash" ? b.scen.crash.pnl[i] : QL.scen === "worst" ? b.scen.worst.pnl[i] : null), rcOf = (i) => (QL.scen === "spike" ? b.scen.spike.rc[i] : b.assets[i].rc);
    const colOf = (i, lo, hi) => { const pl = pnlOf(i); if (pl != null) { const mx = Math.max(1, ...b.assets.map((_, k) => Math.abs(pnlOf(k)))); const t = pl / mx; return t < 0 ? `rgb(${Math.round(120 + 126 * -t)},${Math.round(90 - 20 * -t)},${Math.round(100 - 7 * -t)})` : "rgb(15,191,125)"; }
      if (QL.color === "cluster") return CLC[b.cl[i] % CLC.length]; const v = COLOR[QL.color][1](b.assets[i]); return isFinite(v) ? ramp((v - lo) / (hi - lo || 1)) : "#64748b"; };
    cv.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY, moved: false, yaw: QL.rot.yaw, pitch: QL.rot.pitch }; cv.setPointerCapture(e.pointerId); };
    cv.onpointermove = (e) => { const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; QL.rot.auto = false; } if (QL.view === "net") { QL.rot.yaw = drag.yaw + dx * 0.008; QL.rot.pitch = Math.max(-1.3, Math.min(1.3, drag.pitch + dy * 0.008)); } }
      let best = -1;
      if (QL.view === "budget" && hitBudget) best = hitBudget(mx, my);
      else { let bd = 1e9; proj.forEach((p, i) => { const d = Math.hypot(p.x - mx, p.y - my); if (d < p.r + 6 && d < bd) { bd = d; best = i; } }); }
      QL.hover = best; const tip = $("qlTip");
      if (best >= 0) { const a = b.assets[best], nb = b.nbr[best].map((j) => [b.have[j], b.Cor[best][j]]).sort((x, y) => y[1] - x[1])[0], pl = pnlOf(best);
        tip.hidden = false; tip.style.left = Math.min(r.width - 230, mx + 14) + "px"; tip.style.top = my + 12 + "px";
        tip.innerHTML = `<b>${esc(a.sym)}</b> <span style="color:${CLC[a.cluster % CLC.length]}">● cluster ${a.cluster + 1}</span><br>weight ${pct(a.w)} · risk ${pct(rcOf(best))}<br>component VaR ${usd(a.cvar)} · MCR ${pct(a.mcr)}${nb ? `<br>closest link ${esc(nb[0])} ρ ${num(nb[1])}` : ""}${pl != null ? `<br>scenario <span class="${cls(pl)}">${usd(pl)}</span>` : ""}`; }
      else tip.hidden = true; };
    cv.onpointerup = () => { if (drag && !drag.moved && QL.hover >= 0) { QL.sel = QL.hover; const p = b.pos[QL.sel]; Object.assign(QL.cam, { tx: p[0], ty: p[1], tz: p[2] || 0 }); QL.rot.zoom = Math.max(QL.rot.zoom, 1.35); detail(b, QL.sel); } else if (drag && !drag.moved && QL.hover < 0 && QL.sel != null) { QL.sel = null; Object.assign(QL.cam, { tx: 0, ty: 0, tz: 0 }); QL.rot.zoom = 1; $("qlDetB").innerHTML = ""; } drag = null; };
    cv.onpointerleave = () => { QL.hover = -1; $("qlTip").hidden = true; };
    cv.onwheel = (e) => { e.preventDefault(); QL.rot.zoom = Math.max(0.5, Math.min(3, QL.rot.zoom * (e.deltaY > 0 ? 0.92 : 1.08))); };
    const label = (txt, x, y, col, bold) => { ctx.font = `${bold ? "600 " : ""}11px ui-monospace,SFMono-Regular,monospace`; ctx.textAlign = "center"; ctx.fillStyle = "rgba(6,10,14,.75)"; const w = ctx.measureText(txt).width + 8; ctx.fillRect(x - w / 2, y - 10, w, 14); ctx.fillStyle = col; ctx.fillText(txt, x, y + 1); };
    const vis = (i) => !QL.sector || b.assets[i].sector === QL.sector;
    let last = 0;
    const draw = (t) => {
      if (!document.body.contains(cv)) return; QL.raf = requestAnimationFrame(draw);
      if (S.tab !== "quant" || document.hidden) return; const dt = Math.min(0.05, (t - (last || t)) / 1000); last = t;
      const d = QL.cvD, W = cv.width / d, H = cv.height / d; ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, W, H);
      const vals = b.assets.map((a) => (COLOR[QL.color][1] ? COLOR[QL.color][1](a) : 0)).filter(isFinite), lo = Math.min(...vals), hi = Math.max(...vals);
      const hov = QL.hover, near = hov >= 0 ? new Set([hov, ...b.nbr[hov]]) : null, dim = (i) => (!vis(i) ? 0.12 : near && !near.has(i) ? 0.28 : 1);
      if (QL.view === "net") {
        if (QL.rot.auto && !reduce) QL.rot.yaw += dt * 0.12; const c = QL.cam; for (const k of ["x", "y", "z"]) c[k] += (c["t" + k] - c[k]) * Math.min(1, dt * 4);
        const cy = Math.cos(QL.rot.yaw), sy = Math.sin(QL.rot.yaw), cp = Math.cos(QL.rot.pitch), sp = Math.sin(QL.rot.pitch), S0 = Math.min(W, H) * 0.34 * QL.rot.zoom;
        const P3 = (x, y, z) => { x -= c.x; y -= c.y; z -= c.z; const X = x * cy - z * sy, Z0 = x * sy + z * cy, Y = y * cp - Z0 * sp, Z = y * sp + Z0 * cp, f = 3.2 / (3.2 + Z); return { x: W / 2 + X * S0 * f, y: H / 2 + Y * S0 * f, z: Z, f }; };
        for (const s of stars) { const p = P3(s[0], s[1], s[2]); if (p.z < -3) continue; ctx.fillStyle = `rgba(148,197,255,${(s[3] * 0.35 * Math.min(1, p.f)).toFixed(3)})`; ctx.fillRect(p.x, p.y, 1.2 * p.f, 1.2 * p.f); }
        ctx.lineWidth = 1; for (const rr of [0.55, 1.05, 1.55]) { ctx.strokeStyle = `rgba(94,234,212,${rr === 1.05 ? 0.10 : 0.06})`; ctx.beginPath(); for (let k = 0; k <= 64; k++) { const a = (k / 64) * Math.PI * 2, p = P3(Math.cos(a) * rr, 1.25, Math.sin(a) * rr); k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); } ctx.stroke(); }
        proj = b.pos.map((p) => P3(p[0], p[1], p[2] || 0)); proj.forEach((p, i) => (p.r = (6 + Math.sqrt(b.assets[i].w) * 30) * p.f));
        // cluster halos
        const groups = {}; b.cl.forEach((k, i) => (groups[k] = groups[k] || []).push(i));
        for (const [k, g] of Object.entries(groups)) { if (g.length < 2) continue; const gx = g.reduce((a, i) => a + proj[i].x, 0) / g.length, gy = g.reduce((a, i) => a + proj[i].y, 0) / g.length, rad = Math.max(...g.map((i) => Math.hypot(proj[i].x - gx, proj[i].y - gy) + proj[i].r)) + 26;
          const gr = ctx.createRadialGradient(gx, gy, 0, gx, gy, rad), col = CLC[k % CLC.length]; gr.addColorStop(0, rgba(col, 0.13)); gr.addColorStop(0.7, rgba(col, 0.05)); gr.addColorStop(1, rgba(col, 0)); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(gx, gy, rad, 0, Math.PI * 2); ctx.fill(); }
        // spanning-tree links with flowing particles
        for (const e of b.tree) { const A = proj[e.a], B = proj[e.b], on = hov >= 0 && (e.a === hov || e.b === hov), al = Math.min(dim(e.a), dim(e.b)) * (on ? 1 : 0.75), r = Math.max(0, e.rho), col = e.rho >= 0 ? "94,234,212" : "251,146,60";
          const g = ctx.createLinearGradient(A.x, A.y, B.x, B.y); g.addColorStop(0, `rgba(${col},${(0.15 + 0.5 * r) * al})`); g.addColorStop(0.5, `rgba(${col},${(0.3 + 0.6 * r) * al})`); g.addColorStop(1, `rgba(${col},${(0.15 + 0.5 * r) * al})`);
          ctx.strokeStyle = g; ctx.lineWidth = (0.8 + Math.abs(e.rho) * 3.2) * (on ? 1.6 : 1); ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
          if (!reduce) for (let k = 0; k < 3; k++) { const ph = ((t / 1000) * (0.12 + 0.45 * Math.abs(e.rho)) + k / 3) % 1, x = A.x + (B.x - A.x) * ph, y = A.y + (B.y - A.y) * ph; ctx.fillStyle = `rgba(${col},${0.9 * al})`; ctx.beginPath(); ctx.arc(x, y, 1.6 + Math.abs(e.rho), 0, Math.PI * 2); ctx.fill(); } }
        // strong correlations outside the tree, faint and dashed
        ctx.setLineDash([3, 5]); for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { if (Math.abs(b.Cor[i][j]) < 0.7 || b.nbr[i].includes(j)) continue; ctx.strokeStyle = `rgba(148,163,184,${0.18 * Math.min(dim(i), dim(j))})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(proj[i].x, proj[i].y); ctx.lineTo(proj[j].x, proj[j].y); ctx.stroke(); } ctx.setLineDash([]);
        const rmax = Math.max(...b.assets.map((_, i) => rcOf(i)), 1e-9);
        [...proj.keys()].sort((x, y) => proj[y].z - proj[x].z).forEach((i) => { const p = proj[i], a = b.assets[i], col = colOf(i, lo, hi); ctx.globalAlpha = dim(i);
          const glow = ctx.createRadialGradient(p.x, p.y, p.r * 0.6, p.x, p.y, p.r * 2.4); glow.addColorStop(0, rgba(col, 0.35)); glow.addColorStop(1, rgba(col, 0)); ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 2.4, 0, Math.PI * 2); ctx.fill();
          const g = ctx.createRadialGradient(p.x - p.r * 0.35, p.y - p.r * 0.4, p.r * 0.1, p.x, p.y, p.r); g.addColorStop(0, "#ffffff"); g.addColorStop(0.3, col); g.addColorStop(1, "rgba(8,12,18,.95)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
          const rc = rcOf(i), over = rc > a.w * 1.3; ctx.strokeStyle = "rgba(148,163,184,.18)"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 5, 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = over ? "#facc15" : "#e2e8f0"; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 5, -Math.PI / 2, -Math.PI / 2 + (rc / rmax) * Math.PI * 2); ctx.stroke();
          if (QL.sel === i) { ctx.strokeStyle = `rgba(94,234,212,${0.5 + 0.4 * Math.sin(t / 250)})`; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 11 + 2 * Math.sin(t / 250), 0, Math.PI * 2); ctx.stroke(); }
          const pl = pnlOf(i); label(pl != null ? `${a.sym} ${usd(pl)}` : `${a.sym} ${pct(a.w, 0)}`, p.x, p.y - p.r - 12, "#e2e8f0", i === hov); ctx.globalAlpha = 1; });
        hitBudget = null;
      } else if (QL.view === "budget") {
        const cx = W / 2, cy0 = H / 2 + 6, R = Math.min(W, H) * 0.42, r1 = R * 0.5, r2 = R * 0.78, t1 = R * 0.1, t2 = R * 0.14;
        const ord = [...b.assets.keys()].sort((x, y) => rcOf(y) - rcOf(x)), arcs = []; let aw = -Math.PI / 2, ar = -Math.PI / 2;
        for (const i of ord) { const w = b.assets[i].w * Math.PI * 2, rr = Math.max(0, rcOf(i)) * Math.PI * 2; arcs.push({ i, w0: aw, w1: aw + w, r0: ar, r1: ar + rr }); aw += w; ar += rr; }
        const sector = (rad, th, a0, a1, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(cx, cy0, rad + th, a0, a1); ctx.arc(cx, cy0, rad, a1, a0, true); ctx.closePath(); ctx.fill(); };
        const pt = (rad, a) => [cx + Math.cos(a) * rad, cy0 + Math.sin(a) * rad];
        for (const A of arcs) { const col = colOf(A.i, lo, hi), al = dim(A.i), g = 0.004;
          ctx.fillStyle = rgba(col, (hov === A.i ? 0.32 : 0.09) * al); ctx.beginPath(); ctx.moveTo(...pt(r1 + t1, A.w0 + g)); ctx.arc(cx, cy0, r1 + t1, A.w0 + g, A.w1 - g);
          const e1 = pt(r2, A.r1 - g), c1 = pt((r1 + r2) / 2 + t1, A.w1), c2 = pt((r1 + r2) / 2, A.r1); ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], e1[0], e1[1]); ctx.arc(cx, cy0, r2, A.r1 - g, A.r0 + g, true);
          const s0 = pt(r1 + t1, A.w0 + g), d1 = pt((r1 + r2) / 2, A.r0), d2 = pt((r1 + r2) / 2 + t1, A.w0); ctx.bezierCurveTo(d1[0], d1[1], d2[0], d2[1], s0[0], s0[1]); ctx.fill();
          ctx.globalAlpha = al; sector(r1, t1, A.w0 + g, A.w1 - g, col); sector(r2, t2, A.r0 + g, A.r1 - g, col); ctx.globalAlpha = 1;
          const a = b.assets[A.i], mid = (A.r0 + A.r1) / 2; if (rcOf(A.i) > 0.035 || A.i === hov) { const [lx, ly] = pt(r2 + t2 + 18, mid); ctx.textAlign = lx < cx ? "right" : "left"; ctx.font = "600 11px ui-monospace,monospace"; ctx.fillStyle = "#e2e8f0"; ctx.fillText(a.sym, lx, ly); ctx.font = "10px ui-monospace,monospace"; ctx.fillStyle = rcOf(A.i) > a.w * 1.3 ? "#facc15" : "#94a3b8"; ctx.fillText(`${pct(rcOf(A.i), 0)} risk · ${pct(a.w, 0)} $`, lx, ly + 13); } }
        ctx.textAlign = "center"; ctx.fillStyle = "#e2e8f0"; ctx.font = "600 34px ui-monospace,monospace"; ctx.fillText(num(b.an.enb, 1), cx, cy0 + 4); ctx.font = "11px ui-monospace,monospace"; ctx.fillStyle = "#94a3b8"; ctx.fillText(`effective bets of ${n}`, cx, cy0 + 22);
        ctx.font = "10px ui-monospace,monospace"; ctx.fillStyle = "#64748b"; ctx.fillText("inner ring = money · outer ring = risk" + (QL.scen === "spike" ? " (spike)" : ""), cx, cy0 + 40);
        hitBudget = (mx, my) => { const dx = mx - cx, dy = my - cy0, rr = Math.hypot(dx, dy); let a = Math.atan2(dy, dx); if (a < -Math.PI / 2) a += Math.PI * 2; const A = rr >= r1 && rr <= r1 + t1 ? arcs.find((x) => a >= x.w0 && a < x.w1) : rr >= r2 && rr <= r2 + t2 ? arcs.find((x) => a >= x.r0 && a < x.r1) : null; return A ? A.i : -1; };
        proj = [];
      } else {
        const vs = b.assets.map((a) => a.vol), rs = b.assets.map((a) => a.ret1y), v0 = 0, v1 = Math.max(...vs) * 1.15 || 1, r0 = Math.min(0, ...rs) * 1.15, r1 = Math.max(0.01, ...rs) * 1.15, L = 58, B = 36, T = 20;
        const X = (v) => L + ((v - v0) / (v1 - v0)) * (W - L - 20), Y = (r) => H - B - ((r - r0) / (r1 - r0)) * (H - B - T);
        ctx.strokeStyle = "rgba(148,163,184,.12)"; ctx.fillStyle = "#64748b"; ctx.font = "10px ui-monospace,monospace"; ctx.textAlign = "right";
        for (let k = 0; k <= 4; k++) { const r = r0 + (k / 4) * (r1 - r0); ctx.beginPath(); ctx.moveTo(L, Y(r)); ctx.lineTo(W - 20, Y(r)); ctx.stroke(); ctx.fillText(pct(r, 0), L - 6, Y(r) + 3); }
        ctx.textAlign = "center"; for (let k = 0; k <= 4; k++) { const v = v0 + (k / 4) * (v1 - v0); ctx.fillText(pct(v, 0), X(v), H - B + 14); } ctx.fillText("volatility (annualized) →", W / 2, H - 6);
        // iso-Sharpe lines through the risk-free rate
        ctx.setLineDash([4, 4]); for (const sr of [0.5, 1, 2]) { ctx.strokeStyle = "rgba(94,234,212,.16)"; ctx.beginPath(); ctx.moveTo(X(0), Y(b.rf)); ctx.lineTo(X(v1), Y(b.rf + sr * v1)); ctx.stroke(); const yy = Y(Math.min(r1, b.rf + sr * v1)); ctx.fillStyle = "rgba(94,234,212,.5)"; ctx.fillText(`Sharpe ${sr}`, Math.min(W - 50, X(Math.min(v1, (r1 - b.rf) / sr))) - 6, yy + 12); } ctx.setLineDash([]);
        const pv = b.stats.vol, prt = b.stats.ret1y; ctx.strokeStyle = "#f472b6"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(pv), Y(prt), 9, 0, Math.PI * 2); ctx.stroke(); label("PORTFOLIO", X(pv), Y(prt) - 16, "#f472b6", true);
        proj = b.assets.map((a) => ({ x: X(a.vol), y: Y(a.ret1y), z: 0, f: 1, r: 5 + Math.sqrt(a.w) * 26 }));
        proj.forEach((p, i) => { const col = colOf(i, lo, hi); ctx.globalAlpha = dim(i); const g = ctx.createRadialGradient(p.x - p.r * 0.3, p.y - p.r * 0.3, 1, p.x, p.y, p.r); g.addColorStop(0, "#fff"); g.addColorStop(0.3, col); g.addColorStop(1, "rgba(8,12,18,.9)"); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); label(b.assets[i].sym, p.x, p.y - p.r - 10, "#e2e8f0", i === hov); ctx.globalAlpha = 1; });
        hitBudget = null;
      }
      const sk = QL.view + QL.color + QL.scen + lo + hi; if (QL.scaleKey !== sk) { QL.scaleKey = sk; const sc = $("qlScale");
        sc.innerHTML = QL.scen === "crash" || QL.scen === "worst" ? `<span>Scenario P&amp;L</span><i style="background:linear-gradient(90deg,#f6465d,#78505a,#0fbf7d)"></i>` : QL.color === "cluster" ? `<span>Clusters</span><div class="ql-cdots">${[...new Set(b.cl)].map((k) => `<b style="background:${CLC[k % CLC.length]}"></b>`).join("")}</div>` : `<span>${COLOR[QL.color][0]}</span><i></i><em>${COLOR[QL.color][2](lo)}</em><em>${COLOR[QL.color][2](hi)}</em>`; }
    };
    cancelAnimationFrame(QL.raf); QL.raf = requestAnimationFrame(draw);
  }
  async function detail(b, i) {
    QL.sel = i; const a = b.assets[i], el = $("qlDetB"), nb = b.nbr[i].map((j) => `<span class="ql-tag">${esc(b.have[j])} ρ ${num(b.Cor[i][j])}</span>`).join(" ");
    el.innerHTML = `<h3>${esc(a.sym)} <small class="tw-muted">${esc(a.sector || "")}</small></h3><div class="ql-mini">${kpi("Weight", pct(a.w))}${kpi("Value", usd(a.value))}${kpi("Risk share", pct(a.rc))}${kpi("Volatility", pct(a.vol))}${kpi("1-year", sgn(a.ret1y), "", cls(a.ret1y))}${kpi("Beta", num(a.beta))}${kpi("Component VaR", usd(a.cvar), "1-day 95%")}${kpi("Marginal risk", pct(a.mcr), "∂σ/∂w")}</div>
      ${nb ? `<p class="ql-nb">Linked in the spanning tree to ${nb}</p>` : ""}<div class="ql-btns"><button class="btn ghost" data-go="dcf">Open DCF →</button><button class="btn ghost" data-go="fin">Financials →</button><button class="btn ghost" data-go="research">Research →</button></div>
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

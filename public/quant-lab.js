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
  let wireHoverLater = false; const QL = { busy: false, res: null, sig: "", at: 0, st: {}, ms: {}, view: "net", color: "cluster", scen: "none", sector: "", rot: { yaw: 0.6, pitch: -0.35, zoom: 1, auto: true }, hover: -1, sel: null };
  const MODS = [["cc", "Command center"], ["uni", "Portfolio risk universe"], ["bt", "Strategy tournament & replay"], ["mc", "Monte Carlo"], ["fx", "Factor exposure"], ["cor", "Correlation lab"], ["opt", "Portfolio optimization"], ["reg", "Market regime"], ["ai", "Signal board"]];
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
  // today's histories are also kept in this browser, so a revisit is instant (older days are cleaned up)
  const LK = (k) => "qh2:" + k;
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith("qh2:") && !k.endsWith("|" + new Date().toISOString().slice(0, 10))) localStorage.removeItem(k); } } catch {}
  function hist(sym, from, to) { const k = `${sym}|${from}|${to}`; if (!HC.has(k)) {
      let hit = null; try { const v = localStorage.getItem(LK(k)); if (v) hit = JSON.parse(v); } catch {}
      const p = hit ? Promise.resolve(hit) : api(`/api/pub/hist?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&interval=1d`).then((j) => { try { localStorage.setItem(LK(k), JSON.stringify({ t: j.t, close: j.close, adj: j.adj, name: j.name })); } catch {} return j; });
      HC.set(k, p); p.catch(() => HC.delete(k)); } return HC.get(k); }
  async function loadAll(syms, from, to, onEach) { const out = {}, todo = [...syms]; let n = 0, failed = [];
    const one = async () => { while (todo.length) { const s = todo.shift(); try { const j = await hist(s, from, to); if (j && j.t && j.t.length > 30) out[s] = j; else failed.push(s); } catch { failed.push(s); } onEach && onEach(++n, syms.length); } };
    await Promise.all([one(), one(), one()]);
    // free data sources rate-limit bursts: retry anything that failed once, one at a time, after a pause
    if (failed.length) { const again = failed; failed = []; await new Promise((r) => setTimeout(r, 1500)); for (const s of again) { try { HC.delete(`${s}|${from}|${to}`); const j = await hist(s, from, to); if (j && j.t && j.t.length > 30) out[s] = j; else failed.push(s); } catch { failed.push(s); } } }
    return { out, failed }; }

  // ---------------------------------------------------------------- shell
  function shell() {
    const el = $("tab-quant"); if (el.dataset.ready) return; el.dataset.ready = "1";
    wireHoverLater = true; el.innerHTML = `<div class="fx-head"><div><div class="fx-kick">∑ QUANT · AUTOMATED</div><h1>Quant Lab</h1>
      <p class="fx-sub ql-tagline">Autonomous risk engine · real adjusted prices · no inputs · no trades</p></div>
      <div class="ql-hstat"><span id="qlOverall" class="ql-chip calc">CALCULATING</span><span id="qlFresh" class="tw-muted"></span><button class="btn ghost" type="button" id="qlRe" title="Recalculate with the latest prices">↻ Recalculate</button></div></div>
      <div id="qlProg" class="ql-prog"></div>
      ${MODS.map(([k, n], i) => `<section class="fx-card ql-mod" id="qm-${k}"><div class="ql-mh"><h2><span class="ql-n">${i + 1}</span>${n}</h2>${chip(k)}</div><div class="ql-body" id="qb-${k}"><div class="fx-empty"><span class="spin"></span> Waiting for data…</div></div></section>`).join("")}
      <div class="ql-foot" id="qlFoot"></div>`;
    $("qlRe").onclick = () => run(true); wireHover();
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
      const spy0 = out.SPY ? out.SPY.t[0] : 0, short = held.filter((s) => out[s] && out[s].t.length < 260);
      let have = held.filter((s) => out[s] && !short.includes(s)); if (!have.length && short.length) have = short.filter((s) => out[s].t.length > 60); void spy0;
      if (!have.length) throw new Error("No price history could be loaded for any holding" + (failed.length ? ` (${failed.join(", ")})` : "") + ".");
      if (!out.SPY) throw new Error("Couldn't load SPY, which every module uses as the market benchmark.");
      const irx = out["^IRX"], rf = irx && irx.close.length ? Math.min(0.1, Math.max(0, irx.close[irx.close.length - 1] / 100)) : 0.04, rfSrc = irx ? "13-week T-bill yield (^IRX)" : "assumed 4.0% (T-bill yield unavailable)";
      const lastT = Math.max(...have.map((s) => out[s].t[out[s].t.length - 1])), ageD = (Date.now() / 1000 - lastT) / 86400, stale = ageD > 4;
      const base = compute(P, have, out, rf, [...failed.filter((s) => held.includes(s)), ...short.filter((s) => !have.includes(s)).map((s) => s + " (under 1 year of history)")]);
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
  const QC = { n: 0, g: {} };
  function lineSVG(series, opts = {}) { const { w = 760, h = 220, fmtY = (v) => pct(v, 0), dates, markers = [], zero = false, band, log = false } = opts;
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
    const id = "qc" + ++QC.n; QC.g[id] = { X, Y, n, w, h, L, Rr, T, B, series, dates, fmtY };
    const bg = (opts.bg || []).map((r) => `<rect x="${X(r.i0)}" y="${T}" width="${Math.max(0.5, X(r.i1) - X(r.i0))}" height="${h - T - B}" fill="${r.c}" opacity="${r.o || 0.12}"/>`).join("");
    return `<svg viewBox="0 0 ${w} ${h}" class="ql-svg" preserveAspectRatio="none" data-qc="${id}">${bg}${ticks}${z}${bands}${lines}${mk}${xt}<g class="ql-xh"></g></svg>`;
  }

  // crosshair + tooltip for every chart drawn by lineSVG
  function wireHover() {
    const root = $("tab-quant"); if (root.dataset.hov) return; root.dataset.hov = "1";
    const tip = document.createElement("div"); tip.className = "ql-xt"; tip.hidden = true; document.body.appendChild(tip);
    root.addEventListener("pointermove", (e) => { const sv = e.target.closest && e.target.closest("svg[data-qc]"); document.querySelectorAll("svg[data-qc] .ql-xh").forEach((g) => { if (!sv || g.parentNode !== sv) g.innerHTML = ""; }); if (!sv) { tip.hidden = true; return; }
      const G = QC.g[sv.dataset.qc]; if (!G || !G.n) return; const r = sv.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * G.w, i = Math.max(0, Math.min(G.n - 1, Math.round(((vx - G.L) / (G.w - G.L - G.Rr)) * (G.n - 1))));
      const vals = G.series.map((s) => ({ s, v: s.v[i] })).filter((x) => x.v != null && isFinite(x.v) && x.s.name);
      sv.querySelector(".ql-xh").innerHTML = `<line x1="${G.X(i)}" x2="${G.X(i)}" y1="${G.T}" y2="${G.h - G.B}" class="ql-xl"/>` + vals.map((x) => `<circle cx="${G.X(i)}" cy="${G.Y(x.v)}" r="3.5" fill="${x.s.c}" stroke="#05080c" stroke-width="1.5"/>`).join("");
      if (!vals.length && !G.dates) { tip.hidden = true; return; }
      tip.hidden = false; tip.innerHTML = `${G.dates && G.dates[i] != null ? `<b>${day(G.dates[i])}</b>` : `<b>${G.xLabel ? G.xLabel(i) : "#" + i}</b>`}${vals.map((x) => `<div><i style="background:${x.s.c}"></i>${esc(x.s.name)}<span>${(x.s.fmt || G.fmtY)(x.v)}</span></div>`).join("")}`;
      const tx = Math.min(innerWidth - 230, e.clientX + 16), ty = Math.min(innerHeight - tip.offsetHeight - 10, e.clientY + 12); tip.style.transform = `translate(${tx}px,${ty}px)`; });
    root.addEventListener("pointerleave", () => { tip.hidden = true; });
  }
  const legend = (items) => `<div class="ql-leg">${items.map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join("")}</div>`;
  const kpi = (k, v, sub, c) => `<div class="ql-kpi"><span>${k}</span><b class="${c || ""}">${v}</b>${sub ? `<em>${sub}</em>` : ""}</div>`;
  const note = (t) => `<details class="ql-m"><summary>ⓘ method</summary><p>${t}</p></details>`;

  // ---------------------------------------------------------------- shared visual helpers
  const roll = (a, n, f) => a.map((_, i) => (i + 1 < n ? null : f(a.slice(i + 1 - n, i + 1))));
  const cum = (r) => { const e = [1]; for (const x of r) e.push(e[e.length - 1] * (1 + x)); return e; };
  function spark(v, c = "#5eead4", w = 120, h = 30) { const a = v.filter((x) => x != null && isFinite(x)); if (a.length < 2) return ""; const lo = Math.min(...a), hi = Math.max(...a) || lo + 1, n = v.length;
    let d = "", pen = false; v.forEach((x, i) => { if (x == null || !isFinite(x)) { pen = false; return; } d += (pen ? "L" : "M") + ((i / (n - 1)) * w).toFixed(1) + "," + (h - 2 - ((x - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1); pen = true; });
    return `<svg viewBox="0 0 ${w} ${h}" class="ql-spark" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${c}" stroke-width="1.4"/></svg>`; }
  const tile = (k, v, sp, c, sub) => `<div class="ql-tile"><span>${k}</span><b class="${c || ""}">${v}</b>${sub ? `<em>${sub}</em>` : ""}${sp || ""}</div>`;
  const segH = (id, items, on) => `<div class="ql-seg" id="${id}">${items.map(([k, t]) => `<button data-v="${k}" class="${k === on ? "on" : ""}">${t}</button>`).join("")}</div>`;
  const segOn = (id, fn) => { const el = $(id); el.onclick = (e) => { const v = e.target.dataset.v; if (!v) return; el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v)); fn(v); }; };
  const PAL = ["#5eead4", "#4da3ff", "#facc15", "#f472b6", "#a78bfa", "#fb923c", "#34d399", "#f87171", "#93c5fd", "#fde68a", "#c4b5fd", "#67e8f9"];

  // ---------------------------------------------------------------- 1. command center
  async function renderCC(b) {
    const s = b.stats, pr = b.pr, sp = b.spR, n = pr.length, rfD = b.rf / M.DAYS, D = b.eqDates;
    const peq = b.eq, seq = cum(sp), dd = M.drawdownSeries(peq), sdd = M.drawdownSeries(seq);
    const rv = roll(pr, 63, (x) => M.annVol(x)), srv = roll(sp, 63, (x) => M.annVol(x)), rs = roll(pr, 126, (x) => M.sharpe(x, b.rf)), ssr = roll(sp, 126, (x) => M.sharpe(x, b.rf));
    const rb = pr.map((_, i) => (i + 1 < 126 ? null : M.beta(pr.slice(i - 125, i + 1), sp.slice(i - 125, i + 1)))), rvar = roll(pr, 252, (x) => M.varHist(x)), r1 = roll(pr, 252, (x) => x.reduce((a, y) => a * (1 + y), 1) - 1);
    let ap = null; try { ap = await api("/api/autopilot"); } catch {} b.ap = ap;
    const pad = (a) => [null, ...a]; // daily-return series start one day after the equity series
    b.cc = { D, peq, seq, dd, sdd, rv: pad(rv), srv: pad(srv), rs: pad(rs), ssr: pad(ssr) };
    const top = [...b.assets].sort((x, y) => y.rc - x.rc).slice(0, 6), mx = Math.max(...top.map((a) => Math.max(a.rc, a.w)), 0.01);
    $("qb-cc").innerHTML = `<div class="ql-src">${esc(b.P.name)} · ${b.have.length} holdings · ${num(s.years, 1)}y daily${b.missing.length ? ` · <span class="down">excluded: ${esc(b.missing.join(", "))}</span>` : ""}</div>
      <div class="ql-tiles">${tile("Value", usd(s.value), spark(peq.slice(-252)))}${tile("1Y return", sgn(s.ret1y), spark(r1.slice(-500), "#34d399"), cls(s.ret1y))}${tile("Volatility", pct(s.vol), spark(rv.slice(-500), "#facc15"))}${tile("Sharpe", num(s.sharpe), spark(rs.slice(-500), "#4da3ff"))}
        ${tile("Sortino", num(s.sortino))}${tile("Max DD", pct(-s.mdd), spark(dd.slice(-500), "#f6465d"), "down")}${tile("Beta", num(s.beta), spark(rb.slice(-500), "#a78bfa"))}${tile("VaR 95%", usd(s.var95 * s.value), spark(rvar.slice(-500), "#fb923c"), "", pct(s.var95, 2))}
        ${tile("ES 95%", usd(s.es95 * s.value), "", "", pct(s.es95, 2))}${tile("Regime", '<span id="qlRegK">…</span>')}${tile("Simulation", '<span id="qlMcK">queued</span>')}${tile("Data", day(b.lastT), "", b.stale ? "down" : "", b.stale ? Math.floor(b.ageD) + "d old" : "latest close")}</div>
      <div class="ql-two"><div>${segH("qlCcV", [["g", "Growth"], ["dd", "Drawdown"], ["v", "Volatility"], ["s", "Sharpe"], ["h", "Distribution"]], "g")}<div id="qlCcC"></div></div>
      <div class="ql-side"><h4>Risk vs capital</h4>${top.map((a) => `<div class="ql-rv"><span>${esc(a.sym)}</span><div><i class="w" style="width:${(a.w / mx) * 100}%"></i><i class="r" style="width:${(a.rc / mx) * 100}%"></i></div><em>${pct(a.rc, 0)}</em></div>`).join("")}${legend([["#64748b", "capital"], ["#5eead4", "risk"]])}
      ${ap ? `<h4>AI Trader · paper</h4><div class="ql-tiles sm">${tile("Positions", String((ap.positions || []).length))}${tile("Mode", ap.lastScan && ap.lastScan.riskOff ? '<span class="down">risk-off</span>' : '<span class="up">risk-on</span>')}</div>` : ""}</div></div>`;
    const draw = (v) => { const el = $("qlCcC");
      if (v === "g") el.innerHTML = lineSVG([{ v: peq.map((x) => x - 1), c: "#5eead4", name: "Portfolio", sw: 2 }, { v: seq.map((x) => x - 1), c: "#94a3b8", name: "S&P 500", dash: true }], { dates: D, zero: true, h: 240 });
      else if (v === "dd") el.innerHTML = lineSVG([{ v: dd, c: "#f6465d", name: "Portfolio", sw: 1.8 }, { v: sdd, c: "#94a3b8", name: "S&P 500", dash: true }], { dates: D, zero: true, h: 240, band: [{ lo: dd.map(() => 0), hi: dd, c: "rgba(246,70,93,.15)" }] });
      else if (v === "v") el.innerHTML = lineSVG([{ v: b.cc.rv, c: "#facc15", name: "Portfolio 63d vol", sw: 1.8 }, { v: b.cc.srv, c: "#94a3b8", name: "S&P 500", dash: true }], { dates: D, h: 240 });
      else if (v === "s") el.innerHTML = lineSVG([{ v: b.cc.rs, c: "#4da3ff", name: "Portfolio 6m Sharpe", sw: 1.8, fmt: (x) => num(x) }, { v: b.cc.ssr, c: "#94a3b8", name: "S&P 500", dash: true, fmt: (x) => num(x) }], { dates: D, h: 240, zero: true, fmtY: (x) => num(x, 1) });
      else el.innerHTML = histo(pr, s); };
    segOn("qlCcV", draw); draw("g");
  }
  // daily-return distribution with a fitted normal curve and the VaR / ES lines
  function histo(r, s) {
    const W = 760, H = 240, L = 40, B = 26, lo = M.quantile(r, 0.002), hi = M.quantile(r, 0.998), k = 48, bw = (hi - lo) / k, bins = new Array(k).fill(0);
    for (const x of r) { const i = Math.floor((x - lo) / bw); if (i >= 0 && i < k) bins[i]++; }
    const mx = Math.max(...bins), m = M.mean(r), sd = M.sd(r), X = (v) => L + ((v - lo) / (hi - lo)) * (W - L - 10), Y = (c) => H - B - (c / mx) * (H - B - 12), norm = (x) => (r.length * bw * Math.exp(-((x - m) ** 2) / (2 * sd * sd))) / (sd * Math.sqrt(2 * Math.PI));
    const bars = bins.map((c, i) => { const x0 = lo + i * bw; return `<rect x="${X(x0) + 0.5}" y="${Y(c)}" width="${Math.max(1, X(x0 + bw) - X(x0) - 1)}" height="${H - B - Y(c)}" fill="${x0 + bw <= -s.var95 ? "#f6465d" : "#4da3ff"}" opacity=".75"><title>${pct(x0, 2)} to ${pct(x0 + bw, 2)}: ${c} days</title></rect>`; }).join("");
    let d = ""; for (let i = 0; i <= 120; i++) { const x = lo + ((hi - lo) * i) / 120; d += (i ? "L" : "M") + X(x).toFixed(1) + "," + Math.max(4, Y(norm(x))).toFixed(1); }
    const vl = (v, c, t) => `<line x1="${X(v)}" x2="${X(v)}" y1="8" y2="${H - B}" stroke="${c}" stroke-dasharray="4 3"/><text x="${X(v) + 4}" y="18" class="ql-ax" style="fill:${c}">${t}</text>`;
    const sk = M.mean(r.map((x) => ((x - m) / sd) ** 3)), ku = M.mean(r.map((x) => ((x - m) / sd) ** 4)) - 3;
    return `<svg viewBox="0 0 ${W} ${H}" class="ql-svg">${bars}<path d="${d}" fill="none" stroke="#e2e8f0" stroke-width="1.4" opacity=".8"/>${vl(-s.var95, "#fb923c", "VaR 95%")}${vl(-s.es95, "#f6465d", "ES")}${[lo, 0, hi].map((v) => `<text x="${X(v)}" y="${H - 8}" text-anchor="middle" class="ql-ax">${pct(v, 1)}</text>`).join("")}</svg>
      <div class="ql-tiles sm">${tile("Skew", num(sk))}${tile("Excess kurtosis", num(ku), "", ku > 1 ? "down" : "")}${tile("Worst day", pct(Math.min(...r), 2), "", "down")}${tile("Best day", pct(Math.max(...r), 2), "", "up")}</div>`;
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
    const n = b.have.length; if (n < 2) { setSt("cor", "UNAVAILABLE", "Needs at least two holdings"); $("qb-cor").innerHTML = `<div class="fx-empty">Needs two or more holdings.</div>`; return "na"; }
    const dv = M.diversification(b.w, b.C), avgS = (K) => { const p = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) p.push(K[i][j]); return M.mean(p); };
    const avgRoll = b.R[0].map((_, e) => { if (e + 1 < 63) return null; const K = M.corrMatrix(b.R.map((r) => r.slice(e - 62, e + 1))); return avgS(K); });
    let worst = [0, 1, -2]; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (b.Cor[i][j] > worst[2]) worst = [i, j, b.Cor[i][j]];
    b.corr = { avg: avgS(b.Cor), dv, top: worst, groups: M.cluster(b.Cor, 0.5).clusters.filter((g) => g.length > 1).map((g) => g.map((i) => b.have[i]).join(" · ")) };
    $("qb-cor").innerHTML = `<div class="ql-ctl">${segH("qlCw", [["63", "3M"], ["252", "1Y"], ["all", "3Y"]], "all")}</div>
      <div class="ql-two"><div id="qlHeat" class="ql-heat"></div><div class="ql-side"><div class="ql-tiles sm" id="qlCorT"></div><h4>Average correlation · rolling 3M</h4>${lineSVG([{ v: avgRoll, c: "#a78bfa", name: "Avg ρ", fmt: (x) => num(x) }], { dates: b.dates, h: 120, fmtY: (v) => v.toFixed(1), zero: true })}<div id="qlPair"></div></div></div>`;
    const pair = (i, j) => { const rc = M.rollingCorr(b.R[i], b.R[j], 63); $("qlPair").innerHTML = `<h4>${b.have[i]} × ${b.have[j]} · rolling 3M</h4>${lineSVG([{ v: rc, c: "#4da3ff", name: "ρ", fmt: (x) => num(x) }], { dates: b.dates, h: 120, fmtY: (v) => v.toFixed(1), zero: true })}`; };
    const heat = (win) => { const K = win === "all" ? b.Cor : M.corrMatrix(b.R.map((r) => r.slice(-+win))), ord = M.cluster(K, 0.5).order, cs = Math.max(16, Math.min(40, 560 / n)), Wd = 74 + cs * n;
      const col = (r) => (r >= 0 ? `rgba(94,234,212,${(0.08 + r * 0.9).toFixed(2)})` : `rgba(251,146,60,${(0.08 - r * 0.9).toFixed(2)})`);
      const cells = ord.map((i, y) => ord.map((j, x) => `<rect x="${74 + x * cs}" y="${74 + y * cs}" width="${cs - 1.5}" height="${cs - 1.5}" rx="2" fill="${col(K[i][j])}" data-i="${i}" data-j="${j}" data-x="${x}" data-y="${y}" class="ql-cell"><title>${b.have[i]} × ${b.have[j]}  ρ ${K[i][j].toFixed(2)}</title></rect>${cs >= 28 ? `<text x="${74 + x * cs + cs / 2}" y="${74 + y * cs + cs / 2 + 3}" class="ql-cvt" style="fill:${Math.abs(K[i][j]) > 0.55 ? "#0b1117" : "#cbd5e1"}">${Math.abs(K[i][j]) < 0.05 ? "0" : K[i][j].toFixed(1)}</text>` : ""}`).join("")).join("");
      const lab = ord.map((i, k) => `<text x="68" y="${74 + k * cs + cs / 2 + 3}" text-anchor="end" class="ql-ax" data-r="${k}">${b.have[i]}</text><text transform="translate(${74 + k * cs + cs / 2},68) rotate(-55)" class="ql-ax" data-c="${k}">${b.have[i]}</text>`).join("");
      $("qlHeat").innerHTML = `<svg viewBox="0 0 ${Wd} ${Wd}" class="ql-svg" style="max-width:${Math.round(Wd * 1.2)}px"><rect id="qlHr" x="74" y="0" width="${cs * n}" height="${cs}" fill="none" stroke="#e2e8f0" stroke-width="1" opacity="0"/><rect id="qlHc" x="0" y="74" width="${cs}" height="${cs * n}" fill="none" stroke="#e2e8f0" stroke-width="1" opacity="0"/>${lab}${cells}</svg>`;
      const sv = $("qlHeat").querySelector("svg");
      sv.onmousemove = (e) => { const t = e.target.closest(".ql-cell"); const hr = $("qlHr"), hc = $("qlHc"); if (!t) { hr.setAttribute("opacity", 0); hc.setAttribute("opacity", 0); return; } hr.setAttribute("y", 74 + t.dataset.y * cs); hr.setAttribute("opacity", 0.6); hc.setAttribute("x", 74 + t.dataset.x * cs); hc.setAttribute("opacity", 0.6); };
      sv.onclick = (e) => { const t = e.target.closest(".ql-cell"); if (t && t.dataset.i !== t.dataset.j) pair(+t.dataset.i, +t.dataset.j); };
      $("qlCorT").innerHTML = `${tile("Avg ρ", num(avgS(K)))}${tile("Diversification", num(dv.ratio))}${tile("Effective N", num(dv.effectiveN, 1))}${tile("Top pair", `${b.have[worst[0]]}/${b.have[worst[1]]}`, "", "", "ρ " + num(worst[2]))}`; };
    segOn("qlCw", heat); heat("all"); pair(worst[0], worst[1]);
  }

  // ---------------------------------------------------------------- 5. factor exposure (ETF proxies, OLS)
  async function renderFx(b) {
    const need = ["SPY", "IWM", "IWD", "IWF", "MTUM", "QUAL", "USMV"].filter((s) => b.out[s]);
    const A = M.align({ ...Object.fromEntries(b.have.map((s) => [s, b.out[s]])), ...Object.fromEntries(need.map((s) => [s, b.out[s]])) });
    const N = Math.min(A.dates.length - 1, 756), R = {}; for (const s of [...new Set([...b.have, ...need])]) R[s] = M.returns(A.px[s]).slice(-N);
    const rfD = b.rf / M.DAYS, y = M.portReturns(b.have.map((s) => R[s]), b.w).map((x) => x - rfD), dif = (a, c) => R[a].map((x, i) => x - R[c][i]), F = [];
    if (R.SPY) F.push(["MKT", R.SPY.map((x) => x - rfD)]); if (R.IWM && R.SPY) F.push(["SIZE", dif("IWM", "SPY")]); if (R.IWD && R.IWF) F.push(["VALUE", dif("IWD", "IWF")]);
    if (R.MTUM && R.SPY) F.push(["MOM", dif("MTUM", "SPY")]); if (R.QUAL && R.SPY) F.push(["QUAL", dif("QUAL", "SPY")]); if (R.USMV && R.SPY) F.push(["LOWVOL", dif("USMV", "SPY")]);
    let use = F, fit = M.ols(y, use.map((f) => f[1]));
    while (!fit && use.length > 1) { use = use.slice(0, -1); fit = M.ols(y, use.map((f) => f[1])); } // drop factors until the regression is solvable
    if (!fit) throw new Error("Factor regression could not be solved with the available proxies.");
    const roll = use.map(() => []), rd = []; for (let e = 126; e <= y.length; e += 5) { const f = M.ols(y.slice(e - 126, e), use.map((x) => x[1].slice(e - 126, e))); roll.forEach((r, k) => r.push(f ? f.betas[k] : null)); rd.push(A.dates.slice(-N)[e - 1]); }
    b.fx = { fit, names: use.map((f) => f[0]) };
    const nm = (k) => FACTORS.find((f) => f[0] === k)[1], W = 520, rowH = 34, H = 30 + rowH * use.length, lo = Math.min(-0.5, ...fit.betas.map((v, i) => v - 1.96 * fit.se[i + 1])), hi = Math.max(1.2, ...fit.betas.map((v, i) => v + 1.96 * fit.se[i + 1])), X = (v) => 130 + ((v - lo) / (hi - lo)) * (W - 150);
    const rows = use.map(([k], i) => { const v = fit.betas[i], se = fit.se[i + 1], t = fit.t[i + 1], yy = 22 + i * rowH, sig = Math.abs(t) >= 2, c = PAL[i % PAL.length];
      return `<g><title>${nm(k)}  β ${num(v)}  95% CI ${num(v - 1.96 * se)} to ${num(v + 1.96 * se)}  t ${num(t, 1)}</title><text x="122" y="${yy + 4}" text-anchor="end" class="ql-ax" style="fill:#cbd5e1">${nm(k)}</text><line x1="${X(v - 1.96 * se)}" x2="${X(v + 1.96 * se)}" y1="${yy}" y2="${yy}" stroke="${c}" stroke-width="2" opacity=".6"/><rect x="${Math.min(X(0), X(v))}" y="${yy - 7}" width="${Math.abs(X(v) - X(0))}" height="14" rx="3" fill="${c}" opacity="${sig ? 0.55 : 0.18}"/><circle cx="${X(v)}" cy="${yy}" r="5" fill="${sig ? c : "#0b1016"}" stroke="${c}" stroke-width="2"/><text x="${W - 4}" y="${yy + 4}" text-anchor="end" class="ql-ax" style="fill:${sig ? "#e2e8f0" : "#64748b"}">${num(v)}${sig ? " ★" : ""}</text></g>`; }).join("");
    const axis = [lo, 0, 1, hi].filter((v, i, a) => a.indexOf(v) === i && v >= lo && v <= hi).map((v) => `<line x1="${X(v)}" x2="${X(v)}" y1="8" y2="${H - 10}" class="${v === 0 ? "ql-zero" : "ql-grid"}"/><text x="${X(v)}" y="${H}" text-anchor="middle" class="ql-ax">${num(v, 1)}</text>`).join("");
    $("qb-fx").innerHTML = `<div class="ql-tiles sm">${tile("R²", pct(fit.r2, 0), `<div class="ql-gbar"><i style="width:${(fit.r2 * 100).toFixed(0)}%"></i></div>`)}${tile("Alpha / yr", sgn(fit.alpha * M.DAYS, 1), "", cls(fit.alpha), "t " + num(fit.t[0], 1))}${tile("Days", String(fit.n))}${tile("Factors", String(use.length))}</div>
      <div class="ql-two"><div><svg viewBox="0 0 ${W} ${H + 6}" class="ql-svg">${axis}${rows}</svg>${legend([["#94a3b8", "β with 95% interval · ★ = |t| ≥ 2"]])}</div>
      <div>${lineSVG(roll.map((v, k) => ({ v, c: PAL[k % PAL.length], name: nm(use[k][0]), fmt: (x) => num(x) })), { dates: rd, h: 220, fmtY: (v) => v.toFixed(1), zero: true })}${legend(use.map((f, k) => [PAL[k % PAL.length], nm(f[0])]))}</div></div>
      ${note("OLS of daily excess portfolio returns on long–short ETF spreads: market (SPY − cash), size (IWM − SPY), value (IWD − IWF), momentum (MTUM − SPY), quality (QUAL − SPY), low volatility (USMV − SPY). Whiskers are ±1.96 standard errors; rolling lines use 126-day windows every 5 days. Spreads overlap, so loadings move when factors are added or dropped.")}`;
  }

  // ---------------------------------------------------------------- 7. optimization (interactive frontier)
  async function renderOpt(b) {
    const n = b.have.length; if (n < 2) { setSt("opt", "UNAVAILABLE", "Needs at least two holdings"); $("qb-opt").innerHTML = `<div class="fx-empty">Needs two or more holdings.</div>`; return "na"; }
    const histMu = b.R.map((r) => M.mean(r) * M.DAYS), capm = b.assets.map((a) => a.mu), mu = histMu.map((h, i) => 0.5 * h + 0.5 * capm[i]), BPS = 10;
    const cur = { w: b.w, ret: M.dot(b.w, mu), vol: Math.sqrt(M.pVar(b.w, b.Cann)) }; cur.sharpe = (cur.ret - b.rf) / cur.vol;
    const half = Math.floor(b.R[0].length / 2), segOpt = (a, z, hi) => { const R = b.R.map((r) => r.slice(a, z)), C = M.covMatrix(R).map((r) => r.map((x) => x * M.DAYS)), m = R.map((r, i) => 0.5 * M.mean(r) * M.DAYS + 0.5 * capm[i]); return M.optimize(m, C, { lo: 0, hi, rf: b.rf }); };
    const KEYS = [["minVar", "Min variance", "#5eead4"], ["maxSharpe", "Max Sharpe", "#facc15"], ["riskParity", "Risk parity", "#a78bfa"], ["equal", "Equal weight", "#94a3b8"]];
    const hi0 = Math.min(1, Math.max(0.25, 1.5 / n)), minCap = Math.ceil((100 / n) * 1.0001);
    $("qb-opt").innerHTML = `<div class="ql-ctl"><label class="ql-rng">Max weight <input type="range" id="qlCap" min="${minCap}" max="100" value="${Math.round(hi0 * 100)}"><b id="qlCapV">${Math.round(hi0 * 100)}%</b></label>${segH("qlPick", [["cur", "Current"], ...KEYS.map(([k, t]) => [k, t])], "maxSharpe")}</div>
      <div class="ql-two"><div id="qlFront"></div><div class="ql-side"><div class="ql-tiles sm" id="qlOptT"></div><h4>Weights</h4><div id="qlWbars"></div></div></div>${note(`Long-only, fully invested, each holding capped by the slider. Expected returns: 50% historical mean + 50% CAPM (rf + β × ${pct(ERP, 0)}). Covariance: sample daily × 252. Costs: ${BPS} bps per side. Stability = turnover between the same optimizer run on each half of the window (over 30% = fragile).`)}`;
    let state = { pick: "maxSharpe", hover: null };
    const run = () => { const hi = +$("qlCap").value / 100; $("qlCapV").textContent = Math.round(hi * 100) + "%"; let o, o1, o2; try { o = M.optimize(mu, b.Cann, { lo: 0, hi, rf: b.rf }); o1 = segOpt(0, half, hi); o2 = segOpt(half, b.R[0].length, hi); } catch (e) { $("qlFront").innerHTML = `<div class="fx-empty">${esc(e.message)}</div>`; return; }
      const stab = Object.fromEntries(KEYS.map(([k]) => [k, M.turnover(o1[k].w, o2[k].w)])); b.opt = { o, cur, hi, unstable: stab }; state.o = o; state.stab = stab; drawF(); side(); };
    const W = 560, H = 300, L = 52, B = 34;
    const drawF = () => { const o = state.o, fr = o.frontier, vs = [...fr.map((f) => f.vol), cur.vol, ...b.assets.map((a) => a.vol)], rs = [...fr.map((f) => f.ret), cur.ret, ...mu];
      const v0 = Math.min(...vs) * 0.85, v1 = Math.max(...vs) * 1.08, r0 = Math.min(...rs, b.rf) - 0.01, r1 = Math.max(...rs) * 1.12, X = (v) => L + ((v - v0) / (v1 - v0)) * (W - L - 14), Y = (r) => H - B - ((r - r0) / (r1 - r0)) * (H - B - 14);
      const ms = o.maxSharpe, cml = `<line x1="${X(0 > v0 ? 0 : v0)}" y1="${Y(b.rf + ms.sharpe * Math.max(0, v0))}" x2="${X(v1)}" y2="${Y(b.rf + ms.sharpe * v1)}" stroke="#facc15" stroke-dasharray="5 4" opacity=".45"/>`;
      const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const r = r0 + f * (r1 - r0), v = v0 + f * (v1 - v0); return `<line x1="${L}" x2="${W - 14}" y1="${Y(r)}" y2="${Y(r)}" class="ql-grid"/><text x="${L - 6}" y="${Y(r) + 3}" text-anchor="end" class="ql-ax">${pct(r, 0)}</text><text x="${X(v)}" y="${H - B + 16}" text-anchor="middle" class="ql-ax">${pct(v, 0)}</text>`; }).join("");
      const assets = b.assets.map((a, i) => `<circle cx="${X(a.vol)}" cy="${Y(mu[i])}" r="3" fill="#64748b"/><text x="${X(a.vol) + 5}" y="${Y(mu[i]) + 3}" class="ql-ax">${a.sym}</text>`).join("");
      const path = `<path d="M${fr.map((f) => `${X(f.vol)},${Y(f.ret)}`).join("L")}" fill="none" stroke="#4da3ff" stroke-width="2.4"/>`;
      const dots = fr.map((f, k) => `<circle cx="${X(f.vol)}" cy="${Y(f.ret)}" r="7" fill="transparent" data-f="${k}" class="ql-fp"/>`).join("");
      const P = KEYS.map(([k, t, c]) => `<circle cx="${X(o[k].vol)}" cy="${Y(o[k].ret)}" r="${state.pick === k ? 9 : 6.5}" fill="${c}" stroke="#05080c" stroke-width="2" data-k="${k}" class="ql-fp"><title>${t}</title></circle>`).join("") + `<circle cx="${X(cur.vol)}" cy="${Y(cur.ret)}" r="${state.pick === "cur" ? 10 : 7.5}" fill="none" stroke="#f472b6" stroke-width="2.5" data-k="cur" class="ql-fp"><title>Current</title></circle>`;
      const hv = state.hover != null ? `<circle cx="${X(fr[state.hover].vol)}" cy="${Y(fr[state.hover].ret)}" r="5" fill="#e2e8f0"/>` : "";
      $("qlFront").innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="ql-svg" id="qlFsv">${grid}${cml}${path}${assets}${dots}${P}${hv}<text x="${W - 14}" y="${H - 4}" text-anchor="end" class="ql-ax">volatility →</text><text x="${L}" y="10" class="ql-ax">expected return ↑</text></svg>${legend([["#4da3ff", "Efficient frontier"], ["#facc15", "Capital market line"], ...KEYS.map(([, t, c]) => [c, t]), ["#f472b6", "Current"]])}`;
      const sv = $("qlFsv"); sv.onmousemove = (e) => { const t = e.target.closest(".ql-fp"); const f = t && t.dataset.f != null ? +t.dataset.f : null; if (f !== state.hover) { state.hover = f; side(); } };
      sv.onclick = (e) => { const t = e.target.closest(".ql-fp"); if (t && t.dataset.k) { state.pick = t.dataset.k; $("qlPick").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === state.pick)); drawF(); side(); } }; };
    const side = () => { const o = state.o, p = state.hover != null ? o.frontier[state.hover] : state.pick === "cur" ? cur : o[state.pick], lab = state.hover != null ? "Frontier point" : state.pick === "cur" ? "Current" : KEYS.find((k) => k[0] === state.pick)[1], to = M.turnover(b.w, p.w), st = state.pick !== "cur" && state.hover == null ? state.stab[state.pick] : null;
      $("qlOptT").innerHTML = `${tile("Return", pct(p.ret))}${tile("Volatility", pct(p.vol))}${tile("Sharpe", num((p.ret - b.rf) / p.vol))}${tile("Turnover", pct(to), "", "", usd(M.tradeCost(b.w, p.w, b.value, BPS)) + " cost")}${st != null ? tile("Stability", st > 0.3 ? "fragile" : "stable", "", st > 0.3 ? "down" : "up", pct(st, 0) + " drift") : ""}`;
      const ord = [...b.have.keys()].sort((x, y) => b.w[y] - b.w[x]), bar = (w, t) => `<div class="ql-wb"><span>${t}</span><div>${ord.map((i) => (w[i] > 0.004 ? `<i style="width:${(w[i] * 100).toFixed(2)}%;background:${PAL[i % PAL.length]}" title="${b.have[i]} ${pct(w[i], 1)}"></i>` : "")).join("")}</div></div>`;
      $("qlWbars").innerHTML = bar(b.w, "Now") + bar(p.w, lab) + `<div class="ql-wkey">${ord.map((i) => `<span><i style="background:${PAL[i % PAL.length]}"></i>${b.have[i]} <b class="${p.w[i] - b.w[i] > 0.02 ? "up" : p.w[i] - b.w[i] < -0.02 ? "down" : ""}">${pct(p.w[i], 0)}</b></span>`).join("")}</div>`; };
    $("qlCap").oninput = run; segOn("qlPick", (v) => { state.pick = v; state.hover = null; drawF(); side(); }); run();
  }

  // ---------------------------------------------------------------- 8. market regime
  async function renderReg(b) {
    const A = M.align({ SPY: b.out.SPY, ...(b.out.HYG && b.out.IEF ? { HYG: b.out.HYG, IEF: b.out.IEF } : {}) }), px = A.px.SPY, credit = A.px.HYG ? A.px.HYG.map((v, i) => v / A.px.IEF[i]) : null;
    const tl = M.regimes(px, credit, 5); if (!tl.length) throw new Error("Not enough SPY history for regime detection.");
    const now = tl[tl.length - 1], C = { "Risk-on trend": "#0fbf7d", "Choppy / late-cycle": "#facc15", Correction: "#fb923c", "Risk-off / high volatility": "#f6465d" };
    b.regime = now; const k = $("qlRegK"); if (k) k.innerHTML = `<span style="color:${C[now.label]}">${esc(now.label)}</span>`;
    const t0 = tl[0].i, P = px.slice(t0), D = A.dates.slice(t0), s200 = P.map((_, i) => M.sma(px, 200, i + t0)), s50 = P.map((_, i) => M.sma(px, 50, i + t0));
    const bg = tl.map((r, j) => ({ i0: r.i - t0, i1: (j < tl.length - 1 ? tl[j + 1].i : px.length - 1) - t0, c: C[r.label], o: 0.13 }));
    const ind = now.ind, series = tl.map((r) => r.ind), g = (v, lo, hi, good) => { const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo))); return `<div class="ql-gbar"><i style="width:${(t * 100).toFixed(0)}%;background:${good ? "#0fbf7d" : "#f6465d"}"></i></div>`; };
    $("qb-reg").innerHTML = `<div class="ql-regnow" style="border-color:${C[now.label]}"><b style="color:${C[now.label]}">${esc(now.label)}</b><span>${day(A.dates[now.i])} · score ${num(now.score, 1)}</span></div>
      ${lineSVG([{ v: P, c: "#e2e8f0", name: "S&P 500", sw: 1.5, fmt: (x) => "$" + x.toFixed(2) }, { v: s50, c: "#4da3ff", name: "50-day", sw: 1.1, fmt: (x) => "$" + x.toFixed(2) }, { v: s200, c: "#facc15", name: "200-day", sw: 1.1, fmt: (x) => "$" + x.toFixed(2) }], { dates: D, h: 260, fmtY: (v) => "$" + v.toFixed(0), log: true, bg })}
      ${legend(Object.entries(C).map(([n, c]) => [c, n]))}
      <div class="ql-tiles">${tile("Trend", ind.aboveTrend ? "above 200d" : "below 200d", g(P[P.length - 1] / s200[s200.length - 1] - 1, -0.1, 0.1, ind.aboveTrend), ind.aboveTrend ? "up" : "down")}${tile("50 / 200", ind.goldenCross ? "golden" : "death", "", ind.goldenCross ? "up" : "down")}
        ${tile("Realized vol", pct(ind.vol), spark(series.map((x) => x.vol), "#facc15"), ind.volHigh ? "down" : "", "median " + pct(ind.volMedian))}${tile("Drawdown", pct(ind.drawdown), spark(series.map((x) => x.drawdown), "#f6465d"), ind.drawdown < -0.1 ? "down" : "")}
        ${tile("Credit 3M", ind.credit == null ? "—" : sgn(ind.credit), spark(series.map((x) => x.credit), "#a78bfa"), ind.credit == null ? "" : cls(ind.credit), "HYG / IEF")}</div>
      ${note("Weekly rules: Risk-off if drawdown < −20% or volatility > 1.4× its 1-year median while below the 200-day; Correction if below the 200-day or down > 10%; Risk-on if above the 200-day, 50 > 200 and volatility normal; otherwise Choppy.")}`;
  }

  // ---------------------------------------------------------------- 3. strategy tournament + replay
  async function renderBt(b) {
    const U = b.have, n = U.length, top = Math.max(1, Math.min(3, Math.floor(n / 2))), from = b.dates[0], to = b.dates[b.dates.length - 1];
    const series = Object.fromEntries([...new Set([...U, "SPY"])].map((s) => [s, { t: b.out[s].t, close: b.out[s].close, adj: b.out[s].adj }]));
    const wts = Object.fromEntries(U.map((s, i) => [s, b.w[i] * 100]));
    const base = { universe: U, benchmark: "SPY", from, to, initial: Math.round(b.value), costs: { commissionBps: 0, spreadBps: 5, slippageBps: 2 }, limits: { maxWeight: 1, minCash: 0 }, rf: b.rf, series };
    const entries = [["rebalance", { freq: "quarterly" }, wts, "Rebalanced"], ["buyhold", {}, wts, "Buy & hold"], ["riskparity", {}, null, "Risk parity"]];
    if (n >= 2) entries.push(["momentum", { top }, null, `Momentum ${top}`], ["multifactor", { top }, null, `Multi-factor ${top}`]); entries.push(["smacross", {}, null, "Trend 50/200"]);
    const rows = [];
    for (const [k, params, weights, label] of entries) { await tick(); try { const r = Q.run({ ...base, strategy: k, params, weights }); const cut = Math.floor(r.dates.length * 0.7);
      rows.push({ k, label, r, cut, ins: Q.metrics(r.dates.slice(0, cut + 1), r.equity.slice(0, cut + 1), r.bench.slice(0, cut + 1), b.rf), oos: Q.metrics(r.dates.slice(cut), r.equity.slice(cut), r.bench.slice(cut), b.rf) }); } catch (e) { rows.push({ k, label, err: e.message }); } }
    const ok = rows.filter((x) => !x.err); if (!ok.length) throw new Error("No strategy could be simulated on this portfolio.");
    const rank = (key) => [...ok].sort((a, c) => (c[key].sharpe ?? -9) - (a[key].sharpe ?? -9)).forEach((x, i) => (x[key + "Rank"] = i + 1)); rank("ins"); rank("oos");
    ok.sort((a, c) => (c.oos.sharpe ?? -9) - (a.oos.sharpe ?? -9)); const win = ok[0]; ok.forEach((x, i) => (x.c = PAL[i % PAL.length]));
    let tuned = null; if (n >= 2) { await tick(); try { tuned = Q.optimize({ ...base, strategy: "momentum", params: {} }); } catch {} }
    b.bt = { rows: ok, win, tuned };
    const cut = win.cut, D = win.r.dates, bgO = [{ i0: cut, i1: D.length - 1, c: "#4da3ff", o: 0.07 }];
    const sh = ok.flatMap((x) => [x.ins.sharpe, x.oos.sharpe]).filter(isFinite), lo = Math.min(-0.5, ...sh), hi = Math.max(1, ...sh), W = 520, rowH = 30, H = 34 + rowH * ok.length, X = (v) => 120 + ((v - lo) / (hi - lo)) * (W - 160);
    const dumb = ok.map((x, i) => { const y = 26 + i * rowH, fade = x.insRank <= 2 && x.oosRank - x.insRank >= 2;
      return `<g><title>${x.label}: in-sample Sharpe ${num(x.ins.sharpe)} (#${x.insRank}) → out-of-sample ${num(x.oos.sharpe)} (#${x.oosRank}) · CAGR ${sgn(x.r.metrics.cagr)} · max DD ${pct(x.r.metrics.maxDrawdown)}</title><text x="112" y="${y + 4}" text-anchor="end" class="ql-ax" style="fill:${x.c}">${esc(x.label)}</text><line x1="${X(x.ins.sharpe)}" x2="${X(x.oos.sharpe)}" y1="${y}" y2="${y}" stroke="${fade ? "#f6465d" : "#64748b"}" stroke-width="2"/><circle cx="${X(x.ins.sharpe)}" cy="${y}" r="4.5" fill="#0b1016" stroke="#94a3b8" stroke-width="1.5"/><circle cx="${X(x.oos.sharpe)}" cy="${y}" r="5.5" fill="${x.c}"/><text x="${W - 4}" y="${y + 4}" text-anchor="end" class="ql-ax" style="fill:${fade ? "#f6465d" : "#cbd5e1"}">${num(x.oos.sharpe)}${fade ? " ↓" : ""}</text></g>`; }).join("");
    const ax = [lo, 0, hi].map((v) => `<line x1="${X(v)}" x2="${X(v)}" y1="10" y2="${H - 14}" class="${v === 0 ? "ql-zero" : "ql-grid"}"/><text x="${X(v)}" y="${H - 2}" text-anchor="middle" class="ql-ax">${num(v, 1)}</text>`).join("");
    $("qb-bt").innerHTML = `<div class="ql-ctl">${segH("qlBtV", [["all", "All strategies"], ["dd", "Drawdowns"], ["rp", "Replay"]], "all")}<span class="ql-chipline">5 bps spread · 2 bps slip · next-day fills · shaded = out-of-sample</span></div>
      <div class="ql-two"><div id="qlBtC"></div><div class="ql-side"><h4>Sharpe · in-sample ○ → out-of-sample ●</h4><svg viewBox="0 0 ${W} ${H}" class="ql-svg">${ax}${dumb}</svg>
      ${tuned ? `<div class="ql-tiles sm">${tile("Tuned IS", num(tuned.inSample.metrics.sharpe))}${tile("Tuned OOS", num(tuned.outOfSample.metrics.sharpe), "", tuned.outOfSample.metrics.sharpe < tuned.inSample.metrics.sharpe * 0.5 ? "down" : "up", tuned.outOfSample.metrics.sharpe < tuned.inSample.metrics.sharpe * 0.5 ? "overfit" : "held")}</div>` : ""}</div></div>`;
    const draw = (v) => { const el = $("qlBtC");
      if (v === "all") el.innerHTML = lineSVG([...ok.map((x) => ({ v: x.r.equity, c: x.c, name: x.label, sw: x === win ? 2.2 : 1.2, op: x === win ? 1 : 0.75, fmt: (y) => usd(y) })), { v: win.r.bench, c: "#94a3b8", name: "S&P 500", dash: true, fmt: (y) => usd(y) }], { dates: D, h: 280, fmtY: (y) => big(y), bg: bgO }) + legend([...ok.map((x) => [x.c, x.label]), ["#94a3b8", "S&P 500"]]);
      else if (v === "dd") el.innerHTML = lineSVG(ok.map((x) => ({ v: M.drawdownSeries(x.r.equity), c: x.c, name: x.label, sw: x === win ? 2 : 1.1 })), { dates: D, h: 280, zero: true, bg: bgO }) + legend(ok.map((x) => [x.c, x.label]));
      else { el.innerHTML = `<div class="ql-replay"><button class="btn ghost" id="qlPlay">▶</button><input type="range" id="qlScrub" min="10" max="${win.r.dates.length - 1}" value="${win.r.dates.length - 1}"><span id="qlRDate" class="tw-muted"></span></div><div id="qlReplay"></div><div id="qlRTrades" class="ql-rtr"></div>`; replay(win.r); } };
    segOn("qlBtV", draw); draw("all");
  }
  function replay(r) {
    const tIdx = new Map(r.dates.map((t, i) => [t, i])), marks = r.trades.map((t) => ({ i: tIdx.get(t.t), side: t.side, t })).filter((m) => m.i != null);
    const draw = (k) => { const cut = (a) => a.map((v, i) => (i <= k ? v : null)); const mk = marks.filter((m) => m.i <= k).slice(-80).map((m) => ({ i: m.i, v: r.equity[m.i], side: m.side, title: `${day(m.t.t)} ${m.side} ${m.t.sym} ${usd(m.t.value)}` }));
      $("qlReplay").innerHTML = lineSVG([{ v: cut(r.bench), c: "#94a3b8", sw: 1.2, dash: true, name: "S&P 500", fmt: (y) => usd(y) }, { v: cut(r.equity), c: "#5eead4", sw: 2, name: "Strategy", fmt: (y) => usd(y) }], { dates: r.dates, h: 250, fmtY: (v) => big(v), markers: mk });
      $("qlRDate").textContent = `${day(r.dates[k])} · ${usd(r.equity[k])} vs ${usd(r.bench[k])}`;
      $("qlRTrades").innerHTML = marks.filter((m) => m.i <= k).slice(-4).reverse().map((m) => `<span class="${m.side === "BUY" ? "up" : "down"}">${day(m.t.t)} ${m.side} ${esc(m.t.sym)} ${usd(m.t.value)}</span>`).join(""); };
    const sc = $("qlScrub"); sc.oninput = () => draw(+sc.value); draw(+sc.value);
    $("qlPlay").onclick = () => { if (QL.play) { clearInterval(QL.play); QL.play = null; $("qlPlay").textContent = "▶"; return; } let k = +sc.value >= r.dates.length - 1 ? 10 : +sc.value; $("qlPlay").textContent = "❚❚";
      QL.play = setInterval(() => { k = Math.min(r.dates.length - 1, k + Math.max(1, Math.round(r.dates.length / 240))); sc.value = k; draw(k); if (k >= r.dates.length - 1 || S.tab !== "quant" || !$("qlPlay")) { clearInterval(QL.play); QL.play = null; if ($("qlPlay")) $("qlPlay").textContent = "▶"; } }, 40); };
  }

  // ---------------------------------------------------------------- 4. Monte Carlo (Web Worker, seeded, interactive)
  function renderMC(b) {
    const beta = isFinite(b.stats.beta) ? b.stats.beta : 1, MODELS = { capm: b.rf + beta * ERP, hist: Math.max(-0.2, Math.min(0.4, b.stats.cagr)), cash: b.rf };
    const seed = +day(b.lastT).replace(/-/g, ""); QL.mc = QL.mc || { years: 10, contrib: 0, paths: 5000, model: "capm" };
    $("qb-mc").innerHTML = `<div class="ql-ctl"><label class="ql-rng">Horizon <input type="range" id="qlMy" min="1" max="30" value="${QL.mc.years}"><b id="qlMyV">${QL.mc.years}y</b></label>
      <label class="ql-rng">Monthly add <input type="range" id="qlMc" min="0" max="5000" step="100" value="${QL.mc.contrib}"><b id="qlMcV">${usd(QL.mc.contrib)}</b></label>
      ${segH("qlMm", [["capm", "CAPM " + pct(MODELS.capm, 1)], ["hist", "Historical " + pct(MODELS.hist, 1)], ["cash", "Cash " + pct(MODELS.cash, 1)]], QL.mc.model)}${segH("qlMp", [["1000", "1k"], ["5000", "5k"], ["20000", "20k"]], String(QL.mc.paths))}</div>
      <div class="ql-bar"><i id="qlMcBar" style="width:0%"></i></div><div id="qlMcOut"></div>`;
    let tm = null; const go = () => { clearTimeout(tm); tm = setTimeout(() => sim(b, { start: b.value, mu: MODELS[QL.mc.model], sigma: b.stats.vol, years: QL.mc.years, paths: QL.mc.paths, contrib: QL.mc.contrib, seed, keep: 60 }), 120); };
    $("qlMy").oninput = (e) => { QL.mc.years = +e.target.value; $("qlMyV").textContent = QL.mc.years + "y"; go(); };
    $("qlMc").oninput = (e) => { QL.mc.contrib = +e.target.value; $("qlMcV").textContent = usd(QL.mc.contrib); go(); };
    segOn("qlMm", (v) => { QL.mc.model = v; go(); }); segOn("qlMp", (v) => { QL.mc.paths = +v; go(); });
    return sim(b, { start: b.value, mu: MODELS[QL.mc.model], sigma: b.stats.vol, years: QL.mc.years, paths: QL.mc.paths, contrib: QL.mc.contrib, seed, keep: 60 });
  }
  function sim(b, spec) {
    const mcK = $("qlMcK"); if (mcK) mcK.textContent = "running"; if (QL.mcW) { try { QL.mcW.terminate(); } catch {} QL.mcW = null; }
    return new Promise((resolve, reject) => {
      const done = (res, ms) => { QL.ms.mcWorker = ms; b.mc = { res, spec }; if (mcK) mcK.textContent = `${res.paths.toLocaleString()} paths`; const bar = $("qlMcBar"); if (bar) bar.style.width = "100%"; showMC(b, res, spec, ms); resolve(); };
      let w; try { w = new Worker("/qmc-worker.js"); QL.mcW = w; } catch { const t = performance.now(); return done(M.monteCarlo(spec), performance.now() - t); }
      const to = setTimeout(() => { w.terminate(); const t = performance.now(); done(M.monteCarlo(spec), performance.now() - t); }, 20000);
      w.onmessage = (e) => { const d = e.data; if (d.progress != null) { const bar = $("qlMcBar"); if (bar) bar.style.width = (d.progress * 100).toFixed(0) + "%"; } else if (d.done) { clearTimeout(to); w.terminate(); QL.mcW = null; done(d.result, d.ms); } else if (d.error) { clearTimeout(to); w.terminate(); reject(new Error(d.error)); } };
      w.onerror = () => { clearTimeout(to); w.terminate(); const t = performance.now(); done(M.monteCarlo(spec), performance.now() - t); };
      w.postMessage(spec);
    });
  }
  function showMC(b, r, spec, ms) {
    const m = r.months, inv = Array.from({ length: m + 1 }, (_, i) => spec.start + spec.contrib * i), maxH = Math.max(...r.hist.map((h) => h.n)), dbl = r.sample.length ? null : null; void dbl;
    const pDouble = r.hist.reduce((a, h) => a + (h.from >= spec.start * 2 ? h.n : 0), 0) / r.paths;
    const hist = `<svg viewBox="0 0 300 140" class="ql-svg">${r.hist.map((h, i) => `<rect x="${i * 10}" y="${122 - (h.n / maxH) * 112}" width="9" height="${(h.n / maxH) * 112}" fill="${h.to < r.invested ? "#f6465d" : h.from >= spec.start * 2 ? "#34d399" : "#5eead4"}" opacity=".85"><title>${usd(h.from)}–${usd(h.to)} · ${h.n} paths</title></rect>`).join("")}<text x="0" y="137" class="ql-ax">${big(r.hist[0].from)}</text><text x="300" y="137" text-anchor="end" class="ql-ax">${big(r.hist[r.hist.length - 1].to)}</text></svg>`;
    $("qlMcOut").innerHTML = `<div class="ql-two"><div id="qlFan"></div><div class="ql-side"><div class="ql-tiles sm">${tile("Median", big(r.terminal.p50))}${tile("5th pct", big(r.terminal.p5), "", "down")}${tile("95th pct", big(r.terminal.p95), "", "up")}${tile("P(loss)", pct(r.probBelowInvested), "", r.probBelowInvested > 0.2 ? "down" : "", "vs money put in")}${tile("P(2×)", pct(pDouble), "", "up")}${tile("Compute", ms.toFixed(0) + " ms", "", "", "worker · seed " + spec.seed)}</div><h4>Ending value distribution</h4>${hist}</div></div>
      ${note(`Geometric Brownian motion, monthly steps: V ← (V + contribution) · exp((μ − σ²/2)/12 + σ/√12 · Z). μ = the chosen model, σ = realized portfolio volatility ${pct(spec.sigma)}. Seeded (${spec.seed}) so results are reproducible. Real returns have fatter tails, so the 5th percentile is optimistic.`)}`;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; let k = reduce ? m + 1 : 2;
    const xl = (i) => `month ${i} · year ${(i / 12).toFixed(1)}`;
    const frame = () => { const el = $("qlFan"); if (!el) return; const cut = (a) => a.slice(0, k).concat(new Array(m + 1 - k).fill(null));
      const ser = r.sample.slice(0, 40).map((p) => ({ v: cut(p), c: "rgba(148,163,184,.4)", sw: 0.5, op: 0.5 }));
      ser.push({ v: cut(inv), c: "#f472b6", sw: 1.2, dash: true, name: "Money in", fmt: big }, { v: cut(r.bands.p95), c: "#34d399", sw: 0.8, name: "95th", fmt: big }, { v: cut(r.bands.p50), c: "#5eead4", sw: 2.2, name: "Median", fmt: big }, { v: cut(r.bands.p5), c: "#f6465d", sw: 0.8, name: "5th", fmt: big });
      el.innerHTML = lineSVG(ser, { h: 270, fmtY: (v) => big(v), log: true, band: [{ lo: r.bands.p5.slice(0, k), hi: r.bands.p95.slice(0, k), c: "rgba(94,234,212,.10)" }, { lo: r.bands.p25.slice(0, k), hi: r.bands.p75.slice(0, k), c: "rgba(94,234,212,.22)" }] });
      const sv = el.querySelector("svg[data-qc]"); if (sv) QC.g[sv.dataset.qc].xLabel = xl;
      if (k <= m) { k = Math.min(m + 1, k + Math.max(3, Math.round(m / 40))); requestAnimationFrame(frame); } };
    frame();
  }

  // ---------------------------------------------------------------- 9. signal board (rule-based, no paid AI)
  async function renderAI(b) {
    const s = b.stats, A = [...b.assets].sort((x, y) => y.rc - x.rc), top = A[0], sig = [];
    const add = (k, v, state, why, viz) => sig.push({ k, v, state, why, viz });
    add("Risk-adjusted return", num(s.sharpe), s.sharpe > 1 ? "good" : s.sharpe > 0.4 ? "ok" : "bad", `Sharpe ${num(s.sharpe)} over ${num(s.years, 1)} years; above 1 is strong, below 0.4 is weak.`, spark((b.cc && b.cc.rs) || [], "#4da3ff"));
    add("Drawdown", pct(-s.mdd), s.mdd < 0.15 ? "good" : s.mdd < 0.3 ? "ok" : "bad", `Worst peak-to-trough fall in the window.`, spark((b.cc && b.cc.dd) || [], "#f6465d"));
    if (isFinite(s.beta)) add("Market sensitivity", "β " + num(s.beta), s.beta < 0.9 ? "good" : s.beta < 1.2 ? "ok" : "bad", s.beta > 1.15 ? `Amplifies market moves: a 10% S&P drop ≈ ${pct(s.beta * 0.1, 0)} here.` : s.beta < 0.8 ? "More defensive than the market." : "Moves roughly with the market.");
    add("Concentration", `${top.sym} ${pct(top.rc, 0)}`, top.rc < 0.25 ? "good" : top.rc < 0.4 ? "ok" : "bad", `${top.sym} is ${pct(top.w)} of capital but ${pct(top.rc)} of risk.`, `<div class="ql-gbar"><i style="width:${(top.rc * 100).toFixed(0)}%;background:#facc15"></i></div>`);
    if (b.an) add("Effective bets", `${num(b.an.enb, 1)} / ${b.have.length}`, b.an.enb / b.have.length > 0.6 ? "good" : b.an.enb / b.have.length > 0.35 ? "ok" : "bad", "Meucci's effective number of independent bets.", `<div class="ql-gbar"><i style="width:${Math.min(100, (b.an.enb / b.have.length) * 100).toFixed(0)}%"></i></div>`);
    if (b.corr) add("Correlation", "ρ̄ " + num(b.corr.avg), b.corr.avg < 0.3 ? "good" : b.corr.avg < 0.6 ? "ok" : "bad", b.corr.top[2] > 0.8 ? `${b.have[b.corr.top[0]]} and ${b.have[b.corr.top[1]]} move almost as one (ρ ${num(b.corr.top[2])}).` : "Average pairwise correlation of daily returns.");
    if (b.fx) { const f = b.fx, t = f.names.map((n, i) => [n, f.fit.betas[i], f.fit.t[i + 1]]).filter((x) => x[0] !== "MKT" && Math.abs(x[2]) >= 2 && Math.abs(x[1]) >= 0.1).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))[0];
      add("Style tilt", t ? `${FACTORS.find((x) => x[0] === t[0])[1]} ${num(t[1])}` : "none", t ? "ok" : "good", t ? `Statistically significant tilt (t ${num(t[2], 1)}); R² ${pct(f.fit.r2, 0)}.` : `No significant style tilt beyond the market; R² ${pct(f.fit.r2, 0)}.`); }
    if (b.opt) { const o = b.opt, g = o.o.maxSharpe.sharpe - o.cur.sharpe, u = o.unstable.maxSharpe; add("Optimizer edge", (g >= 0 ? "+" : "") + num(g), u > 0.3 ? "bad" : g > 0.2 ? "ok" : "good", u > 0.3 ? `Max-Sharpe weights drift ${pct(u, 0)} between halves: the edge is mostly noise.` : g > 0.2 ? "A stable, meaningful Sharpe improvement exists under the stated assumptions." : "Current weights are already near-efficient."); }
    if (b.regime) add("Regime", b.regime.label.split(" ")[0], b.regime.label.startsWith("Risk-on") ? "good" : b.regime.label.startsWith("Choppy") ? "ok" : "bad", `S&P ${b.regime.ind.aboveTrend ? "above" : "below"} its 200-day, ${pct(b.regime.ind.drawdown)} from its high.`);
    if (b.bt) { const w = b.bt.win, fade = b.bt.rows.filter((x) => x.insRank <= 2 && x.oosRank - x.insRank >= 2); add("Best strategy OOS", w.label, fade.length ? "ok" : "good", `${w.label}: out-of-sample Sharpe ${num(w.oos.sharpe)}.${fade.length ? " " + fade.map((x) => x.label).join(", ") + " faded out-of-sample." : ""}`); }
    if (b.mc) { const r = b.mc.res; add("10Y loss odds", pct(r.probBelowInvested), r.probBelowInvested < 0.1 ? "good" : r.probBelowInvested < 0.25 ? "ok" : "bad", `Monte Carlo: chance of ending below the money put in; median ${big(r.terminal.p50)}.`); }
    if (b.ap && b.ap.positions) { const mine = new Set(b.have), ov = (b.ap.positions || []).map((p) => p.symbol || p.sym).filter((x) => mine.has(x)); add("AI Trader overlap", `${ov.length}/${(b.ap.positions || []).length}`, "ok", ov.length ? `Paper account also holds ${ov.join(", ")}.` : "No overlap with the paper account."); }
    const checks = selfTest(b); b.checks = checks; const C = { good: "#0fbf7d", ok: "#facc15", bad: "#f6465d" };
    $("qb-ai").innerHTML = `<div class="ql-sig">${sig.map((x) => `<div class="ql-sg ${x.state}" title="${esc(x.why)}"><i style="background:${C[x.state]}"></i><span>${esc(x.k)}</span><b>${esc(x.v)}</b>${x.viz || ""}<em>${esc(x.why)}</em></div>`).join("")}</div>
      <div class="ql-eng">rule-based engine · no paid AI · <span class="${checks.every((c) => c[1]) ? "up" : "down"}">✓ ${checks.filter((c) => c[1]).length}/${checks.length} self-checks</span>${b.missing.length ? ` · excluded ${esc(b.missing.join(", "))}` : ""}</div>`;
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

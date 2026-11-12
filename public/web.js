/* THE WEB — one huge web with the live market summary in its center, written by the Spider.
   Everything shown comes from the server's real research (/api/web/*): the spider's trips into the Terminal's tabs follow
   the backend job log, and the summary text is the server's live summary built from collected data. */
(function () {
  if (typeof VIEW !== "undefined" && VIEW) { const b = document.getElementById("spBtn"); if (b) b.hidden = true; return; } // the public demo doesn't get THE WEB (it holds the owner's research)
  const W = { open: false, sumPoll: null, gPoll: null, viewing: null, poll: null, navPoll: null, st: null, stAt: 0, offline: false, brief: null, histOpen: false, hist: null,
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

  // ================================================================ THE WEB page: one huge web, the market summary in its center
  // The spider climbs to the Terminal section where the server is really researching (taken from the backend job log),
  // reads what that job found, climbs back down the web, picks up the data points the summary sentence is built from,
  // then crawls into the center and writes that sentence. The text is the server's live summary: it is rebuilt from new
  // research while the market is open and frozen as the day's final summary after the close.
  const PAGE = { data: ["markets", "Overview"], news: ["markets", "News"], nyse: ["markets", "Heatmap"], analysis: ["markets", "Analysis"], macro: ["markets", "Macro"],
    research: ["research", "Stock research"], fin: ["research", "Financials"], filings: ["research", "10-K crawler"], portfolio: ["portfolio", "My portfolio"], aitrade: ["ailab", "AI vs S&P 500"] };
  const GNAME = { markets: "Markets", research: "Research", portfolio: "Portfolio", ailab: "AI Lab", quant: "Quant", web: "THE WEB" };
  const SPOKES = 16, RINGS = 6, GSPOKES = { markets: [13, 14, 15, 0, 1, 2], research: [3, 4, 5, 6], portfolio: [7, 8, 9], ailab: [10, 11, 12] };
  function pageOfJob(j) {
    const g = String(j.go || "").replace(/^#/, "").split("/")[0]; if (PAGE[g]) return g; if (/^q:/.test(j.go || "")) return "research";
    const a = j.area || ""; return /Heatmap|Overview/.test(a) ? "nyse" : /News/.test(a) ? "news" : /Macro/.test(a) ? "macro" : /earnings/i.test(a) ? "data" : /crawler|Financials|Stock research/.test(a) ? "filings" : /Portfolio/.test(a) ? "portfolio" : /AI Lab/.test(a) ? "aitrade" : null;
  }
  const groupOfNode = (n) => n.type === "portfolio" || n.type === "holding" || (n.type === "discovery" && n.cat === "portfolio") ? "portfolio" : n.type === "trader" || n.cat === "ai_trader" ? "ailab"
    : n.type === "watch" || n.type === "company" || ["filing", "insider", "fundamentals", "company", "earnings"].includes(n.cat) ? "research" : "markets";

  const G = { w: 0, h: 0, hub: 0.55, cx: 0, cy: 0, rx: 0, ry: 0, slot: {}, nodes: [] }; // geometry in container pixels
  const SPD = { el: null, cap: null, thread: null, x: 0, y: 0, ang: 0, at: { s: 0, k: RINGS }, q: [], cur: null, raf: 0, last: 0, visits: [], seenJobs: new Set(), started: false };
  const SUM = { target: [], shown: [], pending: new Set(), meta: null, typing: false };

  function shell() {
    const root = $("tab-web"); if (root.dataset.ready) return; root.dataset.ready = "1";
    root.innerHTML = `<div class="twb" id="twb"><svg class="twb-web" id="twbSvg"></svg><div class="twb-tools" id="twbTools"></div><div class="twb-legend" id="twbLegend"></div><div class="twb-tip" id="twbTip" hidden></div><div class="twb-hub" id="twbHub"><div class="twb-k" id="twbK">THE WEB · MARKET SUMMARY</div><div class="twb-lines" id="twbLines"><p class="twb-wait">The spider is gathering the first summary…</p></div><div class="twb-foot" id="twbFoot"></div></div><div class="twb-pop" id="twbPop" hidden></div></div>
      <div class="tw-modal" id="twModal" hidden><div class="tw-mbox" id="twMbox"></div></div>`;
    $("twModal").onclick = (e) => { if (e.target.id === "twModal" || e.target.closest(".x")) closeModal(); };
    $("twb").addEventListener("click", (e) => { const st = e.target.closest(".twb-s"); if (st) { if (window.TWX && TWX.intel) return TWX.intel(st.dataset.sym); if (typeof openQuote === "function") return openQuote(st.dataset.sym); } const n = e.target.closest(".twb-n"); if (n) return showPop(n.dataset.id); if (!e.target.closest(".twb-pop")) $("twbPop").hidden = true; });
    $("twbPop").addEventListener("click", (e) => { const g = e.target.closest("[data-twgo]"); if (g) return go(g.dataset.twgo); const d = e.target.closest("[data-twd]"); if (d) { e.preventDefault(); openDisc(d.dataset.twd); } });
    addEventListener("resize", () => { if (W.open) { layoutWeb(); drawWeb(); } });
  }
  function layoutWeb() {
    const box = $("twb"), r = box.getBoundingClientRect(); G.w = r.width; G.h = r.height; G.cx = G.w / 2; G.cy = G.h / 2; G.rx = G.w / 2 - 12; G.ry = G.h / 2 - 12;
    G.narrow = G.w < 760; G.hub = G.narrow ? 0.74 : 0.6;
    const hub = $("twbHub"), cw = G.narrow ? G.w * 0.92 : 2 * G.rx * G.hub * 0.84, ch = G.narrow ? G.h * 0.7 : 2 * G.ry * G.hub * 0.9;
    Object.assign(hub.style, { width: cw + "px", height: ch + "px", left: G.cx - cw / 2 + "px", top: G.cy - ch / 2 + "px" });
  }
  const ang = (s) => -Math.PI / 2 + (s / SPOKES) * Math.PI * 2 + ROT.a; // ROT.a spins the web inside its own outline
  const frac = (k) => G.hub + (1 - G.hub) * (k / RINGS);
  const J = (s, k) => ({ x: G.cx + Math.cos(ang(s)) * G.rx * frac(k), y: G.cy + Math.sin(ang(s)) * G.ry * frac(k) }); // junction, container px
  const sag = (a, b) => ({ x: G.cx + ((a.x + b.x) / 2 - G.cx) * 0.95, y: G.cy + ((a.y + b.y) / 2 - G.cy) * 0.95 });
  function placeNodes() {
    G.slot = {}; G.nodes = [];
    const g = W.graph; if (!g) return;
    const rank = (n) => (n.type === "portfolio" ? 0 : n.type === "holding" || n.type === "trader" ? 1 : n.type === "sector" || n.type === "macro" ? 2 : n.type === "discovery" ? 6 - (n.importance || 40) / 25 : 4);
    const list = g.nodes.filter((n) => n.type !== "industry").slice().sort((a, b) => rank(a) - rank(b));
    for (const n of list) {
      const spokes = GSPOKES[groupOfNode(n)]; let done = false;
      for (let k = 1; k <= RINGS && !done; k++) for (const s of spokes) { const key = s + ":" + k; if (!G.slot[key]) { G.slot[key] = n; n.s = s; n.k = k; G.nodes.push(n); done = true; break; } }
    }
  }
  // ---------------------------------------------------------------- the web is filled with stocks; your portfolio lights up
  // Every free spot on the web (each junction, the middle of each ring segment, and the points between rings) holds a stock:
  // your holdings first (spread around the web, glowing), then the largest S&P 500 companies, then the rest of the index.
  const MEGA = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "BRK.B", "LLY", "JPM", "V", "UNH", "XOM", "MA", "COST", "WMT", "HD", "PG", "JNJ", "NFLX", "ORCL", "ABBV", "BAC", "CRM", "AMD", "KO", "CVX", "MRK", "PEP", "ADBE", "TMO", "CSCO", "ACN", "MCD", "LIN", "WFC", "ABT", "IBM", "GE", "PM", "QCOM", "CAT", "TXN", "INTU", "DIS", "VZ", "AMGN", "NOW", "GS", "ISRG", "PFE", "SPGI", "UBER", "MS", "RTX", "AXP", "BKNG", "T", "LOW", "UNP", "NEE", "PLTR", "BLK", "SCHW", "C", "DE", "LMT", "SBUX", "MU", "PANW", "ANET", "KLAC", "LRCX", "AMAT", "ADI", "BA", "NKE", "GILD", "CMCSA", "INTC", "MDT", "CB", "SO", "DUK", "MO", "PYPL", "CRWD", "SHW", "ICE"];
  function myStocks() { const out = new Set(); for (const p of S.pfs || []) for (const h of p.holdings || []) if (h && h.symbol && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(h.symbol.toUpperCase())) out.add(h.symbol.toUpperCase()); return out; }
  function webSlots() { const out = [], used = new Set(G.nodes.map((n) => n.s + ":" + n.k));
    for (let k = 1; k <= RINGS; k++) for (let s = 0; s < SPOKES; s++) {
      if (!used.has(s + ":" + k)) out.push({ ...J(s, k), s, k, t: "j" });
      const a = J(s, k), b = J((s + 1) % SPOKES, k), c = sag(a, b); out.push({ x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y, s, k, t: "m" }); // mid-segment
      if (k < RINGS) out.push({ ...J(s, k + 0.5), s, k: k + 0.5, t: "j" }); // between rings, on the spoke
    }
    return out; }
  // ---------------------------------------------------------------- drawing: silk, dew, a market heat map, a camera
  // The web is a live map of the S&P 500 (one /api/sp500 call: price, move, market cap): bigger companies are bigger
  // dots, colour is today's move (or sector), your holdings glow gold. Wheel zooms around the cursor, drag pans,
  // double-click resets; hovering a stock threads it to its sector and shows a card; the legend isolates a sector.
  const CAM = { k: 1, x: 0, y: 0 }, VIEWS = { mode: "move", sector: "", mine: false };
  // the web spins slowly inside its outline (≈ one turn every 9 minutes): strands and every dot slide around the oval,
  // labels stay upright, nothing is clipped. Each frame only moves existing elements (no redraw, no filters).
  const ROT = { a: 0, on: (() => { try { return localStorage.getItem("tw_rot") !== "0"; } catch { return true; } })(), last: 0, lastMove: 0, raf: 0 };
  const camT = () => `translate(${CAM.x.toFixed(1)},${CAM.y.toFixed(1)}) scale(${CAM.k.toFixed(3)})`;
  const slotXY = (sl) => { if (sl.t === "m") { const a2 = J(sl.s, sl.k), b2 = J(sl.s + 1, sl.k), c2 = sag(a2, b2); return { x: 0.25 * a2.x + 0.5 * c2.x + 0.25 * b2.x, y: 0.25 * a2.y + 0.5 * c2.y + 0.25 * b2.y }; } return J(sl.s, sl.k); };
  const ringD = (k) => { let d = ""; for (let sp = 0; sp < SPOKES; sp++) { const a2 = J(sp, k), b2 = J((sp + 1) % SPOKES, k), c2 = sag(a2, b2); d += `${sp ? "" : `M${a2.x.toFixed(1)} ${a2.y.toFixed(1)}`} Q${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${b2.x.toFixed(1)} ${b2.y.toFixed(1)}`; } return d; };
  const spokeD = (sp) => { const a2 = J(sp, 0), b2 = J(sp, RINGS + 0.35); return `M${a2.x.toFixed(1)} ${a2.y.toFixed(1)}L${b2.x.toFixed(1)} ${b2.y.toFixed(1)}`; };
  function reposition() {
    const svg = $("twbSvg"); if (!svg) return;
    svg.querySelectorAll("[data-spoke]").forEach((e) => e.setAttribute("d", spokeD(+e.dataset.spoke)));
    svg.querySelectorAll("[data-ring]").forEach((e) => e.setAttribute("d", ringD(+e.dataset.ring)));
    svg.querySelectorAll("[data-sl]").forEach((e) => { const sl = W.slotList[+e.dataset.sl]; if (!sl) return; const p = slotXY(sl); e.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`); });
    (W.kg || []).forEach((e, i) => { const el = document.getElementById("kg" + i); if (el) el.setAttribute("d", kgD(e)); });
    svg.querySelectorAll("[data-js]").forEach((e) => { const p = J(+e.dataset.js, +e.dataset.jk); if (e.tagName === "circle") { e.setAttribute("cx", p.x.toFixed(1)); e.setAttribute("cy", p.y.toFixed(1)); } else e.setAttribute("transform", `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`); });
  }
  function rotLoop(t) {
    ROT.raf = requestAnimationFrame(rotLoop); const dt = ROT.last ? Math.min(0.1, (t - ROT.last) / 1000) : 0; ROT.last = t;
    const svg = $("twbSvg"); if (!svg || !W.open || document.hidden) return;
    const paused = !ROT.on || CAM.k > 1.01 || svg.classList.contains("hov") || svg.classList.contains("grab") || (typeof SCAN !== "undefined" && SCAN.on) || matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (paused || !dt) return;
    const sp = ROT.speed == null ? 1 : ROT.speed; if (!sp) return; ROT.a = (ROT.a + dt * 0.0116 * sp) % (Math.PI * 2);
    if (t - ROT.lastMove < 33) return; ROT.lastMove = t; reposition(); // ~30 fps is plenty for a slow spin
    // a spider resting on the web rides along with its junction
    const c = SPD.cur; if (SPD.el && SPD.at && (!c || (c.wait != null && (c.node || c.rest)))) { const q = scr(J(SPD.at.s, SPD.at.k)); SPD.x += (q.x - SPD.x) * 0.5; SPD.y += (q.y - SPD.y) * 0.5; }
  }
  const SC = { "Information Technology": "#4da3ff", "Health Care": "#34d399", Financials: "#facc15", "Consumer Discretionary": "#f472b6", "Communication Services": "#a78bfa", Industrials: "#94a3b8", "Consumer Staples": "#fb923c", Energy: "#f87171", Utilities: "#67e8f9", "Real Estate": "#c4b5fd", Materials: "#fde68a" };
  const SHORT = { "Information Technology": "Tech", "Health Care": "Health", Financials: "Financials", "Consumer Discretionary": "Discretionary", "Communication Services": "Comms", Industrials: "Industrials", "Consumer Staples": "Staples", Energy: "Energy", Utilities: "Utilities", "Real Estate": "Real estate", Materials: "Materials" };
  function moveCol(p) { if (p == null || !isFinite(p)) return "#475569"; const t = Math.max(-1, Math.min(1, p / 3)); return t >= 0 ? `rgb(${Math.round(40 - 25 * t)},${Math.round(120 + 100 * t)},${Math.round(110 + 15 * t)})` : `rgb(${Math.round(150 + 100 * -t)},${Math.round(70 - 20 * -t)},${Math.round(90 - 10 * -t)})`; }
  async function loadSnap(force) { if (!force && W.snap && Date.now() - W.snapAt < 60e3) return; try { W.snap = await api("/api/sp500"); W.snapAt = Date.now(); if (W.open) { drawWeb(); toolbar(); } } catch {} }
  function drawWeb() {
    const svg = $("twbSvg"); if (!svg || !G.w) return;
    svg.setAttribute("viewBox", `0 0 ${G.w} ${G.h}`);
    let st = "", dew = "";
    for (let sp = 0; sp < SPOKES; sp++) { const d = spokeD(sp); st += `<path class="spoke" data-spoke="${sp}" d="${d}"/><path class="shim" data-spoke="${sp}" d="${d}" style="animation-delay:${(-sp * 0.37).toFixed(2)}s"/>`; }
    for (let k = 0; k <= RINGS; k++) { const d = ringD(k); for (let sp = 0; sp < SPOKES; sp++) if (k && (sp + k) % 3 === 0) { const a = J(sp, k); dew += `<circle data-js="${sp}" data-jk="${k}" cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="1.6"/>`; }
      st += `<path class="ring${k === 0 ? " hubring" : ""}" data-ring="${k}" d="${d}"/>${k ? `<path class="shim r" data-ring="${k}" d="${d}" style="animation-delay:${(-k * 0.9).toFixed(2)}s"/>` : ""}`; }
    const mineSet = myStocks(); let nodes = "";
    for (const n of G.nodes) { const p = J(n.s, n.k), c = ncol(n), lab = ["portfolio", "holding", "sector", "macro", "trader"].includes(n.type), mine = mineSet.has(String(n.label || "").toUpperCase());
      if (mine) nodes += `<g class="twb-lit" data-js="${n.s}" data-jk="${n.k}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" pointer-events="none"><circle class="glow" r="16" style="fill:#f5c518"/><circle r="9" fill="none" stroke="#f5c518" stroke-width="1.4" opacity=".85"/></g>`;
      nodes += `<g class="twb-n${lab || mine ? " lab" : ""}${mine ? " mine" : ""}" data-js="${n.s}" data-jk="${n.k}" data-id="${esc(n.id)}" data-sym="${esc(String(n.label || "").toUpperCase())}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" tabindex="0" role="button" aria-label="${esc(n.type + ": " + n.label)}"><circle class="hit" r="12"/><circle class="halo" r="9" fill="${c}"/><circle class="core" r="${n.type === "portfolio" ? 4.5 : 3}" fill="${c}"/><text x="7" y="3">${esc(n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label)}</text><title>${esc(n.label + (n.sub ? " — " + n.sub : ""))}</title></g>`; }
    svg.innerHTML = `<defs><radialGradient id="twBg" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#0b1a22"/><stop offset=".55" stop-color="#070d13"/><stop offset="1" stop-color="#030508"/></radialGradient>
      <linearGradient id="twSilk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e0fbff" stop-opacity="0"/><stop offset=".5" stop-color="#e0fbff" stop-opacity=".9"/><stop offset="1" stop-color="#e0fbff" stop-opacity="0"/></linearGradient>
      <filter id="twGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <rect class="twb-bgr" x="0" y="0" width="${G.w}" height="${G.h}" fill="url(#twBg)"/>
      <g id="twbCam" transform="${camT()}"><g class="twb-strands">${st}</g><g class="twb-dew">${dew}</g><g id="twbKG"></g><g id="twbLinks"></g>${fillWeb()}${nodes}</g>`;
    svg.classList.toggle("z2", CAM.k >= 1.8); svg.classList.toggle("z3", CAM.k >= 3); applyFilters(); buildKG();
  }
  // ---- knowledge graph: real relationships drawn as glowing links, with information pulses travelling along them
  // sector ↔ its largest companies on the web · holding ↔ its sector · portfolio ↔ holdings · economic indicator ↔ the
  // sectors it moves · research finding ↔ its company
  const MACRO_SECTORS = { "interest rates": ["Financials", "Real Estate", "Utilities"], "yield curve": ["Financials", "Real Estate"], bonds: ["Utilities", "Real Estate"], "crude oil": ["Energy", "Industrials"], "us dollar": ["Materials", "Industrials"], inflation: ["Consumer Staples", "Consumer Discretionary"], "labor market": ["Industrials", "Consumer Discretionary"], "economic growth": ["Industrials", "Financials", "Consumer Discretionary"] };
  const SEC_ALIAS = { "information technology": "Information Technology", technology: "Information Technology", "health care": "Health Care", financials: "Financials", "consumer discretionary": "Consumer Discretionary", "communication services": "Communication Services", industrials: "Industrials", "consumer staples": "Consumer Staples", energy: "Energy", utilities: "Utilities", "real estate": "Real Estate", materials: "Materials" };
  function buildKG() {
    const g = $("twbKG"); if (!g) return; W.kg = [];
    const nodeP = (n) => () => J(n.s, n.k), stockP = (sym) => () => placeXY(sym), secNode = {}, mine = myStocks(), q = (W.snap && W.snap.quotes) || {};
    for (const n of G.nodes) { const sec = SEC_ALIAS[String(n.label || "").toLowerCase()]; if (sec) secNode[sec] = n; }
    const capOf = (x) => (q[x] && q[x][3]) || 0, add = (a, b, c, kind, ids, why) => W.kg.push({ a, b, c, kind, ids: ids.map((x) => { const m = /^[a-z]+:([A-Z][A-Z0-9.\-]*)$/.exec(String(x)); return m && W.place && W.place[m[1]] != null ? m[1] : String(x); }), why });
    for (const [sec, n] of Object.entries(secNode)) Object.keys(W.place || {}).filter((x) => W.sec && W.sec[x] === sec).sort((x, y) => capOf(y) - capOf(x)).slice(0, 5).forEach((x) => add(nodeP(n), stockP(x), SC[sec] || "#4da3ff", "sector", [n.id, x]));
    const pf = G.nodes.find((n) => n.type === "portfolio");
    for (const n of G.nodes) { const lab = String(n.label || ""), up = lab.toUpperCase();
      if (mine.has(up) || n.type === "holding") { const sec = W.sec && W.sec[up]; if (sec && secNode[sec]) add(nodeP(n), nodeP(secNode[sec]), "#a78bfa", "holding", [n.id, secNode[sec].id]); if (pf && pf !== n) add(nodeP(pf), nodeP(n), "#f5c518", "portfolio", [pf.id, n.id]); }
      const ms = MACRO_SECTORS[lab.toLowerCase()]; if (ms) for (const sec of ms) if (secNode[sec]) add(nodeP(n), nodeP(secNode[sec]), "#22d3ee", "macro", [n.id, secNode[sec].id]);
      if (n.type === "discovery" && n.sym && W.place && W.place[n.sym] != null) add(nodeP(n), stockP(n.sym), "#5eead4", "finding", [n.id, n.sym]); }
    // the server's own relationship graph (holdings, correlations, sector sensitivity, earnings events, findings), with its reasons
    const byId = new Map(G.nodes.map((n) => [n.id, n])), posOf = (id) => { const n = byId.get(id); if (n) return nodeP(n); const m = /^[a-z]+:([A-Z][A-Z0-9.\-]*)$/.exec(id); return m && W.place && W.place[m[1]] != null ? stockP(m[1]) : null; };
    const EC = { holds: "#f5c518", correlation: "#a78bfa", sensitivity: "#22d3ee", event: "#fb923c", trader: "#ff6fae", industry: "#7c6bb8", sector: "#4da3ff" };
    for (const e of ((W.graph && W.graph.edges) || []).slice(0, 140)) { const a = posOf(e.a || e.from || e.source), b = posOf(e.b || e.to || e.target); if (a && b) add(a, b, EC[e.type] || "#5eead4", e.type || "link", [e.a || e.from || e.source, e.b || e.to || e.target], e.why); }
    for (const x of mine) if (W.place && W.place[x] != null) { const sec = W.sec && W.sec[x]; if (sec && secNode[sec]) add(stockP(x), nodeP(secNode[sec]), "#f5c518", "holding", [x, secNode[sec].id]); }
    const low = document.documentElement.classList.contains("tw-low");
    g.innerHTML = W.kg.map((e, i) => `<path id="kg${i}" class="kg ${esc(e.kind)}" data-a="${esc(e.ids[0])}" data-b="${esc(e.ids[1])}" stroke="${e.c}" d="${kgD(e)}">${e.why ? `<title>${esc(e.why)}</title>` : ""}</path>${low ? "" : `<circle class="kgp" r="1.9" fill="${e.c}"><animateMotion dur="${(3.2 + (i % 7) * 0.7).toFixed(1)}s" begin="-${((i * 0.37) % 4).toFixed(2)}s" repeatCount="indefinite"><mpath href="#kg${i}"/></animateMotion></circle>`}`).join("");
  }
  function kgD(e) { const a = e.a(), b = e.b(); if (!a || !b) return "M0 0"; const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, cx = mx + (G.cx - mx) * 0.28, cy = my + (G.cy - my) * 0.28; return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`; }
  // search: tickers, company names, sectors, indicators and research nodes; matches and their links light up
  function searchWeb(text) {
    const svg = $("twbSvg"), t = String(text || "").trim().toLowerCase(); svg.querySelectorAll(".q").forEach((e) => e.classList.remove("q")); svg.classList.remove("kgq"); if (!t) return 0;
    const hits = new Set();
    for (const sym of Object.keys(W.place || {})) if (sym.toLowerCase() === t || (t.length >= 3 && String((W.nm && W.nm[sym]) || "").toLowerCase().includes(t)) || (t.length >= 3 && String((W.sec && W.sec[sym]) || "").toLowerCase().includes(t))) hits.add(sym);
    for (const n of G.nodes) if (String(n.label || "").toLowerCase().includes(t)) hits.add(n.id);
    if (!hits.size) return 0; svg.classList.add("kgq");
    for (const h of hits) svg.querySelectorAll(`[data-sym="${CSS.escape(h)}"],[data-id="${CSS.escape(h)}"]`).forEach((e) => e.classList.add("q"));
    svg.querySelectorAll(".kg").forEach((p) => { if (hits.has(p.dataset.a) || hits.has(p.dataset.b)) { p.classList.add("q"); for (const id of [p.dataset.a, p.dataset.b]) svg.querySelectorAll(`[data-sym="${CSS.escape(id)}"],[data-id="${CSS.escape(id)}"]`).forEach((e) => e.classList.add("q")); } });
    const first = [...hits][0]; if (W.place[first] != null && hits.size === 1) focusSym(first);
    return hits.size;
  }
  function fillWeb() {
    if (!W.sp500) { if (!W.sp500Loading) { W.sp500Loading = true; fetch("/sp500.json").then((r) => r.json()).then((j) => { W.sp500 = j.rows || []; if (W.open) drawWeb(); }).catch(() => { W.sp500 = []; }); } }
    if (!W.snap && !W.snapLoading) { W.snapLoading = true; loadSnap(true).finally(() => (W.snapLoading = false)); }
    const slots = webSlots(); W.slotList = slots; if (!slots.length) return "";
    const mine = myStocks(), shown = new Set(G.nodes.map((n) => String(n.label || "").toUpperCase())), rows = W.sp500 || [], q = (W.snap && W.snap.quotes) || {};
    W.sec = Object.fromEntries(rows.map((r) => [r[0], r[2]])); W.nm = Object.fromEntries(rows.map((r) => [r[0], r[1]]));
    const capOf = (x) => (q[x] && q[x][3]) || 0, byCap = rows.map((r) => r[0]).sort((a2, b2) => capOf(b2) - capOf(a2));
    const all = [...new Set([...(W.snap ? byCap : [...MEGA, ...byCap])])].filter((x) => !mine.has(x) && !shown.has(x));
    const order = [], taken = new Set(), mineL = [...mine].filter((x) => !shown.has(x)), stride = Math.max(1, Math.floor(slots.length / Math.max(1, mineL.length)));
    mineL.forEach((sym, i) => { let j = (i * stride + 7) % slots.length; while (taken.has(j)) j = (j + 1) % slots.length; taken.add(j); order[j] = { sym, mine: true }; });
    // biggest companies take the inner rings (closest to the summary), the rest spread outward
    const free = slots.map((p, j) => j).filter((j) => !order[j]).sort((a2, b2) => slots[a2].k - slots[b2].k); free.forEach((j, i) => { if (i < all.length) order[j] = { sym: all[i], mine: false }; });
    const maxCap = Math.max(1, ...all.slice(0, 5).map(capOf)), movers = new Set(Object.entries(q).filter(([x, v]) => v[2] != null && Math.abs(v[2]) >= 3).map(([x]) => x)), big = new Set(all.slice(0, 24));
    W.place = {}; let out = "", lit = "";
    slots.forEach((p, j) => { const o = order[j]; if (!o) return; const sym = o.sym, v = q[sym], pc = v ? v[2] : null, sec = W.sec[sym] || "", d = esc(sym); W.place[sym] = j;
      if (o.mine) { lit += `<g class="twb-s mine" data-sl="${j}" data-sym="${d}" data-sec="${esc(sec)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})"><circle class="glow" r="16"/><circle class="ring" r="7.5"/><circle class="dot" r="4"/><text y="-11">${d}</text>${pc != null ? `<text class="pc ${pc >= 0 ? "u" : "d"}" y="17">${pc >= 0 ? "+" : ""}${pc.toFixed(1)}%</text>` : ""}</g>`; return; }
      const r = 1.5 + 4.2 * Math.sqrt(Math.min(1, capOf(sym) / maxCap)), lab = movers.has(sym) || big.has(sym) ? "on" : "z";
      out += `<g class="twb-s" data-sl="${j}" data-sym="${d}" data-sec="${esc(sec)}" data-pc="${pc == null ? "" : pc.toFixed(2)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})"><circle class="hit" r="${(r + 5).toFixed(1)}"/><circle class="dt" r="${r.toFixed(1)}" data-c-move="${moveCol(pc)}" data-c-sec="${SC[sec] || "#64748b"}" fill="${VIEWS.mode === "move" && W.snap ? moveCol(pc) : SC[sec] || "#64748b"}"/><text class="${lab}" y="${(-r - 2.5).toFixed(1)}">${d}</text></g>`; });
    return `<g class="twb-fill">${out}</g><g class="twb-lit">${lit}</g>`;
  }
  // ---- camera
  function setCam(k, x, y, anim) { k = Math.max(1, Math.min(6, k)); const mx = G.w * (1 - k), my = G.h * (1 - k); x = Math.min(0, Math.max(mx, x)); y = Math.min(0, Math.max(my, y));
    const cam = $("twbCam"), svg = $("twbSvg"); if (!cam) return; if (anim) { const k0 = CAM.k, x0 = CAM.x, y0 = CAM.y, t0 = performance.now(), D = 380; const f = (t) => { const u = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - u, 3); CAM.k = k0 + (k - k0) * e; CAM.x = x0 + (x - x0) * e; CAM.y = y0 + (y - y0) * e; cam.setAttribute("transform", camT()); svg.classList.toggle("z2", CAM.k >= 1.8); svg.classList.toggle("z3", CAM.k >= 3); svg.style.setProperty("--zs", Math.pow(CAM.k, -0.82).toFixed(3)); if (u < 1) requestAnimationFrame(f); else camUi(); }; requestAnimationFrame(f); return; }
    CAM.k = k; CAM.x = x; CAM.y = y; cam.setAttribute("transform", camT()); svg.classList.toggle("z2", k >= 1.8); svg.classList.toggle("z3", k >= 3); camUi(); }
  function camUi() { const r = $("twbReset"); if (r) r.hidden = CAM.k <= 1.01; const zoomed = CAM.k > 1.01;
    const svg = $("twbSvg"); if (svg) svg.style.setProperty("--zs", Math.pow(CAM.k, -0.82).toFixed(3)); // labels stay readable instead of ballooning
    const hub = $("twbHub"); if (hub) { hub.style.opacity = zoomed ? "0.08" : ""; hub.style.pointerEvents = zoomed ? "none" : ""; } if (SPD.el) for (const e of [SPD.el, SPD.cap, SPD.fx]) e.style.opacity = zoomed ? "0" : ""; } // the spider waits while you explore
  const placeXY = (sym) => (W.place[sym] != null && W.slotList[W.place[sym]] ? slotXY(W.slotList[W.place[sym]]) : null);
  function focusSym(sym) { const p = placeXY(sym) || (G.nodes.find((n) => String(n.label).toUpperCase() === sym) && J(G.nodes.find((n) => String(n.label).toUpperCase() === sym).s, G.nodes.find((n) => String(n.label).toUpperCase() === sym).k)); if (!p) return false;
    const k = 3.2; setCam(k, G.w / 2 - p.x * k, G.h / 2 - p.y * k, true); setTimeout(() => { const el = $("twbSvg").querySelector(`[data-sym="${CSS.escape(sym)}"]`); if (el) { el.classList.remove("ping"); void el.getBBox(); el.classList.add("ping"); } }, 400); return true; }
  // ---- filters, legend, toolbar
  function applyFilters() { const svg = $("twbSvg"); if (!svg) return; const mine = myStocks();
    svg.classList.toggle("iso", !!(VIEWS.sector || VIEWS.mine));
    svg.querySelectorAll(".twb-s").forEach((g) => { const on = (!VIEWS.sector || g.dataset.sec === VIEWS.sector) && (!VIEWS.mine || mine.has(g.dataset.sym)); g.classList.toggle("in", on); });
    svg.querySelectorAll(".twb-s .dt").forEach((c) => c.setAttribute("fill", VIEWS.mode === "move" && W.snap ? c.dataset.cMove : c.dataset.cSec)); }
  function toolbar() {
    const tb = $("twbTools"); if (!tb) return; const q = (W.snap && W.snap.quotes) || {}, vals = Object.values(q).map((v) => v[2]).filter((x) => x != null), up = vals.filter((x) => x > 0).length, dn = vals.filter((x) => x < 0).length;
    const secs = Object.keys(SC), secMove = (sc) => { const xs = Object.entries(q).filter(([x]) => W.sec && W.sec[x] === sc).map(([, v]) => [v[2], v[3] || 1]).filter(([p]) => p != null); const w = xs.reduce((a2, [, c]) => a2 + c, 0); return w ? xs.reduce((a2, [p, c]) => a2 + p * c, 0) / w : null; };
    tb.innerHTML = `<div class="twb-seg" id="twbMode"><button data-v="move" class="${VIEWS.mode === "move" ? "on" : ""}">Today's move</button><button data-v="sector" class="${VIEWS.mode === "sector" ? "on" : ""}">Sector</button></div>
      <button class="twb-chip ${VIEWS.mine ? "on" : ""}" id="twbMine">★ My holdings</button><input id="twbFind" class="twb-find" placeholder="Find ticker…" maxlength="8" autocomplete="off" spellcheck="false">
      ${vals.length ? `<span class="twb-breadth"><b class="u">▲ ${up}</b><b class="d">▼ ${dn}</b><i><em style="width:${((up / Math.max(1, up + dn)) * 100).toFixed(1)}%"></em></i></span>` : ""}<button class="twb-chip ${ROT.on ? "on rot" : ""}" id="twbRot" title="Slowly rotate the web">⟳ Rotate</button><button class="twb-chip" id="twbReset" ${CAM.k > 1.01 ? "" : "hidden"}>⤢ Reset view</button>`;
    const lg = $("twbLegend"); lg.innerHTML = secs.map((sc) => { const m = secMove(sc); return `<button data-sec="${esc(sc)}" class="${VIEWS.sector === sc ? "on" : ""}"><i style="background:${SC[sc]}"></i>${SHORT[sc]}${m != null ? `<b class="${m >= 0 ? "u" : "d"}">${m >= 0 ? "+" : ""}${m.toFixed(1)}%</b>` : ""}</button>`; }).join("") + (VIEWS.mode === "move" ? `<span class="twb-ramp"><em>−3%</em><i></i><em>+3%</em></span>` : "");
    $("twbMode").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; VIEWS.mode = v; toolbar(); applyFilters(); };
    $("twbMine").onclick = () => { VIEWS.mine = !VIEWS.mine; toolbar(); applyFilters(); };
    $("twbReset").onclick = () => setCam(1, 0, 0, true);
    $("twbRot").onclick = () => { ROT.on = !ROT.on; try { localStorage.setItem("tw_rot", ROT.on ? "1" : "0"); } catch {} toolbar(); };
    $("twbFind").placeholder = "Search ticker, company, sector…";
    $("twbFind").onkeydown = (e) => { if (e.key === "Escape") { e.target.value = ""; searchWeb(""); return; } if (e.key !== "Enter") return; const v = e.target.value.trim(); if (!v) { searchWeb(""); return; } if (!searchWeb(v) && !focusSym(v.toUpperCase())) { e.target.classList.add("bad"); setTimeout(() => e.target.classList.remove("bad"), 900); } };
    lg.onclick = (e) => { const b = e.target.closest("[data-sec]"); if (!b) return; VIEWS.sector = VIEWS.sector === b.dataset.sec ? "" : b.dataset.sec; toolbar(); applyFilters(); };
  }
  // ---- hover: a card + threads to the stock's sector
  function hoverStock(g, ev) {
    const svg = $("twbSvg"), links = $("twbLinks"), tip = $("twbTip"); if (!g) { svg.classList.remove("hov"); svg.querySelectorAll(".twb-s.rel,.twb-s.cur").forEach((x) => x.classList.remove("rel", "cur")); if (links) links.innerHTML = ""; tip.hidden = true; return; }
    const sym = g.dataset.sym, sec = (W.sec && W.sec[sym]) || g.dataset.sec || "", q = (W.snap && W.snap.quotes && W.snap.quotes[sym]) || null, p0 = placeXY(sym) || (() => { const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute("transform") || ""); return m ? { x: +m[1], y: +m[2] } : null; })();
    if (svg.dataset.hovSym !== sym) { svg.dataset.hovSym = sym; svg.classList.add("hov"); svg.querySelectorAll(".twb-s.rel,.twb-s.cur").forEach((x) => x.classList.remove("rel", "cur")); g.classList.add("cur");
      const peers = Object.keys(W.place).filter((x) => x !== sym && W.sec && W.sec[x] === sec).map((x) => [x, placeXY(x)]).sort((a2, b2) => (((W.snap && W.snap.quotes[b2[0]]) || [])[3] || 0) - (((W.snap && W.snap.quotes[a2[0]]) || [])[3] || 0)).slice(0, 14);
      const c = SC[sec] || "#5eead4"; links.innerHTML = p0 ? peers.map(([x, p], i) => { svg.querySelector(`.twb-s[data-sym="${CSS.escape(x)}"]`)?.classList.add("rel"); const mx = (p0.x + p.x) / 2, my = (p0.y + p.y) / 2, cx = mx + (G.cx - mx) * 0.35, cy = my + (G.cy - my) * 0.35; return `<path d="M${p0.x.toFixed(1)} ${p0.y.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}" stroke="${c}" style="animation-delay:${i * 18}ms"/>`; }).join("") : ""; }
    const r = $("twb").getBoundingClientRect(), mine = myStocks().has(sym), pc = q ? q[2] : null;
    tip.hidden = false; tip.innerHTML = `<div class="tt-h"><b>${esc(sym)}</b>${mine ? '<span class="tt-mine">★ yours</span>' : ""}</div><div class="tt-n">${esc((W.nm && W.nm[sym]) || "")}</div><div class="tt-s"><i style="background:${SC[sec] || "#64748b"}"></i>${esc(sec || "—")}</div>
      ${q ? `<div class="tt-p"><b>$${(+q[0]).toFixed(2)}</b><span class="${pc >= 0 ? "u" : "d"}">${pc >= 0 ? "+" : ""}${pc != null ? pc.toFixed(2) : "—"}%</span></div>${q[3] ? `<div class="tt-c">Market cap ${q[3] >= 1e12 ? "$" + (q[3] / 1e12).toFixed(2) + "T" : "$" + (q[3] / 1e9).toFixed(0) + "B"}</div>` : ""}` : `<div class="tt-c">No quote yet</div>`}<div class="tt-f">click to open · threads = same sector</div>`;
    const tx = Math.min(r.width - 210, ev.clientX - r.left + 16), ty = Math.min(r.height - 150, ev.clientY - r.top + 14); tip.style.transform = `translate(${tx}px,${ty}px)`;
  }
  function wireWeb() {
    const box = $("twb"), svg = $("twbSvg"); if (box.dataset.wired) return; box.dataset.wired = "1";
    let drag = null;
    box.addEventListener("wheel", (e) => { if (e.target.closest(".twb-hub,.twb-pop,.twb-tools,.twb-legend")) return; e.preventDefault(); const r = box.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, k2 = Math.max(1, Math.min(6, CAM.k * (e.deltaY > 0 ? 0.88 : 1.14)));
      setCam(k2, mx - (mx - CAM.x) * (k2 / CAM.k), my - (my - CAM.y) * (k2 / CAM.k)); }, { passive: false });
    svg.addEventListener("pointerdown", (e) => { if (e.target.closest(".twb-s,.twb-n")) return; drag = { x: e.clientX, y: e.clientY, cx: CAM.x, cy: CAM.y, moved: false }; });
    addEventListener("pointermove", (e) => { if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; svg.classList.add("grab"); } if (CAM.k > 1.01) setCam(CAM.k, drag.cx + dx, drag.cy + dy); } });
    addEventListener("pointerup", () => { drag = null; svg.classList.remove("grab"); });
    svg.addEventListener("dblclick", (e) => { if (e.target.closest(".twb-s,.twb-n")) return; if (CAM.k > 1.01) setCam(1, 0, 0, true); else { const r = box.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top; setCam(2.4, mx - mx * 2.4, my - my * 2.4, true); } });
    svg.addEventListener("pointermove", (e) => { const g = e.target.closest(".twb-s") || (e.target.closest(".twb-n.mine") || null); if (g && g.dataset.sym) hoverStock(g, e); else if (svg.dataset.hovSym) { svg.dataset.hovSym = ""; hoverStock(null); } });
    svg.addEventListener("pointerleave", () => { svg.dataset.hovSym = ""; hoverStock(null); });
  }
  const NCOL = { portfolio: "#f5c518", holding: "#4da3ff", watch: "#22d3ee", company: "#8b95a3", sector: "#a78bfa", industry: "#7c6bb8", macro: "#ff9f43", event: "#5eead4", trader: "#ff6fae" };
  const ncol = (n) => (n.type === "discovery" ? (n.tone > 0 ? "#0fbf7d" : n.tone < 0 ? "#f6465d" : "#c9ced6") : NCOL[n.type] || "#888");
  function showPop(id) {
    const n = G.nodes.find((x) => x.id === id); if (!n) return; const p = J(n.s, n.k), pop = $("twbPop");
    pop.innerHTML = `<div class="tw-kick" style="font-size:10px">${esc(n.type.toUpperCase())}</div><b>${esc(n.label)}</b><div class="tw-muted tw-small">${esc(n.sub || "")}</div><div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${n.disc ? `<button class="tw-btn" type="button" data-twd="${esc(n.disc)}">Full research →</button>` : ""}${n.go ? `<button class="tw-btn ghost" type="button" data-twgo="${esc(n.go)}">Open in Terminal →</button>` : ""}</div>`;
    pop.style.left = Math.min(G.w - 250, p.x + 12) + "px"; pop.style.top = Math.min(G.h - 120, p.y + 12) + "px"; pop.hidden = false;
  }

  // ---------------------------------------------------------------- the spider: an articulated, biomechanical crawler (screen space)
  // Legs are recomputed every frame from a walking gait (two alternating groups of four, phase driven by the
  // distance travelled); a full-screen canvas layer draws fading light trails, data particles and a scanning sweep.
  let SIZE = innerWidth < 760 ? 64 : 96, HALF = SIZE / 2;
  const LEGS = [[-1, -11, -58, 0], [-1, -4, -20, 1], [-1, 3, 18, 0], [-1, 10, 52, 1], [1, -11, -58, 1], [1, -4, -20, 0], [1, 3, 18, 1], [1, 10, 52, 0]]; // side, hip y, angle, gait group
  // entrances: from the exact vertical middle of the left edge, partly outside the screen
  const leftMid = () => ({ x: -SIZE * 0.55, y: innerHeight / 2 - HALF });
  function spiderEl() {
    if (SPD.el) return;
    SPD.el = document.createElement("div"); SPD.el.className = "tw-crawler";
    SPD.el.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><defs>
      <radialGradient id="spAbd" cx="45%" cy="35%" r="70%"><stop offset="0" stop-color="#5b6672"/><stop offset=".55" stop-color="#262d35"/><stop offset="1" stop-color="#0d1116"/></radialGradient>
      <radialGradient id="spTh" cx="45%" cy="35%" r="70%"><stop offset="0" stop-color="#6a7581"/><stop offset="1" stop-color="#151a20"/></radialGradient>
      <radialGradient id="spEye"><stop offset="0" stop-color="#e8fffc"/><stop offset=".45" stop-color="#5eead4"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></radialGradient></defs>
      <g class="sp-legs">${LEGS.map((_, i) => `<path class="sp-leg" id="spL${i}"/><path class="sp-leg-core" id="spC${i}"/><circle class="sp-knee" id="spK${i}" r="1.6"/>`).join("")}</g>
      <ellipse cx="50" cy="63" rx="13" ry="17" fill="url(#spAbd)" stroke="#3a4450" stroke-width=".8"/>
      <path class="sp-acc" d="M50 49 L50 77 M43 56 Q50 60 57 56 M42 65 Q50 69 58 65 M44 73 Q50 76 56 73"/>
      <ellipse cx="50" cy="45" rx="9" ry="8" fill="url(#spTh)" stroke="#3a4450" stroke-width=".8"/>
      <path d="M44 38 Q50 30 56 38 L54 41 Q50 37 46 41 Z" fill="#1b2128" stroke="#5eead4" stroke-width=".6"/>
      <circle class="sp-eye" cx="46.5" cy="38.5" r="2.4" fill="url(#spEye)"/><circle class="sp-eye" cx="53.5" cy="38.5" r="2.4" fill="url(#spEye)"/>
      <circle class="sp-eye s" cx="44" cy="41" r="1.2" fill="url(#spEye)"/><circle class="sp-eye s" cx="56" cy="41" r="1.2" fill="url(#spEye)"/>
      <circle class="sp-core" cx="50" cy="63" r="2.2"/></svg>`;
    SPD.cap = document.createElement("div"); SPD.cap.className = "twb-cap";
    SPD.fx = document.createElement("canvas"); SPD.fx.className = "twb-fx";
    document.body.append(SPD.fx, SPD.el, SPD.cap);
    SPD.legs = LEGS.map((_, i) => [SPD.el.querySelector("#spL" + i), SPD.el.querySelector("#spC" + i), SPD.el.querySelector("#spK" + i)]);
    SPD.trail = []; SPD.parts = []; SPD.phase = 0; SPD.frameT = []; SPD.lowFx = false; SPD.idleT = 0; SPD.pauseUntil = 0;
    const p = leftMid(); SPD.x = p.x; SPD.y = p.y; SPD.head = 0;
    addEventListener("resize", () => { SIZE = innerWidth < 760 ? 64 : 96; HALF = SIZE / 2; SPD.el.style.width = SPD.el.style.height = SIZE + "px"; fxSize(); });
    SPD.el.style.width = SPD.el.style.height = SIZE + "px"; fxSize();
    // pause completely when the browser tab is hidden
    document.addEventListener("visibilitychange", () => { if (document.hidden) { cancelAnimationFrame(SPD.raf); SPD.on = false; } else if (SPD.wanted) startSpider(); });
  }
  function fxSize() { const d = Math.min(1.5, devicePixelRatio || 1); SPD.fx.width = innerWidth * d; SPD.fx.height = innerHeight * d; SPD.fx.style.width = innerWidth + "px"; SPD.fx.style.height = innerHeight + "px"; SPD.fxD = d; }
  // gait: each foot swings forward and back along the body; during the lifted half of its cycle the leg pulls in
  function drawLegs(moving) {
    for (let i = 0; i < LEGS.length; i++) {
      const [side, hy, deg, grp] = LEGS[i], ph = SPD.phase + (grp ? Math.PI : 0), sw = moving ? Math.sin(ph) : Math.sin(SPD.idleT * 1.3 + i) * 0.12, lift = moving ? Math.max(0, Math.cos(ph)) : 0;
      const hx = 50 + side * 8, hyy = 45 + hy * 0.9, a = (deg * Math.PI) / 180, L = 34 - lift * 5;
      const fx = hx + side * Math.cos(a) * L, fy = hyy + Math.sin(a) * L + sw * 7;
      const mx = (hx + fx) / 2, my = (hyy + fy) / 2;
      const kx = mx + side * (6 + lift * 3), ky = my - 7 - lift * 4;
      const d = `M${hx.toFixed(1)} ${hyy.toFixed(1)} L${kx.toFixed(1)} ${ky.toFixed(1)} L${fx.toFixed(1)} ${fy.toFixed(1)}`;
      const [pa, cr, kn] = SPD.legs[i]; pa.setAttribute("d", d); cr.setAttribute("d", d); kn.setAttribute("cx", kx.toFixed(1)); kn.setAttribute("cy", ky.toFixed(1));
    }
  }
  function drawFx(t, dt, moving, scanning) {
    const c = SPD.fx.getContext("2d"), d = SPD.fxD, cx = SPD.x + HALF, cy = SPD.y + HALF;
    c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, innerWidth, innerHeight);
    if (SPD.lowFx || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (moving) { SPD.trail.push({ x: cx, y: cy, t }); if (Math.random() < 0.6 && SPD.parts.length < 60) { const a = SPD.head + Math.PI + (Math.random() - 0.5) * 1.2, v = 20 + Math.random() * 40; SPD.parts.push({ x: cx - Math.cos(SPD.head) * HALF * 0.5, y: cy - Math.sin(SPD.head) * HALF * 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.9 }); } }
    SPD.trail = SPD.trail.filter((q) => t - q.t < 900);
    for (let k = 1; k < SPD.trail.length; k++) { const p = SPD.trail[k], q = SPD.trail[k - 1], al = 1 - (t - p.t) / 900; c.strokeStyle = `rgba(94,234,212,${(al * 0.35).toFixed(3)})`; c.lineWidth = 1 + al * 2.5; c.beginPath(); c.moveTo(q.x, q.y); c.lineTo(p.x, p.y); c.stroke(); }
    for (const p of SPD.parts) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96; }
    SPD.parts = SPD.parts.filter((p) => p.life > 0);
    for (const p of SPD.parts) { c.fillStyle = `rgba(${p.life > 0.5 ? "125,249,255" : "77,163,255"},${(p.life * 0.8).toFixed(3)})`; c.fillRect(p.x - 1, p.y - 1, 2, 2); }
    if (scanning) { const r = HALF * 1.25, a0 = (t / 380) % (Math.PI * 2); c.strokeStyle = "rgba(94,234,212,.55)"; c.lineWidth = 1.5; c.beginPath(); c.arc(cx, cy, r, a0, a0 + 1.1); c.stroke();
      const g = (t % 1200) / 1200; c.strokeStyle = `rgba(77,163,255,${(0.4 * (1 - g)).toFixed(3)})`; c.beginPath(); c.arc(cx, cy, HALF * (0.6 + g * 1.2), 0, Math.PI * 2); c.stroke(); }
  }
  const scr = (p) => { const o = $("twb").getBoundingClientRect(); return { x: o.left + p.x * CAM.k + CAM.x - HALF, y: o.top + p.y * CAM.k + CAM.y - HALF }; };
  const jf = (s, k) => () => scr(J(s, k));
  // path along the web: around ring k from spoke s1 to s2 (shorter way), then along spoke s2 to ring k2
  function webPath(from, s2, k2) {
    const pts = []; let { s, k } = from; const dir = ((s2 - s + SPOKES) % SPOKES) <= SPOKES / 2 ? 1 : -1;
    while (s !== s2) { const n = (s + dir + SPOKES) % SPOKES, a = s, kk = k; pts.push(() => scr(sag(J(a, kk), J(n, kk)))); pts.push(jf(n, kk)); s = n; }
    while (k !== k2) { k += k2 > k ? 1 : -1; pts.push(jf(s2, k)); }
    return pts;
  }
  const say = (t) => { SPD.capText = t; };
  function cmd(c) { SPD.q.push(c); }
  function crawl(s2, k2, cap, speed) { const from = { ...SPD.at }; cmd({ pts: () => webPath(from, s2, k2), speed: speed || 150, cap, end: () => (SPD.at = { s: s2, k: k2 }) }); SPD.at = { s: s2, k: k2 }; }
  function planVisit(v) { // v = { page, text, lines:[indexes] }
    const [grp, pageName] = PAGE[v.page] || ["markets", "Overview"], spokes = GSPOKES[grp], s = spokes[Math.floor(spokes.length / 2)];
    crawl(s, RINGS, `Heading to ${GNAME[grp]} › ${pageName}`);
    cmd({ wait: 1700, cap: v.text ? `Reading ${pageName}: ${v.text}` : `Reading ${pageName}` }); // reads it from the web's edge; never leaves the page
    const mine = G.nodes.filter((n) => groupOfNode(n) === grp).sort((a, b) => a.k - b.k || (b.importance || 0) - (a.importance || 0));
    const wanted = (v.lines || []).flatMap((i) => (SUM.target[i] ? G.nodes.filter((n) => n.label.length > 1 && new RegExp(`\\b${n.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(SUM.target[i].t)) : []));
    const picks = [...new Set([...wanted, ...mine])].slice(0, 2);
    const VERB = { filings: "Scanning SEC filings", fin: "Comparing financial statements", research: "Researching", portfolio: "Reviewing portfolio companies", risk: "Reviewing portfolio risk", macro: "Checking macroeconomic releases", news: "Examining market news", data: "Monitoring market developments", nyse: "Monitoring market developments", analysis: "Monitoring market developments", aitrade: "Syncing research with AI Trader" };
    for (const n of picks) { crawl(n.s, n.k, `${VERB[v.page] || "Researching"}: ${n.label}`); cmd({ wait: 1100, cap: `${VERB[v.page] || "Inspecting"}: ${n.label}${n.sub ? " · " + n.sub : ""}`, node: n.id }); }
    crawl(SPD.at.s, 0, "Crawling into the center");
    cmd({ pts: () => { const r = $("twbHub").getBoundingClientRect(); return [() => ({ x: r.left + 10, y: r.top - HALF })]; }, speed: 160, cap: "Writing the summary" });
    cmd({ write: v.lines || null, cap: "Writing the summary" });
    cmd({ pts: () => [jf(SPD.at.s, 0)], speed: 160, cap: "" });
  }
  // Strictly real activity: the spider only travels for (1) research jobs the server actually recorded and
  // (2) summary sentences the server actually changed. With neither, it rests where it is.
  function nextCycle() {
    const v = SPD.visits.shift();
    if (v) { const lines = [...SUM.pending].filter((i) => SUM.target[i] && SUM.target[i].area === v.page); return planVisit({ page: v.page, text: v.text, lines }); }
    if (SUM.pending.size) { // changed text with no recorded job to show: go straight to the center and write it
      crawl(SPD.at.s, 0, "New data — rewriting the summary");
      cmd({ pts: () => { const r = $("twbHub").getBoundingClientRect(); return [() => ({ x: r.left + 10, y: r.top - HALF })]; }, speed: 160, cap: "Writing the summary" });
      cmd({ write: null, cap: "Writing the summary" }); cmd({ pts: () => [jf(SPD.at.s, 0)], speed: 160, cap: "" }); return;
    }
    const st = W.st; cmd({ wait: 1500, cap: st && st.running ? `Server is working: ${st.running.label}` : "Idle — no research job running", rest: true });
  }
  function step(t) {
    if (!SPD.on) return; SPD.raf = requestAnimationFrame(step);
    const dt = Math.min(0.05, (t - (SPD.last || t)) / 1000); SPD.last = t;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!W.open && !SCAN.on) return hideSpider();
    if (!SPD.cur) { if (!SPD.q.length) { if (SCAN.on) return; nextCycle(); } SPD.cur = SPD.q.shift(); if (!SPD.cur) return; const c = SPD.cur; c.t0 = t; if (c.cap != null) say(c.cap);
      if (c.scroll) { try { c.scroll.scrollIntoView({ block: "center", behavior: "instant" }); } catch {} SPD.cur = null; return; }
      if (c.collect) scanCollect(c.collect);
      if (c.finish) { SPD.cur = null; scanFinish(); return; } if (c.write) { writeLines(c.write).then(() => (c.done = true)); } if (c.node) { const e = document.querySelector(`.twb-n[data-id="${CSS.escape(c.node)}"]`); if (e) { e.classList.add("pick"); setTimeout(() => e.classList.remove("pick"), 1400); } } }
    const c = SPD.cur, busy = W.st && W.st.state !== "idle" && W.st.state !== "error", mult = busy ? 1.35 : 1;
    let moving = false;
    if (c.jump) { const p = c.jump(); SPD.x = p.x; SPD.y = p.y; SPD.head = 0; SPD.trail = []; SPD.cur = null; }
    else if (c.pts) {
      const pts = c.pts().map((f) => f()); c.i = c.i || 0;
      if (reduce) { const p = pts[pts.length - 1]; SPD.x = p.x; SPD.y = p.y; c.i = pts.length; }
      // organic steering: the heading turns toward the next waypoint at a limited rate, speed breathes a little,
      // and the spider slows while turning — so it curves into nodes instead of snapping between them
      if (!reduce && c.i < pts.length) {
        if (SPD.pauseUntil > t) { SPD.head += Math.sin(t / 90) * 0.01; }
        else {
          const p = pts[c.i], dx = p.x - SPD.x, dy = p.y - SPD.y, d = Math.hypot(dx, dy), want = Math.atan2(dy, dx);
          let diff = Math.atan2(Math.sin(want - SPD.head), Math.cos(want - SPD.head)); const turn = (d < 50 ? 12 : 5.5) * dt;
          SPD.head += Math.max(-turn, Math.min(turn, diff)); diff = Math.atan2(Math.sin(want - SPD.head), Math.cos(want - SPD.head));
          const v = (c.speed || 150) * mult * (0.82 + 0.18 * Math.sin(t / 470 + c.t0)) * (0.3 + 0.7 * Math.max(0, Math.cos(diff)));
          const m = Math.min(d, v * dt); SPD.x += Math.cos(SPD.head) * m; SPD.y += Math.sin(SPD.head) * m; SPD.phase += m / (SIZE * 0.16); moving = m > 0.05;
          c.el = (c.el || 0) + dt;
          if (d < Math.max(6, v * dt * 1.5) || c.el > 12) { if (d < 30) { SPD.x = p.x; SPD.y = p.y; } c.i++; c.el = 0; if (c.i < pts.length && Math.random() < 0.12) SPD.pauseUntil = t + 250 + Math.random() * 500; } // occasional pause to look around
        }
      }
      if (c.i >= pts.length) { if (c.end) c.end(); SPD.cur = null; }
    } else if (c.wait != null) { if (c.node) SPD.head += Math.sin(t / 260) * 0.012; if (t - c.t0 >= (reduce ? 200 : c.wait)) SPD.cur = null; }
    else if (c.write) {
      if (c.done) SPD.cur = null;
      const k = document.querySelector("#twbLines .caret");
      if (k) { const r = k.getBoundingClientRect(), tx = r.right + 2, ty = r.top - HALF - 6, dx = tx - SPD.x, dy = ty - SPD.y, d = Math.hypot(dx, dy);
        if (d > 1) { const m = Math.min(d, 520 * dt); SPD.x += (dx / d) * m; SPD.y += (dy / d) * m; SPD.head = Math.PI; SPD.phase += m / (SIZE * 0.16); moving = true; } }
    }
    else SPD.cur = null;
    SPD.idleT = t / 1000;
    SPD.el.style.transform = `translate(${SPD.x.toFixed(1)}px,${SPD.y.toFixed(1)}px)`;
    SPD.el.firstElementChild.style.transform = `rotate(${((SPD.head * 180) / Math.PI + 90).toFixed(1)}deg)`;
    drawLegs(moving); drawFx(t, dt, moving, !!(c && c.wait != null && (c.node || c.collect)));
    // adaptive quality: drop the trail and particles if frames are slow (< ~35 fps over 120 frames)
    SPD.frameT.push(dt); if (SPD.frameT.length > 120) SPD.frameT.shift(); if (SPD.frameT.length === 120) SPD.lowFx = SPD.frameT.reduce((x, y) => x + y, 0) / 120 > 1 / 35;
    SPD.el.classList.toggle("stopped", !moving && !(c && c.write));
    SPD.el.classList.toggle("resting", !!(c && c.rest));
    SPD.el.classList.toggle("offline", !!W.offline);
    SPD.cap.textContent = SPD.capText || ""; SPD.cap.style.display = SPD.capText ? "" : "none";
    SPD.cap.style.transform = `translate(${Math.max(8, Math.min(innerWidth - 310, SPD.x + SIZE + 4)).toFixed(0)}px,${Math.max(8, Math.min(innerHeight - 30, SPD.y + HALF - 10)).toFixed(0)}px)`;
  }


  // ---------------------------------------------------------------- following you around the Terminal
  // When you open another section the spider walks over to it, starts the matching research job on the server
  // (one real request, rate-limited), crawls over the charts and tables on that page while the job runs, and
  // reports the job's actual result when the server finishes it.
  const PAGE_JOB = { quant: ["portfolio_scan"], news: ["news_sweep"], data: ["market_pulse"], nyse: ["market_pulse"], analysis: ["market_pulse"], macro: ["macro_check"], portfolio: ["portfolio_scan"], risk: ["portfolio_scan"], aitrade: ["ai_trader_sync"], filings: ["filings_watch"] };
  const FOL = { asked: {}, job: null, jobLabel: "", page: null };
  const pageLabel = (t) => { const g = typeof groupOf === "function" ? groupOf(t) : ""; const it = (NAV.find(([k]) => k === g) || [, []])[1].find(([k]) => k === t); return `${GNAME[g] || g} › ${it ? it[1] : t}`; };
  function symFor(t) { const v = t === "research" ? S.rq && S.rq.sym : t === "fin" ? ($("finSym") || {}).value : t === "dcf" ? ($("dcfSym") || {}).value : t === "filings" ? (typeof CR !== "undefined" && CR.sym) : null; const s = String(v || "").toUpperCase().trim(); return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s) && !/[\^=]/.test(s) ? s : null; }
  async function startResearch(t) {
    const sym = symFor(t), type = sym ? (t === "research" ? "company_snapshot" : "fundamentals") : (PAGE_JOB[t] || [])[0]; if (!type) return null;
    const key = type + ":" + (sym || ""); if (Date.now() - (FOL.asked[key] || 0) < 10 * 60e3) return FOL.job && FOL.jobKey === key ? FOL.job : null;
    FOL.asked[key] = Date.now();
    try { const r = await api("/api/web/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type, symbol: sym || undefined }) }); FOL.job = r.id; FOL.jobKey = key; FOL.jobLabel = sym ? `${sym}` : pageLabel(t); FOL.found = null; watchJob(); return r.id; } catch { return null; }
  }
  function watchJob() { clearInterval(FOL.timer); FOL.watching = true; const t0 = Date.now(); FOL.timer = setInterval(async () => { if (Date.now() - t0 > 4 * 60e3) { FOL.watching = false; return clearInterval(FOL.timer); } await loadStatus(); const j = W.st && (W.st.recent || []).find((x) => x.id === FOL.job); if (j && j.status !== "running") { clearInterval(FOL.timer); FOL.watching = false; FOL.found = j.status === "done" ? `Found: ${j.result || "done"}` : `Research failed: ${j.error || ""}`; } }, 5000); }
  function targetsOn(t) {
    const sec = $("tab-" + t); if (!sec) return [];
    const els = [...sec.querySelectorAll("svg, canvas, table, .card, .fx-card, .pf-card, .pfc, .an-card, .ny-pane, .apx, .mc-grid > *, .heat, .feed > *, .hm-frame, .kpis, .mood-card, .earn-card")];
    return els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 140 && r.height > 50 && r.bottom > 120 && r.top < innerHeight - 40 && !e.closest(".tw-mini") && !els.some((o) => o !== e && o.contains(e) && o.getBoundingClientRect().height < 700); }).slice(0, 14);
  }
  const titleOf = (e) => { const h = e.querySelector("h1,h2,h3,h4,.h,th") || (e.previousElementSibling && /^H\d$/.test(e.previousElementSibling.tagName) ? e.previousElementSibling : null); return h ? h.textContent.trim().replace(/\s+/g, " ").replace(/^\d+\s*/, "").slice(0, 46) : ""; };
  function pageCycle() {
    const t = S.tab;
    if (FOL.found) { cmd({ wait: 4500, cap: FOL.found }); FOL.found = null; return; }
    const live = (W.st && W.st.running) || (FOL.job && FOL.watching);
    if (!live) { cmd({ wait: 1500, cap: "Idle — no research job running", rest: true }); return; } // nothing running: rest
    const T = targetsOn(t); if (!T.length) { cmd({ wait: 1500, cap: W.st && W.st.running ? `Server is working: ${W.st.running.label}` : "" }); return; }
    const e = T[Math.floor(Math.random() * T.length)], fx = 0.15 + Math.random() * 0.7, title = titleOf(e);
    cmd({ pts: () => [() => { const r = e.getBoundingClientRect(); return { x: r.left + r.width * fx - HALF, y: r.top - HALF + 6 }; }], speed: 220, cap: title ? `Reading ${title}` : `Reading ${pageLabel(t)}` });
    cmd({ pts: () => [() => { const r = e.getBoundingClientRect(); return { x: r.left + r.width * Math.min(0.95, fx + 0.12) - HALF, y: r.top + Math.min(r.height - HALF, 40) - HALF }; }], speed: 70, cap: FOL.job && !FOL.found ? `Researching ${FOL.jobLabel} on the server…` : title ? `Reading ${title}` : "" });
  }
  function hideSpider() { SPD.wanted = false; SPD.on = false; cancelAnimationFrame(SPD.raf); SPD.q = []; SPD.cur = null; if (SPD.el) for (const e of [SPD.el, SPD.cap, SPD.fx]) e.style.display = "none"; }
  function onTab(t) {
    if (SCAN.on) { SCAN.on = false; SCAN.aborted = true; } // switching pages cancels a running scan
    if (t !== "web") return hideSpider(); // the spider stays on THE WEB page; the 10-K crawler has its own reader
    if (!SPD.el) return; for (const e of [SPD.el, SPD.cap, SPD.fx]) e.style.display = ""; startSpider();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    SPD.q = []; SPD.cur = null; FOL.page = t;
    if (t === "web") { cmd({ jump: leftMid }); cmd({ pts: () => [jf(12, RINGS)], speed: 260, cap: "Crawling into the web", end: () => (SPD.at = { s: 12, k: RINGS }) }); return; }
    const first = () => { const T = targetsOn(t), e = T[0]; if (!e) return { x: innerWidth / 2 - HALF, y: innerHeight / 2 - HALF }; const r = e.getBoundingClientRect(); return { x: r.left + Math.min(r.width - SIZE, 40), y: r.top - HALF + 6 }; };
    cmd({ jump: leftMid }); cmd({ pts: () => [() => ({ x: Math.min(innerWidth * 0.25, 240), y: innerHeight / 2 - HALF }), first], speed: 320, cap: `Crawling into ${pageLabel(t)}` });
    startResearch(t).then((id) => { if (id) SPD.capText = `Started research: ${FOL.jobLabel}`; });
  }
  const _setTab = setTab; setTab = function () { const r = _setTab.apply(this, arguments); try { onTab(S.tab); } catch {} return r; };

  // ---------------------------------------------------------------- the summary inside the web
  async function loadSummary() {
    let s; try { s = await api("/api/web/summary"); } catch { return; }
    SUM.meta = s;
    const lines = s.lines || [];
    lines.forEach((l, i) => { if (!SUM.target[i] || SUM.target[i].t !== l.t || SUM.shown[i] !== l.t) { if (SUM.shown[i] !== l.t) SUM.pending.add(i); } });
    for (const i of [...SUM.pending]) if (i >= lines.length) SUM.pending.delete(i);
    SUM.target = lines; if (SUM.shown.length > lines.length) SUM.shown.length = lines.length;
    if (!lines.length) $("twbLines").innerHTML = `<p class="twb-wait">${s.empty ? "No summary yet — the spider writes the first one once it has collected market data (usually within a few minutes of the market opening, or press Rewrite)." : ""}</p>`;
    else if (matchMedia("(prefers-reduced-motion: reduce)").matches) { SUM.shown = lines.map((l) => l.t); SUM.pending.clear(); renderLines(); }
    else renderLines();
    foot();
  }
  function foot() {
    const s = SUM.meta; if (!s) return;
    $("twbK").textContent = s.live ? "THE WEB · LIVE MARKET SUMMARY" : "THE WEB · " + (s.title || "MARKET SUMMARY").toUpperCase();
    const st = W.st, job = st && st.running ? `Spider is ${STATE[st.state] ? STATE[st.state].toLowerCase() : "working"}: ${st.running.label}` : "";
    $("twbFoot").innerHTML = `<span>${s.live ? `<b class="up">● Live</b> · updated ${et(s.generatedAt)} ET · keeps rewriting until the 4:00 PM close` : `Market ${esc(s.phase || "closed")} — this is the final summary${s.generatedAt ? ` (written ${etD(s.generatedAt)} ET)` : ""}. Live rewriting resumes at 9:30 AM ET.`}</span>${s.freshness ? `<span class="tw-muted">${esc(s.freshness.quotes.label)}</span>` : ""}${job ? `<span class="tw-muted">${esc(job)}</span>` : ""}<button class="tw-btn ghost" type="button" id="twbRe">Rewrite now</button>`;
    $("twbRe").onclick = async () => { try { await api("/api/web/briefing/generate", { method: "POST" }); toast("🕸 The spider is refreshing its data — the summary updates in about a minute."); } catch (e) { toast(e.message); } };
  }
  function renderLines(active) {
    const el = $("twbLines"); if (!el) return;
    el.innerHTML = SUM.target.map((l, i) => { const shown = SUM.shown[i]; const txt = i === active ? SUM.typing : shown; return `<p class="${i === active ? "typing" : shown == null ? "todo" : SUM.pending.has(i) ? "stale" : ""}">${txt == null ? "&nbsp;" : esc(txt)}${i === active ? '<span class="caret"></span>' : ""}</p>`; }).join("");
  }
  async function writeLines(idx) {
    const list = (idx && idx.length ? idx : [...SUM.pending]).filter((i) => SUM.target[i]).sort((a, b) => a - b);
    for (const i of list) {
      const t = SUM.target[i].t; SUM.typing = "";
      for (let c = 1; c <= t.length; c += 2) { if (!W.open) return; SUM.typing = t.slice(0, c); renderLines(i); if (c === 1) { const pe = $("twbLines").children[i]; if (pe) pe.scrollIntoView({ block: "nearest" }); } await new Promise((r) => setTimeout(r, 14)); }
      SUM.shown[i] = t; SUM.pending.delete(i); renderLines();
    }
    const L = $("twbLines"); if (L && !SUM.pending.size) L.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------------------------------------------------------------- real backend activity → places for the spider to visit
  async function loadStatus() {
    try { W.st = await api("/api/web/status"); W.offline = false; } catch { W.offline = true; }
    const s = W.st; if (!s) return;
    for (const j of (s.recent || []).slice().reverse()) {
      if (SPD.seenJobs.has(j.id) || j.status !== "done") continue; SPD.seenJobs.add(j.id);
      if (!SPD.started || Date.now() - (j.ended || 0) > 10 * 60e3) continue; // only work done since the page opened
      const page = pageOfJob(j); if (page) { SPD.visits.push({ page, text: (j.result || j.label || "").slice(0, 90) }); SPD.visits = SPD.visits.slice(-4); }
    }
    SPD.started = true;
    if (W.open) foot();
    const n = s.stats.memory + ":" + s.stats.discoveries; if (W.lastDisc !== null && n !== W.lastDisc && !W.open) notifyNew(); W.lastDisc = n;
  }
  async function notifyNew() { // a quiet toast elsewhere on the site when a high-importance finding touches your portfolio
    if (Date.now() - W.toastAt < 5 * 60e3 || document.hidden) return;
    try { const r = await api(`/api/web/discoveries?mine=1&min=70&since=${Date.now() - 15 * 60e3}&limit=1`); const d = r.items[0]; if (d) { W.toastAt = Date.now(); toast(`🕸 Spider: ${d.headline}`); } } catch {}
  }
  async function loadGraph() { try { W.graph = await api("/api/web/graph"); } catch { return; } placeNodes(); drawWeb(); }

  // ---------------------------------------------------------------- discovery detail (opened from a web node)
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
  async function runResearch(sym) { try { await api("/api/web/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "company_snapshot", symbol: sym }) }); toast(`🕸 Queued fresh research on ${sym}.`); closeModal(); } catch (e) { toast(e.message); } }

  // ---------------------------------------------------------------- network
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



  // ---------------------------------------------------------------- the Spider button: an on-demand 2x scan of the current page
  // The spider enters from the middle of the left edge, scrolls through every section of the page you're on,
  // inspects each one at double speed, records the figures it reads, starts the matching server research job,
  // and finishes with a written report built from what it collected (rule-based, no paid AI).
  const SCAN = { on: false, found: [], t0: 0, page: null };
  function scanTargets(t, max = 16) {
    const sec = $("tab-" + t); if (!sec) return [];
    const els = [...sec.querySelectorAll(".ql-mod, .fx-card, .card, .pfc, .pf-card, .an-card, .ny-pane, .apx, .kpis, .mood-card, .earn-card, .bt-card, .cr-side, .cr-doc, .twb, .feed > *, .heat, table, svg, canvas")];
    const ok = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 160 && r.height > 60 && e.offsetParent !== null && !els.some((o) => o !== e && o.contains(e) && o.getBoundingClientRect().height < 900); });
    return ok.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).slice(0, max);
  }
  const NUMLINE = /(^|[\s(:·])[-+−]?\$?\d[\d,]*(\.\d+)?\s*(%|[KMBT]\b|x\b)?(?=$|[\s),·])/; // a standalone figure, not the "1" in "1-year"
  // What the report says about each section: its real heading, then the figures with their labels — table rows read as
  // "row: column value", tiles as "label: value" — never chart axis ticks, buttons or header rows. A section without
  // figures contributes its key sentence instead.
  const clean = (t) => String(t || "").replace(/\s+/g, " ").trim(), cleanT = (t) => clean(t).replace(/^\d{1,2}\s*(?=[A-Z])/, ""); // titles lose a module number, values keep their digits
  const NUMV = /\d/, ISFIG = (v) => v.length <= 32 && !/^\d+[A-Za-z]/.test(v) && (/^[-+−±~]?\s?[$€£]?\s?\d/.test(v) || /^[βρσα]\s?[-+−]?\d/.test(v) || /^[A-Z]{1,5}(\/[A-Z]{1,5})?\s[-+−]?\$?\d/.test(v) || /^[-+−]?\d[\d,.]*\s?(%|[KMBT]|x|bps)?\s*(\/|of)\s*\d/.test(v)); // a value, not a label like "1Y return"
  function sectionTitle(e) {
    const own = e.querySelector(".ql-mh h2, h1, h2, h3, h4, legend, caption"); if (own && cleanT(own.textContent)) return cleanT(own.textContent).slice(0, 60);
    let p = e; for (let i = 0; i < 6 && p; i++) { let sb = p.previousElementSibling; for (let k = 0; sb && k < 6; k++) { const h = /^H[1-4]$/.test(sb.tagName) ? sb : sb.querySelector && sb.querySelector("h1,h2,h3,h4"); if (h && cleanT(h.textContent)) return cleanT(h.textContent).slice(0, 60); sb = sb.previousElementSibling; } p = p.parentElement; }
    return cleanT(titleOf(e)) || "Section";
  }
  function factsOf(e) {
    const out = [], push = (f) => { f = clean(f); if (f.length > 3 && f.length < 150 && !out.includes(f)) out.push(f); };
    for (const tb of e.matches("table") ? [e] : [...e.querySelectorAll("table")]) {
      const hd = [...tb.querySelectorAll("thead th")].map((th) => clean(th.textContent));
      for (const tr of [...tb.querySelectorAll("tbody tr")].slice(0, 10)) { const td = [...tr.children].map((c) => clean(c.innerText || c.textContent)); if (td.length < 2) continue;
        const vals = td.slice(1).map((v, i) => [hd[i + 1] || "", v]).filter(([, v]) => ISFIG(v)).slice(0, 3); if (vals.length) push(`${td[0].slice(0, 32)}: ${vals.map(([h, v]) => (h ? `${h} ${v}` : v)).join(" · ")}`); }
      if (out.length >= 10) return out; }
    for (const el of e.querySelectorAll("b, strong, em, span, small, dd, div, p")) {
      if (out.length >= 10) break; if (el.children.length || el.closest("table, svg, button, select, label, .ql-seg, .ql-ctl, .ql-leg, .ql-m, .bs-chip")) continue;
      const v = clean(el.textContent); if (!ISFIG(v)) continue;
      let lab = ""; const sib = el.previousElementSibling; if (sib && !ISFIG(clean(sib.textContent)) && clean(sib.textContent)) lab = clean(sib.textContent);
      if (!lab && el.parentElement) { const f = [...el.parentElement.children].find((c) => c !== el && clean(c.textContent) && !ISFIG(clean(c.textContent))); if (f) lab = clean(f.textContent); }
      push(lab ? `${lab.slice(0, 40)}: ${v}` : v); }
    if (!out.length) (e.innerText || "").split("\n").map(clean).filter((x) => x.length > 24 && x.length < 220 && !/^(symbol|name)\b/i.test(x) && (x.match(/[—…]/g) || []).length < 3 && !/loading|no quote/i.test(x)).slice(0, 2).forEach(push);
    return out;
  }
  function scanCollect(e) {
    const lines = String(e.innerText || "").split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean);
    SCAN.found.push({ title: sectionTitle(e), facts: factsOf(e), text: lines.join(" ").slice(0, 4000) });
  }

  // The scan uses the ORIGINAL spider — the 10-K crawler's: two-segment legs with inverse kinematics and an alternating
  // gait, a laser from its mouth to every figure it reads, spark bursts where the beam lands — drawn huge across the
  // whole screen at the crawler's 2× speed.
  const BS = { sp: null, lasers: [], pulses: [], raf: 0, ov: null, cap: null };
  const bsMs = (ms, min) => (typeof crMs === "function" ? crMs(ms, min) : Math.max(min, ms / 2));
  function bsInit() {
    if (!BS.ov) { BS.ov = document.createElementNS("http://www.w3.org/2000/svg", "svg"); BS.ov.setAttribute("class", "bs-ov"); BS.cap = document.createElement("div"); BS.cap.className = "bs-cap"; document.body.append(BS.ov, BS.cap); }
    const sc = innerWidth < 700 ? 0.95 : 1.7, legs = []; for (const sd of [-1, 1]) [-62, -24, 18, 56].forEach((a, i) => legs.push({ s: sd, a: (a * Math.PI) / 180, g: (i + (sd > 0 ? 1 : 0)) % 2, foot: null, from: null, to: null, t0: 0 }));
    BS.sp = { x: -150 * sc, y: innerHeight / 2, tx: -150 * sc, ty: innerHeight / 2, vx: 0, vy: 0, scale: sc, legs, ph: 0 }; BS.lasers = []; BS.pulses = [];
    BS.ov.style.display = BS.cap.style.display = ""; cancelAnimationFrame(BS.raf); BS.raf = requestAnimationFrame(bsFrame);
  }
  function bsHide() { cancelAnimationFrame(BS.raf); BS.raf = 0; if (BS.ov) { BS.ov.style.display = "none"; BS.ov.innerHTML = ""; BS.cap.style.display = "none"; } }
  function bsFrame(now) {
    const Sp = BS.sp, ov = BS.ov; if (!Sp || ov.style.display === "none") return; BS.raf = requestAnimationFrame(bsFrame);
    ov.setAttribute("viewBox", `0 0 ${innerWidth} ${innerHeight}`); ov.setAttribute("width", innerWidth); ov.setAttribute("height", innerHeight);
    const speed = 2, k = Math.min(0.32, 0.012 * speed * 1.6), damp = 0.78; Sp.vx = (Sp.vx + (Sp.tx - Sp.x) * k) * damp; Sp.vy = (Sp.vy + (Sp.ty - Sp.y) * k) * damp;
    const vmax = 14 * speed * 1.4 * Sp.scale, v = Math.hypot(Sp.vx, Sp.vy); if (v > vmax) { Sp.vx *= vmax / v; Sp.vy *= vmax / v; } Sp.x += Sp.vx; Sp.y += Sp.vy; Sp.ph += 0.05;
    let stepping = false; const lifted = Sp.legs.some((L) => L.to);
    for (const L of Sp.legs) { const rest = crRest(Sp, L); if (!L.foot) L.foot = { ...rest };
      if (L.to) { const t = Math.min(1, (now - L.t0) / bsMs(150 * 1.25, 45)); L.foot = { x: L.from.x + (L.to.x - L.from.x) * t, y: L.from.y + (L.to.y - L.from.y) * t - Math.sin(t * Math.PI) * 22 * Sp.scale }; if (t >= 1) { L.foot = { ...L.to }; L.to = null; } stepping = true; }
      else { const dist = Math.hypot(rest.x - L.foot.x, rest.y - L.foot.y); if (dist > 300 * Sp.scale) L.foot = { ...rest };
        else if (dist > 46 * Sp.scale && (!lifted || (Sp.legs.find((x) => x.to) || {}).g === L.g || dist > 120 * Sp.scale)) { L.from = { ...L.foot }; L.to = { x: rest.x + Sp.vx * 5, y: rest.y + Sp.vy * 5 }; L.t0 = now; stepping = true; } } }
    Sp.stepping = stepping;
    const tw = Math.sin(now / 180) * 1.6 * Sp.scale, s = Sp.scale, bob = Math.sin(Sp.ph * 2) * 1.2 * s, mouth = { x: Sp.x, y: Sp.y + 10 * s };
    const legsSvg = Sp.legs.map((L, i) => { const h = crHip(Sp, L), kn = crKnee(h, L.foot, Sp, L), ky = kn.y + (i % 2 ? tw : -tw); return `<polyline points="${h.x.toFixed(1)},${h.y.toFixed(1)} ${kn.x.toFixed(1)},${ky.toFixed(1)} ${L.foot.x.toFixed(1)},${L.foot.y.toFixed(1)}"/><circle class="kn" cx="${kn.x.toFixed(1)}" cy="${ky.toFixed(1)}" r="${(2.2 * s).toFixed(1)}"/><circle class="ft" cx="${L.foot.x.toFixed(1)}" cy="${L.foot.y.toFixed(1)}" r="${(3 * s).toFixed(1)}"/>`; }).join("");
    BS.lasers = BS.lasers.filter((l) => now < l.t0 + l.life); BS.pulses = BS.pulses.filter((p) => now < p.t0 + bsMs(700, 200));
    const lasers = BS.lasers.filter((l) => now >= l.t0).map((l) => { const t = (now - l.t0) / l.life, a = t < 0.15 ? t / 0.15 : t > 0.75 ? (1 - t) / 0.25 : 1, L = (w, c, o, f) => `<line x1="${mouth.x.toFixed(1)}" y1="${mouth.y.toFixed(1)}" x2="${l.to.x.toFixed(1)}" y2="${l.to.y.toFixed(1)}" stroke="${c}" stroke-width="${w}" ${o ? `opacity="${o}"` : ""} stroke-linecap="round" ${f ? 'filter="url(#bsGlow)"' : ""}/>`;
      return `<g opacity="${a.toFixed(2)}">${L((l.w * 4).toFixed(1), l.c, ".22")}${L(l.w, l.c, "", true)}${L((l.w * 0.35).toFixed(2), "#fff")}<circle cx="${l.to.x.toFixed(1)}" cy="${l.to.y.toFixed(1)}" r="4" fill="#facc15"/></g>`; }).join("");
    const pulses = BS.pulses.filter((p) => now >= p.t0).map((p) => { const t = (now - p.t0) / bsMs(700, 200); return [0, 1, 2, 3, 4, 5, 6, 7].map((k2) => { const a = (k2 / 8) * Math.PI * 2 + 0.3, r = 6 + t * 30; return `<circle cx="${(p.p.x + Math.cos(a) * r).toFixed(1)}" cy="${(p.p.y + Math.sin(a) * r).toFixed(1)}" r="${(1.8 * (1 - t) + 0.3).toFixed(2)}" fill="${p.c}" opacity="${(1 - t).toFixed(2)}"/>`; }).join("") + `<circle cx="${p.p.x.toFixed(1)}" cy="${p.p.y.toFixed(1)}" r="${(4 + t * 26).toFixed(1)}" fill="none" stroke="${p.c}" stroke-width="2" opacity="${(1 - t).toFixed(2)}"/>`; }).join("");
    ov.innerHTML = `<defs><filter id="bsGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${lasers}<g class="cr-legs" fill="none" stroke-linejoin="round" stroke-linecap="round">${legsSvg}</g>
      <g transform="translate(${Sp.x.toFixed(1)},${(Sp.y + bob).toFixed(1)})"><rect x="${(-9 * s).toFixed(1)}" y="${(-30 * s).toFixed(1)}" width="${(18 * s).toFixed(1)}" height="${(46 * s).toFixed(1)}" rx="${(8 * s).toFixed(1)}" class="cr-body"/><rect x="${(-5 * s).toFixed(1)}" y="${(-24 * s).toFixed(1)}" width="${(10 * s).toFixed(1)}" height="${(16 * s).toFixed(1)}" rx="${(4 * s).toFixed(1)}" fill="#1a1d24"/><circle cx="-${(3.2 * s).toFixed(1)}" cy="${(9 * s).toFixed(1)}" r="${(1.8 * s).toFixed(1)}" fill="#38bdf8"/><circle cx="${(3.2 * s).toFixed(1)}" cy="${(9 * s).toFixed(1)}" r="${(1.8 * s).toFixed(1)}" fill="#38bdf8"/></g>${pulses}`;
    BS.cap.style.transform = `translate(${Math.max(8, Math.min(innerWidth - 330, Sp.x + 70 * s)).toFixed(0)}px,${Math.max(8, Math.min(innerHeight - 40, Sp.y - 50 * s)).toFixed(0)}px)`;
  }
  const bsWait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function bsGo(x, y, maxMs) { const Sp = BS.sp; Sp.tx = x; Sp.ty = y; const t0 = performance.now(); while (SCAN.on && Math.hypot(Sp.x - x, Sp.y - y) > 18 * Sp.scale && performance.now() - t0 < maxMs) await bsWait(40); }
  const COLORS = ["#ff2d95", "#ff2d95", "#ff4fa8", "#ff2d95", "#e11d74", "#ff2d95"];
  function bsChip(text, x, y) { const c = document.createElement("div"); c.className = "bs-chip"; c.textContent = text; c.style.left = Math.max(8, Math.min(innerWidth - 220, x)) + "px"; c.style.top = Math.max(60, y) + "px"; document.body.appendChild(c); setTimeout(() => c.remove(), bsMs(2600, 900)); }
  function bsPill(txt) { let p = document.getElementById("bsPill"); if (!p) { p = document.createElement("div"); p.id = "bsPill"; p.className = "bs-pill"; document.body.appendChild(p); } p.hidden = !txt; p.innerHTML = txt || ""; }
  function figuresIn(e, max = 7) { // leaf elements on screen that show a number
    const out = []; for (const el of e.querySelectorAll("b, td, em, span, strong, h3, text, small")) { if (out.length >= max) break; if (el.children.length > 1) continue; const t = (el.textContent || "").trim(); if (!t || t.length > 32 || !NUMLINE.test(" " + t + " ")) continue;
      const r = el.getBoundingClientRect(); if (r.width < 4 || r.bottom < 60 || r.top > innerHeight - 20 || r.right < 0 || r.left > innerWidth) continue; if (out.some((o) => o.contains(el) || el.contains(o))) continue; out.push(el); }
    return out; }
  // Complete readers for pages whose content is a long list: the spider reads the data behind the page, not just what
  // is scrolled into view. News: every headline published today (since midnight ET), whatever the filters hide.
  function deepRead(t) {
    if ((t === "news" || t === "analysis") && S.news && S.news.items) {
      const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })), mid = Date.now() - (et.getHours() * 3600 + et.getMinutes() * 60 + et.getSeconds()) * 1000;
      let items = S.news.items.filter((i) => (i.time || 0) >= mid), span = "today";
      if (items.length < 10) { items = S.news.items.filter((i) => (i.time || 0) >= Date.now() - 24 * 3600e3); span = "the last 24 hours"; }
      return { kind: "news", span, items: items.slice().sort((a, b) => (b.time || 0) - (a.time || 0)) };
    }
    return null;
  }
  // ---- entities: combine every word that refers to the same company (ticker, company name, its people and products)
  // Names come from the S&P 500 list; people/products are learned from the headlines themselves: a word or two-word name
  // that keeps appearing in headlines about one company is attached to that company (no hand-kept CEO list to go stale).
  const NAME_JUNK = /\b(inc|incorporated|corp|corporation|co|company|companies|holdings?|group|plc|ltd|limited|class [a-c]|the|n\.?v|s\.?a|ag|se|lp|llc|trust|reit|international|technologies|technology|systems|enterprises?)\b\.?/gi;
  const GENERIC = new Set("american,general,united,first,national,international,global,bank,financial,capital,energy,health,healthcare,services,industries,motors,brands,foods,airlines,systems,resources,pacific,southern,northern,western,eastern,public,realty,properties,data,digital,new,best,old,royal,state,street,mutual,insurance,life,group,dollar,home,world,electric,power,devices,micro,pharmaceuticals,semiconductor,communications,entertainment,petroleum,oil,gas,chemical,materials,water,solutions,texas,california,florida,carolina,virginia,york,jersey,chicago,boston,atlanta,dallas,houston,denver,phoenix,seattle,ohio,illinois,michigan,arizona,nevada,georgia,washington,america,atlantic,central,united,federal,regional,community,church,arch,ross,ball,cooper,hess,mosaic,target,visa,progressive,principal,prudential,discover,match,gap,apa,lowe,ford,fox,news,host,check,live,block,square,snap,pool,fair,smith,howmet,booking,expedia".split(","));
  async function aliasMap() {
    if (W.alias) return W.alias; if (!W.sp500) { try { W.sp500 = (await (await fetch("/sp500.json")).json()).rows || []; } catch { W.sp500 = []; } }
    const m = new Map(), nm = {};
    for (const [sym, name] of W.sp500) { const base = String(name || "").replace(NAME_JUNK, " ").replace(/[.,&']/g, " ").replace(/\s+/g, " ").trim().toLowerCase(); nm[sym] = String(name || sym).replace(/,? (Inc\.?|Corporation|Corp\.?|Co\.?|Company|plc|Ltd\.?|Holdings?|N\.V\.)$/i, "");
      const w = base.split(" ").filter(Boolean); if (!w.length) continue;
      if (w[0].length >= 4 && !GENERIC.has(w[0])) m.set(w[0], sym); if (w.length >= 2) m.set(w.slice(0, 2).join(" "), sym);
      }
    W.tickers = new Set(W.sp500.map((r) => r[0]));
    for (const [k, v] of [["google", "GOOGL"], ["alphabet", "GOOGL"], ["facebook", "META"], ["meta", "META"], ["nvidia", "NVDA"], ["amazon", "AMZN"], ["microsoft", "MSFT"], ["apple", "AAPL"], ["tesla", "TSLA"], ["berkshire", "BRK.B"], ["jpmorgan", "JPM"], ["openai", null]]) if (v) { m.set(k, v); } else m.delete(k);
    W.alias = { m, nm }; return W.alias;
  }
  function entities(items, A) {
    const STOP = new Set("the,and,for,with,from,that,this,after,over,into,about,amid,says,said,will,have,has,its,are,was,were,than,more,what,when,your,their,they,just,could,would,stock,stocks,shares,share,market,markets,new,how,why,who,report,reports,week,today,year,inc,corp,price,prices,quarter,deal,deals,first,also,back,still,here,there,these,those,most,could,should,ahead,amid,set,sees,gets,make,makes,big,top,now,up,down,out,off,per,via,vs".split(","));
    const disp = {}; const seeD = (w, orig) => { const k = w.toLowerCase(); disp[k] = disp[k] || {}; disp[k][orig] = (disp[k][orig] || 0) + 1; };
    const H = items.map((i) => { const title = String(i.title || "").replace(/['’]s\b/g, ""), low = title.toLowerCase(), ents = new Set(i.tickers || []);
      for (const o of title.match(/[A-Za-z][A-Za-z'.-]{2,}/g) || []) seeD(o, o);
      for (const tk2 of title.match(/\b[A-Z]{2,5}\b/g) || []) if (W.tickers && W.tickers.has(tk2)) ents.add(tk2); // tickers count only when written in capitals
      const tw = low.match(/[a-z][a-z0-9&.'-]*/g) || []; // every word and every adjacent pair
      for (let k = 0; k < tw.length; k++) for (const key of [tw[k], k + 1 < tw.length ? tw[k] + " " + tw[k + 1] : null]) { const s2 = key && A.m.get(key); if (s2) ents.add(s2); }
      const caps = []; const toks = title.match(/[A-Za-z][A-Za-z'.-]+/g) || [];
      for (let k = 0; k < toks.length - 1; k++) if (/^[A-Z][a-z]{2,}$/.test(toks[k]) && /^[A-Z][a-z]{2,}$/.test(toks[k + 1])) caps.push(toks[k] + " " + toks[k + 1]); // two-word names
      const words = new Set([...caps.filter((c) => !c.split(" ").some((x) => A.m.has(x.toLowerCase()))), ...(low.match(/[a-z][a-z'-]{2,}/g) || []).filter((w) => !STOP.has(w) && !A.m.has(w))]);
      return { i, ents, words }; });
    const wc = {}, co = {}; for (const h of H) for (const w of h.words) { wc[w] = (wc[w] || 0) + 1; for (const e of h.ents) { const k = w + "|" + e; co[k] = (co[k] || 0) + 1; } }
    for (const p of Object.keys(wc)) if (p.includes(" ") && wc[p] >= 2) for (const part of p.toLowerCase().split(" ")) if (wc[part] && wc[part] <= wc[p] + 1) delete wc[part]; // "jensen", "huang" fold into "Jensen Huang"
    const ec = {}; for (const h of H) for (const e of h.ents) { ec[e] = ec[e] || { n: 0, m: 0, attach: [] }; ec[e].n++; ec[e].m += Math.sign(h.i.mood || 0); }
    const used = new Set();
    // attach: a word seen ≥2 times mostly alongside one company; a person's name (two capitalized words) needs only half
    for (const [w, n] of Object.entries(wc)) { if (n < 2) continue; const person = /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(w); let best = null;
      for (const e of Object.keys(ec)) { const c = co[w + "|" + e] || 0; if ((person ? c >= 1 && c / n >= 0.5 : c >= 2 && c / n >= 0.6) && (!best || c > best[1])) best = [e, c]; }
      if (best) { ec[best[0]].attach.push([w, n]); used.add(w); } }
    // second pass: a headline that names only a company's person or product counts for that company too
    for (const [e, v] of Object.entries(ec)) for (const [w] of v.attach) for (const h of H) if (h.words.has(w) && !h.ents.has(e)) { h.ents.add(e); v.n++; v.m += Math.sign(h.i.mood || 0); }
    const ents = Object.entries(ec).sort((a, b) => b[1].n - a[1].n).map(([sym, v]) => ({ sym, name: A.nm[sym] || sym, n: v.n, lean: v.m, attach: v.attach.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => (w.includes(" ") ? w : nice(w))) }));
    // non-company themes merge the same way: a word that mostly appears with a stronger theme joins it ("Fed · Powell")
    const tl = Object.entries(wc).filter(([w, n]) => n >= 2 && !used.has(w)).sort((a, b) => b[1] - a[1]), merged = new Set(), themes = [];
    for (const [w, n] of tl) { if (merged.has(w)) continue; const g = [w];
      for (const [v, m] of tl) { if (v === w || merged.has(v) || m > n) continue; const both = H.filter((h) => h.words.has(w) && h.words.has(v)).length; if (both / m >= 0.6) { g.push(v); merged.add(v); } }
      themes.push([g.map((x) => (x.includes(" ") ? x : nice(x))).join(" · "), H.filter((h) => g.some((x) => h.words.has(x))).length]); if (themes.length >= 8) break; }
    function nice(w) { const d = disp[w.toLowerCase()]; if (!d) return w; return Object.entries(d).sort((a, b) => b[1] - a[1] || (a[0] === a[0].toLowerCase()) - (b[0] === b[0].toLowerCase()))[0][0]; }
    return { ents, themes, H };
  }
  window.spiderScan = async function () {
    if (SCAN.on) return; const t = S.tab; SCAN.on = true; SCAN.aborted = false; SCAN.page = t; SCAN.found = []; SCAN.t0 = performance.now(); SCAN.job = null;
    const btn = $("spBtn"); if (btn) btn.classList.add("on"); if (SPD.el) for (const e of [SPD.el, SPD.cap, SPD.fx]) e.style.visibility = "hidden";
    if (typeof startResearch === "function") startResearch(t).then((id) => { SCAN.job = id ? FOL.jobLabel : null; });
    const ALL = scanTargets(t, 80), T = ALL.length <= 9 ? ALL : Array.from({ length: 9 }, (_, i) => ALL[Math.round((i * (ALL.length - 1)) / 8)]); SCAN.deep = deepRead(t); SCAN.all = ALL; const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches, say2 = (x) => { if (BS.cap) BS.cap.textContent = x; };
    if (reduce) { ALL.forEach((e) => scanCollect(e)); return scanFinish(); }
    bsInit(); SCAN.figs = 0; const shuffle = null; void shuffle; bsPill(`<b>${esc(pageLabel(t).toUpperCase())}</b> · <span>0 figures</span> · 0 of ${T.length} sections`); say2(`Spider deployed · examining ${pageLabel(t)} at 2× speed`);
    await bsGo(Math.min(innerWidth * 0.2, 260), innerHeight / 2, 1200);
    // crawl to every piece of information it reads: hop from figure to figure (headline to headline on News),
    // scrolling the page along, lasering each one on arrival. Every section gets visited; ~70 hops keep it brisk.
    const zap = (el, color, main) => { const q = el.getBoundingClientRect(), p = { x: q.left + Math.min(q.width / 2, 120), y: q.top + q.height / 2 }, now = performance.now();
      BS.lasers.push({ to: p, c: color, t0: now, life: bsMs(800, 160), w: main ? 2.6 : 1.8 }); BS.pulses.push({ p, c: color, t0: now + 40 });
      el.classList.remove("bs-zap"); void el.offsetWidth; el.classList.add("bs-zap"); setTimeout(() => el.classList.remove("bs-zap"), 2600); };
    const itemsIn = (e) => SCAN.deep ? [...e.querySelectorAll(".np-art h3, .np-brief h5, li.item, .feed > li, article")].filter((el, i, arr) => !arr.some((o) => o !== el && o.contains(el)))
      : [...e.querySelectorAll("b, td, em, span, strong, h3, text, small")].filter((el) => { if (el.children.length > 1) return false; const t = (el.textContent || "").trim(); return t && t.length <= 32 && NUMLINE.test(" " + t + " ") && el.getBoundingClientRect().width > 3; });
    const BUDGET = 70, per = Math.max(2, Math.floor(BUDGET / Math.max(1, ALL.length))), sc = BS.sp.scale;
    const pickEven = (arr, n) => arr.length <= n ? arr : Array.from({ length: n }, (_, i) => arr[Math.round((i * (arr.length - 1)) / (n - 1 || 1))]);
    let readN = 0, hl = SCAN.deep ? SCAN.deep.items.length : 0;
    for (const [k, e] of ALL.entries()) { if (!SCAN.on) break;
      const title = titleOf(e) || `section ${k + 1}`, color = COLORS[k % COLORS.length];
      try { e.scrollIntoView({ block: "center", behavior: "instant" }); } catch {} await bsWait(40);
      const r0 = e.getBoundingClientRect(); bsChip(title, r0.left + 8, r0.top - 6); say2(`Crawling to ${title}`);
      const items = pickEven(itemsIn(e), SCAN.deep ? Math.max(per, 18) : per);
      if (!items.length) { await bsGo(Math.max(90 * sc, Math.min(innerWidth - 90 * sc, r0.left + r0.width / 2)), Math.max(170 * sc, Math.min(innerHeight - 150 * sc, r0.top + Math.min(r0.height / 2, 200))), bsMs(900, 220)); if (SCAN.on) zap(e, color, true); await bsWait(bsMs(500, 120)); }
      for (const [j, el] of items.entries()) { if (!SCAN.on) break;
        let q = el.getBoundingClientRect(); if (q.top < 120 || q.bottom > innerHeight - 90) { try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch {} await bsWait(30); q = el.getBoundingClientRect(); }
        // the spider stands just beside what it's reading, legs over it
        const x = Math.max(90 * sc, Math.min(innerWidth - 90 * sc, q.left + Math.min(q.width, 240) + 60 * sc)), y = Math.max(150 * sc, Math.min(innerHeight - 140 * sc, q.top + q.height / 2 - 34 * sc));
        const txt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 70);
        say2(`${SCAN.deep ? "Reading" : "Reading " + title + ":"} ${txt}`);
        await bsGo(x, y, bsMs(650, 160)); if (!SCAN.on) break;
        zap(el, j ? "#ff4fa8" : color, !j); readN++; SCAN.figs = (SCAN.figs || 0) + (SCAN.deep ? 0 : 1);
        bsPill(SCAN.deep ? `<b>${esc(pageLabel(t).toUpperCase())}</b> · <span>${Math.min(hl, Math.round((hl * (k * items.length + j + 1)) / Math.max(1, ALL.length * items.length)))} of ${hl} headlines read</span>` : `<b>${esc(pageLabel(t).toUpperCase())}</b> · <span>${SCAN.figs} figures</span> · section ${k + 1} of ${ALL.length}`);
        await bsWait(bsMs(220, 50)); }
      scanCollect(e); const f = SCAN.found[SCAN.found.length - 1];
      if (!SCAN.deep) say2(`Read ${title}: ${f && f.facts.length ? f.facts.slice(0, 2).join(" · ") : "no figures"}`.slice(0, 120)); }
    if (SCAN.deep && SCAN.on) bsPill(`<b>${esc(pageLabel(t).toUpperCase())}</b> · <span>${hl} of ${hl} headlines read</span>`);
    // everything on the page gets read, including the sections the tour didn't stop at
    if (SCAN.on) { if (SCAN.deep) say2(`Read all ${SCAN.deep.items.length} headlines from ${SCAN.deep.span}`); }
    if (SCAN.on) { say2("Writing the report"); await bsGo(-160 * BS.sp.scale, innerHeight / 2, 1500); }
    bsHide(); bsPill(""); if (SPD.el) for (const e of [SPD.el, SPD.cap, SPD.fx]) e.style.visibility = "";
    if (SCAN.on) scanFinish(); else { SCAN.on = false; if (btn) btn.classList.remove("on"); }
  };
  async function scanFinish() {
    const page = SCAN.page, secs = ((performance.now() - SCAN.t0) / 1000).toFixed(1), F = SCAN.found; SCAN.on = false; const btn = $("spBtn"); if (btn) btn.classList.remove("on");
    if (SCAN.aborted) return;
    // ---- analysis of what was collected (all derived from the collected text)
    const all = F.flatMap((f) => f.facts.map((x) => ({ s: f.title, x }))), pcts = [];
    for (const f of F) for (const m of f.text.matchAll(/([+−-])\s?(\d+(?:\.\d+)?)%/g)) { const v = (m[1] === "+" ? 1 : -1) * +m[2]; const i = m.index, ctx = f.text.slice(Math.max(0, i - 40), i + m[0].length + 4).trim(); if (Math.abs(v) < 500) pcts.push({ v, s: f.title, ctx }); }
    const up = pcts.filter((p) => p.v > 0).length, dn = pcts.filter((p) => p.v < 0).length, hi = pcts.reduce((a, p) => (!a || p.v > a.v ? p : a), null), lo = pcts.reduce((a, p) => (!a || p.v < a.v ? p : a), null);
    const known = new Set([...(S.wl || []), ...((S.port || []).map((h) => h.symbol)), ...Object.keys(S.quotes || {})].map((x) => String(x).toUpperCase())), cnt = {};
    for (const f of F) for (const m of f.text.matchAll(/\b[A-Z]{1,5}(?:\.[A-Z])?\b/g)) if (known.has(m[0])) cnt[m[0]] = (cnt[m[0]] || 0) + 1;
    const tick = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const warns = F.flatMap((f) => (f.text.match(/[^.\n]{0,50}\b(STALE|ERROR|UNAVAILABLE|failed|red flag|faded out-of-sample|broke down)\b[^.\n]{0,30}/g) || []).map((w) => ({ s: f.title, w: w.trim() }))).slice(0, 4);
    let sum = null, disc = []; try { sum = await api("/api/web/summary"); } catch {}
    if (tick.length) try { disc = ((await api(`/api/web/discoveries?symbols=${encodeURIComponent(tick.slice(0, 4).map((x) => x[0]).join(","))}&limit=4`)).items || []); } catch {}
    const take = [], DP = SCAN.deep; let deepHtml = "";
    if (DP && DP.kind === "news") {
      const it = DP.items, srcs = new Set(it.map((i) => i.source)), pos = it.filter((i) => i.mood > 0).length, neg = it.filter((i) => i.mood < 0).length, tk = {};
      for (const i of it) for (const x of i.tickers || []) { tk[x] = tk[x] || { n: 0, m: 0 }; tk[x].n++; tk[x].m += Math.sign(i.mood || 0); }
      const topT = Object.entries(tk).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
      const EN = entities(it, await aliasMap()), themes = EN.themes;
      take.push(`Read all ${it.length} headlines from ${DP.span} across ${srcs.size} source${srcs.size === 1 ? "" : "s"} (${[...srcs].join(", ")}).`);
      take.push(`Tone: ${pos} positive, ${neg} negative, ${it.length - pos - neg} neutral — the news flow reads ${pos > neg * 1.4 ? "positive" : neg > pos * 1.4 ? "negative" : "mixed"}.`);
      const topE = EN.ents.slice(0, 6); void topT;
      if (topE.length) take.push(`Most-covered companies: ${topE.map((e) => `${e.name} (${[e.sym, ...e.attach].join(" · ")}) — ${e.n} headline${e.n === 1 ? "" : "s"}${e.lean > 0 ? ", leaning positive" : e.lean < 0 ? ", leaning negative" : ""}`).join("; ")}.`);
      if (themes.length) take.push(`Other recurring themes: ${themes.map(([w, n]) => `${w} (${n})`).join(", ")}.`);
      const rankE = new Map(EN.ents.map((e, k) => [e.sym, k])), nameOf = Object.fromEntries(EN.ents.map((e) => [e.sym, `${e.name} · ${e.sym}`])), groups = {};
      for (const h of EN.H) { const es = [...h.ents].sort((a, b) => (rankE.get(a) ?? 99) - (rankE.get(b) ?? 99)), g = es.length ? nameOf[es[0]] || es[0] : "Market-wide"; (groups[g] = groups[g] || []).push(h.i); }
      const gs = Object.entries(groups).sort((a, b) => (a[0] === "Market-wide") - (b[0] === "Market-wide") || b[1].length - a[1].length);
      const tm = (t) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      deepHtml = `<h4>Every headline read (${it.length})</h4>${gs.map(([g, xs]) => `<div class="sp-sec"><b>${esc(g)} · ${xs.length}</b><ul class="sp-news">${xs.map((i) => `<li><i class="${i.mood > 0 ? "up" : i.mood < 0 ? "down" : ""}">●</i>${esc(i.title)} <em>${esc(i.source || "")} · ${tm(i.time)}</em></li>`).join("")}</ul></div>`).join("")}`;
    }
    if (!DP) take.push(`Examined ${F.length} section${F.length === 1 ? "" : "s"} of ${pageLabel(page)} and recorded ${all.length} figures in ${secs} s.`);
    if (pcts.length) take.push(`Of ${pcts.length} signed percentages on the page, ${up} were positive and ${dn} negative${up + dn ? ` — the page reads ${up > dn * 1.5 ? "mostly positive" : dn > up * 1.5 ? "mostly negative" : "mixed"}` : ""}.`);
    if (hi && hi.v > 0) take.push(`Largest gain seen: ${hi.v > 0 ? "+" : ""}${hi.v}% (${hi.s}: “${hi.ctx}”).`);
    if (lo && lo.v < 0) take.push(`Largest decline seen: ${lo.v}% (${lo.s}: “${lo.ctx}”).`);
    if (tick.length) take.push(`Most-mentioned tickers: ${tick.map(([k, n]) => `${k} (${n})`).join(", ")}.`);
    for (const w of warns) take.push(`Flag in ${w.s}: “${w.w}”.`);
    if (SCAN.job) take.push(`Started a server research job for ${SCAN.job}; its findings will appear in THE WEB.`);
    const el = document.createElement("div"); el.className = "sp-rep"; el.innerHTML = `<div class="sp-rep-in" role="dialog" aria-label="Spider report">
      <div class="sp-rep-h"><div><div class="sp-k">🕷 SPIDER REPORT · ${esc(pageLabel(page).toUpperCase())}</div><h3>What the spider found</h3><small>${new Date().toLocaleTimeString()} · ${DP ? `${DP.items.length} headlines` : `${F.length} sections · ${all.length} figures`} · ${secs} s at 2× speed</small></div><button class="sp-x" type="button" aria-label="Close">✕</button></div>
      <h4>Takeaways</h4><ul class="sp-take">${take.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${sum && sum.lines && sum.lines.length ? `<h4>Market context (THE WEB ${sum.live ? "live summary" : "latest summary"})</h4><ul class="sp-take">${sum.lines.slice(0, 3).map((l) => `<li>${esc(l.t)}</li>`).join("")}</ul>` : ""}
      ${disc.length ? `<h4>Research on those tickers</h4><ul class="sp-take">${disc.map((d) => `<li><b>${esc(d.headline)}</b></li>`).join("")}</ul>` : ""}
      ${deepHtml}${DP ? "" : `<h4>Section by section</h4>`}${DP ? "" : (() => { const m = new Map(); for (const f of F) { if (!f.facts.length) continue; const g = m.get(f.title) || []; for (const x of f.facts) if (!g.includes(x) && g.length < 12) g.push(x); m.set(f.title, g); }
        return m.size ? [...m].map(([t2, fs]) => `<div class="sp-sec"><b>${esc(t2)}</b><ul>${fs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`).join("") : `<p class="sp-foot">Nothing readable on this page yet — prices may still be loading.</p>`; })()}
      <p class="sp-foot">A rule-based summary of what the spider read on this page plus THE WEB's stored research. No paid AI; nothing is traded.</p></div>`;
    document.querySelectorAll(".sp-rep").forEach((x) => x.remove()); document.body.appendChild(el);
    const close = () => el.remove(); el.querySelector(".sp-x").onclick = close; el.onclick = (e) => { if (e.target === el) close(); }; document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
  }

  // ---------------------------------------------------------------- open / close
  window.webOpen = function () {
    shell(); W.open = true; layoutWeb(); const firstIn = !SPD.el; startSpider();
    if (firstIn) { SPD.at = { s: 12, k: RINGS }; cmd({ jump: leftMid }); cmd({ pts: () => [jf(12, RINGS)], speed: 240, cap: "Crawling into the web" }); }
    wireWeb(); toolbar(); loadSnap(); if (!ROT.raf) ROT.raf = requestAnimationFrame(rotLoop); loadStatus(); loadGraph(); loadSummary(); pushCtx(true);
    clearInterval(W.snapPoll); W.snapPoll = setInterval(() => { if (!document.hidden && W.open) loadSnap(); }, 60e3); // live heat map
    clearInterval(W.poll); W.poll = setInterval(() => { if (!document.hidden) loadStatus(); }, 5000);
    clearInterval(W.sumPoll); W.sumPoll = setInterval(() => { if (!document.hidden) loadSummary(); }, SUM.meta && !SUM.meta.live ? 300e3 : 30e3);
    clearInterval(W.gPoll); W.gPoll = setInterval(() => { if (!document.hidden) loadGraph(); }, 120e3);
  };
  window.webClose = function () { W.open = false; clearInterval(W.snapPoll); clearInterval(W.poll); clearInterval(W.sumPoll); clearInterval(W.gPoll); };
  function startSpider() { spiderEl(); SPD.wanted = true; if (SPD.on || document.hidden) return; SPD.on = true; SPD.last = 0; SPD.raf = requestAnimationFrame(step); }

  window.TWX = { W, G, J, CAM, ROT, VIEWS, SPD, SC, SHORT, setCam, focusSym, placeXY, myStocks, drawWeb, toolbar, applyFilters, searchWeb, loadSnap, moveCol, esc, since, rest: () => SPD };
  if (S.tab === "web") window.webOpen(); // the page opened straight on #web (setTab ran before this script loaded)
  setTimeout(() => { pushCtx(true); loadStatus(); }, 2500);
  W.navPoll = setInterval(() => { if (!W.open && !document.hidden) loadStatus(); }, 8000);
})();

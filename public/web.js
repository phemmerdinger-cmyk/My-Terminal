/* THE WEB — one huge web with the live market summary in its center, written by the Spider.
   Everything shown comes from the server's real research (/api/web/*): the spider's trips into the Terminal's tabs follow
   the backend job log, and the summary text is the server's live summary built from collected data. */
(function () {
  if (typeof VIEW !== "undefined" && VIEW) return; // the public demo doesn't get THE WEB (it holds the owner's research)
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
    root.innerHTML = `<div class="twb" id="twb"><svg class="twb-web" id="twbSvg"></svg><div class="twb-hub" id="twbHub"><div class="twb-k" id="twbK">THE WEB · MARKET SUMMARY</div><div class="twb-lines" id="twbLines"><p class="twb-wait">The spider is gathering the first summary…</p></div><div class="twb-foot" id="twbFoot"></div></div><div class="twb-pop" id="twbPop" hidden></div></div>
      <div class="tw-modal" id="twModal" hidden><div class="tw-mbox" id="twMbox"></div></div>`;
    $("twModal").onclick = (e) => { if (e.target.id === "twModal" || e.target.closest(".x")) closeModal(); };
    $("twb").addEventListener("click", (e) => { const st = e.target.closest(".twb-s"); if (st && typeof openQuote === "function") return openQuote(st.dataset.sym); const n = e.target.closest(".twb-n"); if (n) return showPop(n.dataset.id); if (!e.target.closest(".twb-pop")) $("twbPop").hidden = true; });
    $("twbPop").addEventListener("click", (e) => { const g = e.target.closest("[data-twgo]"); if (g) return go(g.dataset.twgo); const d = e.target.closest("[data-twd]"); if (d) { e.preventDefault(); openDisc(d.dataset.twd); } });
    addEventListener("resize", () => { if (W.open) { layoutWeb(); drawWeb(); } });
  }
  function layoutWeb() {
    const box = $("twb"), r = box.getBoundingClientRect(); G.w = r.width; G.h = r.height; G.cx = G.w / 2; G.cy = G.h / 2; G.rx = G.w / 2 - 12; G.ry = G.h / 2 - 12;
    G.narrow = G.w < 760; G.hub = G.narrow ? 0.74 : 0.6;
    const hub = $("twbHub"), cw = G.narrow ? G.w * 0.92 : 2 * G.rx * G.hub * 0.84, ch = G.narrow ? G.h * 0.7 : 2 * G.ry * G.hub * 0.9;
    Object.assign(hub.style, { width: cw + "px", height: ch + "px", left: G.cx - cw / 2 + "px", top: G.cy - ch / 2 + "px" });
  }
  const ang = (s) => -Math.PI / 2 + (s / SPOKES) * Math.PI * 2;
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
  function drawWeb() {
    const svg = $("twbSvg"); if (!svg || !G.w) return;
    svg.setAttribute("viewBox", `0 0 ${G.w} ${G.h}`);
    let out = "";
    for (let s = 0; s < SPOKES; s++) { const a = J(s, 0), b = J(s, RINGS + 0.35); out += `<line class="spoke" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`; }
    for (let k = 0; k <= RINGS; k++) { let d = ""; for (let s = 0; s < SPOKES; s++) { const a = J(s, k), b = J((s + 1) % SPOKES, k), c = sag(a, b); d += `${s ? "" : `M${a.x} ${a.y}`} Q${c.x} ${c.y} ${b.x} ${b.y}`; } out += `<path class="ring${k === 0 ? " hubring" : ""}" d="${d}"/>`; }
    const mineSet = myStocks();
    for (const n of G.nodes) { const p = J(n.s, n.k), c = ncol(n), lab = ["portfolio", "holding", "sector", "macro", "trader"].includes(n.type), mine = mineSet.has(String(n.label || "").toUpperCase());
      if (mine) out += `<g class="twb-lit" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" pointer-events="none"><circle class="glow" r="16" style="fill:#f5c518"/><circle r="9" fill="none" stroke="#f5c518" stroke-width="1.4" opacity=".85"/></g>`;
      out += `<g class="twb-n${lab || mine ? " lab" : ""}${mine ? " mine" : ""}" data-id="${esc(n.id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" tabindex="0" role="button" aria-label="${esc(n.type + ": " + n.label)}"><circle class="hit" r="12"/><circle class="halo" r="9" fill="${c}"/><circle class="core" r="${n.type === "portfolio" ? 4.5 : 3}" fill="${c}"/><text x="7" y="3">${esc(n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label)}</text><title>${esc(n.label + (n.sub ? " — " + n.sub : ""))}</title></g>`; }
    out = out.replace(/(<g class="twb-n)/, fillWeb() + "$1"); if (!/class="twb-n/.test(out)) out += fillWeb();
    svg.innerHTML = out;
  }
  // ---------------------------------------------------------------- the web is filled with stocks; your portfolio lights up
  // Every free spot on the web (each junction, the middle of each ring segment, and the points between rings) holds a stock:
  // your holdings first (spread around the web, glowing), then the largest S&P 500 companies, then the rest of the index.
  const MEGA = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "BRK.B", "LLY", "JPM", "V", "UNH", "XOM", "MA", "COST", "WMT", "HD", "PG", "JNJ", "NFLX", "ORCL", "ABBV", "BAC", "CRM", "AMD", "KO", "CVX", "MRK", "PEP", "ADBE", "TMO", "CSCO", "ACN", "MCD", "LIN", "WFC", "ABT", "IBM", "GE", "PM", "QCOM", "CAT", "TXN", "INTU", "DIS", "VZ", "AMGN", "NOW", "GS", "ISRG", "PFE", "SPGI", "UBER", "MS", "RTX", "AXP", "BKNG", "T", "LOW", "UNP", "NEE", "PLTR", "BLK", "SCHW", "C", "DE", "LMT", "SBUX", "MU", "PANW", "ANET", "KLAC", "LRCX", "AMAT", "ADI", "BA", "NKE", "GILD", "CMCSA", "INTC", "MDT", "CB", "SO", "DUK", "MO", "PYPL", "CRWD", "SHW", "ICE"];
  function myStocks() { const out = new Set(); for (const p of S.pfs || []) for (const h of p.holdings || []) if (h && h.symbol && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(h.symbol.toUpperCase())) out.add(h.symbol.toUpperCase()); return out; }
  function webSlots() { const out = [], used = new Set(G.nodes.map((n) => n.s + ":" + n.k));
    for (let k = 1; k <= RINGS; k++) for (let s = 0; s < SPOKES; s++) {
      if (!used.has(s + ":" + k)) out.push({ ...J(s, k), s, k });
      const a = J(s, k), b = J((s + 1) % SPOKES, k), c = sag(a, b); out.push({ x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y, s: s + 0.5, k }); // mid-segment
      if (k < RINGS) out.push({ ...J(s, k + 0.5), s, k: k + 0.5 }); // between rings, on the spoke
    }
    return out; }
  function fillWeb() {
    if (!W.sp500) { if (!W.sp500Loading) { W.sp500Loading = true; fetch("/sp500.json").then((r) => r.json()).then((j) => { W.sp500 = j.rows || []; if (W.open) drawWeb(); }).catch(() => { W.sp500 = []; }); } }
    const slots = webSlots(); if (!slots.length) return "";
    const mine = myStocks(), shown = new Set(G.nodes.map((n) => String(n.label || "").toUpperCase())), rows = W.sp500 || [], sector = Object.fromEntries(rows.map((r) => [r[0], r[2]]));
    const all = [...new Set([...MEGA, ...rows.map((r) => r[0])])].filter((x) => !mine.has(x) && !shown.has(x));
    // spread holdings evenly around the web (a stride through the slots), then fill the rest in order
    const order = [], taken = new Set(), mineL = [...mine].filter((x) => !shown.has(x)), stride = Math.max(1, Math.floor(slots.length / Math.max(1, mineL.length)));
    mineL.forEach((sym, i) => { let j = (i * stride + 7) % slots.length; while (taken.has(j)) j = (j + 1) % slots.length; taken.add(j); order[j] = { sym, mine: true }; });
    let q = 0; for (let j = 0; j < slots.length; j++) if (!order[j] && q < all.length) order[j] = { sym: all[q++], mine: false };
    const SC = { "Information Technology": "#4da3ff", "Health Care": "#34d399", Financials: "#facc15", "Consumer Discretionary": "#f472b6", "Communication Services": "#a78bfa", Industrials: "#94a3b8", "Consumer Staples": "#fb923c", Energy: "#f87171", Utilities: "#67e8f9", "Real Estate": "#c4b5fd", Materials: "#fde68a" };
    let out = "", lit = "";
    slots.forEach((p, j) => { const o = order[j]; if (!o) return; const d = (q) => esc(q);
      if (o.mine) lit += `<g class="twb-s mine" data-sym="${d(o.sym)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})"><title>${d(o.sym)} · in your portfolio</title><circle class="glow" r="16"/><circle class="ring" r="7.5"/><circle class="dot" r="4"/><text y="-11">${d(o.sym)}</text></g>`;
      else out += `<g class="twb-s" data-sym="${d(o.sym)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})"><title>${d(o.sym)}${sector[o.sym] ? " · " + d(sector[o.sym]) : ""}</title><circle r="1.9" fill="${SC[sector[o.sym]] || "#64748b"}"/><text y="-4">${d(o.sym)}</text></g>`; });
    return `<g class="twb-fill">${out}</g><g class="twb-lit">${lit}</g>`;
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
  const scr = (p) => { const o = $("twb").getBoundingClientRect(); return { x: o.left + p.x - HALF, y: o.top + p.y - HALF }; };
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
  function scanTargets(t) {
    const sec = $("tab-" + t); if (!sec) return [];
    const els = [...sec.querySelectorAll(".ql-mod, .fx-card, .card, .pfc, .pf-card, .an-card, .ny-pane, .apx, .kpis, .mood-card, .earn-card, .bt-card, .cr-side, .cr-doc, .twb, .feed > *, .heat, table, svg, canvas")];
    const ok = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 160 && r.height > 60 && e.offsetParent !== null && !els.some((o) => o !== e && o.contains(e) && o.getBoundingClientRect().height < 900); });
    return ok.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).slice(0, 16);
  }
  const NUMLINE = /(^|[\s(:·])[-+−]?\$?\d[\d,]*(\.\d+)?\s*(%|[KMBT]\b|x\b)?(?=$|[\s),·])/; // a standalone figure, not the "1" in "1-year"
  function scanCollect(e) {
    const title = (titleOf(e) || (e.querySelector("h1,h2,h3,h4,b,strong") || {}).textContent || "").trim().replace(/\s+/g, " ").replace(/^\d+\s*/, "").slice(0, 60) || "Untitled section";
    const lines = String(e.innerText || "").split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean), facts = [];
    for (let i = 0; i < lines.length && facts.length < 6; i++) { const l = lines[i]; if (!NUMLINE.test(l) || l.length > 110) continue;
      const bare = l.length <= 16 && !/[a-z]{4,}/i.test(l.replace(/[KMBT]$/, "")); const lab = bare && i > 0 && !NUMLINE.test(lines[i - 1]) ? lines[i - 1] : null; const f = lab ? `${lab}: ${l}` : l; if (!facts.includes(f) && f.length > 3) facts.push(f); }
    SCAN.found.push({ title, facts, text: lines.join(" ").slice(0, 4000) });
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
  window.spiderScan = async function () {
    if (SCAN.on) return; const t = S.tab; SCAN.on = true; SCAN.aborted = false; SCAN.page = t; SCAN.found = []; SCAN.t0 = performance.now(); SCAN.job = null;
    const btn = $("spBtn"); if (btn) btn.classList.add("on"); if (SPD.el) for (const e of [SPD.el, SPD.cap, SPD.fx]) e.style.visibility = "hidden";
    if (typeof startResearch === "function") startResearch(t).then((id) => { SCAN.job = id ? FOL.jobLabel : null; });
    const T = scanTargets(t), reduce = matchMedia("(prefers-reduced-motion: reduce)").matches, say2 = (x) => { if (BS.cap) BS.cap.textContent = x; };
    if (reduce) { T.forEach((e) => scanCollect(e)); return scanFinish(); }
    bsInit(); SCAN.figs = 0; const shuffle = null; void shuffle; bsPill(`<b>${esc(pageLabel(t).toUpperCase())}</b> · <span>0 figures</span> · 0 of ${T.length} sections`); say2(`Spider deployed · examining ${pageLabel(t)} at 2× speed`);
    await bsGo(Math.min(innerWidth * 0.2, 260), innerHeight / 2, 1200);
    // investigate each section: walk across it in several stops, lasering the figures nearest each stop one by one
    const zap = (el, color, delay, main) => { const q = el.getBoundingClientRect(), p = { x: q.left + q.width / 2, y: q.top + q.height / 2 }, now = performance.now();
      BS.lasers.push({ to: p, c: color, t0: now + delay, life: bsMs(1000, 180), w: main ? 2.6 : 1.7 }); BS.pulses.push({ p, c: color, t0: now + delay + 60 });
      setTimeout(() => { el.classList.remove("bs-zap"); void el.offsetWidth; el.classList.add("bs-zap"); setTimeout(() => el.classList.remove("bs-zap"), 3200); }, delay); };
    const visit = async (e, k, title, pass2) => {
      try { e.scrollIntoView({ block: "center", behavior: "instant" }); } catch {}
      await bsWait(80); const r = e.getBoundingClientRect(), sc = BS.sp.scale, figs = figuresIn(e, pass2 ? 10 : 14), stops = r.width > 900 ? 3 : r.width > 500 ? 2 : 1, color = COLORS[k % COLORS.length];
      if (!pass2) bsChip(title, r.left + 8, r.top - 6);
      for (let st = 0; st < stops && SCAN.on; st++) {
        const fx = (st + 0.5) / stops, x = Math.max(90 * sc, Math.min(innerWidth - 90 * sc, r.left + r.width * fx)), y = Math.max(170 * sc, Math.min(innerHeight - 150 * sc, r.top + Math.min(r.height * (0.35 + 0.2 * (st % 2)), 240)));
        say2(`${pass2 ? "Cross-checking" : "Investigating"} ${title}${stops > 1 ? ` · part ${st + 1}/${stops}` : ""}`);
        await bsGo(x, y, bsMs(1800, 450)); if (!SCAN.on) return;
        const mine = figs.filter((el) => { const q = el.getBoundingClientRect(), cx = q.left + q.width / 2; return cx >= r.left + (r.width * st) / stops - 4 && cx <= r.left + (r.width * (st + 1)) / stops + 4; });
        (mine.length ? mine : st === 0 && !figs.length ? [e] : []).forEach((el, j) => zap(el, j ? "#ff4fa8" : color, j * bsMs(200, 30), !j));
        SCAN.figs = (SCAN.figs || 0) + (pass2 ? 0 : mine.length);
        await bsWait(bsMs(1100, 280) + mine.length * bsMs(200, 30));
      }
    };
    const T0 = performance.now();
    for (const [k, e] of T.entries()) { if (!SCAN.on) break;
      const title = titleOf(e) || `section ${k + 1}`; await visit(e, k, title, false); if (!SCAN.on) break;
      scanCollect(e); const f = SCAN.found[SCAN.found.length - 1];
      bsPill(`<b>${esc(pageLabel(t).toUpperCase())}</b> · <span>${SCAN.figs} figures</span> · ${k + 1} of ${T.length} sections`);
      say2(`Read ${title}: ${f && f.facts.length ? f.facts.slice(0, 2).join(" · ") : "no figures"}`.slice(0, 120)); await bsWait(bsMs(500, 120)); }
    // second pass: go back over the richest sections and cross-check before writing anything
    const rich = SCAN.found.map((f, i) => [i, f.facts.length]).sort((x, y) => y[1] - x[1]).slice(0, 2).filter((x) => x[1] > 0);
    for (const [i] of rich) { if (!SCAN.on) break; const e = T[i]; if (!e) continue; bsPill(`<b>${esc(pageLabel(t).toUpperCase())}</b> · <span>${SCAN.figs} figures</span> · cross-checking`); await visit(e, i, titleOf(e) || `section ${i + 1}`, true); }
    // never rush the report: keep investigating until at least ~30 s have passed
    while (SCAN.on && performance.now() - T0 < 30000 && T.length) { const i = Math.floor(Math.random() * T.length); await visit(T[i], i, titleOf(T[i]) || `section ${i + 1}`, true); }
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
    const take = [];
    take.push(`Examined ${F.length} section${F.length === 1 ? "" : "s"} of ${pageLabel(page)} and recorded ${all.length} figures in ${secs} s.`);
    if (pcts.length) take.push(`Of ${pcts.length} signed percentages on the page, ${up} were positive and ${dn} negative${up + dn ? ` — the page reads ${up > dn * 1.5 ? "mostly positive" : dn > up * 1.5 ? "mostly negative" : "mixed"}` : ""}.`);
    if (hi && hi.v > 0) take.push(`Largest gain seen: ${hi.v > 0 ? "+" : ""}${hi.v}% (${hi.s}: “${hi.ctx}”).`);
    if (lo && lo.v < 0) take.push(`Largest decline seen: ${lo.v}% (${lo.s}: “${lo.ctx}”).`);
    if (tick.length) take.push(`Most-mentioned tickers: ${tick.map(([k, n]) => `${k} (${n})`).join(", ")}.`);
    for (const w of warns) take.push(`Flag in ${w.s}: “${w.w}”.`);
    if (SCAN.job) take.push(`Started a server research job for ${SCAN.job}; its findings will appear in THE WEB.`);
    const el = document.createElement("div"); el.className = "sp-rep"; el.innerHTML = `<div class="sp-rep-in" role="dialog" aria-label="Spider report">
      <div class="sp-rep-h"><div><div class="sp-k">🕷 SPIDER REPORT · ${esc(pageLabel(page).toUpperCase())}</div><h3>What the spider found</h3><small>${new Date().toLocaleTimeString()} · ${F.length} sections · ${all.length} figures · ${secs} s at 2× speed</small></div><button class="sp-x" type="button" aria-label="Close">✕</button></div>
      <h4>Takeaways</h4><ul class="sp-take">${take.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${sum && sum.lines && sum.lines.length ? `<h4>Market context (THE WEB ${sum.live ? "live summary" : "latest summary"})</h4><ul class="sp-take">${sum.lines.slice(0, 3).map((l) => `<li>${esc(l.t)}</li>`).join("")}</ul>` : ""}
      ${disc.length ? `<h4>Research on those tickers</h4><ul class="sp-take">${disc.map((d) => `<li><b>${esc(d.headline)}</b></li>`).join("")}</ul>` : ""}
      <h4>Section by section</h4>${F.map((f) => `<div class="sp-sec"><b>${esc(f.title)}</b>${f.facts.length ? `<ul>${f.facts.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p>No figures on screen.</p>`}</div>`).join("")}
      <p class="sp-foot">A rule-based summary of what the spider read on this page plus THE WEB's stored research. No paid AI; nothing is traded.</p></div>`;
    document.querySelectorAll(".sp-rep").forEach((x) => x.remove()); document.body.appendChild(el);
    const close = () => el.remove(); el.querySelector(".sp-x").onclick = close; el.onclick = (e) => { if (e.target === el) close(); }; document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
  }

  // ---------------------------------------------------------------- open / close
  window.webOpen = function () {
    shell(); W.open = true; layoutWeb(); const firstIn = !SPD.el; startSpider();
    if (firstIn) { SPD.at = { s: 12, k: RINGS }; cmd({ jump: leftMid }); cmd({ pts: () => [jf(12, RINGS)], speed: 240, cap: "Crawling into the web" }); }
    loadStatus(); loadGraph(); loadSummary(); pushCtx(true);
    clearInterval(W.poll); W.poll = setInterval(() => { if (!document.hidden) loadStatus(); }, 5000);
    clearInterval(W.sumPoll); W.sumPoll = setInterval(() => { if (!document.hidden) loadSummary(); }, SUM.meta && !SUM.meta.live ? 300e3 : 30e3);
    clearInterval(W.gPoll); W.gPoll = setInterval(() => { if (!document.hidden) loadGraph(); }, 120e3);
  };
  window.webClose = function () { W.open = false; clearInterval(W.poll); clearInterval(W.sumPoll); clearInterval(W.gPoll); };
  function startSpider() { spiderEl(); SPD.wanted = true; if (SPD.on || document.hidden) return; SPD.on = true; SPD.last = 0; SPD.raf = requestAnimationFrame(step); }

  if (S.tab === "web") window.webOpen(); // the page opened straight on #web (setTab ran before this script loaded)
  setTimeout(() => { pushCtx(true); loadStatus(); }, 2500);
  W.navPoll = setInterval(() => { if (!W.open && !document.hidden) loadStatus(); }, 8000);
})();

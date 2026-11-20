/* Workspace (Research → Workspace): one ticker, four panels side by side — price chart, key stats, latest news and
 * SEC financials. Loaded on demand (lazy-core.js). Logic lives in workspace-core.js; this file only fetches and draws.
 * Each panel loads on its own, so a slow or failed source never blocks the others. */
(function () {
  "use strict";
  const C = window.MDWorkspaceCore;
  if (!C) return;
  const W = { sym: null, range: "6mo", layout: "grid", req: 0, chart: null, series: null, ro: null, mounted: false };
  try { const saved = store.get("md_ws", null); if (saved) { W.range = saved.range || W.range; W.layout = C.LAYOUTS.includes(saved.layout) ? saved.layout : W.layout; W.sym = saved.sym || null; } } catch {}
  const save = () => { try { store.set("md_ws", { sym: W.sym, range: W.range, layout: W.layout }); } catch {} };

  const CSS = `
#tab-workspace .ws-top{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:12px}
#tab-workspace .ws-kick{font-family:var(--mono);font-size:11px;letter-spacing:.22em;color:var(--orange)}
#tab-workspace h1{margin:2px 0 0;font-size:24px}
#tab-workspace .ws-sub{margin:2px 0 0;color:var(--muted);font-size:13px}
#tab-workspace .ws-ctl{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#tab-workspace .ws-form{display:flex;gap:6px}
#tab-workspace .ws-form input{width:130px;background:var(--panel2);border:1px solid var(--line2);border-radius:6px;padding:7px 10px;font-family:var(--mono);text-transform:uppercase}
#tab-workspace .ws-seg{display:inline-flex;border:1px solid var(--line2);border-radius:7px;overflow:hidden}
#tab-workspace .ws-seg button{background:none;border:0;padding:6px 10px;color:var(--muted);cursor:pointer;font-size:12px}
#tab-workspace .ws-seg button.on{background:var(--panel2);color:var(--text)}
#tab-workspace .ws-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
#tab-workspace .ws-chips button{background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-family:var(--mono);font-size:12px;color:var(--muted);cursor:pointer}
#tab-workspace .ws-chips button.on{border-color:var(--orange);color:var(--text)}
#tab-workspace .ws-grid{display:grid;gap:12px;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)}
#tab-workspace .ws-grid.focus{grid-template-columns:minmax(0,2.2fr) minmax(0,1fr)}
#tab-workspace .ws-grid.focus .ws-chart{grid-row:span 2}
#tab-workspace .ws-grid.focus .ws-chart .ws-plot{height:520px}
#tab-workspace .ws-grid.focus .ws-finp{grid-column:1/-1}
#tab-workspace .ws-p{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0;display:flex;flex-direction:column}
#tab-workspace .ws-ph{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
#tab-workspace .ws-ph h2{margin:0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600}
#tab-workspace .ws-ph button{background:none;border:0;color:var(--orange);cursor:pointer;font-size:12px;padding:0}
#tab-workspace .ws-plot{height:300px;position:relative}
#tab-workspace .ws-big{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
#tab-workspace .ws-big b{font-family:var(--mono);font-size:24px}
#tab-workspace .ws-name{color:var(--muted);font-size:13px}
#tab-workspace .up{color:var(--up)} #tab-workspace .down{color:var(--down)}
#tab-workspace .ws-stats{display:grid;grid-template-columns:1fr auto;gap:5px 12px;font-size:13px}
#tab-workspace .ws-stats span{color:var(--muted)} #tab-workspace .ws-stats b{font-family:var(--mono);font-weight:500;text-align:right}
#tab-workspace .ws-news{list-style:none;margin:0;padding:0;overflow:auto;max-height:330px}
#tab-workspace .ws-news li{padding:7px 0;border-bottom:1px solid var(--line)}
#tab-workspace .ws-news li:last-child{border-bottom:0}
#tab-workspace .ws-news a{display:block;font-size:13px;line-height:1.35;color:var(--text)}
#tab-workspace .ws-news a:hover{text-decoration:underline}
#tab-workspace .ws-news small{color:var(--dim);font-size:11px}
#tab-workspace .ws-fin{width:100%;border-collapse:collapse;font-size:13px}
#tab-workspace .ws-fin th,#tab-workspace .ws-fin td{padding:5px 6px;text-align:right;border-bottom:1px solid var(--line);font-family:var(--mono);font-weight:500}
#tab-workspace .ws-fin th:first-child,#tab-workspace .ws-fin td:first-child{text-align:left;font-family:var(--sans);color:var(--muted)}
#tab-workspace .ws-scroll{overflow-x:auto;max-width:100%}
#tab-workspace .ws-note{color:var(--dim);font-size:11px;margin-top:8px}
#tab-workspace .ws-empty{color:var(--muted);font-size:13px;padding:18px 0}
@media (max-width:900px){#tab-workspace .ws-grid,#tab-workspace .ws-grid.focus{grid-template-columns:minmax(0,1fr)}#tab-workspace .ws-grid.focus .ws-chart{grid-row:auto}#tab-workspace .ws-top{align-items:flex-start}#tab-workspace .ws-fin{font-size:12px}#tab-workspace .ws-fin th,#tab-workspace .ws-fin td{padding:5px 4px}#tab-workspace .ws-grid.focus .ws-chart .ws-plot{height:300px}}
`;

  const el = () => $("tab-workspace");
  const panel = (key) => el().querySelector(`[data-ws="${key}"]`);
  const loading = (msg) => `<div class="ws-empty"><span class="spin"></span> ${esc(msg)}</div>`;
  const fail = (what, e) => `<div class="ws-empty">${esc(what)} unavailable right now${e && e.message ? ` (${esc(e.message)})` : ""}.</div>`;

  function mount() {
    if (W.mounted && panel("chart")) return;
    W.mounted = true;
    if (!document.getElementById("wsStyle")) { const s = document.createElement("style"); s.id = "wsStyle"; s.textContent = CSS; document.head.appendChild(s); }
    el().innerHTML = `<div class="ws-top"><div><div class="ws-kick">RESEARCH · WORKSPACE</div><h1>Workspace</h1>
      <p class="ws-sub">One ticker, every view at once: chart, key stats, latest news and SEC financials.</p></div>
      <div class="ws-ctl"><form class="ws-form" id="wsForm" autocomplete="off"><input id="wsSym" maxlength="12" placeholder="Ticker" aria-label="Ticker"><button class="btn">Open</button></form>
      <div class="ws-seg" role="group" aria-label="Chart range">${C.RANGES.map(([r, l]) => `<button type="button" data-wsr="${r}">${l}</button>`).join("")}</div>
      <div class="ws-seg" role="group" aria-label="Layout"><button type="button" data-wsl="grid">Grid</button><button type="button" data-wsl="focus">Focus</button></div></div></div>
      <div class="ws-chips" id="wsChips" aria-label="Your watchlist"></div>
      <div class="ws-grid" id="wsGrid">
        <section class="ws-p ws-chart"><div class="ws-ph"><h2>Price</h2><button type="button" data-wsgo="research">Full research →</button></div><div data-ws="head"></div><div class="ws-plot" data-ws="chart"></div></section>
        <section class="ws-p"><div class="ws-ph"><h2>Key stats</h2></div><div data-ws="stats"></div></section>
        <section class="ws-p"><div class="ws-ph"><h2>Latest news</h2><button type="button" data-wsgo="news">All news →</button></div><div data-ws="news"></div></section>
        <section class="ws-p ws-finp"><div class="ws-ph"><h2>Financials (SEC 10-K)</h2><span><button type="button" data-wsgo="fin">Financials →</button> &nbsp; <button type="button" data-wsgo="dcf">DCF →</button></span></div><div data-ws="fin"></div></section>
      </div>`;
    $("wsForm").onsubmit = (e) => { e.preventDefault(); const s = C.normalizeSymbol($("wsSym").value); if (s) open(s); else $("wsSym").select(); };
    el().addEventListener("click", (e) => {
      const r = e.target.closest("[data-wsr]"); if (r) { W.range = r.dataset.wsr; save(); syncControls(); loadChart(W.sym, W.req); return; }
      const l = e.target.closest("[data-wsl]"); if (l) { W.layout = l.dataset.wsl; save(); syncControls(); return; }
      const c = e.target.closest("[data-wssym]"); if (c) { open(c.dataset.wssym); return; }
      const n = e.target.closest("[data-wsnews]"); if (n) { const it = W.news && W.news[+n.dataset.wsnews]; if (it && typeof window.openReader === "function" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); window.openReader(it); } return; }
      const g = e.target.closest("[data-wsgo]"); if (g) go(g.dataset.wsgo);
    });
  }

  function go(where) {
    const s = W.sym; if (!s) return;
    if (where === "research") { setTab("research"); openQuote(s); return; }
    if (where === "news") { S.q = s; setTab("news"); if (typeof renderFeed === "function") renderFeed(); return; }
    if (where === "fin" || where === "dcf") { setTab(where); const f = $(where + "Sym"); if (f) { f.value = s; $(where + "Form").requestSubmit(); } }
  }

  function syncControls() {
    el().querySelectorAll("[data-wsr]").forEach((b) => b.classList.toggle("on", b.dataset.wsr === W.range));
    el().querySelectorAll("[data-wsl]").forEach((b) => b.classList.toggle("on", b.dataset.wsl === W.layout));
    $("wsGrid").className = "ws-grid" + (W.layout === "focus" ? " focus" : "");
    $("wsChips").innerHTML = (S.wl || []).slice(0, 10).map((s) => `<button type="button" data-wssym="${esc(s)}" class="${s === W.sym ? "on" : ""}">${esc(s)}</button>`).join("");
    if (W.sym && document.activeElement !== $("wsSym")) $("wsSym").value = W.sym;
  }

  function open(sym) {
    W.sym = sym; save(); syncControls();
    const id = ++W.req;
    loadQuoteAndStats(sym, id); loadChart(sym, id); loadNews(sym, id); loadFin(sym, id);
  }

  async function loadQuoteAndStats(sym, id) {
    panel("head").innerHTML = ""; panel("stats").innerHTML = loading("Loading quote…");
    const [q, sum] = await Promise.all([
      api("/api/quotes?symbols=" + encodeURIComponent(sym)).then((j) => j.quotes && j.quotes[sym]).catch((e) => ({ error: true, message: e.message })),
      C.isEquity(sym) ? api("/api/summary?symbol=" + encodeURIComponent(sym)).catch(() => null) : Promise.resolve(null),
    ]);
    if (id !== W.req) return;
    if (!q || q.error) { panel("stats").innerHTML = fail("Quote", q); return; }
    panel("head").innerHTML = `<div class="ws-big"><b>${esc(C.keyStats(q, sum)[0][1])}</b><span class="${C.tone(q.changePct)}">${esc(C.pctText(q.changePct, 2))}</span><span class="ws-name">${esc(sym)} · ${esc(q.name || "")}</span></div>`;
    const pos = C.rangePosition(q);
    const rows = C.keyStats(q, sum).slice(1);
    if (pos != null) rows.splice(3, 0, ["52-week position", `${pos.toFixed(0)}% of range`, ""]);
    panel("stats").innerHTML = `<div class="ws-stats">${rows.map(([l, v, t]) => `<span>${esc(l)}</span><b class="${t}">${esc(v)}</b>`).join("")}</div>`
      + `<div class="ws-note">Prices from Yahoo Finance; may be delayed${q.marketTime ? ` · as of ${esc(new Date(q.marketTime).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} ET` : ""}.</div>`;
  }

  async function loadChart(sym, id) {
    if (!sym) return;
    const box = panel("chart");
    let h; try { h = await api(`/api/history?symbol=${encodeURIComponent(sym)}&range=${W.range}`); } catch (e) { if (id === W.req) { dropChart(); box.innerHTML = fail("Price history", e); } return; }
    if (id !== W.req) return;
    const pts = C.chartPoints(h.candles);
    if (pts.length < 2) { dropChart(); box.innerHTML = `<div class="ws-empty">No price history for ${esc(sym)} in this range yet.</div>`; return; }
    const ret = C.periodReturn(pts), up = ret == null || ret >= 0;
    const line = getComputedStyle(document.documentElement).getPropertyValue(up ? "--up" : "--down").trim() || (up ? "#21c37a" : "#ff4d5e");
    if (window.LightweightCharts) {
      if (!W.chart || !box.contains(W.chart._el)) {
        dropChart(); box.innerHTML = "";
        W.chart = LightweightCharts.createChart(box, { autoSize: true,
          layout: { background: { type: "solid", color: "transparent" }, textColor: "#8b95a3", fontFamily: "IBM Plex Mono, monospace" },
          grid: { vertLines: { color: "#1c2129" }, horzLines: { color: "#1c2129" } },
          rightPriceScale: { borderColor: "#2d3540" }, timeScale: { borderColor: "#2d3540" }, crosshair: { mode: 0 } });
        W.chart._el = box.firstElementChild;
        W.series = W.chart.addAreaSeries({ lineWidth: 2, priceLineVisible: false });
      }
      W.series.applyOptions({ lineColor: line, topColor: line + "44", bottomColor: line + "05" });
      W.series.setData(pts); W.chart.timeScale().fitContent();
    } else {
      dropChart(); // chart library unavailable: simple line so the panel still shows the trend
      const lo = Math.min(...pts.map((p) => p.value)), hi = Math.max(...pts.map((p) => p.value)), n = pts.length - 1;
      const d = pts.map((p, i) => `${i ? "L" : "M"}${((i / n) * 600).toFixed(1)},${(280 - ((p.value - lo) / (hi - lo || 1)) * 260).toFixed(1)}`).join("");
      box.innerHTML = `<svg viewBox="0 0 600 290" preserveAspectRatio="none" style="width:100%;height:100%"><path d="${d}" fill="none" stroke="${line}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
    }
    const label = (C.RANGES.find(([r]) => r === W.range) || [, ""])[1];
    box.setAttribute("aria-label", `${sym} price, ${label}: ${ret == null ? "" : C.pctText(ret)} over the period`);
  }
  function dropChart() { if (W.chart) { try { W.chart.remove(); } catch {} W.chart = null; W.series = null; } }

  async function loadNews(sym, id) {
    panel("news").innerHTML = loading("Loading headlines…");
    let j; try { j = await api("/api/news?tickers=" + encodeURIComponent(sym) + "&range=week"); } catch (e) { if (id === W.req) panel("news").innerHTML = fail("News", e); return; }
    if (id !== W.req) return;
    W.news = C.pickNews(j.items, sym, 12);
    const src = (k) => (typeof SRC !== "undefined" && SRC[k] ? SRC[k].name : k || "");
    panel("news").innerHTML = W.news.length
      ? `<ul class="ws-news">${W.news.map((i, k) => `<li><a href="${esc(i.link)}" target="_blank" rel="noopener" data-wsnews="${k}">${esc(i.title)}</a><small>${esc(src(i.source))}${i.time ? " · " + esc(C.relTime(i.time)) : ""}</small></li>`).join("")}</ul>`
      : `<div class="ws-empty">No headlines tagged ${esc(sym)} in the past week.</div>`;
  }

  async function loadFin(sym, id) {
    if (!C.isEquity(sym)) { panel("fin").innerHTML = `<div class="ws-empty">SEC financials cover U.S.-listed companies; ${esc(sym)} isn't one.</div>`; return; }
    panel("fin").innerHTML = loading("Reading 10-K data from the SEC…");
    let sec; try { sec = typeof fxSec === "function" ? await fxSec(sym) : await api("/api/pub/sec?symbol=" + encodeURIComponent(sym)); } catch (e) { if (id === W.req) panel("fin").innerHTML = fail("SEC data", e); return; }
    if (id !== W.req) return;
    const f = C.finSummary(sec);
    if (!f) { panel("fin").innerHTML = `<div class="ws-empty">${esc((sec && sec.reason) || `No annual 10-K figures for ${sym} yet.`)}</div>`; return; }
    const row = (label, key, fmtv, toned) => `<tr><td>${label}</td>${f.cols.map((c) => `<td class="${toned ? C.tone(c[key]) : ""}">${esc(fmtv(c[key]))}</td>`).join("")}</tr>`;
    panel("fin").innerHTML = `<div class="ws-scroll"><table class="ws-fin"><thead><tr><th></th>${f.cols.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>
      ${row("Revenue", "revenue", (v) => C.compact(v, "$"))}${row("Revenue growth", "revenueGrowth", (v) => C.pctText(v), true)}
      ${row("Net income", "netIncome", (v) => C.compact(v, "$"), true)}${row("Net margin", "netMargin", (v) => (v == null ? C.DASH : v.toFixed(1) + "%"))}
      ${row("Free cash flow", "fcf", (v) => C.compact(v, "$"), true)}</tbody></table></div>
      <div class="ws-note">SEC EDGAR XBRL${f.form ? ` · latest ${esc(f.form)}` : ""}${f.filed ? ` filed ${esc(f.filed)}` : ""}${f.currency !== "USD" ? ` · ${esc(f.currency)}` : ""}. Growth and margins are calculated from the reported figures.</div>`;
  }

  window.wsOpen = function () {
    mount(); syncControls();
    const start = W.sym || (S.sel && C.normalizeSymbol(S.sel)) || "AAPL";
    if (start !== W.sym || !panel("chart").childElementCount) open(start);
  };
  if (S.tab === "workspace") window.wsOpen(); // the page opened straight on #workspace
})();

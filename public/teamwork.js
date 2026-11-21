/* Bots × spider teamwork UI (owner / private desk only; the server 404s these routes for visitors).
 *  - Morning brief pop-up (once a day, and from the ☀ Brief button): overnight spider findings, each bot's plan for the open, today's earnings, risk flags,
 *    plus the spider-vs-no-spider twin, lessons from losing trades and recent pre-buy checks.
 *  - Research → "Why" subtab: every bot's view of one stock and the spider's evidence.
 * Thin UI: all rules live in bot-teamwork-core.js on the server. Nothing here is estimated. */
(function () {
  "use strict";
  if (window.__VISITOR || typeof S === "undefined") return;
  const h = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const money = (n) => (Number.isFinite(n) ? (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—");
  const pts = (n) => (Number.isFinite(n) ? (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(2) + "%" : "—");
  const cls = (n) => (Number.isFinite(n) ? (n >= 0 ? "up" : "down") : "");
  const when = (t) => (t ? new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "—");
  const get = (p) => fetch(p, { credentials: "same-origin" }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; });
  const src = (s) => (s && s.length ? ` <span class="tw-src">${h(s.map((x) => x.name).filter(Boolean).slice(0, 2).join(", "))}</span>` : "");
  const toneCls = (t) => (t > 0 ? "up" : t < 0 ? "down" : "");
  const LV = { high: "High", med: "Watch", low: "Note" };

  const css = document.createElement("style");
  css.textContent = `.tw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-top:12px}
.tw-card{background:var(--panel,#121212);border:1px solid var(--line,#2a2a2a);border-radius:10px;padding:14px}
.tw-card h3{margin:0 0 10px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--orange,#ff991f)}
.tw-row{padding:7px 0;border-top:1px solid var(--line,#222);font-size:13px;line-height:1.4}.tw-row:first-of-type{border-top:0}
.tw-src,.tw-dim{color:var(--muted,#8a8a8a);font-size:11.5px}.tw-flag{display:inline-block;min-width:44px;font-size:10.5px;font-weight:700;text-transform:uppercase;margin-right:6px}
.tw-flag.high{color:var(--down,#ff5a5a)}.tw-flag.med{color:var(--orange,#ff991f)}.tw-flag.low{color:var(--muted,#8a8a8a)}
.tw-big{font-size:22px;font-weight:700}.tw-kv{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:4px 0}
.tw-tag{display:inline-block;border:1px solid var(--line,#333);border-radius:999px;padding:1px 8px;font-size:11px;margin:0 4px 4px 0}
#briefModal .modal-box{width:min(1180px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:20px}
.tw-head{display:flex;align-items:flex-start;gap:10px}.tw-head>div{flex:1}.tw-head h2{margin:4px 0 6px;font-size:22px}
.tw-v-veto{color:var(--down,#ff5a5a);font-weight:700}.tw-v-ok{color:var(--up,#3ddc84);font-weight:700}.tw-v-caution{color:var(--orange,#ff991f);font-weight:700}`;
  document.head.appendChild(css);

  // ---------------------------------------------------------------- Morning Brief
  let briefBusy = false;
  function modal() {
    let m = document.getElementById("briefModal");
    if (!m) {
      m = document.createElement("div"); m.className = "modal"; m.id = "briefModal"; m.hidden = true;
      m.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true" aria-label="Morning brief"></div>';
      m.onclick = (e) => { if (e.target === m || e.target.closest("[data-tw-close]")) m.hidden = true; };
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") m.hidden = true; });
      document.body.appendChild(m);
    }
    return m;
  }
  async function openBrief() {
    if (briefBusy) return;
    const m = modal(), el = m.firstElementChild; m.hidden = false;
    el.innerHTML = '<div class="fx-empty"><span class="spin"></span> Putting the morning brief together…</div>';
    briefBusy = true;
    try {
      const [b, ap] = await Promise.all([get("/api/brief"), get("/api/autopilot").catch(() => null)]);
      el.innerHTML = briefHtml(b, ap && ap.teamwork);
      const r = el.querySelector("[data-tw-refresh]"); if (r) r.onclick = () => openBrief(true);
      el.querySelectorAll("[data-tw-sym]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); m.hidden = true; if (typeof openQuote === "function") { openQuote(a.dataset.twSym); S.rq.sub = "why"; if (typeof setTab === "function") setTab("research"); } }));
    } catch (e) {
      el.innerHTML = `<div class="tw-head"><div></div><button class="ac-x" data-tw-close aria-label="Close">✕</button></div><div class="fx-empty">The morning brief is unavailable: ${h(e.message)}. It needs the private desk (the bots and the spider run on the server).</div>`;
    } finally { briefBusy = false; }
  }
  const symLink = (s) => `<a href="#research/${h(s)}" data-tw-sym="${h(s)}">${h(s)}</a>`;
  function briefHtml(b, tw) {
    const flags = b.flags.length ? b.flags.map((f) => `<div class="tw-row"><span class="tw-flag ${f.level}">${LV[f.level]}</span>${h(f.text)}</div>`).join("") : '<div class="tw-row tw-dim">No risk flags this morning.</div>';
    const found = b.overnight.length ? b.overnight.map((d) => `<div class="tw-row"><span class="${toneCls(d.tone)}">${d.tone > 0 ? "▲" : d.tone < 0 ? "▼" : "•"}</span> ${h(d.headline)} ${(d.tickers || []).slice(0, 3).map(symLink).join(" ")}<br><span class="tw-dim">${h(d.cat)} · ${when(d.at)}</span>${src(d.sources)}</div>`).join("") : '<div class="tw-row tw-dim">The spider has no new findings since the last close.</div>';
    const plans = b.plans.map((p) => `<div class="tw-row"><b>${h(p.bot)}</b>${p.at ? ` <span class="tw-dim">· planned ${when(p.at)}</span>` : ""}${p.orders.length ? p.orders.slice(0, 10).map((o) => `<div><span class="${o.side === "BUY" ? "up" : "down"}">${h(o.side)}</span> ${symLink(o.sym)} ${o.amount ? money(o.amount) : ""} <span class="tw-dim">${h(String(o.why || "").slice(0, 150))}</span></div>`).join("") : `<div class="tw-dim">${h(p.empty)}</div>`}</div>`).join("");
    const earn = b.earningsToday.length ? b.earningsToday.slice(0, 14).map((e) => `<div class="tw-kv"><span>${symLink(e.sym)}${e.relevant ? ' <span class="tw-tag">held / on the bots\' list</span>' : ""}</span><span class="tw-dim">${e.hour === "bmo" ? "before the open" : e.hour === "amc" ? "after the close" : "time not given"}${e.epsEstimate != null ? ` · EPS est. ${e.epsEstimate}` : ""}</span></div>`).join("") : '<div class="tw-row tw-dim">No earnings reports on the calendar today (Finnhub).</div>';
    return `<div class="tw-head"><div><div class="fx-kick">☀ MORNING BRIEF · ${h(b.day)}</div><h2>Before the opening bell</h2>
      <div class="tw-dim">Generated ${when(b.generatedAt)}. ${h(b.note)}</div></div><button class="btn ghost" data-tw-refresh>Refresh</button><button class="ac-x" data-tw-close aria-label="Close">✕</button></div>
      <div class="tw-grid">
        <section class="tw-card"><h3>Risk flags</h3>${flags}</section>
        <section class="tw-card"><h3>Bot plans for the open</h3>${plans}</section>
        <section class="tw-card"><h3>Spider: overnight findings</h3>${found}</section>
        <section class="tw-card"><h3>Earnings today</h3>${earn}</section>
        ${tw ? teamHtml(tw) : ""}
      </div>`;
  }
  function teamHtml(tw) {
    const t = tw.twin, c = t && t.compare;
    const twin = c ? `<div class="tw-kv"><span>With the spider (real swing bot)</span><b class="${cls(c.realRet)}">${pts(c.realRet)}</b></div>
      <div class="tw-kv"><span>Without the spider (twin)</span><b class="${cls(c.twinRet)}">${pts(c.twinRet)}</b></div>
      <div class="tw-kv"><span>Difference</span><b class="${cls(c.diffPts)}">${pts(c.diffPts)}</b></div>
      <div class="tw-row"><b>${h(c.verdict)}</b> <span class="tw-dim">since ${when(t.since)} · ${t.trades.length} twin trades</span><br><span class="tw-dim">${h(c.note)}</span></div>`
      : '<div class="tw-row tw-dim">The no-spider twin starts at the next market-hours scan.</div>';
    const pm = tw.postMortems || {}, causes = Object.entries(pm.causes || {}).sort((a, b) => b[1] - a[1]);
    const lessons = (pm.lessons || []).length ? pm.lessons.map((l) => `<div class="tw-kv"><span><span class="tw-tag">${h(l.tag)}</span> ${l.n} trades, ${Math.round(l.winRate * 100)}% won, ${money(l.pnl)}</span><b class="down">${l.penalty.toFixed(2)}</b></div>`).join("") : '<div class="tw-row tw-dim">No losing pattern has enough trades to count yet.</div>';
    const losses = (pm.losses || []).slice(0, 6).map((x) => `<div class="tw-row">${symLink(x.sym)} <span class="down">${money(x.pnl)}</span> after ${x.days}d — <b>${h(x.label)}</b><br><span class="tw-dim">${(x.tags || []).map((g) => h(g)).join(" · ")}</span></div>`).join("");
    const checks = (tw.checks || []).length ? tw.checks.slice(0, 8).map((k) => `<div class="tw-row">${symLink(k.sym)} <span class="tw-v-${k.verdict}">${k.verdict === "veto" ? "Vetoed" : "Caution"}</span> <span class="tw-dim">#${k.rank} · ${when(k.t)}</span><br>${h(k.note)}${(k.evidence || []).map((e) => `<div class="tw-dim">• ${h(e.headline)}${e.source ? ` (${h(e.source)})` : ""}</div>`).join("")}</div>`).join("") : '<div class="tw-row tw-dim">No buy has been vetoed or flagged yet.</div>';
    return `<section class="tw-card"><h3>Does the spider help? (hypothetical)</h3>${twin}</section>
      <section class="tw-card"><h3>Lessons from losing trades</h3><div class="tw-dim" style="margin-bottom:6px">${pm.closed || 0} closed swing trades reviewed${causes.length ? " · losses by cause: " + causes.map(([k, n]) => `${h(k)} ${n}`).join(", ") : ""}</div>${lessons}${losses}<div class="tw-dim" style="margin-top:6px">${h(pm.rule || "")}</div></section>
      <section class="tw-card"><h3>Spider pre-buy checks</h3>${checks}</section>`;
  }

  // ---------------------------------------------------------------- Research → Why
  const whyCache = new Map();
  async function why(el, sym) {
    el.innerHTML = '<div class="fx-empty"><span class="spin"></span> Asking every bot and the spider about ' + h(sym) + "…</div>";
    try {
      const c = whyCache.get(sym), w = c && Date.now() - c.at < 60e3 ? c.w : await get("/api/why?symbol=" + encodeURIComponent(sym));
      whyCache.set(sym, { at: Date.now(), w });
      if (S.rq && S.rq.sym === sym && S.rq.sub === "why") el.innerHTML = whyHtml(w);
    } catch (e) { el.innerHTML = `<div class="fx-empty">The Why card is unavailable: ${h(e.message)}.</div>`; }
  }
  const trades = (L) => (L && L.length ? L.map((t) => `<div class="tw-dim"><span class="${t.side === "BUY" ? "up" : "down"}">${h(t.side)}</span> ${when(t.t)} @ ${Number.isFinite(t.price) ? "$" + t.price.toFixed(2) : "—"}${t.pnl != null ? ` <span class="${cls(t.pnl)}">${money(t.pnl)}</span>` : ""} — ${h(String(t.why || "").slice(0, 140))}</div>`).join("") : '<div class="tw-dim">No trades in this stock.</div>');
  function whyHtml(w) {
    const sw = w.swing, x = sw.scanned;
    const swing = `<section class="tw-card"><h3>Swing bot</h3>${x ? `<div class="tw-kv"><span>Rank</span><b>#${x.rank} of ${x.of} · ${h(x.sleeve === "safe" ? "safe" : "high-risk")} sleeve</b></div>
      <div class="tw-kv"><span>Score</span><b>${x.score}</b></div>
      <div class="tw-kv"><span>Analysts / 3-mo momentum / trend</span><b>${x.analysts ?? "—"} / ${Number.isFinite(x.momentum3m) ? pts(x.momentum3m * 100) : "—"} / ${x.trend}</b></div>
      <div class="tw-kv"><span>News score</span><b class="${cls(x.news)}">${x.news}</b></div>${x.headline ? `<div class="tw-dim">“${h(x.headline)}”</div>` : ""}
      <div class="tw-kv"><span>10-K grade · ratios</span><b>${x.grade || "—"} · ${x.ratios ?? "—"}</b></div>
      <div class="tw-kv"><span>Spider nudge</span><b class="${cls(x.spiderNudge)}">${x.spiderNudge ?? "none"}</b></div>
      ${x.lesson ? `<div class="tw-kv"><span>Lesson penalty (${h(x.lesson.tags.join(", "))})</span><b class="down">${x.lesson.penalty}</b></div>` : ""}
      ${x.check ? `<div class="tw-row">Pre-buy check: <span class="tw-v-${h(x.check.verdict)}">${h(x.check.verdict)}</span> — ${h(x.check.note)}</div>` : ""}
      ${x.earnNext ? `<div class="tw-row">Next earnings ${h(x.earnNext.date)} (${x.earnNext.days} trading days)</div>` : ""}
      <div class="tw-dim">Scanned ${when(x.at)}</div>` : `<div class="tw-dim">${h(sw.note)}</div>`}
      <div class="tw-row"><b>Holding:</b> ${sw.holding ? `${sw.holding.shares.toFixed(2)} sh @ $${sw.holding.cost.toFixed(2)} since ${when(sw.holding.since)}` : "no"}</div>
      ${sw.plans.length ? `<div class="tw-row"><b>Plans:</b> ${sw.plans.map((p) => `${h(p.side)} — ${h(p.when)}: ${h(String(p.why || "").slice(0, 140))}`).join("<br>")}</div>` : ""}
      <div class="tw-row">${trades(sw.trades)}</div></section>`;
    const q = w.quant;
    const quant = `<section class="tw-card"><h3>Quant trader</h3><div class="tw-kv"><span>Regime</span><b>${h(q.regime || "—")}${q.rawRegime && q.rawRegime !== q.regime ? ` <span class="tw-dim">(raw: ${h(q.rawRegime)})</span>` : ""}</b></div>
      ${q.inUniverse ? `<div class="tw-kv"><span>Target weight</span><b>${q.target != null ? (q.target * 100).toFixed(1) + "%" : "—"}</b></div>${q.ranked ? `<div class="tw-kv"><span>Factor score</span><b>${q.ranked.score}${q.ranked.picked ? " · picked" : q.ranked.trend ? "" : " · below 200-day"}</b></div>` : ""}` : '<div class="tw-dim">Not in the quant universe (ETFs, mega-caps, bonds, gold, T-bills).</div>'}
      <div class="tw-row"><b>Holding:</b> ${q.holding ? `${q.holding.shares.toFixed(2)} sh @ $${q.holding.cost.toFixed(2)}` : "no"}${q.queued.length ? ` · queued: ${q.queued.map((o) => h(o.side)).join(", ")}` : ""}</div><div class="tw-row">${trades(q.trades)}</div></section>`;
    const d = w.day;
    const day = `<section class="tw-card"><h3>Day trader</h3><div class="tw-row"><b>Holding:</b> ${d.holding ? `${h(d.holding.dir)} ${d.holding.shares} sh · ${h(d.holding.setup || "")} — ${h(d.holding.why || "")}` : "no"}${d.queued ? " · entry queued" : ""}</div><div class="tw-row">${trades(d.trades)}</div></section>`;
    const sp = w.spider;
    const spider = sp ? `<section class="tw-card"><h3>Spider evidence</h3>
      <div class="tw-kv"><span>Research signal (all findings)</span>${sp.signal.n ? `<b class="${sp.signal.score ? cls(sp.signal.score) : ""}">${sp.signal.score} · ${sp.signal.n} finding${sp.signal.n === 1 ? "" : "s"}</b>` : '<b class="tw-dim">no findings yet</b>'}</div>
      <div class="tw-kv"><span>Last researched</span><b>${when(sp.lastResearched)}</b></div>
      ${sp.signals.map((s) => `<div class="tw-row"><b class="${s.dir < 0 ? "down" : s.dir > 0 ? "up" : ""}">${h(s.name)}</b><br><span class="tw-dim">${h(s.calc)}</span>${s.inputs.slice(0, 2).map((i) => `<div class="tw-dim">• ${h(i.headline)}${src(i.sources)}</div>`).join("")}</div>`).join("")}
      ${sp.developments.map((dv) => `<div class="tw-row"><span class="${toneCls(dv.tone)}">${dv.tone > 0 ? "▲" : dv.tone < 0 ? "▼" : "•"}</span> ${h(dv.headline)} <span class="tw-dim">${when(dv.t)}</span>${src(dv.sources)}</div>`).join("") || '<div class="tw-row tw-dim">No findings in the last 14 days.</div>'}
      ${sp.catalysts.length ? `<div class="tw-row"><b>Catalysts:</b> ${sp.catalysts.slice(0, 3).map(h).join(" · ")}</div>` : ""}
      <div class="tw-dim">${h(sp.note)}</div></section>` : '<section class="tw-card"><h3>Spider evidence</h3><div class="tw-dim">The spider isn\'t running on this server.</div></section>';
    return `<div class="tw-dim">Why each bot thinks what it does about <b>${h(w.sym)}</b> · ${h(w.note)}</div><div class="tw-grid">${swing}${spider}${quant}${day}</div>`;
  }

  window.MDTeam = { openBrief, why };
  // pops up by itself once per (New York) day, the first time the desk is opened
  try {
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (!document.documentElement.classList.contains("pane") && localStorage.getItem("md_brief_seen") !== day) { localStorage.setItem("md_brief_seen", day); openBrief(); }
  } catch {}
  if (S.tab === "research" && S.rq && S.rq.sub === "why" && typeof renderResearchBody === "function") renderResearchBody();
})();

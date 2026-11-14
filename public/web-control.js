/* THE WEB · Spider Control Center: every control does something real on the server spider.
   - Research now: queues a news sweep, a market pulse and a portfolio scan as manual jobs (they run even when paused).
   - Research company: queues a company snapshot for a ticker.
   - Pause / resume, research frequency, monitored companies and sectors, which recurring jobs run, notifications.
   - Live monitor: the job running now, its phase, the queue, finished and failed jobs, budget, storage.
   - Research timeline: search and filter everything the spider has found; click a company for its timeline.
   - Backup: download the research memory as JSON, or restore it from a file. */
(function () {
  "use strict";
  if (typeof S === "undefined" || (typeof VIEW !== "undefined" && VIEW)) return;
  const SECTORS11 = ["Information Technology", "Communication Services", "Consumer Discretionary", "Consumer Staples", "Financials", "Health Care", "Industrials", "Energy", "Utilities", "Real Estate", "Materials"];
  const C = { st: null, poll: 0, f: { q: "", cat: "", min: 0, mine: false, since: 0, kind: "" }, tl: null, lastNote: +localStorage.getItem("md_sp_seen") || Date.now() };
  const post = (u, b) => api(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
  const tago = (t) => (typeof ago === "function" ? ago(t) : new Date(t).toLocaleString());

  function mount() {
    const box = $("twb"), modes = $("twbModes"); if (!box || !modes || $("twbCtl")) return !!$("twbCtl");
    modes.insertAdjacentHTML("beforeend", `<button data-m="ctl">⚙ Control center</button>`);
    box.insertAdjacentHTML("beforeend", `<div class="twb-ctl" id="twbCtl" hidden></div>`);
    modes.addEventListener("click", (e) => { const b = e.target.closest("[data-m]"); if (!b) return; const on = b.dataset.m === "ctl"; $("twbCtl").hidden = !on; modes.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("on", x === b)); if (on) open(); else close(); }, true);
    return true;
  }
  function close() { clearInterval(C.poll); C.poll = 0; }
  function open() {
    const el = $("twbCtl");
    el.innerHTML = `<div class="ctl-grid">
      <section class="ctl-card ctl-act"><h3>Research</h3>
        <div class="ctl-row"><button class="ctl-btn hot" id="ctlNow">⚡ Research now</button><span class="ctl-msg" id="ctlNowMsg">Runs a news sweep, a market check and a portfolio scan right away.</span></div>
        <form class="ctl-row" id="ctlCo"><input id="ctlSym" placeholder="Ticker, e.g. NVDA" maxlength="10" autocomplete="off"><button class="ctl-btn">🔎 Research company</button><span class="ctl-msg" id="ctlCoMsg"></span></form>
        <div class="ctl-row"><button class="ctl-btn" id="ctlPause"></button><label>Frequency <select id="ctlFreq"><option value="0.5">Faster (2×)</option><option value="1">Normal</option><option value="2">Slower (½×)</option><option value="4">Much slower (¼×)</option></select></label>
          <label class="ctl-chk"><input type="checkbox" id="ctlNotify"> Notify me about findings on my stocks</label><button class="ctl-btn" id="ctlBrief">📰 Generate briefing</button></div></section>
      <section class="ctl-card"><h3>Live monitor <em id="ctlState"></em></h3><div id="ctlRun"></div><div class="ctl-cols"><div><h4>Queue</h4><div id="ctlQueue"></div></div><div><h4>Finished</h4><div id="ctlDone"></div></div><div><h4>Failed</h4><div id="ctlFail"></div></div></div><div class="ctl-stats" id="ctlStats"></div></section>
      <section class="ctl-card"><h3>What the spider watches</h3>
        <label class="ctl-lab">Extra companies to monitor <em>besides your portfolio and watchlist</em><input id="ctlExtra" placeholder="e.g. TSM, ASML, AVGO"></label>
        <div class="ctl-lab">Sectors to monitor</div><div class="ctl-chips" id="ctlSec"></div>
        <div class="ctl-lab">Recurring research <em>untick to switch a job off</em></div><div class="ctl-jobs" id="ctlJobs"></div>
        <div class="ctl-row"><button class="ctl-btn" id="ctlSave">Save settings</button><span class="ctl-msg" id="ctlSaveMsg"></span></div></section>
      <section class="ctl-card ctl-tl"><h3>Research timeline</h3>
        <form class="ctl-filters" id="ctlF"><input id="ctlQ" placeholder="Search findings, company or ticker"><select id="ctlCat"><option value="">All types</option>${["company", "earnings", "filing", "insider", "fundamentals", "news", "mover", "sector", "macro", "policy", "market", "portfolio", "pattern"].map((x) => `<option>${x}</option>`).join("")}</select>
          <select id="ctlMin"><option value="0">Any importance</option><option value="0.5">Important+</option><option value="0.7">Very important</option></select><select id="ctlSince"><option value="0">Any date</option><option value="1">Last 24 h</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select>
          <select id="ctlKind"><option value="">Facts and interpretation</option><option value="fact">Verified facts</option><option value="interpretation">Interpretation</option><option value="estimate">Estimates</option><option value="speculation">Speculation</option></select><label class="ctl-chk"><input type="checkbox" id="ctlMine"> My portfolio only</label></form>
        <div id="ctlList"></div></section>
      <section class="ctl-card ctl-co" id="ctlCoCard" hidden></section>
      <section class="ctl-card"><h3>Backup</h3><p class="ctl-note" id="ctlStore"></p><div class="ctl-row"><a class="ctl-btn" href="/api/web/export" download>⬇ Download research memory</a><label class="ctl-btn ctl-file">⬆ Restore from file<input type="file" id="ctlImp" accept="application/json,.json" hidden></label><span class="ctl-msg" id="ctlImpMsg"></span></div></section>
    </div>`;
    $("ctlNow").onclick = async () => { const m = $("ctlNowMsg"); m.textContent = "Queuing…"; const r = [];
      for (const type of ["news_sweep", "market_pulse", "portfolio_scan"]) { try { const j = await post("/api/web/run", { type }); if (j.queued) r.push(type.replace("_", " ")); } catch (e) { m.textContent = String(e.message || e).replace(/^Error: /, ""); } }
      if (r.length) m.textContent = `Queued: ${r.join(", ")}. Watch the live monitor.`; load(); };
    $("ctlCo").onsubmit = async (e) => { e.preventDefault(); const s = $("ctlSym").value.trim().toUpperCase(), m = $("ctlCoMsg"); if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) { m.textContent = "Enter a ticker like NVDA."; return; }
      try { const j = await post("/api/web/run", { type: "company_snapshot", symbol: s }); m.textContent = j.queued ? `Queued research on ${s}.` : "Couldn't queue it."; showCompany(s); } catch (err) { m.textContent = String(err.message || err).replace(/^Error: /, ""); } load(); };
    $("ctlPause").onclick = async () => { await post("/api/web/control", { paused: !(C.st && C.st.ctrl && C.st.ctrl.paused) }); load(); };
    $("ctlFreq").onchange = async (e) => { await post("/api/web/control", { freq: +e.target.value }); load(); };
    $("ctlNotify").onchange = async (e) => { await post("/api/web/control", { notify: e.target.checked }); if (e.target.checked && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {}); };
    $("ctlBrief").onclick = async () => { try { await post("/api/web/briefing/generate"); toast("📰 The spider is writing a briefing — it appears in THE WEB summary shortly."); } catch (e) { toast(String(e.message || e).replace(/^Error: /, "")); } load(); };
    $("ctlSave").onclick = async () => { const ex = $("ctlExtra").value.split(/[\s,]+/).filter(Boolean), sec = [...$("ctlSec").querySelectorAll("button.on")].map((b) => b.dataset.s), off = [...$("ctlJobs").querySelectorAll("input:not(:checked)")].map((i) => i.dataset.j);
      try { await post("/api/web/control", { extra: ex, sectors: sec, off }); $("ctlSaveMsg").textContent = "Saved."; } catch (e) { $("ctlSaveMsg").textContent = String(e.message || e); } load(); };
    $("ctlSec").onclick = (e) => { const b = e.target.closest("button"); if (b) b.classList.toggle("on"); };
    $("ctlImp").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const m = $("ctlImpMsg"); m.textContent = "Restoring…";
      try { const j = await api("/api/web/import", { method: "POST", headers: { "content-type": "application/json" }, body: await f.text() }); m.textContent = `Restored ${j.added} finding${j.added === 1 ? "" : "s"} (${j.kept} already up to date). Memory now holds ${j.total}.`; list(); } catch (err) { m.textContent = String(err.message || err).replace(/^Error: /, ""); } };
    const fl = () => { C.f = { q: $("ctlQ").value.trim(), cat: $("ctlCat").value, min: +$("ctlMin").value, mine: $("ctlMine").checked, since: +$("ctlSince").value, kind: $("ctlKind").value }; list(); };
    $("ctlF").oninput = fl; $("ctlF").onchange = fl; $("ctlF").onsubmit = (e) => { e.preventDefault(); fl(); };
    $("ctlList").onclick = (e) => { const t = e.target.closest("[data-co]"); if (t) showCompany(t.dataset.co); };
    load(true); list(); clearInterval(C.poll); C.poll = setInterval(() => { if (!document.hidden && !$("twbCtl").hidden) load(); }, 4000);
  }
  async function load(first) {
    let st; try { st = await api("/api/web/status"); } catch { $("ctlRun").innerHTML = '<p class="ctl-note">Sign in to control the spider.</p>'; return; }
    C.st = st; const c = st.ctrl || {};
    $("ctlState").textContent = c.paused ? "· paused (automatic research off)" : `· ${st.state}${st.note ? ": " + st.note : ""}`;
    $("ctlPause").textContent = c.paused ? "▶ Resume automatic research" : "⏸ Pause automatic research"; $("ctlPause").classList.toggle("hot", !!c.paused);
    if (first) { $("ctlFreq").value = String(c.freq || 1); $("ctlNotify").checked = c.notify !== false; $("ctlExtra").value = (c.extra || []).join(", ");
      $("ctlSec").innerHTML = SECTORS11.map((s) => `<button type="button" data-s="${esc(s)}" class="${(c.sectors || []).includes(s) ? "on" : ""}">${esc(s)}</button>`).join("");
      $("ctlJobs").innerHTML = (st.jobTypes || []).map((j) => `<label class="ctl-chk"><input type="checkbox" data-j="${esc(j.type)}" ${(c.off || []).includes(j.type) ? "" : "checked"}> ${esc(j.label)} <em>every ${j.every[0]}–${j.every[1]} min</em></label>`).join(""); }
    const r = st.running; // only what the server reports: no simulated progress
    $("ctlRun").innerHTML = r ? `<div class="ctl-job on"><b>${esc(r.label)}</b><em>${esc(r.area || "")}${r.phase ? " · " + esc(r.phase) : ""}${r.note ? " · " + esc(r.note) : ""} · started ${esc(tago(r.started))}</em></div>` : `<p class="ctl-note">${c.paused ? "Paused. Manual research still runs." : "Idle: waiting for the next job to come due."}</p>`;
    $("ctlQueue").innerHTML = (st.queue || []).slice(0, 8).map((j) => `<div class="ctl-job"><b>${esc(j.label)}</b><em>priority ${Math.round(j.score)}${j.why ? " · " + esc(String(j.why).split(",")[0]) : ""}</em></div>`).join("") || '<p class="ctl-note">Empty.</p>';
    const rec = st.recent || [];
    $("ctlDone").innerHTML = rec.filter((j) => j.status === "done").slice(0, 8).map((j) => `<div class="ctl-job done"><b>${esc(j.label || j.type)}</b><em>${j.found || 0} new · ${j.updated || 0} updated · ${esc(tago(j.ended))}</em></div>`).join("") || '<p class="ctl-note">None yet.</p>';
    $("ctlFail").innerHTML = rec.filter((j) => j.status === "error").slice(0, 6).map((j) => `<div class="ctl-job bad"><b>${esc(j.label || j.type)}</b><em>${esc(j.error || "failed")} · ${esc(tago(j.ended))}</em></div>`).join("") || '<p class="ctl-note">No failures.</p>';
    const s = st.stats || {}, b = s.budget || {};
    $("ctlStats").innerHTML = [["Jobs today", s.jobs], ["Findings today", s.discoveries], ["Errors today", s.errors], ["In memory", s.memory], ["Briefings", s.briefings], ["This hour", b.used != null ? `${b.used}/${b.max}` : "—"], ["Hypotheses held / failed", s.hypotheses ? `${s.hypotheses.supported || 0} / ${s.hypotheses.refuted || 0}` : "—"]].map(([k, v]) => `<div><span>${k}</span><b>${v == null ? "—" : esc(String(v))}</b></div>`).join("");
    const sto = st.storage || {}; $("ctlStore").textContent = sto.durable ? `Research memory is saved in ${sto.backend} (free tier), so it survives restarts and redeploys. Download a copy any time.` : `Research memory is in the server's temp folder, which Render's free plan wipes on redeploy or sleep. Download a backup and restore it after a redeploy, or add the free Upstash keys.`;
  }
  async function list() {
    const f = C.f, qs = new URLSearchParams({ limit: "80" }); if (f.q) qs.set("q", f.q); if (f.cat) qs.set("cat", f.cat); if (f.min) qs.set("min", f.min); if (f.mine) qs.set("mine", "1"); if (f.since) qs.set("since", Date.now() - f.since * 864e5);
    let j; try { j = await api("/api/web/discoveries?" + qs); } catch { $("ctlList").innerHTML = '<p class="ctl-note">Sign in to search the research memory.</p>'; return; }
    let it = j.items || []; if (f.kind) it = it.filter((d) => (d.kind || ((d.facts || []).some((x) => x.kind === "fact") ? "fact" : (d.interp && d.interp.kind) || "fact")) === f.kind);
    $("ctlList").innerHTML = it.length ? `<p class="ctl-note">${it.length} of ${j.total} findings</p>` + it.map((d) => `<div class="ctl-find"><div><span class="ctl-cat">${esc(d.cat)}</span>${(d.tickers || []).slice(0, 4).map((t) => `<button type="button" class="ctl-tk" data-co="${esc(t)}">${esc(t)}</button>`).join("")}<em>${esc(tago(d.u || d.t))}${d.v > 1 ? ` · updated ×${d.v - 1}` : ""}${d.pf && d.pf.rel >= 0.45 ? " · ★ your portfolio" : ""}</em></div>
        <b>${esc(d.headline)}</b>${d.summary ? `<p>${esc(String(d.summary).slice(0, 260))}</p>` : ""}${(d.sources || []).length ? `<p class="ctl-src">Sources: ${d.sources.slice(0, 3).map((s) => (s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>` : esc(s.name))).join(" · ")}</p>` : ""}</div>`).join("") : '<p class="ctl-note">Nothing matches those filters.</p>';
  }
  async function showCompany(sym) {
    const card = $("ctlCoCard"); card.hidden = false; card.innerHTML = `<h3>${esc(sym)} · intelligence timeline <button type="button" class="ctl-x" id="ctlCoX">✕</button></h3><p class="ctl-note"><span class="spin"></span>Collecting the spider's findings, SEC filings and headlines…</p>`;
    $("ctlCoX").onclick = () => (card.hidden = true); card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    let j; try { j = await api("/api/web/timeline?symbol=" + encodeURIComponent(sym)); } catch (e) { card.querySelector(".ctl-note").textContent = String(e.message || e); return; }
    const icon = { spider: "🕷", sec: "📄", news: "📰" };
    card.innerHTML = `<h3>${esc(sym)} · intelligence timeline <em>${j.items.length} events · spider findings, SEC filings and headlines, each with its source</em><button type="button" class="ctl-x" id="ctlCoX">✕</button></h3>
      <div class="ctl-tline">${j.items.map((x) => `<div class="ctl-ev ${x.superseded ? "old" : ""}"><span class="ctl-d">${x.t ? new Date(x.t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : ""}</span><span class="ctl-i">${icon[x.src] || "•"}</span><div><b>${esc(x.headline)}</b> <em>${esc(x.cat)}${x.kind && x.kind !== "fact" ? " · " + esc(x.kind) : ""}${x.superseded ? " · replaced by a newer version" : ""}${x.expired ? " · may be out of date" : ""}</em>${x.summary ? `<p>${esc(String(x.summary).slice(0, 220))}</p>` : ""}${(x.sources || []).length ? `<p class="ctl-src">${x.sources.slice(0, 2).map((s) => (s.url ? `<a href="${esc(s.url)}" ${x.src === "news" || x.src === "sec" ? "data-read" : ""} data-title="${esc(x.headline)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>` : esc(s.name))).join(" · ")}</p>` : ""}</div></div>`).join("") || '<p class="ctl-note">Nothing on file yet. The research you just queued will add to it.</p>'}</div>`;
    $("ctlCoX").onclick = () => (card.hidden = true);
  }
  // notifications: new findings about your holdings (only if the setting is on)
  async function notifyCheck() {
    if (document.hidden) return; let st = C.st; if (!st) { try { st = await api("/api/web/status"); } catch { return; } }
    if (!st.ctrl || st.ctrl.notify === false) return;
    let j; try { j = await api(`/api/web/discoveries?mine=1&since=${C.lastNote}&limit=5`); } catch { return; }
    const it = (j.items || []).filter((d) => (d.importance || 0) >= 0.5); C.lastNote = Date.now(); localStorage.setItem("md_sp_seen", String(C.lastNote));
    for (const d of it.slice(0, 2)) { toast("🕷 " + d.headline); if ("Notification" in window && Notification.permission === "granted") { try { new Notification("Spider: " + (d.tickers || []).join(", "), { body: d.headline, tag: d.id }); } catch {} } }
  }
  const iv = setInterval(() => { if (mount()) clearInterval(iv); }, 600);
  setInterval(notifyCheck, 3 * 60e3); setTimeout(notifyCheck, 20e3);
  window.spiderCompany = (s) => { if (typeof setTab === "function") setTab("web"); setTimeout(() => { const b = document.querySelector('#twbModes [data-m="ctl"]'); if (b) b.click(); setTimeout(() => showCompany(String(s).toUpperCase()), 300); }, 400); };
})();

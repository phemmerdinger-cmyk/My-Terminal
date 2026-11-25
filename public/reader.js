/* Market Desk · in-site news reader.
   Three panels: the feed (left), the article (centre) and financial intelligence about it (right). On phones the
   panels become tabs.
   What the centre shows depends on what we are allowed to show:
   - Full text only for public-domain / public-record sources (Federal Reserve, BLS, BEA, Treasury, SEC filings).
   - Every other publisher: their own headline and summary, credited, plus a clearly labelled Market Desk briefing
     written by rules from the headline, live prices, related coverage and the spider's stored research. It never
     invents what the article says. The original link is always one click away.
   Nothing fetched from another site is inserted as HTML: all text goes through esc(). */
(function () {
  "use strict";
  if (typeof S === "undefined") return;
  const LS = { saved: "md_saved_v1", size: "md_rd_size", panes: "md_rd_panes" };
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const R = { open: false, cur: null, list: [], filter: "all", q: "", art: null, size: load(LS.size, 17), panes: load(LS.panes, { left: true, right: true }), focus: false, tab: "art", saved: load(LS.saved, {}), req: 0 };
  const src = (i) => (typeof SRC !== "undefined" && SRC[i.source]) || { name: i.source || "News", short: i.source || "", c: "#8aa" };
  const when = (t) => (t ? new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "");
  const short = (t) => { if (!t) return ""; const s = (Date.now() - t) / 1000; return s < 3600 ? Math.max(1, Math.round(s / 60)) + "m" : s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d"; };
  const cleanT = (t) => String(t || "").replace(/\s+[-–|]\s+[^-–|]{2,40}$/, "");
  const q = (s) => (S.quotes && S.quotes[s] && !S.quotes[s].error ? S.quotes[s] : null);
  const breaking = (i) => i._bs ? (i._bs === 2 ? "Black swan" : "Shock watch") : i._top ? "Top story" : i.time && Date.now() - i.time < 45 * 60e3 && (i._web || 0) > 1 ? "Breaking" : "";
  const cat = (i) => (i.source === "official" ? (i.agency || "Official") : typeof npSection === "function" ? npSection(i) : "News");

  // ------------------------------------------------------------ shell
  const box = document.createElement("div"); box.id = "rdr"; box.hidden = true; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "News reader");
  box.innerHTML = `<div class="rdr-top"><b class="rdr-brand">◆ Reader</b>
      <div class="rdr-tabs"><button data-rt="feed">Feed</button><button data-rt="art" class="on">Article</button><button data-rt="intel">Intelligence</button></div>
      <div class="rdr-tools"><button data-ra="left" title="Show or hide the feed">☰</button><button data-ra="smaller" title="Smaller text">A−</button><button data-ra="bigger" title="Larger text">A+</button>
      <button data-ra="save" title="Save this article (S)">☆ Save</button><button data-ra="focus" title="Full-screen reading">⤢ Focus</button><button data-ra="right" title="Show or hide intelligence">◧</button>
      <a class="rdr-orig" target="_blank" rel="noopener noreferrer">Original ↗</a><button data-ra="close" class="rdr-x" title="Close (Esc)">✕</button></div></div>
    <div class="rdr-grid"><aside class="rdr-l"><div class="rdr-lh"><input id="rdrQ" placeholder="Search headlines, tickers…" autocomplete="off">
        <div class="rdr-f">${[["all", "All"], ["priority", "For you"], ["mine", "My stocks"], ["breaking", "Breaking"], ["official", "Official"], ["saved", "★ Saved"]].map(([k, l]) => `<button data-rf="${k}">${l}</button>`).join("")}</div></div><div class="rdr-list" id="rdrList"></div></aside>
      <main class="rdr-c"><div class="rdr-prog"><i id="rdrProg"></i></div><div class="rdr-scroll" id="rdrScroll"><article class="rdr-art" id="rdrArt"></article></div></main>
      <aside class="rdr-r" id="rdrIntel"></aside></div>`;
  document.body.appendChild(box);
  const $r = (sel) => box.querySelector(sel);

  function applyLayout() {
    box.classList.toggle("no-l", !R.panes.left); box.classList.toggle("no-r", !R.panes.right); box.classList.toggle("focus", R.focus);
    box.style.setProperty("--rdr-size", R.size + "px");
    box.querySelectorAll("[data-rt]").forEach((b) => b.classList.toggle("on", b.dataset.rt === R.tab)); box.dataset.tab = R.tab;
    box.querySelectorAll("[data-rf]").forEach((b) => b.classList.toggle("on", b.dataset.rf === R.filter));
    const sv = $r('[data-ra="save"]'); if (sv && R.cur) { const on = !!R.saved[R.cur.id]; sv.textContent = on ? "★ Saved" : "☆ Save"; sv.classList.toggle("on", on); }
  }

  // ------------------------------------------------------------ feed (left)
  function pool() {
    const base = typeof filtered === "function" ? filtered() : (S.news && S.news.items) || [];
    let list = base.slice();
    if (R.filter === "saved") list = Object.values(R.saved).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    else if (R.filter === "mine") { const m = new Set([...(S.wl || []), ...(S.port || []).map((h) => h.symbol)]); list = list.filter((i) => (i.tickers || []).some((t) => m.has(t))); }
    else if (R.filter === "breaking") list = list.filter((i) => breaking(i));
    else if (R.filter === "official") list = list.filter((i) => i.source === "official");
    const qq = R.q.trim().toLowerCase();
    if (qq) list = list.filter((i) => (i.title + " " + (i.summary || "") + " " + (i.tickers || []).join(" ")).toLowerCase().includes(qq));
    if (R.filter === "priority" && window.MDNewsIntel) list = window.MDNewsIntel.prioritize(list, { portfolios: S.pfs, holdings: S.port, watchlist: S.wl, now: Date.now() });
    if (R.cur && !list.some((i) => i.id === R.cur.id)) list.unshift(R.cur);
    return (R.filter === "priority" || R.filter === "saved" ? list : list.sort((a, b) => (b.time || 0) - (a.time || 0))).slice(0, 300);
  }
  function renderList() {
    R.list = pool();
    $r("#rdrList").innerHTML = R.list.length ? R.list.map((i) => { const s = src(i), br = breaking(i);
      const relevance = R.filter === "priority" && window.MDNewsIntel ? (i._priority || window.MDNewsIntel.explain(i, { portfolios: S.pfs, holdings: S.port, watchlist: S.wl })) : null;
      return `<button class="rdr-row${R.cur && R.cur.id === i.id ? " on" : ""}" data-rid="${esc(i.id)}"><span class="rdr-meta"><i style="--c:${s.c}">${esc(i.source === "official" ? i.agency || "Official" : s.short || s.name)}</i>${esc(short(i.time))}${br ? `<b class="rdr-br">${esc(br)}</b>` : ""}${R.saved[i.id] ? '<b class="rdr-sv">★</b>' : ""}</span>
        <span class="rdr-t">${esc(cleanT(i.title))}</span><span class="rdr-tk">${esc(cat(i))}${(i.tickers || []).slice(0, 4).map((t) => ` · <em>${esc(t)}</em>`).join("")}</span>${relevance ? `<span class="rdr-prio">${esc(relevance.level)} · ${esc(relevance.reasons.join(" · "))}</span>` : ""}</button>`; }).join("")
      : `<p class="rdr-empty">${R.filter === "saved" ? "Nothing saved yet. Press ☆ Save on an article to keep it here." : "No headlines match."}</p>`;
    const on = $r(".rdr-row.on"); if (on) on.scrollIntoView({ block: "nearest" });
  }

  // ------------------------------------------------------------ article (centre)
  function sentences(text) { return String(text || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]+(\s|$)/g) || []; }
  function takeaways(paras) { // extractive: the sentences that carry numbers and market words, kept in reading order
    const all = []; paras.filter((p) => !p.h && !p.pre).forEach((p, pi) => sentences(p.t).forEach((s, si) => { s = s.trim(); if (s.length < 50 || s.length > 300) return;
      let sc = 0; if (/\d/.test(s)) sc += 2; if (/%|percent|\$|basis points?/.test(s)) sc += 2; if (/\b(rate|inflation|employment|unemployment|revenue|earnings|guidance|growth|outlook|decline|increase|decrease|rose|fell|expects?|forecast|target|committee|policy)\b/i.test(s)) sc += 1.5; if (pi < 4) sc += 1;
      all.push({ s, sc, k: pi * 100 + si }); }));
    return all.sort((a, b) => b.sc - a.sc).slice(0, 4).sort((a, b) => a.k - b.k).map((x) => x.s);
  }
  const POSW = /\b(beat|beats|surge[sd]?|soar(s|ed)?|jump(s|ed)?|rall(y|ies|ied)|record|upgrade[sd]?|raise[sd]?|strong(er)?|gain(s|ed)?|grow(s|th)?|expand(s|ed|ing)?|improv(e|es|ed|ing)|approv(al|ed)|partnership|buyback|dividend|outperform)\b/i;
  const NEGW = /\b(miss(es|ed)?|plunge[sd]?|fall(s|en)?|fell|drop(s|ped)?|slump(s|ed)?|downgrade[sd]?|cut(s)?|weak(er|ness)?|loss(es)?|lawsuit|probe|investigation|recall(s|ed)?|warn(s|ing)?|layoffs?|declin(e|es|ed)|tariffs?|fine[sd]?|delay(s|ed)?|risk(s)?|elevated|uncertain(ty)?)\b/i;
  function factors(i, paras) {
    const pool = [cleanT(i.title), i.summary || "", (R.art && R.art.description) || "", ...paras.filter((p) => !p.h && !p.pre).map((p) => p.t)].flatMap((t) => sentences(t + (/[.!?]$/.test(t) ? "" : "."))).map((s) => s.trim()).filter((s) => s.length > 25 && s.length < 260);
    const uniq = (a) => [...new Set(a)].slice(0, 3);
    return { bull: uniq(pool.filter((s) => POSW.test(s) && !NEGW.test(s))), bear: uniq(pool.filter((s) => NEGW.test(s) && !POSW.test(s))) };
  }
  function related(i) {
    const items = (S.news && S.news.items) || [], tk = new Set(i.tickers || []), w = new Set((cleanT(i.title).toLowerCase().match(/[a-z]{4,}/g) || []).map((x) => x.replace(/s$/, "")));
    return items.filter((x) => x.id !== i.id).map((x) => { const xw = (cleanT(x.title).toLowerCase().match(/[a-z]{4,}/g) || []).map((y) => y.replace(/s$/, "")); const ov = xw.filter((y) => w.has(y)).length; const tt = (x.tickers || []).filter((t) => tk.has(t)).length;
      return { x, sc: ov * 1.5 + tt * 2 + (x.time && i.time && Math.abs(x.time - i.time) < 2 * 864e5 ? 0.5 : 0) }; }).filter((r) => r.sc >= 2.5).sort((a, b) => b.sc - a.sc).slice(0, 6).map((r) => r.x);
  }
  function briefing(i, rel) { // original, rules-based: only facts we hold (headline, publisher summary, prices, coverage, research)
    const out = [], tk = (i.tickers || []).slice(0, 4), pub = src(i).name;
    out.push(`${pub} reports: “${cleanT(i.title)}”${i.time ? ` (${when(i.time)})` : ""}.`);
    for (const t of tk) { const x = q(t); if (!x) continue; const pos = x.high52 && x.low52 && x.high52 > x.low52 ? Math.round(((x.price - x.low52) / (x.high52 - x.low52)) * 100) : null;
      out.push(`${t} is trading at $${fmt(x.price)}, ${x.changePct >= 0 ? "up" : "down"} ${Math.abs(x.changePct).toFixed(2)}% today${pos != null ? `, ${pos}% of the way between its 52-week low and high` : ""}.`); }
    const spx = q("^GSPC"); if (spx && tk.length) { const t0 = q(tk[0]); if (t0) { const d = t0.changePct - spx.changePct; if (Math.abs(d) >= 1) out.push(`That is ${Math.abs(d).toFixed(1)} points ${d > 0 ? "better" : "worse"} than the S&P 500 (${pct(spx.changePct)}), which differs from the broad market; the comparison alone does not establish why.`); } }
    const also = (i.also || []).length; if (also) out.push(`${also + 1} outlets are covering the same story, which usually means it is getting wide attention.`);
    if (rel.length) { const p = rel.filter((x) => x.mood > 0).length, n = rel.filter((x) => x.mood < 0).length; out.push(`${rel.length} related headline${rel.length > 1 ? "s" : ""} in the feed; the tone of that coverage is ${p > n ? "mostly positive" : n > p ? "mostly negative" : "mixed"}.`); }
    if (S.earn && !S.earn.error) for (const t of tk) { const e = [...(S.earn.yours || []), ...(S.earn.notable || [])].find((x) => x.symbol === t); if (e) out.push(`${t} reports earnings on ${e.date}${e.time ? ` (${e.time})` : ""}.`); }
    return out;
  }
  function renderArticle() {
    const i = R.cur; if (!i) return; const a = R.art, s = src(i), rel = related(i);
    $r(".rdr-orig").href = (a && a.url) || i.link || "#";
    const head = `<div class="rdr-kick">${esc(cat(i))}${breaking(i) ? ` · <b>${esc(breaking(i))}</b>` : ""}</div><h1>${esc(cleanT((a && a.full && a.title) || i.title))}</h1>
      <div class="rdr-by"><span class="rdr-pub" style="--c:${s.c}">${esc(i.source === "official" ? (a && a.publisher) || i.agency || s.name : s.name)}</span>${a && a.author ? `<span>By ${esc(String(a.author).replace(/^by\s+/i, "").slice(0, 80))}</span>` : ""}<span>${esc(when(i.time) || (a && a.published) || "")}</span></div>`;
    let body;
    if (!a) body = `<p class="rdr-load"><span class="spin"></span>Opening the article…</p>`;
    else if (a.full && a.paragraphs.length) {
      const tk = takeaways(a.paragraphs);
      body = `<div class="rdr-rights">✓ Full text · ${esc(a.rights)}</div>${tk.length ? `<div class="rdr-key"><h4>Key points <em>sentences picked from the release</em></h4><ul>${tk.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
        <div class="rdr-body">${a.paragraphs.map((p) => (p.h ? `<h3>${esc(p.t)}</h3>` : p.pre ? `<pre>${esc(p.t)}</pre>` : `<p>${esc(p.t)}</p>`)).join("")}</div>`;
    } else {
      const sum = [i.summary, a.description].filter(Boolean).map((x) => String(x).trim()).filter((x, n, arr) => x && arr.indexOf(x) === n && x.length > 20).sort((x, y) => y.length - x.length)[0];
      body = `<div class="rdr-rights">${esc(a.rights || "Publisher's article.")}</div>
        ${a.image ? `<div class="rdr-img"><img src="${esc(a.image)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.parentNode.remove()"></div>` : ""}
        <section class="rdr-sum"><h4>The publisher's summary</h4>${sum ? `<blockquote>${esc(sum)}</blockquote><cite>— ${esc(s.name)}</cite>` : `<p class="dim">${esc(s.name)} doesn't share a summary for this story.</p>`}</section>
        <section class="rdr-brief"><h4>Market Desk briefing <em>written by rules from the headline, live prices, related coverage and the spider's research, not from the article itself</em></h4>${briefing(i, rel).map((x) => `<p>${esc(x)}</p>`).join("")}<div id="rdrBriefSpider"></div></section>
        <a class="btn rdr-read" href="${esc(a.url || i.link)}" target="_blank" rel="noopener noreferrer">Read the full story on ${esc(a.publisher || s.name)} ↗</a>${/wsj\.com|morningstar\.com|barrons\.com|ft\.com|bloomberg\.com/.test(i.link || "") ? '<span class="rdr-pay">may require a subscription</span>' : ""}`;
    }
    $r("#rdrArt").innerHTML = head + body;
    $r("#rdrScroll").scrollTop = 0; prog(); renderIntel(rel);
  }
  function prog() { const sc = $r("#rdrScroll"), m = sc.scrollHeight - sc.clientHeight; $r("#rdrProg").style.width = (m > 4 ? Math.min(100, (sc.scrollTop / m) * 100) : 100) + "%"; }

  // ------------------------------------------------------------ intelligence (right)
  function renderIntel(rel) {
    const i = R.cur, a = R.art, tk = [...new Set(i.tickers || [])].slice(0, 6), paras = (a && a.paragraphs) || [], f = factors(i, paras);
    const relevance = window.MDNewsIntel ? window.MDNewsIntel.explain(i, { portfolios: S.pfs, holdings: S.port, watchlist: S.wl }) : null;
    const held = []; for (const pf of S.pfs || []) for (const h of pf.holdings || []) if (tk.includes(h.symbol)) { const x = q(h.symbol), px = x ? x.price : h.cost; held.push({ pf: pf.name, sym: h.symbol, sh: h.shares, val: h.shares * (px || 0), day: x && x.change != null ? h.shares * x.change : null }); }
    const tk2 = tk.length ? tk : [];
    $r("#rdrIntel").innerHTML = `
      ${tk2.length ? `<section><h4>Affected tickers</h4>${tk2.map((t) => { const x = q(t); return `<button class="rdr-tick" data-rq="${esc(t)}"><b>${esc(t)}</b>${x ? `<span>$${fmt(x.price)}</span><i class="${cls(x.changePct)}">${pct(x.changePct)}</i>${typeof extChip === "function" ? extChip(t, x, true) : ""}` : "<span>open research →</span>"}</button>`; }).join("")}</section>` : `<section><h4>Affected tickers</h4><p class="dim">No company is named in this story${i.source === "official" ? "; it is an economy-wide release" : ""}.</p></section>`}
      ${tk2.some((t) => q(t)) ? `<section><h4>Metrics</h4><table class="rdr-m">${tk2.slice(0, 3).map((t) => { const x = q(t); if (!x) return ""; const pos = x.high52 > x.low52 ? Math.round(((x.price - x.low52) / (x.high52 - x.low52)) * 100) : null; return `<tr><th>${esc(t)}</th><td>day ${pct(x.changePct)}</td><td>${x.low52 ? `52w $${fmt(x.low52, 0)}–$${fmt(x.high52, 0)}` : ""}</td><td>${pos != null ? pos + "% of range" : ""}</td></tr>`; }).join("")}</table></section>` : ""}
      ${relevance ? `<section><h4>Why this story appears</h4><p><b>${esc(relevance.level)}</b> relevance · ${esc(relevance.reasons.join(" · "))}</p><p class="dim">Ranked using holdings, watchlist, source coverage and recency—not a predicted price move.</p></section>` : ""}
      <section><h4>Your exposure</h4>${held.length ? held.map((h) => `<p><b>${esc(h.sym)}</b> in ${esc(h.pf)}: ${h.sh} sh · ${$m(h.val)}${h.day != null ? ` · <span class="${cls(h.day)}">${h.day >= 0 ? "+" : "−"}${$m(Math.abs(h.day)).replace("−", "")} today</span>` : ""}</p>`).join("") : `<p class="dim">${tk2.length ? "You don't hold these." : "Nothing in your portfolios is named."}${tk2.some((t) => (S.wl || []).includes(t)) ? " On your watchlist." : ""}</p>`}</section>
      ${f.bull.length || f.bear.length ? `<section><h4>Possible bullish / bearish factors <em>keyword rules on the text we can show</em></h4>${f.bull.map((x) => `<p class="rdr-bu">▲ ${esc(x)}</p>`).join("")}${f.bear.map((x) => `<p class="rdr-be">▼ ${esc(x)}</p>`).join("")}</section>` : ""}
      <section><h4>Related news</h4>${rel.length ? rel.map((x) => `<button class="rdr-rel" data-rid="${esc(x.id)}">${esc(cleanT(x.title))}<em>${esc(src(x).short || src(x).name)} · ${esc(short(x.time))}</em></button>`).join("") : '<p class="dim">No closely related headlines in the feed.</p>'}</section>
      ${tk2.length ? `<section><h4>SEC filings</h4><div id="rdrSec"><span class="spin"></span></div></section>` : ""}
      <section><h4>Spider research</h4><div id="rdrSpider"><span class="spin"></span></div></section>`;
    if (tk2.length) api("/api/pub/filings?symbols=" + encodeURIComponent(tk2.slice(0, 3).join(","))).then((j) => { if (R.cur !== i) return; const el = $r("#rdrSec"); if (!el) return; const rows = [];
      for (const t of tk2.slice(0, 3)) { const fl = j.filings && j.filings[t]; if (!fl) continue; for (const [k, lab] of [["er", "Earnings release (8-K)"], ["q", "Quarterly report (10-Q)"], ["k", "Annual report (10-K)"]]) if (fl[k]) rows.push(`<button class="rdr-rel" data-rurl="${esc(fl[k].url)}" data-rtitle="${esc(`${t} ${fl[k].form} filed ${fl[k].date}`)}">${esc(t)} · ${esc(lab)}<em>filed ${esc(fl[k].date)} · opens here</em></button>`);
        if (fl.f4 && fl.f4.n30) rows.push(`<p class="dim">${esc(t)}: ${fl.f4.n30} insider filing${fl.f4.n30 > 1 ? "s" : ""} (Form 4) in 30 days.</p>`); }
      el.innerHTML = rows.join("") || '<p class="dim">No SEC filings found for these tickers.</p>'; }).catch(() => { const el = $r("#rdrSec"); if (el) el.innerHTML = '<p class="dim">SEC filings unavailable right now.</p>'; });
    const qs = tk2.length ? "symbols=" + encodeURIComponent(tk2.join(",")) : "q=" + encodeURIComponent((cleanT(i.title).match(/[A-Za-z]{5,}/g) || []).slice(0, 2).join(" "));
    api(`/api/web/discoveries?${qs}&limit=8`).then((j) => { if (R.cur !== i) return; const it = ((j && j.items) || []).filter((d) => !tk2.length || (d.tickers || []).some((t) => tk2.includes(t))).slice(0, 5), el = $r("#rdrSpider"), b = $r("#rdrBriefSpider");
      if (el) el.innerHTML = it.length ? it.map((d) => `<p class="rdr-find"><b>${esc(d.headline)}</b><em>${esc(d.cat || "finding")}${d.kind && d.kind !== "fact" ? " · " + esc(d.kind) : ""}${d.u || d.t ? " · " + esc(short(d.u || d.t)) : ""}</em></p>`).join("") : '<p class="dim">The spider has no stored research on this yet.</p>';
      if (b && it.length) b.innerHTML = `<p>The spider's stored research adds: ${it.slice(0, 2).map((d) => `“${esc(d.headline)}”`).join("; ")}.</p>`; })
      .catch(() => { const el = $r("#rdrSpider"); if (el) el.innerHTML = '<p class="dim">Sign in to see the spider\'s research.</p>'; });
  }

  // ------------------------------------------------------------ open / navigate
  async function show(i) {
    R.cur = i; R.art = null; const id = ++R.req; if (innerWidth < 900) R.tab = "art";
    applyLayout(); renderList(); renderArticle();
    try { const a = await api("/api/article?url=" + encodeURIComponent(i.link)); if (id !== R.req) return; R.art = a; }
    catch (e) { if (id !== R.req) return; R.art = { full: false, url: i.link, rights: "Couldn't reach the publisher just now. The headline and briefing below come from the feed.", paragraphs: [] }; }
    renderArticle(); applyLayout();
  }
  function openReader(i) { if (!i) return; R.open = true; box.hidden = false; document.body.classList.add("rdr-open"); show(i); }
  function close() { R.open = false; box.hidden = true; document.body.classList.remove("rdr-open"); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
  function step(d) { const k = R.list.findIndex((x) => R.cur && x.id === R.cur.id); const n = R.list[k + d]; if (n) show(n); }
  const findItem = (id) => R.list.find((x) => x.id === id) || (S._feedMap && S._feedMap.get(id)) || ((S.news && S.news.items) || []).find((x) => x.id === id) || R.saved[id];

  box.addEventListener("click", (e) => {
    const rt = e.target.closest("[data-rt]"); if (rt) { R.tab = rt.dataset.rt; applyLayout(); return; }
    const rf = e.target.closest("[data-rf]"); if (rf) { R.filter = rf.dataset.rf; applyLayout(); renderList(); return; }
    const row = e.target.closest("[data-rid]"); if (row) { const it = findItem(row.dataset.rid); if (it) show(it); return; }
    const ru = e.target.closest("[data-rurl]"); if (ru) { show({ id: "url|" + ru.dataset.rurl, title: ru.dataset.rtitle, link: ru.dataset.rurl, source: "official", agency: "SEC filing", tickers: (R.cur && R.cur.tickers) || [], time: null }); return; }
    const rq = e.target.closest("[data-rq]"); if (rq) { close(); openQuote(rq.dataset.rq); return; }
    const ra = e.target.closest("[data-ra]"); if (!ra) return; const k = ra.dataset.ra;
    if (k === "close") close();
    else if (k === "left") { R.panes.left = !R.panes.left; save(LS.panes, R.panes); }
    else if (k === "right") { R.panes.right = !R.panes.right; save(LS.panes, R.panes); }
    else if (k === "smaller" || k === "bigger") { R.size = Math.max(14, Math.min(24, R.size + (k === "bigger" ? 1 : -1))); save(LS.size, R.size); }
    else if (k === "focus") { R.focus = !R.focus; if (R.focus && box.requestFullscreen) box.requestFullscreen().catch(() => {}); else if (!R.focus && document.fullscreenElement) document.exitFullscreen().catch(() => {}); }
    else if (k === "save") toggleSave();
    applyLayout();
  });
  function toggleSave() { const i = R.cur; if (!i) return; if (R.saved[i.id]) delete R.saved[i.id]; else R.saved[i.id] = { id: i.id, title: i.title, link: i.link, source: i.source, agency: i.agency, time: i.time, tickers: i.tickers || [], summary: i.summary || "", savedAt: Date.now() }; save(LS.saved, R.saved); renderList(); applyLayout(); }
  $r("#rdrQ").addEventListener("input", (e) => { R.q = e.target.value; renderList(); });
  $r("#rdrScroll").addEventListener("scroll", prog, { passive: true });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && R.focus) { R.focus = false; applyLayout(); } });
  document.addEventListener("keydown", (e) => { if (!R.open || /input|textarea|select/i.test((e.target.tagName || ""))) return;
    if (e.key === "Escape") close(); else if (e.key === "j" || e.key === "ArrowDown" && e.altKey) step(1); else if (e.key === "k" || e.key === "ArrowUp" && e.altKey) step(-1); else if (e.key === "s") toggleSave(); });
  // every headline on the site that carries data-story (and anything marked data-read) opens here instead of leaving
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-story], a[data-read]"); if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    let it = a.dataset.story ? findItem(a.dataset.story) : null;
    if (!it && a.dataset.read != null) it = { id: "url|" + a.href, title: a.dataset.title || a.textContent.trim(), link: a.href, source: a.dataset.src || "", time: +a.dataset.time || null, tickers: (a.dataset.tickers || "").split(",").filter(Boolean) };
    if (!it) return; e.preventDefault(); e.stopImmediatePropagation(); openReader(it);
  }, true);
  window.openReader = openReader;
  applyLayout();
})();

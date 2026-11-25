/* Market Desk · My Trader — the owner's own $30,000 paper account on the "Trading bots vs. the S&P 500" page.
   Server rules: my-trader-core.js (fills at a fresh quote stamped after the order + modeled costs; long only; paper money).
   Hooks used by index.html: window.mtRender(d) draws the view when "My Trader" is selected. */
(function () {
  "use strict";
  const MT = { side: "BUY", mode: "shares", msg: "", busy: false, review: false, vals: { sym: "", qty: "", note: "" } };
  const keep = () => { if ($("mtSym")) MT.vals = { sym: $("mtSym").value, qty: $("mtQty") ? $("mtQty").value : MT.vals.qty, note: $("mtNote") ? $("mtNote").value : MT.vals.note }; };
  const usd = (n, d = 2) => (Number.isFinite(n) ? (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
  const sgn = (n) => (Number.isFinite(n) ? (n >= 0 ? "+" : "−") + "$" + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—");
  const when = (t) => (t ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  const sh = (x) => { const n = +x; return n % 1 ? n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : String(n); };

  // one-time styles for the ticket (theme variables from index.html)
  if (!document.getElementById("mtCss")) {
    const css = document.createElement("style"); css.id = "mtCss";
    css.textContent = `.mt-t{border-top:1px solid var(--line);padding-top:12px;margin-top:2px}
.mt-t h4{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:0 0 10px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.mt-t h4 em{font-style:normal;letter-spacing:0;text-transform:none;font-weight:400;font-size:12px}
.mt-wrap{display:grid;grid-template-columns:minmax(300px,380px) minmax(0,1fr);gap:14px;align-items:start}
.mt-tk{display:flex;flex-direction:column;gap:10px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);padding:14px;min-width:0}
.mt-tk label{display:grid;gap:5px;min-width:0}.mt-tk small{font-size:11px;color:var(--muted)}
.mt-tk input{width:100%;box-sizing:border-box;height:36px;padding:0 10px;border-radius:8px;border:1px solid var(--line2);background:var(--bg);color:var(--text);font:inherit;font-variant-numeric:tabular-nums}
.mt-tk input:focus{outline:none;border-color:var(--orange)}
.mt-two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.mt-tk .apseg{height:36px;box-sizing:border-box;align-items:stretch;display:flex}.mt-tk .apseg button{flex:1;padding:0 10px}
.mt-acts{display:flex;gap:6px}.mt-acts button{flex:1;height:36px;border-radius:8px;border:1px solid var(--line2);background:var(--bg);color:var(--muted);font-weight:600;font-size:12.5px;cursor:pointer}
.mt-acts button.on.b{border-color:var(--up);color:var(--up);background:color-mix(in srgb,var(--up) 10%,var(--bg))}.mt-acts button.on.s{border-color:var(--down);color:var(--down);background:color-mix(in srgb,var(--down) 10%,var(--bg))}
.mt-fixed{height:36px;display:flex;align-items:center;padding:0 10px;border-radius:8px;border:1px dashed var(--line2);color:var(--muted);font-size:13px}
.mt-hold{font-size:12.5px;color:var(--muted);margin-top:-4px}.mt-hold b{color:var(--text)}
.mt-est{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:13px}.mt-est b{font-size:18px;font-variant-numeric:tabular-nums}.mt-est small{color:var(--muted)}
.mt-go{height:38px;border:0;border-radius:8px;font-weight:700;cursor:pointer;background:var(--orange);color:#111;flex:1}.mt-go:disabled{opacity:.55;cursor:default}
.mt-ghost{height:38px;border:1px solid var(--line2);border-radius:8px;background:none;color:var(--text);font-weight:600;cursor:pointer;padding:0 18px}
.mt-tk>.mt-go{flex:none}.mt-btns{display:flex;gap:8px;margin-top:4px}.mt-rv-h{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}.mt-rv-t{font-size:16px}
.mt-empty{color:var(--muted);font-size:13px;min-height:120px;display:flex;align-items:center;justify-content:center;gap:8px;text-align:center}
.mt-ctx{font-size:12px;color:var(--muted)}.mt-ctx b{color:var(--text);font-weight:600}.mt-msg{font-size:13px;min-height:0}
.mt-look{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:12px;margin-top:12px}
.mt-card{border:1px solid var(--line);border-radius:10px;background:var(--panel2);padding:12px 14px;min-width:0}
.mt-card h5{margin:0 0 8px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600;display:flex;justify-content:space-between;gap:8px}
.mt-card h5 em{font-style:normal;letter-spacing:0;text-transform:none;font-weight:400}
.mt-hd{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin-bottom:10px}.mt-hd b{font-size:16px}.mt-hd .px{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.mt-kv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 14px}.mt-kv div{min-width:0}.mt-kv span{display:block;font-size:10.5px;color:var(--muted);letter-spacing:.04em}.mt-kv b{font-weight:600;font-size:13px;font-variant-numeric:tabular-nums}
.mt-rng{position:relative;height:4px;border-radius:2px;background:var(--line2);margin:5px 0 2px}.mt-rng i{position:absolute;top:-3px;width:2px;height:10px;background:var(--orange);border-radius:1px}
.mt-row{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px dashed var(--line);font-size:13px}.mt-row:last-of-type{border:0}.mt-row b{font-variant-numeric:tabular-nums;font-weight:600}
.mt-row.big b{font-size:16px}.mt-warn{margin-top:8px;font-size:12px;color:var(--orange)}.mt-about{margin-top:10px;font-size:12px;color:var(--muted);line-height:1.5}
@media (max-width:1180px){.mt-kv{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:900px){.mt-wrap{grid-template-columns:1fr}}`;
    document.head.appendChild(css);
  }
  // broker-style actions: what you can do depends on what you hold in the ticker (like Schwab's Buy / Sell / Sell All / Short)
  const ACT = { BUY: "Buy", SELL: "Sell", SHORT: "Sell short", COVER: "Buy back (close short)" };
  const VERB = { BUY: "buy", SELL: "sell", SHORT: "short sale", COVER: "buy to cover" };
  const symOf = () => (MT.vals.sym || "").trim().toUpperCase();
  const posOf = (d, sym) => (sym ? d.positions.find((x) => x.sym === sym) : null);
  function actions(p) {
    if (!p) return [["BUY", "shares", "Buy"], ["SHORT", "shares", "Sell short"]];
    if (p.dir === "short") return [["COVER", "shares", "Buy back some"], ["COVER", "all", "Close whole short"], ["SHORT", "shares", "Short more"]];
    return [["SELL", "shares", "Sell"], ["SELL", "all", "Sell all"], ["BUY", "shares", "Buy more"]];
  }
  function fitAction(d) { // keep the chosen action valid for what you hold
    const ok = actions(posOf(d, symOf()));
    if (!ok.some(([s, m]) => s === MT.side && (m === "all") === (MT.mode === "all"))) { const keepMode = MT.mode === "amount" ? "amount" : "shares"; const f = ok.find(([s]) => s === MT.side) || ok[0]; MT.side = f[0]; MT.mode = f[1] === "all" ? "all" : keepMode; }
  }
  // ---- stock lookup: live quote + company info, and what the order will cost (order-preview-core.js)
  MT.info = {};
  const big = (n) => (!Number.isFinite(n) ? "—" : Math.abs(n) >= 1e12 ? "$" + (n / 1e12).toFixed(2) + "T" : Math.abs(n) >= 1e9 ? "$" + (n / 1e9).toFixed(2) + "B" : Math.abs(n) >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M" : usd(n, 0));
  const cnt = (n) => (!Number.isFinite(n) ? "—" : n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(n));
  const num = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—"), fpc = (n, d = 1) => (Number.isFinite(n) ? (n * 100).toFixed(d) + "%" : "—");
  async function lookup(sym, force) {
    if (!sym || !/^[A-Z0-9^][A-Z0-9.\-=]{0,20}$/.test(sym)) return;
    const have = MT.info[sym]; if (have && !force && Date.now() - have.at < 20_000) return;
    MT.info[sym] = { ...(have || {}), at: Date.now(), loading: !have };
    const [q, sm] = await Promise.allSettled([api("/api/quotes?symbols=" + encodeURIComponent(sym)).then((j) => j.quotes && j.quotes[sym]), have && have.d ? Promise.resolve(have.d) : api("/api/summary?symbol=" + encodeURIComponent(sym))]);
    MT.info[sym] = { at: Date.now(), q: q.status === "fulfilled" && q.value && !q.value.error ? q.value : null, d: sm.status === "fulfilled" ? sm.value || {} : {}, err: q.status !== "fulfilled" ? (q.reason && q.reason.message) || "quote unavailable" : null };
    if (symOf() === sym && $("mtLook")) { $("mtLook").innerHTML = look(BOTS.d.me); if ($("mtEst")) $("mtEst").innerHTML = estLine(BOTS.d.me); }
  }
  function infoCard(sym, x) {
    const q = x.q || {}, d = x.d || {}, sd = d.summaryDetail || {}, ks = d.defaultKeyStatistics || {}, fd = d.financialData || {}, ap = d.assetProfile || d.summaryProfile || {}, pr = d.price || {};
    const name = pr.longName || pr.shortName || q.name || sym, px = q.price, lo52 = sd.fiftyTwoWeekLow ?? q.low52, hi52 = sd.fiftyTwoWeekHigh ?? q.high52;
    const bar = (lo, hi) => { const w = MDOrderPreview.within(px, lo, hi); return w == null ? "" : `<div class="mt-rng"><i style="left:calc(${(w * 100).toFixed(1)}% - 1px)"></i></div>`; };
    const ed = d.calendarEvents && d.calendarEvents.earnings && d.calendarEvents.earnings.earningsDate, e0 = Array.isArray(ed) ? ed[0] : ed, eMs = Number.isFinite(e0) ? e0 * 1000 : null, eDays = eMs ? Math.ceil((eMs - Date.now()) / 864e5) : null;
    const fresh = q.marketTime && Date.now() - q.marketTime < 5 * 60e3;
    const kv = [
      ["Day range", `${num(q.dayLow)} – ${num(q.dayHigh)}${bar(q.dayLow, q.dayHigh)}`], ["52-week range", `${num(lo52)} – ${num(hi52)}${bar(lo52, hi52)}`], ["Volume · avg", `${cnt(q.volume)} · ${cnt(sd.averageVolume)}`],
      ["Bid · ask", sd.bid > 0 && sd.ask > 0 ? `${num(sd.bid)} · ${num(sd.ask)}` : "—"], ["Market cap", big(sd.marketCap ?? pr.marketCap)], ["P/E · forward", `${num(sd.trailingPE, 1)} · ${num(sd.forwardPE, 1)}`],
      ["EPS (12 mo)", Number.isFinite(ks.trailingEps) ? usd(ks.trailingEps) : "—"], ["Dividend yield", fpc(sd.dividendYield ?? sd.yield, 2)], ["Beta", num(sd.beta ?? ks.beta)],
      ["Analysts", fd.recommendationKey ? `${esc(String(fd.recommendationKey).replace(/_/g, " "))}${fd.numberOfAnalystOpinions ? ` (${fd.numberOfAnalystOpinions})` : ""}` : "—"], ["Avg target", Number.isFinite(fd.targetMeanPrice) ? `${usd(fd.targetMeanPrice)}${px ? ` <span class="${cls(fd.targetMeanPrice - px)}">(${pct((fd.targetMeanPrice / px - 1) * 100)})</span>` : ""}` : "—"],
      ["Next earnings", eMs ? `${new Date(eMs).toLocaleDateString("en-US", { month: "short", day: "numeric" })}${eDays != null && eDays >= 0 ? ` · ${eDays}d` : ""}` : "—"],
      ["Short interest", Number.isFinite(ks.shortPercentOfFloat) ? `${fpc(ks.shortPercentOfFloat)} of float` : "—"], ["Days to cover", num(ks.shortRatio, 1)], ["Revenue growth · margin", `${fpc(fd.revenueGrowth)} · ${fpc(fd.profitMargins)}`],
    ];
    const about = ap.longBusinessSummary ? String(ap.longBusinessSummary) : "";
    return `<div class="mt-card"><h5>${esc(sym)} <em>${q.marketTime ? `price as of ${new Date(q.marketTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}${fresh ? "" : " (not live)"}` : ""}</em></h5>
      <div class="mt-hd"><b>${esc(name)}</b><span class="px">${px ? usd(px) : "—"}</span>${Number.isFinite(q.changePct) ? `<span class="${cls(q.changePct)}">${q.change >= 0 ? "+" : "−"}${num(Math.abs(q.change))} (${pct(q.changePct)})</span>` : ""}<span class="dim" style="font-size:12px">${esc([q.exchange, ap.sector, ap.industry].filter(Boolean).join(" · "))}</span></div>
      <div class="mt-kv">${kv.map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join("")}</div>
      ${eDays != null && eDays >= 0 && eDays <= 7 ? `<div class="mt-warn">Earnings in ${eDays} day${eDays === 1 ? "" : "s"}: the price can jump a lot on the report.</div>` : ""}
      ${(MT.side === "SHORT") && ks.shortPercentOfFloat > 0.15 ? `<div class="mt-warn">${fpc(ks.shortPercentOfFloat)} of the shares are already sold short, so a squeeze is more likely and real borrowing would likely cost more than the modeled fee.</div>` : ""}
      ${about ? `<div class="mt-about">${esc(about.length > 320 ? about.slice(0, 320).replace(/\s\S*$/, "") + "…" : about)} <a href="#research/${encodeURIComponent(sym)}">Full research →</a></div>` : `<div class="mt-about"><a href="#research/${encodeURIComponent(sym)}">Full research →</a></div>`}</div>`;
  }
  // the order estimate (Schwab: "Estimated Cost"), shared by the ticket and the review screen
  // multi-asset: futures and options are priced per contract (price × multiplier), FX and crypto in units
  const instM = (sym) => (window.MDInstruments ? MDInstruments.normalize({ symbol: sym, quoteType: ((MT.info[sym] || {}).q || {}).instrumentType }) : { assetClass: "equity" });
  const multM = (sym) => (window.MDInstruments ? MDInstruments.multiplierOf(instM(sym)) : 1);
  const unitWord = (sym) => { const c = instM(sym).assetClass; return c === "future" || c === "option" ? "Contracts" : c === "crypto" || c === "forex" ? "Units" : "Shares"; };
  function estimate(d) {
    const sym = symOf(), x = MT.info[sym], q = (x && x.q) || {}, p = posOf(d, sym), m = multM(sym);
    return MDOrderPreview.preview({ side: MT.side, mode: MT.mode, qty: +MT.vals.qty }, Number.isFinite(q.price) ? q.price * m : q.price, { buyingPower: d.buyingPower ?? d.cash, value: d.value }, p ? { dir: p.dir, shares: p.shares, cost: p.cost * m } : null, d.rules);
  }
  const row = (l, v, c = "") => `<div class="mt-row ${c}"><span>${l}</span><b>${v}</b></div>`;
  function estRows(d, pv) {
    const sym = symOf(), m = multM(sym);
    let r = row(unitWord(sym), sh(pv.shares)) + (m !== 1 ? row("Contract multiplier", `× ${m.toLocaleString("en-US")} (fully cash-backed, whole contracts)`) : "") + row(m !== 1 ? "Value per contract" : "Last price", usd(pv.price)) + row(`Est. fill price (incl. ${(d.rules.cost * 100).toFixed(3).replace(/0+$/, "")}% trading cost)`, usd(pv.fill));
    if (pv.side === "BUY") r += row("Estimated cost", usd(pv.amount), "big") + row("Free cash after", usd(pv.freeAfter, 0)) + row("Share of your account", Math.round(pv.weight * 100) + "%");
    if (pv.side === "SHORT") r += row("Estimated proceeds", usd(pv.amount), "big") + row("Cash set aside to back it", usd(pv.setAside, 0)) + row("Borrow fee (modeled)", `${usd(pv.borrowDay)}/day · ${usd(pv.borrowMonth)}/mo`) + row("Automatic buy-back at", usd(pv.autoCover)) + row("Free cash after", usd(pv.freeAfter, 0));
    if (pv.side === "SELL") r += row("Estimated proceeds", usd(pv.amount), "big") + row("Gain / loss vs your cost", `<span class="${cls(pv.pnl)}">${sgn(pv.pnl)} (${pct(pv.pnlPct * 100)})</span>`);
    if (pv.side === "COVER") r += row("Estimated cost to cover", usd(pv.amount), "big") + row("Gain / loss vs your short", `<span class="${cls(pv.pnl)}">${sgn(pv.pnl)} (${pct(pv.pnlPct * 100)})</span>`);
    return r + row("Modeled trading cost", usd(pv.cost));
  }
  function look(d) {
    if (!d) return ""; const sym = symOf();
    if (!sym) return `<div class="mt-card mt-empty">Enter a symbol and its quote, company details and key stats appear here.</div>`;
    const x = MT.info[sym];
    if (!x || x.loading) return `<div class="mt-card mt-empty"><span class="spin"></span> Looking up ${esc(sym)}…</div>`;
    if (!x.q || !(x.q.price > 0)) return `<div class="mt-card mt-empty">No quote found for ${esc(sym)}${x.err ? ` (${esc(x.err)})` : ""}. Check the symbol.</div>`;
    return infoCard(sym, x);
  }
  function estLine(d) {
    if (!symOf()) return `<span class="dim">Type a ticker to see its price and what the order would cost.</span>`;
    const pv = estimate(d);
    if (!pv.ok) return `<span class="dim">${esc(pv.why)}</span>`;
    const lab = pv.side === "BUY" ? "Estimated cost" : pv.side === "COVER" ? "Estimated cost to cover" : "Estimated proceeds";
    return `<span>${lab}</span><b>${usd(pv.amount)}</b><small>${sh(pv.shares)} sh × ${usd(pv.fill)}</small>${pv.warn.length ? `<div class="mt-warn" style="flex-basis:100%">${pv.warn.map(esc).join(" ")}</div>` : ""}`;
  }
  let lookT = null;
  setInterval(() => { const sym = symOf(); if (sym && $("mtLook") && BOTS.sel === "me") lookup(sym, true); }, 20_000);
  function ticket(d) {
    if (window.__VISITOR) return "";
    fitAction(d);
    const sym = symOf(), p = posOf(d, sym), acts = actions(p), all = MT.mode === "all";
    const head = `<h4>Trade <em>${d.marketOpen ? '<span class="up">●</span> market open · market orders fill at the live price' : "market closed · orders fill at the first fresh price after the open"}</em></h4>`;
    if (MT.review) {
      const pv = estimate(d);
      return `<div class="mt-t" id="mtTicket">${head}<div class="mt-wrap"><div class="mt-tk">
        <div class="mt-rv-h">Review your order</div>
        <div class="mt-rv-t"><b>${esc(ACT[MT.side])}</b> ${all ? "all" : sh(pv.ok ? pv.shares : 0)} ${esc(sym)} · market order</div>
        ${pv.ok ? estRows(d, pv) : `<div class="mt-warn">${esc(pv.why)}</div>`}
        ${MT.vals.note ? row("Why", esc(MT.vals.note)) : ""}
        ${pv.ok && pv.warn.length ? pv.warn.map((w) => `<div class="mt-warn">${esc(w)}</div>`).join("") : ""}
        <div class="mt-about">Estimated from the last price. A market order fills at the price at that moment${d.marketOpen ? "" : ", which with the market closed is after the open, and prices can gap overnight"}.</div>
        <div class="mt-btns"><button type="button" class="mt-ghost" id="mtEdit">Edit</button><button type="button" class="mt-go" id="mtPlace" ${MT.busy || !pv.ok ? "disabled" : ""}>${MT.busy ? "Placing…" : "Place order"}</button></div>
        <div class="mt-msg" id="mtMsg">${MT.msg}</div>
      </div><div id="mtLook">${look(d)}</div></div></div>`;
    }
    const hold = !sym ? "" : p ? `${p.dir === "short" ? `You're <b class="down">short ${sh(p.shares)}</b>` : `You own <b>${sh(p.shares)}</b>`} ${esc(sym)} · avg ${usd(p.cost)}${p.pnl != null ? ` · <span class="${cls(p.pnl)}">${sgn(p.pnl)}</span>` : ""}` : `You don't hold ${esc(sym)}`;
    return `<div class="mt-t" id="mtTicket">${head}<div class="mt-wrap"><form class="mt-tk" id="mtForm" autocomplete="off">
      <label><small>Symbol</small><input id="mtSym" list="mtOwn" placeholder="e.g. NVDA" value="${esc(MT.vals.sym)}" style="text-transform:uppercase" required><datalist id="mtOwn">${d.positions.map((x) => `<option value="${esc(x.sym)}">`).join("")}</datalist></label>
      ${sym ? `<div class="mt-hold">${hold}</div>` : ""}
      <div class="mt-fld" role="group" aria-labelledby="mtSideL"><small id="mtSideL">Action</small><div class="mt-acts" id="mtSide">${acts.map(([s, m, l]) => { const on = MT.side === s && (m === "all") === all; return `<button type="button" data-s="${s}" data-m="${m}" aria-pressed="${on}" class="${on ? "on " + (s === "BUY" || s === "COVER" ? "b" : "s") : ""}">${on ? "✓ " : ""}${l}</button>`; }).join("")}</div></div>
      ${all ? `<div class="mt-hold">The whole position: ${p ? sh(p.shares) : 0} shares</div>` : `<div class="mt-two"><div class="mt-fld" role="group" aria-labelledby="mtModeL"><small id="mtModeL">Quantity in</small><div class="apseg" id="mtMode">${[["shares", "Shares"], ["amount", "Dollars"]].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${MT.mode === v}" class="${MT.mode === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
        <label><small>${MT.mode === "amount" ? "Dollars" : "Shares"}</small><input id="mtQty" type="number" min="0" step="any" value="${esc(MT.vals.qty)}" required placeholder="${MT.mode === "amount" ? "e.g. 2500" : "e.g. 10"}"></label></div>`}
      <div class="mt-two"><div class="mt-fld"><small>Order type</small><div class="mt-fixed">Market (fills at the current price)</div></div><div class="mt-fld"><small>Timing</small><div class="mt-fixed">${d.marketOpen ? "Now" : "Next open"}</div></div></div>
      <label><small>Why (optional, shows in your trade log)</small><input id="mtNote" maxlength="280" value="${esc(MT.vals.note)}" placeholder="e.g. uncertainty about Jensen Huang"></label>
      <div class="mt-est" id="mtEst">${estLine(d)}</div>
      <div class="mt-ctx">Free cash <b>${usd(d.buyingPower ?? d.cash, 0)}</b>${d.shortReserve ? ` · set aside for shorts <b>${usd(d.shortReserve, 0)}</b>` : ""}</div>
      <button class="mt-go" type="submit">Review order</button>
      <div class="mt-msg" id="mtMsg">${MT.msg}</div>
    </form><div id="mtLook">${look(d)}</div></div></div>`;
  }
  function wire(d) {
    if ($("mtEdit")) { $("mtEdit").onclick = () => { MT.review = false; MT.msg = ""; mtRender(d); }; }
    if ($("mtPlace")) $("mtPlace").onclick = async () => {
      if (MT.busy) return; const body = { side: MT.side, sym: symOf(), note: MT.vals.note.trim() };
      if (MT.mode === "all") body.all = true; else body[MT.mode] = +MT.vals.qty;
      MT.busy = true; mtRender(d);
      try {
        const r = await api("/api/mytrader/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        MT.msg = r.filled ? `<span class="up">Filled:</span> ${esc(ACT[r.trade.side])} ${sh(r.trade.shares)} ${esc(r.trade.sym)} at ${usd(r.trade.price)} (${usd(r.trade.amount)})${r.trade.pnl != null ? ` · <span class="${cls(r.trade.pnl)}">${sgn(r.trade.pnl)}</span>` : ""}` : `<span class="or">Order placed, waiting:</span> ${esc(r.why || "queued")}`;
        MT.vals = { sym: body.sym, qty: "", note: "" }; MT.review = false;
      } catch (err) { MT.msg = `<span class="down">${esc(err.message || "Order failed")}</span>`; MT.review = false; }
      MT.busy = false; await load();
    };
    const f = $("mtForm"); if (!f) return;
    $("mtSide").onclick = (e) => { const b = e.target.closest("[data-s]"); if (!b) return; keep(); MT.side = b.dataset.s; MT.mode = b.dataset.m === "all" ? "all" : MT.mode === "amount" ? "amount" : "shares"; MT.msg = ""; mtRender(d); };
    if ($("mtMode")) $("mtMode").onclick = (e) => { const b = e.target.closest("[data-v]"); if (!b) return; keep(); MT.mode = b.dataset.v; mtRender(d); };
    ["mtSym", "mtQty", "mtNote"].forEach((id) => $(id) && $(id).addEventListener("input", () => {
      keep();
      if (id === "mtSym") { clearTimeout(lookT); const sym = symOf(); lookT = setTimeout(() => { lookup(sym); const pos = $("mtSym").selectionStart; mtRender(d); const el = $("mtSym"); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } }, 350); }
      if (id === "mtQty") $("mtEst").innerHTML = estLine(d);
    }));
    f.onsubmit = (e) => { e.preventDefault(); keep(); const pv = estimate(d); if (!symOf()) return; if (!pv.ok && MT.info[symOf()] && MT.info[symOf()].q) { MT.msg = `<span class="down">${esc(pv.why)}</span>`; mtRender(d); return; } MT.msg = ""; MT.review = true; mtRender(d); };
    { const sym = symOf(); if (sym) lookup(sym); }
  }
  // quick actions from the holdings table (Robinhood/Schwab: sell or buy-to-cover straight from a position)
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-mtq]"); if (!b || !BOTS.d.me) return;
    MT.vals = { sym: b.dataset.mtq, qty: "", note: "" }; MT.side = b.dataset.act; MT.mode = "all"; MT.review = false; MT.msg = "";
    mtRender(BOTS.d.me); lookup(b.dataset.mtq); const t = $("mtTicket"); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  async function load() { try { BOTS.d.me = await api("/api/mytrader"); } catch (e) { MT.msg = `<span class="down">${esc(e.message)}</span>`; } if (BOTS.sel === "me" && BOTS.d.me) mtRender(BOTS.d.me); }

  function mtRender(d) {
    const ret = d.value / d.startValue - 1, started = !!d.firstTrade, spxRet = d.spx0 && d.spxNow ? d.spxNow / d.spx0 - 1 : null, spxV = spxRet == null ? null : d.startValue * (1 + spxRet), lead = spxV == null ? null : d.value - spxV;
    $("apVs").innerHTML = `<div class="ap-vs"><div class="ap-side ai ${started && lead >= 0 ? "lead" : ""}"><span>🧑 My Trader</span><b>${usd(d.value, 0)}</b><small class="${cls(ret)}">${pct(ret * 100)}</small></div>
      <div class="ap-mid">${started && lead != null ? `<b class="${cls(lead)}">${esc(typeof apLead === "function" ? apLead(ret, lead) : lead >= 0 ? "You lead" : "S&P leads")}</b><small>by ${usd(Math.abs(lead), 0)}</small>` : `<b>VS</b><small>starts with your first trade</small>`}</div>
      <div class="ap-side sp ${started && lead < 0 ? "lead" : ""}"><span>📈 S&amp;P 500</span><b>${spxV == null ? usd(d.startValue, 0) : usd(spxV, 0)}</b><small class="${cls(spxRet || 0)}">${spxRet == null ? "—" : pct(spxRet * 100)}</small></div></div>
      <div class="ap-live ${d.marketOpen ? "on" : ""}"><i></i><b>My Trader</b> · <span class="ap-tag own">you · paper money</span> ${d.marketOpen ? "Market open" : "Market closed"}${d.durable ? "" : ' · <span class="down">not saved between restarts on this server</span>'}</div>${ticket(d)}`;
    const eq = d.equity || [], lab = eq.map((p) => new Date(p.d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }));
    const ser = [{ v: eq.map((p) => p.v / d.startValue - 1), c: "#ff991f", n: "You", area: true, up: "#21c37a", down: "#ff6b6b", ao: 0.16 }];
    if (d.spx0 && eq.some((p) => p.spx)) ser.push({ v: eq.map((p) => (p.spx ? p.spx / d.spx0 - 1 : null)), c: "#9a9a9a", n: "S&P 500", dash: true, w: 1.4 });
    const pc = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
    const chart = eq.length >= 2 ? apSvgChart("mtC", lab, ser, { zero: true, fmt: pc, h: 220 }).replace('<div class="apc" id="mtC">', '<div class="apc" id="mtC" data-zero="1">') : `<div class="ap-empty" style="padding:24px 10px">Your chart appears after your first full trading day.</div>`;
    const s = d.stats || {};
    const shorts = d.positions.filter((p) => p.dir === "short");
    const tiles = [["Free cash", usd(d.buyingPower ?? d.cash, 0), d.shortReserve ? `${usd(d.shortReserve, 0)} set aside for shorts` : `${d.value ? Math.round((d.cash / d.value) * 100) : 0}% of the account`], ["Open positions", String(d.positions.length) + (shorts.length ? ` <small style="font-size:12px">(${shorts.length} short)</small>` : ""), d.pending.length ? `${d.pending.length} order(s) waiting` : "no orders waiting"],
      ["Closed trades", String(s.closed || 0), s.winRate != null ? `${Math.round(s.winRate * 100)}% winners` : "none yet"], ["Realized P&amp;L", sgn(s.realized), s.profitFactor != null ? `profit factor ${s.profitFactor.toFixed(2)}` : "after modeled costs"],
      ["Costs paid", usd((s.costs || 0) + (s.borrow || 0), 0), s.borrow ? `incl. ${usd(s.borrow)} borrow fees` : "modeled spread & slippage"]];
    $("apBox").innerHTML = `
      <div class="ap-mini">${tiles.map(([l, v, x]) => `<div><span>${l}</span><b>${v}</b><small>${x}</small></div>`).join("")}</div>
      <div class="bt-card"><h4>You vs. the S&amp;P 500 <em>return since your first trade</em></h4>${chart}</div>
      <div class="bt-card"><h4>Holdings <em>${d.positions.length} open</em></h4>${d.positions.length ? `<div class="ap-wrap"><table class="ap-tbl"><thead><tr><th>Stock</th><th>Side</th><th>Shares</th><th>Avg entry</th><th>Price</th><th>Value</th><th>Share of account</th><th>Stock today</th><th>Your P&amp;L</th><th></th></tr></thead><tbody>
        ${d.positions.map((p) => `<tr><td class="n"><b>${esc(p.sym)}</b></td><td><span class="sd ${p.dir === "short" ? "SELL" : "BUY"}">${p.dir === "short" ? "SHORT" : "LONG"}</span></td><td>${sh(p.shares)}</td><td>${usd(p.cost)}</td><td>${p.priced ? usd(p.price) : '<span class="dim">unavailable</span>'}</td><td>${usd(p.value, 0)}</td><td>${p.weight != null ? Math.round(p.weight * 100) + "%" : "—"}</td><td class="${cls(p.dayPct || 0)}">${p.dayPct != null ? pct(p.dayPct) : "—"}</td><td class="${p.pnl != null ? cls(p.pnl) : ""}">${p.pnl != null ? `${sgn(p.pnl)} (${pct(p.pnlPct * 100)})` : "—"}</td><td>${window.__VISITOR ? "" : `<button class="btn ghost" style="white-space:nowrap" data-mtq="${esc(p.sym)}" data-act="${p.dir === "short" ? "COVER" : "SELL"}">${p.dir === "short" ? "Close short" : "Sell"}</button>`}</td></tr>`).join("")}</tbody></table></div>` : '<div class="hd-empty">Nothing held yet. Use the ticket above to make your first trade.</div>'}
      ${shorts.length ? `<div class="ap-note">Shorts are bought back automatically if the price rises ${Math.round(d.rules.shortStop * 100)}% above your entry: ${shorts.map((p) => `${esc(p.sym)} at ${usd(p.autoCoverAt)}`).join(" · ")}.</div>` : ""}
      ${d.unpriced && d.unpriced.length ? `<div class="ap-note">No live price for ${d.unpriced.map(esc).join(", ")}; valued at cost until one arrives.</div>` : ""}</div>`;
    $("apMore").innerHTML = `${d.pending.length ? `<div class="bt-card"><h4>Waiting orders <em>fill at the first fresh price after you placed them</em></h4><div class="ap-wrap"><table class="ap-tbl"><thead><tr><th>Placed</th><th>Order</th><th>Size</th><th>Why</th><th></th></tr></thead><tbody>
        ${d.pending.map((o) => `<tr><td class="n">${when(o.at)}</td><td><span class="sd ${o.side === "BUY" || o.side === "COVER" ? "BUY" : "SELL"}">${o.side}</span> <b>${esc(o.sym)}</b></td><td>${o.all ? "whole position" : o.shares != null ? sh(o.shares) + " sh" : usd(o.amount, 0)}</td><td class="n">${esc(o.note || "")}</td><td>${window.__VISITOR ? "" : `<button class="btn ghost" data-mtcancel="${esc(o.id)}">Cancel</button>`}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
      <div class="bt-card"><h4>Your trade log <em>${d.trades.length} events · newest first</em></h4>${d.trades.length ? `<div class="ap-wrap ap-tl"><table class="ap-tbl"><thead><tr><th>Time</th><th>Action</th><th>Stock</th><th>Shares</th><th>Fill</th><th>Amount</th><th>Result</th><th>Why</th></tr></thead><tbody>
        ${d.trades.map((t) => `<tr><td class="n" style="white-space:nowrap">${when(t.t)}</td><td><span class="sd ${t.side === "BUY" || t.side === "COVER" ? "BUY" : t.side === "SELL" || t.side === "SHORT" ? "SELL" : ""}">${esc(t.side)}</span></td><td class="n"><b>${esc(t.sym)}</b></td><td>${t.shares != null ? sh(t.shares) : ""}</td><td>${t.price != null ? usd(t.price) : ""}</td><td>${t.amount != null ? usd(t.amount, 0) : ""}</td><td class="${t.pnl != null ? cls(t.pnl) : ""}">${t.pnl != null ? `${sgn(t.pnl)} (${pct(t.pnlPct * 100)})` : ""}</td><td class="n">${esc(t.auto || t.note || "")}</td></tr>`).join("")}</tbody></table></div>` : '<div class="hd-empty">No trades yet.</div>'}</div>
      <div class="bt-card"><h4>House rules <em>the same as the bots, so the race is fair</em></h4><ul class="ap-rules">
        <li><b>$30,000 of paper money</b>, the same start as each bot.</li>
        <li><b>Fills:</b> during regular hours an order fills at a live quote no more than ${Math.round(d.rules.maxQuoteAge / 60000)} minutes old. Otherwise it waits for the first fresh quote <i>after</i> you placed it, so you can't trade on a price you already saw.</li>
        <li><b>Costs:</b> ${(d.rules.cost * 100).toFixed(3).replace(/0+$/, "")}% of every buy and sell (${(d.rules.cost * 1e4).toFixed(1)} basis points) for the bid-ask spread and slippage, so fills aren't flattering.</li>
        <li><b>Long:</b> Buy and Sell, no margin. Fractional shares are allowed when you trade in dollars.</li>
        <li><b>Short:</b> Selling short means selling borrowed shares to bet the price falls; buying them back closes the short. You make money if the price drops and lose if it rises. Each short sets aside twice its value in cash (the sale proceeds plus the same again of yours), so your shorts can't add up to more than your account.</li>
        <li><b>Short costs and safety:</b> a modeled ${(d.rules.borrowYr * 100).toFixed(0)}% a year borrow fee, charged daily, and an automatic buy-back if a short rises ${Math.round(d.rules.shortStop * 100)}% above your entry. Dividends a real short would owe and hard-to-borrow fees aren't modeled.</li>
        <li>The S&amp;P 500 comparison starts the day of your first trade.</li></ul></div>`;
    if (eq.length >= 2) apWireChart("mtC", lab, ser, pc);
    document.querySelectorAll("[data-mtcancel]").forEach((b) => (b.onclick = async () => { b.disabled = true; try { await api("/api/mytrader/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: b.dataset.mtcancel }) }); MT.msg = "Order cancelled."; } catch (e) { MT.msg = `<span class="down">${esc(e.message)}</span>`; } load(); }));
    wire(d);
  }
  window.mtRender = mtRender; window.mtLoad = load;
  if (typeof S !== "undefined" && S.tab === "aitrade" && typeof BOTS !== "undefined" && BOTS.sel === "me") load();
})();

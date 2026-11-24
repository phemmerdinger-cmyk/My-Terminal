/* Market Desk · My Trader — the owner's own $30,000 paper account on the "Trading bots vs. the S&P 500" page.
   Server rules: my-trader-core.js (fills at a fresh quote stamped after the order + modeled costs; long only; paper money).
   Hooks used by index.html: window.mtRender(d) draws the view when "My Trader" is selected. */
(function () {
  "use strict";
  const MT = { side: "BUY", mode: "shares", msg: "", busy: false, vals: { sym: "", qty: "", note: "" } };
  const keep = () => { if ($("mtSym")) MT.vals = { sym: $("mtSym").value, qty: $("mtQty").value, note: $("mtNote").value }; };
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
.mt-g{display:grid;grid-template-columns:auto minmax(110px,1fr) auto minmax(110px,1fr);gap:10px 12px;align-items:end}
.mt-g label{display:grid;gap:5px;min-width:0}.mt-g small{font-size:11px;color:var(--muted)}
.mt-g input{width:100%;box-sizing:border-box;height:36px;padding:0 10px;border-radius:8px;border:1px solid var(--line2);background:var(--bg);color:var(--text);font:inherit;font-variant-numeric:tabular-nums}
.mt-g input:focus{outline:none;border-color:var(--orange)}.mt-g input:disabled{opacity:.5}
.mt-g .apseg{height:36px;box-sizing:border-box;align-items:stretch}.mt-g .apseg button{padding:0 12px}
.mt-g .apseg button.on.b{color:var(--up)}.mt-g .apseg button.on.s{color:var(--down)}
.mt-why{grid-column:1/4}.mt-go{height:36px;border:0;border-radius:8px;font-weight:700;cursor:pointer;background:var(--orange);color:#111}
.mt-go:disabled{opacity:.6;cursor:default}
.mt-ctx{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px;font-size:12px;color:var(--muted)}.mt-ctx b{color:var(--text);font-weight:600}
.mt-msg{margin-top:8px;font-size:13px;min-height:18px}
@media (max-width:820px){.mt-g{grid-template-columns:1fr 1fr}.mt-why{grid-column:1/-1}.mt-go{grid-column:1/-1}}`;
    document.head.appendChild(css);
  }
  const ACT = { BUY: ["Buy", "b", "Buy shares you think will rise"], SELL: ["Sell", "s", "Sell shares you own"], SHORT: ["Short", "s", "Bet the price falls: borrow and sell now, buy back later"], COVER: ["Cover", "b", "Buy back shares you shorted"] };
  function ctx(d) {
    const sym = (MT.vals.sym || "").trim().toUpperCase(), p = sym && d.positions.find((x) => x.sym === sym);
    const hold = !sym ? "" : p ? `<span>${p.dir === "short" ? "You're <b>short</b>" : "You own"} <b>${sh(p.shares)} ${esc(sym)}</b>${p.price != null ? ` at ${usd(p.price)}` : ""}${p.pnl != null ? ` · <span class="${cls(p.pnl)}">${sgn(p.pnl)}</span>` : ""}</span>` : `<span>You don't hold <b>${esc(sym)}</b></span>`;
    return `${hold}<span>Free cash <b>${usd(d.buyingPower ?? d.cash, 0)}</b></span>${d.shortReserve ? `<span>Set aside for shorts <b>${usd(d.shortReserve, 0)}</b></span>` : ""}<span>${esc(ACT[MT.side][2])}</span>`;
  }
  function ticket(d) {
    if (window.__VISITOR) return "";
    const closing = MT.side === "SELL" || MT.side === "COVER", own = d.positions.filter((p) => (MT.side === "SELL" ? p.dir !== "short" : MT.side === "COVER" ? p.dir === "short" : true)).map((p) => p.sym);
    const seg = (id, opts, cur) => `<div class="apseg" id="${id}">${opts.map(([v, l, c]) => `<button type="button" data-v="${v}" class="${cur === v ? "on " + (c || "") : ""}">${l}</button>`).join("")}</div>`;
    return `<div class="mt-t" id="mtTicket"><h4>Place a trade <em>${d.marketOpen ? '<span class="up">●</span> market open · fills at the live price' : "market closed · fills at the first fresh price after the open"}</em></h4>
      <form id="mtForm" class="mt-g" autocomplete="off">
        <label><small>Action</small>${seg("mtSide", Object.entries(ACT).map(([k, [l, c]]) => [k, l, c]), MT.side)}</label>
        <label><small>Ticker</small><input id="mtSym" list="mtOwn" placeholder="e.g. NVDA" value="${esc(MT.vals.sym)}" style="text-transform:uppercase" required><datalist id="mtOwn">${own.map((x) => `<option value="${esc(x)}">`).join("")}</datalist></label>
        <label><small>Size in</small>${seg("mtMode", [["shares", "Shares"], ["amount", "Dollars"], ...(closing ? [["all", "All"]] : [])], MT.mode)}</label>
        <label><small>${MT.mode === "amount" ? "Dollars" : MT.mode === "all" ? "Size" : "Shares"}</small><input id="mtQty" type="number" min="0" step="any" value="${MT.mode === "all" ? "" : esc(MT.vals.qty)}" ${MT.mode === "all" ? 'disabled placeholder="the whole position"' : `required placeholder="${MT.mode === "amount" ? "e.g. 2,500" : "e.g. 10"}"`}></label>
        <label class="mt-why"><small>Why (optional, shows in your trade log)</small><input id="mtNote" maxlength="280" value="${esc(MT.vals.note)}" placeholder="e.g. uncertainty about Jensen Huang"></label>
        <button class="mt-go" type="submit" ${MT.busy ? "disabled" : ""}>${MT.busy ? "Sending…" : ACT[MT.side][0]}</button>
      </form>
      <div class="mt-ctx" id="mtCtx">${ctx(d)}</div>
      <div class="mt-msg" id="mtMsg">${MT.msg}</div></div>`;
  }
  function wire(d) {
    const f = $("mtForm"); if (!f) return;
    $("mtSide").onclick = (e) => { const b = e.target.closest("[data-v]"); if (!b) return; keep(); MT.side = b.dataset.v; if (MT.mode === "all" && !(MT.side === "SELL" || MT.side === "COVER")) MT.mode = "shares"; MT.msg = ""; mtRender(d); };
    $("mtMode").onclick = (e) => { const b = e.target.closest("[data-v]"); if (!b) return; keep(); MT.mode = b.dataset.v; mtRender(d); };
    ["mtSym", "mtQty", "mtNote"].forEach((id) => $(id).addEventListener("input", () => { keep(); if (id === "mtSym") $("mtCtx").innerHTML = ctx(d); }));
    f.onsubmit = async (e) => {
      e.preventDefault(); if (MT.busy) return; keep();
      const body = { side: MT.side, sym: MT.vals.sym.trim().toUpperCase(), note: MT.vals.note.trim() }, qty = +MT.vals.qty;
      if (MT.mode === "all") body.all = true; else body[MT.mode] = qty;
      MT.busy = true; $("mtMsg").textContent = "Sending…";
      try {
        const r = await api("/api/mytrader/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        MT.msg = r.filled ? `<span class="up">Filled:</span> ${esc(ACT[r.trade.side][0].toLowerCase())} ${sh(r.trade.shares)} ${esc(r.trade.sym)} at ${usd(r.trade.price)} (${usd(r.trade.amount)})${r.trade.pnl != null ? ` · <span class="${cls(r.trade.pnl)}">${sgn(r.trade.pnl)}</span>` : ""}` : `<span class="or">Waiting:</span> ${esc(r.why || "queued")}`;
        MT.vals = { sym: "", qty: "", note: "" };
      } catch (err) { MT.msg = `<span class="down">${esc(err.message || "Order failed")}</span>`; }
      MT.busy = false; await load();
    };
  }
  async function load() { try { BOTS.d.me = await api("/api/mytrader"); } catch (e) { MT.msg = `<span class="down">${esc(e.message)}</span>`; } if (BOTS.sel === "me" && BOTS.d.me) mtRender(BOTS.d.me); }

  function mtRender(d) {
    const ret = d.value / d.startValue - 1, started = !!d.firstTrade, spxRet = d.spx0 && d.spxNow ? d.spxNow / d.spx0 - 1 : null, spxV = spxRet == null ? null : d.startValue * (1 + spxRet), lead = spxV == null ? null : d.value - spxV;
    $("apVs").innerHTML = `<div class="ap-vs"><div class="ap-side ai ${started && lead >= 0 ? "lead" : ""}"><span>🧑 My Trader</span><b>${usd(d.value, 0)}</b><small class="${cls(ret)}">${pct(ret * 100)}</small></div>
      <div class="ap-mid">${started && lead != null ? `<b class="${cls(lead)}">${lead >= 0 ? "You lead" : "S&amp;P leads"}</b><small>by ${usd(Math.abs(lead), 0)}</small>` : `<b>VS</b><small>starts with your first trade</small>`}</div>
      <div class="ap-side sp ${started && lead < 0 ? "lead" : ""}"><span>📈 S&amp;P 500</span><b>${spxV == null ? usd(d.startValue, 0) : usd(spxV, 0)}</b><small class="${cls(spxRet || 0)}">${spxRet == null ? "—" : pct(spxRet * 100)}</small></div></div>
      <div class="ap-live ${d.marketOpen ? "on" : ""}"><i></i><b>My Trader</b> · <span class="ap-tag own">you · paper money</span> ${d.marketOpen ? "Market open" : "Market closed"}${d.durable ? "" : ' · <span class="down">not saved between restarts on this server</span>'}</div>${ticket(d)}`;
    const eq = d.equity || [], lab = eq.map((p) => new Date(p.d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }));
    const ser = [{ v: eq.map((p) => p.v / d.startValue - 1), c: "#ff991f", n: "You", area: true, up: "#21c37a", down: "#ff6b6b", ao: 0.16 }];
    if (d.spx0 && eq.some((p) => p.spx)) ser.push({ v: eq.map((p) => (p.spx ? p.spx / d.spx0 - 1 : null)), c: "#9a9a9a", n: "S&P 500", dash: true, w: 1.4 });
    const pc = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
    const chart = eq.length >= 2 ? apSvgChart("mtC", lab, ser, { zero: true, fmt: pc, h: 220 }).replace('<div class="apc" id="mtC">', '<div class="apc" id="mtC" data-zero="1">') : `<div class="ap-empty" style="padding:24px 10px">Your curve starts after your first trade and its second day.</div>`;
    const s = d.stats || {};
    const shorts = d.positions.filter((p) => p.dir === "short");
    const tiles = [["Free cash", usd(d.buyingPower ?? d.cash, 0), d.shortReserve ? `${usd(d.shortReserve, 0)} set aside for shorts` : `${d.value ? Math.round((d.cash / d.value) * 100) : 0}% of the account`], ["Open positions", String(d.positions.length) + (shorts.length ? ` <small style="font-size:12px">(${shorts.length} short)</small>` : ""), d.pending.length ? `${d.pending.length} order(s) waiting` : "no orders waiting"],
      ["Closed trades", String(s.closed || 0), s.winRate != null ? `${Math.round(s.winRate * 100)}% winners` : "none yet"], ["Realized P&amp;L", sgn(s.realized), s.profitFactor != null ? `profit factor ${s.profitFactor.toFixed(2)}` : "after modeled costs"],
      ["Costs paid", usd((s.costs || 0) + (s.borrow || 0), 0), s.borrow ? `incl. ${usd(s.borrow)} borrow fees` : "modeled spread & slippage"]];
    $("apBox").innerHTML = `
      <div class="ap-mini">${tiles.map(([l, v, x]) => `<div><span>${l}</span><b>${v}</b><small>${x}</small></div>`).join("")}</div>
      <div class="bt-card"><h4>You vs. the S&amp;P 500 <em>return since your first trade</em></h4>${chart}</div>
      <div class="bt-card"><h4>Holdings <em>${d.positions.length} open</em></h4>${d.positions.length ? `<div class="ap-wrap"><table class="ap-tbl"><thead><tr><th>Stock</th><th>Side</th><th>Shares</th><th>Avg entry</th><th>Price</th><th>Value</th><th>Weight</th><th>Today</th><th>P&amp;L</th></tr></thead><tbody>
        ${d.positions.map((p) => `<tr><td class="n"><b>${esc(p.sym)}</b></td><td><span class="sd ${p.dir === "short" ? "SELL" : "BUY"}">${p.dir === "short" ? "SHORT" : "LONG"}</span></td><td>${sh(p.shares)}</td><td>${usd(p.cost)}</td><td>${p.priced ? usd(p.price) : '<span class="dim">unavailable</span>'}</td><td>${usd(p.value, 0)}</td><td>${p.weight != null ? Math.round(p.weight * 100) + "%" : "—"}</td><td class="${cls(p.dayPct || 0)}">${p.dayPct != null ? pct(p.dayPct) : "—"}</td><td class="${p.pnl != null ? cls(p.pnl) : ""}">${p.pnl != null ? `${sgn(p.pnl)} (${pct(p.pnlPct * 100)})` : "—"}</td></tr>`).join("")}</tbody></table></div>` : '<div class="hd-empty">Nothing held yet. Use the ticket above to make your first trade.</div>'}
      ${shorts.length ? `<div class="ap-note">Shorts are bought back automatically if the price rises ${Math.round(d.rules.shortStop * 100)}% above your entry: ${shorts.map((p) => `${esc(p.sym)} at ${usd(p.autoCoverAt)}`).join(" · ")}.</div>` : ""}
      ${d.unpriced && d.unpriced.length ? `<div class="ap-note">No live price for ${d.unpriced.map(esc).join(", ")}; valued at cost until one arrives.</div>` : ""}</div>`;
    $("apMore").innerHTML = `${d.pending.length ? `<div class="bt-card"><h4>Waiting orders <em>fill at the first fresh price after you placed them</em></h4><div class="ap-wrap"><table class="ap-tbl"><thead><tr><th>Placed</th><th>Order</th><th>Size</th><th>Why</th><th></th></tr></thead><tbody>
        ${d.pending.map((o) => `<tr><td class="n">${when(o.at)}</td><td><span class="sd ${o.side === "BUY" || o.side === "COVER" ? "BUY" : "SELL"}">${o.side}</span> <b>${esc(o.sym)}</b></td><td>${o.all ? "whole position" : o.shares != null ? sh(o.shares) + " sh" : usd(o.amount, 0)}</td><td class="n">${esc(o.note || "")}</td><td>${window.__VISITOR ? "" : `<button class="btn ghost" data-mtcancel="${esc(o.id)}">Cancel</button>`}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
      <div class="bt-card"><h4>Your trade log <em>${d.trades.length} events · newest first</em></h4>${d.trades.length ? `<div class="ap-wrap ap-tl"><table class="ap-tbl"><thead><tr><th>Time</th><th>Action</th><th>Stock</th><th>Shares</th><th>Fill</th><th>Amount</th><th>Result</th><th>Why</th></tr></thead><tbody>
        ${d.trades.map((t) => `<tr><td class="n" style="white-space:nowrap">${when(t.t)}</td><td><span class="sd ${t.side === "BUY" || t.side === "COVER" ? "BUY" : t.side === "SELL" || t.side === "SHORT" ? "SELL" : ""}">${esc(t.side)}</span></td><td class="n"><b>${esc(t.sym)}</b></td><td>${t.shares != null ? sh(t.shares) : ""}</td><td>${t.price != null ? usd(t.price) : ""}</td><td>${t.amount != null ? usd(t.amount, 0) : ""}</td><td class="${t.pnl != null ? cls(t.pnl) : ""}">${t.pnl != null ? `${sgn(t.pnl)} (${pct(t.pnlPct * 100)})` : ""}</td><td class="n">${esc(t.auto || t.note || "")}</td></tr>`).join("")}</tbody></table></div>` : '<div class="hd-empty">No trades yet.</div>'}</div>
      <div class="bt-card"><h4>House rules <em>the same as the bots, so the race is fair</em></h4><ul class="ap-rules">
        <li><b>$30,000 of paper money</b>, the same start as each bot.</li>
        <li><b>Fills:</b> during regular hours an order fills at a live quote no more than ${Math.round(d.rules.maxQuoteAge / 60000)} minutes old. Otherwise it waits for the first fresh quote <i>after</i> you placed it, so you can't trade on a price you already saw.</li>
        <li><b>Costs:</b> ${(d.rules.cost * 1e4).toFixed(1)} bps of modeled spread and slippage on every buy and sell.</li>
        <li><b>Long:</b> Buy and Sell, no margin. Fractional shares are allowed when you trade in dollars.</li>
        <li><b>Short:</b> Short sells shares you borrow; Cover buys them back. Each short sets aside twice its value in cash (the sale proceeds plus the same again of yours), so your shorts can't add up to more than your account.</li>
        <li><b>Short costs and safety:</b> a modeled ${(d.rules.borrowYr * 100).toFixed(0)}% a year borrow fee, charged daily, and an automatic buy-back if a short rises ${Math.round(d.rules.shortStop * 100)}% above your entry. Dividends a real short would owe and hard-to-borrow fees aren't modeled.</li>
        <li>The S&amp;P 500 comparison starts the day of your first trade.</li></ul></div>`;
    if (eq.length >= 2) apWireChart("mtC", lab, ser, pc);
    document.querySelectorAll("[data-mtcancel]").forEach((b) => (b.onclick = async () => { b.disabled = true; try { await api("/api/mytrader/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: b.dataset.mtcancel }) }); MT.msg = "Order cancelled."; } catch (e) { MT.msg = `<span class="down">${esc(e.message)}</span>`; } load(); }));
    wire(d);
  }
  window.mtRender = mtRender; window.mtLoad = load;
  if (typeof S !== "undefined" && S.tab === "aitrade" && typeof BOTS !== "undefined" && BOTS.sel === "me") load();
})();

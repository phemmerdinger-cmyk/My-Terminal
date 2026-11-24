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

  function ticket(d) {
    if (window.__VISITOR) return "";
    const own = d.positions.map((p) => p.sym);
    return `<div class="bt-card" id="mtTicket"><h4>Place a trade <em>paper money · ${d.marketOpen ? "market open: fills at the live price" : "market closed: fills at the first fresh price after the open"}</em></h4>
      <form id="mtForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;align-items:start">
        <label style="display:grid;gap:4px"><small>Side</small><div class="apseg" id="mtSide">${["BUY", "SELL"].map((s) => `<button type="button" data-v="${s}" class="${MT.side === s ? "on" : ""}">${s === "BUY" ? "Buy" : "Sell"}</button>`).join("")}</div></label>
        <label style="display:grid;gap:4px"><small>Ticker</small><input id="mtSym" list="mtOwn" autocomplete="off" value="${esc(MT.vals.sym)}" placeholder="e.g. AAPL" style="text-transform:uppercase;width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--line2,#333);background:#0b0b0b;color:inherit;font:inherit" required><datalist id="mtOwn">${own.map((s) => `<option value="${esc(s)}">`).join("")}</datalist></label>
        <label style="display:grid;gap:4px"><small>Size</small><div class="apseg" id="mtMode">${[["shares", "Shares"], ["amount", "Dollars"], ...(MT.side === "SELL" ? [["all", "All"]] : [])].map(([v, l]) => `<button type="button" data-v="${v}" class="${MT.mode === v ? "on" : ""}">${l}</button>`).join("")}</div></label>
        <label style="display:grid;gap:4px"><small>${MT.mode === "amount" ? "Dollars" : "Shares"}</small><input id="mtQty" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--line2,#333);background:#0b0b0b;color:inherit;font:inherit" type="number" min="0" step="any" value="${esc(MT.vals.qty)}" ${MT.mode === "all" ? "disabled placeholder=\"everything\"" : "required"}></label>
        <label style="display:grid;gap:4px;grid-column:1/-1"><small>Why (optional, shows in your trade log)</small><input id="mtNote" style="width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--line2,#333);background:#0b0b0b;color:inherit;font:inherit" maxlength="280" value="${esc(MT.vals.note)}" placeholder="e.g. earnings beat, breaking out above resistance"></label>
        <button class="btn" type="submit" ${MT.busy ? "disabled" : ""}>${MT.busy ? "Sending…" : MT.side === "BUY" ? "Buy" : "Sell"}</button>
        <span class="ap-note" id="mtMsg" style="margin:0;grid-column:span 3">${MT.msg}</span>
      </form>
      <div class="ap-note">Cash available ${usd(d.cash)} · modeled spread and slippage ${(d.rules.cost * 1e4).toFixed(1)} bps each way, the same as the swing bot · long only, no margin, no shorting.</div></div>`;
  }
  function wire(d) {
    const f = $("mtForm"); if (!f) return;
    $("mtSide").onclick = (e) => { const b = e.target.closest("[data-v]"); if (!b) return; keep(); MT.side = b.dataset.v; if (MT.side === "BUY" && MT.mode === "all") MT.mode = "shares"; MT.msg = ""; mtRender(d); };
    $("mtMode").onclick = (e) => { const b = e.target.closest("[data-v]"); if (!b) return; keep(); MT.mode = b.dataset.v; mtRender(d); };
    f.onsubmit = async (e) => {
      e.preventDefault(); if (MT.busy) return;
      const body = { side: MT.side, sym: $("mtSym").value.trim().toUpperCase(), note: $("mtNote").value.trim() }, qty = +$("mtQty").value;
      if (MT.mode === "all") body.all = true; else body[MT.mode] = qty;
      MT.busy = true; $("mtMsg").textContent = "Sending…";
      try {
        const r = await api("/api/mytrader/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        MT.msg = r.filled ? `<span class="up">Filled:</span> ${esc(r.trade.side)} ${sh(r.trade.shares)} ${esc(r.trade.sym)} at ${usd(r.trade.price)} (${usd(r.trade.amount)})` : `<span class="or">Waiting:</span> ${esc(r.why || "queued")}`;
      } catch (err) { MT.msg = `<span class="down">${esc(err.message || "Order failed")}</span>`; }
      MT.busy = false; if (/Filled|Waiting/.test(MT.msg)) MT.vals = { sym: "", qty: "", note: "" }; else keep(); await load();
    };
  }
  async function load() { try { BOTS.d.me = await api("/api/mytrader"); } catch (e) { MT.msg = `<span class="down">${esc(e.message)}</span>`; } if (BOTS.sel === "me" && BOTS.d.me) mtRender(BOTS.d.me); }

  function mtRender(d) {
    const ret = d.value / d.startValue - 1, started = !!d.firstTrade, spxRet = d.spx0 && d.spxNow ? d.spxNow / d.spx0 - 1 : null, spxV = spxRet == null ? null : d.startValue * (1 + spxRet), lead = spxV == null ? null : d.value - spxV;
    $("apVs").innerHTML = `<div class="ap-vs"><div class="ap-side ai ${started && lead >= 0 ? "lead" : ""}"><span>🧑 My Trader</span><b>${usd(d.value, 0)}</b><small class="${cls(ret)}">${pct(ret * 100)}</small></div>
      <div class="ap-mid">${started && lead != null ? `<b class="${cls(lead)}">${lead >= 0 ? "You lead" : "S&amp;P leads"}</b><small>by ${usd(Math.abs(lead), 0)}</small>` : `<b>VS</b><small>starts with your first trade</small>`}</div>
      <div class="ap-side sp ${started && lead < 0 ? "lead" : ""}"><span>📈 S&amp;P 500</span><b>${spxV == null ? usd(d.startValue, 0) : usd(spxV, 0)}</b><small class="${cls(spxRet || 0)}">${spxRet == null ? "—" : pct(spxRet * 100)}</small></div></div>
      <div class="ap-live ${d.marketOpen ? "on" : ""}"><i></i><b>My Trader</b> · <span class="ap-tag own">you · paper money</span> ${d.marketOpen ? "Market open" : "Market closed"}${d.durable ? "" : ' · <span class="down">not saved between restarts on this server</span>'}</div>`;
    const eq = d.equity || [], lab = eq.map((p) => new Date(p.d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }));
    const ser = [{ v: eq.map((p) => p.v / d.startValue - 1), c: "#ff991f", n: "You", area: true, up: "#21c37a", down: "#ff6b6b", ao: 0.16 }];
    if (d.spx0 && eq.some((p) => p.spx)) ser.push({ v: eq.map((p) => (p.spx ? p.spx / d.spx0 - 1 : null)), c: "#9a9a9a", n: "S&P 500", dash: true, w: 1.4 });
    const pc = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
    const chart = eq.length >= 2 ? apSvgChart("mtC", lab, ser, { zero: true, fmt: pc, h: 220 }).replace('<div class="apc" id="mtC">', '<div class="apc" id="mtC" data-zero="1">') : `<div class="ap-empty" style="padding:24px 10px">Your curve starts after your first trade and its second day.</div>`;
    const s = d.stats || {};
    const tiles = [["Cash", usd(d.cash, 0), `${d.value ? Math.round((d.cash / d.value) * 100) : 0}% of the account`], ["Open positions", String(d.positions.length), d.pending.length ? `${d.pending.length} order(s) waiting` : "no orders waiting"],
      ["Closed trades", String(s.closed || 0), s.winRate != null ? `${Math.round(s.winRate * 100)}% winners` : "none yet"], ["Realized P&amp;L", sgn(s.realized), s.profitFactor != null ? `profit factor ${s.profitFactor.toFixed(2)}` : "after modeled costs"],
      ["Costs paid", usd(s.costs, 0), "modeled spread & slippage"]];
    $("apBox").innerHTML = `${ticket(d)}
      <div class="ap-mini">${tiles.map(([l, v, x]) => `<div><span>${l}</span><b>${v}</b><small>${x}</small></div>`).join("")}</div>
      <div class="bt-card"><h4>You vs. the S&amp;P 500 <em>return since your first trade</em></h4>${chart}</div>
      <div class="bt-card"><h4>Holdings <em>${d.positions.length} open</em></h4>${d.positions.length ? `<div class="ap-wrap"><table class="ap-tbl"><thead><tr><th>Stock</th><th>Shares</th><th>Avg cost</th><th>Price</th><th>Value</th><th>Weight</th><th>Today</th><th>P&amp;L</th></tr></thead><tbody>
        ${d.positions.map((p) => `<tr><td class="n"><b>${esc(p.sym)}</b></td><td>${sh(p.shares)}</td><td>${usd(p.cost)}</td><td>${p.priced ? usd(p.price) : '<span class="dim">unavailable</span>'}</td><td>${usd(p.value, 0)}</td><td>${p.weight != null ? Math.round(p.weight * 100) + "%" : "—"}</td><td class="${cls(p.dayPct || 0)}">${p.dayPct != null ? pct(p.dayPct) : "—"}</td><td class="${p.pnl != null ? cls(p.pnl) : ""}">${p.pnl != null ? `${sgn(p.pnl)} (${pct(p.pnlPct * 100)})` : "—"}</td></tr>`).join("")}</tbody></table></div>` : '<div class="hd-empty">Nothing held yet. Use the ticket above to make your first trade.</div>'}
      ${d.unpriced && d.unpriced.length ? `<div class="ap-note">No live price for ${d.unpriced.map(esc).join(", ")}; valued at cost until one arrives.</div>` : ""}</div>`;
    $("apMore").innerHTML = `${d.pending.length ? `<div class="bt-card"><h4>Waiting orders <em>fill at the first fresh price after you placed them</em></h4><div class="ap-wrap"><table class="ap-tbl"><thead><tr><th>Placed</th><th>Order</th><th>Size</th><th>Why</th><th></th></tr></thead><tbody>
        ${d.pending.map((o) => `<tr><td class="n">${when(o.at)}</td><td><span class="sd ${o.side}">${o.side}</span> <b>${esc(o.sym)}</b></td><td>${o.all ? "all shares" : o.shares != null ? sh(o.shares) + " sh" : usd(o.amount, 0)}</td><td class="n">${esc(o.note || "")}</td><td>${window.__VISITOR ? "" : `<button class="btn ghost" data-mtcancel="${esc(o.id)}">Cancel</button>`}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
      <div class="bt-card"><h4>Your trade log <em>${d.trades.length} events · newest first</em></h4>${d.trades.length ? `<div class="ap-wrap ap-tl"><table class="ap-tbl"><thead><tr><th>Time</th><th>Action</th><th>Stock</th><th>Shares</th><th>Fill</th><th>Amount</th><th>Result</th><th>Why</th></tr></thead><tbody>
        ${d.trades.map((t) => `<tr><td class="n" style="white-space:nowrap">${when(t.t)}</td><td><span class="sd ${t.side === "BUY" ? "BUY" : t.side === "SELL" ? "SELL" : ""}">${esc(t.side)}</span></td><td class="n"><b>${esc(t.sym)}</b></td><td>${t.shares != null ? sh(t.shares) : ""}</td><td>${t.price != null ? usd(t.price) : ""}</td><td>${t.amount != null ? usd(t.amount, 0) : ""}</td><td class="${t.pnl != null ? cls(t.pnl) : ""}">${t.pnl != null ? `${sgn(t.pnl)} (${pct(t.pnlPct * 100)})` : ""}</td><td class="n">${esc(t.note || "")}</td></tr>`).join("")}</tbody></table></div>` : '<div class="hd-empty">No trades yet.</div>'}</div>
      <div class="bt-card"><h4>House rules <em>the same as the bots, so the race is fair</em></h4><ul class="ap-rules">
        <li><b>$30,000 of paper money</b>, the same start as each bot.</li>
        <li><b>Fills:</b> during regular hours an order fills at a live quote no more than ${Math.round(d.rules.maxQuoteAge / 60000)} minutes old. Otherwise it waits for the first fresh quote <i>after</i> you placed it, so you can't trade on a price you already saw.</li>
        <li><b>Costs:</b> ${(d.rules.cost * 1e4).toFixed(1)} bps of modeled spread and slippage on every buy and sell.</li>
        <li><b>Long only:</b> no margin and no shorting. Fractional shares are allowed when you trade in dollars.</li>
        <li>The S&amp;P 500 comparison starts the day of your first trade.</li></ul></div>`;
    if (eq.length >= 2) apWireChart("mtC", lab, ser, pc);
    document.querySelectorAll("[data-mtcancel]").forEach((b) => (b.onclick = async () => { b.disabled = true; try { await api("/api/mytrader/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: b.dataset.mtcancel }) }); MT.msg = "Order cancelled."; } catch (e) { MT.msg = `<span class="down">${esc(e.message)}</span>`; } load(); }));
    wire(d);
  }
  window.mtRender = mtRender; window.mtLoad = load;
  if (typeof S !== "undefined" && S.tab === "aitrade" && typeof BOTS !== "undefined" && BOTS.sel === "me") load();
})();

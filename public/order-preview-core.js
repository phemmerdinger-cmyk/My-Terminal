/* What a My Trader order will cost before you place it. Mirrors my-trader-core.js (same cost, short backing,
   borrow fee and buy-back rules) so the estimate matches the fill, except that the real fill uses the price
   at the moment it fills. Pure; tested in tests/order-preview-core.test.js. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDOrderPreview = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;
  // o: {side, mode: "shares"|"amount"|"all", qty}; price: last price; acct: {buyingPower, value}; pos: {dir, shares, cost} or null
  // rules: {cost, borrowYr, shortStop}
  function preview(o, price, acct, pos, rules) {
    if (!(price > 0)) return { ok: false, why: "No live price for this ticker, so there's no estimate." };
    const side = o.side, pays = side === "BUY" || side === "COVER", fill = price * (pays ? 1 + rules.cost : 1 - rules.cost);
    const closing = side === "SELL" || side === "COVER", want = side === "SELL" ? "long" : "short";
    const held = pos && (pos.dir === "short" ? "short" : "long") === want ? pos.shares : 0;
    if (closing && !held) return { ok: false, why: side === "SELL" ? "You don't own this stock." : "You aren't short this stock." };
    let shares = o.mode === "all" ? held : o.mode === "amount" ? (o.qty > 0 ? o.qty / fill : 0) : o.qty > 0 ? o.qty : 0;
    shares = r4(closing ? Math.min(shares, held) : shares);
    if (!(shares > 0)) return { ok: false, why: "Enter a size to see the cost." };
    const gross = shares * price, amount = shares * fill, cost = gross * rules.cost, out = { ok: true, side, shares, price, fill: r2(fill), gross: r2(gross), amount: r2(amount), cost: r2(cost), warn: [] };
    if (side === "BUY") { out.cashChange = -r2(amount); out.freeAfter = r2(acct.buyingPower - amount); }
    if (side === "SHORT") {
      out.cashChange = r2(amount); out.setAside = r2(2 * amount); out.freeAfter = r2(acct.buyingPower - amount);
      out.borrowDay = r2(amount * rules.borrowYr / 360); out.borrowMonth = r2(amount * rules.borrowYr / 12); out.autoCover = r2(fill * (1 + rules.shortStop));
    }
    if (side === "SELL") { out.cashChange = r2(amount); out.pnl = r2((fill - pos.cost) * shares); out.pnlPct = fill / pos.cost - 1; }
    if (side === "COVER") { out.cashChange = -r2(amount); out.pnl = r2((pos.cost - fill) * shares); out.pnlPct = 1 - fill / pos.cost; }
    if ((side === "BUY" || side === "SHORT") && out.freeAfter < -0.005) out.warn.push(`Not enough free cash: you'd be ${Math.abs(out.freeAfter).toLocaleString("en-US", { style: "currency", currency: "USD" })} short.`);
    if ((side === "BUY" || side === "SHORT") && acct.value > 0) { out.weight = amount / acct.value; if (out.weight > 0.25) out.warn.push(`This is ${Math.round(out.weight * 100)}% of your account in one stock.`); }
    return out;
  }
  // where today's price sits inside a low–high range, 0..1 (null without a range)
  function within(price, low, high) { return price > 0 && Number.isFinite(low) && Number.isFinite(high) && high > low ? Math.max(0, Math.min(1, (price - low) / (high - low))) : null; }
  return { preview, within };
});

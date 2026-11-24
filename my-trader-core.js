// Market Desk — "My Trader": the owner's own $30,000 paper account, traded by hand and raced against the bots and the S&P 500.
// Pure rules (tested in tests/my-trader-core.test.js). Same fill model as the bots: a fresh quote stamped after the order,
// plus modeled spread/slippage per side. Long only, no margin, no shorting. Paper money only.
"use strict";
const START = 30_000, COST = 0.00075, MAX_QUOTE_AGE = 3 * 60_000;
const SYM = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;

function fresh(now = Date.now()) {
  return { v: 1, start: START, cash: START, positions: {}, pending: [], trades: [], equity: [], intraday: [], spx0: null, firstTrade: null, created: now, seq: 0 };
}
function usable(q, now, after = 0) {
  return !!q && Number.isFinite(q.price) && q.price > 0 && Number.isFinite(q.marketTime) && q.marketTime > after && q.marketTime <= now && now - q.marketTime <= MAX_QUOTE_AGE;
}
// order: {side: "BUY"|"SELL", sym, shares?, amount?, all?, note?}. Returns {ok, error} or {ok, order}.
function validate(st, o) {
  const side = String(o && o.side || "").toUpperCase(), sym = String(o && o.sym || "").trim().toUpperCase();
  if (side !== "BUY" && side !== "SELL") return { ok: false, error: "Choose buy or sell." };
  if (!SYM.test(sym)) return { ok: false, error: "That doesn't look like a ticker symbol." };
  const shares = o.shares == null || o.shares === "" ? null : +o.shares, amount = o.amount == null || o.amount === "" ? null : +o.amount, all = !!o.all;
  if (side === "BUY" && (all || (shares == null) === (amount == null))) return { ok: false, error: "Enter either a number of shares or a dollar amount." };
  if (side === "SELL" && !all && shares == null && amount == null) return { ok: false, error: "Enter shares, a dollar amount, or sell all." };
  if (shares != null && !(shares > 0 && shares <= 1e7)) return { ok: false, error: "Shares must be more than zero." };
  if (amount != null && !(amount >= 1 && amount <= 1e8)) return { ok: false, error: "The dollar amount must be at least $1." };
  if (side === "SELL") {
    const held = (st.positions[sym] || {}).shares || 0, queued = st.pending.filter((p) => p.side === "SELL" && p.sym === sym).length;
    if (!held) return { ok: false, error: `You don't own any ${sym}. Shorting isn't allowed.` };
    if (queued) return { ok: false, error: `A sell order for ${sym} is already waiting. Cancel it first.` };
    if (shares != null && shares > held + 1e-9) return { ok: false, error: `You only own ${r4(held)} shares of ${sym}.` };
  }
  return { ok: true, order: { side, sym, shares, amount, all: side === "SELL" && all, note: String(o.note || "").slice(0, 280) } };
}
// fill one order at quote q (already checked usable). Mutates st; returns the trade or {error}.
function fill(st, ord, q, now) {
  const { side, sym } = ord, px = q.price * (side === "BUY" ? 1 + COST : 1 - COST);
  if (side === "BUY") {
    let shares = ord.shares != null ? ord.shares : ord.amount / px; shares = r4(shares);
    const amt = shares * px;
    if (!(shares > 0)) return { error: "Order too small." };
    if (amt > st.cash + 0.005) return { error: `Not enough cash: this costs $${r2(amt).toLocaleString("en-US")} and you have $${r2(st.cash).toLocaleString("en-US")}.` };
    const p = st.positions[sym] || { shares: 0, cost: 0, at: now };
    p.cost = (p.cost * p.shares + amt) / (p.shares + shares); p.shares = r4(p.shares + shares); st.positions[sym] = p;
    st.cash = r2(st.cash - amt);
    const t = { id: ++st.seq, t: now, side, sym, shares, price: r2(px), quote: q.price, quoteAt: q.marketTime, amount: r2(amt), cost: r2(shares * q.price * COST), note: ord.note || "", placedAt: ord.at || now };
    st.trades.unshift(t); if (!st.firstTrade) st.firstTrade = now; return t;
  }
  const p = st.positions[sym]; if (!p) return { error: `You no longer own ${sym}.` };
  let shares = ord.all ? p.shares : ord.shares != null ? ord.shares : ord.amount / px; shares = Math.min(p.shares, r4(shares));
  if (!(shares > 0)) return { error: "Order too small." };
  const amt = shares * px, pnl = (px - p.cost) * shares;
  p.shares = r4(p.shares - shares); if (p.shares < 1e-4) delete st.positions[sym];
  st.cash = r2(st.cash + amt);
  const t = { id: ++st.seq, t: now, side, sym, shares, price: r2(px), quote: q.price, quoteAt: q.marketTime, amount: r2(amt), cost: r2(shares * q.price * COST), pnl: r2(pnl), pnlPct: r4(px / p.cost - 1), note: ord.note || "", placedAt: ord.at || now };
  st.trades.unshift(t); return t;
}
// place: fills now when the market is open and the quote is fresh; otherwise waits for the first fresh quote after the order.
function place(st, raw, { now = Date.now(), open = false, quote = null } = {}) {
  const v = validate(st, raw); if (!v.ok) return v;
  const ord = { ...v.order, id: "o" + (++st.seq), at: now };
  if (open && usable(quote, now)) { const t = fill(st, ord, quote, now); return t.error ? { ok: false, error: t.error } : { ok: true, filled: true, trade: t }; }
  st.pending.push(ord); return { ok: true, filled: false, order: ord, why: open ? "No fresh price right now; it fills at the next fresh quote." : "The market is closed; it fills at the first fresh price after the next open." };
}
// called every minute while the market is open: fill waiting orders with quotes stamped after they were placed.
function work(st, quotes, { now = Date.now(), open = false } = {}) {
  if (!open || !st.pending.length) return [];
  const done = [], keep = [];
  for (const o of st.pending) {
    const q = quotes[o.sym];
    if (!usable(q, now, o.at)) { keep.push(o); continue; }
    const t = fill(st, o, q, now);
    if (t.error) st.trades.unshift({ id: ++st.seq, t: now, side: "REJECTED", sym: o.sym, note: t.error, placedAt: o.at });
    done.push({ order: o, result: t });
  }
  st.pending = keep; return done;
}
function cancel(st, id) { const n = st.pending.length; st.pending = st.pending.filter((o) => o.id !== id); return n !== st.pending.length; }
// account value from the latest prices (a mark, not a fill); positions without a price are valued at cost and flagged.
function value(st, px) {
  let v = st.cash; const missing = [];
  for (const [s, p] of Object.entries(st.positions)) { const x = px[s]; if (Number.isFinite(x) && x > 0) v += p.shares * x; else { v += p.shares * p.cost; missing.push(s); } }
  return { value: r2(v), missing };
}
// one equity point per New York day (today's is overwritten until the day ends), and intraday points every few minutes.
function mark(st, { day, value: v, spx, now = Date.now(), intradayEvery = 5 * 60_000 }) {
  if (!st.firstTrade || !(v > 0)) return;
  if (st.spx0 == null && spx > 0) st.spx0 = spx;
  const last = st.equity[st.equity.length - 1];
  if (last && last.d === day) Object.assign(last, { v, spx: spx || last.spx }); else st.equity.push({ d: day, v, spx: spx || null });
  if (st.equity.length > 3000) st.equity.shift();
  const li = st.intraday[st.intraday.length - 1];
  if (li && new Date(li.t).toDateString() !== new Date(now).toDateString()) st.intraday = [];
  if (!li || now - li.t >= intradayEvery) st.intraday.push({ t: now, v, spx: spx || null });
  if (st.intraday.length > 400) st.intraday.shift();
}
function stats(st) {
  const closed = st.trades.filter((t) => t.side === "SELL" && Number.isFinite(t.pnl)), w = closed.filter((t) => t.pnl > 0);
  const gw = w.reduce((a, t) => a + t.pnl, 0), gl = -closed.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  return { closed: closed.length, wins: w.length, winRate: closed.length ? w.length / closed.length : null, realized: r2(gw - gl), profitFactor: gl > 0 ? r2(gw / gl) : null,
    costs: r2(st.trades.reduce((a, t) => a + (t.cost || 0), 0)), fills: st.trades.filter((t) => t.side === "BUY" || t.side === "SELL").length };
}
module.exports = { START, COST, MAX_QUOTE_AGE, fresh, usable, validate, place, work, cancel, value, mark, stats };

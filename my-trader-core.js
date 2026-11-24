// Market Desk — "My Trader": the owner's own $30,000 paper account, traded by hand and raced against the bots and the S&P 500.
// Pure rules (tested in tests/my-trader-core.test.js). Same fill model as the bots: a fresh quote stamped after the order,
// plus modeled spread/slippage per side. Long (BUY/SELL) and short (SHORT/COVER). No margin on longs; shorts must be backed by
// cash (the short's value is set aside twice: the sale proceeds plus your own money), so total shorts can't exceed the account.
// Shorts pay a modeled borrow fee daily and are bought back automatically if they lose half their entry price. Paper money only.
"use strict";
const START = 30_000, COST = 0.00075, MAX_QUOTE_AGE = 3 * 60_000, BORROW_YR = 0.03, SHORT_STOP = 0.5;
const SIDES = ["BUY", "SELL", "SHORT", "COVER"], OPENS = { BUY: "long", SHORT: "short" }, CLOSES = { SELL: "long", COVER: "short" };
const dirOf = (p) => (p && p.dir === "short" ? "short" : "long");
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
  if (!SIDES.includes(side)) return { ok: false, error: "Choose buy, sell, short or cover." };
  if (!SYM.test(sym)) return { ok: false, error: "That doesn't look like a ticker symbol." };
  const shares = o.shares == null || o.shares === "" ? null : +o.shares, amount = o.amount == null || o.amount === "" ? null : +o.amount, all = !!o.all, closing = !!CLOSES[side];
  if (!closing && (all || (shares == null) === (amount == null))) return { ok: false, error: "Enter either a number of shares or a dollar amount." };
  if (closing && !all && shares == null && amount == null) return { ok: false, error: "Enter shares, a dollar amount, or All." };
  if (shares != null && !(shares > 0 && shares <= 1e7)) return { ok: false, error: "Shares must be more than zero." };
  if (amount != null && !(amount >= 1 && amount <= 1e8)) return { ok: false, error: "The dollar amount must be at least $1." };
  const p = st.positions[sym], have = p ? dirOf(p) : null;
  if (closing) {
    const want = CLOSES[side], held = p && have === want ? p.shares : 0, queued = st.pending.some((x) => CLOSES[x.side] && x.sym === sym);
    if (!held) return { ok: false, error: want === "long" ? (have === "short" ? `You're short ${sym}. Use Cover to buy it back.` : `You don't own any ${sym}. To bet against it, choose Short.`) : `You aren't short ${sym}.` };
    if (queued) return { ok: false, error: `An order to close ${sym} is already waiting. Cancel it first.` };
    if (shares != null && shares > held + 1e-9) return { ok: false, error: `You only have ${r4(held)} shares of ${sym}.` };
  } else if (p && have !== OPENS[side]) return { ok: false, error: have === "long" ? `You own ${sym}. Sell it before shorting.` : `You're short ${sym}. Cover it before buying.` };
  return { ok: true, order: { side, sym, shares, amount, all: closing && all, note: String(o.note || "").slice(0, 280) } };
}
// cash set aside for open shorts: their current value twice (proceeds + the same again of your own money)
function shortReserve(st, px = {}) { let r = 0; for (const [s, p] of Object.entries(st.positions)) if (dirOf(p) === "short") r += 2 * p.shares * (Number.isFinite(px[s]) && px[s] > 0 ? px[s] : p.cost); return r; }
function buyingPower(st, px = {}) { return r2(st.cash - shortReserve(st, px)); }
// fill one order at quote q (already checked usable). Mutates st; returns the trade or {error}.
function fill(st, ord, q, now, why = "") {
  const { side, sym } = ord, pays = side === "BUY" || side === "COVER", px = q.price * (pays ? 1 + COST : 1 - COST);
  const rec = (t) => { const x = { id: ++st.seq, t: now, side, sym, price: r2(px), quote: q.price, quoteAt: q.marketTime, note: ord.note || "", placedAt: ord.at || now, ...(why ? { auto: why } : {}), ...t }; st.trades.unshift(x); if (!st.firstTrade) st.firstTrade = now; return x; };
  if (OPENS[side]) {
    const shares = r4(ord.shares != null ? ord.shares : ord.amount / px), amt = shares * px;
    if (!(shares > 0)) return { error: "Order too small." };
    const bp = buyingPower(st, { [sym]: q.price }), need = amt; // a buy spends amt; a short adds amt of proceeds but sets aside 2× amt, so either way it uses amt of free cash
    if (need > bp + 0.005) return { error: side === "BUY" ? `Not enough cash: this costs $${r2(amt).toLocaleString("en-US")} and you have $${Math.max(0, bp).toLocaleString("en-US")} free.` : `Not enough free cash to back this short: it needs $${r2(amt).toLocaleString("en-US")} and you have $${Math.max(0, bp).toLocaleString("en-US")} free.` };
    const p = st.positions[sym] || { shares: 0, cost: 0, at: now, dir: OPENS[side] };
    p.cost = (p.cost * p.shares + amt) / (p.shares + shares); p.shares = r4(p.shares + shares); st.positions[sym] = p;
    st.cash = r2(st.cash + (side === "BUY" ? -amt : amt));
    return rec({ shares, amount: r2(amt), cost: r2(shares * q.price * COST) });
  }
  const p = st.positions[sym]; if (!p || dirOf(p) !== CLOSES[side]) return { error: `You no longer have a ${CLOSES[side]} position in ${sym}.` };
  const shares = Math.min(p.shares, r4(ord.all ? p.shares : ord.shares != null ? ord.shares : ord.amount / px));
  if (!(shares > 0)) return { error: "Order too small." };
  const amt = shares * px, pnl = side === "SELL" ? (px - p.cost) * shares : (p.cost - px) * shares;
  p.shares = r4(p.shares - shares); if (p.shares < 1e-4) delete st.positions[sym];
  st.cash = r2(st.cash + (side === "SELL" ? amt : -amt));
  return rec({ shares, amount: r2(amt), cost: r2(shares * q.price * COST), pnl: r2(pnl), pnlPct: r4(side === "SELL" ? px / p.cost - 1 : 1 - px / p.cost) });
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
  if (!open) return [];
  const done = [], keep = [];
  // safety: buy back any short that has lost half its entry price
  for (const [sym, p] of Object.entries(st.positions)) {
    const q = quotes[sym];
    if (dirOf(p) === "short" && usable(q, now) && q.price >= p.cost * (1 + SHORT_STOP) && !st.pending.some((o) => o.sym === sym && o.side === "COVER")) {
      const t = fill(st, { side: "COVER", sym, all: true, note: "" }, q, now, `Automatic buy-back: the short lost ${Math.round(SHORT_STOP * 100)}% of its entry price`);
      done.push({ order: { side: "COVER", sym, auto: true }, result: t });
    }
  }
  for (const o of st.pending) {
    const q = quotes[o.sym];
    if (!usable(q, now, o.at)) { keep.push(o); continue; }
    const t = fill(st, o, q, now);
    if (t.error) st.trades.unshift({ id: ++st.seq, t: now, side: "REJECTED", sym: o.sym, note: t.error, placedAt: o.at });
    done.push({ order: o, result: t });
  }
  st.pending = keep; return done;
}
// borrow fee on open shorts, charged once per New York day from the short's current value
function borrow(st, { day, px = {} }) {
  if (st.borrowDay === day) return 0; const prev = st.borrowDay; st.borrowDay = day; if (!prev) return 0;
  let fee = 0; for (const [s, p] of Object.entries(st.positions)) if (dirOf(p) === "short") fee += p.shares * (Number.isFinite(px[s]) && px[s] > 0 ? px[s] : p.cost) * BORROW_YR / 360;
  fee = r2(fee); if (fee > 0) { st.cash = r2(st.cash - fee); st.borrowPaid = r2((st.borrowPaid || 0) + fee); } return fee;
}
function cancel(st, id) { const n = st.pending.length; st.pending = st.pending.filter((o) => o.id !== id); return n !== st.pending.length; }
// account value from the latest prices (a mark, not a fill); positions without a price are valued at cost and flagged.
function value(st, px) {
  let v = st.cash; const missing = [];
  for (const [s, p] of Object.entries(st.positions)) { const x = px[s], sign = dirOf(p) === "short" ? -1 : 1; if (Number.isFinite(x) && x > 0) v += sign * p.shares * x; else { v += sign * p.shares * p.cost; missing.push(s); } }
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
  const closed = st.trades.filter((t) => (t.side === "SELL" || t.side === "COVER") && Number.isFinite(t.pnl)), w = closed.filter((t) => t.pnl > 0);
  const gw = w.reduce((a, t) => a + t.pnl, 0), gl = -closed.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  return { closed: closed.length, wins: w.length, winRate: closed.length ? w.length / closed.length : null, realized: r2(gw - gl), profitFactor: gl > 0 ? r2(gw / gl) : null,
    costs: r2(st.trades.reduce((a, t) => a + (t.cost || 0), 0)), borrow: r2(st.borrowPaid || 0), fills: st.trades.filter((t) => SIDES.includes(t.side)).length };
}
module.exports = { START, COST, MAX_QUOTE_AGE, BORROW_YR, SHORT_STOP, SIDES, fresh, usable, validate, place, work, cancel, value, mark, stats, borrow, buyingPower, shortReserve };

// Toughness test for bot rules: replays a bot's exact rules on past daily prices, then asks whether the result
// survives (1) the later 40% of the period on its own, (2) settings changed by ±20%, (3) doubled trading costs and
// (4) 1,000 reshuffles of its trades (bad-luck runs). Pure functions; the caller supplies price history.
// Honest limits, shown with every result: today's list of stocks is used for the whole period (survivorship bias),
// fills are next-day opening prices from daily bars, and a hypothetical replay is not a track record.
"use strict";
const X = require("./extra-bots-core.js");

const START = 30_000, COST = 0.00075, MIN_TRADES = 15;
const scale = (r, k, keys) => Object.fromEntries(Object.entries(r).map(([n, v]) => [n, keys.includes(n) ? (Array.isArray(v) ? v.map((x) => Math.round(x * k)) : n === "slots" ? Math.max(1, Math.round(v * k)) : +(v * k).toFixed(4)) : v]));
// the settings each bot's ±20% check moves
const KNOBS = { pullback: ["rsiMax", "stop", "maxSessions"], rotation: ["lookbacks"] };

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function drawdown(eq) { let hi = -Infinity, dd = 0; for (const v of eq) { hi = Math.max(hi, v); dd = Math.max(dd, 1 - v / hi); } return dd; }
function sharpe(eq) {
  const r = eq.slice(1).map((v, i) => v / eq[i] - 1); if (r.length < 20) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length, sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  return sd ? (m / sd) * Math.sqrt(252) : null;
}

// Replay one of the stock / sector bots day by day: decide after each close, fill at the next session's open.
function simulate(bot, barsBySymbol, { rules = X.RULES[bot], cost = COST, universe = [], warmup = 200 } = {}) {
  const cal = (barsBySymbol.SPY || []).map((b) => b.day), idx = {}, byDay = {};
  for (const [sym, bars] of Object.entries(barsBySymbol)) { byDay[sym] = new Map(bars.map((b, i) => [b.day, i])); idx[sym] = bars; }
  const upTo = (day) => { const o = {}; for (const [sym, bars] of Object.entries(idx)) { const i = byDay[sym].get(day); if (i != null) o[sym] = bars.slice(0, i + 1); } return o; };
  let cash = START; const pos = {}, trades = [], equity = [], days = [];
  let pending = [], month = null;
  for (let i = warmup; i < cal.length; i++) {
    const day = cal[i];
    // 1) fill yesterday's decisions at today's open (sells first)
    for (const o of pending.sort((a, b) => (a.side === b.side ? 0 : a.side === "SELL" ? -1 : 1))) {
      const bi = byDay[o.symbol] && byDay[o.symbol].get(day), bar = bi != null ? idx[o.symbol][bi] : null;
      if (!bar || !(bar.open > 0)) continue;
      if (o.side === "SELL" && pos[o.symbol]) {
        const p = pos[o.symbol], px = bar.open * (1 - cost), pnl = p.shares * (px - p.entry);
        cash += p.shares * px; trades.push({ symbol: o.symbol, ret: pnl / (p.shares * p.entry), pnl, weight: (p.shares * p.entry) / p.bookAtEntry, open: p.day, close: day }); delete pos[o.symbol];
      } else if (o.side === "BUY" && !pos[o.symbol]) {
        const value = cash + Object.entries(pos).reduce((a, [s, p]) => a + p.shares * p.mark, 0);
        const px = bar.open * (1 + cost), shares = Math.floor(Math.min(cash, value / o.slots) / px);
        if (shares > 0) { cash -= shares * px; pos[o.symbol] = { shares, entry: px, day, held: 0, mark: bar.open, bookAtEntry: value }; }
      }
    }
    pending = [];
    // 2) mark at the close, count sessions held
    for (const [s, p] of Object.entries(pos)) { const bi = byDay[s].get(day); if (bi != null) p.mark = idx[s][bi].close; if (p.day < day) p.held++; }
    const value = cash + Object.values(pos).reduce((a, p) => a + p.shares * p.mark, 0);
    equity.push(value); days.push(day);
    if (i === cal.length - 1) break;
    // 3) decide for tomorrow's open with only the bars known today
    const known = upTo(day);
    if (bot === "rotation") {
      if (day.slice(0, 7) !== month) {
        const r = X.rotationTargets(known, day, rules);
        if (r.complete) {
          month = day.slice(0, 7);
          for (const s of Object.keys(pos)) if (!r.targets.includes(s)) pending.push({ side: "SELL", symbol: s });
          for (const s of r.targets) if (!pos[s]) pending.push({ side: "BUY", symbol: s, slots: rules.slots });
        }
      }
      continue;
    }
    const leaving = new Set();
    for (const [s, p] of Object.entries(pos)) {
      const c = (known[s] || []).map((b) => b.close);
      if (c.length && X.exitFor(bot, p, c, p.held, rules)) { pending.push({ side: "SELL", symbol: s }); leaving.add(s); }
    }
    let open = Object.keys(pos).length - leaving.size;
    for (const idea of X.pullbackIdeas(known, day, universe, rules)) {
      if (open >= rules.slots) break;
      if (pos[idea.symbol]) continue;
      pending.push({ side: "BUY", symbol: idea.symbol, slots: rules.slots }); open++;
    }
  }
  return summarize(equity, days, trades);
}

function summarize(equity, days, trades) {
  const total = equity.length ? equity[equity.length - 1] / START - 1 : 0;
  const cut = Math.floor(equity.length * 0.6), later = equity.length > 40 ? equity[equity.length - 1] / equity[cut] - 1 : null;
  const wins = trades.filter((t) => t.pnl > 0).length;
  return { from: days[0] || null, to: days[days.length - 1] || null, sessions: equity.length, total, later, laterFrom: days[cut] || null,
    sharpe: sharpe(equity), maxDrawdown: drawdown(equity), trades: trades.length, winRate: trades.length ? wins / trades.length : null, tradeList: trades };
}

// Reshuffle the trades (sampled with replacement) 1,000 times: how bad could the same edge look with worse luck?
function monteCarlo(trades, { runs = 1000, seed = 7 } = {}) {
  if (trades.length < MIN_TRADES) return null;
  const r = rng(seed), finals = [], dds = [];
  for (let k = 0; k < runs; k++) {
    let eq = 1; const path = [1];
    for (let i = 0; i < trades.length; i++) { const t = trades[Math.floor(r() * trades.length)]; eq *= 1 + t.ret * Math.min(1, t.weight || 0.2); path.push(eq); }
    finals.push(eq - 1); dds.push(drawdown(path));
  }
  const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  return { runs, p05: q(finals, 0.05), median: q(finals, 0.5), dd95: q(dds, 0.95) };
}

// Run every check for one bot and turn it into pass / borderline / fail / too few trades.
function toughness(bot, barsBySymbol, opts = {}) {
  const base = simulate(bot, barsBySymbol, opts), rules = opts.rules || X.RULES[bot];
  const lo = simulate(bot, barsBySymbol, { ...opts, rules: scale(rules, 0.8, KNOBS[bot]) });
  const hi = simulate(bot, barsBySymbol, { ...opts, rules: scale(rules, 1.2, KNOBS[bot]) });
  const dbl = simulate(bot, barsBySymbol, { ...opts, cost: COST * 2 });
  return verdict(base, { lo, hi, dbl, mc: monteCarlo(base.tradeList) });
}

function verdict(base, { lo, hi, dbl, mc }) {
  const pct = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}%`);
  const checks = [
    { id: "profit", label: "Made money after costs", ok: base.total > 0, value: pct(base.total) },
    { id: "later", label: "Still made money in the last 40% of the period", ok: base.later != null && base.later > 0, value: pct(base.later) },
    { id: "settings", label: "Still made money with its settings 20% lower and 20% higher", ok: lo.total > 0 && hi.total > 0, value: `${pct(lo.total)} / ${pct(hi.total)}` },
    { id: "costs", label: "Still made money with trading costs doubled", ok: dbl.total > 0, value: pct(dbl.total) },
    { id: "luck", label: "Bad-luck reshuffles: 1 in 20 ends worse than −15%, and drawdowns stay under 30%", ok: !!mc && mc.p05 > -0.15 && mc.dd95 < 0.3, value: mc ? `${pct(mc.p05)} · drawdown ${pct(-mc.dd95)}` : "—" },
  ];
  const failed = checks.filter((c) => !c.ok).length;
  const status = base.trades < MIN_TRADES ? "few-trades" : !checks[0].ok || failed >= 2 ? "fail" : failed === 1 ? "borderline" : "pass";
  const { tradeList, ...summary } = base;
  return { status, label: { pass: "Passed", borderline: "Borderline", fail: "Failed", "few-trades": "Too few trades to judge" }[status], checks, summary, monteCarlo: mc,
    gate: status === "fail" ? "New buys paused automatically until a re-test passes (open positions still follow their exit rules)." : "Trading normally.",
    limits: "Replay on past daily prices with today's list of stocks (survivorship bias), next-day opening fills and modeled costs. Hypothetical, not a track record." };
}

// Bots whose inputs have no free history (news, analyst ratings, earnings surprises, insider filings) are judged on
// their live paper record instead: after 20 closed trades, a losing record with a low win rate pauses new buys.
function liveRecord(book, { minTrades = 20 } = {}) {
  const n = book ? book.closed || 0 : 0;
  if (n < minTrades) return { status: "live-wait", label: `Judged on live paper trades (${n} of ${minTrades} closed so far)`, gate: "Trading normally." };
  const wr = book.wins / n, bad = book.realizedPnl < 0 && wr < 0.4;
  return { status: bad ? "fail" : "pass", label: bad ? "Failed on its live paper record" : "Passing on its live paper record",
    detail: `${n} closed trades, ${Math.round(wr * 100)}% won, realized ${book.realizedPnl >= 0 ? "+" : "−"}$${Math.abs(book.realizedPnl).toFixed(0)}`,
    gate: bad ? "New buys paused automatically; open positions still follow their exit rules." : "Trading normally." };
}

// Quant trader replay: its own decide() every 21 sessions on the closes known that day, filled at the next close
// (the live bot rebalances daily at the open; Zweig put/call and the ratio score have no free history, so they're off).
function simulateQuant(decide, px, { cost = 0.0005, every = 21, warmup = 280, opts = {} } = {}) {
  const syms = Object.keys(px), n = px.SPY.length; let cash = START; const sh = {}, equity = [];
  const val = (i) => cash + syms.reduce((a, s) => a + (sh[s] || 0) * px[s][i], 0);
  for (let i = warmup; i < n; i++) {
    if ((i - warmup) % every === 0 && i + 1 < n) {
      const slice = Object.fromEntries(syms.map((s) => [s, px[s].slice(0, i + 1)]));
      let w; try { w = decide(slice, opts).w; } catch { w = null; }
      if (w) {
        const v = val(i + 1);
        for (const s of syms) {
          const want = (w[s] || 0) * v / px[s][i + 1], d = want - (sh[s] || 0);
          if (Math.abs(d * px[s][i + 1]) < 1) continue;
          cash -= d * px[s][i + 1] + Math.abs(d * px[s][i + 1]) * cost; sh[s] = want;
        }
      }
    }
    equity.push(val(i));
  }
  // per-rebalance returns stand in for trades in the reshuffle test
  const per = []; for (let k = every; k < equity.length; k += every) per.push({ ret: equity[k] / equity[k - every] - 1, pnl: equity[k] - equity[k - every], weight: 1 });
  return { ...summarize(equity, equity.map((_, k) => String(k)), per), unit: "monthly rebalances" };
}
function quantToughness(decide, px, dates, opts = {}) {
  const base = simulateQuant(decide, px, opts);
  const lo = simulateQuant(decide, px, { ...opts, opts: { volTarget: 0.12, top: 6 } });
  const hi = simulateQuant(decide, px, { ...opts, opts: { volTarget: 0.18, top: 10 } });
  const dbl = simulateQuant(decide, px, { ...opts, cost: 0.001 });
  const v = verdict(base, { lo, hi, dbl, mc: monteCarlo(base.tradeList) });
  const first = Math.min(dates.length - 1, opts.warmup ?? 280);
  v.summary.from = dates[first] || null; v.summary.to = dates[dates.length - 1] || null;
  v.summary.laterFrom = dates[first + Math.floor(v.summary.sessions * 0.6)] || null;
  v.checks[2].label = "Still made money with its volatility target and number of picks 20% lower and higher";
  v.checks[4].label = "Bad-luck reshuffles of its monthly results: 1 in 20 ends worse than −15%, drawdowns under 30%";
  v.limits = "Monthly replay of its own rules on past closes (today's list of ETFs and mega-caps), filled at the next close with modeled costs; the put/call tilt and ratio score are off because they have no free history. Hypothetical, not a track record.";
  v.gate = "Shown for information: the Quant trader is a main bot and keeps trading.";
  return v;
}

const paused = (result) => !!result && result.status === "fail";

module.exports = { START, COST, MIN_TRADES, KNOBS, simulate, simulateQuant, quantToughness, monteCarlo, toughness, verdict, liveRecord, paused, scale };

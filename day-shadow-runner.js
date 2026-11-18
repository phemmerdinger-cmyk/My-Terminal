// Independent paper-only research books. No broker or Day Trader account mutations.
"use strict";

const DTC = require("./daytrade-core.js"), SIGNAL = require("./day-shadow-core.js");

const START = 30_000, RISK_PER_TRADE = 60, OPEN_RISK = 120, MAX_LAG_SEC = 90, LOG_LIMIT = 250;
const COST = 0.0005, SHORT_COST = 0.0001;
const COST_MODEL = Object.freeze({ sideBps: COST * 1e4, shortEntryBps: SHORT_COST * 1e4, calibrated: false });

function freshBook() {
  return { cash: START, value: START, peak: START, maxDrawdown: 0, gross: 0, openRisk: 0,
    signals: 0, queued: 0, filled: 0, closed: 0, expired: 0, blocked: 0, costs: 0, netPnl: 0,
    positions: {}, pending: {}, seen: {}, trades: [] };
}

function refresh(book) {
  book.value = book.cash;
  book.gross = 0;
  book.openRisk = 0;
  for (const p of Object.values(book.positions)) {
    const marked = p.shares * p.mark;
    book.value += (p.dir === "long" ? 1 : -1) * marked;
    book.gross += marked;
    book.openRisk += p.plannedRisk;
  }
  book.peak = Math.max(book.peak, book.value);
  book.maxDrawdown = Math.max(book.maxDrawdown, 1 - book.value / book.peak);
}

function entryCost(price, dir) { return price * (COST + (dir === "short" ? SHORT_COST : 0)); }

function opportunity(dir, entry, target) {
  return Math.abs(target - entry) > entryCost(entry, dir) + target * COST;
}

function tryOpen(book, sym, order, bar) {
  if (book.positions[sym] || bar.d !== order.day || bar.t !== order.fillAt || bar.t * 1000 <= order.decisionAt) return false;
  const bracket = SIGNAL.bracketAtFill(order.signal, bar.o);
  const { dir } = order.signal, px = bar.o;
  if (!bracket || !opportunity(dir, px, bracket.target)) return false;
  const fee = entryCost(px, dir), eachRisk = Math.abs(px - bracket.stop) + fee + bracket.stop * COST;
  const allowedRisk = Math.min(RISK_PER_TRADE, OPEN_RISK - book.openRisk);
  const allowedGross = book.value - book.gross;
  const shares = Math.floor(Math.min(allowedRisk / eachRisk, allowedGross / (px + fee)));
  if (!(shares >= 1)) return false;
  const cost = shares * fee;
  book.positions[sym] = { ...bracket, dir, setup: order.signal.setup, signalAt: order.signal.closeAt, decisionAt: order.decisionAt,
    entry: px, mark: px, at: bar.t * 1000, hold: order.signal.hold, shares, bars: 0, cost, plannedRisk: eachRisk * shares };
  book.cash += (dir === "long" ? -1 : 1) * shares * px - cost;
  book.costs += cost;
  book.filled++;
  refresh(book);
  return true;
}

function closePosition(book, sym, p, exit) {
  const fee = p.shares * exit.px * COST, grossPnl = DTC.pnlOf(p, exit.px), costs = p.cost + fee;
  const pnl = grossPnl - costs;
  book.cash += (p.dir === "long" ? 1 : -1) * p.shares * exit.px - fee;
  book.costs += fee;
  book.netPnl += pnl;
  book.closed++;
  delete book.positions[sym];
  book.trades.unshift({ sym, setup: p.setup, dir: p.dir, shares: p.shares, signalAt: p.signalAt, decisionAt: p.decisionAt,
    openedAt: p.at, closedAt: exit.t * 1000, entry: p.entry, exit: exit.px, stop: p.stop, target: p.target,
    grossPnl, pnl, costs, plannedRisk: p.plannedRisk, why: exit.why });
  if (book.trades.length > LOG_LIMIT) book.trades.length = LOG_LIMIT;
}

const nextPositionBar = (p) => p ? (p.lastProcessedBar == null ? p.at / 1000 : p.lastProcessedBar + 60) : Infinity;
const orderExpired = (order, now) => now > (order.fillAt + 60 + MAX_LAG_SEC) * 1000;

function settleBook(book, snapshots, day, now) {
  const events = new Map();
  for (const [sym, order] of Object.entries(book.pending)) {
    const data = snapshots.get(sym);
    if (order.day !== day || (!data && orderExpired(order, now))) {
      delete book.pending[sym];
      book.expired++;
    }
  }
  for (const [sym, { bars, observedAt }] of snapshots) {
    const order = book.pending[sym], start = Math.min(nextPositionBar(book.positions[sym]), order?.fillAt ?? Infinity);
    if (!Number.isFinite(start)) continue;
    const fresh = bars.filter((bar) => bar.t >= start && DTC.paperBarReady(bar, observedAt, MAX_LAG_SEC));
    if (order && !fresh.some((bar) => bar.t === order.fillAt) &&
        (bars.at(-1)?.t > order.fillAt || orderExpired(order, now))) {
      delete book.pending[sym];
      book.expired++;
    }
    for (const bar of fresh) {
      if (!events.has(bar.t)) events.set(bar.t, []);
      events.get(bar.t).push([sym, bar]);
    }
  }
  for (const [, minute] of [...events].sort((a, b) => a[0] - b[0])) {
    // All orders are sized against the same observable minute open before bracket outcomes are known.
    for (const [sym, bar] of minute) {
      const p = book.positions[sym];
      if (p && bar.t >= nextPositionBar(p)) p.mark = bar.o;
    }
    refresh(book);
    for (const [sym, bar] of minute) {
      const order = book.pending[sym];
      if (order?.fillAt !== bar.t) continue;
      delete book.pending[sym];
      if (!tryOpen(book, sym, order, bar)) book.blocked++;
    }
    for (const [sym, bar] of minute) {
      const p = book.positions[sym];
      if (!p || bar.t < nextPositionBar(p)) continue;
      const exit = DTC.managePaperPosition(p, bar, p.hold);
      if (exit) closePosition(book, sym, p, exit);
      else if (p.lastProcessedBar === bar.t) p.mark = bar.c;
    }
    refresh(book);
  }
}

function queueSignals(book, sym, signals, bars, day, close, now) {
  for (const signal of signals) {
    if (signal.t <= (book.seen[sym] ?? -Infinity)) continue;
    book.seen[sym] = signal.t;
    book.signals++;
    const lastMinute = bars.find((bar) => (bar.t + 60) * 1000 === signal.closeAt);
    const fillAt = lastMinute && DTC.paperEntryMinute(lastMinute, now, close, MAX_LAG_SEC, signal.hold);
    if (fillAt == null || book.positions[sym] || book.pending[sym] || !opportunity(signal.dir, signal.reference, signal.target)) {
      book.blocked++;
      continue;
    }
    book.pending[sym] = { day, fillAt, decisionAt: now, signal };
    book.queued++;
  }
}

function advanceDayShadows(state, { series, day, close = DTC.CLOSE, now, warmup = {}, prior = {} }) {
  if (!day || !Number.isFinite(now)) throw new TypeError("A session date and decision clock are required");
  if (state?.v !== 1 || !state.books?.base || !state.books?.fvg) {
    state = { v: 1, since: now, day, books: { base: freshBook(), fvg: freshBook() } };
  }
  if (state.day !== day) {
    state.day = day;
    for (const book of Object.values(state.books)) book.seen = {};
  }
  const snapshots = new Map();
  for (const [sym, source, observedAt] of series) {
    if (!Number.isFinite(observedAt) || observedAt > now) continue;
    const bars = source.filter((bar) => bar && bar.d === day && bar.m >= DTC.OPEN && bar.m < close &&
      DTC.validMinuteBar(bar) && (bar.t + 60) * 1000 <= observedAt);
    const distinct = [...new Map(bars.map((bar) => [bar.t, bar])).values()].sort((a, b) => a.t - b.t);
    snapshots.set(sym, { bars: distinct, observedAt });
  }
  for (const book of Object.values(state.books)) settleBook(book, snapshots, day, now);

  const diagnostics = { checked: snapshots.size, ready: 0 };
  for (const [sym, { bars, observedAt }] of snapshots) {
    const latest = bars.at(-1);
    if (!latest || !DTC.paperBarReady(latest, now, MAX_LAG_SEC)) continue;
    const result = SIGNAL.evaluate(bars, { day, asOf: observedAt, closeMinute: close, warmup: warmup[sym], prior: prior[sym], includeFvg: true });
    if (result.diagnostics.latest?.adx != null && result.diagnostics.vwapComplete) diagnostics.ready++;
    queueSignals(state.books.base, sym, result.signals, bars, day, close, now);
    queueSignals(state.books.fvg, sym, result.variants, bars, day, close, now);
  }
  state.updated = now;
  state.diagnostics = diagnostics;
  state.costModel = { ...COST_MODEL };
  return state;
}

module.exports = { advanceDayShadows };

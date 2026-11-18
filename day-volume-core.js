"use strict";

const DTC = require("./daytrade-core.js");

const VOLUME_POLICY = Object.freeze({
  target: 1_000, capital: 30_000, maxNotional: 200, grossLimit: 10_000,
  maxOpen: 50, hold: 10, costPerSide: 0.0005, shortBorrow: 0.0001,
});

const P = VOLUME_POLICY;
const emptySession = (day, close) => ({
  day, target: close === DTC.CLOSE ? P.target : null, queued: 0, opened: 0, closed: 0, expired: 0, recovered: 0,
  costQualified: 0, grossPnl: 0, netPnl: 0, costs: 0,
});
const initial = (day, close) => ({
  day: emptySession(day, close), cash: P.capital, positions: {}, pending: {}, lastSignals: {}, sessions: [], trades: [],
});
const sign = (order) => order.dir === "long" ? 1 : -1;
const markOf = (position) => position.mark ?? position.entry;
const gross = (positions) => Object.values(positions).reduce((sum, p) => sum + p.shares * markOf(p), 0);
const marketValue = (positions) => Object.values(positions).reduce((sum, p) => sum + sign(p) * p.shares * markOf(p), 0);

function reducePosition(book, symbol, bar) {
  const position = book.positions[symbol];
  const exit = DTC.managePaperPosition(position, bar, P.hold);
  if (!exit) {
    if (position.lastProcessedBar === bar.t) position.mark = bar.c;
    return;
  }
  const fee = position.shares * exit.px * P.costPerSide;
  const grossPnl = DTC.pnlOf(position, exit.px);
  const netPnl = grossPnl - fee - position.entryCost;
  const session = position.day === book.day.day ? book.day : book.sessions.find((record) => record.day === position.day);
  book.cash += sign(position) * exit.px * position.shares - fee;
  if (session) {
    session.grossPnl += grossPnl;
    session.netPnl += netPnl;
    session.costs += fee;
    if (bar.d === position.day) {
      session.closed++;
      if (position.qualified) session.costQualified++;
    } else session.recovered++;
  }
  book.trades.push({ id: position.id, symbol, direction: position.dir, decisionAt: position.decisionAt, entryAt: position.at,
    closeAt: exit.t * 1000, entry: position.entry, exit: exit.px, shares: position.shares, grossPnl, netPnl,
    cost: position.entryCost + fee, qualifiedAtEntry: position.qualified, reason: exit.why });
  delete book.positions[symbol];
}

function openPosition(book, symbol, order, bar) {
  const fill = DTC.paperOpen(order, bar);
  const costRate = P.costPerSide + (order.idea.dir === "short" ? P.shortBorrow : 0);
  const invested = gross(book.positions);
  const capitalRoom = (book.cash + marketValue(book.positions) - invested) / (1 + costRate);
  const notional = Math.min(P.maxNotional, P.grossLimit - invested, capitalRoom);
  delete book.pending[symbol];
  if (!fill || !(notional > 0)) {
    book.day.expired++;
    return;
  }
  const shares = notional / fill.entry;
  const cost = notional * costRate;
  book.cash -= sign(order.idea) * notional + cost;
  book.day.opened++;
  book.day.costs += cost;
  book.positions[symbol] = { ...fill, id: `${symbol}:${order.fillAt}`, dir: order.idea.dir, shares, day: order.day,
    decisionAt: order.decisionAt, qualified: order.qualified, entryCost: cost };
}

function settle(book, series, day, close, maxLagSec, now) {
  const events = [];
  for (const [symbol, history, observedAt] of series) {
    const position = book.positions[symbol], order = book.pending[symbol];
    if ((!position && !order) || !Number.isFinite(observedAt) || observedAt > now) continue;
    const earliest = position ? (position.lastProcessedBar ?? (position.at / 1_000 - 60)) + 60 : order.fillAt;
    for (const bar of history) {
      if (bar.t >= earliest && bar.d === day && DTC.validMinuteBar(bar) && bar.m >= DTC.OPEN &&
          bar.m < close && DTC.paperBarReady(bar, observedAt, maxLagSec)) events.push({ symbol, bar });
    }
  }
  events.sort((a, b) => a.bar.t - b.bar.t);
  for (const { symbol, bar } of events) {
    const order = book.pending[symbol];
    if (order?.fillAt === bar.t) openPosition(book, symbol, order, bar);
    if (book.positions[symbol]) reducePosition(book, symbol, bar);
  }
  for (const [symbol, order] of Object.entries(book.pending)) {
    if (now > (order.fillAt + 60 + maxLagSec) * 1_000) {
      delete book.pending[symbol];
      book.day.expired++;
    }
  }
}

function queue(book, candidates, day, close, maxLagSec, now) {
  let slots = Math.min(P.maxOpen - Object.keys(book.positions).length, P.target - book.day.opened)
    - Object.keys(book.pending).length;
  if (slots <= 0 || book.cash + marketValue(book.positions) <= gross(book.positions)) return;
  const ranked = candidates.filter(({ last, forecast }) => last?.d === day && Number.isFinite(forecast?.mu) &&
    Number.isFinite(forecast.moveBps) && Number.isFinite(forecast.hurdleBps) && Number.isFinite(forecast.a) &&
    forecast.a > 0 && forecast.mu !== 0 && Math.sign(forecast.mu) === forecast.side)
    .sort((a, b) => (b.forecast.moveBps - b.forecast.hurdleBps) - (a.forecast.moveBps - a.forecast.hurdleBps)
      || a.sym.localeCompare(b.sym));
  for (const { sym, last, forecast } of ranked) {
    if (slots <= 0) break;
    if (book.positions[sym] || book.pending[sym] || last.t <= (book.lastSignals[sym] ?? -Infinity)) continue;
    const fillAt = DTC.paperEntryMinute(last, now, close, maxLagSec, P.hold);
    if (fillAt == null) continue;
    book.pending[sym] = { day, fillAt, decisionAt: now, qualified: forecast.qualified === true,
      idea: { dir: forecast.side === 1 ? "long" : "short", stopDistance: Math.max(forecast.a, last.c * 0.0005),
        targetDistance: Math.max(forecast.a * 1.2, last.c * 0.0006) } };
    book.lastSignals[sym] = last.t;
    book.day.queued++;
    slots--;
  }
}

// The caller supplies only candles actually sealed as of this observation. Replay callers
// must move "now" forward for each read rather than feeding today's end-of-session bar set.
function advanceVolumeTrials(state, { series = [], candidates = [], day, close, now, maxLagSec = 90 }) {
  if (!day || !Number.isFinite(now) || state?.day.day > day || (state?.observedAt ?? -Infinity) >= now) return state;
  const book = state ? structuredClone(state) : initial(day, close);
  if (book.day.day !== day) {
    book.day.expired += Object.keys(book.pending).length;
    book.sessions = [...book.sessions, book.day].slice(-90);
    book.day = emptySession(day, close);
    book.pending = {};
    book.lastSignals = {};
  }
  settle(book, series, day, close, maxLagSec, now);
  queue(book, candidates, day, close, maxLagSec, now);
  book.trades = book.trades.slice(-160);
  book.observedAt = now;
  return book;
}

function volumeSymbols(state) {
  return state ? [...Object.keys(state.positions), ...Object.keys(state.pending)] : [];
}

function volumeSummary(state) {
  const open = state ? Object.keys(state.positions).length : 0;
  const pending = state ? Object.keys(state.pending).length : 0;
  const equity = state ? state.cash + marketValue(state.positions) : P.capital;
  const session = state?.day ?? emptySession(null, DTC.CLOSE);
  return { policy: P, ...session, open, pending, pnl: session.netPnl, equity, grossExposure: state ? gross(state.positions) : 0,
    asOf: state?.observedAt ?? null, recent: state?.trades.slice(-10).reverse() ?? [], recentSessions: state?.sessions.slice(-10).reverse() ?? [],
    status: !state ? "Waiting for a market scan" : session.target == null ? "Short session · no volume target"
      : session.closed >= session.target ? "Session target reached" : "Counting completed paper trials" };
}

module.exports = { VOLUME_POLICY, advanceVolumeTrials, volumeSymbols, volumeSummary };

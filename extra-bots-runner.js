// Books for the four extra Strategy Lab bots (rules in extra-bots-core.js). Decisions are made after the close on
// finalized daily bars and filled only at the verified 9:30 ET opening price of the next session, with modeled costs.
// Paper money. A buy whose opening price can't be verified is dropped; a sell is retried at the next open.
"use strict";
const X = require("./extra-bots-core.js");
const PAPER = require("./paper-execution-core.js");

const START = 30_000, COST_RATE = 0.00075, OPEN_MINUTE = 570, GRACE_MIN = 5;
const BOTS = ["pullback", "rotation", "earnings", "insider"];
const positive = (v) => Number.isFinite(v) && v > 0;

const freshBook = () => ({ cash: START, value: START, costs: 0, positions: {}, pending: [], trades: [], closed: 0, wins: 0, realizedPnl: 0, skipped: 0, rejections: [] });
const freshExtraBots = (now = Date.now()) => ({ since: now, lastPreparedDay: null, rotationMonth: null, lastNotes: null, books: Object.fromEntries(BOTS.map((b) => [b, freshBook()])) });

function mark(book) { book.value = book.cash + Object.values(book.positions).reduce((v, p) => v + p.shares * p.mark, 0); }
function addTrade(book, t) { book.costs += t.cost; book.trades.unshift(t); book.trades.length = Math.min(book.trades.length, 300); }
function reject(book, o, day, reason) { book.skipped++; book.rejections.unshift({ symbol: o.symbol, side: o.side, day, reason }); book.rejections.length = Math.min(book.rejections.length, 20); }

// Symbols the runner needs finalized daily bars for (held, pending, plus today's event candidates)
function neededSymbols(state) {
  if (!state) return [];
  return [...new Set(Object.values(state.books).flatMap((b) => [...Object.keys(b.positions), ...b.pending.map((o) => o.symbol)]))];
}

/** After the close: mark books, decide exits and entries for the next session's open. */
function prepareExtraBots(state, { barsBySymbol, signalDay, asOf, nextSession, sessions, universe, earningsEvents, insiderEvents, paused = {} }) {
  if (!positive(asOf) || !signalDay || (state && state.lastPreparedDay > signalDay)) return state;
  const next = state ? structuredClone(state) : freshExtraBots(asOf);
  for (const b of BOTS) next.books[b] = next.books[b] || freshBook();
  const held = (pos) => sessions.filter((d) => d > pos.openedDay && d <= signalDay).length;
  for (const [bot, book] of Object.entries(next.books)) {
    // carry unfilled sells to the next open; unfilled buys expire
    book.pending = book.pending.filter((o) => {
      if (o.openDay > signalDay) return true;
      if (o.side === "SELL" && book.positions[o.symbol]) { o.openDay = nextSession; return true; }
      reject(book, o, signalDay, "Verified opening price unavailable");
      return false;
    });
    for (const [sym, p] of Object.entries(book.positions)) {
      const bar = (barsBySymbol[sym] || []).find((x) => x.day === signalDay);
      if (bar && positive(bar.close)) p.mark = bar.close;
    }
    mark(book);
  }
  if (next.lastPreparedDay === signalDay || !nextSession) return next;
  next.lastPreparedDay = signalDay;
  const signalAt = asOf;
  const queue = (book, side, symbol, reason, extra = {}) => {
    if (book.pending.some((o) => o.symbol === symbol && o.side === side)) return;
    book.pending.push({ side, symbol, openDay: nextSession, signalDay, signalAt, reason, ...extra });
  };
  // ---- exits for the stock bots
  for (const bot of ["pullback", "earnings", "insider"]) {
    const book = next.books[bot];
    for (const [sym, p] of Object.entries(book.positions)) {
      const bars = barsBySymbol[sym]; if (!bars || !bars.length || bars[bars.length - 1].day !== signalDay) continue;
      const why = X.exitFor(bot, p, bars.filter((x) => x.day <= signalDay).map((x) => x.close), held(p));
      if (why) queue(book, "SELL", sym, why);
    }
  }
  // ---- entries
  const ideas = {
    pullback: X.pullbackIdeas(barsBySymbol, signalDay, universe || []),
    earnings: X.earningsIdeas(earningsEvents, barsBySymbol, signalDay, sessions),
    insider: X.insiderIdeas(insiderEvents, barsBySymbol, signalDay, asOf),
  };
  const noteOf = {};
  for (const bot of ["pullback", "earnings", "insider"]) {
    const book = next.books[bot], slots = X.RULES[bot].slots;
    if (paused[bot]) { noteOf[bot] = `${ideas[bot].length} candidate${ideas[bot].length === 1 ? "" : "s"} · new buys paused by the toughness test`; continue; }
    const leaving = new Set(book.pending.filter((o) => o.side === "SELL").map((o) => o.symbol));
    let open = Object.keys(book.positions).filter((s) => !leaving.has(s)).length + book.pending.filter((o) => o.side === "BUY").length;
    for (const idea of ideas[bot]) {
      if (open >= slots) break;
      if (book.positions[idea.symbol] || leaving.has(idea.symbol)) continue;
      queue(book, "BUY", idea.symbol, idea.reason, { slots }); open++;
    }
    noteOf[bot] = `${ideas[bot].length} candidate${ideas[bot].length === 1 ? "" : "s"} on ${signalDay}`;
  }
  // ---- monthly sector rotation (first completed session of each month)
  const month = signalDay.slice(0, 7), rot = next.books.rotation;
  if (next.rotationMonth !== month) {
    const r = X.rotationTargets(barsBySymbol, signalDay);
    if (r.complete) {
      next.rotationMonth = month;
      for (const sym of Object.keys(rot.positions)) if (!r.targets.includes(sym)) queue(rot, "SELL", sym, `Monthly rotation: no longer a top-3 sector above its 200-day average`);
      if (!paused.rotation) for (const sym of r.targets) if (!rot.positions[sym]) queue(rot, "BUY", sym, `Monthly rotation: top-3 sector by 3- and 6-month return, above its 200-day average`, { slots: X.RULES.rotation.slots });
      noteOf.rotation = `Targets for ${month}: ${r.targets.join(", ") || "none above their 200-day (cash)"}${paused.rotation ? " · new buys paused by the toughness test" : ""}`;
    } else noteOf.rotation = "Waiting for all 11 sector funds' final closes";
  }
  next.lastNotes = { day: signalDay, ...noteOf };
  return next;
}

/** At 9:30 ET: fill today's orders at the verified opening print (sells first, then equal-slot buys). */
function openExtraBots(state, { day, openingBars = {}, now, minute }) {
  if (!state || !positive(now) || minute < OPEN_MINUTE) return state;
  if (!Object.values(state.books).some((b) => b.pending.some((o) => o.openDay === day))) return state;
  const next = structuredClone(state), late = minute >= OPEN_MINUTE + GRACE_MIN;
  for (const book of Object.values(next.books)) {
    const today = book.pending.filter((o) => o.openDay === day).sort((a, b) => (a.side === b.side ? 0 : a.side === "SELL" ? -1 : 1));
    for (const o of today) {
      const bar = openingBars[o.symbol], px = bar && positive(bar.o) ? bar.o : null;
      if (!px) { if (late && o.side === "BUY") { reject(book, o, day, "Verified opening price unavailable during entry window"); book.pending = book.pending.filter((x) => x !== o); } continue; }
      book.pending = book.pending.filter((x) => x !== o);
      if (o.side === "SELL") {
        const p = book.positions[o.symbol]; if (!p) continue;
        const fill = PAPER.paperFill("SELL", px, COST_RATE), pnl = p.shares * (fill - p.entry);
        book.cash += p.shares * fill; book.closed++; book.wins += pnl > 0 ? 1 : 0; book.realizedPnl += pnl;
        delete book.positions[o.symbol];
        addTrade(book, { symbol: o.symbol, side: "SELL", day, observedAt: now, shares: p.shares, price: fill, referencePrice: px, pnl, cost: p.shares * (px - fill), reason: o.reason });
      } else {
        if (book.positions[o.symbol]) continue;
        mark(book);
        const fill = PAPER.paperFill("BUY", px, COST_RATE), slot = Math.min(book.cash, book.value / (o.slots || 5));
        const shares = Math.floor(slot / fill);
        if (!(shares > 0)) { reject(book, o, day, "Not enough cash for a whole share"); continue; }
        book.cash -= shares * fill;
        book.positions[o.symbol] = { shares, entry: fill, openedDay: day, mark: px, reason: o.reason };
        addTrade(book, { symbol: o.symbol, side: "BUY", day, observedAt: now, shares, price: fill, referencePrice: px, cost: shares * (fill - px), reason: o.reason });
      }
    }
    mark(book);
  }
  return next;
}

function openingSymbols(state, day) {
  return state ? [...new Set(Object.values(state.books).flatMap((b) => b.pending.filter((o) => o.openDay === day).map((o) => o.symbol)))] : [];
}

module.exports = { BOTS, START, COST_RATE, freshExtraBots, prepareExtraBots, openExtraBots, openingSymbols, neededSymbols };

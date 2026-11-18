// Separate forward-paper accounts for the technical setup and the earnings ablation.
const SW = require("./swing-shadow-core");
const PAPER = require("./paper-execution-core");

const START = 30_000, TRADE_RISK = 90, OPEN_RISK = 180, COST_RATE = 0.00075;
const OPEN_MINUTE = 570, OPEN_GRACE_MS = 5 * 60_000;
const clock = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const positive = (value) => Number.isFinite(value) && value > 0;

function marketClock(time) {
  const fields = Object.fromEntries(clock.formatToParts(time).map(({ type, value }) => [type, value]));
  return { day: `${fields.year}-${fields.month}-${fields.day}`, minute: Number(fields.hour) * 60 + Number(fields.minute) };
}

const freshBook = () => ({ cash: START, value: START, costs: 0, positions: {}, pending: [], trades: [],
  closed: 0, wins: 0, realizedPnl: 0, skipped: 0, rejections: [] });

function freshSwingShadows(now = Date.now()) {
  return { since: now, lastPreparedDay: null, screen: null, books: { technical: freshBook(), canSlim: freshBook() } };
}

function mark(book) {
  book.value = book.cash + Object.values(book.positions).reduce((value, position) => value + position.shares * position.mark, 0);
}

function addTrade(book, trade) {
  book.costs += trade.cost;
  book.trades.unshift(trade);
  book.trades.length = Math.min(book.trades.length, 500);
}

function reject(book, idea, day, reason) {
  book.skipped++;
  book.rejections.unshift({ symbol: idea.symbol, day, reason });
  book.rejections.length = Math.min(book.rejections.length, 20);
}

function recentBars(rows, position, signalDay) {
  const bars = new Map();
  for (const bar of Array.isArray(rows) ? rows : []) {
    if (!bar || bar.day > signalDay || bar.day < position.openedDay || bar.day <= (position.lastDay || "")) continue;
    const previous = bars.get(bar.day);
    if (previous === undefined) bars.set(bar.day, bar);
    else if (previous && ["open", "high", "low", "close"].some((key) => previous[key] !== bar[key])) bars.set(bar.day, null);
  }
  return [...bars.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([, bar]) => bar);
}

function settleBook(book, barsBySymbol, signalDay, asOf) {
  for (const [symbol, original] of Object.entries(book.positions)) {
    let position = original;
    for (const bar of recentBars(barsBySymbol?.[symbol], position, signalDay)) {
      const { position: next, exit } = SW.advancePosition(position, bar);
      if (exit) {
        const price = PAPER.paperFill("SELL", exit.referencePrice, COST_RATE);
        const pnl = position.shares * (price - position.entry);
        book.cash += position.shares * price;
        book.closed++;
        book.wins += Number(pnl > 0);
        book.realizedPnl += pnl;
        delete book.positions[symbol];
        addTrade(book, { symbol, side: "SELL", day: bar.day, observedAt: asOf, shares: position.shares, price,
          referencePrice: exit.referencePrice, pnl, cost: position.shares * (exit.referencePrice - price), reason: exit.reason });
        break;
      }
      if (next === position) break;
      position = { ...next, mark: bar.close };
      book.positions[symbol] = position;
    }
  }
  mark(book);
}

/** Settle completed OHLC bars once and freeze fresh opening orders for the next exchange session.
 * The supplied regime may suppress entries by setting riskOff: true; exits remain enabled.
 * Books are never backfilled with orders that were not prepared before their scheduled opening. */
function prepareSwingShadows(state, { barsBySymbol, signalDay, asOf, nextSession, fundamentalsBySymbol, regime }) {
  if (!positive(asOf) || !signalDay || state?.lastPreparedDay > signalDay) return state;
  const next = state ? structuredClone(state) : freshSwingShadows(asOf);
  for (const book of Object.values(next.books)) {
    settleBook(book, barsBySymbol, signalDay, asOf);
    book.pending = book.pending.filter((idea) => {
      if (idea.openDay > signalDay) return true;
      reject(book, idea, signalDay, "Scheduled opening session has passed");
      return false;
    });
  }
  if (next.lastPreparedDay === signalDay) return next;
  const screen = SW.screen({ barsBySymbol, signalDay, asOf, nextSession, fundamentalsBySymbol });
  next.screen = { ...screen, asOf, regime: regime ?? null };
  if (!screen.openDay || !screen.counts.ranked) return next;
  next.lastPreparedDay = signalDay;
  if (regime?.riskOff === true) return next;
  for (const [name, book] of Object.entries(next.books)) {
    book.pending = screen.candidates.filter((idea) => !book.positions[idea.symbol] && (name === "technical" || idea.canSlim === true));
  }
  return next;
}

function openRisk(book) {
  return Object.values(book.positions).reduce((risk, position) =>
    risk + position.shares * Math.max(0, position.entry - PAPER.paperFill("SELL", position.stop, COST_RATE)), 0);
}

function openPosition(book, idea, referencePrice, openingAt, now) {
  const price = PAPER.paperFill("BUY", referencePrice, COST_RATE);
  const perShareRisk = price - PAPER.paperFill("SELL", idea.stop, COST_RATE);
  const budget = Math.min(TRADE_RISK, OPEN_RISK - openRisk(book));
  // Whole shares enforce the risk budget and keep the account unlevered.
  const shares = positive(perShareRisk) && positive(budget) ? Math.floor(Math.min(book.cash / price, budget / perShareRisk)) : 0;
  if (!shares) {
    reject(book, idea, idea.openDay, "Cash or open-risk budget exhausted");
    return;
  }
  const position = { shares, entry: price, initialStop: idea.stop, stop: idea.stop, atr: idea.atr,
    highestClose: price, openedDay: idea.openDay, lastDay: null, mark: referencePrice };
  book.cash -= shares * price;
  book.positions[idea.symbol] = position;
  addTrade(book, { symbol: idea.symbol, side: "BUY", day: idea.openDay, signalAt: idea.signalAt, openingAt, observedAt: now,
    shares, price, referencePrice, cost: shares * (price - referencePrice), reason: "Opening price confirmed breakout" });
}

/** Accept only the original 9:30 ET minute's observed open within five minutes of that opening.
 * openingBars is { SYM: { o: price, t: exchange epoch seconds or ms, m: minute of day, d: session } }.
 * This is a simulated reference fill with adverse costs, not proof of a broker execution. */
function openSwingShadows(state, { day, openingBars = {}, now }) {
  if (!state || !positive(now)) return state;
  const current = marketClock(now);
  if (current.day !== day || current.minute < OPEN_MINUTE) return state;
  if (!Object.values(state.books).some((book) => book.pending.some((idea) => idea.openDay <= day))) return state;
  const next = structuredClone(state);
  for (const book of Object.values(next.books)) {
    book.pending = book.pending.filter((idea) => {
      if (idea.openDay > day) return true;
      if (idea.openDay < day || current.minute >= OPEN_MINUTE + OPEN_GRACE_MS / 60_000) {
        reject(book, idea, day, "Verified opening print unavailable during entry window");
        return false;
      }
      const bar = openingBars?.[idea.symbol];
      if (!bar || bar.d !== day || bar.m !== OPEN_MINUTE || !positive(bar.o) || !positive(bar.t)) return true;
      const opened = bar.t < 1e12 ? bar.t * 1000 : bar.t;
      if (opened > now || now - opened >= OPEN_GRACE_MS) return true;
      const print = marketClock(opened);
      if (print.day !== day || print.minute !== OPEN_MINUTE) return true;
      if (!(idea.signalAt < opened) || book.positions[idea.symbol]) {
        reject(book, idea, day, "No eligible pre-opening decision");
        return false;
      }
      const check = SW.entryAtOpen(idea, { day, open: bar.o });
      if (check.ok) openPosition(book, idea, check.referencePrice, opened, now);
      else if (check.status === "reject") reject(book, idea, day, check.reason);
      return !check.ok && check.status === "wait";
    });
    mark(book);
  }
  return next;
}

module.exports = { freshSwingShadows, prepareSwingShadows, openSwingShadows, START, TRADE_RISK, OPEN_RISK, COST_RATE };

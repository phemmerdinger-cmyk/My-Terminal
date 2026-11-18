"use strict";
const C = require("./desk-risk-core.js");
const MARK_AGE = 3 * 60_000;
const REFRESH = 45_000;

function createDeskRisk({ store, loadBooks, books, quotes, closes, clock, sessionOf, previousDay, now = Date.now }) {
  let state = null, loading, updating, snapshot = null, block = null;
  const betaCache = new Map(), reservations = new Set();

  async function load() {
    if (!loading) loading = (async () => {
      state = await store.get("state");
    })().catch((error) => { loading = null; throw error; });
    return loading;
  }

  async function primeBeta(symbols, day) {
    const inputs = [...new Set(symbols)];
    if (!inputs.length) return;
    const benchmark = await closes("SPY", day);
    for (let i = 0; i < inputs.length; i += 5) {
      await Promise.all(inputs.slice(i, i + 5).map(async (sym) => {
        if (betaCache.get(sym)?.day === day) return;
        try {
          const beta = sym === "SPY" ? 1 : C.betaFromCloses(await closes(sym, day), benchmark);
          if (Number.isFinite(beta)) betaCache.set(sym, { day, beta });
        } catch { /* Missing histories leave individual entries blocked. */ }
      }));
    }
  }

  function freshQuote(q, t, at) {
    return Number.isFinite(q?.price) && q.price > 0 && Number.isFinite(q.marketTime) &&
      q.marketTime <= at && sessionOf(q.marketTime).day === t.day &&
      (t.open ? at - q.marketTime <= MARK_AGE : sessionOf(q.marketTime).min >= t.close - 5);
  }

  async function refresh(extra = []) {
    const t = clock();
    if (!t.trading || (!t.open && (t.min < t.close || t.min > t.close + 90))) return;
    if (updating) return updating;
    updating = (async () => {
      await load();
      await loadBooks();
      const first = books(), symbols = [...new Set(first.flatMap((b) => [...b.lots, ...(b.queued || [])].map((p) => p.sym)))];
      const quoteMap = await quotes([...new Set([...symbols, ...extra, "SPY", "^VIX"])]);
      const markAt = now(), t2 = clock();
      if (t2.day !== t.day || !freshQuote(quoteMap.SPY, t2, markAt)) throw new Error("Market mark unavailable");
      const current = books(), lots = current.flatMap((b) => b.lots);
      if (lots.some((p) => !freshQuote(quoteMap[p.sym], t2, markAt))) throw new Error("One or more held symbols lack an aligned mark");
      const equity = Object.fromEntries(current.map((b) => [b.bot, b.cash + b.lots.reduce((sum, p) => sum + p.sign * p.shares * quoteMap[p.sym].price, 0)]));
      const nav = Object.values(equity).reduce((sum, amount) => sum + amount, 0);
      const close = !t2.open && t2.min >= t2.close + 2;
      const next = C.updateMark(state, { nav, at: markAt, day: t2.day, previousDay: previousDay(t2.day), close });
      if (next === state && !state) throw new Error("Desk NAV unavailable");
      state = next;
      await store.set("state", state);
      const vix = quoteMap["^VIX"];
      const vixFresh = t2.open && Number.isFinite(vix?.price) && Number.isFinite(vix.changePct) &&
        vix.marketTime <= markAt && markAt - vix.marketTime <= 25 * 60_000 && sessionOf(vix.marketTime).day === t2.day;
      snapshot = { at: markAt, day: t2.day, equity, quoteMap, vixFresh, shock: vixFresh && vix.price >= 30 && vix.changePct >= 20 };
      block = null;
    })().catch((error) => { block = error.message; })
      .finally(() => { updating = null; });
    return updating;
  }

  async function prepare(symbols = []) {
    const t = clock();
    if (!t.open) return;
    const aligned = snapshot?.day === t.day && now() - snapshot.at < REFRESH && !block &&
      [...symbols, ...books().flatMap((b) => b.lots.map((p) => p.sym))].every((sym) => snapshot.quoteMap[sym]);
    if (!aligned) await refresh(symbols);
    if (block || !snapshot) return;
    try { await primeBeta([...symbols, ...books().flatMap((b) => [...b.lots, ...(b.queued || [])].map((p) => p.sym))], t.day); }
    catch { /* An entry still requires the instrument's estimate. */ }
  }

  function currentExposure(t, at) {
    const lots = [...reservations].map((r) => r.lot);
    for (const book of books()) {
      for (const p of book.lots) {
        const q = snapshot?.quoteMap[p.sym];
        const price = freshQuote(q, t, at) ? q.price : null;
        const beta = betaCache.get(p.sym);
        const risk = price == null ? null : p.risk(price);
        lots.push({ bot: book.bot, sign: p.sign, shares: p.shares, price, beta: beta?.day === t.day ? beta.beta : null, riskPerShare: risk });
      }
      for (const order of book.queued || []) {
        const beta = betaCache.get(order.sym);
        lots.push({ ...order, bot: book.bot, beta: beta?.day === t.day ? beta.beta : null });
      }
    }
    return C.exposure(lots);
  }

  function gate(t, at) {
    const fresh = !block && t.open && snapshot?.day === t.day && at - snapshot.at <= MARK_AGE && freshQuote(snapshot.quoteMap.SPY, t, at) &&
      snapshot.vixFresh && at - snapshot.quoteMap["^VIX"].marketTime <= 25 * 60_000;
    return C.status(state, { day: t.day, fresh, shock: snapshot?.shock });
  }

  function reserve({ bot, sym, sign, shares, price, riskPerShare, integer = false, pilotRoom }) {
    const t = clock(), at = now(), mode = gate(t, at), beta = betaCache.get(sym);
    if (!mode.multiplier || !Number.isFinite(beta?.beta) || beta.day !== t.day) {
      return { shares: 0, reason: mode.multiplier ? "Market beta unavailable for this symbol" : mode.reason };
    }
    const lot = { bot, sign, shares: 1, price, riskPerShare, beta: beta.beta };
    const current = currentExposure(t, at);
    const pilot = bot === "day" && pilotRoom != null;
    const result = pilot ? { units: C.dayPilotSize({ state, gate: mode, current, lot, units: shares, sessionRoom: pilotRoom }),
      reason: "Day paper allocation cannot fund one share" } : C.entrySize({ state, gate: mode, current, legs: [lot], units: shares, dayEquity: snapshot.equity.day, bot });
    const size = integer ? Math.floor(result.units) : result.units;
    if (!(size > 0)) return { shares: 0, reason: result.reason || "Desk risk budget cannot fund one share" };
    const ticket = { lot: { ...lot, shares: size } };
    reservations.add(ticket);
    return { shares: size, pilot, release: () => reservations.delete(ticket) };
  }

  function view() {
    const t = clock(), at = now(), mode = gate(t, at);
    return { policy: C.POLICY, state, ...mode, equity: snapshot?.equity ?? null, error: block,
      exposure: snapshot ? currentExposure(t, at) : null, durable: store.durable };
  }

  async function review() {
    await refresh();
    if (updating || block || !state?.peakLockAt || now() - state.at > MARK_AGE ||
        state.drawdown >= C.POLICY.peakStop || state.dailyLoss >= C.POLICY.hardDaily) return false;
    const next = { ...state, peakLockAt: null, reviewedAt: now() };
    const writing = store.set("state", next);
    updating = writing;
    try {
      await writing;
      state = next;
      return true;
    } finally { updating = null; }
  }

  function mayExecute() { return gate(clock(), now()).multiplier > 0; }
  return { refresh, prepare, reserve, mayExecute, view, review };
}

module.exports = { createDeskRisk };

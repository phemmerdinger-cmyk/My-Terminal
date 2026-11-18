// Serial, copy-on-write research account for the standalone pairs methodology.
const P = require("./quant-pairs-core.js");
const { MAX_QUOTE_AGE } = require("./paper-execution-core.js");

const CAPITAL = 30_000, PER_PAIR_RISK = 60, TOTAL_RISK = 180;
const DAY_MS = 86_400_000;
const dateValue = (day) => Date.parse(day + "T00:00:00Z");
const sign = (side) => side === "BUY" ? 1 : -1;
const positive = (n) => Number.isFinite(n) && n > 0;

function freshPairShadows() {
  return { version: 1, cash: CAPITAL, realized: 0, borrow: 0, costs: 0, closedPairs: 0, positions: {}, pending: [],
    formation: null, lastSignalDay: null, trades: [], equity: [], diagnostics: [] };
}

function markFor(position, leg) {
  return position.marks[leg.symbol] ?? leg.referencePrice;
}

function pairSummary(state) {
  const positions = Object.values(state.positions);
  let gross = 0, net = 0, unrealized = 0, reservedRisk = 0;
  for (const position of positions) {
    for (const leg of position.entryFills) {
      const mark = markFor(position, leg);
      gross += mark * leg.shares;
      net += sign(leg.side) * mark * leg.shares;
      unrealized += sign(leg.side) * (mark - leg.price) * leg.shares - leg.fee;
    }
    unrealized -= position.borrowAccrued;
    reservedRisk += position.riskDollars;
  }
  return { capital: CAPITAL, cash: state.cash, value: state.cash + net, gross, net, unrealized, realized: state.realized,
    reservedRisk, costs: state.costs, borrow: state.borrow, openPairs: positions.length,
    queued: state.pending.length, closedPairs: state.closedPairs || 0 };
}

function chargeBorrow(state, position, day) {
  const elapsed = (dateValue(day) - dateValue(position.borrowThrough)) / DAY_MS;
  if (!(elapsed > 0)) return;
  const short = position.entryFills.find((leg) => leg.side === "SELL");
  const estimate = elapsed * markFor(position, short) * short.shares * position.borrowAnnualBps / (365 * 1e4);
  state.cash -= estimate;
  state.borrow += estimate;
  position.borrowAccrued += estimate;
  position.borrowThrough = day;
}

function markClose(state, day, rawPrices) {
  for (const position of Object.values(state.positions)) {
    chargeBorrow(state, position, day);
    for (const leg of position.entryFills) {
      if (positive(rawPrices?.[leg.symbol])) position.marks[leg.symbol] = rawPrices[leg.symbol];
    }
  }
  const totals = pairSummary(state);
  state.equity = [...state.equity.filter((p) => p.day !== day), { day, value: totals.value, gross: totals.gross,
    borrow: totals.borrow, realized: totals.realized, unrealized: totals.unrealized }].slice(-1500);
}

function entrySize(plan, model, grossLeft, riskLeft) {
  // For a unit of gross, estimate deterioration to the z stop and include all modeled round-trip costs.
  const stopMove = (3.5 - Math.abs(plan.z)) * model.sd / (1 + model.beta);
  const riskRate = stopMove + plan.costBps / 1e4;
  if (!positive(riskRate)) return 0;
  return Math.max(0, Math.min(grossLeft, Math.min(PER_PAIR_RISK, riskLeft) / riskRate));
}

function entryRisk(plan, model, gross) {
  return ((3.5 - Math.abs(plan.z)) * model.sd / (1 + model.beta) + plan.costBps / 1e4) * gross;
}

function preparePairShadows(state, { sessions, adjustedCloses, signal, borrow, executionCosts, executeDay, now, riskOff }) {
  if (!signal?.day || !Number.isFinite(signal.time) || !Number.isFinite(now) || signal.time > now ||
      !executeDay || executeDay <= signal.day || (state?.lastSignalDay && signal.day <= state.lastSignalDay)) return state;
  const next = state ? structuredClone(state) : freshPairShadows();
  next.lastSignalDay = signal.day;
  next.pending = next.pending.filter((plan) => plan.executeDay > signal.day);
  markClose(next, signal.day, signal.rawPrices);

  const complete = sessions.filter((day) => day <= signal.day);
  const sinceFit = (fit) => complete.filter((day) => day > fit.through).length + (complete.includes(signal.day) ? 0 : 1);
  if (!next.formation?.through || sinceFit(next.formation) > P.MODEL_SESSIONS || !next.formation.models.some((model) => model.observations === P.FORMATION_SESSIONS)) {
    next.formation = P.fitPairs({ sessions: complete.filter((day) => day < signal.day), adjustedCloses });
  }
  const diagnostics = [];
  const queued = new Set(next.pending.map((plan) => plan.pairId));
  for (const [pairId, position] of Object.entries(next.positions)) {
    if (queued.has(pairId)) continue;
    const heldSessions = complete.filter((day) => day >= position.openDay).length + (complete.includes(signal.day) ? 0 : 1);
    const exit = P.planExit({ position, signal, heldSessions, executeDay, executionCosts });
    if (exit.ok) {
      position.exitReason = exit.reason;
      next.pending.push({ ...exit, pairId });
    }
    diagnostics.push({ pairId, stage: exit.ok ? "exitQueued" : "held", reason: exit.reason, z: exit.z ?? null });
  }
  if (riskOff) {
    next.diagnostics = [...diagnostics, { stage: "blocked", reason: "Risk-off entry pause" }];
    return next;
  }
  const totals = pairSummary(next);
  let grossLeft = CAPITAL - totals.gross - next.pending.reduce((a, b) => a + (b.grossNotional || 0), 0);
  let riskLeft = TOTAL_RISK - totals.reservedRisk - next.pending.reduce((a, b) => a + (b.riskDollars || 0), 0);
  for (const model of next.formation.models) {
    if (next.positions[model.id] || queued.has(model.id)) continue;
    const plan = P.planEntry({ model, executeDay, executionCosts, borrow, grossNotional: 1,
      signal: { ...signal, sessionsSinceFit: sinceFit(next.formation) } });
    const grossNotional = plan.ok ? entrySize(plan, model, grossLeft, riskLeft) : 0;
    if (!(grossNotional > 0)) {
      diagnostics.push({ pairId: model.id, stage: "blocked", reason: plan.reason === "No eligible forward signal"
        ? model.reason || plan.reason : plan.reason || "Risk or gross budget unavailable",
      z: plan.z ?? null, edgeBps: plan.edgeBps ?? null, costBps: plan.costBps ?? null });
      continue;
    }
    const riskDollars = entryRisk(plan, model, grossNotional);
    const orders = plan.orders.map((leg) => ({ ...leg, shares: leg.shares * grossNotional }));
    next.pending.push({ ...plan, pairId: model.id, orders, grossNotional, riskDollars });
    diagnostics.push({ pairId: model.id, stage: "entryQueued", z: plan.z, edgeBps: plan.edgeBps,
      costBps: plan.costBps, grossNotional, riskDollars });
    grossLeft -= grossNotional;
    riskLeft -= riskDollars;
  }
  next.diagnostics = diagnostics;
  return next;
}

function recordFill(state, plan, filled, day) {
  const previous = state.positions[plan.pairId];
  if (plan.action === "exit") chargeBorrow(state, previous, day);
  const orderCash = (leg) => -sign(leg.side) * leg.price * leg.shares - leg.fee;
  state.cash += filled.fills.reduce((total, leg) => total + orderCash(leg), 0);
  state.costs += filled.fills.reduce((total, leg) =>
    total + leg.fee + Math.abs(leg.price - leg.referencePrice) * leg.shares, 0);
  let pnl = null;
  if (plan.action === "enter") {
    state.positions[plan.pairId] = { ...filled.position, riskDollars: plan.riskDollars,
      borrowThrough: day, borrowAccrued: 0,
      marks: Object.fromEntries(filled.fills.map((leg) => [leg.symbol, leg.referencePrice])) };
  } else {
    pnl = [...previous.entryFills, ...filled.fills].reduce((total, leg) => total + orderCash(leg), -previous.borrowAccrued);
    state.realized += pnl;
    state.closedPairs = (state.closedPairs || 0) + 1;
    delete state.positions[plan.pairId];
  }
  state.trades.push({ day, pairId: plan.pairId, action: plan.action, reason: plan.reason || "Spread entry",
    z: plan.z, pnl, fills: filled.fills });
}

function openPairShadows(state, { day, opens, openTime, now, borrow }) {
  if (!state?.pending.length || !day || !Number.isFinite(openTime) || !Number.isFinite(now)) return state;
  const next = structuredClone(state), pending = [];
  const ordered = [...next.pending].sort((a, b) => Number(a.action === "enter") - Number(b.action === "enter"));
  for (const plan of ordered) {
    if (plan.executeDay > day) { pending.push(plan); continue; }
    if (plan.executeDay < day || now - openTime > MAX_QUOTE_AGE || plan.signalTime >= openTime) {
      next.diagnostics.push({ pairId: plan.pairId, stage: "expired", reason: "Opening window missed" });
      continue;
    }
    const active = !!next.positions[plan.pairId];
    if ((plan.action === "enter" && active) || (plan.action === "exit" && !active)) continue;
    const filled = P.fillAtOpen({ plan, opens, openTime, now, borrow });
    if (!filled.ok) {
      pending.push(plan);
      next.diagnostics.push({ pairId: plan.pairId, stage: "waiting", reason: filled.reason });
      continue;
    }
    if (plan.action === "enter") {
      const totals = pairSummary(next);
      const batchGross = filled.fills.reduce((a, leg) => a + leg.referencePrice * leg.shares, 0);
      if (totals.gross + batchGross > CAPITAL || totals.reservedRisk + plan.riskDollars > TOTAL_RISK + 1e-7) {
        next.diagnostics.push({ pairId: plan.pairId, stage: "blocked", reason: "Opening gross or risk cap exceeded" });
        continue;
      }
    }
    recordFill(next, plan, filled, day);
    next.diagnostics.push({ pairId: plan.pairId, stage: "filled", action: plan.action });
  }
  next.pending = pending;
  next.trades = next.trades.slice(-1000);
  next.diagnostics = next.diagnostics.slice(-30);
  return next;
}

module.exports = { freshPairShadows, pairSummary, preparePairShadows, openPairShadows };

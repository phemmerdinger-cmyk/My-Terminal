"use strict";

const POLICY = Object.freeze({
  capital: 90_000, softDaily: 400, hardDaily: 650, peakStop: 1_000,
  plannedRisk: 350, betaFraction: 0.25, dayGrossFraction: 1,
  tradeRisk: Object.freeze({ day: 60, swing: 90, quant: 60 }),
});

function updateMark(state, mark) {
  if (!Number.isFinite(mark.nav) || mark.nav <= 0 || !(mark.at > (state?.at || 0)) ||
      (state?.day && mark.day < state.day)) return state;
  const sameDay = state?.day === mark.day;
  const priorClose = state?.closeDay === mark.previousDay && Number.isFinite(state.closeNav) ? state.closeNav : null;
  const reference = sameDay ? state.reference : (priorClose ?? Math.max(POLICY.capital, mark.nav));
  const highWater = Math.max(POLICY.capital, state?.highWater || 0, mark.nav);
  return {
    ...state, day: mark.day, at: mark.at, nav: mark.nav, reference, highWater,
    referenceType: sameDay ? state.referenceType : priorClose == null ? "initial conservative reference" : "prior session close",
    dailyLoss: Math.max(0, reference - mark.nav), drawdown: Math.max(0, highWater - mark.nav),
    dailyStopDay: state?.dailyStopDay === mark.day || reference - mark.nav >= POLICY.hardDaily ? mark.day : state?.dailyStopDay ?? null,
    peakLockAt: state?.peakLockAt ?? (highWater - mark.nav >= POLICY.peakStop ? mark.at : null),
    ...(mark.close ? { closeDay: mark.day, closeNav: mark.nav } : {}),
  };
}

function status(state, { day, fresh, shock }) {
  if (state?.peakLockAt) return { mode: "locked", reason: "Desk drawdown lock — owner review required", multiplier: 0 };
  if (!fresh || state?.day !== day) return { mode: "waiting", reason: "Waiting for aligned desk prices", multiplier: 0 };
  if (state.dailyStopDay === day) return { mode: "paused", reason: "Desk daily loss stop", multiplier: 0 };
  if (shock) return { mode: "paused", reason: "Desk volatility shock filter", multiplier: 0 };
  const soft = state.dailyLoss >= POLICY.softDaily;
  return { mode: soft ? "reduced" : "armed", reason: soft ? "Desk daily risk reduced" : "Desk risk checks active", multiplier: soft ? 0.5 : 1 };
}

function betaFromCloses(stock, benchmark) {
  const dates = [...stock.keys()].filter((d) => benchmark.has(d)).sort().slice(-61);
  if (dates.length < 41) return null;
  const x = [], y = [];
  for (let i = 1; i < dates.length; i++) {
    x.push(Math.log(benchmark.get(dates[i]) / benchmark.get(dates[i - 1])));
    y.push(Math.log(stock.get(dates[i]) / stock.get(dates[i - 1])));
  }
  const avgX = x.reduce((a, v) => a + v, 0) / x.length;
  const avgY = y.reduce((a, v) => a + v, 0) / y.length;
  const variance = x.reduce((a, v) => a + (v - avgX) ** 2, 0);
  if (!(variance > 0)) return null;
  return x.reduce((a, v, i) => a + (v - avgX) * (y[i] - avgY), 0) / variance;
}

function exposure(lots) {
  let stopRisk = 0, betaDollars = 0, dayGross = 0;
  for (const lot of lots) {
    if (![lot.shares, lot.price, lot.riskPerShare, lot.beta].every(Number.isFinite) ||
        lot.shares < 0 || lot.price <= 0 || lot.riskPerShare <= 0 || ![-1, 1].includes(lot.sign)) return null;
    stopRisk += lot.shares * lot.riskPerShare;
    betaDollars += lot.sign * lot.shares * lot.price * lot.beta;
    if (lot.bot === "day") dayGross += lot.shares * lot.price;
  }
  return { stopRisk, betaDollars, dayGross };
}

function entrySize({ state, gate, current, legs, dayEquity, units, bot }) {
  if (!(gate.multiplier > 0) || !current || !Number.isFinite(units) || units <= 0) return { units: 0, reason: gate.reason || "No executable position size" };
  const unit = exposure(legs);
  if (!unit || !(unit.stopRisk > 0) || !Number.isFinite(POLICY.tradeRisk[bot])) return { units: 0, reason: "Missing beta or position-risk inputs" };
  const room = Math.min(POLICY.plannedRisk, POLICY.hardDaily - state.dailyLoss, POLICY.peakStop - state.drawdown) - current.stopRisk;
  const riskUnits = Math.min(room, POLICY.tradeRisk[bot] * gate.multiplier) / unit.stopRisk;
  const betaLimit = state.nav * POLICY.betaFraction;
  if (Math.abs(current.betaDollars) > betaLimit && Math.sign(unit.betaDollars) === Math.sign(current.betaDollars)) {
    return { units: 0, reason: "Desk market-beta limit" };
  }
  const betaUnits = unit.betaDollars === 0 ? Infinity :
    (betaLimit - Math.sign(unit.betaDollars) * current.betaDollars) / Math.abs(unit.betaDollars);
  const grossUnits = unit.dayGross ? (dayEquity * POLICY.dayGrossFraction - current.dayGross) / unit.dayGross : Infinity;
  const next = Math.max(0, Math.min(units, riskUnits, betaUnits, grossUnits));
  return { units: next, reason: next > 0 ? null : "Desk stop-risk, beta or gross exposure limit" };
}

module.exports = { POLICY, updateMark, status, betaFromCloses, exposure, entrySize };

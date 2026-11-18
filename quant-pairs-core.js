// Standalone paper research. The caller supplies completed sessions and an exchange calendar.
// Formation and forward adjusted closes share a point-in-time adjustment scale per symbol.
const QM = require("./public/qmath.js");
const { usableQuote, paperFill } = require("./paper-execution-core.js");

const PAIRS = Object.freeze([
  Object.freeze({ id: "SPY-IVV", left: "SPY", right: "IVV", relationship: "S&P 500 index funds" }),
  Object.freeze({ id: "QQQ-QQQM", left: "QQQ", right: "QQQM", relationship: "Nasdaq-100 index funds" }),
  Object.freeze({ id: "GLD-IAU", left: "GLD", right: "IAU", relationship: "physical gold trusts" }),
  Object.freeze({ id: "XOM-CVX", left: "XOM", right: "CVX", relationship: "integrated oil majors" }),
]);
const FORMATION_SESSIONS = 252, MODEL_SESSIONS = 21, ALPHA = 0.05;
const ENTER_Z = 2, EXIT_Z = 0.5, STOP_Z = 3.5, MIN_HALF_LIFE = 2, MAX_HALF_LIFE = 10;
const BORROW_AGE_MS = 24 * 60 * 60_000;
const positive = (value) => Number.isFinite(value) && value > 0;
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const isDay = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const reject = (reason, more = {}) => ({ ok: false, reason, ...more });

// CADF auxiliary regression: Δe[t] = gamma*e[t-1] + delta*Δe[t-1] + error.
// Fix one lag before validation. The intercept is estimated in the first, level regression only.
function residualUnitRoot(residuals) {
  const level = residuals.slice(1, -1);
  const change = residuals.slice(1).map((r, i) => r - residuals[i]);
  const lag = change.slice(0, -1), target = change.slice(1);
  const xx = QM.dot(level, level), zz = QM.dot(lag, lag), xz = QM.dot(level, lag);
  const determinant = xx * zz - xz * xz;
  if (!(determinant > 1e-12 * xx * zz)) return null;
  const xy = QM.dot(level, target), zy = QM.dot(lag, target);
  const gamma = (zz * xy - xz * zy) / determinant, delta = (xx * zy - xz * xy) / determinant;
  const error = target.map((y, i) => y - gamma * level[i] - delta * lag[i]);
  const se = Math.sqrt(QM.dot(error, error) * zz / (determinant * (target.length - 2)));
  return positive(se) ? gamma / se : null;
}

// MacKinnon (1994) asymptotic τ response surface, N=2, intercept (no trend).
// Coefficients: https://github.com/statsmodels/statsmodels/blob/main/statsmodels/tsa/adfvalues.py
// Engle–Granger assumes integrated log price levels. This screen tests a residual unit root.
function cointegrationP(t) {
  if (t > 0.92) return 1;
  if (t < -18.86) return 0;
  const z = t <= -2.62
    ? 2.92 + t * (1.5012 + t * 0.039796)
    : 2.1945 + t * (0.64695 + t * (-0.29198 - t * 0.042377));
  // Abramowitz and Stegun 26.2.17, absolute error < 8e-8.
  const x = Math.abs(z), k = 1 / (1 + 0.2316419 * x);
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * k *
    (0.319381530 + k * (-0.356563782 + k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))));
  return z < 0 ? tail : 1 - tail;
}

// MacKinnon (2010) Table 2, finite-sample 5% τc critical value, N=2.
const T = FORMATION_SESSIONS - 1;
const CRITICAL_5 = -3.33613 - 6.1101 / T - 6.823 / (T * T);

function fitPairs({ sessions, adjustedCloses }) {
  const dates = sessions.slice(-FORMATION_SESSIONS), through = dates.at(-1) || null;
  const completeCalendar = dates.length === FORMATION_SESSIONS && dates.every((day, i) => isDay(day) && (!i || day > dates[i - 1]));
  const models = PAIRS.map((pair) => {
    const m = { ...pair, through, observations: 0, critical5: CRITICAL_5, eligible: false };
    if (!completeCalendar) return { ...m, reason: "Need 252 sorted, unique completed market sessions" };
    const left = adjustedCloses[pair.left] || {}, right = adjustedCloses[pair.right] || {};
    const observations = dates.filter((day) => positive(left[day]) && positive(right[day])).length;
    if (observations !== FORMATION_SESSIONS) return { ...m, observations, reason: "Missing a completed adjusted close" };
    const l = dates.map((day) => Math.log(left[day])), r = dates.map((day) => Math.log(right[day]));
    const hedge = QM.ols(l, [r]), beta = hedge?.betas[0];
    if (!Number.isFinite(beta)) return { ...m, observations, reason: "Cannot estimate a hedge ratio" };
    const spread = l.map((x, i) => x - beta * r[i]), mean = QM.mean(spread), sd = QM.sd(spread);
    const residuals = spread.map((x) => x - mean);
    const t = sd > 1e-8 ? residualUnitRoot(residuals) : null;
    if (!Number.isFinite(t)) return { ...m, observations, beta, reason: "Degenerate residual series" };
    const ar = QM.ols(residuals.slice(1), [residuals.slice(0, -1)]);
    const phi = ar?.betas[0], halfLife = phi > 0 && phi < 1 ? Math.log(0.5) / Math.log(phi) : null;
    return { ...m, observations, beta, mean, sd, t, p: cointegrationP(t), phi: Number.isFinite(phi) ? phi : null,
      halfLife, maxHold: halfLife == null ? null : Math.floor(2 * halfLife) };
  });

  // Holm step-down controls the family of predefined pairs. Missing tests count as p=1.
  let running = 0;
  const ranked = models.map((m, index) => ({ index, p: m.p ?? 1 })).sort((a, b) => a.p - b.p);
  ranked.forEach(({ index, p }, rank) => {
    const model = models[index];
    running = Math.min(1, Math.max(running, p * (ranked.length - rank)));
    if (model.p == null) return;
    model.holmP = running;
    if (!(model.beta > 0)) model.reason = "Hedge coefficient must be positive";
    else if (model.t >= CRITICAL_5 || model.holmP > ALPHA) model.reason = "Residual unit-root screen did not pass";
    else if (!(model.halfLife >= MIN_HALF_LIFE && model.halfLife <= MAX_HALF_LIFE)) model.reason = "Half-life outside 2–10 sessions";
    else model.eligible = true;
  });
  return { through, models };
}

function zScore(model, adjustedPrices) {
  const left = adjustedPrices?.[model.left], right = adjustedPrices?.[model.right];
  return positive(left) && positive(right) && positive(model.sd)
    ? (Math.log(left) - model.beta * Math.log(right) - model.mean) / model.sd : null;
}

function validBorrow(value, now) {
  return value?.available === true && typeof value.source === "string" && !!value.source.trim() &&
    nonnegative(value.annualBps) && Number.isFinite(value.marketTime) && value.marketTime <= now &&
    now - value.marketTime <= BORROW_AGE_MS;
}

function tradeCosts(cost) {
  if (!cost || ![cost.halfSpreadBps, cost.slippageBps, cost.feeBps].every(nonnegative)) return null;
  const priceBps = cost.halfSpreadBps + cost.slippageBps;
  return priceBps < 1e4 && cost.feeBps < 1e4 ? { priceBps, feeBps: cost.feeBps } : null;
}

// signal = { day, time (ms), sessionsSinceFit, adjustedPrices, rawPrices }.
// executeDay is the next regular session from the caller's exchange calendar.
function planEntry({ model, signal, executeDay, grossNotional, executionCosts, borrow }) {
  if (!model?.eligible || !positive(model.beta) || !Number.isFinite(signal?.time) || !isDay(signal.day) ||
      signal.day <= model.through || !Number.isInteger(signal.sessionsSinceFit) ||
      signal.sessionsSinceFit < 1 || signal.sessionsSinceFit > MODEL_SESSIONS ||
      !isDay(executeDay) || executeDay <= signal.day || !positive(grossNotional)) return reject("No eligible forward signal");
  const z = zScore(model, signal.adjustedPrices);
  if (!Number.isFinite(z) || Math.abs(z) < ENTER_Z || Math.abs(z) >= STOP_Z) return reject("Spread outside entry band", { z });
  const direction = z < 0 ? 1 : -1;
  const legs = [model.left, model.right].map((symbol, i) => ({
    symbol,
    side: direction * (i ? -1 : 1) > 0 ? "BUY" : "SELL",
    weight: (i ? model.beta : 1) / (1 + model.beta),
    price: signal.rawPrices?.[symbol],
    costs: tradeCosts(executionCosts?.[symbol]),
  }));
  if (legs.some((leg) => !positive(leg.price) || !leg.costs)) return reject("Both raw prices and explicit cost estimates are required", { z });
  const short = legs.find((leg) => leg.side === "SELL"), borrowQuote = borrow?.[short.symbol];
  if (!validBorrow(borrowQuote, signal.time)) return reject("Short borrow or a timestamped rate is unavailable", { z });
  // Use an allowance for weekends/holidays over the full planned hold.
  const borrowDays = Math.ceil(model.maxHold * 7 / 5) + 3;
  const borrowBps = short.weight * borrowQuote.annualBps * borrowDays / 365;
  const costBps = legs.reduce((total, leg) => total + 2 * leg.weight * (leg.costs.priceBps + leg.costs.feeBps), borrowBps);
  // First-order gross return on the two legs. Cap expected convergence at the exit band.
  const convergence = Math.min(Math.abs(z) - EXIT_Z, Math.abs(z) * (1 - model.phi ** model.maxHold));
  const edgeBps = 1e4 * convergence * model.sd / (1 + model.beta);
  if (!(edgeBps > 2 * costBps)) return reject("Expected gross return does not clear twice modeled costs", { z, edgeBps, costBps });
  const orders = legs.map(({ symbol, side, weight, price, costs }) => ({ symbol, side, shares: grossNotional * weight / price, ...costs }));
  return { ok: true, action: "enter", signalDay: signal.day, signalTime: signal.time, executeDay, model: { ...model }, direction, z, edgeBps, costBps, orders,
    shortSymbol: short.symbol, maxBorrowBps: borrowQuote.annualBps };
}

// The model stored at entry governs every exit. heldSessions includes the completed opening session.
function planExit({ position, signal, heldSessions, executeDay, executionCosts }) {
  if (!position || !isDay(signal?.day) || !Number.isFinite(signal.time) || signal.day < position.openDay || !isDay(executeDay) || executeDay <= signal.day ||
      !Number.isInteger(heldSessions) || heldSessions < 1) return reject("No completed exit signal");
  const z = zScore(position.model, signal.adjustedPrices), signedZ = position.direction * z;
  let reason;
  if (position.exitReason) reason = position.exitReason;
  else if (Number.isFinite(z) && signedZ >= -EXIT_Z) reason = "Mean reversion";
  else if (Number.isFinite(z) && signedZ <= -STOP_Z) reason = "Spread stop";
  else if (heldSessions >= position.model.maxHold) reason = "Holding limit";
  else return reject(Number.isFinite(z) ? "Continue holding" : "Missing a paired adjusted close", { z });
  const orders = position.orders.map((leg) => ({ ...leg, side: leg.side === "BUY" ? "SELL" : "BUY",
    ...tradeCosts(executionCosts?.[leg.symbol]) }));
  return { ok: true, action: "exit", signalDay: signal.day, signalTime: signal.time, executeDay, z, reason, orders };
}

const exchangeClock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function atRegularOpen(day, time) {
  if (!Number.isFinite(time) || Math.abs(time) > 8.64e15 || time % 1000 !== 0) return false;
  const p = Object.fromEntries(exchangeClock.formatToParts(time).map((part) => [part.type, part.value]));
  return [p.year, p.month, p.day].join("-") === day && p.hour === "09" && p.minute === "30" && p.second === "00";
}

// opens = { SYMBOL: { price, marketTime } }. No fallback quotes or partial simulated fills.
function fillAtOpen({ plan, opens, openTime, now, borrow }) {
  if (!plan?.ok || !["enter", "exit"].includes(plan.action) || !Number.isFinite(plan.signalTime) || plan.signalTime >= openTime || !Number.isFinite(now) ||
      !atRegularOpen(plan.executeDay, openTime)) return reject("Wrong execution session");
  if (!Array.isArray(plan.orders) || plan.orders.length !== 2 ||
      plan.orders.some((order) => {
        const quote = opens?.[order.symbol];
        return quote?.marketTime !== openTime || !usableQuote(quote, now, openTime - 1);
      })) return reject("Both fresh opening prices are required");
  const quote = borrow?.[plan.shortSymbol];
  if (plan.action === "enter" && (!validBorrow(quote, openTime) || quote.annualBps > plan.maxBorrowBps)) {
    return reject("Opening borrow unavailable or more expensive than planned");
  }
  const fills = plan.orders.map((order) => {
    const referencePrice = opens[order.symbol].price;
    const price = paperFill(order.side, referencePrice, order.priceBps / 1e4);
    return { ...order, marketTime: openTime, referencePrice, price, fee: price * order.shares * order.feeBps / 1e4 };
  });
  const position = plan.action === "enter" ? { openDay: plan.executeDay, openedAt: openTime, direction: plan.direction, model: { ...plan.model },
    orders: plan.orders.map((order) => ({ ...order })), entryFills: fills.map((fill) => ({ ...fill })),
    borrowAnnualBps: quote.annualBps, borrowSource: quote.source } : null;
  return { ok: true, fills, position };
}

module.exports = { PAIRS, FORMATION_SESSIONS, MODEL_SESSIONS, fitPairs, planEntry, planExit, fillAtOpen };

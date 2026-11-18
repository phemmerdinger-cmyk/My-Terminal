// Forward-paper swing strategy. Scans completed sessions and issues opening intents.
const WEEK_MS = 7 * 86400_000;
const RULES = Object.freeze({
  trendWeeks: 30, trendSlopeWeeks: 4, relativeSessions: 126, minPercentile: 0.8,
  contractionSessions: 5, comparisonSessions: 10, maxContraction: 0.65,
  pivotSessions: 10, volumeSessions: 20, minVolumeRatio: 1.5, atrSessions: 14,
  maxEntryDistanceAtr: 0.5, stopBufferAtr: 0.01, trailAtR: 2, trailAtr: 2,
  minEpsGrowth: 0.25, minSalesGrowth: 0.15,
});

const positive = (n) => Number.isFinite(n) && n > 0;
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sessionTime(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  const time = Date.parse(day);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : NaN;
}

function weekStart(day) {
  const date = new Date(sessionTime(day));
  return +date - ((date.getUTCDay() + 6) % 7) * 86400_000;
}

function barsThrough(bars, day) {
  const result = new Map();
  for (const bar of Array.isArray(bars) ? bars : []) {
    if (!bar || typeof bar.day !== "string" || bar.day > day || !Number.isFinite(sessionTime(bar.day))) continue;
    const previous = result.get(bar.day);
    if (previous === undefined) result.set(bar.day, bar);
    else if (previous && ["open", "high", "low", "close", "volume"].some((key) => previous[key] !== bar[key])) result.set(bar.day, null);
  }
  return result;
}

function completedWeeks(sessions, signalDay, nextSession) {
  const signalWeek = weekStart(signalDay);
  const finalDayOfWeek = new Date(sessionTime(signalDay)).getUTCDay() === 5 || weekStart(nextSession) > signalWeek;
  const weeks = new Map();
  for (const day of sessions) {
    const start = weekStart(day);
    if (start < signalWeek || start === signalWeek && finalDayOfWeek) weeks.set(start, day);
  }
  const required = RULES.trendWeeks + RULES.trendSlopeWeeks;
  const recent = [...weeks.entries()].slice(-required);
  if (recent.length < required || recent.some(([week], index) => index > 0 && week - recent[index - 1][0] !== WEEK_MS)) return [];
  return recent.map(([, day]) => day);
}

const trueRange = (bar, prior) => Math.max(bar.high - bar.low, Math.abs(bar.high - prior.close), Math.abs(bar.low - prior.close));
const validRange = (bar) => !!bar && positive(bar.high) && positive(bar.low) && positive(bar.close) && bar.low <= bar.close && bar.close <= bar.high;

function rankRelative(cohort) {
  const sorted = [...cohort].sort((a, b) => a.relativeReturn - b.relativeReturn);
  for (let i = 0; i < sorted.length;) {
    let end = i + 1;
    while (end < sorted.length && sorted[end].relativeReturn === sorted[i].relativeReturn) end++;
    const percentile = (i + (end - i) / 2) / sorted.length;
    for (; i < end; i++) sorted[i].percentile = percentile;
  }
  return sorted;
}

/** Evaluate the newest version of the fundamentals whose public availability time is at or before asOf (epoch ms).
 * Missing coverage, including missing contemporaneous comparables, stays null. */
function canSlimAt(records, asOf) {
  let current = null;
  for (const record of Array.isArray(records) ? records : []) {
    if (record && positive(record.availableAt) && record.availableAt <= asOf &&
        (!current || record.availableAt > current.availableAt)) current = record;
  }
  if (!current || !Number.isFinite(current.eps) || !Number.isFinite(current.priorYearEps) ||
      !positive(current.sales) || !positive(current.priorYearSales)) return null;
  return current.priorYearEps > 0 && current.eps / current.priorYearEps >= 1 + RULES.minEpsGrowth &&
    current.sales / current.priorYearSales >= 1 + RULES.minSalesGrowth;
}

/** Scan exchange-local ISO session dates. barsBySymbol is { SYM: [{ day, open, high, low, close, volume }] }.
 * The caller must provide a finalized signalDay, its decision time (epoch ms) and, for a tradeable intent,
 * the next regular exchange session. All later data is ignored. The benchmark is excluded from the peer rank.
 * fundamentalsBySymbol optionally contains { SYM: [{ availableAt, eps, priorYearEps, sales, priorYearSales }] }.
 * The returned candidate list is technical-only. canSlim is true, false or null for an independent ablation. */
function screen({ barsBySymbol, signalDay, asOf, benchmark = "SPY", nextSession, fundamentalsBySymbol = {} }) {
  const signalTime = sessionTime(signalDay), nextTime = sessionTime(nextSession);
  const openDay = nextTime > signalTime ? nextSession : null;
  const counts = { input: 0, ranked: 0, leaders: 0, trend: 0, contraction: 0, breakout: 0, candidates: 0 };
  const result = { signalDay, openDay, counts, candidates: [] };
  if (!barsBySymbol || !Number.isFinite(signalTime) || !positive(asOf) || asOf < signalTime) return result;
  const market = barsThrough(barsBySymbol[benchmark], signalDay);
  const sessions = [...market.keys()].sort();
  const latest = sessions.at(-1), base = sessions.at(-1 - RULES.relativeSessions);
  if (latest !== signalDay || !positive(market.get(latest)?.close) || !positive(market.get(base)?.close)) return result;
  const benchmarkReturn = market.get(latest).close / market.get(base).close - 1;
  const weeklySessions = completedWeeks(sessions, signalDay, openDay);
  const recentSessions = sessions.slice(-1 - RULES.volumeSessions);
  const cohort = [];
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    if (symbol === benchmark) continue;
    counts.input++;
    const byDay = barsThrough(bars, signalDay);
    if (!positive(byDay.get(latest)?.close) || !positive(byDay.get(base)?.close)) continue;
    cohort.push({ symbol, byDay, relativeReturn: byDay.get(latest).close / byDay.get(base).close - 1 - benchmarkReturn });
  }
  counts.ranked = cohort.length;
  if (!weeklySessions.length) return result;
  for (const { symbol, byDay, relativeReturn, percentile } of rankRelative(cohort).reverse()) {
    if (percentile < RULES.minPercentile) break;
    counts.leaders++;
    const weeklyCloses = weeklySessions.map((day) => byDay.get(day)?.close);
    if (!weeklyCloses.every(positive)) continue;
    const weeklyAverage = average(weeklyCloses.slice(-RULES.trendWeeks));
    if (weeklyCloses.at(-1) <= weeklyAverage || weeklyAverage <= average(weeklyCloses.slice(0, RULES.trendWeeks))) continue;
    counts.trend++;

    const recent = recentSessions.map((day) => byDay.get(day));
    if (!recent.every((bar) => validRange(bar) && Number.isFinite(bar.volume) && bar.volume >= 0)) continue;
    const signal = recent.at(-1), prior = recent.slice(0, -1);
    const ranges = prior.slice(1).map((bar, index) => trueRange(bar, prior[index]));
    const contractionStart = ranges.length - RULES.contractionSessions;
    const before = median(ranges.slice(contractionStart - RULES.comparisonSessions, contractionStart));
    if (!(before > 0)) continue;
    const contraction = median(ranges.slice(contractionStart)) / before;
    if (contraction > RULES.maxContraction) continue;
    counts.contraction++;

    const pivot = Math.max(...prior.slice(-RULES.pivotSessions).map(({ high }) => high));
    const typicalVolume = median(prior.map(({ volume }) => volume));
    if (!positive(typicalVolume) || signal.close <= pivot) continue;
    const volumeRatio = signal.volume / typicalVolume;
    if (volumeRatio < RULES.minVolumeRatio) continue;
    counts.breakout++;
    const atr = average([...ranges, trueRange(signal, prior.at(-1))].slice(-RULES.atrSessions));
    const stop = Math.min(...prior.slice(-RULES.contractionSessions).map(({ low }) => low)) - RULES.stopBufferAtr * atr;
    if (!positive(atr) || !positive(stop) || stop >= pivot) continue;
    result.candidates.push({ symbol, signalDay, signalAt: asOf, openDay, pivot, stop, atr, relativeReturn, percentile, contraction, volumeRatio,
      canSlim: canSlimAt(fundamentalsBySymbol?.[symbol], asOf) });
  }
  counts.candidates = result.candidates.length;
  return result;
}

/** Check the original regular-session opening print for the scheduled session. The caller models spread and slippage. */
function entryAtOpen(intent, bar) {
  const deny = (status, reason) => ({ ok: false, status, reason });
  if (!intent || !Number.isFinite(sessionTime(intent.openDay)) || !(intent.openDay > intent.signalDay) ||
      !positive(intent.pivot) || !positive(intent.atr)) return deny("reject", "Invalid opening intent");
  if (!bar || !Number.isFinite(sessionTime(bar.day)) || bar.day < intent.openDay) return deny("wait", "Waiting for the scheduled opening session");
  if (bar.day > intent.openDay) return deny("reject", "Scheduled opening session has passed");
  if (!positive(bar.open)) return deny("wait", "Opening price unavailable");
  if (bar.open < intent.pivot) return deny("reject", "Opened below the breakout pivot");
  if (bar.open > intent.pivot + RULES.maxEntryDistanceAtr * intent.atr) return deny("reject", "Opening gap exceeded the entry band");
  return { ok: true, status: "eligible", reason: null, referencePrice: bar.open };
}

/** Apply a finalized daily bar to a long. Positions contain { entry, stop, initialStop, atr, highestClose,
 * openedDay, lastDay }. entry is the paper fill, atr is frozen at the signal. The prior stop takes priority.
 * A trailing stop calculated at the close first applies to the following session. */
function advancePosition(position, bar) {
  const unchanged = { position, exit: null };
  if (!position || !positive(position.entry) || !positive(position.initialStop) || !positive(position.stop) ||
      !positive(position.atr) || !Number.isFinite(sessionTime(position.openedDay)) ||
      !validRange(bar) || !positive(bar.open) || bar.open < bar.low || bar.open > bar.high ||
      !Number.isFinite(sessionTime(bar.day)) || bar.day < position.openedDay ||
      (position.lastDay && bar.day <= position.lastDay)) return unchanged;
  if (bar.low <= position.stop) {
    const gap = bar.open < position.stop;
    return { position: null, exit: { referencePrice: gap ? bar.open : position.stop, reason: gap ? "Gap through stop" : "Stop touched" } };
  }
  const highestClose = Math.max(positive(position.highestClose) ? position.highestClose : position.entry, bar.close);
  const risk = position.entry - position.initialStop;
  const stop = risk > 0 && highestClose >= position.entry + RULES.trailAtR * risk
    ? Math.max(position.stop, highestClose - RULES.trailAtr * position.atr)
    : position.stop;
  return { position: { ...position, highestClose, stop, lastDay: bar.day }, exit: null };
}

module.exports = { RULES, screen, canSlimAt, entryAtOpen, advancePosition };

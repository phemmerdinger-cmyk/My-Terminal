// Four more forward paper bots for the Strategy Lab. Pure rules on finalized daily bars; extra-bots-runner.js keeps
// the books and fills orders only at a verified opening price. Paper money, no data is estimated:
// a stock without enough history is skipped, not guessed.
//   pullback  — buy strong stocks (above the 200-day) after a sharp 2-day dip (RSI(2) < 10); sell on the bounce
//   rotation  — once a month hold the 3 strongest of the 11 S&P sector funds (only those above their 200-day)
//   earnings  — post-earnings drift: a 5%+ EPS beat that the market confirmed with a 2%+ up day; hold ~2 months
//   insider   — two or more different insiders buying on the open market (SEC Form 4, found by THE WEB spider in the
//               last 10 days); hold ~3 months
"use strict";

const SECTORS = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB", "XLC", "XLRE"];
const RULES = Object.freeze({
  pullback: { slots: 5, stop: 0.08, maxSessions: 7, rsiMax: 10 },
  rotation: { slots: 3, lookbacks: [63, 126] },
  earnings: { slots: 6, stop: 0.10, maxSessions: 40, minSurprise: 0.05, minReaction: 0.02, freshSessions: 2 },
  insider: { slots: 6, stop: 0.12, maxSessions: 60, minBuyers: 2, windowDays: 10, maxBelow200: 0.2 },
});

const closesTo = (bars, day) => (bars || []).filter((b) => b.day <= day && b.close > 0).map((b) => b.close);
const sma = (c, n) => (c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : null);
function rsi(c, n = 2) {
  if (c.length < n * 10 + 1) return null;
  let up = 0, dn = 0;
  const d = c.slice(1).map((v, i) => v - c[i]);
  for (let i = 0; i < n; i++) { up += Math.max(0, d[i]); dn += Math.max(0, -d[i]); }
  up /= n; dn /= n;
  for (let i = n; i < d.length; i++) { up = (up * (n - 1) + Math.max(0, d[i])) / n; dn = (dn * (n - 1) + Math.max(0, -d[i])) / n; }
  return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
}
const lastBarIs = (bars, day) => bars && bars.length && bars[bars.length - 1].day === day;

// ---- exits shared by the stock bots: stop, profit/bounce rule, time limit (sessions counted on SPY's calendar)
function exitFor(bot, pos, closes, sessionsHeld, r = RULES[bot]) {
  const px = closes[closes.length - 1];
  if (r.stop && px <= pos.entry * (1 - r.stop)) return `Stop: down ${Math.round(r.stop * 100)}% from entry`;
  if (bot === "pullback") { const m5 = sma(closes, 5); if (m5 && px > m5) return "Bounced above its 5-day average"; }
  if (r.maxSessions && sessionsHeld >= r.maxSessions) return `Time exit after ${sessionsHeld} sessions`;
  return null;
}

function pullbackIdeas(barsBySymbol, day, universe, r = RULES.pullback) {
  const out = [];
  for (const symbol of universe) {
    const bars = barsBySymbol[symbol]; if (!lastBarIs(bars, day)) continue;
    const c = closesTo(bars, day), m200 = sma(c, 200), v = rsi(c, 2);
    if (m200 == null || v == null) continue;
    if (c[c.length - 1] > m200 && v < r.rsiMax) out.push({ symbol, rank: v, reason: `Above its 200-day average after a sharp dip (2-day RSI ${v.toFixed(1)})` });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

function rotationTargets(barsBySymbol, day, r = RULES.rotation) {
  const [l1, l2] = r.lookbacks;
  const rows = [];
  for (const symbol of SECTORS) {
    const bars = barsBySymbol[symbol]; if (!lastBarIs(bars, day)) continue;
    const c = closesTo(bars, day); if (c.length < Math.max(201, l2 + 1)) continue;
    const ret = (n) => c[c.length - 1] / c[c.length - 1 - n] - 1;
    rows.push({ symbol, score: (ret(l1) + ret(l2)) / 2, r3: ret(l1), r6: ret(l2), above200: c[c.length - 1] > sma(c, 200) });
  }
  rows.sort((a, b) => b.score - a.score);
  const targets = rows.slice(0, r.slots).filter((x) => x.above200).map((x) => x.symbol);
  return { ranked: rows, targets, complete: rows.length === SECTORS.length };
}

// events: [{ symbol, date, hour: "bmo"|"amc"|null, surprise }] — surprise = (actual − estimate) / |estimate|
function earningsIdeas(events, barsBySymbol, day, sessions) {
  const out = [], idx = sessions.indexOf(day);
  if (idx < 0) return out;
  for (const e of events || []) {
    if (!(e.surprise >= RULES.earnings.minSurprise)) continue;
    const bars = barsBySymbol[e.symbol]; if (!lastBarIs(bars, day)) continue;
    // the first session that could react: the report day itself (before the open / unknown) or the next one (after the close)
    let react = sessions.findIndex((d) => (e.hour === "amc" ? d > e.date : d >= e.date));
    if (react < 0 || react > idx || idx - react >= RULES.earnings.freshSessions) continue;
    const reactDay = sessions[react], prev = sessions[react - 1];
    const bReact = bars.find((b) => b.day === reactDay), bPrev = bars.find((b) => b.day === prev);
    if (!bReact || !bPrev) continue;
    const move = bReact.close / bPrev.close - 1, c = closesTo(bars, day), m50 = sma(c, 50);
    if (move < RULES.earnings.minReaction || m50 == null || c[c.length - 1] <= m50) continue;
    out.push({ symbol: e.symbol, rank: -e.surprise, reason: `EPS beat by ${Math.round(e.surprise * 100)}% and the stock rose ${(move * 100).toFixed(1)}% on the report` });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// events: [{ symbol, buyers, lastAt, headline, source }] — distinct open-market insider buyers (90-day Form 4 window)
function insiderIdeas(events, barsBySymbol, day, asOf) {
  const out = [];
  for (const e of events || []) {
    if (!(e.buyers >= RULES.insider.minBuyers) || asOf - e.lastAt > RULES.insider.windowDays * 864e5) continue;
    const bars = barsBySymbol[e.symbol]; if (!lastBarIs(bars, day)) continue;
    const c = closesTo(bars, day), m200 = sma(c, 200);
    if (m200 == null || c[c.length - 1] < m200 * (1 - RULES.insider.maxBelow200)) continue; // not a falling knife
    out.push({ symbol: e.symbol, rank: -e.buyers, reason: `${e.buyers} insiders bought on the open market${e.headline ? ` — “${String(e.headline).slice(0, 90)}”` : ""}${e.source ? ` (${e.source})` : ""}` });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

module.exports = { SECTORS, RULES, sma, rsi, exitFor, pullbackIdeas, rotationTargets, earningsIdeas, insiderIdeas };

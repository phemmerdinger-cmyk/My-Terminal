// Market Desk — the day trader's brain: pure functions (no network), used by server.js and tests/daybrain.test.js.
//
// Every minute, for every stock, it turns everything the site knows into one feature vector, predicts the next
// minute's move (in units of the stock's typical 1-minute range, "ATR"), and learns from the answer a minute later.
//
//   chart (today's 1-minute bars)   momentum over 1/5/15 minutes, distance from VWAP, EMA trend, order-flow imbalance,
//                                   the stock's own momentum-vs-reversal tendency today, liquidity sweeps & gaps, patterns
//   tape (the whole market)         beta-adjusted strength vs the S&P, the S&P's last minute × beta, breadth × beta
//   research (other site sections)  News/earnings/analysts/financial health (swing-bot inputs), THE WEB Spider's findings,
//                                   the swing bot's ranking, the Quant trader's ranking, sector strength (Heatmap),
//                                   market regime (Quant regime, VIX, Macro page: yield curve, Sahm rule)
//
// The model is a linear forecaster trained online (every stock's outcome, every minute ≈ 39,000 a day, averaged into one
// RMSprop step per minute) on a Huber-clipped error, shrunk toward sensible starting weights so one noisy hour can't wreck it. Its accuracy is
// measured prequentially — each prediction is scored against the outcome *before* the model learns from it — so the
// hit rate and information coefficient it reports are out-of-sample.
//
// Sizing: direction = sign of the forecast; size grows with the forecast's edge *after trading costs*, relative to the
// model's typical edge. A trade whose edge doesn't clear its costs still happens (the bot keeps its pace) but at a
// minimum size, so costs stay small where it has nothing to say.
"use strict";
const DTC = require("./daytrade-core.js");

const FEATURES = [
  // key, label (for the trade log), group (the "setup" a trade is filed under), starting weight
  ["mom1", "last minute's move", "momentum", 0.02],
  ["mom5", "5-minute momentum", "momentum", 0.02],
  ["mom15", "15-minute trend", "momentum", 0.01],
  ["vwap", "distance from VWAP", "reversion", -0.025],
  ["ema", "9/20-EMA trend", "momentum", 0.01],
  ["flow", "order-flow imbalance", "flow", 0.02],
  ["autoc", "its own momentum/reversal tendency today", "flow", 0.03],
  ["level", "liquidity sweep / gap-and-go", "levels", 0.03],
  ["pattern", "chart pattern", "momentum", 0.015],
  ["rs", "beta-adjusted strength vs the S&P", "relative", 0.015],
  ["spy", "the S&P's last minute × beta", "tape", 0.015],
  ["breadth", "market breadth × beta", "tape", 0.01],
  ["research", "news, earnings, analysts & financial health", "research", 0.03],
  ["spider", "THE WEB Spider's findings", "spider", 0.02],
  ["swing", "the swing bot's ranking", "consensus", 0.01],
  ["quant", "the Quant trader's ranking", "consensus", 0.01],
  ["sector", "its sector vs the S&P today", "relative", 0.01],
  ["macro", "market regime & macro × beta", "tape", 0.01],
];
const KEYS = FEATURES.map((f) => f[0]), PRIOR = FEATURES.map((f) => f[3]);
const GROUP = { momentum: "Momentum", reversion: "VWAP snap-back", flow: "Order flow", levels: "Liquidity levels", relative: "Relative strength", tape: "Market tape", research: "News & research", spider: "Spider research", consensus: "Bot consensus" };
const LR = 0.002, BETA2 = 0.99, EPS = 1e-8, L2 = 0.02, HUBER = 2, EW = 0.002; // EW: ~500-sample memory for the scorecard
const MIN_X = 0.15, MAX_X = 2; // size multiplier range

const clip = (x, a, b) => (isFinite(x) ? Math.max(a, Math.min(b, x)) : 0);
const unit = (x, lim) => clip(x, -lim, lim) / lim; // → −1…+1

function fresh() {
  return { v: 1, w: PRIOR.slice(), g2: PRIOR.map(() => 0), acc: PRIOR.map(() => 0), k: 0, steps: 0, n: 0, hits: 0, scored: 0, mse: 0.5, absMu: 0.02, my: 0, mm: 0, yy: 0, day: { d: null, n: 0, hits: 0, scored: 0 } };
}
// Make an old/partial saved brain usable (new features added later start at their prior).
function fix(b) {
  if (!b || b.v !== 1 || !Array.isArray(b.w)) return fresh();
  const f = fresh(); const out = { ...f, ...b };
  out.w = KEYS.map((_, i) => (isFinite(b.w[i]) ? b.w[i] : PRIOR[i])); out.g2 = KEYS.map((_, i) => (b.g2 && isFinite(b.g2[i]) ? b.g2[i] : 0));
  out.acc = KEYS.map(() => 0); out.k = 0;
  out.day = b.day && typeof b.day === "object" ? b.day : f.day; return out;
}

// Lag-1 autocorrelation of 1-minute returns, shrunk toward 0 when there are few of them.
function autocorr(r) {
  const n = r.length; if (n < 10) return 0;
  const m = r.reduce((a, b) => a + b, 0) / n; let num = 0, den = 0;
  for (let i = 0; i < n; i++) { den += (r[i] - m) ** 2; if (i) num += (r[i] - m) * (r[i - 1] - m); }
  return den > 0 ? (num / den) * (n / (n + 30)) : 0;
}
// Beta of the stock's 1-minute returns to SPY's, over matching minutes, shrunk toward 1.
function betaOf(reg, spy) {
  const xs = [], ys = [];
  for (let i = Math.max(1, reg.length - 60); i < reg.length; i++) {
    const a = spy.get(reg[i].t), b = spy.get(reg[i - 1].t); if (!(a > 0 && b > 0) || !(reg[i - 1].c > 0)) continue;
    xs.push(a / b - 1); ys.push(reg[i].c / reg[i - 1].c - 1);
  }
  const n = xs.length; if (n < 10) return 1;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let c = 0, v = 0; for (let i = 0; i < n; i++) { c += (xs[i] - mx) * (ys[i] - my); v += (xs[i] - mx) ** 2; }
  const raw = v > 0 ? c / v : 1; return clip((n * raw + 20) / (n + 20), -1, 4);
}

// Feature vector for the bar that just closed (the last bar in `bars`; everything is known at its close — no lookahead).
//   bars: today's 1-minute bars up to and including the decision bar (pre-market included)
//   ctx:  { spy: Map(t → SPY close), breadth: −1…+1 at this minute, prev: prior-day {h,l,c} or null,
//           info: per-stock research {research, spider, swing, quant, sector, catalyst}, market: −1…+1 regime/macro }
function features(bars, ctx = {}) {
  const reg = bars.filter((b) => b.m >= DTC.OPEN); if (reg.length < 3) return null;
  const b = reg[reg.length - 1], c = b.c, cl = reg.map((x) => x.c);
  const a = DTC.atr(reg, 14) || c * 0.001;
  const back = (k) => cl[Math.max(0, cl.length - 1 - k)];
  const vw = DTC.vwap(reg), e9 = DTC.ema(cl, 9), e20 = DTC.ema(cl, 20), av = DTC.avgVol(reg, 20) || 1;
  // order flow: where each of the last 5 bars closed in its range, weighted by its relative volume
  let flow = 0; for (const x of reg.slice(-5)) { const r = x.h - x.l; if (r > 0) flow += ((2 * x.c - x.h - x.l) / r) * Math.min(3, x.v / av); }
  const rets = []; for (let i = Math.max(1, reg.length - 60); i < reg.length; i++) rets.push((reg[i].c - reg[i - 1].c) / a);
  const r1 = unit((c - back(1)) / a, 3);
  const spy = ctx.spy instanceof Map ? ctx.spy : new Map(), beta = betaOf(reg, spy);
  const sNow = spy.get(b.t), s1 = spy.get(reg[Math.max(0, reg.length - 2)].t), s5 = spy.get(reg[Math.max(0, reg.length - 6)].t);
  const spyR1 = sNow > 0 && s1 > 0 ? sNow / s1 - 1 : 0, spyR5 = sNow > 0 && s5 > 0 ? sNow / s5 - 1 : 0, r5 = c / back(5) - 1;
  // liquidity levels: a sweep-and-reclaim of a key level, or a gap-and-go break (rules in daytrade-core.js)
  let level = 0;
  try { const sw = DTC.sweep(bars, DTC.levels(ctx.prev || null, bars)); if (sw) level = sw.dir === "long" ? 1 : -1; } catch {}
  if (!level && ctx.prev && ctx.prev.c) { const g = DTC.gapGo(bars, ctx.prev.c, (ctx.info && ctx.info.catalyst) || 0); if (g) level = g.dir === "long" ? 0.8 : -0.8; }
  const sig = DTC.scalpSignal(bars), info = ctx.info || {};
  const x = {
    mom1: r1,
    mom5: unit((c - back(5)) / (a * Math.sqrt(5)), 3),
    mom15: unit((c - back(15)) / (a * Math.sqrt(15)), 3),
    vwap: vw ? unit((c - vw) / a, 4) : 0,
    ema: e9 != null && e20 != null ? unit((e9 - e20) / a, 2) : 0,
    flow: unit(flow / 5, 1),
    autoc: clip(autocorr(rets) * r1 * 3, -1, 1),
    level,
    pattern: sig ? (sig.dir === "long" ? 1 : -1) * clip(sig.score / 2.2, 0, 1) : 0,
    rs: unit(((r5 - beta * spyR5) * c) / (a * Math.sqrt(5)), 3),
    spy: unit((beta * spyR1 * c) / a, 3),
    breadth: clip((ctx.breadth || 0) * beta, -1, 1),
    research: clip(info.research || 0, -1, 1),
    spider: clip(info.spider || 0, -1, 1),
    swing: clip(info.swing || 0, -1, 1),
    quant: clip(info.quant || 0, -1, 1),
    sector: clip(info.sector || 0, -1, 1),
    macro: clip((ctx.market || 0) * beta, -1, 1),
  };
  return { x: KEYS.map((k) => x[k]), c, a, t: b.t, beta };
}

const predict = (brain, x) => x.reduce((s, v, i) => s + v * brain.w[i], 0);

// Learn from one outcome. y = the next minute's move in ATRs of the decision bar. Scores the prediction first.
function learn(brain, x, y, day) {
  y = clip(y, -3, 3);
  const mu = predict(brain, x), err = clip(mu - y, -HUBER, HUBER);
  // prequential scorecard (all-time and today)
  if (brain.day.d !== day) brain.day = { d: day, n: 0, hits: 0, scored: 0 };
  brain.n++; brain.day.n++;
  if (y !== 0 && mu !== 0) { brain.scored++; brain.day.scored++; if (Math.sign(y) === Math.sign(mu)) { brain.hits++; brain.day.hits++; } }
  brain.mse += EW * ((mu - y) ** 2 - brain.mse); brain.absMu += EW * (Math.abs(mu) - brain.absMu);
  brain.my += EW * (mu * y - brain.my); brain.mm += EW * (mu * mu - brain.mm); brain.yy += EW * (y * y - brain.yy);
  // gradient of the Huber loss, collected for this minute's mini-batch (see step)
  for (let i = 0; i < x.length; i++) brain.acc[i] += err * x[i];
  brain.k++;
  return mu;
}

// One RMSprop step on the minute's averaged gradient (all stocks share the same minute, and their errors are correlated,
// so one step per minute rather than one per stock), with L2 shrinkage toward the starting weights.
function step(brain) {
  if (!brain.k) return false;
  for (let i = 0; i < brain.w.length; i++) {
    const g = brain.acc[i] / brain.k + L2 * (brain.w[i] - PRIOR[i]);
    brain.g2[i] = BETA2 * brain.g2[i] + (1 - BETA2) * g * g;
    brain.w[i] = clip(brain.w[i] - (LR * g) / (Math.sqrt(brain.g2[i]) + EPS), -0.5, 0.5);
    brain.acc[i] = 0;
  }
  brain.k = 0; brain.steps++; return true;
}

// Decision for one stock this minute. costAtr = round-trip trading cost in ATRs.
//   Always returns a direction (the bot trades every stock every minute); `sizeX` carries the conviction.
function decide(brain, f, { costAtr = 0, mom = 0 } = {}) {
  const mu = predict(brain, f.x), dir = mu > 0 ? "long" : mu < 0 ? "short" : mom >= 0 ? "long" : "short", sgn = dir === "long" ? 1 : -1;
  const edge = Math.abs(mu) - costAtr, norm = Math.max(brain.absMu, 0.005);
  const sizeX = clip(MIN_X + (1 - MIN_X) * Math.max(0, edge) / norm, MIN_X, MAX_X);
  const contrib = f.x.map((v, i) => ({ i, c: v * brain.w[i] * sgn })).filter((z) => z.c > 0).sort((p, q) => q.c - p.c);
  const lead = contrib[0] ? FEATURES[contrib[0].i] : FEATURES[0];
  const reasons = contrib.slice(0, 3).map((z) => FEATURES[z.i][1]);
  const against = f.x.map((v, i) => ({ i, c: v * brain.w[i] * sgn })).filter((z) => z.c < 0).sort((p, q) => p.c - q.c)[0];
  return { dir, mu, edge, sizeX, kind: lead[2], reasons, against: against && -against.c > 0.002 ? FEATURES[against.i][1] : null, ic: ic(brain) };
}
// Rolling information coefficient (correlation of forecast and outcome over ~the last 500 predictions).
const ic = (b) => (b.mm > 0 && b.yy > 0 ? b.my / Math.sqrt(b.mm * b.yy) : 0);

// Portfolio guard: scale a new trade so gross stays ≤ grossCap × equity and |net| ≤ netCap × equity.
// Never below 1 share (the bot keeps its pace) unless even 1 share would breach gross.
function guard(shares, px, dir, book, eq, { grossCap = 4, netCap = 1.5 } = {}) {
  if (!(shares >= 1) || !(px > 0) || !(eq > 0)) return 0;
  const sgn = dir === "long" ? 1 : -1, roomG = grossCap * eq - book.gross;
  let roomN = Infinity; if (Math.sign(book.net) === sgn || book.net === 0) roomN = netCap * eq - Math.abs(book.net); else roomN = netCap * eq + Math.abs(book.net);
  const max = Math.floor(Math.min(roomG, roomN) / px);
  if (max >= shares) return shares;
  if (roomG < px) return 0;
  return Math.max(1, max);
}

// Market breadth per minute: (stocks above their VWAP − stocks below) ÷ stocks counted, from every stock's bars.
// Returns t → −1…+1 (0 when fewer than `min` stocks have a bar at that minute). Index ETFs are left out.
function breadthMap(list, min = 20) {
  const m = new Map();
  for (const [sym, bars] of list) {
    if (!bars || /^(SPY|QQQ|IWM|DIA)$/.test(sym)) continue;
    let pv = 0, v = 0;
    for (const b of bars) { if (b.m < DTC.OPEN) continue; pv += ((b.h + b.l + b.c) / 3) * b.v; v += b.v; if (!v) continue; const e = m.get(b.t) || [0, 0]; e[0] += b.c > pv / v ? 1 : b.c < pv / v ? -1 : 0; e[1]++; m.set(b.t, e); }
  }
  return (t) => { const e = m.get(t); return e && e[1] >= min ? e[0] / e[1] : 0; };
}

function scorecard(b) {
  return { n: b.n, hitRate: b.scored ? b.hits / b.scored : null, today: b.day && b.day.scored ? { n: b.day.n, hitRate: b.day.hits / b.day.scored } : null, ic: +ic(b).toFixed(4), rmse: +Math.sqrt(b.mse).toFixed(3), absMu: +b.absMu.toFixed(4),
    weights: FEATURES.map(([k, label, g], i) => ({ k, label, group: GROUP[g], prior: PRIOR[i], w: +b.w[i].toFixed(4) })) };
}

module.exports = { FEATURES, KEYS, PRIOR, GROUP, MIN_X, MAX_X, fresh, fix, features, predict, learn, step, decide, guard, breadthMap, scorecard, autocorr, betaOf, ic };

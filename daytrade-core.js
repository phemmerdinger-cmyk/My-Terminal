// Market Desk — day-trader core: pure functions (no network) used by the server and the tests.
// Bars are 1-minute candles {t (unix s), m (minutes after midnight ET), o, h, l, c, v}.
"use strict";

const OPEN = 9 * 60 + 30, CLOSE = 16 * 60;

// Key levels where stop orders cluster: prior-day high/low, pre-market high/low, opening range (first 15 minutes).
function levels(prev, bars) {
  const pre = bars.filter((b) => b.m >= 4 * 60 && b.m < OPEN), or = bars.filter((b) => b.m >= OPEN && b.m < OPEN + 15);
  const L = [];
  if (prev) { L.push({ k: "PDH", name: "prior-day high", p: prev.h, side: "high" }, { k: "PDL", name: "prior-day low", p: prev.l, side: "low" }); }
  if (pre.length >= 5) { L.push({ k: "PMH", name: "pre-market high", p: Math.max(...pre.map((b) => b.h)), side: "high" }, { k: "PML", name: "pre-market low", p: Math.min(...pre.map((b) => b.l)), side: "low" }); }
  const lastM = bars.length ? bars[bars.length - 1].m : 0;
  if (or.length >= 10 && lastM >= OPEN + 15) { L.push({ k: "ORH", name: "opening-range high", p: Math.max(...or.map((b) => b.h)), side: "high" }, { k: "ORL", name: "opening-range low", p: Math.min(...or.map((b) => b.l)), side: "low" }); }
  // intraday liquidity: the session high/low and the last 30 minutes' swing high/low, measured before the
  // most recent 5 bars (so a fresh run through them can count as a sweep)
  const reg = bars.filter((b) => b.m >= OPEN), base = reg.slice(0, -5);
  if (base.length >= 15) {
    L.push({ k: "HOD", name: "high of day", p: Math.max(...base.map((b) => b.h)), side: "high" }, { k: "LOD", name: "low of day", p: Math.min(...base.map((b) => b.l)), side: "low" });
    const sw = base.slice(-30);
    if (base.length >= 45) L.push({ k: "SWH", name: "30-minute swing high", p: Math.max(...sw.map((b) => b.h)), side: "high" }, { k: "SWL", name: "30-minute swing low", p: Math.min(...sw.map((b) => b.l)), side: "low" });
  }
  return L;
}
const vwap = (bars) => { let pv = 0, v = 0; for (const b of bars) if (b.m >= OPEN) { pv += ((b.h + b.l + b.c) / 3) * b.v; v += b.v; } return v ? pv / v : null; };
const avgVol = (bars, n = 20) => { const a = bars.slice(-n - 1, -1).map((b) => b.v).filter((x) => x > 0); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; };

// Liquidity sweep: within the last 5 completed bars, price ran past a level (taking the stops resting there)
// on above-average volume (1.25×), and the latest bar closed back on the other side. Returns a trade idea or null.
function sweep(bars, lv, { buf = 0.0004, volMult = 1.25, lookback = 5 } = {}) {
  const reg = bars.filter((b) => b.m >= OPEN); if (reg.length < 8) return null;
  const last = reg[reg.length - 1], win = reg.slice(-lookback);
  for (const L of lv) {
    const pad = L.p * buf;
    if (L.side === "high") {
      const sb = win.filter((b) => b.h > L.p + pad); if (!sb.length) continue;
      const wick = Math.max(...sb.map((b) => b.h)), hit = sb.find((b) => b.h === wick), vol = avgVol(reg.slice(0, reg.indexOf(hit) + 1));
      if (last.c < L.p && vol && hit.v >= volMult * vol) return { dir: "short", level: L, wick, volX: hit.v / vol, at: last.t, entry: L.p, stop: wick + pad };
    } else {
      const sb = win.filter((b) => b.l < L.p - pad); if (!sb.length) continue;
      const wick = Math.min(...sb.map((b) => b.l)), hit = sb.find((b) => b.l === wick), vol = avgVol(reg.slice(0, reg.indexOf(hit) + 1));
      if (last.c > L.p && vol && hit.v >= volMult * vol) return { dir: "long", level: L, wick, volX: hit.v / vol, at: last.t, entry: L.p, stop: wick - pad };
    }
  }
  return null;
}

// Gap and go: a stock that gapped ≥ 2% on a matching catalyst — or ≥ 4% with no known catalyst (a gap that big
// is news in itself) — breaks its first-5-minute range in the gap's direction.
// Entry is a limit at the breakout level (a retest), stop on the far side of the 5-minute range.
function gapGo(bars, prevClose, catalyst, { minGap = 0.02, bigGap = 0.04 } = {}) {
  const reg = bars.filter((b) => b.m >= OPEN); if (reg.length < 6 || !prevClose) return null;
  const gap = reg[0].o / prevClose - 1, r5 = reg.slice(0, 5), hi = Math.max(...r5.map((b) => b.h)), lo = Math.min(...r5.map((b) => b.l)), last = reg[reg.length - 1];
  if (last.m > OPEN + 120) return null; // gap plays only in the first two hours
  const up = gap >= bigGap || (gap >= minGap && catalyst > 0), dn = gap <= -bigGap || (gap <= -minGap && catalyst < 0);
  if (up && !(catalyst < 0) && last.c > hi) return { dir: "long", gap, entry: hi, stop: lo, at: last.t };
  if (dn && !(catalyst > 0) && last.c < lo) return { dir: "short", gap, entry: lo, stop: hi, at: last.t };
  return null;
}

// Position size from the dollars at risk: shares = risk ÷ (distance to stop), capped by buying power.
function size(equity, entry, stop, riskPct, maxNotional) {
  const per = Math.abs(entry - stop); if (!(per > 0)) return 0;
  return Math.max(0, Math.floor(Math.min((equity * riskPct) / per, maxNotional / entry)));
}

// One bar of order handling. Limit orders placed before this bar can fill on it (never on the bar that created them).
//   buy limit fills if low ≤ limit (at the limit, or at the open if the bar opened below it); sell/short limit mirrors.
function fillOrder(o, b) {
  if (o.dir === "long" && b.l <= o.price) return Math.min(o.price, b.o);
  if (o.dir === "short" && b.h >= o.price) return Math.max(o.price, b.o);
  return null;
}
// Exits for an open position on one bar. If the stop and target are both inside the bar, assume the stop hit first
// (the conservative choice). Gaps through a level fill at the open. After +1R the stop moves to breakeven.
function manage(p, b, slip = 0.0002) {
  const long = p.dir === "long";
  if (long) {
    if (b.l <= p.stop) return { px: Math.min(p.stop, b.o) * (1 - slip), why: p.stop >= p.entry ? "Stopped out at breakeven" : "Stop-loss hit" };
    if (b.h >= p.target) return { px: Math.max(p.target, b.o), why: "Profit target hit (2R)" };
    if (!p.be && b.h >= p.entry + (p.entry - p.stop0)) { p.stop = p.entry; p.be = true; }
  } else {
    if (b.h >= p.stop) return { px: Math.max(p.stop, b.o) * (1 + slip), why: p.stop <= p.entry ? "Stopped out at breakeven" : "Stop-loss hit" };
    if (b.l <= p.target) return { px: Math.min(p.target, b.o), why: "Profit target hit (2R)" };
    if (!p.be && b.l <= p.entry - (p.stop0 - p.entry)) { p.stop = p.entry; p.be = true; }
  }
  return null;
}
const pnlOf = (p, exit) => (p.dir === "long" ? exit - p.entry : p.entry - exit) * p.shares;

// ---------------------------------------------------------------- scalper
// Exponential moving average of the last value, and the average 1-minute true range.
function ema(vals, n) { if (!vals.length) return null; const k = 2 / (n + 1); let e = vals[0]; for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k); return e; }
function atr(bars, n = 14) {
  const tr = bars.slice(1).map((b, i) => Math.max(b.h - b.l, Math.abs(b.h - bars[i].c), Math.abs(b.l - bars[i].c))).slice(-n);
  return tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : null;
}
// One scalp idea per stock per minute, or null. Three quick patterns, all judged on the bar that just closed:
//   pullback — trend up (9-EMA over 20-EMA, price over VWAP), the bar dipped to the 9-EMA and closed green → long (mirror for short)
//   burst    — a bar of 1.3×+ the normal range on 1.3×+ volume closing in its top/bottom quarter → ride it
//   stretch  — price 2.5+ average ranges away from VWAP with a reversal bar → fade it back toward VWAP
// Entry is a limit at the close (valid one minute), stop and target one average range away.
function scalpSignal(bars, { stopX = 1, targetX = 1.2 } = {}) {
  const reg = bars.filter((b) => b.m >= OPEN); if (reg.length < 15) return null;
  const b = reg[reg.length - 1], cl = reg.map((x) => x.c), e9 = ema(cl, 9), e20 = ema(cl, 20), vw = vwap(reg), a = atr(reg, 14), v = avgVol(reg, 20);
  if (!a || !vw || !(b.c > 0)) return null;
  const rng = b.h - b.l, pos = rng > 0 ? (b.c - b.l) / rng : 0.5, volX = v ? b.v / v : 1, green = b.c > b.o, red = b.c < b.o;
  let idea = null;
  if (e9 > e20 && b.c > vw && b.l <= e9 * 1.0003 && green) idea = { dir: "long", kind: "pullback", score: 1 + Math.min(1, volX / 3), why: "uptrend pullback to the 9-EMA, closed green" };
  else if (e9 < e20 && b.c < vw && b.h >= e9 * 0.9997 && red) idea = { dir: "short", kind: "pullback", score: 1 + Math.min(1, volX / 3), why: "downtrend pop to the 9-EMA, closed red" };
  else if (rng >= 1.3 * a && volX >= 1.3 && pos >= 0.75) idea = { dir: "long", kind: "burst", score: 1.2 + Math.min(1, volX / 4), why: `range burst on ${volX.toFixed(1)}× volume, closed near the high` };
  else if (rng >= 1.3 * a && volX >= 1.3 && pos <= 0.25) idea = { dir: "short", kind: "burst", score: 1.2 + Math.min(1, volX / 4), why: `range burst on ${volX.toFixed(1)}× volume, closed near the low` };
  else if ((b.c - vw) / a >= 2.5 && red) idea = { dir: "short", kind: "stretch", score: 0.8 + Math.min(1, (b.c - vw) / a / 5), why: "stretched far above VWAP, reversal bar" };
  else if ((vw - b.c) / a >= 2.5 && green) idea = { dir: "long", kind: "stretch", score: 0.8 + Math.min(1, (vw - b.c) / a / 5), why: "stretched far below VWAP, reversal bar" };
  if (!idea) return null;
  const d = Math.max(a * stopX, b.c * 0.0005); // never tighter than 0.05% of price
  const t = Math.max(a * targetX, b.c * 0.0006);
  return { ...idea, entry: b.c, stop: idea.dir === "long" ? b.c - d : b.c + d, target: idea.dir === "long" ? b.c + t : b.c - t, atr: a, at: b.t };
}
// Exits for a scalp on one bar, then a 5-minute time stop at the close. When the stop and the target are both inside
// one bar, the usual OHLC path rule decides which came first: a green bar went open → low → high → close,
// a red bar open → high → low → close. A gap through either level fills at the open.
function scalpManage(p, b, maxBars = 5) {
  p.bars = (p.bars || 0) + 1;
  const long = p.dir === "long";
  const hitS = long ? b.l <= p.stop : b.h >= p.stop, hitT = long ? b.h >= p.target : b.l <= p.target;
  const stop = { px: long ? Math.min(p.stop, b.o) : Math.max(p.stop, b.o), why: "Stop hit" }, tgt = { px: long ? Math.max(p.target, b.o) : Math.min(p.target, b.o), why: "Target hit" };
  if (hitS && hitT) { const gapS = long ? b.o <= p.stop : b.o >= p.stop, gapT = long ? b.o >= p.target : b.o <= p.target; if (gapS) return stop; if (gapT) return tgt; const lowFirst = b.c >= b.o; return (long ? lowFirst : !lowFirst) ? stop : tgt; }
  if (hitS) return stop;
  if (hitT) return tgt;
  if (p.bars >= maxBars) return { px: b.c, why: `Time stop — out after ${maxBars} minutes` };
  return null;
}

module.exports = { OPEN, CLOSE, levels, vwap, avgVol, sweep, gapGo, size, fillOrder, manage, pnlOf, ema, atr, scalpSignal, scalpManage };

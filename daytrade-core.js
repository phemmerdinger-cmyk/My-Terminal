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
  return L;
}
const vwap = (bars) => { let pv = 0, v = 0; for (const b of bars) if (b.m >= OPEN) { pv += ((b.h + b.l + b.c) / 3) * b.v; v += b.v; } return v ? pv / v : null; };
const avgVol = (bars, n = 20) => { const a = bars.slice(-n - 1, -1).map((b) => b.v).filter((x) => x > 0); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; };

// Liquidity sweep: within the last 3 completed bars, price ran past a level (taking the stops resting there)
// on above-average volume, and the latest bar closed back on the other side. Returns a trade idea or null.
function sweep(bars, lv, { buf = 0.0005, volMult = 1.5, lookback = 3 } = {}) {
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

// Gap and go: a stock that gapped ≥ 3% on a catalyst breaks its first-5-minute range in the gap's direction.
// Entry is a limit at the breakout level (a retest), stop on the far side of the 5-minute range.
function gapGo(bars, prevClose, catalyst, { minGap = 0.03 } = {}) {
  const reg = bars.filter((b) => b.m >= OPEN); if (reg.length < 6 || !prevClose) return null;
  const gap = reg[0].o / prevClose - 1, r5 = reg.slice(0, 5), hi = Math.max(...r5.map((b) => b.h)), lo = Math.min(...r5.map((b) => b.l)), last = reg[reg.length - 1];
  if (last.m > OPEN + 90) return null; // gap plays only in the first 90 minutes
  if (gap >= minGap && catalyst > 0 && last.c > hi) return { dir: "long", gap, entry: hi, stop: lo, at: last.t };
  if (gap <= -minGap && catalyst < 0 && last.c < lo) return { dir: "short", gap, entry: lo, stop: hi, at: last.t };
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

module.exports = { OPEN, CLOSE, levels, vwap, avgVol, sweep, gapGo, size, fillOrder, manage, pnlOf };

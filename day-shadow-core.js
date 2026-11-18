// Market Desk Day Trader research signals, evaluated on sealed five-minute equity bars.
"use strict";

const { OPEN, CLOSE, validMinuteBar } = require("./daytrade-core.js");

const FIVE = 5, PERIOD = 14, EMA_PERIOD = 20, HOLD = 10;
const OR_END = OPEN + 15, PAD = 0.1;

function foldFiveMinute(bars, { day, asOf, closeMinute = CLOSE }) {
  if (!day || !Number.isFinite(asOf)) return [];
  const groups = new Map();
  for (const bar of bars) {
    if (!bar || bar.d !== day || !validMinuteBar(bar) || !Number.isFinite(bar.v) || bar.v < 0 || bar.m < OPEN || (bar.t + 60) * 1000 > asOf) continue;
    const minute = bar.m - (bar.m - OPEN) % FIVE;
    if (minute + FIVE > closeMinute) continue;
    if (!groups.has(minute)) groups.set(minute, new Map());
    groups.get(minute).set(bar.m, bar);
  }
  const out = [];
  for (const [m, group] of groups) {
    if (group.size !== FIVE) continue;
    const first = group.get(m);
    const window = Array.from({ length: FIVE }, (_, i) => group.get(m + i));
    if (!window.every((bar, i) => bar && bar.t === first.t + i * 60)) continue;
    out.push({
      d: day, t: first.t, m, o: first.o, c: window.at(-1).c,
      h: Math.max(...window.map((bar) => bar.h)), l: Math.min(...window.map((bar) => bar.l)),
      v: window.reduce((sum, bar) => sum + bar.v, 0),
      // Minute-bar typical prices approximate the price×volume numerator of session VWAP.
      pv: window.reduce((sum, bar) => sum + ((bar.h + bar.l + bar.c) / 3) * bar.v, 0),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Wilder ADX and ATR over completed 5-minute candles; EMA takes 20 closes to seed.
function indicators(bars) {
  let tr = 0, plus = 0, minus = 0, dxSum = 0, dxCount = 0, adx = null, ema = null, closeSum = 0;
  return bars.map((bar, i) => {
    if (i < EMA_PERIOD) closeSum += bar.c;
    if (i === EMA_PERIOD - 1) ema = closeSum / EMA_PERIOD;
    if (i >= EMA_PERIOD) ema += 2 / (EMA_PERIOD + 1) * (bar.c - ema);
    if (i > 0) {
      const previous = bars[i - 1];
      const range = Math.max(bar.h - bar.l, Math.abs(bar.h - previous.c), Math.abs(bar.l - previous.c));
      const up = bar.h - previous.h, down = previous.l - bar.l;
      const p = up > down && up > 0 ? up : 0, n = down > up && down > 0 ? down : 0;
      const decay = i > PERIOD ? (PERIOD - 1) / PERIOD : 1;
      tr = tr * decay + range;
      plus = plus * decay + p;
      minus = minus * decay + n;
      if (i >= PERIOD) {
        // DI values share the same true-range denominator, which cancels in DX.
        const dx = plus + minus > 0 ? 100 * Math.abs(plus - minus) / (plus + minus) : 0;
        dxSum += dx;
        dxCount++;
        if (dxCount === PERIOD) adx = dxSum / PERIOD;
        if (dxCount > PERIOD) adx += (dx - adx) / PERIOD;
      }
    }
    return { ...bar, ema, adx, atr: i >= PERIOD ? tr / PERIOD : null };
  });
}

function priorBias(prior) {
  if (!prior || ![prior.o, prior.h, prior.l, prior.c].every((p) => Number.isFinite(p) && p > 0) ||
      !(prior.h > prior.l) || prior.l > Math.min(prior.o, prior.c) || prior.h < Math.max(prior.o, prior.c)) return null;
  const range = prior.h - prior.l;
  const lower = prior.l + 0.2 * range, upper = prior.h - 0.2 * range;
  if (prior.o >= upper && prior.c <= lower) return "long";
  if (prior.o <= lower && prior.c >= upper) return "short";
  return null;
}

function gapDirection(bars) {
  const [first, middle, last] = bars;
  if (!last || middle.t !== first.t + FIVE * 60 || last.t !== middle.t + FIVE * 60) return null;
  if (last.l > first.h) return "long";
  if (last.h < first.l) return "short";
  return null;
}

function bracketAtFill(signal, price) {
  if (!signal || !Number.isFinite(price) || !(price > 0)) return null;
  const side = signal.dir === "long" ? 1 : -1;
  const risk = side * (price - signal.stop);
  if (!(risk > 0 && signal.stop > 0)) return null;
  let target = price + side * risk * signal.rewardRisk;
  if (signal.targetVwap != null) {
    if (side * (signal.targetVwap - price) <= 0) return null;
    target = side > 0 ? Math.min(target, signal.targetVwap) : Math.max(target, signal.targetVwap);
  }
  if (!(target > 0)) return null;
  return { stop: signal.stop, target };
}

function makeSignal(setup, dir, bar, extreme, rewardRisk, targetVwap = null) {
  const sign = dir === "long" ? 1 : -1;
  const signal = { setup, dir, t: bar.t, m: bar.m, closeAt: (bar.t + FIVE * 60) * 1000, hold: HOLD,
    reference: bar.c, stop: extreme - sign * PAD * bar.atr, rewardRisk, targetVwap };
  const bracket = bracketAtFill(signal, bar.c);
  return bracket ? { ...signal, ...bracket } : null;
}

function risingAdx(bars, index) {
  if (index < 2) return false;
  const a = bars[index - 2].adx, b = bars[index - 1].adx, c = bars[index].adx;
  return a != null && b != null && c > 30 && a < b && b < c;
}

function continuation(previous, current, range, trend, adxRising) {
  if (!range || current.m < OR_END || current.vwap == null || current.ema == null) return { trend: null, signal: null };
  if (trend) {
    const long = trend.dir === "long";
    const aligned = long ? current.c > current.vwap : current.c < current.vwap;
    if (!aligned || current.adx == null || current.adx < 18) trend = null;
    else {
      const touch = long ? current.l <= current.ema : current.h >= current.ema;
      const confirmation = long ? current.c > previous.h : current.c < previous.l;
      const extreme = long ? Math.min(trend.extreme ?? Infinity, current.l) : Math.max(trend.extreme ?? -Infinity, current.h);
      if (trend.extreme != null && confirmation) {
        return { trend: null, signal: makeSignal("continuation", trend.dir, current, extreme, 2) };
      }
      return { trend: touch || trend.extreme != null ? { ...trend, extreme } : trend, signal: null };
    }
  }
  if (!previous || !adxRising) return { trend, signal: null };
  if (previous.c <= range.high && current.c > range.high && current.c > current.vwap) trend = { dir: "long", extreme: null };
  if (previous.c >= range.low && current.c < range.low && current.c < current.vwap) trend = { dir: "short", extreme: null };
  return { trend, signal: null };
}

function reversal(current, prior, dir, extreme) {
  if (!dir || !(current.atr > 0)) return { extreme, signal: null };
  const long = dir === "long", level = long ? prior.l : prior.h;
  const end = long ? current.l : current.h;
  const breach = long ? end <= level - PAD * current.atr : end >= level + PAD * current.atr;
  if (breach || extreme != null) extreme = long ? Math.min(extreme ?? Infinity, end) : Math.max(extreme ?? -Infinity, end);
  const reclaimed = long ? current.c > level : current.c < level;
  if (extreme == null || !reclaimed) return { extreme, signal: null };
  if (current.adx == null || current.adx >= 18 || current.vwap == null) return { extreme: null, signal: null };
  return { extreme: null, signal: makeSignal("80-20-reclaim", dir, current, extreme, 1.5, current.vwap) };
}

function evaluate(minuteBars, { day, asOf, closeMinute = CLOSE, prior = null, warmup = [], includeFvg = false }) {
  const today = foldFiveMinute(minuteBars, { day, asOf, closeMinute });
  const past = warmup.filter((bar) => bar && bar.d < day && bar.m >= OPEN && bar.m < CLOSE &&
    (bar.m - OPEN) % FIVE === 0 && validMinuteBar(bar) && (bar.t + FIVE * 60) * 1000 <= asOf);
  const warmed = [...new Map(past.map((bar) => [bar.t, bar])).values()].sort((a, b) => a.t - b.t);
  const opening = today.slice(0, 3);
  const openingRange = opening.length === 3 && opening.every((bar, i) => bar.m === OPEN + i * FIVE)
    ? { high: Math.max(...opening.map((bar) => bar.h)), low: Math.min(...opening.map((bar) => bar.l)) } : null;
  const frames = indicators([...warmed, ...today]);
  const recent = frames.slice(warmed.length);
  const bias = prior && (!prior.d || prior.d < day) ? priorBias(prior) : null;
  let volume = 0, pv = 0, complete = true, trend = null, extreme = null, signals = [];
  for (let i = 0; i < recent.length; i++) {
    const bar = recent[i], previous = recent[i - 1];
    complete = complete && bar.m === OPEN + i * FIVE && (!previous || bar.t === previous.t + FIVE * 60);
    volume += bar.v;
    pv += bar.pv;
    bar.vwap = complete && volume > 0 ? pv / volume : null;
    const next = continuation(previous, bar, openingRange, trend, risingAdx(frames, warmed.length + i));
    const fade = reversal(bar, prior, bias, extreme);
    trend = next.trend;
    extreme = fade.extreme;
    signals = [next.signal, fade.signal].filter(Boolean);
  }
  const last = recent.at(-1);
  const fvg = gapDirection(recent.slice(-3));
  return {
    signals,
    variants: includeFvg ? signals.filter((signal) => signal.dir === fvg).map((signal) => ({ ...signal, variant: "fvg" })) : [],
    diagnostics: { day, closedFiveMinuteBars: recent.length, warmupBars: warmed.length, openingRange, priorBias: bias,
      latest: last ? { t: last.t, m: last.m, adx: last.adx, atr: last.atr, ema20: last.ema, vwap: last.vwap } : null,
      vwapComplete: !!last && complete && volume > 0, continuationState: trend?.dir || null, sweptExtreme: extreme, fvg },
  };
}

module.exports = { evaluate, foldFiveMinute, indicators, bracketAtFill };

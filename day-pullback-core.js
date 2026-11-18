"use strict";

const DTC = require("./daytrade-core.js");

const PULLBACK = Object.freeze({
  universe: Object.freeze(["SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLI", "SMH", "XBI"]),
  holdMinutes: 10,
  costPerSide: 0.0005,
  shortBorrow: 0.0001,
  minGrossCostX: 2,
  extensionAtr: 1.5,
});
const ETF_UNIVERSE = new Set(PULLBACK.universe);

function targetRoom(dir, entry, target, costPerSide, shortBorrow, minGrossCostX) {
  if (![entry, target].every((value) => Number.isFinite(value) && value > 0) ||
      ![costPerSide, shortBorrow].every((value) => Number.isFinite(value) && value >= 0) ||
      !Number.isFinite(minGrossCostX) || minGrossCostX < 1) return null;
  const gross = dir === "long" ? target - entry : entry - target;
  const cost = (entry + target) * costPerSide + (dir === "short" ? entry * shortBorrow : 0);
  if (!(gross > 0) || gross < minGrossCostX * cost) return null;
  return { grossTargetBps: gross / entry * 10_000, netTargetBps: (gross - cost) / entry * 10_000, costBps: cost / entry * 10_000 };
}

function findPullback(symbol, bars, {
  day, now, close = DTC.CLOSE, maxLagSec = 90, costPerSide = PULLBACK.costPerSide,
  shortBorrow = PULLBACK.shortBorrow, minGrossCostX = PULLBACK.minGrossCostX,
} = {}) {
  if (!ETF_UNIVERSE.has(symbol) || !Array.isArray(bars) || typeof day !== "string" || !Number.isFinite(now)) return null;
  const regular = bars.filter((bar) => bar.d === day && bar.m >= DTC.OPEN && bar.m < close && (bar.t + 60) * 1000 <= now);
  // The reference uses all sealed bars since the bell. A missing minute invalidates that VWAP.
  if (regular.length < 17 || regular[0].m !== DTC.OPEN ||
      !regular.every((bar, i) => DTC.validMinuteBar(bar) && Number.isFinite(bar.v) && bar.v >= 0 &&
        (!i || (bar.t === regular[i - 1].t + 60 && bar.m === regular[i - 1].m + 1)))) return null;
  const confirm = regular.at(-1), sweep = regular.at(-2), history = regular.slice(0, -2);
  if (!DTC.paperBarReady(confirm, now, maxLagSec) || !(confirm.v > 0 && sweep.v > 0)) return null;
  const target = DTC.vwap(history), atr = DTC.atr(history);
  if (!(target > 0 && atr > 0)) return null;
  const shelf = history.slice(-5);
  const low = Math.min(...shelf.map((bar) => bar.l)), high = Math.max(...shelf.map((bar) => bar.h));
  const range = sweep.h - sweep.l, mid = (sweep.h + sweep.l) / 2;
  const extension = atr * PULLBACK.extensionAtr, pad = Math.max(atr * 0.1, confirm.c * 0.0001);
  const long = sweep.l <= target - extension && sweep.l < low && sweep.c >= mid && sweep.c <= low &&
    confirm.l >= sweep.l && confirm.c > low && confirm.c > confirm.o;
  const short = sweep.h >= target + extension && sweep.h > high && sweep.c <= mid && sweep.c >= high &&
    confirm.h <= sweep.h && confirm.c < high && confirm.c < confirm.o;
  if (!(range > 0) || (!long && !short)) return null;

  const dir = long ? "long" : "short", side = long ? 1 : -1;
  const entry = confirm.c, stop = long ? sweep.l - pad : sweep.h + pad;
  const stopDistance = side * (entry - stop), targetDistance = side * (target - entry);
  const room = targetRoom(dir, entry, target, costPerSide, shortBorrow, minGrossCostX);
  if (!(stop > 0 && stopDistance > 0) || !room) return null;
  return {
    dir, side, kind: "vwap-reclaim", entry, stop, target, stopDistance, targetDistance,
    ...room, signalAt: confirm.t, costPerSide, shortBorrow, minGrossCostX,
    why: "Confirmed a sweep and reclaim toward the pre-sweep session VWAP",
  };
}

function openPullback(order, bar, { now, maxLagSec = 90 } = {}) {
  if (!Number.isFinite(now) || !bar || !DTC.paperBarReady(bar, now, maxLagSec) || order?.idea?.kind !== "vwap-reclaim") return null;
  const fill = DTC.paperOpen(order, bar);
  if (!fill) return null;
  const { dir, stop, target, costPerSide, shortBorrow, minGrossCostX } = order.idea;
  const side = dir === "long" ? 1 : -1;
  if (!Number.isFinite(stop) || stop <= 0 || side * (fill.entry - stop) <= 0 ||
      !targetRoom(dir, fill.entry, target, costPerSide, shortBorrow, minGrossCostX)) return null;
  return { ...fill, stop, target };
}

module.exports = { PULLBACK, findPullback, openPullback };

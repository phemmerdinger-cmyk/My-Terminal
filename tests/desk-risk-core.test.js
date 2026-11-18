"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { updateMark, status, exposure, entrySize, betaFromCloses, dayPilotSize } = require("../desk-risk-core.js");
const D = "2026-11-18", P = "2026-11-17";
const mark = (nav, at, day = D, close = false) => ({ day, previousDay: P, nav, at, close });
const gate = (s, day = D) => status(s, { day, fresh: true, shock: false });

test("daily brake, latched session pause and restart-safe peak lock", () => {
  let s = updateMark(null, mark(90_000, 1));
  s = updateMark(s, mark(89_600, 2));
  assert.equal(gate(s).multiplier, 0.5);
  s = updateMark(s, mark(89_350, 3));
  assert.equal(gate(s).mode, "paused");
  s = updateMark(s, mark(89_900, 4));
  assert.equal(gate(s).mode, "paused");
  s = updateMark(s, mark(89_000, 5));
  s = JSON.parse(JSON.stringify(updateMark(s, { ...mark(89_900, 6, "2026-11-19"), previousDay: D })));
  assert.equal(gate(s, "2026-11-19").mode, "locked");
  assert.equal(s.peakLockAt, 5);
});

test("prior close anchors daily loss and a stale observation cannot change the anchor", () => {
  let s = updateMark(null, mark(90_100, 10, P, true));
  s = updateMark(s, mark(89_600, 20));
  assert.equal(s.reference, 90_100);
  assert.equal(s.dailyLoss, 500);
  assert.equal(s.referenceType, "prior session close");
  assert.equal(updateMark(s, mark(100_000, 19)), s);
  assert.equal(status(s, { day: D, fresh: false }).multiplier, 0);
});

test("paper position size includes shared exposure and half-size brake", () => {
  const state = updateMark(updateMark(null, mark(90_000, 1)), mark(89_600, 2));
  const leg = { bot: "day", sign: 1, beta: 1, shares: 1, price: 100, riskPerShare: 2 };
  const config = { state, gate: gate(state), current: exposure([]), legs: [leg], units: 100, dayEquity: 30_000, bot: "day" };
  assert.equal(entrySize(config).units, 15);
  assert.equal(entrySize({ ...config, current: exposure([{ ...leg, shares: 300 }]) }).units, 0);
  assert.equal(exposure([{ ...leg, beta: null }]), null);
});

test("market beta uses aligned daily price changes", () => {
  const m = new Map(), s = new Map(); let p = 100, q = 100;
  for (let i = 0; i < 62; i++) {
    const r = (i % 2 ? 0.014 : -0.010) + i / 100000;
    p *= Math.exp(r); q *= Math.exp(r * 2);
    const key = String(i).padStart(3, "0"); m.set(key, p); s.set(key, q);
  }
  assert.ok(Math.abs(betaFromCloses(s, m) - 2) < 1e-9);
  assert.equal(betaFromCloses(new Map(), m), null);
});

test("separate reversal allocation admits limited paper size alongside legacy book exposure", () => {
  const state = updateMark(updateMark(null, mark(90_000, 1)), mark(89_800, 2));
  const swing = { bot: "swing", sign: 1, beta: 1, shares: 420, price: 100, riskPerShare: 9 };
  const lot = { ...swing, bot: "day", shares: 1, riskPerShare: 3 };
  const input = { state, gate: gate(state), current: exposure([swing]), lot, units: 100, sessionRoom: 60 };
  assert.equal(entrySize({ ...input, legs: [lot], bot: "day", dayEquity: 30_000 }).units, 0);
  assert.equal(dayPilotSize(input), 5);
  assert.equal(dayPilotSize({ ...input, sessionRoom: 6 }), 2);
  assert.equal(dayPilotSize({ ...input, current: exposure([swing, { ...lot, shares: 9 }]) }), 1);
  assert.equal(dayPilotSize({ ...input, lot: { ...lot, beta: 3, price: 600, riskPerShare: 1 } }), 3_000 / 1_800);
  assert.equal(dayPilotSize({ ...input, lot: { ...lot, bot: "swing" } }), 0);
  assert.equal(dayPilotSize({ ...input, gate: gate({ ...state, dailyLoss: 400 }) }), 2.5);
  assert.equal(dayPilotSize({ ...input, gate: gate({ ...state, dailyStopDay: D }) }), 0);
  assert.equal(dayPilotSize({ ...input, gate: gate({ ...state, peakLockAt: 3 }) }), 0);
});

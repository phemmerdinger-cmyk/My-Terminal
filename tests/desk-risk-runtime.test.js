"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createDeskRisk } = require("../desk-risk.js");

test("one book limits another, and an acknowledged peak lock survives a process restart", async () => {
  let time = 600_000, combined = 90_000, saved = null, stale = false;
  const day = "2026-11-18", stamp = () => ({ day, open: true, trading: true, min: 610, close: 960 });
  const store = { durable: true, get: async () => saved, set: async (_key, value) => { saved = structuredClone(value); } };
  const def = {
    store, now: () => time, clock: stamp, sessionOf: stamp, previousDay: () => "2026-11-17", loadBooks: async () => {},
    books: () => ["day", "swing", "quant"].map((bot) => ({ bot, cash: combined / 3, lots: [] })),
    quotes: async (symbols) => Object.fromEntries(symbols.map((sym) => [sym, { price: sym === "^VIX" ? 20 : 100,
      marketTime: stale ? time - 200_000 : time, changePct: 0 }])),
    closes: async () => new Map(Array.from({ length: 62 }, (_, i) => [String(i).padStart(3, "0"), 100 + i + i % 2])),
  };
  const r = createDeskRisk(def);
  await r.prepare(["SPY"]);
  const entry = { bot: "day", sym: "SPY", sign: 1, shares: 100, price: 50, riskPerShare: 1, integer: true };
  assert.equal(r.reserve(entry).shares, 60);
  for (let i = 0; i < 4; i++) r.reserve(entry);
  assert.equal(r.reserve({ ...entry, bot: "quant" }).shares, 50);
  assert.equal(r.reserve({ ...entry, bot: "swing" }).shares, 0);
  time += 60_000; stale = true;
  await r.refresh();
  assert.equal(r.reserve(entry).shares, 0);
  stale = false; combined = 88_950; time += 60_000;
  await r.refresh();
  assert.equal(r.view().mode, "locked");
  const restart = createDeskRisk(def);
  combined = 89_000; time += 60_000;
  await restart.prepare(["SPY"]);
  assert.equal(restart.view().mode, "locked");
  assert.equal(await restart.review(), false);
});

test("reversal reservations share the intraday allocation and still observe the desk daily stop", async () => {
  const day = "2026-11-18", stamp = () => ({ day, open: true, trading: true, min: 610, close: 960 });
  let time = 600_000, swingCash = -12_000;
  const risk = createDeskRisk({
    store: { durable: false, get: async () => null, set: async () => {} },
    clock: stamp, sessionOf: stamp, now: () => time, previousDay: () => "2026-11-17", loadBooks: async () => {},
    books: () => [{ bot: "swing", cash: swingCash, lots: [{ sym: "SPY", sign: 1, shares: 420, risk: () => 9 }] },
      { bot: "day", cash: 30_000, lots: [] }, { bot: "quant", cash: 30_000, lots: [] }],
    quotes: async (symbols) => Object.fromEntries(symbols.map((sym) => [sym, { price: sym === "^VIX" ? 20 : 100, marketTime: time, changePct: 0 }])),
    closes: async () => new Map(),
  });
  await risk.prepare(["SPY"]);
  const order = { bot: "day", sym: "SPY", sign: 1, shares: 50, price: 100, riskPerShare: 3, integer: true };
  assert.equal(risk.reserve(order).shares, 0);
  const first = risk.reserve({ ...order, pilotRoom: 60 });
  const second = risk.reserve({ ...order, pilotRoom: 45 });
  assert.equal(first.pilot, true);
  assert.equal(first.shares, 5);
  assert.equal(second.shares, 5);
  assert.equal(risk.reserve({ ...order, pilotRoom: 30 }).shares, 0);
  first.release();
  second.release();
  swingCash -= 650;
  time += 60_000;
  await risk.refresh();
  assert.equal(risk.view().mode, "paused");
  assert.equal(risk.reserve({ ...order, pilotRoom: 60 }).shares, 0);
});

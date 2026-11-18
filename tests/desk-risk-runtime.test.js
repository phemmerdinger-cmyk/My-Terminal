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

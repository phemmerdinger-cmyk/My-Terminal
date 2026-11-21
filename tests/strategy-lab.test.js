"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createStrategyLab, quarterlyComparison } = require("../strategy-lab.js");
const { freshPairShadows } = require("../quant-pairs-runner.js");
const { freshSwingShadows } = require("../swing-shadow-runner.js");

test("earnings variant uses only quarterly SEC filings from before the signal date", () => {
  const prior = { start: "2025-07-01", end: "2025-09-30", filed: "2025-10-20", form: "10-Q", val: 1 };
  const latest = { start: "2026-07-01", end: "2026-09-30", filed: "2026-11-04", form: "10-Q", val: 1.4 };
  const releaseDay = { ...latest, filed: "2026-11-18", val: 99 };
  const facts = { "us-gaap": {
    EarningsPerShareDiluted: { units: { "USD/shares": [prior, latest, releaseDay] } },
    Revenues: { units: { USD: [prior, latest, releaseDay].map((r) => ({ ...r, val: r.val * 100 })) } },
  } };
  const comparison = quarterlyComparison(facts, "2026-11-18", 1000);
  assert.equal(comparison.eps, 1.4);
  assert.equal(comparison.priorYearSales, 100);
  assert.equal(quarterlyComparison(facts, "2026-11-03", 1000), null);
});

test("lab opens a queued pair only with both observed opens and carries the Treasury benchmark separately", async () => {
  const day = "2026-11-18", opening = Date.parse(day + "T14:30:00Z"), observed = opening + 65_000;
  const pairs = freshPairShadows();
  const requested = new Set();
  const orders = [{ symbol: "SPY", side: "BUY" }, { symbol: "IVV", side: "SELL" }]
    .map((order) => ({ ...order, shares: 1, priceBps: 5, feeBps: 0 }));
  pairs.pending.push({ ok: true, action: "enter", signalTime: opening - 16 * 3_600_000, executeDay: day,
    pairId: "SPY/IVV", model: {}, orders, shortSymbol: "IVV", maxBorrowBps: 100, riskDollars: 60 });
  let state = { since: opening - 86_400_000, swing: freshSwingShadows(opening), pairs, records: [], borrow: {} };
  let both = false;
  const lab = createStrategyLab({
    store: { get: async () => state, set: async (_, next) => { state = next; } },
    clock: () => ({ day, min: 571, trading: true, close: 960 }), now: () => observed,
    bars: async (symbol) => {
      requested.add(symbol);
      return symbol === "SPY" || both ? [{ d: day, t: opening / 1000, o: 100 }] : [];
    },
    rates: async () => "observation_date,DGS3MO\n2026-11-17,4.25\n2026-11-18,8",
  });
  const quote = { symbol: "IVV", marketTime: opening - 1000, annualBps: 90, source: "Test broker", available: true };
  await assert.rejects(lab.saveBorrow([{ ...quote, marketTime: day + "T09:29:00" }]), /Invalid borrow quote/);
  assert.equal((await lab.saveBorrow([quote])).accepted, 1);
  await lab.tick();
  assert.deepEqual([...requested].sort(), ["IVV", "SPY"]);
  assert.equal(state.pairs.trades.length, 0);
  both = true;
  await lab.tick();
  const view = await lab.view();
  assert.equal(state.pairs.trades[0].fills.length, 2);
  assert.equal(view.experiments.find((e) => e.bot === "quant").value, 29_999.9);
  assert.equal(view.experiments.find((e) => e.bot === "swing").cash, 30_000);
  assert.equal(view.riskFree.ratePct, 4.25);
  assert.equal(view.riskFree.cashReturn, null);
  assert.deepEqual(view.errors, []);
});

test("lab falls back to the Treasury's 3-month par yield when FRED is unreachable", async () => {
  const lab = createStrategyLab({
    store: { get: async () => null }, clock: () => ({ day: "2026-11-18" }),
    rates: async () => { throw new Error("Timeout"); },
    treasuryRates: async () => '"Date","2 Mo","3 Mo","4 Mo"\n"11/18/2026","5","6","7"\n"11/17/2026","3","4.33","5"\n"11/16/2026","3","N/A","5"',
  });
  const { riskFree, errors } = await lab.view();
  assert.equal(riskFree.day, "2026-11-17");
  assert.equal(riskFree.ratePct, 4.33);
  assert.match(riskFree.source, /U.S. Treasury/);
  assert.deepEqual(errors, []);
});

test("lab fills the extra bots' queued orders at the verified open and lists them as experiments", async () => {
  const Extra = require("../extra-bots-runner.js");
  const day = "2026-11-18", opening = Date.parse(day + "T14:30:00Z"), observed = opening + 65_000;
  const extra = Extra.freshExtraBots(opening);
  extra.books.insider.pending.push({ side: "BUY", symbol: "ACME", openDay: day, signalDay: "2026-11-17", signalAt: opening - 16 * 3_600_000, reason: "2 insiders bought", slots: 6 });
  let state = { since: opening - 86_400_000, swing: freshSwingShadows(opening), pairs: freshPairShadows(), extra, records: [], borrow: {} };
  const lab = createStrategyLab({
    store: { get: async () => state, set: async (_, next) => { state = next; } },
    clock: () => ({ day, min: 571, trading: true, close: 960 }), now: () => observed,
    bars: async (symbol) => (symbol === "ACME" ? [{ d: day, t: opening / 1000, o: 50 }] : []),
    rates: async () => "observation_date,DGS3MO\n2026-11-17,4.25",
  });
  await lab.tick();
  const pos = state.extra.books.insider.positions.ACME;
  assert.ok(pos && pos.shares === Math.floor(5000 / pos.entry));
  const view = await lab.view();
  const row = view.experiments.find((e) => e.id === "extra-insider");
  assert.equal(row.positions, 1);
  assert.deepEqual(view.experiments.map((e) => e.id).filter((id) => id.startsWith("extra-")), ["extra-pullback", "extra-rotation", "extra-earnings", "extra-insider"]);
});

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDgs3moCsv, rateBefore, cashBenchmark } = require("../risk-free-core.js");

test("FRED observations parse without inventing missing rates", () => {
  const rows = parseDgs3moCsv("observation_date,DGS3MO\n2026-11-19,4.2\n2026-11-16,.\n2026-11-17,4.34\n2026-11-18,\n");
  assert.deepEqual(rows, [{ day: "2026-11-17", ratePct: 4.34 }, { day: "2026-11-19", ratePct: 4.2 }]);
  assert.equal(rateBefore(rows, "2026-11-19").ratePct, 4.34);
  assert.equal(rateBefore(rows, "2026-11-17"), null);
  assert.equal(rateBefore(rows, "2026-12-19"), null);
  assert.throws(() => parseDgs3moCsv("<html>unavailable</html>"), /headers/);
});

test("cash benchmark compounds across a weekend using the prior session's known rate", () => {
  const rows = [{ day: "2026-11-19", ratePct: 4 }, { day: "2026-11-20", ratePct: 5 }];
  const cash = cashBenchmark({ sessions: ["2026-11-20", "2026-11-23"], observations: rows, initial: 30_000 });
  assert.equal(cash.points[1].value, 30_000 * 1.04 ** (3 / 365));
  assert.equal(cash.points[1].rate.ratePct, 5);
  assert.equal(cashBenchmark({ sessions: ["2026-11-20", "2026-12-02"], observations: rows }).points[1].value, null);
});

test("recorded rates freeze the original comparison against later feed revisions", () => {
  const sessions = ["2026-11-20", "2026-11-23"];
  const observations = [{ day: "2026-11-19", ratePct: 9 }];
  const fixed = { day: "2026-11-19", ratePct: 4, ageDays: 1 };
  const cash = cashBenchmark({ sessions, observations, recordedRates: { "2026-11-20": fixed } });
  assert.equal(cash.points[1].value, 1.04 ** (3 / 365));
  assert.equal(cashBenchmark({ sessions, observations, recordedRates: { "2026-11-20": null } }).points[1].value, null);
});

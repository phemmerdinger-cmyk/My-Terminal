const test = require("node:test");
const assert = require("node:assert/strict");
const { usableQuote, paperFill, completedCloses } = require("../paper-execution-core.js");

test("paper execution requires a fresh quote strictly after the decision", () => {
  const decision = 1_000_000, now = decision + 60_000;
  assert.equal(usableQuote({ price: 100, marketTime: decision }, now, decision), false);
  assert.equal(usableQuote({ price: 100, marketTime: decision + 1 }, now, decision), true);
  assert.equal(usableQuote({ price: 100, marketTime: now + 1 }, now, decision), false);
  assert.equal(usableQuote({ price: 100, marketTime: now - 180_001 }, now), false);
  assert.equal(usableQuote({ price: 0, marketTime: now }, now), false);
});

test("both sides incur adverse execution costs", () => {
  assert.equal(paperFill("BUY", 100, 0.00075).toFixed(3), "100.075");
  assert.equal(paperFill("SELL", 100, 0.00075).toFixed(3), "99.925");
});

test("swing daily features discard current and future sessions", () => {
  const bars = [{ time: 1, close: 100 }, { time: 2, close: 200 }, { time: 3, close: 300 }];
  assert.deepEqual(completedCloses(bars, "2026-11-17", (t) => `2026-11-${15 + t}`), [100]);
});

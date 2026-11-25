"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../doctor-core.js");

const T = (h, m = 0) => Date.UTC(2026, 10, 25, h + 5, m); // ET → UTC
const rs = { start: T(9, 30), end: T(16) };

test("phase follows New York trading hours", () => {
  assert.equal(D.phase({ wd: "Wed", min: 6 * 60 }), "pre");
  assert.equal(D.phase({ wd: "Wed", min: 10 * 60 }), "regular");
  assert.equal(D.phase({ wd: "Wed", min: 17 * 60 }), "after");
  assert.equal(D.phase({ wd: "Sun", min: 10 * 60 }), "closed");
});

test("catches this morning's pre-market baseline bug, and passes the fixed math", () => {
  const now = T(8, 40);
  const wrong = { price: 155.38, marketTime: T(-8), regularSession: rs, preMarket: { price: 147.1, changePct: -10.88, marketTime: T(8, 35) } };
  const bug = D.checkQuote("NVDA", wrong, { now, phase: "pre" });
  assert.equal(bug[0].key, "premarket-baseline"); assert.equal(bug[0].fix, "code"); assert.equal(bug[0].evidence.expected, -5.33);
  const right = { ...wrong, preMarket: { ...wrong.preMarket, changePct: -5.329 } };
  assert.deepEqual(D.checkQuote("NVDA", right, { now, phase: "pre" }), []);
});

test("stale quotes in session heal by clearing the cache", () => {
  const x = D.checkQuote("SPY", { price: 700, marketTime: T(10), regularSession: rs }, { now: T(10, 30), phase: "regular" });
  assert.equal(x[0].key, "quote-stale:SPY"); assert.deepEqual(D.healFor(x[0]), { action: "clear-quote", sym: "SPY" });
});

test("catches a 1D chart that covers only 4 hours, is out of order, or lacks extended bars", () => {
  const now = T(8, 45);
  const short = { extended: true, candles: [{ time: T(4) / 1000, ext: "pre" }, { time: T(8, 44) / 1000, ext: "pre" }] };
  assert.ok(D.checkChart("SPY", short, { now, phase: "pre" }).some((x) => x.key === "chart-24h"));
  const back = { extended: true, candles: [{ time: T(-14) / 1000 }, { time: T(-15) / 1000 }, { time: T(8, 44) / 1000, ext: "pre" }] };
  assert.ok(D.checkChart("SPY", back, { now, phase: "pre" }).some((x) => x.key === "chart-order"));
  const unmarked = { extended: true, candles: [{ time: T(-14) / 1000 }, { time: T(8, 44) / 1000 }] };
  const u = D.checkChart("SPY", unmarked, { now, phase: "pre" }).map((x) => x.key);
  assert.ok(u.includes("chart-ext-mark") && u.includes("chart-no-ext"));
  const good = { extended: true, candles: [{ time: T(-14) / 1000 }, { time: T(-8) / 1000, ext: "post" }, { time: T(8, 44) / 1000, ext: "pre" }] };
  assert.deepEqual(D.checkChart("SPY", good, { now, phase: "pre" }), []);
});

test("stalled bots restart; repeated bot errors and server 5xx need code", () => {
  const now = T(11);
  const b = D.checkBots({ swingTick: T(10, 40), dayTick: T(10, 59), errors: { swing: Array(5).fill({ t: T(10, 50), e: "boom" }) } }, { now, phase: "regular", awake: true });
  assert.deepEqual(b.map((x) => x.key), ["bot-swing-stalled", "bot-errors:swing"]);
  assert.deepEqual(D.healFor(b[0]), { action: "restart-swing" }); assert.equal(D.healFor(b[1]), null);
  const s = D.checkServer([1, 2, 3].map(() => ({ t: T(10, 55), path: "/api/history", status: 502, msg: "no data" })), { now });
  assert.equal(s[0].key, "server-5xx:/api/history"); assert.equal(s[0].fix, "code");
  assert.deepEqual(D.checkServer([{ t: T(10, 55), path: "/api/x", status: 500 }], { now }), []);
});

test("browser errors group by message; issues have stable titles", () => {
  const c = D.checkClient([{ t: T(10), kind: "js", msg: "x is not defined", page: "desk#data" }, { t: T(10, 1), kind: "js", msg: "x is not defined", page: "desk#data" }], { now: T(10, 5) });
  assert.equal(c.length, 1); assert.match(c[0].text, /×2/);
  const i = D.issueFor({ ...c[0], first: T(10) });
  assert.ok(i.title.startsWith(`[doctor] ${c[0].key}:`)); assert.deepEqual(i.labels, ["doctor"]); assert.match(i.body, /npm test/);
  assert.deepEqual(D.checkAi({ on: true, lastError: "503" }).map((x) => D.healFor(x).action), ["repick-ai-model"]);
});

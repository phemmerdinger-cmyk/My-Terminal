"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { summarize, botRace, leadText } = require("../public/bots-verdict-core.js");

const T0 = Date.parse("2026-11-17T20:19:00Z");
const bot = (value, spx0, spxNow, days = 6, firstTrade = T0) => ({
  value, startValue: 30000, spx0, spxNow, firstTrade,
  equity: Array.from({ length: days }, (_, i) => ({ d: "2026-11-1" + i, v: value })),
});

test("each bot is compared with the S&P over its own dates", () => {
  const r = botRace("Swing bot", bot(29649.3, 6000, 5906.4));
  assert.ok(Math.abs(r.ret - -0.011690) < 1e-5);
  assert.ok(Math.abs(r.spx - -0.0156) < 1e-9);
  assert.ok(r.gap > 0);
  assert.equal(r.since, "Nov 17");
});

test("headline says down-but-ahead plainly and flags a short record", () => {
  const v = summarize([
    ["Swing bot", bot(29649.3, 6000, 5906.4)],
    ["Day trader", bot(29975.67, 6000, 5905.2)],
    ["Quant trader", bot(29635.07, 6000, 5870.4)],
  ]);
  assert.equal(v.headline, "All 3 accounts are down since they started; all are ahead of the S&P 500 over the same dates.");
  assert.equal(v.early, true);
  assert.match(v.note, /Too early to call: the longest-running bot has 6 trading days/);
  assert.match(v.lines[0], /^Swing bot: −1\.17% vs\. S&P −1\.56% since Nov 17 → 0\.39 pts ahead$/);
});

test("mixed results and a bot that hasn't started", () => {
  const v = summarize([
    ["Swing bot", bot(30600, 6000, 6060, 25)],
    ["Day trader", bot(29700, 6000, 6060, 25)],
    ["Quant trader", { value: 30000, startValue: 30000 }],
  ]);
  assert.equal(v.headline, "1 of 2 is up since they started; 1 of 2 is ahead of the S&P 500 over the same dates.");
  assert.equal(v.early, false);
  assert.equal(v.lines[2], "Quant trader: hasn't made its first trade yet.");
});

test("nothing started yet", () => {
  const v = summarize([["Swing bot", { value: 30000, startValue: 30000 }]]);
  assert.match(v.headline, /hasn't started yet/);
});

test("missing benchmark data is never estimated", () => {
  const r = botRace("Swing bot", { value: 29000, startValue: 30000, firstTrade: T0 });
  assert.equal(r.spx, null);
  assert.equal(r.gap, null);
});

test("lead text never calls a losing bot a winner", () => {
  assert.equal(leadText(-0.0117, 118, "Swing bot"), "Swing bot is down, but less than the S&P");
  assert.equal(leadText(0.02, 300, "Swing bot"), "Swing bot is beating the S&P");
  assert.equal(leadText(0.01, -50, "Day trader"), "Day trader is up, but trailing the S&P");
  assert.equal(leadText(-0.03, -200, "Day trader"), "Day trader is behind the S&P");
  assert.equal(leadText(-0.003, -246, "You"), "You are behind the S&P");
});

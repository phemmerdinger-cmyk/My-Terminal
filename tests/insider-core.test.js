const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../insider-core.js");

const NOW = Date.parse("2026-11-24T20:00:00Z");
const tx = (date, code, shares, price, extra = {}) => ({ date, code, shares, price, value: +(shares * price).toFixed(2), plan10b51: false, ...extra });
const filing = (owner, txs, extra = {}) => ({ owner, role: "Director", officer: false, url: "https://www.sec.gov/x", filed: "2026-11-20", tx: txs, ...extra });

test("only open-market buys and sales count; grants, exercises and tax withholding don't", () => {
  const S = I.summarize([filing("A", [tx("2026-11-10", "P", 1000, 50), tx("2026-11-10", "A", 5000, 0), tx("2026-11-10", "M", 2000, 20), tx("2026-11-10", "F", 800, 50)])], { now: NOW });
  assert.equal(S.buys.length, 1);
  assert.equal(S.buyValue, 50000);
  assert.equal(S.other, 3);
});

test("10b5-1 plan trades are left out of buys and sells, and counted", () => {
  const S = I.summarize([filing("A", [tx("2026-11-10", "S", 1000, 50, { plan10b51: true }), tx("2026-11-11", "P", 10, 50, { plan10b51: true }), tx("2026-11-12", "S", 100, 50)])], { now: NOW });
  assert.equal(S.sells.length, 1);
  assert.equal(S.buys.length, 0);
  assert.equal(S.planSells + S.planBuys, 2);
  assert.match(S.notes.join(" "), /10b5-1/);
});

test("an amended filing (4/A) repeating the same trade counts once", () => {
  const t = tx("2026-11-10", "P", 1000, 50);
  const S = I.summarize([filing("Jane Doe", [t]), filing("JANE DOE", [{ ...t }])], { now: NOW });
  assert.equal(S.buys.length, 1);
  assert.equal(S.dupes, 1);
  assert.equal(S.buyers.length, 1);
});

test("two different insiders buying make a two-buyer cluster", () => {
  const S = I.summarize([filing("A", [tx("2026-11-10", "P", 1000, 50)]), filing("B", [tx("2026-11-12", "P", 500, 51)])], { now: NOW });
  assert.deepEqual(S.buyers.sort(), ["A", "B"]);
});

test("an implausible price is flagged: shares kept, dollars left out of totals", () => {
  const S = I.summarize([filing("A", [tx("2026-11-10", "P", 1000, 50), tx("2026-11-11", "P", 1000, 52), tx("2026-11-12", "P", 1000, 51000)])], { now: NOW });
  assert.equal(S.suspect, 1);
  assert.equal(S.buyValue, 50000 + 52000);
  assert.equal(S.buyShares, 3000);
  assert.match(S.notes.join(" "), /implausible price/);
});

test("the window is on the trade date; older trades are out", () => {
  const S = I.summarize([filing("A", [tx("2026-07-01", "P", 1000, 50), tx("2026-11-01", "P", 10, 50)])], { now: NOW, days: 90 });
  assert.equal(S.buys.length, 1);
});

test("a scan that didn't reach the window start says so", () => {
  const S = I.summarize([filing("A", [tx("2026-11-10", "P", 1000, 50)])], { now: NOW, complete: false });
  assert.equal(S.complete, false);
  assert.match(S.notes[0], /incomplete/);
});

test("pickFilings reads every Form 4 back to the window, and reports a capped scan as partial", () => {
  const day = (d) => new Date(NOW - d * 864e5).toISOString().slice(0, 10);
  const recent = { form: ["4", "8-K", "4/A", "4", "10-Q", "4"], filingDate: [day(1), day(5), day(20), day(80), day(100), day(200)] };
  const a = I.pickFilings(recent, { now: NOW, days: 90 });
  assert.deepEqual(a.picks, [0, 2, 3]);
  assert.equal(a.complete, true);
  const many = { form: Array(80).fill("4"), filingDate: Array.from({ length: 80 }, (_, i) => day(i)) };
  const b = I.pickFilings(many, { now: NOW, days: 90, cap: 60 });
  assert.equal(b.picks.length, 60);
  assert.equal(b.complete, false);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../market-data-core.js");

test("the gate limits concurrency, spaces calls and backs off after a 429", async () => {
  let t = 0; const slept = [];
  const g = M.createGate({ concurrency: 2, minGapMs: 100, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  let active = 0, peak = 0;
  const job = () => g.run(async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return 1; });
  await Promise.all([job(), job(), job(), job()]);
  assert.ok(peak <= 2, "never more than 2 at once");
  assert.ok(slept.every((ms) => ms > 0) && slept.length >= 3, "calls are spaced out");
  await assert.rejects(g.run(async () => { throw new Error("HTTP 429 for https://query1.finance.yahoo.com/x"); }));
  assert.ok(g.stats().coolingDownMs >= 2000, "a 429 starts a cool-down");
  assert.equal(g.stats().throttled, 1);
});

test("search rows carry the normalised schema and the old fields", () => {
  const rows = M.searchRows([{ symbol: "ES=F", quoteType: "FUTURE", shortname: "E-Mini S&P 500 Dec 26", exchDisp: "Chicago Mercantile Exchange", typeDisp: "Futures" },
    { symbol: "BTC-USD", quoteType: "CRYPTOCURRENCY", shortname: "Bitcoin USD", exchDisp: "CCC", typeDisp: "Cryptocurrency" }, { foo: 1 }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].assetClass, "future"); assert.equal(rows[0].badge, "FUTURE"); assert.equal(rows[0].typeDisp, "Futures"); assert.equal(rows[0].spec.root, "ES");
  assert.equal(rows[1].badge, "CRYPTO"); assert.equal(rows[1].displaySymbol, "BTC/USD");
});

test("Coinbase ticks and quotes (public feed, same ids as Yahoo)", () => {
  const now = Date.parse("2026-11-25T03:42:41Z");
  const tick = M.coinbaseTick({ type: "ticker", product_id: "BTC-USD", price: "59344.87", time: "2026-11-25T03:42:40.217Z", volume_24h: "13101.9", open_24h: "60257.27" }, now);
  assert.deepEqual([tick.sym, tick.p, tick.t], ["BTC-USD", 59344.87, Date.parse("2026-11-25T03:42:40.217Z")]);
  assert.equal(M.coinbaseTick({ type: "ticker", product_id: "BTC-USD", price: "1", time: "2026-11-25T03:50:00Z" }, now).t, now, "never stamped in the future");
  assert.equal(M.coinbaseTick({ type: "heartbeat" }), null);
  assert.equal(M.coinbaseTick({ type: "ticker", product_id: "X", price: "0", time: "x" }), null);
  const q = M.coinbaseQuote("BTC-USD", { price: "59344.87", time: "2026-11-25T03:42:40Z" }, { open: "60257.27", high: "60706.2", low: "58852.86", volume: "13080.3" }, now);
  assert.equal(q.provider, "coinbase"); assert.equal(q.changeBasis, "24h"); assert.ok(q.changePct < 0); assert.equal(q.volume, 13080.3);
  const products = M.coinbaseProducts([{ id: "BTC-USD", quote_increment: "0.01", status: "online" }, { id: "OLD-USD", status: "delisted" }]);
  assert.deepEqual(Object.keys(products), ["BTC-USD"]); assert.equal(products["BTC-USD"].quoteIncrement, 0.01);
});

test("Binance.US fallback (Binance.com refuses US addresses, so it isn't used)", () => {
  assert.equal(M.binanceUsSymbol("BTC-USD"), "BTCUSD"); assert.equal(M.binanceUsSymbol("AAPL"), null);
  const q = M.binanceUsQuote("BTC-USD", { lastPrice: "59378.36", openPrice: "60232.19", highPrice: "60702.33", lowPrice: "58877.87", volume: "115.79", closeTime: 1795578193284 }, 1795578200000);
  assert.equal(q.price, 59378.36); assert.equal(q.provider, "binance.us"); assert.ok(q.change < 0);
});

test("Frankfurter is labelled a daily reference rate, never a live price", () => {
  assert.equal(M.frankfurterUrl("USD", "EUR"), "https://api.frankfurter.dev/v2/rate/usd/eur");
  const q = M.frankfurterQuote("EUR=X", { date: "2026-11-25", base: "USD", quote: "EUR", rate: 0.91336 });
  assert.equal(q.price, 0.91336); assert.equal(q.reference, true); assert.match(q.note, /not a live market price/);
  assert.throws(() => M.frankfurterQuote("AAPL", {}));
});

test("FRED CSV gives the latest yield and skips missing days", () => {
  const csv = "observation_date,DGS10\n2026-11-20,4.31\n2026-11-21,.\n2026-11-24,4.28\n";
  assert.deepEqual(M.fredLatest(csv), { date: "2026-11-24", value: 4.28, prev: 4.31 });
  const q = M.fredQuote("^TNX", csv); assert.equal(q.provider, "fred"); assert.match(q.note, /DGS10/);
  assert.throws(() => M.fredLatest("observation_date,DGS10\n"));
});

test("options chains keep the provider's numbers and the 100-share multiplier", () => {
  const j = { optionChain: { result: [{ underlyingSymbol: "AAPL", expirationDates: [1767916800], quote: { regularMarketPrice: 190, currency: "USD" },
    options: [{ expirationDate: 1767916800, calls: [{ contractSymbol: "AAPL260109C00190000", strike: 190, lastPrice: 3.2, bid: 3.1, ask: 3.3, impliedVolatility: 0.24, openInterest: 1000, volume: 50, inTheMoney: false }], puts: [] }] }] } };
  const c = M.optionChain(j);
  assert.equal(c.underlying, "AAPL"); assert.equal(c.expiry, "2026-01-09"); assert.equal(c.calls[0].iv, 0.24); assert.equal(c.multiplier, 100);
  assert.throws(() => M.optionChain({}));
});

test("Yahoo session times become PRE / OPEN / AFTER windows", () => {
  const p = M.tradingPeriods({ currentTradingPeriod: { pre: { start: 1, end: 2 }, regular: { start: 2, end: 3 }, post: { start: 3, end: 4 } } });
  assert.deepEqual(p.regular, { start: 2000, end: 3000 });
  assert.equal(M.tradingPeriods({}), null);
});

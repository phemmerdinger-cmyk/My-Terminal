const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../public/instruments-core.js");

test("every asset class is recognised from the provider type or the symbol's shape", () => {
  const c = (s, t) => I.normalize({ symbol: s, quoteType: t }).assetClass;
  assert.equal(c("AAPL", "EQUITY"), "equity");
  assert.equal(c("7203.T", "EQUITY"), "equity");
  assert.equal(c("VOO", "ETF"), "etf");
  assert.equal(c("VFIAX", "MUTUALFUND"), "etf");
  assert.equal(c("ES=F"), "future");
  assert.equal(c("ESZ25.CME"), "future");
  assert.equal(c("EURUSD=X"), "forex");
  assert.equal(c("JPY=X"), "forex");
  assert.equal(c("BTC-USD"), "crypto");
  assert.equal(c("^GSPC"), "index");
  assert.equal(c("AAPL250117C00150000"), "option");
  assert.equal(c("BRK-B", "EQUITY"), "equity", "a class from the provider wins over the shape");
  assert.equal(c("BRK-B"), "equity", "BRK-B isn't a crypto pair");
});

test("the normalised schema has every field", () => {
  for (const s of ["AAPL", "ES=F", "EURUSD=X", "BTC-USD", "^TNX", "AAPL250117C00150000"]) {
    const x = I.normalize(s);
    for (const k of ["symbol", "displaySymbol", "name", "assetClass", "exchange", "currency", "tickSize", "marketHours", "provider"]) assert.ok(k in x, `${s} has ${k}`);
    assert.ok(I.CLASSES.includes(x.assetClass));
  }
});

test("display symbols read like a terminal", () => {
  assert.equal(I.normalize("EURUSD=X").displaySymbol, "EUR/USD");
  assert.equal(I.normalize("JPY=X").displaySymbol, "USD/JPY");
  assert.equal(I.normalize("BTC-USD").displaySymbol, "BTC/USD");
  assert.equal(I.normalize("^GSPC").displaySymbol, "SPX");
  assert.equal(I.normalize("ES=F").displaySymbol, "ES");
  assert.equal(I.normalize("AAPL250117C00150000").displaySymbol, "AAPL 2025-01-17 150 C");
  assert.equal(I.normalize("^TNX").subtype, "yield");
  assert.equal(I.normalize("EURUSD=X").tickSize, 0.00001, "no floating-point noise");
  assert.equal(I.normalize("JPY=X").tickSize, 0.001);
});

test("futures carry their contract specs; unknown roots don't invent any", () => {
  const es = I.normalize("ES=F");
  assert.equal(es.spec.tickSize, 0.25); assert.equal(es.spec.tickValue, 12.5); assert.equal(es.spec.multiplier, 50);
  assert.equal(es.tickSize, 0.25); assert.equal(es.currency, "USD");
  for (const [root, f] of Object.entries(I.FUT)) assert.ok(Math.abs(f[2] * f[4] - f[3]) < 1e-9, `${root}: tick × multiplier = tick value`);
  const zz = I.normalize({ symbol: "ZZ=F", quoteType: "FUTURE" });
  assert.equal(zz.spec, undefined); assert.equal(zz.tickSize, null);
});

test("prices use the right precision for each class", () => {
  const f = (s, p) => I.formatPrice(I.normalize(s), p);
  assert.equal(f("AAPL", 189.5), "189.50");
  assert.equal(f("EURUSD=X", 1.08345), "1.08345");
  assert.equal(f("JPY=X", 151.234), "151.234");
  assert.equal(f("BTC-USD", 97123.456), "97,123.46");
  assert.equal(f("XRP-USD", 2.34567), "2.3457");
  assert.equal(f("SHIB-USD", 0.00002345), "0.00002345");
  assert.equal(f("CL=F", 71.234), "71.23");
  assert.equal(f("6E=F", 1.08365), "1.08365");
  assert.equal(f("^TNX", 4.3125), "4.313");
  assert.equal(f("ZB=F", 118.5), "118'16");
  assert.equal(f("ZN=F", 110 + 17.5 / 32), "110'17.5");
  assert.equal(f("ZF=F", 107 + 8.25 / 32), "107'08.25");
  assert.equal(f("AAPL", null), "—");
});

test("market status: crypto is always live; equities, futures and FX follow their sessions", () => {
  const at = (iso) => Date.parse(iso);
  const st = (s, iso) => I.marketStatus(I.normalize(s), at(iso)).code;
  assert.equal(st("BTC-USD", "2026-11-28T08:00:00Z"), "LIVE");
  assert.equal(st("AAPL", "2026-11-24T15:00:00Z"), "OPEN");   // Tue 10:00 ET
  assert.equal(st("AAPL", "2026-11-24T12:00:00Z"), "PRE");    // 07:00 ET
  assert.equal(st("AAPL", "2026-11-24T22:00:00Z"), "AFTER");  // 17:00 ET
  assert.equal(st("AAPL", "2026-11-25T03:00:00Z"), "CLOSED"); // 22:00 ET
  assert.equal(st("ES=F", "2026-11-24T22:30:00Z"), "CLOSED"); // 17:30 ET daily break
  assert.equal(st("ES=F", "2026-11-25T03:00:00Z"), "OPEN");   // 22:00 ET overnight session
  assert.equal(st("ES=F", "2026-11-28T15:00:00Z"), "CLOSED"); // Saturday
  assert.equal(st("EURUSD=X", "2026-11-29T23:00:00Z"), "OPEN"); // Sun 18:00 ET
  assert.equal(st("EURUSD=X", "2026-11-29T20:00:00Z"), "CLOSED"); // Sun 15:00 ET
  // the provider's own session times win (they know holidays and foreign exchanges)
  const reg = { start: at("2026-11-26T14:30:00Z"), end: at("2026-11-26T21:00:00Z") };
  assert.equal(I.marketStatus(I.normalize({ symbol: "7203.T", exchange: "Tokyo" }), at("2026-11-26T15:00:00Z"), { regular: reg }).code, "OPEN");
  assert.equal(I.marketStatus(I.normalize({ symbol: "7203.T", exchange: "Tokyo" }), at("2026-11-26T15:00:00Z")).code, "UNKNOWN", "no guessing for foreign exchanges");
});

test("paper trading: prices snap to the tick and futures P&L uses the multiplier", () => {
  const es = I.normalize("ES=F"), aapl = I.normalize("AAPL"), opt = I.normalize("AAPL250117C00150000");
  assert.equal(I.roundToTick(es, 5000.13), 5000.25);
  assert.equal(I.roundToTick(aapl, 189.123), 189.12);
  assert.equal(I.pnl(es, { qty: 2, entry: 5000, exit: 5010 }), 1000);
  assert.equal(I.pnl(opt, { qty: 1, entry: 2.5, exit: 3 }), 50);
  assert.equal(I.pnl(aapl, { qty: 10, entry: 100, exit: 101 }), 10);
});

test("providers: everything routes to keyless sources", () => {
  assert.deepEqual(I.providerFor(I.normalize("BTC-USD")).fallbacks, ["coinbase", "binance.us"]);
  assert.equal(I.providerFor(I.normalize("BTC-USD")).stream, "coinbase");
  assert.deepEqual(I.providerFor(I.normalize("EURUSD=X")).fallbacks, ["frankfurter"]);
  assert.deepEqual(I.providerFor(I.normalize("^TNX")).fallbacks, ["fred"]);
});

test("extended-hours line: pre-market before the open, after-hours after the close, nothing in session", () => {
  const T = (h, m = 0) => Date.UTC(2026, 10, 25, h + 5, m); // ET → UTC (EST)
  const q = { price: 100, regularSession: { start: T(9, 30), end: T(16) },
    preMarket: { price: 98, change: -2, changePct: -2, marketTime: T(8) }, postMarket: null };
  assert.equal(I.extendedNow(q, T(8, 15)).short, "Pre");
  assert.equal(I.extendedNow(q, T(8, 15)).price, 98);
  assert.equal(I.extendedNow(q, T(11)), null);
  assert.equal(I.extendedNow(q, T(17)), null); // no after-hours print yet: show nothing rather than a stale pre-market
  const q2 = { ...q, postMarket: { price: 101, change: 1, changePct: 1, marketTime: T(17) } };
  assert.equal(I.extendedNow(q2, T(17, 5)).label, "After-hours");
  assert.equal(I.extendedNow({ price: 5 }, T(8)), null); // futures/crypto: no extended fields
  assert.equal(I.extendedNow({ error: true }, T(8)), null);
  assert.equal(I.extendedNow({ preMarket: { price: 0 } }, T(8)), null);
});

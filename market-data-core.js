// Market Desk — free multi-asset data adapter: pure helpers for the server (tests/market-data-core.test.js).
// Every source used here is keyless and free: Yahoo Finance (chart/search/options), Coinbase Exchange public market
// data (REST + WebSocket), Binance.US public market data, Frankfurter (ECB/central-bank reference FX) and FRED's
// public CSV download. No network calls in this file; server.js does the fetching through the gate below.
"use strict";
const I = require("./public/instruments-core.js");

// ---- request gate: at most `concurrency` calls to one provider at a time, at least `minGapMs` apart, and a growing
// pause after the provider says "too many requests" (HTTP 429/999), so bursts of clicks or many visitors can't get
// the server's address throttled.
function createGate({ concurrency = 3, minGapMs = 120, maxCooldownMs = 60_000, now = () => Date.now(), sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) } = {}) {
  const g = { active: 0, waiting: [], last: 0, cooldownUntil: 0, strikes: 0, served: 0, throttled: 0 };
  const isThrottle = (e) => /HTTP (429|999)\b|Too Many Requests|status 429/i.test(String((e && e.message) || e)) || (e && (e.status === 429 || e.status === 999));
  async function slot() {
    const t = now(), wait = Math.max(0, g.cooldownUntil - t, g.last + minGapMs - t);
    g.last = Math.max(t, g.last + minGapMs, g.cooldownUntil);
    if (wait > 0) await sleep(wait);
  }
  function run(fn) {
    return new Promise((resolve, reject) => {
      const go = async () => {
        g.active++;
        try {
          await slot();
          const out = await fn(); g.served++; g.strikes = 0; resolve(out);
        } catch (e) {
          if (isThrottle(e)) { g.throttled++; g.strikes++; g.cooldownUntil = now() + Math.min(maxCooldownMs, 2000 * 2 ** (g.strikes - 1)); }
          reject(e);
        } finally { g.active--; const n = g.waiting.shift(); if (n) n(); }
      };
      if (g.active < concurrency) go(); else g.waiting.push(go);
    });
  }
  const stats = () => ({ active: g.active, queued: g.waiting.length, served: g.served, throttled: g.throttled, coolingDownMs: Math.max(0, g.cooldownUntil - now()) });
  return { run, stats, isThrottle };
}

// How long each kind of data may be served from memory (ms). Live quotes stay short; slow-moving data stays long.
const TTL = { quote: 10_000, cryptoQuote: 5_000, intraday: 60_000, daily: 5 * 60_000, search: 10 * 60_000, instrument: 24 * 3600_000, options: 60_000, fx: 60 * 60_000, fred: 6 * 3600_000, coinbaseProducts: 24 * 3600_000 };

// ---- Yahoo search → normalised instruments (keeps the old fields so existing pages keep working)
function searchRows(quotes) {
  return (quotes || []).filter((x) => x && x.symbol).map((x) => {
    const inst = I.normalize({ symbol: x.symbol, quoteType: x.quoteType, name: x.shortname || x.longname, exchDisp: x.exchDisp || x.exchange });
    return { ...inst, type: x.quoteType || "", typeDisp: x.typeDisp || x.quoteType || "", exchange: inst.exchange };
  });
}

// ---- Coinbase Exchange (public, no key): products, ticker REST, 24h stats, WebSocket "ticker" messages.
// Coinbase product ids (BTC-USD) are the same as Yahoo's crypto symbols, so no mapping table is needed.
function coinbaseProducts(list) {
  const out = {};
  for (const p of list || []) {
    if (!p || !p.id || p.status === "delisted" || p.trading_disabled) continue;
    out[String(p.id).toUpperCase()] = { quoteIncrement: +p.quote_increment || null, baseIncrement: +p.base_increment || null };
  }
  return out;
}
function coinbaseTick(msg, nowMs = Date.now()) {
  if (!msg || msg.type !== "ticker" || typeof msg.product_id !== "string") return null;
  const p = +msg.price, t = Date.parse(msg.time);
  if (!(p > 0) || !Number.isFinite(t)) return null;
  // never stamp a trade later than our own clock (browsers reject future-dated ticks)
  return { sym: msg.product_id.toUpperCase(), p, t: Math.min(t, nowMs), v24: +msg.volume_24h || null, open24: +msg.open_24h || null };
}
function coinbaseQuote(sym, ticker, stats, nowMs = Date.now()) {
  const price = +(ticker && ticker.price), open = +(stats && stats.open);
  if (!(price > 0)) throw new Error("no Coinbase price");
  const t = Date.parse(ticker.time);
  return { symbol: sym, name: sym.replace("-", "/"), price, prevClose: open > 0 ? open : null, change: open > 0 ? price - open : null, changePct: open > 0 ? ((price - open) / open) * 100 : null,
    currency: sym.split("-")[1], exchange: "Coinbase", marketTime: Number.isFinite(t) ? Math.min(t, nowMs) : nowMs,
    dayHigh: +(stats && stats.high) || null, dayLow: +(stats && stats.low) || null, volume: +(stats && stats.volume) || null, spark: [], provider: "coinbase", changeBasis: "24h" };
}
// Binance.US public ticker (BTCUSD style symbols). Binance.com is not used: it refuses US addresses (HTTP 451).
const binanceUsSymbol = (sym) => { const p = I.cryptoPair(sym); return p ? p[0] + (p[1] === "USD" ? "USD" : p[1]) : null; };
function binanceUsQuote(sym, j, nowMs = Date.now()) {
  const price = +(j && j.lastPrice), open = +(j && j.openPrice);
  if (!(price > 0)) throw new Error("no Binance.US price");
  return { symbol: sym, name: sym.replace("-", "/"), price, prevClose: open > 0 ? open : null, change: open > 0 ? price - open : null, changePct: open > 0 ? ((price - open) / open) * 100 : null,
    currency: sym.split("-")[1], exchange: "Binance.US", marketTime: Math.min(+j.closeTime || nowMs, nowMs), dayHigh: +j.highPrice || null, dayLow: +j.lowPrice || null,
    volume: +j.volume || null, spark: [], provider: "binance.us", changeBasis: "24h" };
}

// ---- Frankfurter (free, no key): daily central-bank reference rates. Used only when Yahoo's live FX quote fails,
// and always labelled as a reference rate, never as a live market price.
function frankfurterUrl(base, quote) { return `https://api.frankfurter.dev/v2/rate/${encodeURIComponent(base.toLowerCase())}/${encodeURIComponent(quote.toLowerCase())}`; }
function frankfurterQuote(sym, j) {
  const pair = I.forexPair(sym); if (!pair) throw new Error("not an FX pair");
  const rate = j && (j.rate != null ? +j.rate : j.rates && +j.rates[pair[1]]); // v2: {date, base, quote, rate}
  if (!(rate > 0)) throw new Error("no reference rate");
  return { symbol: sym, name: pair.join("/"), price: rate, prevClose: null, change: null, changePct: null, currency: pair[1], exchange: "ECB reference rate",
    marketTime: Date.parse((j.date || "") + "T16:00:00+01:00") || null, spark: [], provider: "frankfurter", reference: true,
    note: `Daily reference rate published ${j.date || "—"}, not a live market price` };
}

// ---- FRED public CSV (no key): latest value of a daily series, e.g. DGS10 for the 10-year yield.
const FRED_FOR = { "^IRX": "DTB3", "^FVX": "DGS5", "^TNX": "DGS10", "^TYX": "DGS30" };
function fredLatest(csv) {
  const rows = String(csv || "").trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).filter((r) => r.length >= 2 && r[1] !== "." && r[1] !== "" && Number.isFinite(+r[1]));
  if (!rows.length) throw new Error("no FRED data");
  const last = rows[rows.length - 1], prev = rows.length > 1 ? rows[rows.length - 2] : null;
  return { date: last[0], value: +last[1], prev: prev ? +prev[1] : null };
}
function fredQuote(sym, csv) {
  const f = fredLatest(csv);
  return { symbol: sym, name: I.YIELDS[sym] || sym, price: f.value, prevClose: f.prev, change: f.prev != null ? f.value - f.prev : null, changePct: f.prev ? ((f.value - f.prev) / f.prev) * 100 : null,
    currency: null, exchange: "FRED (St. Louis Fed)", marketTime: Date.parse(f.date + "T21:00:00Z") || null, spark: [], provider: "fred", reference: true, note: `Daily close for ${f.date} (FRED ${FRED_FOR[sym]})` };
}

// ---- Yahoo options chain → strikes with bid/ask/last/IV/OI per expiry (all numbers straight from the provider)
function optionChain(j) {
  const r = j && j.optionChain && j.optionChain.result && j.optionChain.result[0];
  if (!r) throw new Error("no options for that symbol");
  const q = r.quote || {}, o = (r.options && r.options[0]) || {};
  const row = (c) => ({ contract: c.contractSymbol, strike: c.strike, last: c.lastPrice ?? null, bid: c.bid ?? null, ask: c.ask ?? null, change: c.change ?? null,
    volume: c.volume ?? null, openInterest: c.openInterest ?? null, iv: Number.isFinite(c.impliedVolatility) ? c.impliedVolatility : null, itm: !!c.inTheMoney,
    lastTrade: c.lastTradeDate ? c.lastTradeDate * 1000 : null });
  return { underlying: r.underlyingSymbol || q.symbol, underlyingPrice: q.regularMarketPrice ?? null, currency: q.currency || "USD",
    expirations: (r.expirationDates || []).map((s) => new Date(s * 1000).toISOString().slice(0, 10)),
    expiry: o.expirationDate ? new Date(o.expirationDate * 1000).toISOString().slice(0, 10) : null,
    calls: (o.calls || []).map(row), puts: (o.puts || []).map(row), multiplier: 100, provider: "yahoo" };
}

// Yahoo chart meta → the provider's own session times (ms), used for PRE / OPEN / AFTER / CLOSED.
function tradingPeriods(meta) {
  const p = meta && meta.currentTradingPeriod; if (!p) return null;
  const ms = (x) => (x && x.start < x.end ? { start: x.start * 1000, end: x.end * 1000 } : null);
  const out = { pre: ms(p.pre), regular: ms(p.regular), post: ms(p.post) };
  return out.regular ? out : null;
}

module.exports = { createGate, TTL, searchRows, coinbaseProducts, coinbaseTick, coinbaseQuote, binanceUsSymbol, binanceUsQuote, frankfurterUrl, frankfurterQuote, FRED_FOR, fredLatest, fredQuote, optionChain, tradingPeriods };

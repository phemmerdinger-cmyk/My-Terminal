// Market Desk — one description for every tradable thing (stocks, ETFs, futures, forex, crypto, indexes, yields,
// options). Pure functions, no network: the server and the browser both load this file (tests/instruments-core.test.js).
// Every instrument is normalised to: symbol, displaySymbol, name, assetClass, exchange, currency, tickSize,
// marketHours and provider. Nothing here is a list of tickers to trade: classification comes from the provider's own
// type plus the symbol's shape, and the only table is futures contract specs (tick size/value), which no free API serves.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MDInstruments = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CLASSES = ["equity", "etf", "future", "forex", "crypto", "index", "option"];
  const BADGE = { equity: "EQUITY", etf: "ETF", future: "FUTURE", forex: "FX", crypto: "CRYPTO", index: "INDEX", option: "OPTION" };
  const YAHOO_TYPE = { EQUITY: "equity", ETF: "etf", MUTUALFUND: "etf", MONEYMARKET: "etf", FUTURE: "future", CURRENCY: "forex", CRYPTOCURRENCY: "crypto", INDEX: "index", OPTION: "option" };
  // Treasury yield indexes on Yahoo (quoted in percent): shown as yields, not points.
  const YIELDS = { "^IRX": "US 13-week T-bill yield", "^FVX": "US 5-year Treasury yield", "^TNX": "US 10-year Treasury yield", "^TYX": "US 30-year Treasury yield" };
  const INDEX_ALIAS = { "^GSPC": "SPX", "^DJI": "DJIA", "^IXIC": "COMP", "^NDX": "NDX", "^RUT": "RUT", "^VIX": "VIX", "^IRX": "US13W", "^FVX": "US5Y", "^TNX": "US10Y", "^TYX": "US30Y", "^FTSE": "UKX", "^GDAXI": "DAX", "^N225": "NKY", "^HSI": "HSI", "^STOXX50E": "SX5E", "^FCHI": "CAC" };
  const OCC = /^([A-Z][A-Z.]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
  const CRYPTO_QUOTES = ["USD", "USDT", "USDC", "EUR", "GBP", "BTC", "ETH"];

  // ---- futures contract specs (CME Group / COMEX / NYMEX / CBOT published specs; "points" = price units)
  // tick = minimum price move, tickValue = dollars per tick per contract, multiplier = dollars per 1.00 of price.
  // hours: globex = Sun 6 PM – Fri 5 PM ET with a 5–6 PM ET daily break; grains/livestock: their own sessions.
  const FUT = {
    ES: ["E-mini S&P 500", "CME", 0.25, 12.5, 50, "globex", "HMUZ"], MES: ["Micro E-mini S&P 500", "CME", 0.25, 1.25, 5, "globex", "HMUZ"],
    NQ: ["E-mini Nasdaq-100", "CME", 0.25, 5, 20, "globex", "HMUZ"], MNQ: ["Micro E-mini Nasdaq-100", "CME", 0.25, 0.5, 2, "globex", "HMUZ"],
    YM: ["E-mini Dow ($5)", "CBOT", 1, 5, 5, "globex", "HMUZ"], MYM: ["Micro E-mini Dow", "CBOT", 1, 0.5, 0.5, "globex", "HMUZ"],
    RTY: ["E-mini Russell 2000", "CME", 0.1, 5, 50, "globex", "HMUZ"], M2K: ["Micro E-mini Russell 2000", "CME", 0.1, 0.5, 5, "globex", "HMUZ"],
    CL: ["Crude Oil (WTI)", "NYMEX", 0.01, 10, 1000, "globex", "monthly"], MCL: ["Micro WTI Crude Oil", "NYMEX", 0.01, 1, 100, "globex", "monthly"],
    NG: ["Henry Hub Natural Gas", "NYMEX", 0.001, 10, 10000, "globex", "monthly"], RB: ["RBOB Gasoline", "NYMEX", 0.0001, 4.2, 42000, "globex", "monthly"],
    HO: ["NY Harbor ULSD (Heating Oil)", "NYMEX", 0.0001, 4.2, 42000, "globex", "monthly"],
    GC: ["Gold", "COMEX", 0.1, 10, 100, "globex", "GJMQVZ"], MGC: ["Micro Gold", "COMEX", 0.1, 1, 10, "globex", "GJMQVZ"],
    SI: ["Silver", "COMEX", 0.005, 25, 5000, "globex", "HKNUZ"], HG: ["Copper", "COMEX", 0.0005, 12.5, 25000, "globex", "HKNUZ"],
    PL: ["Platinum", "NYMEX", 0.1, 5, 50, "globex", "FJNV"], PA: ["Palladium", "NYMEX", 0.5, 50, 100, "globex", "HMUZ"],
    ZB: ["30-Year U.S. Treasury Bond", "CBOT", 1 / 32, 31.25, 1000, "globex", "HMUZ", "32nds"],
    ZN: ["10-Year U.S. Treasury Note", "CBOT", 1 / 64, 15.625, 1000, "globex", "HMUZ", "32nds"],
    ZF: ["5-Year U.S. Treasury Note", "CBOT", 1 / 128, 7.8125, 1000, "globex", "HMUZ", "32nds"],
    ZT: ["2-Year U.S. Treasury Note", "CBOT", 1 / 256, 7.8125, 2000, "globex", "HMUZ", "32nds"],
    ZC: ["Corn (cents/bushel)", "CBOT", 0.25, 12.5, 50, "grains", "HKNUZ"], ZS: ["Soybeans (cents/bushel)", "CBOT", 0.25, 12.5, 50, "grains", "FHKNQUX"],
    ZW: ["Chicago SRW Wheat (cents/bushel)", "CBOT", 0.25, 12.5, 50, "grains", "HKNUZ"], ZL: ["Soybean Oil (cents/lb)", "CBOT", 0.01, 6, 600, "grains", "FHKNQUVZ"],
    ZM: ["Soybean Meal ($/short ton)", "CBOT", 0.1, 10, 100, "grains", "FHKNQUVZ"],
    LE: ["Live Cattle (cents/lb)", "CME", 0.025, 10, 400, "livestock", "GJMQVZ"], HE: ["Lean Hogs (cents/lb)", "CME", 0.025, 10, 400, "livestock", "GJKMNQVZ"],
    "6E": ["Euro FX", "CME", 0.00005, 6.25, 125000, "globex", "HMUZ"], "6J": ["Japanese Yen", "CME", 0.0000005, 6.25, 12500000, "globex", "HMUZ"],
    "6B": ["British Pound", "CME", 0.0001, 6.25, 62500, "globex", "HMUZ"], "6A": ["Australian Dollar", "CME", 0.00005, 5, 100000, "globex", "HMUZ"],
    "6C": ["Canadian Dollar", "CME", 0.00005, 5, 100000, "globex", "HMUZ"], "6S": ["Swiss Franc", "CME", 0.00005, 6.25, 125000, "globex", "HMUZ"],
    BTC: ["Bitcoin (CME)", "CME", 5, 25, 5, "globex", "monthly"], MBT: ["Micro Bitcoin (CME)", "CME", 5, 0.5, 0.1, "globex", "monthly"],
  };
  const MONTH_CODE = { F: "Jan", G: "Feb", H: "Mar", J: "Apr", K: "May", M: "Jun", N: "Jul", Q: "Aug", U: "Sep", V: "Oct", X: "Nov", Z: "Dec" };
  const HOURS = {
    us_equity: { tz: "America/New_York", label: "Pre 4:00–9:30 · Regular 9:30–16:00 · After 16:00–20:00 ET, Mon–Fri" },
    us_index: { tz: "America/New_York", label: "Regular 9:30–16:00 ET, Mon–Fri" },
    us_option: { tz: "America/New_York", label: "Regular 9:30–16:00 ET, Mon–Fri" },
    forex: { tz: "America/New_York", label: "24h from Sun 17:00 to Fri 17:00 ET" },
    crypto: { tz: "UTC", label: "24/7" },
    globex: { tz: "America/New_York", label: "Sun 18:00 – Fri 17:00 ET, daily break 17:00–18:00 ET" },
    grains: { tz: "America/New_York", label: "Sun–Fri 20:00–08:45 and Mon–Fri 09:30–14:20 ET" },
    livestock: { tz: "America/New_York", label: "Mon–Fri 09:30–14:05 ET" },
    exchange: { tz: null, label: "Exchange hours (local session from the data provider)" },
  };

  function futureSpec(symbol) {
    const root = futureRoot(symbol); const f = root && FUT[root];
    if (!f) return null;
    const [name, exchange, tick, tickValue, multiplier, hours, months, priceFormat] = f;
    return { root, name, exchange, tickSize: tick, tickValue, multiplier, hours, months: months === "monthly" ? "Every month" : months.split("").map((c) => MONTH_CODE[c]).join(", "), priceFormat: priceFormat || "decimal",
      source: "CME Group contract specifications" };
  }
  // ES=F → ES; ESZ25.CME / ESZ5 → ES; 6E=F → 6E
  function futureRoot(symbol) {
    const s = String(symbol || "").toUpperCase();
    let m = s.match(/^([A-Z0-9]{1,4})=F$/); if (m) return m[1];
    m = s.match(/^([A-Z0-9]{1,4}?)[FGHJKMNQUVXZ]\d{1,2}(\.[A-Z]+)?$/); if (m && FUT[m[1]]) return m[1];
    return null;
  }
  function parseOption(symbol) {
    const m = String(symbol || "").toUpperCase().replace(/\s+/g, "").match(OCC);
    if (!m) return null;
    return { underlying: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, right: m[5] === "C" ? "call" : "put", strike: +m[6] / 1000 };
  }
  function forexPair(symbol) {
    const s = String(symbol || "").toUpperCase();
    let m = s.match(/^([A-Z]{3})([A-Z]{3})=X$/); if (m) return [m[1], m[2]];
    m = s.match(/^([A-Z]{3})=X$/); if (m) return ["USD", m[1]]; // Yahoo writes USD/JPY as JPY=X
    return null;
  }
  function cryptoPair(symbol) {
    const m = String(symbol || "").toUpperCase().match(/^([A-Z0-9]{2,10})-([A-Z]{3,4})$/);
    return m && CRYPTO_QUOTES.includes(m[2]) ? [m[1], m[2]] : null;
  }

  // The asset class from the provider's type when there is one, otherwise from the symbol's shape.
  function assetClassOf(symbol, quoteType) {
    const t = YAHOO_TYPE[String(quoteType || "").toUpperCase()];
    if (t) return t;
    const s = String(symbol || "").toUpperCase();
    if (parseOption(s)) return "option";
    if (/=F$/.test(s) || futureRoot(s)) return "future";
    if (/=X$/.test(s)) return "forex";
    if (s.startsWith("^")) return "index";
    if (cryptoPair(s) && !/\.[A-Z]+$/.test(s)) return "crypto";
    return "equity";
  }

  function displaySymbolOf(symbol, cls) {
    const s = String(symbol || "").toUpperCase();
    if (cls === "forex") { const p = forexPair(s); return p ? p.join("/") : s; }
    if (cls === "crypto") { const p = cryptoPair(s); return p ? p.join("/") : s; }
    if (cls === "future") return futureRoot(s) || s.replace(/=F$/, "");
    if (cls === "index") return INDEX_ALIAS[s] || s.replace(/^\^/, "");
    if (cls === "option") { const o = parseOption(s); return o ? `${o.underlying} ${o.expiry} ${o.strike} ${o.right === "call" ? "C" : "P"}` : s; }
    return s;
  }

  const isYield = (symbol) => Object.hasOwn(YIELDS, String(symbol || "").toUpperCase());
  const isUS = (exchange, currency) => !exchange || /nasdaq|nyse|nms|ngm|ncm|nyq|ase|amex|bats|cboe|pcx|arca|otc|pnk|nym|cbt|cme|cmx|nyb|us/i.test(exchange) || (!exchange && currency === "USD");

  function hoursKey(inst) {
    if (inst.assetClass === "crypto") return "crypto";
    if (inst.assetClass === "forex") return "forex";
    if (inst.assetClass === "future") return (inst.spec && inst.spec.hours) || "globex";
    if (inst.assetClass === "option") return "us_option";
    if (inst.assetClass === "index") return isUS(inst.exchange, inst.currency) ? "us_index" : "exchange";
    return isUS(inst.exchange, inst.currency) ? "us_equity" : "exchange";
  }

  // decimals to show for a price: 2 for stocks, 4–5 for FX (3 for yen pairs), the tick's precision for futures,
  // and a price-dependent precision for crypto (so a $0.00001234 coin isn't shown as 0.00).
  function decimals(inst, price) {
    const cls = inst && inst.assetClass, p = Math.abs(+price);
    if (cls === "forex") { const pair = forexPair(inst.symbol); return pair && pair[1] === "JPY" ? 3 : 5; }
    if (cls === "future" && inst.tickSize) return tickDecimals(inst.tickSize);
    if (cls === "crypto") {
      if (!Number.isFinite(p) || p === 0) return 2;
      if (p >= 1000) return 2; if (p >= 1) return 4;
      return Math.min(10, Math.ceil(-Math.log10(p)) + 3);
    }
    if (inst && inst.subtype === "yield") return 3;
    if ((cls === "equity" || cls === "etf") && Number.isFinite(p) && p > 0 && p < 1) return 4;
    return 2;
  }
  function tickDecimals(t) { const s = String(+(+t).toPrecision(8)); return s.includes("e-") ? +s.split("e-")[1] : s.includes(".") ? s.split(".")[1].length : 0; }

  const pow10 = (d) => +(1 / 10 ** d).toFixed(d); // 0.00001, not 0.000009999999999999999
  function tickSizeOf(inst, price) {
    const cls = inst.assetClass, p = Math.abs(+price);
    if (cls === "future") return inst.spec ? inst.spec.tickSize : null;
    if (cls === "forex") return pow10(decimals(inst, price));
    if (cls === "crypto") return inst.quoteIncrement || pow10(decimals(inst, price));
    if (inst.subtype === "yield") return 0.001;
    if ((cls === "equity" || cls === "etf") && p > 0 && p < 1) return 0.0001;
    return 0.01;
  }

  // Treasury futures are quoted in points and 32nds: 112.53125 → 112'17.0 (ZN/ZF/ZT show halves and quarters).
  function formatPrice(inst, price, { d } = {}) {
    if (price == null || !Number.isFinite(+price)) return "—";
    const v = +price;
    if (inst && inst.spec && inst.spec.priceFormat === "32nds") {
      // parts of a 32nd: ZB 1, ZN 2 (halves), ZF 4 (quarters), ZT 8 (eighths)
      const parts = Math.max(1, Math.round(1 / (inst.spec.tickSize * 32)));
      let whole = Math.floor(v), t = Math.round((v - whole) * 32 * parts) / parts;
      if (t >= 32) { whole += 1; t -= 32; }
      const ti = Math.floor(t), frac = +(t - ti).toFixed(3);
      return `${whole}'${String(ti).padStart(2, "0")}${frac ? String(frac).replace(/^0/, "") : ""}`;
    }
    const n = d ?? decimals(inst || {}, v);
    return v.toLocaleString("en-US", { minimumFractionDigits: n, maximumFractionDigits: n });
  }

  // Normalise any provider row (Yahoo search/quote, a bare symbol) into the shared schema.
  function normalize(row) {
    const r = typeof row === "string" ? { symbol: row } : row || {};
    const symbol = String(r.symbol || "").toUpperCase();
    const assetClass = assetClassOf(symbol, r.quoteType || r.type || r.instrumentType);
    const spec = assetClass === "future" ? futureSpec(symbol) : null;
    const opt = assetClass === "option" ? parseOption(symbol) : null;
    const fx = assetClass === "forex" ? forexPair(symbol) : null, cp = assetClass === "crypto" ? cryptoPair(symbol) : null;
    const inst = {
      symbol,
      displaySymbol: displaySymbolOf(symbol, assetClass),
      name: r.name || r.shortname || r.longname || r.shortName || r.longName || (spec && spec.name) || (isYield(symbol) && YIELDS[symbol]) || symbol,
      assetClass,
      badge: BADGE[assetClass],
      exchange: r.exchDisp || r.exchange || r.fullExchangeName || (spec && spec.exchange) || (assetClass === "crypto" ? "Crypto" : assetClass === "forex" ? "FX" : ""),
      currency: r.currency || (fx ? fx[1] : cp ? cp[1] : spec ? "USD" : null) || null,
    };
    if (isYield(symbol)) inst.subtype = "yield";
    if (/MUTUALFUND/i.test(r.quoteType || r.type || "")) inst.subtype = "mutual fund";
    if (spec) inst.spec = spec;
    if (opt) inst.option = opt;
    if (r.quoteIncrement) inst.quoteIncrement = +r.quoteIncrement;
    inst.tickSize = tickSizeOf(inst, r.price ?? r.regularMarketPrice);
    const hk = hoursKey(inst);
    inst.marketHours = { session: hk, ...HOURS[hk] };
    inst.provider = providerFor(inst).quote;
    return inst;
  }

  // Which free source serves each class. Every route is keyless; fallbacks are tried in order when the first fails.
  function providerFor(inst) {
    switch (inst.assetClass) {
      case "crypto": return { quote: "yahoo", stream: "coinbase", fallbacks: ["coinbase", "binance.us"] };
      case "forex": return { quote: "yahoo", stream: null, fallbacks: ["frankfurter"] };
      case "index": return { quote: "yahoo", stream: null, fallbacks: inst.subtype === "yield" ? ["fred"] : [] };
      default: return { quote: "yahoo", stream: inst.assetClass === "equity" || inst.assetClass === "etf" ? "finnhub" : null, fallbacks: [] };
    }
  }

  // ---- market status
  const etFmt = typeof Intl !== "undefined" ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : null;
  function etNow(now) {
    const p = Object.fromEntries(etFmt.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    return { wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), min: (+p.hour % 24) * 60 + +p.minute };
  }
  const H = (h, m = 0) => h * 60 + m;
  // periods: the provider's own session times for today (ms), e.g. Yahoo's currentTradingPeriod {pre, regular, post}.
  // They win when present because they know holidays and foreign exchanges.
  function marketStatus(inst, now = Date.now(), periods = null) {
    const cls = inst && inst.assetClass;
    if (cls === "crypto") return { code: "LIVE", label: "LIVE 24/7" };
    const inP = (p) => p && p.start < p.end && now >= p.start && now < p.end;
    if (periods && (cls === "equity" || cls === "etf" || cls === "index" || cls === "option") && periods.regular && periods.regular.start < periods.regular.end) {
      if (inP(periods.regular)) return { code: "OPEN", label: "OPEN" };
      if (cls !== "index" && cls !== "option" && inP(periods.pre)) return { code: "PRE", label: "PRE-MARKET" };
      if (cls !== "index" && cls !== "option" && inP(periods.post)) return { code: "AFTER", label: "AFTER HOURS" };
      return { code: "CLOSED", label: "CLOSED" };
    }
    const { wd, min } = etNow(now), wkday = wd >= 1 && wd <= 5;
    const key = hoursKey(inst);
    if (key === "forex") {
      const open = (wd === 0 && min >= H(17)) || (wd >= 1 && wd <= 4) || (wd === 5 && min < H(17));
      return open ? { code: "OPEN", label: "OPEN 24h" } : { code: "CLOSED", label: "CLOSED (weekend)" };
    }
    if (key === "globex") {
      if (wd === 6 || (wd === 0 && min < H(18)) || (wd === 5 && min >= H(17))) return { code: "CLOSED", label: "CLOSED (weekend)" };
      if (min >= H(17) && min < H(18)) return { code: "CLOSED", label: "CLOSED (daily break)" };
      return { code: "OPEN", label: "OPEN" };
    }
    if (key === "grains") {
      const night = (min >= H(20) && wd >= 0 && wd <= 4) || (min < H(8, 45) && wd >= 1 && wd <= 5), day = wkday && min >= H(9, 30) && min < H(14, 20);
      return night || day ? { code: "OPEN", label: "OPEN" } : { code: "CLOSED", label: "CLOSED" };
    }
    if (key === "livestock") return wkday && min >= H(9, 30) && min < H(14, 5) ? { code: "OPEN", label: "OPEN" } : { code: "CLOSED", label: "CLOSED" };
    if (key === "us_equity") {
      if (!wkday) return { code: "CLOSED", label: "CLOSED" };
      if (min >= H(9, 30) && min < H(16)) return { code: "OPEN", label: "OPEN" };
      if (min >= H(4) && min < H(9, 30)) return { code: "PRE", label: "PRE-MARKET" };
      if (min >= H(16) && min < H(20)) return { code: "AFTER", label: "AFTER HOURS" };
      return { code: "CLOSED", label: "CLOSED" };
    }
    if (key === "us_index" || key === "us_option") return wkday && min >= H(9, 30) && min < H(16) ? { code: "OPEN", label: "OPEN" } : { code: "CLOSED", label: "CLOSED" };
    return { code: "UNKNOWN", label: "—" }; // a foreign exchange without the provider's session times: don't guess
  }

  // Paper-trading math that respects the instrument: prices snap to the tick, futures P&L uses the contract multiplier.
  function roundToTick(inst, price) {
    const t = inst && inst.tickSize; if (!(t > 0) || !Number.isFinite(+price)) return +price;
    const n = Math.round(+price / t) * t, d = tickDecimals(t);
    return +n.toFixed(Math.min(10, d + 2));
  }
  const multiplierOf = (inst) => (inst && inst.assetClass === "future" && inst.spec ? inst.spec.multiplier : inst && inst.assetClass === "option" ? 100 : 1);
  function pnl(inst, { qty, entry, exit }) { return (exit - entry) * qty * multiplierOf(inst); }

  // Robinhood-style extended-hours line: before today's open → the latest pre-market print; after the close → the latest
  // after-hours print; during the regular session → nothing. Only real prints from the quote; never estimated.
  function extendedNow(q, now) {
    if (!q || q.error) return null;
    const ok = (x) => x && Number.isFinite(x.price) && x.price > 0;
    const pre = ok(q.preMarket) ? Object.assign({}, q.preMarket, { session: "pre", label: "Pre-market", short: "Pre" }) : null;
    const post = ok(q.postMarket) ? Object.assign({}, q.postMarket, { session: "post", label: "After-hours", short: "After hrs" }) : null;
    const rs = q.regularSession, t = now == null ? Date.now() : now;
    if (rs && rs.start < rs.end) return t < rs.start ? pre : t >= rs.end ? post : null;
    return [pre, post].filter(Boolean).sort((a, b) => b.marketTime - a.marketTime)[0] || null;
  }
  return { extendedNow, CLASSES, BADGE, YIELDS, FUT, HOURS, normalize, assetClassOf, displaySymbolOf, futureSpec, futureRoot, parseOption, forexPair, cryptoPair,
    decimals, tickSizeOf, formatPrice, providerFor, marketStatus, roundToTick, multiplierOf, pnl };
});

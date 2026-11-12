// Deterministic fake data sources for THE WEB tests (no network). Times are controllable through clock.
const FINS = require("../public/fin.js");
function makeDeps(over = {}) {
  let T = over.t0 || Date.parse("2026-11-11T16:00:00Z"); // Wed 11:00 ET, market open
  const clock = { now: () => T, set: (t) => (T = t), add: (ms) => (T += ms) };
  const chg = Object.assign({ "^GSPC": -1.4, "^IXIC": -2.1, "^DJI": -0.6, "^RUT": -1.9, "^VIX": 14, "^TNX": 2.1, "CL=F": 3.5, "GC=F": 0.4, "DX-Y.NYB": 0.2, "BTC-USD": -3, XLK: -2.6, XLF: 0.3, XLE: 2.2, XLV: 0.8, XLU: 1.1, XLP: 0.9, XLY: -1.5, XLC: -1.8, XLI: -0.4, XLB: 0.1, XLRE: -0.2, AAPL: -1.2, NVDA: -6.5, MSFT: -2.0, AMD: -7.2, JPM: 0.5, XOM: 2.9, SPY: -1.4, TSLA: 3.1, ORCL: 1.0 }, over.chg || {});
  const px = { "^GSPC": 6500, "^VIX": 24, "^TNX": 4.3, "CL=F": 71 };
  const calls = { quotes: 0, trades: 0 };
  const quote = (s) => ({ symbol: s, name: s + " Inc", price: px[s] || 100, prevClose: (px[s] || 100) / (1 + (chg[s] || 0) / 100), change: s === "^TNX" ? 0.09 : (px[s] || 100) * (chg[s] || 0) / 100, changePct: chg[s] || 0, marketTime: T - 60e3, volume: 3e7, high52: 150, low52: 60 });
  const hist = (s, range) => { const n = 260, c = []; let p = 80 + (s.charCodeAt(0) % 20); const seed = s.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
    for (let i = 0; i < n; i++) { const shared = Math.sin(i * 0.7) * 0.01; p *= 1 + shared + Math.sin(i * 1.3 + seed) * 0.004 + 0.0005; c.push({ time: Math.floor((T - (n - i) * 864e5) / 1000), open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e7 }); }
    return { symbol: s, name: s + " Inc", candles: c }; };
  const SPL = [["AAPL", "Apple Inc.", "Information Technology", "Technology Hardware"], ["NVDA", "Nvidia", "Information Technology", "Semiconductors"], ["AMD", "Advanced Micro Devices", "Information Technology", "Semiconductors"], ["MSFT", "Microsoft", "Information Technology", "Systems Software"], ["JPM", "JPMorgan Chase", "Financials", "Diversified Banks"], ["XOM", "ExxonMobil", "Energy", "Integrated Oil & Gas"], ["TSLA", "Tesla, Inc.", "Consumer Discretionary", "Automobile Manufacturers"], ["ORCL", "Oracle Corporation", "Information Technology", "Application Software"], ["AVGO", "Broadcom", "Information Technology", "Semiconductors"], ["CVX", "Chevron Corporation", "Energy", "Integrated Oil & Gas"], ["COP", "ConocoPhillips", "Energy", "Oil & Gas E&P"]];
  const deps = {
    now: clock.now, holidays: new Set(["2026-11-26"]), earlyClose: new Set(["2026-11-27"]), sp500List: SPL,
    quotes: async (syms) => { calls.quotes++; return { quotes: Object.fromEntries(syms.map((s) => [s, quote(s)])) }; },
    history: async (s, r) => hist(s, r),
    news: async (tickers) => ({ sources: { yahoo: { ok: true }, cnbc: { ok: true } }, items: [
      { id: "1", source: "cnbc", title: "Nvidia (NVDA) shares plunge after export curbs on AI chips", link: "https://cnbc.com/a", time: T - 3600e3, tickers: ["NVDA"] },
      { id: "2", source: "yahoo", title: "AMD (AMD) stock tumbles as chip export rules tighten", link: "https://finance.yahoo.com/b", time: T - 2 * 3600e3, tickers: ["AMD"] },
      { id: "3", source: "wsj", title: "Broadcom (AVGO) slides with chip stocks on export fears", link: "https://wsj.com/c", time: T - 2 * 3600e3, tickers: [] },
      { id: "4", source: "cnbc", title: "Fed's Powell says rate cuts remain on the table", link: "https://cnbc.com/d", time: T - 4 * 3600e3, tickers: [] },
      ...Array.from({ length: 7 }, (_, i) => ({ id: "f" + i, source: "yahoo", title: `Fed officials weigh interest rates path ${i}`, link: "https://finance.yahoo.com/f" + i, time: T - 5 * 3600e3, tickers: [] })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: "n" + i, source: "yahoo", title: `Nvidia (NVDA) falls as investors weigh outlook ${i}`, link: "https://finance.yahoo.com/n" + i, time: T - 6 * 3600e3, tickers: ["NVDA"] })),
    ].filter((i) => !tickers.length || true) }),
    trending: async () => ({ items: [{ title: "Nvidia (NVDA) shares plunge after export curbs on AI chips" }] }),
    smart: async () => ({ items: [{ g: "policy", src: "fed", name: "Federal Reserve", title: "Federal Reserve issues FOMC statement", link: "https://www.federalreserve.gov/x", time: T - 1800e3 }, { g: "policy", src: "bls", name: "Bureau of Labor Statistics", title: "Consumer Price Index – October 2026", link: "https://www.bls.gov/cpi", time: T - 3 * 864e5 }] }),
    sp500: async () => ({ updated: T, quotes: Object.fromEntries([...SPL.map((r) => [r[0], [100, 1, chg[r[0]] ?? 0.5, 1e11]]), ["CVX", [100, 6, 6.1, 3e11]], ["COP", [100, 5, 5.6, 1e11]]]) }),
    earnings: async (syms) => ({ source: "Finnhub", yours: syms.includes("AAPL") ? [{ symbol: "AAPL", date: "2026-11-12", hour: "amc", epsEstimate: 1.62, revenueEstimate: 9e10 }] : [], notable: [{ symbol: "ORCL", date: "2026-11-12", hour: "amc", epsEstimate: 1.3 }] }),
    earningsActuals: async () => [{ symbol: "MSFT", date: "2026-11-10", hour: "amc", epsActual: 3.4, epsEstimate: 3.0 }],
    macro: async () => ({ source: "FRED", series: [{ id: "UNRATE", name: "Unemployment rate", unit: "%", freq: "Monthly", data: [["2026-08-01", 4.2], ["2026-09-01", over.unrate || 4.3]], src: "BLS via FRED" }, { id: "T10Y3M", name: "Yield curve 10y-3m", unit: "pts", freq: "Daily", daily: true, data: [["2026-11-09", 0.2], ["2026-11-10", -0.1]] }, { id: "SAHMREALTIME", name: "Sahm rule", unit: "pts", freq: "Monthly", data: [["2026-08-01", 0.3], ["2026-09-01", 0.35]] }] }),
    filings: async (syms) => ({ filings: Object.fromEntries(syms.filter((s) => s !== "VOO").map((s) => [s, { name: s + " Inc", k: { acc: s + "-k1", date: "2026-10-30", form: "10-K", url: "https://www.sec.gov/k" }, q: { acc: s + "-q" + (over.qv || 1), date: "2026-11-10", form: "10-Q", period: "2026-09-27", url: "https://www.sec.gov/q" }, er: { acc: s + "-er1", date: "2026-11-10", form: "8-K", url: "https://www.sec.gov/er" }, f4: { acc: s + "-f4", date: "2026-11-09", form: "4", n30: 3, url: "https://www.sec.gov/f4" } }])) }),
    release: async (s) => ({ symbol: s, available: true, title: s + " reports record results", filing: { form: "8-K", filed: "2026-11-10", accession: s + "-er1", url: "https://www.sec.gov/er" }, paragraphs: [{ sents: [...Array(8)].map(() => ({ tone: "bull" })).concat([{ tone: "bear", hedge: "headwinds" }]) }], guidance: [{ metric: "Revenue", value: "90 billion", period: "Q4" }] }),
    insiders: async (s) => ({ available: true, filings: [{ owner: "Jane Doe", role: "Director", accession: s + "-f4", url: "https://www.sec.gov/f4", tx: [{ date: "2026-11-05", code: "P", shares: 1000, price: 100, value: 1e5 }] }, { owner: "John Roe", role: "CFO", officer: true, accession: s + "-f4b", url: "https://www.sec.gov/f4b", tx: [{ date: "2026-11-06", code: "P", shares: 2000, price: 99, value: 1.98e5 }] }] }),
    fundamentals: async (s) => ({ available: true, cik: 320193, years: [{ end: "2025-09-27", revenue: 390e9, netIncome: 95e9, cfo: 110e9, capex: 10e9, fcf: 100e9, totalAssets: 360e9, grossProfit: 170e9, operatingIncome: 120e9, currentAssets: 140e9, currentLiabilities: 150e9 }, { end: "2026-09-26", revenue: over.rev || 410e9, netIncome: 100e9, cfo: 120e9, capex: 11e9, fcf: 109e9, totalAssets: 365e9, grossProfit: 182e9, operatingIncome: 128e9, currentAssets: 145e9, currentLiabilities: 150e9, _filed: "2026-10-30", _form: "10-K" }] }),
    health: FINS.health, analyst: (s) => (s === "ORCL" ? { adj: 1.2, n: 30 } : { adj: 0.4, n: 10 }),
    trader: () => ({ positions: { NVDA: { shares: 5, cost: 120 }, XOM: { shares: 4, cost: 100 } }, lastScan: { t: T, riskOff: false, stress: null, top: [{ sym: "XOM", rank: 1 }, { sym: "TSLA", rank: 2 }] }, plan: null, trades: [{ t: T - 3600e3, side: "BUY", sym: "XOM", why: "Ranked #1" }], apTrade: () => { calls.trades++; throw new Error("the Spider must never trade"); } }),
    tone: (t) => (/plunge|tumble|slide|falls/i.test(t) ? -2 : /beat|surge|record/i.test(t) ? 2 : 0),
    matcher: (sym, name) => new RegExp(`\\(${sym}\\)|\\b${name.split(" ")[0]}\\b`, "i"),
    sourceName: (k) => ({ cnbc: "CNBC", yahoo: "Yahoo Finance", wsj: "Wall Street Journal" }[k] || k),
    ...over.deps,
  };
  return { deps, clock, calls };
}
module.exports = { makeDeps };

// Personal Stock News Hub — zero-dependency Node.js server (Node 18+)
// Pulls headlines from Yahoo Finance, CNBC, Morningstar, Seeking Alpha and
// The Wall Street Journal, plus live quotes, and serves the dashboard in /public.
//
//   node server.js            -> http://localhost:3000
//   PORT=8080 node server.js

const http = require("http");
const { AsyncLocalStorage } = require("node:async_hooks");
const costCtx = new AsyncLocalStorage(); // adds up what each request spends on Claude
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const FINNHUB = process.env.FINNHUB_API_KEY;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------------------------------------------------------------- sources
const isCrypto = (t) => /-USD$/.test(t);
const base = (t) => t.replace(/-USD$/, "");
const kind = (t) => (isCrypto(t) ? "crypto" : "stock");
const gnews = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const SOURCES = {
  yahoo: {
    name: "Yahoo Finance",
    domain: "finance.yahoo.com",
    market: ["https://finance.yahoo.com/news/rssindex"],
    ticker: (t) => [`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${t}&region=US&lang=en-US`],
  },
  cnbc: {
    name: "CNBC",
    domain: "cnbc.com",
    market: [
      "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114", // top news
      "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069", // investing
      "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839135", // earnings
      "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", // finance
    ],
    ticker: (t) => [gnews(`${base(t)} ${kind(t)} site:cnbc.com when:7d`)],
  },
  morningstar: {
    name: "Morningstar",
    domain: "morningstar.com",
    market: [gnews("site:morningstar.com stocks when:3d"), gnews("site:morningstar.com markets when:3d")],
    ticker: (t) => [gnews(`${base(t)} ${isCrypto(t) ? "crypto " : ""}site:morningstar.com when:14d`)],
  },
  seekingalpha: {
    name: "Seeking Alpha",
    domain: "seekingalpha.com",
    market: ["https://seekingalpha.com/market_currents.xml", "https://seekingalpha.com/feed.xml"],
    ticker: (t) => [`https://seekingalpha.com/api/sa/combined/${t}.xml`],
  },
  wsj: {
    name: "Wall Street Journal",
    domain: "wsj.com",
    // WSJ's own RSS feeds have gone stale, so fresh WSJ headlines come via Google News
    market: [
      gnews("site:wsj.com markets when:2d"),
      gnews("site:wsj.com stocks when:2d"),
      gnews("site:wsj.com economy when:2d"),
      gnews("site:wsj.com business when:2d"),
      gnews("site:wsj.com tech when:2d"),
      "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
    ],
    ticker: (t) => [gnews(`${base(t)} ${kind(t)} site:wsj.com when:7d`)],
  },
};

// ---------------------------------------------------------------- cache
const cache = new Map(); // url -> {at, data, promise}
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.data !== undefined && Date.now() - hit.at < ttlMs) return hit.data;
  if (hit && hit.promise) return hit.promise;
  const promise = fn()
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .catch((e) => {
      if (hit && hit.data !== undefined) {
        cache.set(key, { ...hit, promise: null });
        return hit.data; // serve last good copy
      }
      cache.delete(key);
      throw e;
    });
  cache.set(key, { ...(hit || {}), promise });
  return promise;
}

// Keep memory in check on the small free server: drop cache entries unused for 12 hours,
// and if there are still too many, drop the oldest.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (!v.promise && v.at && now - v.at > 12 * 3600e3) cache.delete(k);
  if (cache.size > 6000) [...cache.entries()].filter(([, v]) => !v.promise).sort((a, b) => (a[1].at || 0) - (b[1].at || 0)).slice(0, cache.size - 5000).forEach(([k]) => cache.delete(k));
}, 10 * 60e3).unref();

async function get(url, accept = "*/*") {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ---------------------------------------------------------------- RSS / Atom parsing
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
}
const stripTags = (s) => decode(decode(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let link = stripTags(tag(b, "link"));
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = decode(m[1]);
    }
    const date = stripTags(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"));
    const t = Date.parse(date);
    items.push({
      title: stripTags(tag(b, "title")),
      link,
      summary: stripTags(tag(b, "description") || tag(b, "summary")).slice(0, 280),
      time: isNaN(t) ? null : t,
      publisher: stripTags(tag(b, "source")),
    });
  }
  return items.filter((i) => i.title && i.link);
}

async function fetchFeed(url) {
  return cached("feed:" + url, 60_000, async () =>
    parseFeed(await get(url, "application/rss+xml, application/xml, text/xml, */*"))
  );
}

// Tiny headline sentiment lexicon: +1 positive, -1 negative, 0 neutral
const POS = /\b(beat|beats|surge[sd]?|soar(s|ed)?|jump(s|ed)?|rall(y|ies|ied)|record high|upgrade[sd]?|raise[sd]? (guidance|forecast|outlook|dividend)|strong|gain(s|ed)?|rise[sn]?|rising|tops?|outperform(s)?|bullish|boost(s|ed)?|wins?|approv(al|es|ed)|buyback|breakout|accelerat\w+|blowout|rebound(s|ed)?|climb(s|ed)?)\b/gi;
const NEG = /\b(miss(es|ed)?|plunge[sd]?|fall(s|en)?|fell|drop(s|ped)?|slump(s|ed)?|downgrade[sd]?|cuts?|weak(er|ness)?|loss(es)?|lawsuit|probe|recall(s|ed)?|bearish|warns?|warning|sell-?off|layoffs?|declin(e|es|ed)|sink(s)?|sank|tumble[sd]?|fears?|crash(es|ed)?|slash(es|ed)?|investigation|halt(s|ed)?|bankrupt\w*|default(s)?|lower(s|ed)? (guidance|forecast|outlook)|slid(es)?|slide|worst)\b/gi;
function sentiment(text) {
  const p = (text.match(POS) || []).length, n = (text.match(NEG) || []).length;
  return p > n ? 1 : n > p ? -1 : 0;
}

function cleanItem(it, srcKey, ticker) {
  const src = SOURCES[srcKey];
  let title = it.title;
  // Google News appends " - Publisher" to titles
  if (it.link.includes("news.google.com")) {
    title = title.replace(/\s+-\s+[^-]+$/, "");
    const who = { wsj: /wall street journal|\bwsj\b/i, yahoo: /yahoo/i, cnbc: /cnbc/i, morningstar: /morningstar/i, seekingalpha: /seeking ?alpha/i }[srcKey];
    if (it.publisher && who && !who.test(it.publisher)) return null;
  }
  // Google News descriptions are just HTML link lists — drop them
  const summary = it.link.includes("news.google.com") ? "" : it.summary;
  return {
    id: (srcKey + "|" + title).toLowerCase().replace(/\W+/g, "").slice(0, 120),
    source: srcKey,
    title,
    link: it.link,
    summary,
    time: it.time,
    mood: sentiment(title),
    tickers: ticker ? [ticker] : [],
    pct: it._pct ?? 0.5, // position in the outlet's own feed: 0 = its top story, 1 = its last
  };
}

async function loadSource(srcKey, urls, ticker) {
  const src = SOURCES[srcKey];
  const results = await Promise.allSettled(urls.map(fetchFeed));
  const ranked = (list) => list.map((it, i, a) => ({ ...it, _pct: a.length > 1 ? i / (a.length - 1) : 0 }));
  let items = results.flatMap((r) => (r.status === "fulfilled" ? ranked(r.value) : []));
  const fresh = (list) => list.some((i) => i.time && i.time > Date.now() - 3 * 86400e3);
  let ok = results.some((r) => r.status === "fulfilled" && r.value.length && fresh(r.value));
  // Fallback: if the outlet's own feed failed, use Google News for that site
  if (!ok) {
    const q = ticker ? `${base(ticker)} ${kind(ticker)} site:${src.domain} when:7d` : `site:${src.domain} stocks when:2d`;
    try {
      items = items.concat(ranked(await fetchFeed(gnews(q))));
      ok = fresh(items);
    } catch {}
  }
  return { ok, items: items.map((i) => cleanItem(i, srcKey, ticker)).filter(Boolean) };
}

const TICKER_RE = /^[A-Z0-9.\-^=]{1,12}$/;

// ---------------------------------------------------------------- news archive (older headlines)
// RSS feeds only hold the latest stories, so older news comes from Google News
// searches limited to each outlet's site and split into date windows.
const RANGE_DAYS = { today: 1, "24h": 1, week: 7, month: 31, "6m": 183, year: 366, all: null };
const DOMAINS = { yahoo: "finance.yahoo.com", cnbc: "cnbc.com", morningstar: "morningstar.com", seekingalpha: "seekingalpha.com", wsj: "wsj.com" };
function newsWindows(range) {
  const day = 86400e3, now = Date.now();
  const make = (n, len) => Array.from({ length: n }, (_, i) => [now - (i + 1) * len, now - i * len]);
  if (range === "week") return make(2, 4 * day);
  if (range === "month") return make(4, 8 * day);
  if (range === "6m") return make(6, 31 * day);
  if (range === "year") return make(12, 31 * day);
  if (range === "all") return [...make(12, 31 * day), ...Array.from({ length: 9 }, (_, i) => [now - (i + 2) * 365 * day, now - (i + 1) * 365 * day])];
  return [];
}
async function pool(tasks, n) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k]().catch(() => []); } }));
  return out;
}
async function newsArchive(range, tickers) {
  const wins = newsWindows(range);
  if (!wins.length) return [];
  const tk = tickers.filter((t) => !/[\^=]/.test(t)).slice(0, 8).map(base);
  return cached(`arch:${range}:${tk.join(",")}`, range === "week" ? 30 * 60e3 : 6 * 3600e3, async () => {
    const d = (t) => new Date(t).toISOString().slice(0, 10);
    const tasks = [];
    for (const [a, b] of wins) for (const key of Object.keys(SOURCES)) {
      const when = `after:${d(a)} before:${d(b + 86400e3)}`;
      tasks.push(() => fetchFeed(gnews(`site:${DOMAINS[key]} (stocks OR markets OR economy OR earnings) ${when}`)).then((l) => l.map((i) => cleanItem(i, key, null))));
      if (tk.length && range !== "all") tasks.push(() => fetchFeed(gnews(`(${tk.join(" OR ")}) site:${DOMAINS[key]} ${when}`)).then((l) => l.map((i) => cleanItem(i, key, null))));
    }
    return (await pool(tasks, 8)).flat().filter(Boolean);
  });
}

async function getNews(tickers, range) {
  const jobs = [];
  for (const key of Object.keys(SOURCES)) {
    jobs.push(loadSource(key, SOURCES[key].market, null).then((r) => ({ key, ...r })));
    for (const t of tickers) jobs.push(loadSource(key, SOURCES[key].ticker(t), t).then((r) => ({ key, ...r })));
  }
  const [done, older] = await Promise.all([Promise.all(jobs), newsArchive(range, tickers).catch(() => [])]);
  done.push({ key: "archive", ok: false, items: older });
  const status = {};
  const byId = new Map();
  for (const { key, ok, items } of done) {
    if (key !== "archive") status[key] = status[key] || ok;
    for (const it of items) {
      const prev = byId.get(it.id);
      if (prev) prev.tickers = [...new Set([...prev.tickers, ...it.tickers])];
      else byId.set(it.id, it);
    }
  }
  // Tag market headlines that mention a watched ticker, e.g. "(AAPL)" or "$AAPL" or " AAPL "
  for (const it of byId.values()) {
    for (const t of tickers) {
      if (it.tickers.includes(t)) continue;
      const b = base(t);
      if (new RegExp(`(^|[\\s($])${b.replace(/[.^=]/g, "\\$&")}([\\s),:'’]|$)`).test(it.title)) it.tickers.push(t);
    }
  }
  const days = range in RANGE_DAYS ? RANGE_DAYS[range] : 21;
  const since = days ? Date.now() - days * 86400e3 : 0;
  const recent = [...byId.values()]
    .filter((i) => !i.time || i.time >= since)
    .sort((a, b) => (b.time || 0) - (a.time || 0));
  // Keep a fair share from every outlet (stories about your tickers always stay)
  const long = !days || days > 7;
  // Long timelines: keep a fair share per outlet per month so older periods aren't crowded out
  const per = {};
  const items = recent.filter((i) => {
    const k = i.source + (long ? ":" + new Date(i.time || 0).toISOString().slice(0, 7) : "");
    per[k] = (per[k] || 0) + 1;
    return i.tickers.length ? per[k] <= (long ? 120 : 1e9) : per[k] <= (long ? 60 : 90);
  }).slice(0, long ? 6000 : 500);
  return {
    updated: Date.now(),
    sources: Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, { name: s.name, ok: !!status[k] }])),
    items,
  };
}



// ---------------------------------------------------------------- "Most popular" signals
// No outlet publishes view counts. The best free stand-ins: Google News' Business "Top stories" (ranked by
// importance, and each story lists how many publishers across the web cover it) and CNBC's editor-picked Top News.
const TREND_FEEDS = [
  { key: "google", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en" },
  { key: "google", url: "https://news.google.com/rss/search?q=stock+market+OR+stocks+OR+economy+when:1d&hl=en-US&gl=US&ceid=US:en" },
  { key: "cnbc", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114" },
];
async function getTrending() {
  return cached("trending", 10 * 60_000, async () => {
    const out = [];
    await Promise.all(TREND_FEEDS.map(async (f, fi) => {
      try {
        const xml = await get(f.url, "application/rss+xml, application/xml, text/xml");
        const items = xml.split(/<item[\s>]/).slice(1);
        items.forEach((raw, i) => {
          const t = (raw.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
          const d = decode((raw.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "");
          const title = decode(t.replace(/<!\[CDATA\[|\]\]>/g, "")).replace(/\s+-\s+[^-]+$/, "").trim();
          if (!title) return;
          // Google lists the other publishers covering the same story inside the description
          const related = f.key === "google" ? Math.max(1, (d.match(/<li>/gi) || []).length) : 1;
          out.push({ title, feed: f.key, list: fi, rank: i, of: items.length, related });
        });
      } catch {}
    }));
    return { updated: Date.now(), items: out };
  });
}

// ---------------------------------------------------------------- Smart Money (free feeds: regulators, newsletters, earnings calls, Reddit)
const SMART = [
  { g: "policy", key: "fed", name: "Federal Reserve", urls: ["https://www.federalreserve.gov/feeds/press_all.xml", gnews("site:federalreserve.gov when:14d")], days: 21 },
  { g: "policy", key: "sec", name: "SEC", urls: ["https://www.sec.gov/news/pressreleases.rss", gnews("site:sec.gov press release when:14d")], days: 21 },
  { g: "policy", key: "treasury", name: "U.S. Treasury", urls: [gnews("site:home.treasury.gov when:14d")], days: 21 },
  { g: "policy", key: "bls", name: "Bureau of Labor Statistics", urls: ["https://www.bls.gov/feed/bls_latest.rss", gnews("site:bls.gov when:14d")], days: 21 },
  { g: "letters", key: "abnormal", name: "Abnormal Returns", urls: ["https://abnormalreturns.com/feed/"], days: 10 },
  { g: "letters", key: "carlson", name: "A Wealth of Common Sense", urls: ["https://awealthofcommonsense.com/feed/"], days: 21 },
  { g: "letters", key: "batnick", name: "The Irrelevant Investor", urls: ["https://theirrelevantinvestor.com/feed/", "https://theirrelevantinvestor.com/feed/?x=1", gnews("site:theirrelevantinvestor.com when:30d")], days: 21 },
  { g: "letters", key: "netinterest", name: "Net Interest", urls: ["https://www.netinterest.co/feed"], days: 30 },
  { g: "letters", key: "apricitas", name: "Apricitas Economics", urls: ["https://www.apricitas.io/feed"], days: 30 },
  { g: "letters", key: "overshoot", name: "The Overshoot", urls: ["https://theovershoot.co/feed"], days: 30 },
  { g: "letters", key: "kyla", name: "Kyla Scanlon", urls: ["https://kyla.substack.com/feed"], days: 30 },
  { g: "letters", key: "calcrisk", name: "Calculated Risk", urls: ["https://www.calculatedriskblog.com/feeds/posts/default?alt=rss", "https://www.calculatedriskblog.com/feeds/posts/default", gnews("site:calculatedriskblog.com when:7d")], days: 7 },
  { g: "calls", key: "calls", name: "Earnings calls", urls: [gnews('"earnings call" CEO said when:3d'), gnews('"conference call" guidance analysts when:3d')], days: 4 },
  { g: "reddit", key: "r_investing", name: "r/investing", urls: ["https://www.reddit.com/r/investing/top/.rss?t=day", "https://old.reddit.com/r/investing/top/.rss?t=day"], days: 3 },
  { g: "reddit", key: "r_stocks", name: "r/stocks", urls: ["https://www.reddit.com/r/stocks/top/.rss?t=day", "https://old.reddit.com/r/stocks/top/.rss?t=day"], days: 3 },
  { g: "reddit", key: "r_secanalysis", name: "r/SecurityAnalysis", urls: ["https://www.reddit.com/r/SecurityAnalysis/top/.rss?t=week", "https://old.reddit.com/r/SecurityAnalysis/top/.rss?t=week"], days: 10 },
];
async function smartSource(src) {
  for (const url of src.urls) {
    try {
      const items = await fetchFeed(url);
      if (!items.length) continue;
      const since = Date.now() - src.days * 86400e3;
      const isG = url.includes("news.google.com"), isR = url.includes("reddit.com");
      const out = items.filter((i) => !i.time || i.time >= since).slice(0, 10).map((i) => ({
        g: src.g, src: src.key, name: isG && src.g === "calls" && i.publisher ? i.publisher : src.name,
        title: isG ? i.title.replace(/\s+-\s+[^-]+$/, "") : i.title,
        link: i.link, time: i.time,
        summary: isG || isR ? "" : i.summary.replace(/The post .* appeared first on .*$/i, "").trim().slice(0, 240),
      }));
      if (out.length) return { ok: true, items: out };
    } catch {}
  }
  return { ok: false, items: [] };
}
async function getSmart() {
  return cached("smart", 10 * 60_000, async () => {
    let ri = 0; const perHost = {};
    const res = await Promise.all(SMART.map(async (s) => {
      const host = (s.urls[0].match(/\/\/([^/]+)/) || [])[1] || "";
      const k = /substack|apricitas|overshoot|netinterest/.test(host) ? "substack" : host;
      if (s.g !== "reddit") { await new Promise((ok) => setTimeout(ok, 1200 * (perHost[k] = (perHost[k] || 0) + 1) - 1200)); }
      if (s.g === "reddit") { await new Promise((ok) => setTimeout(ok, 1800 * ri++)); let r = await smartSource(s); if (!r.ok) { await new Promise((ok) => setTimeout(ok, 4000)); r = await smartSource({ ...s, urls: s.urls.map((u) => u + "&limit=15") }); } return { s, ...r }; }
      return { s, ...(await smartSource(s)) };
    }));
    const seen = new Set(), items = [];
    for (const r of res) for (const it of r.items) { const k = it.title.toLowerCase().replace(/\W+/g, "").slice(0, 80); if (!seen.has(k)) { seen.add(k); items.push(it); } }
    items.sort((a, b) => (b.time || 0) - (a.time || 0));
    return { updated: Date.now(), sources: res.map((r) => ({ key: r.s.key, name: r.s.name, g: r.s.g, ok: r.ok })), items };
  });
}

// ---------------------------------------------------------------- quotes (Yahoo Finance chart API)
async function quote(sym) {
  return cached("q:" + sym, 15_000, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m&includePrePost=true`;
    const j = JSON.parse(await get(url, "application/json"));
    const r = j.chart && j.chart.result && j.chart.result[0];
    if (!r) throw new Error("no data");
    const m = r.meta;
    const closes = (r.indicators.quote[0].close || []).filter((x) => x != null);
    const price = m.regularMarketPrice ?? closes[closes.length - 1];
    const prev = m.chartPreviousClose ?? m.previousClose;
    return {
      symbol: m.symbol,
      name: m.shortName || m.longName || m.symbol,
      price,
      prevClose: prev,
      change: price - prev,
      changePct: prev ? ((price - prev) / prev) * 100 : 0,
      currency: m.currency,
      exchange: m.fullExchangeName || m.exchangeName,
      marketTime: (m.regularMarketTime || 0) * 1000,
      dayHigh: m.regularMarketDayHigh,
      dayLow: m.regularMarketDayLow,
      volume: m.regularMarketVolume,
      high52: m.fiftyTwoWeekHigh,
      low52: m.fiftyTwoWeekLow,
      spark: closes.length > 60 ? closes.filter((_, i) => i % Math.ceil(closes.length / 60) === 0) : closes,
    };
  });
}

async function getQuotes(symbols) {
  const out = await Promise.allSettled(symbols.map(quote));
  return {
    updated: Date.now(),
    quotes: Object.fromEntries(
      symbols.map((s, i) => [s, out[i].status === "fulfilled" ? out[i].value : { symbol: s, error: true }])
    ),
  };
}

// ---------------------------------------------------------------- history (candles)
const RANGES = {
  intraday: ["1d", "1m"], intraday5: ["5d", "5m"],
  "1d": ["1d", "5m"], "5d": ["5d", "15m"], "1mo": ["1mo", "1h"], "6mo": ["6mo", "1d"],
  ytd: ["ytd", "1d"], "1y": ["1y", "1d"], "5y": ["5y", "1wk"], max: ["max", "1mo"],
};
// Explicit period + candle length (used by the Trading Sim). Only combinations Yahoo serves are allowed.
const HIST_RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y", "max"]);
const HIST_IVS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "1h", "1d", "1wk", "1mo"]);
async function history(sym, range = "6mo", interval) {
  let [r, iv] = RANGES[range] || RANGES["6mo"];
  if (interval && HIST_IVS.has(interval) && HIST_RANGES.has(range)) { r = range; iv = interval === "1h" ? "60m" : interval; }
  return cached(`h:${sym}:${r}:${iv}`, r === "1d" || r === "5d" ? (iv === "1m" ? 15_000 : 30_000) : 10 * 60_000, async () => {
    const qs = `${encodeURIComponent(sym)}?range=${r}&interval=${iv}${range && range.startsWith("intraday") ? "&includePrePost=true" : ""}`;
    const key = `${sym}:${r}:${iv}`;
    // Yahoo throttles bursts of clicks: try both hosts with a short pause, and fall back to the last good copy
    let res = null, lastErr;
    for (const [i, host] of ["query1", "query2", "query1"].entries()) {
      try {
        if (i) await new Promise((ok) => setTimeout(ok, 600 * i));
        const j = JSON.parse(await get(`https://${host}.finance.yahoo.com/v8/finance/chart/${qs}`, "application/json"));
        res = j.chart && j.chart.result && j.chart.result[0];
        if (res && res.timestamp) break;
        if (j.chart && j.chart.error) { lastErr = new Error(j.chart.error.description || "no history"); break; } // a bad symbol: don't retry
        res = null;
      } catch (e) { lastErr = e; }
    }
    if (!res || !res.timestamp) { if (HIST_LAST.has(key)) return HIST_LAST.get(key); throw lastErr || new Error("no history"); }
    const q = res.indicators.quote[0];
    const candles = [];
    res.timestamp.forEach((t, i) => {
      if (q.open[i] == null || q.close[i] == null) return;
      candles.push({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
    });
    const out = { symbol: res.meta.symbol, name: res.meta.shortName || res.meta.symbol, range: r, interval: iv, candles };
    HIST_LAST.set(key, out); if (HIST_LAST.size > 400) HIST_LAST.delete(HIST_LAST.keys().next().value);
    return out;
  });
}
const HIST_LAST = new Map(); // last good chart per symbol/range, served if Yahoo is throttling



// ---------------------------------------------------------------- S&P 500 snapshot (Wall Street tab)
// One shared, cached snapshot of all ~503 companies: price, change and market cap.
// Tries Yahoo's bulk quote (needs a crumb), then falls back to the spark endpoint in batches of 20.
const SP500 = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "public", "sp500.json"), "utf8")).rows; } catch { return []; } })();
const spCaps = {}; // remembered market caps, so the map keeps its shape if the bulk endpoint is blocked
// Company sizes when Yahoo's bulk quote is blocked: shares outstanding from Finnhub (free tier ~60/min),
// gathered slowly in the background and saved to a file; market value = shares × live price.
const SHARES_FILE = path.join(require("os").tmpdir(), "sp500-shares.json");
const spShares = (() => { try { return JSON.parse(fs.readFileSync(SHARES_FILE, "utf8")); } catch { return {}; } })();
let shareJob = null;
function startShareJob() {
  if (shareJob || !FINNHUB || !SP500.length) return;
  const todo = SP500.map(r => r[0]).filter(s => !spShares[s] && !spCaps[s]);
  if (!todo.length) return;
  shareJob = (async () => {
    let n = 0;
    for (const s of todo) {
      if (spShares[s] || spCaps[s]) continue; // already sized by the live quote feed, no need to ask Finnhub
      try {
        const j = JSON.parse(await get(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(s.replace("-", "."))}&token=${FINNHUB}`, "application/json"));
        if (j && j.shareOutstanding) spShares[s] = j.shareOutstanding * 1e6;
      } catch (e) { if (/429/.test(String(e.message))) await new Promise(r => setTimeout(r, 30_000)); }
      if (++n % 20 === 0) { try { fs.writeFileSync(SHARES_FILE, JSON.stringify(spShares)); } catch {} cache.delete && cache.delete("sp500"); }
      await new Promise(r => setTimeout(r, 1500)); // stay well under Finnhub's free limit (other features use it too)
    }
    try { fs.writeFileSync(SHARES_FILE, JSON.stringify(spShares)); } catch {}
    shareJob = null;
  })();
}

// ---------------------------------------------------------------- Best Buys / Best Sells: the WHOLE US market
// A slow, continuous background scan of every common stock on the NYSE, Nasdaq and NYSE American using Finnhub's
// free analyst-recommendation data (~45 requests/min, under the free limit). Largest companies first, then the rest;
// each stock is re-rated daily and the rankings update as the scan goes. Saved to a temp file between restarts.
const BB_FILE = path.join(require("os").tmpdir(), "best-buys-market.json");
let BB = (() => { try { const j = JSON.parse(fs.readFileSync(BB_FILE, "utf8")); return j.ratings ? j : null; } catch { return null; } })()
  || { ratings: {}, metrics: {}, names: {}, universe: [], uniAt: 0 };
let bbJob = null;
const BB_PAUSE = +process.env.BB_PAUSE_MS || 1350; // ~45 Finnhub calls a minute
const BB_MIN_N = 5, BB_PRIOR = 0.6, BB_K = 6; // shrink thinly-covered stocks toward an average rating
function bbAdj(r) { return (2 * r.sb + r.b - r.s - 2 * r.ss + BB_PRIOR * BB_K) / (r.n + BB_K); }
function bbRank() {
  const all = Object.entries(BB.ratings).filter(([, r]) => r && r.n >= BB_MIN_N).map(([sym, r]) => ({ sym, ...r, adj: bbAdj(r) }));
  all.sort((a, b) => b.adj - a.adj || b.n - a.n);
  return { all, top: all.slice(0, 20), bottom: all.slice(-15).reverse() };
}
function bbSave() { try { fs.writeFileSync(BB_FILE, JSON.stringify(BB)); } catch {} }
function startBestBuys() {
  if (bbJob || !FINNHUB) return;
  bbJob = (async () => {
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const call = async (p) => { try { return await fh(p); } catch (e) { if (/429/.test(String(e.message))) await pause(30_000); return null; } finally { await pause(BB_PAUSE); } };
    for (;;) {
      // 1) the universe: every US common stock on the major exchanges (refreshed daily)
      if (!BB.universe.length || Date.now() - BB.uniAt > 24 * 3600e3) {
        const list = await call("/stock/symbol?exchange=US");
        if (Array.isArray(list) && list.length) {
          const MICS = new Set(["XNYS", "XNAS", "XASE", "ARCX", "BATS"]);
          const keep = list.filter((x) => x.type === "Common Stock" && MICS.has(x.mic) && /^[A-Z]{1,5}(\.[A-Z])?$/.test(x.symbol));
          keep.forEach((x) => (BB.names[x.symbol] = x.description));
          let snap = {}; try { snap = (await sp500Snapshot()).quotes || {}; } catch {}
          const sp = SP500.map((r) => r[0].replace("-", ".")).sort((a, b) => ((snap[b.replace(".", "-")] || [])[3] || 0) - ((snap[a.replace(".", "-")] || [])[3] || 0));
          const spSet = new Set(sp);
          BB.universe = [...sp, ...keep.map((x) => x.symbol).filter((s) => !spSet.has(s)).sort((a, b) => a.length - b.length || a.localeCompare(b))];
          BB.uniAt = Date.now(); bbSave();
        } else if (!BB.universe.length) { await pause(10 * 60_000); continue; }
      }
      // 2) rate the stock whose rating is oldest (never-rated first)
      const due = BB.universe.find((s) => !BB.ratings[s] || Date.now() - BB.ratings[s].t > 24 * 3600e3);
      if (!due) { await pause(10 * 60_000); continue; }
      const rec = await call(`/stock/recommendation?symbol=${encodeURIComponent(due)}`);
      const r = Array.isArray(rec) && rec[0];
      BB.ratings[due] = r ? { t: Date.now(), period: r.period, sb: r.strongBuy || 0, b: r.buy || 0, h: r.hold || 0, s: r.sell || 0, ss: r.strongSell || 0,
        n: (r.strongBuy || 0) + (r.buy || 0) + (r.hold || 0) + (r.sell || 0) + (r.strongSell || 0) } : { t: Date.now(), n: 0 };
      // 3) every 25 stocks: re-rank, fetch valuation/growth for any new finalists, save
      if (Object.keys(BB.ratings).length % 25 === 0) {
        const { top, bottom } = bbRank();
        for (const f of [...top.slice(0, 14), ...bottom.slice(0, 12)]) {
          const m = BB.metrics[f.sym];
          if (m && Date.now() - m.t < 24 * 3600e3) continue;
          const j = await call(`/stock/metric?symbol=${encodeURIComponent(f.sym)}&metric=all`);
          const x = (j && j.metric) || {};
          BB.metrics[f.sym] = { t: Date.now(), hi52: x["52WeekHigh"] ?? null, lo52: x["52WeekLow"] ?? null, pe: x.peTTM ?? x.peBasicExclExtraTTM ?? null, revG: x.revenueGrowthTTMYoy ?? null, epsG: x.epsGrowthTTMYoy ?? null, beta: x.beta ?? null };
        }
        bbSave();
      }
    }
  })().catch(() => { bbJob = null; setTimeout(startBestBuys, 60_000); });
}
setInterval(startBestBuys, 30 * 60_000);
async function bestBuys() {
  startBestBuys();
  const total = BB.universe.length, rated = Object.values(BB.ratings).filter((r) => Date.now() - r.t < 36 * 3600e3).length;
  const { all, top, bottom } = bbRank();
  if (!FINNHUB) return { status: "unavailable", items: [] };
  if (all.length < 30) return { status: "building", progress: Object.keys(BB.ratings).length, total: total || 6000, items: [] };
  const buys = top.slice(0, 12), sells = bottom.slice(0, 10), syms = [...buys, ...sells].map((t) => t.sym.replace(".", "-"));
  const q = await Promise.race([getQuotes(syms).catch(() => ({})), new Promise((r) => setTimeout(() => r({}), 6000))]);
  const quotes = (q && q.quotes) || {};
  const spNames = Object.fromEntries(SP500.map((r) => [r[0].replace("-", "."), [r[1], r[2]]]));
  const newsP = cached("bbnews:" + syms.join(","), 15 * 60_000, async () => {
    const out = {};
    for (let i = 0; i < syms.length; i += 12) {
      const chunk = syms.slice(i, i + 12);
      const n = await getNews(chunk, "").catch(() => ({ items: [] }));
      for (const it of n.items || []) for (const t of it.tickers || []) if (chunk.includes(t)) {
        const o = (out[t] = out[t] || { count: 0, top: null });
        if (Date.now() - (it.time || 0) < 7 * 864e5) o.count++;
        if (!o.top || (it.time || 0) > (o.top.time || 0)) o.top = { title: it.title, link: it.link, source: it.source || "", time: it.time };
      }
    }
    return out;
  });
  const news = (await Promise.race([newsP, new Promise((r) => setTimeout(() => r(null), 7000))])) || {};
  const shape = (t) => {
    const ys = t.sym.replace(".", "-"), qq = quotes[ys] || {}, m = BB.metrics[t.sym] || {};
    return { ...t, ...m, sym: ys, score: t.adj, buyPct: (t.sb + t.b) / t.n, sellPct: (t.s + t.ss) / t.n, holdPct: t.h / t.n,
      name: (spNames[t.sym] || [])[0] || (BB.names[t.sym] ? BB.names[t.sym].replace(/\b(\w)(\w*)/g, (a, b, c) => b + c.toLowerCase()) : t.sym),
      sector: (spNames[t.sym] || [])[1] || "", sp500: !!spNames[t.sym], price: qq.price ?? null, chgPct: qq.changePct ?? null, news: news[ys] || null };
  };
  return { status: rated < total * 0.9 ? "scanning" : "ready", progress: rated, total, rated: all.length, updated: Date.now(),
    newsReady: !!Object.keys(news).length, items: buys.map(shape), sells: sells.map(shape) };
}
setTimeout(async () => { try { await sp500Snapshot(); } catch {} startShareJob(); }, 20_000);
setTimeout(startBestBuys, 45_000); // load live sizes first so only missing ones go to Finnhub
async function sp500Snapshot() {
  return cached("sp500", 60_000, async () => {
    const syms = SP500.map(r => r[0]), out = {}; let source = "quote";
    try {
      for (let i = 0; i < syms.length; i += 150) {
        const chunk = syms.slice(i, i + 150);
        const j = await yget(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(","))}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,marketCap,regularMarketPreviousClose`);
        for (const q of (j.quoteResponse && j.quoteResponse.result) || []) {
          if (q.regularMarketPrice == null) continue;
          if (q.marketCap) spCaps[q.symbol] = q.marketCap;
          out[q.symbol] = [q.regularMarketPrice, q.regularMarketChange ?? null, q.regularMarketChangePercent ?? null, q.marketCap || spCaps[q.symbol] || null];
        }
      }
    } catch (e) { source = "spark"; }
    const missing = syms.filter(s => !out[s]);
    if (missing.length) {
      source = Object.keys(out).length ? "mixed" : "spark";
      const batches = []; for (let i = 0; i < missing.length; i += 20) batches.push(missing.slice(i, i + 20));
      let bi = 0;
      const worker = async () => { while (bi < batches.length) { const b = batches[bi++];
        try {
          const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(b.join(","))}&range=1d&interval=1d`, "application/json"));
          const list = j.spark && j.spark.result ? j.spark.result.map(r => ({ symbol: r.symbol, ...(r.response && r.response[0] && r.response[0].meta || {}) })) : Object.values(j);
          for (const r of list) {
            const sym = r.symbol, price = r.regularMarketPrice ?? (r.close && r.close[r.close.length - 1]), prev = r.chartPreviousClose ?? r.previousClose;
            if (!sym || price == null || !prev) continue;
            out[sym] = [price, price - prev, (price / prev - 1) * 100, spCaps[sym] || (spShares[sym] ? Math.round(spShares[sym] * price) : null)];
          }
        } catch (e) { /* skip this batch */ } } };
      await Promise.all([worker(), worker(), worker()]);
    }
    startShareJob();
    return { updated: Date.now(), source, count: Object.keys(out).length, sized: Object.values(out).filter(v => v[3]).length, quotes: out };
  });
}

// ---------------------------------------------------------------- Claude password lock
// Every request that spends Claude credits must carry the owner's password (header x-claude-pass).
// Only a one-way scrypt hash of the password lives in this code. To change the password, set
// CLAUDE_PASSWORD in Render's Environment settings (it takes priority over the hash below).
const nodeCrypto = require("crypto");
const PASS_HASH = process.env.CLAUDE_PASSWORD_HASH || "1cec6559abba0f21217c3da332525de6:3b6fa7c7c1f84925bd3996c9e92a95e84b870569b46891d817182942fd43b65e";
const goodPass = new Set(); // sha256 of passwords already verified (skips the slow check next time)
const badTries = new Map(); // ip -> [times] of wrong passwords
function passOk(pw) {
  if (!pw || typeof pw !== "string" || pw.length > 200) return false;
  const tag = nodeCrypto.createHash("sha256").update(pw).digest("hex");
  if (goodPass.has(tag)) return true;
  let ok = false;
  if (process.env.CLAUDE_PASSWORD) {
    const a = Buffer.from(pw), b = Buffer.from(process.env.CLAUDE_PASSWORD);
    ok = a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
  } else {
    const [salt, hash] = PASS_HASH.split(":");
    const got = nodeCrypto.scryptSync(pw, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
    ok = nodeCrypto.timingSafeEqual(got, Buffer.from(hash, "hex"));
  }
  if (ok) goodPass.add(tag);
  return ok;
}
// Returns null if allowed, or [status, body] to send back
function claudeGate(req, pw) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  const now = Date.now(), tries = (badTries.get(ip) || []).filter(t => now - t < 15 * 60e3);
  if (tries.length >= 8) return [429, { error: "Too many wrong passwords. Try again in 15 minutes.", code: "locked" }];
  if (passOk(pw)) return null;
  if (pw) { tries.push(now); badTries.set(ip, tries); }
  return [401, { error: pw ? "Wrong password." : "Claude is locked. Flip the Claude switch at the top and enter the password.", code: "locked" }];
}

// ---------------------------------------------------------------- Claude predictions
// Needs an Anthropic API key, set as ANTHROPIC_API_KEY in Render's Environment settings.
//
// Credit protection: the site is public, so every real call to Claude counts toward a daily cap
// (CLAUDE_DAILY_LIMIT, default 60 ≈ $1/day worst case) and each visitor gets at most 20 Claude
// requests per hour. Cached predictions (reused for 30 minutes) are free and don't count.
const DAILY_LIMIT = Math.max(0, parseInt(process.env.CLAUDE_DAILY_LIMIT || "60", 10) || 0);
const usage = { day: "", count: 0 };
const etDay = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
function claudeUsed() { if (usage.day !== etDay()) { usage.day = etDay(); usage.count = 0; } return usage.count; }
function spendOne() {
  if (claudeUsed() >= DAILY_LIMIT) {
    const e = new Error(`Daily Claude limit reached (${DAILY_LIMIT} requests). It resets at midnight Eastern, or raise CLAUDE_DAILY_LIMIT in Render.`);
    e.code = "daily_limit"; throw e;
  }
  usage.count++;
}
const perIp = new Map();
const IP_HOURLY = Math.max(1, parseInt(process.env.CLAUDE_HOURLY_LIMIT || "40", 10) || 40);
function ipAllowed(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now(), list = (perIp.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= IP_HOURLY) return false;
  list.push(now); perIp.set(ip, list);
  if (perIp.size > 2000) perIp.clear();
  return true;
}
async function anthropic(apiKey, body) {
  spendOne();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (j.error && j.error.message) || `Anthropic API error ${res.status}`;
    throw new Error(/credit balance/i.test(msg) ? "Your Anthropic credit balance is too low. Add credits at platform.claude.com/settings/billing." : msg);
  }
  // real cost of this call from the token counts Anthropic reports (prices per million tokens; override with env vars)
  const u = j.usage || {};
  const cost = ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1) * PRICE_IN / 1e6 + (u.output_tokens || 0) * PRICE_OUT / 1e6;
  const st = costCtx.getStore(); if (st) st.cost += cost;
  return j;
}
const PRICE_IN = +process.env.CLAUDE_PRICE_IN || 2, PRICE_OUT = +process.env.CLAUDE_PRICE_OUT || 10;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";

function perf(c, days) {
  if (!c.length) return null;
  const last = c[c.length - 1];
  const cutoff = last.time - days * 86400;
  const base = c.find((x) => x.time >= cutoff) || c[0];
  return ((last.close - base.close) / base.close) * 100;
}
function summarizeHistory(h) {
  const c = h.candles;
  if (!c.length) return "no history";
  const closes = c.map((x) => x.close);
  const sma = (n) => (closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null);
  const f = (n) => (n == null ? "n/a" : n.toFixed(2));
  return `1y daily: last ${f(closes.at(-1))}, 1w ${f(perf(c, 7))}%, 1m ${f(perf(c, 30))}%, 3m ${f(perf(c, 91))}%, 1y ${f(perf(c, 365))}%, ` +
    `SMA50 ${f(sma(50))}, SMA200 ${f(sma(200))}, 1y high ${f(Math.max(...c.map((x) => x.high)))}, 1y low ${f(Math.min(...c.map((x) => x.low)))}`;
}

async function askClaude(apiKey, prompt, raw = false, retry = false) {
  const j = await anthropic(apiKey, {
      model: MODEL,
      max_tokens: 3000,
      ...(raw ? {} : { tools: [PREDICTION_TOOL], tool_choice: { type: "auto" } }),
      system:
        "You are a sharp, balanced equity strategist writing for one individual investor's personal dashboard. " +
        "Use ONLY the data provided plus general market knowledge. Be specific, cite the headlines and numbers you rely on, " +
        "state uncertainty honestly, and never present a forecast as certain. This is an opinion, not financial advice. " +
        (raw
          ? "Answer in plain text: short paragraphs or '- ' bullets, no markdown headings, under 250 words."
          : "Always give your answer by calling the prediction tool exactly once. Do not answer in plain text."),
      messages: [{ role: "user", content: prompt }],
  });
  if (!raw) {
    const tu = (j.content || []).find((b) => b.type === "tool_use");
    if (tu && tu.input) return tu.input;
  }
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (raw) return text.trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  if (!retry) return askClaude(apiKey, prompt + "\n\nIMPORTANT: answer by calling the prediction tool.", raw, true);
  throw new Error("Claude's answer couldn't be read. Please try again.");
}

// Structured output: a flat schema of simple text fields (nested lists came back garbled)
const T = (d) => ({ type: "string", description: d });
const PREDICTION_TOOL = {
  name: "prediction",
  description: "Record the outlook for the dashboard.",
  input_schema: {
    type: "object",
    properties: {
      stance: { type: "string", enum: ["Bullish", "Bearish", "Neutral"] },
      confidence: { type: "integer", description: "0-100" },
      headline: T("one-sentence call"),
      shortTermView: T("2-3 sentences on the next 1-2 weeks"), shortTermRange: T("expected price/level range for the next 1-2 weeks"),
      shortTermTarget: { type: "number", description: "single most likely price/level in 2 weeks" },
      mediumTermTarget: { type: "number", description: "single most likely price/level in 6 months" },
      riskLevel: { type: "string", enum: ["Low", "Medium", "High", "Very high"] },
      oneLiner: T("under 12 words, the gist for a ranked list"),
      mediumTermView: T("2-3 sentences on the next 3-6 months"), mediumTermRange: T("expected price/level range for the next 3-6 months"),
      bullCase: T("2-4 short points, one per line"), bearCase: T("2-4 short points, one per line"),
      catalysts: T("2-4 upcoming events to watch, one per line"), newsRead: T("what the latest headlines say, 2-3 sentences"),
    },
    required: ["stance", "confidence", "headline", "oneLiner", "riskLevel", "shortTermTarget", "mediumTermTarget", "shortTermView", "shortTermRange", "mediumTermView", "mediumTermRange", "bullCase", "bearCase", "catalysts", "newsRead"],
  },
};
const lines = (v) => (Array.isArray(v) ? v : String(v || "").split(/\n+|(?:^|\s)[•\-]\s+/)).map((x) => String(x).replace(/^[\s•\-\d.)]+/, "").trim()).filter(Boolean).slice(0, 6);
function shapePrediction(p) {
  if (p.shortTerm && typeof p.shortTerm === "object") return p; // already in the old shape
  return {
    stance: p.stance, confidence: Math.max(0, Math.min(100, Math.round(+p.confidence || 0))), headline: p.headline,
    shortTerm: { horizon: "next 1-2 weeks", view: p.shortTermView, range: p.shortTermRange },
    mediumTerm: { horizon: "next 3-6 months", view: p.mediumTermView, range: p.mediumTermRange },
    bullCase: lines(p.bullCase), bearCase: lines(p.bearCase), catalysts: lines(p.catalysts), newsRead: p.newsRead,
    oneLiner: p.oneLiner, riskLevel: p.riskLevel,
    targetShort: +p.shortTermTarget || null, targetMedium: +p.mediumTermTarget || null,
  };
}
const SHAPE = `Give your answer by calling the prediction tool. Put each bull point, bear point and catalyst on its own line.`;

async function predict(sym, apiKey, fresh) {
  const isMarket = sym === "MARKET";
  if (fresh) cache.delete(`p:${sym}:${MODEL}`);
  return cached(`p:${sym}:${MODEL}`, 30 * 60_000, async () => {
    const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", dateStyle: "full" });
    let prompt;
    if (isMarket) {
      const idx = ["^GSPC", "^IXIC", "^DJI", "^RUT", "^VIX", "^TNX", "CL=F", "GC=F"];
      const [qs, hs, news] = await Promise.all([
        getQuotes(idx),
        Promise.allSettled(["^GSPC", "^IXIC"].map((s) => history(s, "1y"))),
        getNews([]),
      ]);
      const lines = idx.map((s) => { const q = qs.quotes[s]; return q.error ? `${s}: n/a` : `${q.name} (${s}): ${q.price?.toFixed(2)} (${q.changePct?.toFixed(2)}% today)`; });
      const hist = hs.map((h, i) => (h.status === "fulfilled" ? `${["S&P 500", "Nasdaq"][i]} ${summarizeHistory(h.value)}` : "")).join("\n");
      const heads = news.items.slice(0, 40).map((i) => `- [${SOURCES[i.source].name}] ${i.title}`).join("\n");
      prompt = `Today is ${today}. Give your outlook for the overall US stock market.\n\nINDEXES & MACRO\n${lines.join("\n")}\n\nTREND\n${hist}\n\nLATEST HEADLINES (Yahoo Finance, CNBC, Morningstar, Seeking Alpha, WSJ)\n${heads}\n\nFor the ranges, use S&P 500 levels.\n${SHAPE}`;
    } else {
      const [qs, h, news] = await Promise.all([getQuotes([sym]), history(sym, "1y").catch(() => null), getNews([sym])]);
      const q = qs.quotes[sym];
      if (!q || q.error) throw new Error(`Couldn't find a quote for ${sym}`);
      const heads = news.items.filter((i) => i.tickers.includes(sym)).slice(0, 30)
        .map((i) => `- [${SOURCES[i.source].name}${i.time ? ", " + new Date(i.time).toISOString().slice(0, 10) : ""}] ${i.title}${i.summary ? " — " + i.summary.slice(0, 160) : ""}`).join("\n");
      prompt = `Today is ${today}. Give your outlook for ${q.name} (${sym}).\n\nQUOTE\nPrice ${q.price} ${q.currency}, ${q.changePct?.toFixed(2)}% today, prev close ${q.prevClose}, day ${q.dayLow}-${q.dayHigh}, 52w ${q.low52}-${q.high52}, volume ${q.volume}\n\nTREND\n${h ? summarizeHistory(h) : "n/a"}\n\nLATEST ${sym} HEADLINES\n${heads || "(none found)"}\n\n${SHAPE}`;
    }
    const out = shapePrediction(await askClaude(apiKey, prompt));
    const pq = (await getQuotes([isMarket ? "^GSPC" : sym])).quotes;
    const priceAt = (pq[isMarket ? "^GSPC" : sym] || {}).price ?? null;
    return { symbol: sym, model: MODEL, generated: Date.now(), priceAt, priceSymbol: isMarket ? "^GSPC" : sym, ...out };
  });
}

// Ask Claude can also DO things on the dashboard: build a portfolio or add holdings.
// Simple text fields only (nested lists came back garbled from this model).
const ACTION_TOOLS = [
  {
    name: "create_portfolio",
    description: "Create a new portfolio on the user's dashboard. Use this whenever the user asks you to make, build or set up a portfolio for them. Pick real, liquid tickers that fit their request and today's data.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "short portfolio name, e.g. 'Aggressive Growth'" },
        total: { type: "number", description: "total dollars to invest; use the amount the user gave, otherwise 10000" },
        holdings: { type: "string", description: "comma-separated TICKER:PERCENT pairs that add up to 100, e.g. 'NVDA:15, MSFT:10, VOO:25'. Use Yahoo symbols (crypto like BTC-USD)." },
        rationale: { type: "string", description: "2-4 sentences on why these picks and weights" },
      },
      required: ["name", "total", "holdings", "rationale"],
    },
  },
  {
    name: "add_holdings",
    description: "Add holdings to the portfolio the user is currently viewing. Use when they ask to add stocks to their current/existing portfolio.",
    input_schema: {
      type: "object",
      properties: {
        holdings: { type: "string", description: "comma-separated TICKER:DOLLARS pairs, e.g. 'AAPL:1000, AMD:500'" },
        rationale: { type: "string", description: "1-3 sentences on why" },
      },
      required: ["holdings", "rationale"],
    },
  },
];
function parsePairs(str) {
  return String(str || "").split(/,(?!\d{3}(?!\d))|[;\n]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^\$?([A-Za-z0-9.\-^=]{1,12})\s*[:=\s]\s*\$?([\d.,]+)\s*%?$/);
    return m ? { symbol: m[1].toUpperCase(), value: parseFloat(m[2].replace(/,/g, "")) } : null;
  }).filter((x) => x && x.value > 0).slice(0, 40);
}
async function askWithActions(apiKey, prompt) {
  const j = await anthropic(apiKey, {
      model: MODEL, max_tokens: 4000, tools: ACTION_TOOLS, tool_choice: { type: "auto" },
      system:
        "You are a sharp, balanced investing assistant inside one person's personal stock dashboard. Use the data provided plus general market knowledge, " +
        "cite specific numbers and headlines, and be honest about uncertainty. This is an opinion, not financial advice. " +
        "You can take actions: when the user asks you to make/build/create a portfolio, CALL create_portfolio (don't just describe one); if they ask for several portfolios, call it once per portfolio in the same reply. " +
        "When they ask to add stocks to their current portfolio, CALL add_holdings. Otherwise just answer. " +
        "Always also write a short plain-text reply (no markdown headings, '- ' bullets are fine, under 220 words).",
      messages: [{ role: "user", content: prompt }],
  });
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const actions = [];
  for (const tu of (j.content || []).filter((b) => b.type === "tool_use").slice(0, 4)) {
    const pairs = parsePairs(tu.input && tu.input.holdings);
    if (!pairs.length) continue;
    if (tu.name === "create_portfolio") {
      const sum = pairs.reduce((a, b) => a + b.value, 0) || 1;
      actions.push({ type: "create_portfolio", name: String(tu.input.name || "Claude's portfolio").slice(0, 40), total: Math.max(1, +tu.input.total || 10000),
        holdings: pairs.map((p) => ({ symbol: p.symbol, pct: (p.value / sum) * 100 })), rationale: tu.input.rationale || "" });
    } else if (tu.name === "add_holdings") {
      actions.push({ type: "add_holdings", holdings: pairs.map((p) => ({ symbol: p.symbol, amount: p.value })), rationale: tu.input.rationale || "" });
    }
  }
  const answer = text || actions.map((x) => x.rationale).filter(Boolean).join("\n\n") || "Done.";
  return { answer, action: actions[0] || null, actions };
}

// Free-form question, with the viewer's watchlist / portfolio as context
async function ask(apiKey, body) {
  const question = String(body.question || "").slice(0, 1000);
  if (!question.trim()) throw new Error("Ask a question first");
  const holdings = (Array.isArray(body.holdings) ? body.holdings : []).slice(0, 40)
    .filter((h) => TICKER_RE.test(String(h.symbol || "").toUpperCase()))
    .map((h) => ({ symbol: String(h.symbol).toUpperCase(), shares: +h.shares || 0, cost: +h.cost || 0 }));
  const watch = parseList(Array.isArray(body.watchlist) ? body.watchlist.join(",") : "", 25);
  const syms = [...new Set([...holdings.map((h) => h.symbol), ...watch])].slice(0, 40);
  const idx = ["^GSPC", "^IXIC", "^DJI", "^VIX", "^TNX"];
  const [qs, news] = await Promise.all([getQuotes([...idx, ...syms]), getNews(syms.slice(0, 15))]);
  const qline = (s) => { const q = qs.quotes[s]; return !q || q.error ? `${s}: n/a` : `${s} ${q.name}: ${q.price?.toFixed(2)} (${q.changePct?.toFixed(2)}% today, 52w ${q.low52}-${q.high52})`; };
  const port = holdings.length
    ? holdings.map((h) => `${h.symbol}: ${h.shares} sh @ avg ${h.cost}`).join("\n")
    : "(no holdings entered)";
  const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", dateStyle: "full" });
  const ctx = String(body.context || "").slice(0, 6000);
  const prompt = `Today is ${today}.\n\n${ctx ? "WHAT I'M LOOKING AT ON MY DASHBOARD RIGHT NOW\n" + ctx + "\n\n" : ""}MARKET\n${idx.map(qline).join("\n")}\n\nWATCHED / HELD STOCKS\n${syms.map(qline).join("\n")}\n\nMY PORTFOLIO\n${port}\n\nLATEST HEADLINES\n${news.items.slice(0, 40).map((i) => `- [${SOURCES[i.source].name}] ${i.title}`).join("\n")}\n\nMY QUESTION\n${question}`;
  return { ...(await askWithActions(apiKey, prompt)), model: MODEL, generated: Date.now() };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 1_000_000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------- Yahoo research data
// quoteSummary needs a Yahoo session cookie + "crumb"; we fetch one and reuse it.
const yahoo = { cookie: "", crumb: "", at: 0, pending: null };
function cookiesFrom(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
  return list.map((c) => c.split(";")[0]).join("; ");
}
// Follow redirects by hand so every Set-Cookie along the way is kept
async function collectCookies(startUrl, jar) {
  let url = startUrl;
  for (let i = 0; i < 6 && url; i++) {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9", Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
      redirect: "manual", signal: AbortSignal.timeout(10000),
    });
    const list = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean);
    for (const c of list) { const [kv] = c.split(";"); const i2 = kv.indexOf("="); if (i2 > 0) jar.set(kv.slice(0, i2).trim(), kv.slice(i2 + 1).trim()); }
    const loc = r.headers.get("location");
    url = loc && r.status >= 300 && r.status < 400 ? new URL(loc, url).toString() : null;
  }
}
async function yahooAuth(force = false) {
  if (!force && yahoo.crumb && Date.now() - yahoo.at < 6 * 3600e3) return yahoo;
  if (yahoo.failedAt && Date.now() - yahoo.failedAt < 5 * 60e3 && !force) throw new Error(yahoo.failMsg);
  if (yahoo.pending) return yahoo.pending;
  yahoo.pending = (async () => {
    const jar = new Map();
    const notes = [];
    for (const u of ["https://fc.yahoo.com/", "https://finance.yahoo.com/", "https://finance.yahoo.com/quote/AAPL/"]) {
      try { await collectCookies(u, jar); } catch (e) { notes.push(`${new URL(u).host}: ${e.message}`); }
      if (jar.has("A3") || jar.has("A1")) break;
    }
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    for (const host of ["query2", "query1"]) {
      try {
        const r2 = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, {
          headers: { "User-Agent": UA, Cookie: cookie, Accept: "text/plain", Referer: "https://finance.yahoo.com/" }, signal: AbortSignal.timeout(10000),
        });
        const crumb = (await r2.text()).trim();
        if (r2.ok && crumb && crumb.length < 40 && !crumb.includes("<") && !crumb.includes("{")) {
          Object.assign(yahoo, { cookie, crumb, at: Date.now(), failedAt: 0 });
          return yahoo;
        }
        notes.push(`${host} crumb HTTP ${r2.status}`);
      } catch (e) { notes.push(`${host}: ${e.message}`); }
    }
    yahoo.failedAt = Date.now();
    yahoo.failMsg = `Couldn't start a Yahoo Finance session (cookies: ${[...jar.keys()].join(",") || "none"}; ${notes.join("; ")})`;
    throw new Error(yahoo.failMsg);
  })().finally(() => { yahoo.pending = null; });
  return yahoo.pending;
}
async function yget(url) {
  let last;
  for (let i = 0; i < 2; i++) {
    const a = await yahooAuth(i > 0);
    const u = url + (url.includes("?") ? "&" : "?") + "crumb=" + encodeURIComponent(a.crumb);
    const res = await fetch(u, { headers: { "User-Agent": UA, Cookie: a.cookie, Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) { last = new Error("Yahoo refused the request"); continue; }
    if (!res.ok) { const e = new Error((body.quoteSummary && body.quoteSummary.error && body.quoteSummary.error.description) || `Yahoo error ${res.status}`); e.status = res.status; throw e; }
    return body;
  }
  throw last;
}
// {raw, fmt} -> raw, recursively
function unwrap(v) {
  if (Array.isArray(v)) return v.map(unwrap);
  if (v && typeof v === "object") {
    if ("raw" in v && (typeof v.raw !== "object" || v.raw === null)) return v.raw;
    if ("fmt" in v && Object.keys(v).length <= 2) return v.fmt ?? null;
    if (Object.keys(v).length === 0) return null;
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = unwrap(x);
    return o;
  }
  return v;
}

async function search(q) {
  return cached("s:" + q.toLowerCase(), 10 * 60_000, async () => {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0&enableFuzzyQuery=true`;
    const j = JSON.parse(await get(url, "application/json"));
    return (j.quotes || []).filter((x) => x.symbol).map((x) => ({
      symbol: x.symbol, name: x.shortname || x.longname || x.symbol, type: x.quoteType || "", typeDisp: x.typeDisp || x.quoteType || "", exchange: x.exchDisp || x.exchange || "",
    }));
  });
}

const MODULE_SETS = [
  "price,quoteType,summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents,earnings,earningsTrend,earningsHistory,recommendationTrend,upgradeDowngradeHistory,majorHoldersBreakdown,institutionOwnership,fundOwnership,insiderHolders,netSharePurchaseActivity",
  "price,quoteType,summaryDetail,defaultKeyStatistics,assetProfile,summaryProfile,fundProfile,topHoldings,fundPerformance",
  "price,quoteType,summaryDetail",
];
const VALUATION = ["MarketCap", "EnterpriseValue", "PeRatio", "ForwardPeRatio", "PegRatio", "PsRatio", "PbRatio", "EnterprisesValueRevenueRatio", "EnterprisesValueEBITDARatio"];
async function basicSummary(sym) {
  const [q, val] = await Promise.all([
    quote(sym),
    (async () => {
      const now = Math.floor(Date.now() / 1000);
      const types = VALUATION.map((k) => "trailing" + k).join(",");
      const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types}&period1=${now - 86400 * 400}&period2=${now}&merge=false`;
      const j = JSON.parse(await get(url, "application/json"));
      const out = {};
      for (const r of (j.timeseries && j.timeseries.result) || []) {
        const t = r.meta && r.meta.type && r.meta.type[0]; const pts = (t && r[t]) || [];
        const last = pts.filter((p) => p && p.reportedValue).pop();
        if (last) out[t.replace(/^trailing/, "")] = last.reportedValue.raw;
      }
      return out;
    })().catch(() => ({})),
  ]);
  const out = {
    symbol: sym, limited: true,
    price: { longName: q.name, regularMarketPrice: q.price, regularMarketChange: q.change, regularMarketChangePercent: q.changePct / 100, exchangeName: q.exchange, currency: q.currency },
    summaryDetail: { previousClose: q.prevClose, dayLow: q.dayLow, dayHigh: q.dayHigh, fiftyTwoWeekLow: q.low52, fiftyTwoWeekHigh: q.high52, volume: q.volume, marketCap: val.MarketCap, trailingPE: val.PeRatio, forwardPE: val.ForwardPeRatio, priceToSalesTrailing12Months: val.PsRatio },
    defaultKeyStatistics: { enterpriseValue: val.EnterpriseValue, pegRatio: val.PegRatio, priceToBook: val.PbRatio, enterpriseToRevenue: val.EnterprisesValueRevenueRatio, enterpriseToEbitda: val.EnterprisesValueEBITDARatio },
  };
  await Promise.all([
    FINNHUB && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym) && !isCrypto(sym) ? addFinnhub(sym, out).catch(() => {}) : null,
    !isCrypto(sym) && !/[\^=]/.test(sym) ? addWikipedia(q.name, out).catch(() => {}) : null,
  ]);
  return out;
}

// Company / fund description from Wikipedia (free, no key)
const WIKI_UA = { "User-Agent": "MyTerminal/1.0 (personal stock dashboard)", Accept: "application/json" };
async function addWikipedia(name, out) {
  if (!name) return;
  return cached("wiki:" + name, 7 * 86400e3, async () => {
    const clean = name.replace(/,? (Inc|Corp|Corporation|Co|Ltd|plc|Holdings|Class [A-C])\.?$/i, "").trim();
    for (const q of [name, clean + " company", clean]) {
      const s = await fetch(`https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=${encodeURIComponent(q)}`, { headers: WIKI_UA, signal: AbortSignal.timeout(8000) }).then((r) => r.json());
      const title = s && s[1] && s[1][0];
      if (!title) continue;
      const sum = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { headers: WIKI_UA, signal: AbortSignal.timeout(8000) }).then((r) => r.json());
      const text = sum && sum.type !== "disambiguation" && sum.extract;
      const looksRight = text && /compan|corporation|fund|trust|bank|firm|manufactur|retail|conglomerate|exchange-traded|holding|technolog|pharma|insur|airline|motor|energy|semiconductor|software|platform|maker|brand/i.test(text);
      if (looksRight) return { text, url: sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page };
    }
    return null;
  }).then((w) => {
    if (w) out.assetProfile = { ...(out.assetProfile || {}), longBusinessSummary: w.text, descriptionSource: "Wikipedia", descriptionUrl: w.url };
  });
}

// Finnhub free endpoints fill in what Yahoo won't share: profile, key metrics, analyst trends, earnings
async function fh(path) {
  const r = await fetch(`https://finnhub.io/api/v1${path}${path.includes("?") ? "&" : "?"}token=${FINNHUB}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("Finnhub " + r.status);
  return r.json();
}
async function addFinnhub(sym, out) {
  const fsym = sym.replace("-", ".");
  const [prof, met, rec, earn, ins, tgt] = await Promise.allSettled([
    fh(`/stock/profile2?symbol=${fsym}`), fh(`/stock/metric?symbol=${fsym}&metric=all`), fh(`/stock/recommendation?symbol=${fsym}`), fh(`/stock/earnings?symbol=${fsym}`),
    fh(`/stock/insider-transactions?symbol=${fsym}`), fh(`/stock/price-target?symbol=${fsym}`),
  ]).then((r) => r.map((x) => (x.status === "fulfilled" ? x.value : null)));
  const m = (met && met.metric) || {};
  const pc = (x) => (x == null ? undefined : x / 100);
  const mil = (x) => (x == null ? undefined : x * 1e6);
  const sd = out.summaryDetail, ks = out.defaultKeyStatistics;
  if (prof && prof.name) {
    out.price.longName = prof.name;
    out.assetProfile = { ...(out.assetProfile || {}), sector: prof.finnhubIndustry, industry: prof.finnhubIndustry, country: prof.country, website: prof.weburl, phone: prof.phone, ipo: prof.ipo };
    sd.marketCap = sd.marketCap ?? mil(prof.marketCapitalization);
    ks.sharesOutstanding = mil(prof.shareOutstanding);
  }
  Object.assign(sd, {
    beta: m.beta, trailingPE: sd.trailingPE ?? m.peTTM ?? m.peBasicExclExtraTTM, dividendYield: pc(m.dividendYieldIndicatedAnnual ?? m.currentDividendYieldTTM),
    dividendRate: m.dividendPerShareAnnual, payoutRatio: pc(m.payoutRatioTTM ?? m.payoutRatioAnnual),
    averageVolume: mil(m["3MonthAverageTradingVolume"]), averageVolume10days: mil(m["10DayAverageTradingVolume"]),
    fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh ?? m["52WeekHigh"], fiftyTwoWeekLow: sd.fiftyTwoWeekLow ?? m["52WeekLow"],
  });
  Object.assign(ks, {
    trailingEps: m.epsTTM ?? m.epsBasicExclExtraItemsTTM, priceToBook: ks.priceToBook ?? m.pbQuarterly ?? m.pbAnnual,
    bookValue: m.bookValuePerShareQuarterly ?? m.bookValuePerShareAnnual, "52WeekChange": pc(m["52WeekPriceReturnDaily"]),
  });
  out.financialData = {
    profitMargins: pc(m.netProfitMarginTTM), operatingMargins: pc(m.operatingMarginTTM), grossMargins: pc(m.grossMarginTTM),
    returnOnAssets: pc(m.roaTTM), returnOnEquity: pc(m.roeTTM), revenueGrowth: pc(m.revenueGrowthQuarterlyYoy), earningsGrowth: pc(m.epsGrowthQuarterlyYoy),
    currentRatio: m.currentRatioQuarterly, quickRatio: m.quickRatioQuarterly, revenuePerShare: m.revenuePerShareTTM,
    debtToEquity: m["totalDebt/totalEquityQuarterly"] != null ? m["totalDebt/totalEquityQuarterly"] * 100 : undefined,
    totalCashPerShare: m.cashPerSharePerShareQuarterly,
  };
  if (Array.isArray(rec) && rec.length) {
    const r0 = rec[0];
    out.recommendationTrend = { trend: [{ period: "0m", strongBuy: r0.strongBuy || 0, buy: r0.buy || 0, hold: r0.hold || 0, sell: r0.sell || 0, strongSell: r0.strongSell || 0 }] };
    const sc = (r0.strongBuy * 1 + r0.buy * 2 + r0.hold * 3 + r0.sell * 4 + r0.strongSell * 5) / Math.max(1, r0.strongBuy + r0.buy + r0.hold + r0.sell + r0.strongSell);
    out.financialData.recommendationKey = sc <= 1.5 ? "strong_buy" : sc <= 2.5 ? "buy" : sc <= 3.5 ? "hold" : sc <= 4.5 ? "sell" : "strong_sell";
    out.financialData.numberOfAnalystOpinions = r0.strongBuy + r0.buy + r0.hold + r0.sell + r0.strongSell;
  }
  if (Array.isArray(earn) && earn.length) {
    out.earningsHistory = { history: earn.slice(0, 8).reverse().map((e) => ({ quarter: Date.parse(e.period) / 1000, epsEstimate: e.estimate, epsActual: e.actual, epsDifference: e.surprise, surprisePercent: pc(e.surprisePercent) })) };
  }
  if (tgt && tgt.targetMean) {
    Object.assign(out.financialData, { targetHighPrice: tgt.targetHigh, targetLowPrice: tgt.targetLow, targetMeanPrice: tgt.targetMean, targetMedianPrice: tgt.targetMedian, currentPrice: out.price.regularMarketPrice });
  }
  if (ins && Array.isArray(ins.data) && ins.data.length) {
    const CODES = { P: "Buy", S: "Sale", A: "Grant/award", M: "Option exercise", F: "Tax withholding", G: "Gift", D: "Disposition", C: "Conversion", X: "Option exercise" };
    out.insiderTransactions = ins.data
      .filter((t) => t.transactionDate)
      .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))
      .slice(0, 25)
      .map((t) => ({ name: t.name, date: t.transactionDate, type: CODES[t.transactionCode] || t.transactionCode || "", change: t.change, shares: t.share, price: t.transactionPrice }));
  }
  out.source = "Yahoo Finance + Finnhub";
}
async function summary(sym) {
  return cached("sum:" + sym, 10 * 60_000, async () => {
    let lastErr;
    // ETFs / funds / crypto get the fund set first; everything else the stock set
    let order = [0, 1, 2];
    try {
      const qt = unwrap((await yget(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=quoteType`)).quoteSummary.result[0]).quoteType;
      if (qt && qt.quoteType && qt.quoteType !== "EQUITY") order = [1, 2];
    } catch (e) { lastErr = e; }
    for (const i of order) {
      try {
        const j = await yget(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${MODULE_SETS[i]}`);
        const r = j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
        if (r) return { symbol: sym, ...unwrap(r) };
      } catch (e) { lastErr = e; }
    }
    // Yahoo wouldn't give us a session: fall back to what we can get without one
    try { const b = await basicSummary(sym); b.note = String((lastErr && lastErr.message) || ""); return b; }
    catch { throw lastErr || new Error("No data for " + sym); }
  });
}

const STATEMENTS = {
  income: ["TotalRevenue", "CostOfRevenue", "GrossProfit", "ResearchAndDevelopment", "SellingGeneralAndAdministration", "OperatingExpense", "OperatingIncome", "InterestExpense", "OtherIncomeExpense", "PretaxIncome", "TaxProvision", "NetIncome", "NetIncomeCommonStockholders", "BasicEPS", "DilutedEPS", "BasicAverageShares", "DilutedAverageShares", "EBIT", "EBITDA", "NormalizedEBITDA"],
  balance: ["TotalAssets", "CurrentAssets", "CashAndCashEquivalents", "CashCashEquivalentsAndShortTermInvestments", "Receivables", "Inventory", "NetPPE", "Goodwill", "TotalNonCurrentAssets", "TotalLiabilitiesNetMinorityInterest", "CurrentLiabilities", "AccountsPayable", "CurrentDebt", "LongTermDebt", "TotalDebt", "NetDebt", "StockholdersEquity", "RetainedEarnings", "WorkingCapital", "TangibleBookValue", "OrdinarySharesNumber"],
  cash: ["OperatingCashFlow", "CapitalExpenditure", "FreeCashFlow", "InvestingCashFlow", "FinancingCashFlow", "StockBasedCompensation", "DepreciationAndAmortization", "CashDividendsPaid", "RepurchaseOfCapitalStock", "IssuanceOfDebt", "RepaymentOfDebt", "ChangesInCash", "EndCashPosition"],
};
async function financials(sym, freq) {
  const f = freq === "quarterly" ? "quarterly" : "annual";
  return cached(`fin:${sym}:${f}`, 6 * 3600e3, async () => {
    const keys = Object.values(STATEMENTS).flat();
    const types = keys.map((k) => f + k).join(",");
    const now = Math.floor(Date.now() / 1000);
    const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?symbol=${encodeURIComponent(sym)}&type=${types}&period1=493590046&period2=${now}&merge=false&padTimeSeries=true`;
    let j;
    try { j = await yget(url); } catch { j = JSON.parse(await get(url, "application/json")); }
    const rows = {};
    const dates = new Set();
    for (const r of (j.timeseries && j.timeseries.result) || []) {
      const type = r.meta && r.meta.type && r.meta.type[0];
      if (!type) continue;
      const key = type.replace(/^(annual|quarterly)/, "");
      for (const pt of r[type] || []) {
        if (!pt || !pt.asOfDate || !pt.reportedValue) continue;
        (rows[key] = rows[key] || {})[pt.asOfDate] = pt.reportedValue.raw;
        dates.add(pt.asOfDate);
      }
    }
    const periods = [...dates].sort().reverse().slice(0, f === "annual" ? 5 : 8);
    const out = {};
    for (const [stmt, list] of Object.entries(STATEMENTS)) out[stmt] = list.filter((k) => rows[k]).map((k) => ({ key: k, values: periods.map((d) => rows[k][d] ?? null) }));
    return { symbol: sym, freq: f, periods, ...out };
  });
}

// ---------------------------------------------------------------- market movers & earnings calendar
const UNIVERSE = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","BRK-B","JPM","LLY","V","UNH","XOM","MA","JNJ","PG","HD","COST","ORCL","ABBV","WMT","BAC","NFLX","CRM","KO","CVX","AMD","PEP","MRK","ADBE","TMO","CSCO","ACN","MCD","LIN","ABT","WFC","DIS","INTC","QCOM","TXN","IBM","GE","CAT","AMGN","PFE","NOW","INTU","UBER","PLTR","GS","MS","BA","NKE","SBUX","PYPL","COIN","SHOP","SNOW","MU","ARM","SMCI","RIVN","SOFI","HOOD","F","GM","T","VZ"];
async function movers() {
  return cached("movers", 2 * 60_000, async () => {
    const pick = (q) => ({ symbol: q.symbol, name: q.shortName || q.longName || q.symbol, price: q.regularMarketPrice, changePct: q.regularMarketChangePercent, volume: q.regularMarketVolume, marketCap: q.marketCap });
    try {
      const ids = ["day_gainers", "day_losers", "most_actives"];
      const res = await Promise.all(ids.map((id) => yget(`https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${id}&count=10&formatted=false`)));
      const lists = res.map((j) => ((j.finance && j.finance.result && j.finance.result[0] && j.finance.result[0].quotes) || []).map(pick));
      if (lists.every((l) => l.length)) return { source: "Yahoo Finance screeners", gainers: lists[0], losers: lists[1], active: lists[2] };
    } catch {}
    // Fallback: rank 70 of the biggest US stocks ourselves
    const qs = (await getQuotes(UNIVERSE)).quotes;
    const list = Object.values(qs).filter((q) => !q.error && q.changePct != null).map((q) => ({ symbol: q.symbol, name: q.name, price: q.price, changePct: q.changePct, volume: q.volume }));
    return {
      source: "70 largest US stocks",
      gainers: [...list].sort((a, b) => b.changePct - a.changePct).slice(0, 10),
      losers: [...list].sort((a, b) => a.changePct - b.changePct).slice(0, 10),
      active: [...list].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 10),
    };
  });
}

async function earningsCalendar(symbols) {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86400e3).toISOString().slice(0, 10);
  const all = FINNHUB
    ? await cached("ecal:" + from, 3600e3, async () => ((await fh(`/calendar/earnings?from=${from}&to=${to}`)).earningsCalendar || []))
    : [];
  const mine = new Set(symbols.map((s) => s.replace("-", ".")));
  const big = new Set(UNIVERSE.map((s) => s.replace("-", ".")));
  const row = (e) => ({ symbol: e.symbol.replace(".", "-"), date: e.date, hour: e.hour, epsEstimate: e.epsEstimate, revenueEstimate: e.revenueEstimate, quarter: e.quarter, year: e.year });
  let yours = all.filter((e) => mine.has(e.symbol)).map(row);
  // Without Finnhub (or for symbols it lacks), fall back to Yahoo's calendarEvents
  const missing = symbols.filter((s) => !yours.some((y) => y.symbol === s) && /^[A-Z][A-Z.\-]{0,6}$/.test(s) && !isCrypto(s)).slice(0, 12);
  if (missing.length) {
    const extra = await Promise.allSettled(missing.map(async (s) => {
      const d = await summary(s);
      const ed = d.calendarEvents && d.calendarEvents.earnings && d.calendarEvents.earnings.earningsDate;
      const t = Array.isArray(ed) && ed[0];
      if (t && t * 1000 >= Date.now() - 86400e3 && t * 1000 < Date.now() + 60 * 86400e3) {
        return { symbol: s, date: new Date(t * 1000).toISOString().slice(0, 10), epsEstimate: d.calendarEvents.earnings.earningsAverage, revenueEstimate: d.calendarEvents.earnings.revenueAverage };
      }
    }));
    yours = yours.concat(extra.map((x) => x.status === "fulfilled" && x.value).filter(Boolean));
  }
  const notable = all.filter((e) => big.has(e.symbol) && !mine.has(e.symbol)).map(row);
  const byDate = (a, b) => a.date.localeCompare(b.date);
  return { updated: Date.now(), source: FINNHUB ? "Finnhub" : "Yahoo Finance", yours: yours.sort(byDate), notable: notable.sort(byDate).slice(0, 40) };
}

// ---------------------------------------------------------------- live streaming prices (Finnhub)
// With FINNHUB_API_KEY set (free at finnhub.io), the server keeps one WebSocket to
// Finnhub and streams every trade to open browsers via Server-Sent Events.
// Free tier: real-time US stock trades, up to 30 symbols at once. Needs Node 22+.
const live = { ws: null, open: false, subs: new Set(), last: new Map(), dirty: new Set(), clients: new Set(), retry: 1000 };
const streamable = (s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s); // stocks, ETFs and COIN-USD (no ^indexes or futures)
const toFeed = (s) => (isCrypto(s) ? `BINANCE:${base(s)}USDT` : s);
const fromFeed = (f) => { const m = f.match(/^BINANCE:(\w+)USDT$/); return m ? m[1] + "-USD" : f; };

function wanted() {
  const want = new Set();
  for (const c of live.clients) for (const s of c.syms) { if (want.size >= 30) break; want.add(s); }
  return want;
}
function syncSubs() {
  if (!live.open) return;
  const want = wanted();
  for (const s of live.subs) if (!want.has(s)) { live.ws.send(JSON.stringify({ type: "unsubscribe", symbol: toFeed(s) })); live.subs.delete(s); }
  for (const s of want) if (!live.subs.has(s)) { live.ws.send(JSON.stringify({ type: "subscribe", symbol: toFeed(s) })); live.subs.add(s); }
}
function connectFinnhub() {
  if (!FINNHUB || typeof WebSocket === "undefined") return;
  const ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB}`);
  live.ws = ws;
  ws.onopen = () => { live.open = true; live.retry = 1000; live.subs.clear(); syncSubs(); console.log("Finnhub stream connected"); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== "trade" || !Array.isArray(m.data)) return;
    for (const t of m.data) {
      const sym = fromFeed(t.s);
      const prev = live.last.get(sym);
      if (!prev || t.t >= prev.t) { live.last.set(sym, { p: t.p, t: t.t }); live.dirty.add(sym); }
    }
  };
  ws.onclose = () => {
    live.open = false;
    setTimeout(connectFinnhub, live.retry);
    live.retry = Math.min(live.retry * 2, 60_000);
  };
  ws.onerror = () => {};
}
connectFinnhub();
// Push batched updates to browsers ~2x per second
setInterval(() => {
  if (!live.dirty.size) return;
  const dirty = live.dirty; live.dirty = new Set();
  for (const c of live.clients) {
    const out = {};
    for (const s of dirty) if (c.syms.has(s)) out[s] = live.last.get(s);
    if (Object.keys(out).length) c.res.write(`data: ${JSON.stringify(out)}\n\n`);
  }
}, 500);
// Keep connections alive through proxies
setInterval(() => { for (const c of live.clients) c.res.write(": ping\n\n"); }, 25_000);

function openStream(req, res, syms) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const client = { res, syms: new Set(syms.filter(streamable)) };
  live.clients.add(client);
  const snap = {};
  for (const s of client.syms) if (live.last.has(s)) snap[s] = live.last.get(s);
  res.write(`event: hello\ndata: ${JSON.stringify({ streaming: live.open })}\n\n`);
  if (Object.keys(snap).length) res.write(`data: ${JSON.stringify(snap)}\n\n`);
  syncSubs();
  req.on("close", () => { live.clients.delete(client); syncSubs(); });
}

// ---------------------------------------------------------------- device sync (portfolios, watchlist, alerts, predictions)
// Each person picks a private sync code; data is stored under a hash of it.
// With UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set, data lives in Upstash Redis
// (free, survives restarts). Otherwise it is kept in a file on this server, which free
// Render plans wipe whenever the site updates.
const crypto = require("crypto");
const UP_URL = process.env.UPSTASH_REDIS_REST_URL, UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SYNC_DIR = path.join(require("os").tmpdir(), "pft-sync");
const syncKey = (code) => "pft:sync:" + crypto.createHash("sha256").update("pft|" + code).digest("hex").slice(0, 40);
async function syncGet(code) {
  const k = syncKey(code);
  if (UP_URL && UP_TOKEN) {
    const r = await fetch(`${UP_URL}/get/${k}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json(); return j.result ? JSON.parse(j.result) : null;
  }
  try { return JSON.parse(fs.readFileSync(path.join(SYNC_DIR, k + ".json"), "utf8")); } catch { return null; }
}
async function syncPut(code, doc) {
  const k = syncKey(code), body = JSON.stringify(doc);
  if (body.length > 900_000) throw new Error("Too much data to sync");
  if (UP_URL && UP_TOKEN) {
    const r = await fetch(`${UP_URL}/set/${k}`, { method: "POST", headers: { Authorization: `Bearer ${UP_TOKEN}` }, body, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error("Sync storage error " + r.status); return;
  }
  fs.mkdirSync(SYNC_DIR, { recursive: true }); fs.writeFileSync(path.join(SYNC_DIR, k + ".json"), body);
}

// ---------------------------------------------------------------- http
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function parseList(v, max) {
  return [...new Set(String(v || "").toUpperCase().split(",").map((s) => s.trim()).filter((s) => TICKER_RE.test(s)))].slice(0, max);
}

function send(res, code, body, type = "application/json") {
  const st = costCtx.getStore();
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...(st && st.cost > 0 ? { "X-Api-Cost": st.cost.toFixed(6) } : {}) });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

process.on("unhandledRejection", (e) => console.error("unhandled:", e && e.message));
process.on("uncaughtException", (e) => console.error("uncaught:", e && e.message));

http
  .createServer((req, res) => costCtx.run({ cost: 0 }, () => handle(req, res)))
  .listen(PORT, () => console.log(`Stock News Hub running at http://localhost:${PORT}`));
async function handle(req, res) {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname === "/api/news") {
        const r = String(u.searchParams.get("range") || "");
        return send(res, 200, await getNews(parseList(u.searchParams.get("tickers"), 25), r in RANGE_DAYS ? r : ""));
      }
      if (u.pathname === "/api/bestbuys") return send(res, 200, await bestBuys());
      if (u.pathname === "/api/trending") return send(res, 200, await getTrending());
      if (u.pathname === "/api/smart") return send(res, 200, await getSmart());
      if (u.pathname === "/api/quotes") return send(res, 200, await getQuotes(parseList(u.searchParams.get("symbols"), 160)));
      if (u.pathname === "/api/sp500") return send(res, 200, await sp500Snapshot());
      if (u.pathname === "/api/history") {
        const [s] = parseList(u.searchParams.get("symbol"), 1);
        if (!s) return send(res, 400, { error: "symbol required" });
        return send(res, 200, await history(s, u.searchParams.get("range"), u.searchParams.get("interval")));
      }
      if (u.pathname === "/api/unlock" && req.method === "POST") {
        let pw = ""; try { pw = (await readBody(req)).password; } catch {}
        const g = claudeGate(req, String(pw || ""));
        return g ? send(res, ...g) : send(res, 200, { ok: true });
      }
      if (u.pathname === "/api/predict") {
        const raw = String(u.searchParams.get("symbol") || "MARKET").toUpperCase();
        const [s] = raw === "MARKET" ? ["MARKET"] : parseList(raw, 1);
        if (!s) return send(res, 400, { error: "Enter a valid ticker" });
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) return send(res, 401, { error: "no_key" });
        { const g = claudeGate(req, req.headers["x-claude-pass"]); if (g) return send(res, ...g); }
        if (!ipAllowed(req)) return send(res, 429, { error: "Hourly Claude limit reached (safety cap to protect your credits). Try again a bit later." });
        try { return send(res, 200, await predict(s, key, u.searchParams.get("fresh") === "1")); }
        catch (e) { return send(res, e.code === "daily_limit" ? 429 : 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/ask" && req.method === "POST") {
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) return send(res, 401, { error: "no_key" });
        { const g = claudeGate(req, req.headers["x-claude-pass"]); if (g) return send(res, ...g); }
        if (!ipAllowed(req)) return send(res, 429, { error: "Hourly Claude limit reached (safety cap to protect your credits). Try again a bit later." });
        try { return send(res, 200, await ask(key, await readBody(req))); }
        catch (e) { return send(res, e.code === "daily_limit" ? 429 : 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/search") {
        const q = String(u.searchParams.get("q") || "").trim().slice(0, 40);
        if (!q) return send(res, 200, { results: [] });
        try { return send(res, 200, { results: await search(q) }); }
        catch (e) { return send(res, 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/summary" || u.pathname === "/api/financials") {
        const [s] = parseList(u.searchParams.get("symbol"), 1);
        if (!s) return send(res, 400, { error: "symbol required" });
        try {
          return send(res, 200, u.pathname === "/api/summary" ? await summary(s) : await financials(s, u.searchParams.get("freq")));
        } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/movers") {
        try { return send(res, 200, await movers()); } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/earnings") {
        try { return send(res, 200, await earningsCalendar(parseList(u.searchParams.get("symbols"), 40))); } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/stream") {
        if (!FINNHUB || typeof WebSocket === "undefined") return send(res, 404, { error: "streaming_off" });
        return openStream(req, res, parseList(u.searchParams.get("symbols"), 60));
      }
      if (u.pathname === "/api/sync") {
        const code = String(u.searchParams.get("code") || "");
        if (code.length < 6 || code.length > 80) return send(res, 400, { error: "Sync code must be 6 to 80 characters" });
        try {
          if (req.method === "GET") return send(res, 200, { doc: await syncGet(code), durable: !!(UP_URL && UP_TOKEN) });
          if (req.method === "PUT" || req.method === "POST") {
            const doc = await readBody(req);
            if (!doc || typeof doc !== "object" || !doc.updated) return send(res, 400, { error: "bad data" });
            const cur = await syncGet(code);
            if (cur && cur.updated > doc.updated && !u.searchParams.get("force")) return send(res, 409, { error: "newer", doc: cur });
            await syncPut(code, doc);
            return send(res, 200, { ok: true, durable: !!(UP_URL && UP_TOKEN) });
          }
        } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/health") return send(res, 200, { ok: true, serverKey: !!process.env.ANTHROPIC_API_KEY, claudeUsedToday: claudeUsed(), claudeDailyLimit: DAILY_LIMIT, durableSync: !!(UP_URL && UP_TOKEN), streaming: !!FINNHUB && typeof WebSocket !== "undefined" });
      let file = path.normalize(path.join(PUBLIC, u.pathname === "/" ? "index.html" : u.pathname));
      if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden", "text/plain");
      fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, "Not found", "text/plain");
        send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
      });
    } catch (e) {
      send(res, 500, { error: String(e.message || e) });
    }
}

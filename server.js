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


// ---------------------------------------------------------------- article preview (publisher's own share metadata)
// Only the preview info publishers provide for link sharing (og:title / description / image / author / time).
// Full article text is NOT copied: sites block embedding, WSJ/Morningstar are paywalled, and it isn't ours to republish.
const PREVIEW_HOSTS = /(^|\.)(yahoo\.com|cnbc\.com|morningstar\.com|seekingalpha\.com|wsj\.com|reuters\.com|bloomberg\.com|marketwatch\.com|barrons\.com|ft\.com|nytimes\.com|apnews\.com|forbes\.com|fool\.com|investopedia\.com|businessinsider\.com|axios\.com|cnn\.com|bbc\.co\.uk|bbc\.com|theverge\.com|techcrunch\.com|federalreserve\.gov|sec\.gov)$/i;
async function articlePreview(url) {
  let u; try { u = new URL(url); } catch { throw new Error("bad url"); }
  if (u.protocol !== "https:" || !PREVIEW_HOSTS.test(u.hostname)) return { url, limited: true };
  return cached("pv:" + url, 60 * 60_000, async () => {
    const html = (await get(url, "text/html")).slice(0, 400_000);
    const meta = (names) => { for (const n of names) {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)["']`, "i")) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${n}["']`, "i"));
      if (m) return decode(m[1]).trim(); } return null; };
    const img = meta(["og:image", "twitter:image", "twitter:image:src"]);
    return { url, title: meta(["og:title", "twitter:title"]), description: meta(["og:description", "twitter:description", "description"]),
      image: img && /^https:\/\//.test(img) ? img : null, author: ((a) => a && /^https?:\/\//.test(a) ? a.replace(/\/+$/, "").split("/").pop().replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : a)(meta(["author", "article:author", "parsely-author", "sailthru.author"])),
      published: meta(["article:published_time", "parsely-pub-date", "pubdate", "date"]), site: meta(["og:site_name"]) };
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
const PASS_HASH = process.env.CLAUDE_PASSWORD_HASH || "c0ac999253905a7b3be1af512276821d:4d4a88f54ad298c56217184506034a7a802b03db15033fb68f1d3cf61a8ec18d";
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

// ---------------------------------------------------------------- private site login
// The real site needs the owner's site password; everyone else only gets the public demo (/demo).
// Login turns the password into a session key with scrypt (slow on purpose) and stores it in an
// HttpOnly cookie; each request is checked by hashing that cookie and comparing with SITE_CHECK.
// Only that one-way check value is in this (public) code, never the password or the key.
// SITE_PASSWORD in Render's settings replaces the built-in password.
const SITE_SALT = "md-site-v1:cb944adbcd40a4ff562c03f47f9498b7";
let SITE_CHECK = "bf2a3c78b6d18ed0605022ddd41ce1168c86dd92efe4fb4cca2ce9b36b734887";
const siteKey = (pw) => nodeCrypto.scryptSync(pw, SITE_SALT, 32, { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }).toString("hex");
if (process.env.SITE_PASSWORD) SITE_CHECK = nodeCrypto.createHash("sha256").update(Buffer.from(siteKey(process.env.SITE_PASSWORD), "hex")).digest("hex");
const keyOk = (hex) => /^[0-9a-f]{64}$/.test(hex || "") && nodeCrypto.timingSafeEqual(nodeCrypto.createHash("sha256").update(Buffer.from(hex, "hex")).digest(), Buffer.from(SITE_CHECK, "hex"));
const cookieOf = (req, name) => { const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")); return m ? decodeURIComponent(m[1]) : ""; };
const isOwner = (req) => keyOk(cookieOf(req, "md_owner"));
const loginTries = new Map();
function siteLogin(req, pw) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  const now = Date.now(), tries = (loginTries.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  if (tries.length >= 8) return { status: 429, error: "Too many wrong passwords. Try again in 15 minutes." };
  if (typeof pw !== "string" || !pw || pw.length > 200) return { status: 400, error: "Enter your password." };
  const key = siteKey(pw);
  if (keyOk(key)) return { status: 200, key };
  tries.push(now); loginTries.set(ip, tries); if (loginTries.size > 5000) loginTries.clear();
  return { status: 401, error: "Wrong password." };
}
const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Market Desk · Sign in</title><meta name="robots" content="noindex"><link rel="icon" type="image/svg+xml" href="/favicon-owner.svg?v=3"><link rel="apple-touch-icon" href="/apple-touch-icon-owner.png">
<meta name="theme-color" content="#0b0d10"><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e8ecf1;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;padding:16px}
form{width:min(380px,100%);background:#12151a;border:1px solid #232932;border-radius:16px;padding:28px 24px;display:flex;flex-direction:column;gap:14px}
.b{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.14em;font-size:13px}.b i{width:22px;height:22px;background:url(/favicon-owner.svg?v=3) center/contain no-repeat}.b span{color:#ff6fae}
h1{margin:4px 0 0;font-size:22px;letter-spacing:-.01em}p{margin:0;color:#8b95a3;font-size:13px}
input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #2d3540;background:#0b0d10;color:#e8ecf1;font-size:16px}input:focus{outline:2px solid #ff6fae;border-color:transparent}
button{padding:12px;border:0;border-radius:10px;background:#ff6fae;color:#1a0b12;font-weight:700;font-size:15px;cursor:pointer}button:disabled{opacity:.6}
.e{color:#ff6b6b;font-size:13px;min-height:18px}a{color:#8b95a3;font-size:13px;text-align:center}
</style></head><body><form id="f"><div class="b"><i></i>MARKET <span>DESK</span></div><h1>Owner sign-in</h1><p>This is Peter's private site. Recruiters and visitors: the public demo is open to everyone.</p>
<input type="text" name="username" value="owner" autocomplete="username" hidden><input id="p" type="password" placeholder="Password" autocomplete="current-password" autofocus required>
<div class="e" id="e"></div><button id="b">Sign in</button><a href="/demo">Open the public demo →</a></form>
<script>document.getElementById("f").onsubmit=async function(ev){ev.preventDefault();var b=document.getElementById("b"),e=document.getElementById("e");b.disabled=true;e.textContent="";
try{var r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})});var j=await r.json().catch(function(){return{}});
if(!r.ok)throw new Error(j.error||"Wrong password.");try{localStorage.setItem("ownerMode","1")}catch(x){}var n=new URLSearchParams(location.search).get("next")||"/";location.replace(/^\\/(?!\\/)/.test(n)?n:"/");}
catch(x){e.textContent=x.message;b.disabled=false;document.getElementById("p").select();}};</script></body></html>`;
// API routes anyone may use (the demo needs public market data); everything else is owner-only
const PUBLIC_API = new Set(["/api/news", "/api/bestbuys", "/api/trending", "/api/preview", "/api/smart", "/api/quotes", "/api/sp500", "/api/history", "/api/search", "/api/summary", "/api/financials", "/api/movers", "/api/earnings", "/api/stream", "/api/health", "/api/login"]);
const isPublicApi = (u, req) => PUBLIC_API.has(u.pathname) || ((u.pathname === "/api/autopilot" || u.pathname === "/api/daytrader") && req.method === "GET") || u.pathname.startsWith("/api/pub/");
// ---------------------------------------------------------------- abuse protection
// Per-visitor request budget for the API (keeps outbound traffic low so the free plan is never suspended)
const RL = new Map();
function rateLimited(req, owner) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  const now = Date.now(), max = owner ? 600 : 180;
  let b = RL.get(ip); if (!b || now - b.t > 60e3) { b = { t: now, n: 0 }; RL.set(ip, b); }
  b.n++; if (RL.size > 20000) RL.clear();
  return b.n > max;
}
const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()", "Strict-Transport-Security": "max-age=15552000",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};
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
const DAILY_LIMIT = Math.max(0, parseInt(process.env.CLAUDE_DAILY_LIMIT || "0", 10) || 0);
const usage = { day: "", count: 0 };
const etDay = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
function claudeUsed() { if (usage.day !== etDay()) { usage.day = etDay(); usage.count = 0; } return usage.count; }
function spendOne() {
  if (claudeUsed() >= DAILY_LIMIT) {
    const e = new Error(DAILY_LIMIT ? `Daily Claude limit reached (${DAILY_LIMIT} requests). It resets at midnight Eastern, or raise CLAUDE_DAILY_LIMIT in Render.` : "Claude is turned off so the site costs $0. To turn it on, set CLAUDE_DAILY_LIMIT (for example 20) in Render's Environment settings.");
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

// ---------------------------------------------------------------- AI vs. S&P 500 (free rules-based paper-trading bot)
// A $10,000 paper account that trades on its own all day, every trading day, with no Claude API calls.
// Every 10 minutes while the market is open it re-scores ~70 stocks using what the rest of the site shows:
//   analyst consensus (Best Buys scan) 30% · 3-month momentum 20% · trend vs 50/200-day averages 20%
//   · news sentiment from the site's feeds, trending stories and each stock's own headlines 20%
//   · today's strength vs the S&P 10% · plus an earnings adjustment (fresh beats up, misses down).
// Stops are checked every minute. Overnight and on weekends it keeps reading news and the earnings
// calendar and builds a plan that it carries out the moment the opening bell rings.
// Market filters: S&P below its 200-day average → 50% cash; market stress / black-swan headlines → 30%
// invested and no new buys. If the account falls below $1,000 (−90%) it counts as busted: the run is
// archived as a "test run" and a fresh $10,000 run starts.
const AP_FILE = path.join(require("os").tmpdir(), "autopilot-v2.json");
const AP_KEY = "pft:autopilot:v2";
const AP_RISK_SLOTS = 8; // 80% risk: 8 of the 10 equal slots go to high-volatility names
const AP_START = 10_000, AP_BUST = process.env.AP_TEST_BUST ? 9_990 : 1_000, AP_SLOTS = 10, AP_SLIP = 0.0005, AP_HOLD_MIN = 60 * 60e3;
const AP_FALLBACK = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","AVGO","TSLA","BRK-B","JPM","LLY","V","UNH","XOM","MA","COST","HD","PG","JNJ","WMT","NFLX","ABBV","BAC","CRM","ORCL","AMD","KO","MRK","CVX","PEP","ADBE","TMO","LIN","MCD","CSCO","ACN","ABT","WFC","GE","QCOM","INTU","CAT","TXN","DIS","IBM"];
const apFresh = () => ({ v: 2, run: 1, runs: [], start: Date.now(), cash: AP_START, positions: {}, trades: [], equity: [], intraday: [], lastRebalance: "", updated: Date.now() });
let AP = apFresh(), apBusy = false, apLoaded = false, apLastScore = 0, apLastPlan = 0, apSig = null;
const apBase = new Map(); // per-symbol daily inputs (moving averages, 3-month-ago price, name matcher)
const etParts = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, wd: p.weekday, min: (+p.hour % 24) * 60 + +p.minute };
};
function apFix() {
  if (!AP || AP.v !== 2) AP = apFresh();
  AP.run = AP.run || 1; AP.runs = AP.runs || []; AP.intraday = AP.intraday || []; AP.equity = AP.equity || []; AP.trades = AP.trades || []; AP.recent = AP.recent || {};
}
async function apLoad() {
  try {
    if (UP_URL && UP_TOKEN) {
      const r = await fetch(`${UP_URL}/get/${AP_KEY}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` }, signal: AbortSignal.timeout(8000) });
      const j = await r.json(); if (j.result) { AP = JSON.parse(j.result); apFix(); apLoaded = true; return; }
    }
  } catch {}
  try { AP = JSON.parse(fs.readFileSync(AP_FILE, "utf8")); } catch {}
  apFix(); apLoaded = true;
}
async function apSave() {
  AP.updated = Date.now();
  const body = JSON.stringify(AP);
  try { fs.writeFileSync(AP_FILE, body); } catch {}
  if (UP_URL && UP_TOKEN) { try { await fetch(`${UP_URL}/set/${AP_KEY}`, { method: "POST", headers: { Authorization: `Bearer ${UP_TOKEN}` }, body, signal: AbortSignal.timeout(8000) }); } catch {} }
}
const ySym = (s) => s.replace(".", "-");
const sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((x, y) => x + y, 0) / n : null);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
async function apMarketOpen() {
  const t = etParts();
  if (process.env.AP_TEST) return { open: process.env.AP_TEST !== "closed", t: { ...t, wd: "Tue", min: process.env.AP_TEST === "closed" ? 20 * 60 : 11 * 60 } };
  const BOT = BOTDIAG.market;
  if (t.wd === "Sat" || t.wd === "Sun" || t.min < 9 * 60 + 30 || t.min >= 16 * 60) { Object.assign(BOT, { at: Date.now(), open: false, why: "outside 9:30 AM–4 PM ET on a weekday" }); return { open: false, t }; }
  if (NYSE_HOLIDAYS.has(t.day)) { Object.assign(BOT, { at: Date.now(), open: false, why: "NYSE holiday" }); return { open: false, t }; }
  if (NYSE_EARLY.has(t.day) && t.min >= 13 * 60) { Object.assign(BOT, { at: Date.now(), open: false, why: "early close (1 PM)" }); return { open: false, t }; }
  try {
    const q = await quote("SPY"), fresh = Date.now() - q.marketTime < 20 * 60e3;
    // a quote older than 20 minutes in the middle of a session means trading is halted or the day is a holiday we don't know about
    const open = fresh || t.min < 9 * 60 + 50;
    Object.assign(BOT, { at: Date.now(), open, why: open ? "open (live SPY quote)" : "SPY quote hasn't updated for 20+ minutes", quoteError: null });
    return { open, t, spy: q };
  } catch (e) {
    // price feed hiccup: trust the exchange calendar instead of sitting out the whole day
    Object.assign(BOT, { at: Date.now(), open: true, why: "open (by the exchange calendar; SPY quote unavailable)", quoteError: String(e.message || e) });
    return { open: true, t };
  }
}
// NYSE full-day holidays and 1 PM early closes, 2026–2027 (nyse.com/markets/hours-calendars)
const NYSE_HOLIDAYS = new Set(["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"]);
const NYSE_EARLY = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
// What each bot last did and why — shown on the page so "why no trades?" has an answer
const BOTDIAG = { market: {}, swing: { errors: [] }, day: { errors: [], scans: 0, signals: 0, barsOk: 0, barsFail: 0 } };
const diagErr = (k, e) => { const l = BOTDIAG[k].errors; l.unshift({ t: Date.now(), e: String((e && e.message) || e).slice(0, 160) }); l.length = Math.min(l.length, 5); };
// latest price and model score per symbol (for "value after trade" and the signal score shown in the trade log)
const apPx = {}, apScoreOf = {};
const apRule = (side, why) => side === "BUY" ? "Ranking signal" : /^Stop-loss|^Trailing/.test(why) ? "Stop rule" : /earnings/i.test(why) ? "Earnings rule" : /^Bad news/.test(why) ? "News rule" : /average/.test(why) ? "Trend rule" : /^Fell to/.test(why) ? "Ranking rule" : /^Trimmed|^Defense/.test(why) ? "Risk limit" : /^Swapped/.test(why) ? "Swap rule" : /busted/i.test(why) ? "Bust reset" : "Rule";
function apTrade(st, side, sym, shares, price, why, name, sleeve) {
  const px = side === "BUY" ? price * (1 + AP_SLIP) : price * (1 - AP_SLIP), amt = shares * px;
  const p = st.positions[sym]; let pnl = null, pnlPct = null;
  if (side === "BUY") {
    st.cash -= amt;
    if (p) { p.cost = (p.cost * p.shares + amt) / (p.shares + shares); p.shares += shares; p.peak = Math.max(p.peak, px); }
    else st.positions[sym] = { shares, cost: px, at: Date.now(), peak: px, name: name || sym, sleeve: sleeve || "risk" };
  } else {
    if (!p) return;
    st.cash += amt;
    pnl = (px - p.cost) * shares; pnlPct = px / p.cost - 1;
    p.shares -= shares; if (p.shares < 1e-6) delete st.positions[sym];
    why += ` (${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(0)})`;
  }
  st.recent = st.recent || {}; st.recent[sym] = Date.now();
  const after = st.cash + Object.entries(st.positions).reduce((a, [k, q]) => a + q.shares * (apPx[k] || q.cost), 0);
  st.trades.unshift({ t: Date.now(), side, sym, shares: +shares.toFixed(4), price: +px.toFixed(2), amount: +amt.toFixed(2), why, rule: apRule(side, why),
    score: apScoreOf[sym] != null ? +apScoreOf[sym].toFixed(3) : null, after: +after.toFixed(2), cost: +(shares * price * AP_SLIP).toFixed(2), pnl: pnl == null ? null : +pnl.toFixed(2), pnlPct: pnlPct == null ? null : +pnlPct.toFixed(4) });
  st.trades = st.trades.slice(0, 1500);
}

// ---- news sentiment (headline word rules) ----
const AP_POS2 = /\b(beats?|tops?|topped|crush(es|ed)?|smash(es|ed)?) (\w+ )?(estimates|expectations|forecasts?|views?)|raises? (its |full-year |annual )?(guidance|outlook|forecast)|record (revenue|sales|profit|quarter)|upgrade[sd]?\b|\bsoar(s|ed|ing)?\b|\bsurg(e|es|ed|ing)\b|skyrocket|blowout/i;
const AP_POS1 = /\b(jumps?|jumped|rall(y|ies|ied)|gains?|climbs?|rises?|rose|higher|strong(er)?|buyback|approv(al|ed|es)|wins?|won|partnership|outperform|bullish|boost(s|ed)?|expands?|breakthrough|beats?)\b/i;
const AP_NEG2 = /\b(miss(es|ed)? (\w+ )?(estimates|expectations|forecasts?|views?)|cuts? (its |full-year )?(guidance|outlook|forecast)|lowers? (its )?(guidance|outlook|forecast)|downgrade[sd]?|plunge[sd]?|plummet(s|ed)?|tumble[sd]?|crash(es|ed)?|fraud|bankrupt\w*|chapter 11|sec (charges|probe|investigation)|recall(s|ed)?|guidance cut|profit warning)\b/i;
const AP_NEG1 = /\b(falls?|fell|drops?|dropped|slides?|slid|slump(s|ed)?|sinks?|sank|lower|weak(er|ness)?|probe|investigation|lawsuit|sues?|sued|layoffs?|warns?|warning|fined|delay(s|ed)?|halt(s|ed)?|bearish|concerns?|antitrust|misses?)\b/i;
const AP_SWAN = [/circuit breaker/i, /(market|trading)[- ]wide halt|exchange (halted|outage)/i, /flash crash/i, /bank run|run on (the )?bank/i, /emergency (rate|interest[- ]rate) cut|emergency (fed|central bank) (meeting|action)/i, /sovereign default|debt default/i, /declares? war|invasion of|act of war/i, /nuclear (attack|strike|detonation)|martial law/i, /worst (day|week|selloff|sell-off|crash) since (19\d\d|20[01]\d)/i, /(stocks?|markets?|dow|s&p|nasdaq) (crash|plunge|tumble|plummet)s? .{0,20}([3-9]|\d{2,})(\.\d)?%/i, /black swan/i];
function apTone(title) {
  const s = (AP_POS2.test(title) ? 2 : AP_POS1.test(title) ? 1 : 0) - (AP_NEG2.test(title) ? 2 : AP_NEG1.test(title) ? 1 : 0);
  return clamp(s, -2, 2);
}
const AP_GENERIC = new Set(["american","general","first","united","national","international","global","digital","advanced","applied","bank","energy","health","the","new","southern","western","eastern","northern","public","royal","capital","financial","technologies","solutions","group","systems","service","services","communications","pacific","atlantic","west","east","north","south","old","home","life","real","texas","ford"]);
function apMatcher(sym, name) {
  const s = sym.replace("-", "."), alts = [`\\(${s.replace(".", "\\.")}\\)`, `\\$${s.replace(".", "\\.")}\\b`];
  const clean = String(name || "").replace(/,?\s+(inc\.?|incorporated|corp\.?|corporation|co\.?|company|holdings?|plc|ltd\.?|limited|group|class [a-c]|n\.?v\.?|s\.?a\.?|& co\.?|the)\b\.?/gi, " ").replace(/\s+/g, " ").trim();
  if (clean.length >= 4) alts.push(`\\b${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const first = clean.split(" ")[0] || "";
  if (first.length >= 4 && !AP_GENERIC.has(first.toLowerCase())) alts.push(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}('s)?\\b`);
  if (s.length >= 3 && !/^(ALL|ARE|CAN|FOR|ONE|NOW|BIG|KEY|NEW|LOW|HAS|SEE|IT|ON|AI|GO|BE|SO|ANY|OUT|RUN|TEAM|LIFE|REAL|BEST|GOOD|FAST|OPEN|CASH|GOLD|HOME|PLAY|WELL|CARE|BOX)$/.test(s)) alts.push(`\\b${s.replace(".", "\\.")}\\b`);
  return new RegExp(alts.join("|"), "i");
}
// Gathers everything the news side of the site sees: market feeds from all five outlets, Google/CNBC top
// stories (trending), Smart Money (Fed, SEC, Treasury, newsletters), and each candidate's own Yahoo feed.
async function apNewsPool(syms) {
  const pool = [];
  const add = (title, time, src, w = 1) => { if (title) pool.push({ title, time: time || Date.now(), src, w, dated: !!time }); };
  try { (await getNews([], "24h")).items.forEach((i) => add(i.title, i.time, i.source)); } catch {}
  try { (await getTrending()).items.forEach((i) => add(i.title, Date.now() - 3 * 3600e3, "trending", 1.5)); } catch {}
  let macro = 0, swan = null;
  try { (await getSmart()).items.slice(0, 80).forEach((i) => { macro += apTone(i.title || "") * 0.2; add(i.title, i.time, "smart", 0.6); }); } catch {}
  for (const s of syms) {
    try { const r = await loadSource("yahoo", SOURCES.yahoo.ticker(s), s); r.items.forEach((i) => pool.push({ title: i.title, time: i.time || Date.now(), src: "yahoo", w: 1, sym: s })); } catch {}
  }
  for (const p of pool) if (!swan && p.dated && p.src !== "smart" && p.src !== "trending" && Date.now() - p.time < 24 * 3600e3 && AP_SWAN.some((re) => re.test(p.title))) swan = p.title;
  const seen = new Set();
  return { pool: pool.filter((p) => { const k = p.title.toLowerCase().slice(0, 90); if (seen.has(k)) return false; seen.add(k); return true; }), macro: clamp(macro, -3, 3), swan };
}
function apNewsFor(sym, re, pool) {
  let score = 0; const hits = [];
  for (const p of pool) {
    if (!(p.sym === sym || re.test(p.title))) continue;
    const ageH = Math.max(0, (Date.now() - p.time) / 3600e3); if (ageH > 96) continue;
    const t = apTone(p.title); if (!t) continue;
    const w = Math.exp(-ageH / 36) * p.w; score += t * w; hits.push({ title: p.title, t, w });
  }
  hits.sort((a, b) => Math.abs(b.t * b.w) - Math.abs(a.t * a.w));
  return { score: clamp(score, -4, 4), top: hits.slice(0, 2).map((h) => h.title) };
}
// ---- earnings: who reported last night/this morning (beat or miss) and who reports next ----
async function apEarnings() {
  if (!FINNHUB) return [];
  const from = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10), to = new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10);
  try { return await cached("apecal:" + from, 30 * 60e3, async () => ((await fh(`/calendar/earnings?from=${from}&to=${to}`)).earningsCalendar || [])); } catch { return []; }
}
function apEarnFor(sym, cal, today) {
  const s = sym.replace("-", "."), rows = cal.filter((e) => e.symbol === s);
  const tomorrow = new Date(Date.parse(today + "T12:00:00Z") + 86400e3).toISOString().slice(0, 10);
  const yday = new Date(Date.parse(today + "T12:00:00Z") - 86400e3).toISOString().slice(0, 10);
  for (const e of rows) {
    if (e.epsActual != null && e.epsEstimate != null && (e.date === today || e.date === yday || (e.date < today && e.date >= new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10)))) {
      const surprise = (e.epsActual - e.epsEstimate) / Math.max(0.01, Math.abs(e.epsEstimate));
      return { kind: surprise >= 0.03 ? "beat" : surprise <= -0.03 ? "miss" : "inline", surprise, date: e.date, hour: e.hour };
    }
  }
  for (const e of rows) if (e.epsActual == null && (e.date === today || e.date === tomorrow)) return { kind: "soon", date: e.date, hour: e.hour };
  return null;
}
async function apBaseFor(sym, day) {
  const b = apBase.get(sym); if (b && b.day === day) return b;
  const h = await history(sym, "1y"); const cl = h.candles.map((x) => x.close);
  if (cl.length < 120) throw new Error("short history");
  const rets = cl.slice(-127).map((c, i, a) => (i ? Math.log(c / a[i - 1]) : 0)).slice(1), mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length) * Math.sqrt(252);
  const out = { day, name: h.name, vol, last: cl[cl.length - 1], m50: sma(cl, 50), m200: sma(cl, Math.min(200, cl.length)), past: cl[Math.max(0, cl.length - 64)], re: apMatcher(sym, h.name) };
  apBase.set(sym, out); if (apBase.size > 400) apBase.delete(apBase.keys().next().value);
  return out;
}
// Scores every candidate. Returns the ranked list plus market-level signals.
async function apScore(live) {
  const t = etParts(), ranked = bbRank().all;
  const cal = await apEarnings();
  let cands = ranked.length >= 30 ? ranked.slice(0, 60).map((r) => ({ sym: ySym(r.sym), adj: r.adj })) : AP_FALLBACK.map((s) => ({ sym: s, adj: null }));
  const rated = (s) => { const r = BB.ratings[s.replace("-", ".")]; return r && r.n >= BB_MIN_N ? bbAdj(r) : null; };
  const spSet = new Set(SP500.map((r) => r[0]));
  // fresh earnings beats from well-covered companies join the candidate list (that's how an overnight report becomes a 9:30 buy)
  for (const e of cal) {
    const s = ySym(e.symbol);
    if (e.epsActual != null && e.epsEstimate != null && e.epsActual > e.epsEstimate && (rated(s) != null || spSet.has(s)) && !cands.find((c) => c.sym === s) && cands.length < 85) cands.push({ sym: s, adj: rated(s) });
  }
  for (const s of Object.keys(AP.positions)) if (!cands.find((c) => c.sym === s)) cands.push({ sym: s, adj: rated(s) });
  const out = [];
  for (const c of cands) {
    try { const fresh = !apBase.has(c.sym) || apBase.get(c.sym).day !== t.day; out.push({ ...c, ...(await apBaseFor(c.sym, t.day)) }); if (fresh) await new Promise((r) => setTimeout(r, 200)); } catch {}
  }
  // live prices (during the day) — otherwise yesterday's close
  const q = live ? (await getQuotes([...out.map((x) => x.sym), "SPY", "^VIX", "^GSPC"])).quotes : {};
  const spyDay = q.SPY && q.SPY.changePct || 0;
  // news: the five outlets, trending, Smart Money, plus own-feeds for holdings and the current top names
  const own = [...new Set([...Object.keys(AP.positions), ...out.slice().sort((a, b) => (b.adj || 0) - (a.adj || 0)).slice(0, 14).map((x) => x.sym)])].slice(0, 24);
  const news = await apNewsPool(own);
  for (const x of out) {
    const qq = q[x.sym]; x.px = qq && !qq.error && qq.price ? qq.price : x.last; x.day = qq && !qq.error ? qq.changePct || 0 : 0;
    x.mom = x.px / x.past - 1; x.trend = (x.px > x.m50 ? 0.5 : 0) + (x.px > x.m200 ? 0.5 : 0);
    const n = apNewsFor(x.sym, x.re, news.pool); x.news = n.score; x.headlines = n.top;
    x.earn = apEarnFor(x.sym, cal, t.day);
  }
  const pr = (k) => { const v = out.filter((x) => x[k] != null).map((x) => x[k]).sort((a, b) => a - b); return (x) => (x == null || !v.length ? 0.5 : v.filter((y) => y <= x).length / v.length); };
  const ra = pr("adj"), rm = pr("mom");
  for (const x of out) {
    const e = x.earn, eAdj = !e ? 0 : e.kind === "beat" ? Math.min(0.2, 0.08 + e.surprise) : e.kind === "miss" ? -0.35 : 0;
    x.score = 0.3 * ra(x.adj) + 0.2 * rm(x.mom) + 0.2 * x.trend + 0.2 * ((x.news + 4) / 8) + 0.1 * clamp((x.day - spyDay) / 6 + 0.5, 0, 1) + eAdj;
  }
  out.sort((a, b) => b.score - a.score); out.forEach((x, i) => { x.rank = i + 1; apPx[x.sym] = x.px; apScoreOf[x.sym] = x.score; });
  // 80% risk: the more volatile 60% of names feed the risk sleeve (8 slots), the calmest 40% the safe sleeve (2 slots)
  const vols = out.map((x) => x.vol).sort((a, b) => a - b), cut = vols[Math.floor(vols.length * 0.4)] || 0;
  let rr = 0, sr = 0; for (const x of out) { x.sleeve = x.vol > cut ? "risk" : "safe"; x.srank = x.sleeve === "risk" ? ++rr : ++sr; }
  let spx = null; try { const h = await history("^GSPC", "1y"); const cl = h.candles.map((c) => c.close); spx = { px: (q["^GSPC"] && q["^GSPC"].price) || cl[cl.length - 1], m200: sma(cl, 200), day: q["^GSPC"] && q["^GSPC"].changePct }; } catch {}
  const vix = q["^VIX"] && !q["^VIX"].error ? q["^VIX"] : null;
  const riskOff = !!(spx && spx.m200 && spx.px < spx.m200);
  // defense mode needs the market to agree: a scary headline alone (often opinion pieces) isn't enough
  const marketShaky = (vix && vix.price >= 25) || (spx && spx.day != null && spx.day <= -1.5);
  const stress = (vix && (vix.price >= 35 || vix.changePct >= 25)) ? `VIX fear index at ${vix.price.toFixed(1)}` : spx && spx.day <= -3 ? `S&P 500 down ${spx.day.toFixed(1)}% today` : news.swan && marketShaky ? `Black-swan headline with the market under stress: “${news.swan.slice(0, 110)}”` : null;
  return { list: out, riskOff, stress, macro: news.macro, vix: vix && vix.price, spyDay };
}
// Turns scores into trades on `st` (the real account, or a copy when planning overnight).
function apDecide(st, sc, opening) {
  const by = Object.fromEntries(sc.list.map((x) => [x.sym, x])), now = Date.now();
  const cool = (s) => st.recent && st.recent[s] && now - st.recent[s] < AP_HOLD_MIN;
  const val = () => st.cash + Object.entries(st.positions).reduce((s, [k, p]) => s + p.shares * (by[k] ? by[k].px : p.cost), 0);
  const fmtE = (e) => e.kind === "beat" ? `earnings beat by ${(e.surprise * 100).toFixed(0)}%` : `earnings missed by ${(-e.surprise * 100).toFixed(0)}%`;
  const slv = (s) => (st.positions[s] && st.positions[s].sleeve) || "risk";
  const held = (sl) => Object.keys(st.positions).filter((s) => slv(s) === sl);
  const SLOTS = { risk: AP_RISK_SLOTS, safe: AP_SLOTS - AP_RISK_SLOTS };
  // 1) sells
  for (const [sym, p] of Object.entries(st.positions)) {
    const x = by[sym]; if (!x) continue; const risk = slv(sym) === "risk";
    if (x.earn && x.earn.kind === "miss") apTrade(st, "SELL", sym, p.shares, x.px, `${opening ? "At the opening bell: " : ""}${fmtE(x.earn)} — sold before it can fall further`);
    else if (x.news <= -2.5) apTrade(st, "SELL", sym, p.shares, x.px, `Bad news: “${(x.headlines[0] || "").slice(0, 120)}”`);
    else if (risk ? x.px < x.m50 && x.px < x.m200 : x.px < x.m200) apTrade(st, "SELL", sym, p.shares, x.px, risk ? "Fell below both its 50- and 200-day averages — momentum is gone" : "Price broke below its 200-day average — trend turned down");
    else if (x.rank > (risk ? 25 : 35) && !cool(sym)) apTrade(st, "SELL", sym, p.shares, x.px, `Fell to #${x.rank} in the live rankings`);
  }
  // 80% risk profile: fully invested normally; still cuts back when the whole market breaks down
  const exposure = sc.stress ? 0.5 : sc.riskOff ? 0.8 : 0.99;
  const target = (val() * exposure) / AP_SLOTS;
  // 2) trims
  for (const [sym, p] of Object.entries(st.positions)) {
    const x = by[sym]; if (!x) continue; const v = p.shares * x.px;
    if (v > target * 1.6) apTrade(st, "SELL", sym, (v - target) / x.px, x.px, sc.stress ? `Defense mode — ${sc.stress}` : sc.riskOff ? "Trimmed — S&P 500 is below its 200-day average, so the bot keeps 20% cash" : "Trimmed back to an equal slot after a big run-up");
  }
  if (sc.stress) return;
  const ok = (x, sl) => x.sleeve === sl && !st.positions[x.sym] && !cool(x.sym) && x.px >= 5 && x.news > -1.5 && !(x.earn && (x.earn.kind === "miss" || x.earn.kind === "soon")) &&
    (sl === "risk" ? x.px > x.m50 || x.px > x.m200 || (x.earn && x.earn.kind === "beat") : x.px > x.m200);
  const why = (x) => {
    const bits = [x.sleeve === "risk" ? `high-risk pick (${Math.round(x.vol * 100)}% volatility)` : `safe pick (${Math.round(x.vol * 100)}% volatility)`];
    if (x.earn && x.earn.kind === "beat") bits.push(`${opening ? "reported overnight: " : ""}${fmtE(x.earn)}`);
    if (x.news >= 1 && x.headlines[0]) bits.push(`good news: “${x.headlines[0].slice(0, 90)}”`);
    if (x.adj != null) bits.push(`analysts ${x.adj >= 1 ? "strongly positive" : x.adj >= 0.5 ? "positive" : "mixed"}`);
    bits.push(`${x.mom >= 0 ? "+" : ""}${(x.mom * 100).toFixed(0)}% over 3 months`);
    if (Math.abs(x.day) >= 1) bits.push(`${x.day >= 0 ? "+" : ""}${x.day.toFixed(1)}% today`);
    return `Ranked #${x.rank}: ` + bits.join(", ");
  };
  for (const sl of ["risk", "safe"]) {
    // 3) swaps inside the sleeve: a much stronger name replaces the weakest holding (held at least an hour)
    let swaps = 0;
    for (const x of sc.list) {
      if (swaps >= 2 || held(sl).length < SLOTS[sl]) break;
      if (!ok(x, sl)) continue;
      const weakest = held(sl).filter((s) => by[s] && !cool(s)).sort((a, b) => by[a].score - by[b].score)[0];
      if (!weakest || x.score < by[weakest].score + 0.1) break;
      apTrade(st, "SELL", weakest, st.positions[weakest].shares, by[weakest].px, `Swapped out for ${x.sym}, which scores much higher (#${by[weakest].rank} vs #${x.rank})`);
      swaps++;
    }
    // 4) buys into empty slots
    for (const x of sc.list) {
      if (held(sl).length >= SLOTS[sl]) break;
      if (!ok(x, sl)) continue;
      const amt = Math.min(target, st.cash - 5); if (amt < 50) break;
      apTrade(st, "BUY", x.sym, amt / (x.px * (1 + AP_SLIP)), x.px, why(x), x.name, sl);
    }
  }
}
const apStops = (p) => (p.sleeve === "safe" ? [0.08, 0.1] : [0.15, 0.2]); // risk sleeve gets room to swing
function apValueNow(q) { return AP.cash + Object.entries(AP.positions).reduce((s, [k, p]) => s + p.shares * (q[k] && q[k].price ? q[k].price : p.cost), 0); }
function apSummary(end, busted, spxNow) {
  const vals = [AP_START, ...AP.equity.map((p) => p.v)], last = end;
  return { run: AP.run, start: AP.firstTrade || AP.start, end: Date.now(), startValue: AP_START, endValue: +last.toFixed(2), peak: +Math.max(...vals, last).toFixed(2), low: +Math.min(...vals, last).toFixed(2),
    trades: AP.trades.length, days: AP.equity.length, spxRet: AP.spx0 && spxNow ? +((spxNow / AP.spx0 - 1) * 100).toFixed(2) : null, busted };
}
function apSignals(sc) {
  const pick = (x) => ({ sleeve: x.sleeve, vol: +(x.vol || 0).toFixed(3), sym: x.sym, name: x.name, rank: x.rank, score: +x.score.toFixed(3), news: +x.news.toFixed(2), headline: x.headlines[0] || null, earn: x.earn, mom: +x.mom.toFixed(4), adj: x.adj == null ? null : +x.adj.toFixed(2), trend: x.trend, day: +(x.day || 0).toFixed(2), held: !!AP.positions[x.sym] });
  return { t: Date.now(), riskOff: sc.riskOff, stress: sc.stress, macro: +sc.macro.toFixed(2), vix: sc.vix,
    top: sc.list.slice(0, 15).map(pick),
    news: sc.list.filter((x) => Math.abs(x.news) >= 1).sort((a, b) => Math.abs(b.news) - Math.abs(a.news)).slice(0, 8).map(pick),
    earnings: sc.list.filter((x) => x.earn).sort((a, b) => (a.earn.kind === "soon") - (b.earn.kind === "soon")).slice(0, 12).map(pick) };
}
async function apTick() {
  if (apBusy) return; apBusy = true;
  try {
    if (!apLoaded) await apLoad();
    const m = await apMarketOpen(), now = Date.now();
    if (!m.open) {
      // overnight / weekend: keep reading news + earnings and plan the opening trades (every 10 minutes)
      if (now - apLastPlan >= 10 * 60e3) {
        apLastPlan = now;
        const sc = await apScore(false); apSig = apSignals(sc);
        const copy = JSON.parse(JSON.stringify({ cash: AP.cash, positions: AP.positions, trades: [], recent: AP.recent }));
        apDecide(copy, sc, true);
        AP.plan = { t: now, orders: copy.trades.reverse().map((x) => ({ side: x.side, sym: x.sym, amount: x.amount, why: x.why.replace(/ \([+−]\$\d+\)$/, "") })) };
        AP.lastScan = apSig; await apSave();
      }
      return;
    }
    BOTDIAG.swing.lastOpenTick = now;
    if (!AP.spx0) { try { AP.spx0 = (await quote("^GSPC")).price; AP.firstTrade = AP.firstTrade || now; } catch (e) { diagErr("swing", e); } }
    let syms = Object.keys(AP.positions), q = syms.length ? (await getQuotes(syms)).quotes : {};
    // stops every minute
    for (const s of syms) {
      const p = AP.positions[s], x = q[s]; if (!x || x.error || !x.price) continue;
      p.peak = Math.max(p.peak || p.cost, x.price); apPx[s] = x.price;
      const [sl, tr] = apStops(p), stop = Math.max(p.cost * (1 - sl), p.peak * (1 - tr));
      if (x.price <= stop) apTrade(AP, "SELL", s, p.shares, x.price, x.price <= p.cost * (1 - sl) ? `Stop-loss: down ${sl * 100}% from where it was bought` : `Trailing stop: fell ${tr * 100}% from its high`);
    }
    // full re-score every 10 minutes (and right at the opening bell)
    const opening = AP.lastRebalance !== m.t.day;
    if (opening || now - apLastScore >= 10 * 60e3) {
      apLastScore = now;
      const sc = await apScore(true); apSig = apSignals(sc);
      BOTDIAG.swing.lastScan = { t: now, candidates: sc.list.length, stress: sc.stress, riskOff: sc.riskOff, buysBefore: AP.trades.length };
      if (!AP.spx0) { try { AP.spx0 = (await quote("^GSPC")).price; AP.firstTrade = now; } catch {} }
      apDecide(AP, sc, opening);
      BOTDIAG.swing.lastScan.tradesMade = AP.trades.length - BOTDIAG.swing.lastScan.buysBefore;
      AP.lastRebalance = m.t.day; AP.lastScan = apSig; AP.plan = null;
    }
    syms = Object.keys(AP.positions); q = syms.length ? (await getQuotes(syms)).quotes : {};
    const eq = apValueNow(q);
    let spx = null; try { spx = (await quote("^GSPC")).price; } catch {}
    const pt = { d: m.t.day, v: +eq.toFixed(2), spx };
    if (AP.equity.length && AP.equity[AP.equity.length - 1].d === pt.d) AP.equity[AP.equity.length - 1] = pt; else AP.equity.push(pt);
    if (!AP.intraday.length || AP.intraday[0].d !== m.t.day) AP.intraday = [];
    if (!AP.intraday.length || now - AP.intraday[AP.intraday.length - 1].t >= 5 * 60e3) AP.intraday.push({ d: m.t.day, t: now, v: pt.v, spx });
    // busted: archive this test run and start a new one with a fresh $10,000
    if (eq < AP_BUST) {
      for (const [s, p] of Object.entries(AP.positions)) apTrade(AP, "SELL", s, p.shares, (q[s] && q[s].price) || p.cost, "Account busted — closing everything");
      AP.runs.unshift(apSummary(AP.cash, true, spx));
      Object.assign(AP, { run: AP.run + 1, start: now, cash: AP_START, positions: {}, trades: [], equity: [], intraday: [], recent: {}, spx0: null, firstTrade: null, lastRebalance: "" });
    }
    await apSave();
  } catch (e) { console.error("autopilot", e.message); diagErr("swing", e); } finally { apBusy = false; BOTDIAG.swing.lastTick = Date.now(); }
}
async function apView() {
  if (!apLoaded) await apLoad();
  const syms = Object.keys(AP.positions);
  const q = (await getQuotes([...syms, "^GSPC"])).quotes;
  const positions = syms.map((s) => { const p = AP.positions[s], x = q[s] || {}; const price = x.price || p.cost; return { sym: s, name: p.name, shares: p.shares, cost: p.cost, price, value: p.shares * price, pnl: (price - p.cost) * p.shares, pnlPct: (price / p.cost - 1) * 100, dayPct: x.changePct || 0, at: p.at, peak: p.peak, sleeve: p.sleeve || "risk", stop: Math.max(p.cost * (1 - apStops(p)[0]), Math.max(p.peak || p.cost, price) * (1 - apStops(p)[1])) }; }).sort((a, b) => b.value - a.value);
  const value = AP.cash + positions.reduce((s, p) => s + p.value, 0);
  const t = etParts(), wk = !(t.wd === "Sat" || t.wd === "Sun"), open = wk && t.min >= 570 && t.min < 960;
  const mode = open ? "Trading live — stops checked every minute, full re-score every 10 minutes" : "Market closed — reading news and earnings overnight, ready for the opening bell";
  const current = apSummary(value, false, q["^GSPC"] && q["^GSPC"].price);
  // subsequent performance: each recent trade's price vs. now (buys: gain since buying; sells: move since selling)
  const recentSyms = [...new Set(AP.trades.slice(0, 80).map((t) => t.sym))].filter((s) => !q[s]).slice(0, 40);
  const q2 = recentSyms.length ? (await getQuotes(recentSyms)).quotes : {};
  const nowPx = (s) => { const x = q[s] || q2[s]; return x && !x.error && x.price ? x.price : null; };
  const tradesOut = AP.trades.map((t, i) => (i < 80 && nowPx(t.sym) ? { ...t, since: nowPx(t.sym) / t.price - 1 } : t));
  const sells = AP.trades.filter((t) => t.side === "SELL" && t.pnl != null), wins = sells.filter((t) => t.pnl > 0), losses = sells.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  const eqv = AP.equity.map((p) => p.v), dr = eqv.slice(1).map((v, i) => v / eqv[i] - 1);
  const mean = dr.length ? dr.reduce((a, b) => a + b, 0) / dr.length : 0, sd = dr.length > 1 ? Math.sqrt(dr.reduce((a, b) => a + (b - mean) ** 2, 0) / (dr.length - 1)) : 0;
  let peak = AP_START, mdd = 0; for (const v of [AP_START, ...eqv, value]) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  const traded = AP.trades.reduce((a, t) => a + t.amount, 0), avgEq = eqv.length ? eqv.reduce((a, b) => a + b, 0) / eqv.length : AP_START;
  const spxNow = q["^GSPC"] && q["^GSPC"].price, spxRet = AP.spx0 && spxNow ? spxNow / AP.spx0 - 1 : null, ret = value / AP_START - 1;
  const analytics = { trades: AP.trades.length, closed: sells.length, winRate: sells.length ? wins.length / sells.length : null,
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null, avgWinPct: wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : null, avgLossPct: losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : null,
    profitFactor: gl > 0 ? gw / gl : wins.length ? null : null, grossWins: gw, grossLosses: gl, maxDrawdown: mdd, tradingDays: eqv.length,
    sharpe: dr.length >= 20 && sd ? (mean / sd) * Math.sqrt(252) : null, turnover: avgEq ? traded / avgEq : null, traded,
    costs: AP.trades.reduce((a, t) => a + (t.cost != null ? t.cost : t.amount * AP_SLIP), 0), totalReturn: ret, benchmarkReturn: spxRet, excessReturn: spxRet != null ? ret - spxRet : null };
  return { ...AP, diag: { market: BOTDIAG.market, ...BOTDIAG.swing }, trades: tradesOut, analytics, positions, value, startValue: AP_START, bustAt: AP_BUST, spxNow: q["^GSPC"] && q["^GSPC"].price, marketOpen: open, status: mode, current, durable: !!(UP_URL && UP_TOKEN) };
}
// The owner's browser keeps a backup; if a redeploy wiped the server copy, it posts it back.
function apRestore(doc) {
  if (!doc || typeof doc !== "object" || doc.v !== 2 || typeof doc.cash !== "number" || !doc.positions || !Array.isArray(doc.trades)) return { ok: false, error: "bad data" };
  const mine = AP.trades.length + (AP.runs || []).length * 1e4, theirs = doc.trades.length + (doc.runs || []).length * 1e4;
  if (theirs < mine || (AP.trades.length && doc.updated <= AP.updated)) return { ok: false, error: "server copy is newer" };
  const keep = ["run", "runs", "start", "cash", "positions", "trades", "equity", "intraday", "lastRebalance", "lastScan", "spx0", "firstTrade", "recent", "updated"];
  AP = apFresh(); for (const k of keep) if (doc[k] !== undefined) AP[k] = doc[k];
  AP.trades = AP.trades.slice(0, 1500); AP.equity = (AP.equity || []).slice(-2000); AP.runs = (AP.runs || []).slice(0, 200); apFix();
  apSave(); return { ok: true };
}
setTimeout(() => { apTick(); setInterval(apTick, process.env.AP_TEST ? 6000 : 60e3); }, process.env.AP_TEST ? 3000 : 60_000);

// ---------------------------------------------------------------- AI day trader (paper, intraday, longs + shorts)
// A second paper account that trades like a day trader: liquidity-sweep reversals at prior-day / pre-market /
// opening-range highs and lows, and gap-and-go on stocks with an earnings or news catalyst. Every trade is a
// limit-order entry with a bracket (stop-loss beyond the sweep wick, target at 2R; stop moves to breakeven at +1R).
// 2% of equity at risk per trade, max 3 positions, 12 trades a day, −6% daily loss limit, flat by 3:55 PM.
// Starts with $30,000 so it is above the $25,000 pattern-day-trader minimum; falling under $25,000 would lock a
// real account out of day trading, so that counts as a bust and a fresh $30,000 run starts.
// Data: free 1-minute Yahoo bars (every symbol every minute); all rules live in daytrade-core.js.
const DTC = require("./daytrade-core.js");
const DT_FILE = path.join(require("os").tmpdir(), "daytrader-v1.json"), DT_KEY = "pft:daytrader:v1";
const DT_START = 30_000, DT_PDT = 25_000, DT_RISK = 0.02, DT_MAXPOS = 4, DT_MAXTRADES = 20, DT_DAYSTOP = 0.06, DT_FEE_SHORT = 0.0001;
const DT_UNIVERSE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX", "PLTR", "COIN", "MU", "JPM", "XOM", "BA", "UBER",
  "SMCI", "MSTR", "HOOD", "SOFI", "ARM", "INTC", "SHOP", "CRWD", "SNOW", "RIVN", "MARA", "DKNG", "ORCL", "CRM", "ABNB"];
const dtFresh = () => ({ v: 1, run: 1, runs: [], start: Date.now(), cash: DT_START, positions: {}, orders: [], trades: [], equity: [], intraday: [], spx0: null, firstTrade: null, day: null, lastBar: {}, updated: Date.now() });
let DT = dtFresh(), dtLoaded = false, dtBusy = false, dtTickN = 0;
const dtPx = {}, dtSeq = { n: 0 };
async function dtLoad() {
  try { if (UP_URL && UP_TOKEN) { const r = await fetch(`${UP_URL}/get/${DT_KEY}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` }, signal: AbortSignal.timeout(8000) }); const j = await r.json(); if (j.result) { DT = { ...dtFresh(), ...JSON.parse(j.result) }; dtLoaded = true; return; } } } catch {}
  try { DT = { ...dtFresh(), ...JSON.parse(fs.readFileSync(DT_FILE, "utf8")) }; } catch {}
  dtLoaded = true;
}
async function dtSave() {
  DT.updated = Date.now(); const body = JSON.stringify(DT);
  try { fs.writeFileSync(DT_FILE, body); } catch {}
  if (UP_URL && UP_TOKEN) { try { await fetch(`${UP_URL}/set/${DT_KEY}`, { method: "POST", headers: { Authorization: `Bearer ${UP_TOKEN}` }, body, signal: AbortSignal.timeout(8000) }); } catch {} }
}
async function dtBars(sym) {
  return cached("dtb:" + sym, 50e3, async () => {
    const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m&includePrePost=true`, "application/json"));
    const r = j.chart && j.chart.result && j.chart.result[0]; if (!r || !r.timestamp) throw new Error("no bars");
    const q = r.indicators.quote[0], t0 = r.timestamp[0], e0 = etParts(new Date(t0 * 1000)).min, base = t0 - e0 * 60; // ET minutes from the first bar's offset
    const out = []; r.timestamp.forEach((t, i) => { if (q.close[i] == null || q.high[i] == null) return; out.push({ t, m: Math.round((t - base) / 60) % 1440, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
    return out;
  });
}
async function dtPrev(sym, today) {
  return cached(`dtp:${sym}:${today}`, 12 * 3600e3, async () => {
    const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, "application/json"));
    const r = j.chart.result[0], q = r.indicators.quote[0];
    const rows = r.timestamp.map((t, i) => ({ d: etParts(new Date(t * 1000)).day, h: q.high[i], l: q.low[i], c: q.close[i] })).filter((x) => x.c != null && x.d < today);
    return rows[rows.length - 1] || null;
  });
}
// catalysts the swing bot already found (earnings beats/misses, strong news) — feed the gap setup
function dtCatalysts() {
  const m = {}, sig = AP && AP.lastScan; if (!sig) return m;
  for (const x of sig.earnings || []) if (x.earn && (x.earn.kind === "beat" || x.earn.kind === "miss")) m[x.sym] = { s: x.earn.kind === "beat" ? 1 : -1, why: `earnings ${x.earn.kind === "beat" ? "beat" : "miss"} (${Math.round(x.earn.surprise * 100)}%)` };
  for (const x of sig.news || []) if (!m[x.sym] && Math.abs(x.news) >= 1.5) m[x.sym] = { s: Math.sign(x.news), why: `${x.news > 0 ? "good" : "bad"} news: “${(x.headline || "").slice(0, 80)}”` };
  return m;
}
const dtEquity = () => DT.cash + Object.entries(DT.positions).reduce((a, [s, p]) => a + (p.dir === "long" ? 1 : -1) * p.shares * (dtPx[s] || p.entry), 0);
function dtLog(x) { DT.trades.unshift({ id: ++dtSeq.n + "-" + Date.now(), t: x.t || Date.now(), ...x, after: +dtEquity().toFixed(2) }); DT.trades = DT.trades.slice(0, 2000); }
function dtExit(sym, px, why, t) {
  const p = DT.positions[sym]; if (!p) return;
  const pnl = DTC.pnlOf(p, px), R = pnl / (Math.abs(p.entry - p.stop0) * p.shares);
  DT.cash += (p.dir === "long" ? 1 : -1) * p.shares * px; delete DT.positions[sym]; dtPx[sym] = px;
  DT.day.pnl += pnl;
  dtLog({ t: t ? t * 1000 : Date.now(), side: p.dir === "long" ? "SELL" : "COVER", sym, shares: p.shares, price: +px.toFixed(2), amount: +(p.shares * px).toFixed(2), setup: p.setup, why, pnl: +pnl.toFixed(2), pnlPct: +(pnl / (p.entry * p.shares)).toFixed(4), R: +R.toFixed(2), held: Math.round(((t ? t * 1000 : Date.now()) - p.at) / 60000), cost: +(p.shares * px * 0.0002).toFixed(2), entry: p.entry, dir: p.dir });
}
function dtBar(sym, b) {
  dtPx[sym] = b.c;
  // working limit orders (placed on an earlier bar) can fill on this one
  for (const o of DT.orders.filter((x) => x.sym === sym && x.placed < b.t)) {
    if (b.t > o.expires) { DT.orders = DT.orders.filter((x) => x !== o); dtLog({ t: b.t * 1000, side: "CANCEL", sym, shares: o.shares, price: o.price, amount: 0, setup: o.setup, why: "Limit order expired unfilled — price never came back to the level" }); continue; }
    const px = DTC.fillOrder(o, b); if (px == null) continue;
    DT.orders = DT.orders.filter((x) => x !== o);
    if ((o.dir === "long" && px <= o.stop) || (o.dir === "short" && px >= o.stop)) { dtLog({ t: b.t * 1000, side: "CANCEL", sym, shares: o.shares, price: o.price, amount: 0, setup: o.setup, why: "Price gapped through the stop before the order could fill — skipped" }); continue; }
    const risk = Math.abs(px - o.stop), target = o.dir === "long" ? px + 2 * risk : px - 2 * risk;
    DT.positions[sym] = { dir: o.dir, shares: o.shares, entry: px, stop: o.stop, stop0: o.stop, target, setup: o.setup, at: b.t * 1000, why: o.why };
    const fee = o.dir === "short" ? o.shares * px * DT_FEE_SHORT : 0;
    DT.cash += (o.dir === "long" ? -1 : 1) * o.shares * px - fee; DT.day.trades++;
    if (!DT.firstTrade) DT.firstTrade = Date.now();
    dtLog({ t: b.t * 1000, side: o.dir === "long" ? "BUY" : "SHORT", sym, shares: o.shares, price: +px.toFixed(2), amount: +(o.shares * px).toFixed(2), setup: o.setup, why: o.why, stop: +o.stop.toFixed(2), target: +target.toFixed(2), score: o.conf, cost: +fee.toFixed(2), dir: o.dir });
  }
  const p = DT.positions[sym]; if (!p) return;
  const ex = DTC.manage(p, b); if (ex) dtExit(sym, ex.px, ex.why, b.t);
}
function dtPlace(sym, idea, setup, why, conf, lastT) {
  const eq = dtEquity(), gross = Object.entries(DT.positions).reduce((a, [s, p]) => a + p.shares * (dtPx[s] || p.entry), 0);
  const per = Math.abs(idea.entry - idea.stop) / idea.entry; if (per < 0.001 || per > 0.03) return false; // stop too tight to survive noise, or too wide for a day trade
  const shares = DTC.size(eq, idea.entry, idea.stop, DT_RISK, Math.min(2 * eq, 4 * eq - gross)); if (shares < 1) return false; // day-trading buying power: 4× equity, max 2× in one stock
  DT.orders.push({ sym, dir: idea.dir, price: +idea.entry.toFixed(2), stop: +idea.stop.toFixed(2), shares, setup, why, conf, placed: lastT, expires: lastT + 10 * 60 });
  dtLog({ t: lastT * 1000, side: "ORDER", sym, shares, price: +idea.entry.toFixed(2), amount: +(shares * idea.entry).toFixed(2), setup, why: `${idea.dir === "long" ? "Buy" : "Short"} limit @ $${idea.entry.toFixed(2)}, stop $${idea.stop.toFixed(2)}, target 2R — ${why}`, dir: idea.dir, score: conf });
  return true;
}
async function dtTick() {
  if (dtBusy) return; dtBusy = true;
  try {
    if (!dtLoaded) await dtLoad();
    const m = process.env.AP_TEST ? { open: true, t: { ...etParts(), wd: "Tue", min: 11 * 60 } } : await apMarketOpen();
    const t = m.t; if (!m.open && !(t.min >= 9 * 60 + 28 && t.min < 9 * 60 + 30 && t.wd !== "Sat" && t.wd !== "Sun")) return;
    if (!DT.day || DT.day.d !== t.day) DT.day = { d: t.day, startEq: dtEquity(), pnl: 0, trades: 0, halted: false, used: {} };
    const cats = dtCatalysts(), syms = [...new Set([...DT_UNIVERSE, ...Object.keys(cats).slice(0, 5), ...Object.keys(DT.positions), ...DT.orders.map((o) => o.sym)])];
    dtTickN++; BOTDIAG.day.scans++; BOTDIAG.day.lastOpenTick = Date.now();
    const batch = syms; // every symbol every minute
    const now = Date.now() / 1000;
    for (const sym of batch) {
      let bars; try { bars = await dtBars(sym); BOTDIAG.day.barsOk++; } catch (e) { BOTDIAG.day.barsFail++; diagErr("day", `${sym}: ${e.message || e}`); continue; }
      const done = bars.filter((b) => b.t <= now - 60), seen = DT.lastBar[sym] || 0;
      for (const b of done) if (b.t > seen && b.m >= DTC.OPEN) dtBar(sym, b);
      if (done.length) DT.lastBar[sym] = done[done.length - 1].t;
      const last = done[done.length - 1]; if (!last) continue;
      // look for a new setup
      if (DT.day.halted || t.min < DTC.OPEN + 5 || t.min >= 15 * 60 + 30 || DT.day.trades >= DT_MAXTRADES) continue;
      if (DT.positions[sym] || DT.orders.some((o) => o.sym === sym) || Object.keys(DT.positions).length + DT.orders.length >= DT_MAXPOS) continue;
      let prev = null; try { prev = await dtPrev(sym, t.day); } catch {}
      const lk = (L) => sym + ":" + L.k + ":" + L.p.toFixed(2), lv = DTC.levels(prev, done).filter((L) => !DT.day.used[lk(L)]);
      const sw = DTC.sweep(done, lv);
      if (sw) {
        BOTDIAG.day.signals++; BOTDIAG.day.lastSignal = { t: Date.now(), sym, setup: "sweep " + sw.level.k };
        DT.day.used[lk(sw.level)] = 1;
        const why = `${sym} swept the ${sw.level.name} ($${sw.level.p.toFixed(2)}) to $${sw.wick.toFixed(2)} on ${sw.volX.toFixed(1)}× normal volume, then closed back ${sw.dir === "short" ? "below" : "above"} it — stops were taken, fading the move`;
        dtPlace(sym, sw, "Liquidity sweep", why, Math.min(0.95, 0.5 + (sw.volX - 1.25) * 0.1), last.t); continue;
      }
      const c = cats[sym];
      if (prev && !DT.day.used[sym + ":GAP"]) {
        const g = DTC.gapGo(done, prev.c, c ? c.s : 0);
        if (g) { DT.day.used[sym + ":GAP"] = 1; dtPlace(sym, g, "News/earnings gap", `${sym} gapped ${g.gap >= 0 ? "up" : "down"} ${(Math.abs(g.gap) * 100).toFixed(1)}% on ${c ? c.why : "no single headline — a gap that size is news in itself"}, then broke its first-5-minute ${g.dir === "long" ? "high" : "low"} — limit at the breakout level`, 0.6, last.t); }
      }
    }
    // daily loss limit and end of day
    const eq = dtEquity();
    if (!DT.day.halted && eq - DT.day.startEq <= -DT_DAYSTOP * DT.day.startEq) { DT.day.halted = true; DT.orders = []; for (const s of Object.keys(DT.positions)) dtExit(s, dtPx[s] || DT.positions[s].entry, "Daily loss limit (−6%) hit — flat for the rest of the day"); }
    if (t.min >= 15 * 60 + 55 && !process.env.AP_TEST) { DT.orders = []; for (const s of Object.keys(DT.positions)) dtExit(s, dtPx[s] || DT.positions[s].entry, "End of day — day traders go home flat (3:55 PM)"); }
    // equity points (5-minute intraday + one per day) vs. the S&P 500
    let spx = null; try { spx = (await quote("^GSPC")).price; } catch {}
    if (!DT.spx0 && spx) DT.spx0 = spx; // the S&P side starts with the bot's first trading minute
    if (!DT.started) DT.started = Date.now();
    const v = +dtEquity().toFixed(2), nowMs = Date.now();
    if (DT.started) {
      if (!DT.intraday.length || DT.intraday[0].d !== t.day) DT.intraday = [];
      if (!DT.intraday.length || nowMs - DT.intraday[DT.intraday.length - 1].t >= 5 * 60e3) DT.intraday.push({ d: t.day, t: nowMs, v, spx });
      const pt = { d: t.day, v, spx }; if (DT.equity.length && DT.equity[DT.equity.length - 1].d === t.day) DT.equity[DT.equity.length - 1] = pt; else DT.equity.push(pt);
    }
    // pattern-day-trader lock = bust
    if (DT.firstTrade && v < DT_PDT) {
      DT.orders = []; for (const s of Object.keys(DT.positions)) dtExit(s, dtPx[s] || DT.positions[s].entry, "Account fell below $25,000 — a real account would be locked out of day trading");
      const vals = [DT_START, ...DT.equity.map((p) => p.v)];
      DT.runs.unshift({ run: DT.run, start: DT.firstTrade || DT.start, end: nowMs, startValue: DT_START, endValue: +dtEquity().toFixed(2), peak: +Math.max(...vals).toFixed(2), low: +Math.min(...vals, dtEquity()).toFixed(2), trades: DT.trades.filter((x) => x.pnl != null).length, days: DT.equity.length, spxRet: DT.spx0 && spx ? +((spx / DT.spx0 - 1) * 100).toFixed(2) : null, busted: true, reason: "PDT lock (< $25,000)" });
      DT = { ...dtFresh(), run: DT.run + 1, runs: DT.runs };
    }
    await dtSave();
  } catch (e) { console.error("daytrader", e.message); diagErr("day", e); } finally { dtBusy = false; BOTDIAG.day.lastTick = Date.now(); }
}
function botStats(trades, equity, start, value, spx0, spxNow) {
  const closed = trades.filter((t) => t.pnl != null), wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  const eqv = equity.map((p) => p.v), dr = eqv.slice(1).map((v, i) => v / eqv[i] - 1);
  const mean = dr.length ? dr.reduce((a, b) => a + b, 0) / dr.length : 0, sd = dr.length > 1 ? Math.sqrt(dr.reduce((a, b) => a + (b - mean) ** 2, 0) / (dr.length - 1)) : 0;
  let peak = start, mdd = 0; for (const v of [start, ...eqv, value]) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  const fills = trades.filter((t) => /^(BUY|SELL|SHORT|COVER)$/.test(t.side)), traded = fills.reduce((a, t) => a + t.amount, 0), avgEq = eqv.length ? eqv.reduce((a, b) => a + b, 0) / eqv.length : start;
  const ret = value / start - 1, spxRet = spx0 && spxNow ? spxNow / spx0 - 1 : null, Rs = closed.filter((t) => t.R != null).map((t) => t.R);
  return { trades: fills.length, closed: closed.length, winRate: closed.length ? wins.length / closed.length : null,
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null, avgWinPct: wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : null, avgLossPct: losses.length ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : null,
    profitFactor: gl > 0 ? gw / gl : null, grossWins: gw, grossLosses: gl, maxDrawdown: mdd, tradingDays: eqv.length, sharpe: dr.length >= 20 && sd ? (mean / sd) * Math.sqrt(252) : null,
    turnover: avgEq ? traded / avgEq : null, traded, costs: trades.reduce((a, t) => a + (t.cost || 0), 0), totalReturn: ret, benchmarkReturn: spxRet, excessReturn: spxRet != null ? ret - spxRet : null,
    avgR: Rs.length ? Rs.reduce((a, b) => a + b, 0) / Rs.length : null, longs: closed.filter((t) => t.dir === "long").length, shorts: closed.filter((t) => t.dir === "short").length,
    longPnl: closed.filter((t) => t.dir === "long").reduce((a, t) => a + t.pnl, 0), shortPnl: closed.filter((t) => t.dir === "short").reduce((a, t) => a + t.pnl, 0),
    bySetup: Object.entries(closed.reduce((m, t) => { const k = t.setup || "Other"; (m[k] = m[k] || []).push(t); return m; }, {})).map(([k, l]) => ({ setup: k, n: l.length, win: l.filter((t) => t.pnl > 0).length / l.length, pnl: l.reduce((a, t) => a + t.pnl, 0) })) };
}
async function dtView() {
  if (!dtLoaded) await dtLoad();
  const syms = Object.keys(DT.positions);
  const q = (await getQuotes([...syms, "^GSPC"])).quotes;
  for (const s of syms) if (q[s] && q[s].price && !dtPx[s]) dtPx[s] = q[s].price;
  const positions = syms.map((s) => { const p = DT.positions[s], price = dtPx[s] || p.entry, pnl = DTC.pnlOf(p, price); return { sym: s, dir: p.dir, shares: p.shares, entry: p.entry, stop: p.stop, target: p.target, price, pnl, value: p.shares * price, R: pnl / (Math.abs(p.entry - p.stop0) * p.shares), setup: p.setup, at: p.at, why: p.why, be: !!p.be }; });
  const value = dtEquity(), t = etParts(), wk = !(t.wd === "Sat" || t.wd === "Sun"), open = wk && t.min >= 570 && t.min < 960, spxNow = q["^GSPC"] && q["^GSPC"].price;
  const vals = [DT_START, ...DT.equity.map((p) => p.v), value];
  const current = { run: DT.run, start: DT.firstTrade || DT.start, end: Date.now(), startValue: DT_START, endValue: +value.toFixed(2), peak: +Math.max(...vals).toFixed(2), low: +Math.min(...vals).toFixed(2), trades: DT.trades.filter((x) => x.pnl != null).length, days: DT.equity.length, spxRet: DT.spx0 && spxNow ? +((spxNow / DT.spx0 - 1) * 100).toFixed(2) : null, busted: false };
  return { ...DT, kind: "day", diag: { market: BOTDIAG.market, ...BOTDIAG.day }, rawPositions: DT.positions, positions, value, startValue: DT_START, bustAt: DT_PDT, spxNow, marketOpen: open, current, analytics: botStats(DT.trades, DT.equity, DT_START, value, DT.spx0, spxNow), universe: DT_UNIVERSE, durable: !!(UP_URL && UP_TOKEN),
    status: open ? (DT.day && DT.day.halted ? "Daily loss limit hit — done for today" : "Trading live — scanning 1-minute bars for sweeps and gaps") : "Market closed — flat overnight, back at the opening bell",
    rules: { risk: DT_RISK, maxPos: DT_MAXPOS, maxTrades: DT_MAXTRADES, dayStop: DT_DAYSTOP } };
}
function dtRestore(doc) {
  if (!doc || typeof doc !== "object" || doc.v !== 1 || typeof doc.cash !== "number" || !Array.isArray(doc.trades)) return { ok: false, error: "bad data" };
  const mine = DT.trades.length + DT.runs.length * 1e4, theirs = doc.trades.length + (doc.runs || []).length * 1e4;
  if (theirs < mine || (DT.trades.length && doc.updated <= DT.updated)) return { ok: false, error: "server copy is newer" };
  DT = { ...dtFresh(), ...doc, trades: doc.trades.slice(0, 2000) }; dtSave(); return { ok: true };
}
setTimeout(() => { dtTick(); setInterval(dtTick, process.env.AP_TEST ? 7000 : 60e3); }, process.env.AP_TEST ? 5000 : 75_000);

// ---------------------------------------------------------------- SEC EDGAR fundamentals (free, no key)
// Annual figures from companies' own 10-K filings via the SEC's XBRL "company facts" API.
// SEC fair-access rules: at most 10 requests/second and a User-Agent naming a contact
// (set SEC_USER_AGENT in Render, e.g. "Market Desk research your@email"). We stay far below
// the limit: one SEC request at a time, results cached for 12 hours.
const SEC_UA = process.env.SEC_USER_AGENT || "Market Desk personal research project (github.com/phemmerdinger-cmyk/My-Terminal)";
let secChain = Promise.resolve();
function secGet(url) {
  const run = secChain.then(async () => {
    const r = await fetch(url, { headers: { "User-Agent": SEC_UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    await new Promise((ok) => setTimeout(ok, 250)); // ≤ 4 requests/second
    if (!r.ok) throw new Error(`SEC returned ${r.status}`);
    return r.json();
  });
  secChain = run.catch(() => {});
  return run;
}
const secTickers = () => cached("sec:tickers", 24 * 3600e3, async () => {
  const j = await secGet("https://www.sec.gov/files/company_tickers.json");
  const m = {}; for (const k in j) m[String(j[k].ticker).toUpperCase()] = { cik: j[k].cik_str, name: j[k].title };
  return m;
});
// tag fallbacks, in order of preference (companies switch tags over the years, so this is chosen per year)
const SEC_TAGS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "SalesRevenueGoodsNet", "RevenuesNetOfInterestExpense"],
  cogs: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold", "CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization"],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  pretaxIncome: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic"],
  incomeTax: ["IncomeTaxExpenseBenefit"],
  netIncome: ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
  eps: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"],
  interestExpense: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"],
  da: ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization", "Depreciation"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements"],
  cfo: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  cff: ["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
  inventory: ["InventoryNet"],
  totalAssets: ["Assets"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  ltDebt: ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"],
  ltDebtCurrent: ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent", "DebtCurrent"],
  ltDebtTotal: ["LongTermDebt"],
  shortDebt: ["ShortTermBorrowings", "CommercialPaper"],
  dilutedShares: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
};
const FLOW = new Set(["revenue", "cogs", "grossProfit", "operatingIncome", "pretaxIncome", "incomeTax", "netIncome", "eps", "interestExpense", "da", "capex", "cfo", "cff", "dilutedShares"]);
function secSeries(facts, tag, flow) {
  const f = facts["us-gaap"] && facts["us-gaap"][tag]; if (!f) return null;
  const unitKey = Object.keys(f.units).find((u) => u === "USD" || u === "USD/shares" || u === "shares") || Object.keys(f.units)[0];
  const byEnd = {};
  for (const x of f.units[unitKey]) {
    if (!/^(10-K|10-K\/A|20-F|20-F\/A|40-F)$/.test(x.form || "")) continue;
    if (flow) { if (!x.start) continue; const d = (Date.parse(x.end) - Date.parse(x.start)) / 864e5; if (d < 340 || d > 380) continue; } // full fiscal years only
    else if (x.start) continue;
    const prev = byEnd[x.end]; if (!prev || (x.filed || "") > (prev.filed || "")) byEnd[x.end] = x; // latest filing wins (restatements)
  }
  return { unit: unitKey, byEnd };
}
async function secFundamentals(sym) {
  sym = String(sym || "").toUpperCase().replace("-", ".");
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(sym)) throw new Error("bad symbol");
  return cached("sec:f:" + sym, 12 * 3600e3, async () => {
    const map = await secTickers(); const hit = map[sym] || map[sym.replace(".", "-")];
    if (!hit) return { symbol: sym, available: false, reason: "Not an SEC filer (the SEC only has U.S.-listed companies that file 10-Ks; ETFs and many foreign companies aren't covered)." };
    const j = await secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(hit.cik).padStart(10, "0")}.json`);
    const facts = j.facts || {};
    // fiscal-year ends come from revenue/net income/assets filings
    const S = {}; for (const k in SEC_TAGS) S[k] = SEC_TAGS[k].map((t) => [t, secSeries(facts, t, FLOW.has(k))]).filter(([, s]) => s && Object.keys(s.byEnd).length);
    const ends = new Set(); for (const k of ["revenue", "netIncome", "totalAssets"]) for (const [, s] of S[k]) for (const e of Object.keys(s.byEnd)) ends.add(e);
    // group ends that are within a few days of each other (52/53-week years)
    const sorted = [...ends].sort().reverse(), years = [];
    for (const e of sorted) if (!years.some((y) => Math.abs(Date.parse(y) - Date.parse(e)) < 20 * 864e5)) years.push(e);
    const pick = (k, end) => {
      for (const [tag, s] of S[k]) for (const e in s.byEnd) if (Math.abs(Date.parse(e) - Date.parse(end)) < 20 * 864e5) return { v: s.byEnd[e].val, tag, unit: s.unit, filed: s.byEnd[e].filed, form: s.byEnd[e].form };
      return null;
    };
    const rows = years.slice(0, 6).map((end) => {
      const r = { end }; const src = {};
      for (const k in SEC_TAGS) { const p = pick(k, end); if (p) { r[k] = p.v; src[k] = p.tag; r._unit = r._unit || (p.unit.startsWith("USD") ? "USD" : p.unit); r._filed = p.filed; r._form = p.form; } }
      if (r.grossProfit == null && r.revenue != null && r.cogs != null) { r.grossProfit = r.revenue - r.cogs; src.grossProfit = "computed: revenue − cost of revenue"; }
      const debtParts = r.ltDebtTotal != null ? [r.ltDebtTotal, r.shortDebt] : [r.ltDebt, r.ltDebtCurrent, r.shortDebt];
      if (debtParts.some((x) => x != null)) { r.totalDebt = debtParts.reduce((a, b) => a + (b || 0), 0); src.totalDebt = "computed: long-term + current debt + short-term borrowings"; }
      if (r.cfo != null && r.capex != null) { r.fcf = r.cfo - r.capex; src.fcf = "computed: operating cash flow − capital expenditures"; }
      r._src = src; return r;
    }).filter((r) => r.revenue != null || r.netIncome != null);
    const sh = facts.dei && facts.dei.EntityCommonStockSharesOutstanding;
    let shares = null;
    if (sh) { const list = Object.values(sh.units)[0].slice().sort((a, b) => (a.end > b.end ? 1 : -1)); const last = list[list.length - 1]; if (last) shares = { v: last.val, asOf: last.end, src: "dei:EntityCommonStockSharesOutstanding (cover page of latest filing)" }; }
    // dual-class companies report each class separately on the cover; fall back to diluted weighted shares if that looks too small
    const dil = rows[0] && rows[0].dilutedShares;
    if (dil && (!shares || shares.v < dil * 0.5)) shares = { v: dil, asOf: rows[0].end, src: "us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding (latest 10-K)" };
    return { symbol: sym, available: true, name: j.entityName || hit.name, cik: hit.cik, currency: (rows[0] && rows[0]._unit) || "USD", years: rows.reverse(), shares, source: "SEC EDGAR XBRL company facts (10-K / 20-F annual filings)", fetched: Date.now() };
  });
}

// ---------------------------------------------------------------- long price history for backtests and stress tests
// Daily or weekly closes plus Yahoo's dividend-and-split adjusted closes ("adj") between two dates.
// Cached for 6 hours; the backtester and risk tools run their math in the browser.
async function longHistory(sym, from, to, interval) {
  const p1 = Math.floor(Date.parse(from + "T00:00:00Z") / 1000), p2 = Math.floor(Date.parse(to + "T23:59:59Z") / 1000);
  if (!isFinite(p1) || !isFinite(p2) || p2 <= p1) throw new Error("bad dates");
  const iv = interval === "1wk" ? "1wk" : interval === "1mo" ? "1mo" : "1d";
  return cached(`lh:${sym}:${p1}:${p2}:${iv}`, 6 * 3600e3, async () => {
    let j = null, err;
    for (const [i, host] of ["query1", "query2"].entries()) {
      try {
        if (i) await new Promise((ok) => setTimeout(ok, 700));
        j = JSON.parse(await get(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=${iv}&events=div%2Csplit`, "application/json"));
        if (j.chart && j.chart.result && j.chart.result[0]) break;
      } catch (e) { err = e; j = null; }
    }
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) throw err || new Error((j && j.chart && j.chart.error && j.chart.error.description) || "no history");
    const q = r.indicators.quote[0], adj = (r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || null;
    const t = [], c = [], a = [];
    r.timestamp.forEach((ts, i) => { if (q.close[i] == null) return; t.push(ts); c.push(+q.close[i].toFixed(4)); a.push(adj && adj[i] != null ? +adj[i].toFixed(4) : null); });
    const divs = r.events && r.events.dividends ? Object.keys(r.events.dividends).length : 0;
    return { symbol: r.meta.symbol, name: r.meta.shortName || r.meta.longName || r.meta.symbol, currency: r.meta.currency, interval: iv, first: (r.meta.firstTradeDate || t[0]) || null, t, close: c, adj: a.some((x) => x != null) ? a : null, dividends: divs, source: "Yahoo Finance chart data" };
  });
}

// ---------------------------------------------------------------- macro dashboard (free government data, no keys)
// Primary source: FRED public CSV downloads. If FRED is slow or unreachable from the server, each series falls
// back to the original agency: U.S. Treasury yield-curve CSVs, the BLS public API (v1, no key), the New York
// Fed's effective fed funds API, the University of Michigan's sentiment CSV, and the NBER's recession dates.
// Everything is cached (6 hours; older history for 7 days) so each source is called only a few times a day.
const MACRO = [
  { id: "FEDFUNDS", name: "Federal funds rate", unit: "%", freq: "Monthly", src: "Board of Governors of the Federal Reserve System via FRED" },
  { id: "CPIAUCSL", name: "CPI inflation (year over year)", unit: "%", freq: "Monthly", yoy: true, src: "U.S. Bureau of Labor Statistics via FRED" },
  { id: "CPILFESL", name: "Core CPI inflation (ex food & energy)", unit: "%", freq: "Monthly", yoy: true, src: "U.S. Bureau of Labor Statistics via FRED" },
  { id: "UNRATE", name: "Unemployment rate", unit: "%", freq: "Monthly", src: "U.S. Bureau of Labor Statistics via FRED" },
  { id: "A191RL1Q225SBEA", name: "Real GDP growth (annualized)", unit: "%", freq: "Quarterly", src: "U.S. Bureau of Economic Analysis via FRED" },
  { id: "DGS2", name: "2-year Treasury yield", unit: "%", freq: "Daily", daily: true, src: "Board of Governors of the Federal Reserve System via FRED" },
  { id: "DGS10", name: "10-year Treasury yield", unit: "%", freq: "Daily", daily: true, src: "Board of Governors of the Federal Reserve System via FRED" },
  { id: "T10Y2Y", name: "Yield curve: 10-year minus 2-year", unit: "pts", freq: "Daily", daily: true, src: "Federal Reserve Bank of St. Louis via FRED" },
  { id: "T10Y3M", name: "Yield curve: 10-year minus 3-month", unit: "pts", freq: "Daily", daily: true, src: "Federal Reserve Bank of St. Louis via FRED" },
  { id: "UMCSENT", name: "Consumer sentiment", unit: "index", freq: "Monthly", src: "Surveys of Consumers, University of Michigan, via FRED (copyrighted, cited)" },
  { id: "SAHMREALTIME", name: "Sahm rule recession indicator", unit: "pts", freq: "Monthly", src: "Claudia Sahm via FRED" },
  { id: "USREC", name: "NBER recession (1 = in recession)", unit: "", freq: "Monthly", hidden: true, src: "NBER business-cycle dates via FRED" },
];
async function getT(url, accept, ms, init) {
  const r = await fetch(url, { ...(init || {}), headers: { "User-Agent": UA, Accept: accept || "*/*", ...((init && init.headers) || {}) }, signal: AbortSignal.timeout(ms || 20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text();
}
const weekly = (rows) => { const wk = new Map(); for (const r of rows) wk.set(Math.floor((Date.parse(r[0] + "T12:00:00Z") / 864e5 + 3) / 7), r); const out = [...wk.values()]; if (rows.length && out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]); return out; };
const yoy = (rows) => { const by = new Map(rows); return rows.map(([d, v]) => { const p = by.get(String(+d.slice(0, 4) - 1) + d.slice(4)); return p ? [d, +((v / p - 1) * 100).toFixed(2)] : null; }).filter(Boolean); };
async function fredCsv(m) {
  const start = m.daily ? new Date(Date.now() - 31 * 365.25 * 864e5).toISOString().slice(0, 10) : "1960-01-01";
  const csv = await getT(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${m.id}&cosd=${start}`, "text/csv", 8000);
  let rows = csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).filter((r) => r[1] && r[1] !== "." && isFinite(+r[1])).map((r) => [r[0], +r[1]]);
  if (!rows.length) throw new Error("empty series");
  return rows;
}
// ---- fallbacks ----
async function treasuryYields() {
  return cached("ust:all", 6 * 3600e3, async () => {
    const y0 = new Date().getUTCFullYear(), rows = [];
    for (let y = y0 - 9; y <= y0; y++) {
      const csv = await cached("ust:" + y, y < y0 ? 7 * 864e5 : 6 * 3600e3, () => getT(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`, "text/csv", 20000));
      const lines = csv.trim().split(/\r?\n/), head = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
      const ix = (n) => head.indexOf(n), i3 = ix("3 Mo"), i2 = ix("2 Yr"), i10 = ix("10 Yr");
      for (const l of lines.slice(1)) { const c = l.split(","); const [mm, dd, yy] = c[0].replace(/"/g, "").split("/"); if (!yy) continue; rows.push([`${yy}-${mm}-${dd}`, +c[i3], +c[i2], +c[i10]]); }
    }
    return rows.filter((r) => r.slice(1).every(isFinite)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  });
}
async function blsSeries(id) {
  const y0 = new Date().getUTCFullYear(), out = [];
  for (const [a, b] of [[y0 - 19, y0 - 10], [y0 - 9, y0]]) {
    const j = await cached(`bls:${a}`, b < y0 ? 7 * 864e5 : 12 * 3600e3, async () => JSON.parse(await getT("https://api.bls.gov/publicAPI/v1/timeseries/data/", "application/json", 20000,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seriesid: ["CUSR0000SA0", "CUSR0000SA0L1E", "LNS14000000"], startyear: String(a), endyear: String(b) }) })));
    const s = (j.Results && j.Results.series || []).find((x) => x.seriesID === id);
    if (s) for (const d of s.data) if (/^M(0[1-9]|1[0-2])$/.test(d.period) && isFinite(+d.value)) out.push([`${d.year}-${d.period.slice(1)}-01`, +d.value]);
  }
  if (!out.length) throw new Error("BLS returned no data");
  return [...new Map(out.map((r) => [r[0], r])).values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
async function nyfedEffr() {
  const end = new Date().toISOString().slice(0, 10), start = new Date(Date.now() - 10 * 365.25 * 864e5).toISOString().slice(0, 10);
  const j = JSON.parse(await getT(`https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=${start}&endDate=${end}`, "application/json", 20000));
  const daily = (j.refRates || []).map((r) => [r.effectiveDate, +r.percentRate]).filter((r) => isFinite(r[1])).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const m = new Map(); for (const [d, v] of daily) { const k = d.slice(0, 7) + "-01"; const x = m.get(k) || [0, 0]; m.set(k, [x[0] + v, x[1] + 1]); }
  return [...m].map(([d, [s, n]]) => [d, +(s / n).toFixed(2)]);
}
async function umichSentiment() {
  const csv = await getT("https://www.sca.isr.umich.edu/files/tbmics.csv", "text/csv", 20000);
  const M = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  return csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(",")).filter((c) => M[(c[0] || "").trim().toLowerCase()] && isFinite(+c[2])).map((c) => [`${c[1].trim()}-${String(M[c[0].trim().toLowerCase()]).padStart(2, "0")}-01`, +c[2]]);
}
const NBER = [["1960-05", "1961-02"], ["1970-01", "1970-11"], ["1973-12", "1975-03"], ["1980-02", "1980-07"], ["1981-08", "1982-11"], ["1990-08", "1991-03"], ["2001-04", "2001-11"], ["2008-01", "2009-06"], ["2020-03", "2020-04"]];
function nberMonthly() { const rows = []; const now = new Date(); for (let y = 1960; y <= now.getUTCFullYear(); y++) for (let m = 1; m <= 12; m++) { const k = `${y}-${String(m).padStart(2, "0")}`; if (Date.parse(k + "-01") > now) break; rows.push([k + "-01", NBER.some(([a, b]) => k >= a && k <= b) ? 1 : 0]); } return rows; }
function sahmFrom(unrate) { // 3-month average unemployment minus the lowest 3-month average of the prior 12 months
  const a3 = unrate.map((r, i) => (i >= 2 ? [r[0], (unrate[i][1] + unrate[i - 1][1] + unrate[i - 2][1]) / 3] : null)).filter(Boolean);
  return a3.map((r, i) => (i >= 12 ? [r[0], +(r[1] - Math.min(...a3.slice(i - 12, i).map((x) => x[1]))).toFixed(2)] : null)).filter(Boolean);
}
async function macroFallback(id, have) {
  if (["DGS2", "DGS10", "T10Y2Y", "T10Y3M"].includes(id)) { const t = await treasuryYields(); const f = { DGS2: (r) => r[2], DGS10: (r) => r[3], T10Y2Y: (r) => r[3] - r[2], T10Y3M: (r) => r[3] - r[1] }[id]; return { rows: t.map((r) => [r[0], +f(r).toFixed(2)]), src: "U.S. Department of the Treasury daily par yield curve (last 10 years)" }; }
  if (id === "CPIAUCSL") return { rows: await blsSeries("CUSR0000SA0"), src: "U.S. Bureau of Labor Statistics public API (CPI-U, seasonally adjusted)" };
  if (id === "CPILFESL") return { rows: await blsSeries("CUSR0000SA0L1E"), src: "U.S. Bureau of Labor Statistics public API (core CPI-U, seasonally adjusted)" };
  if (id === "UNRATE") return { rows: await blsSeries("LNS14000000"), src: "U.S. Bureau of Labor Statistics public API" };
  if (id === "SAHMREALTIME") { const u = have.UNRATE || await blsSeries("LNS14000000"); return { rows: sahmFrom(u), src: "Computed here from BLS unemployment with the Sahm-rule formula (not the official real-time series)" }; }
  if (id === "FEDFUNDS") return { rows: await nyfedEffr(), src: "Federal Reserve Bank of New York, effective federal funds rate (monthly average)" };
  if (id === "UMCSENT") return { rows: await umichSentiment(), src: "Surveys of Consumers, University of Michigan (copyrighted, cited)" };
  if (id === "USREC") return { rows: nberMonthly(), src: "NBER business-cycle dates" };
  throw new Error("no free fallback for this series");
}
let fredDownUntil = 0; // after one FRED failure, go straight to the agency sources for an hour
async function macroSeries(m, have) {
  return cached("macro:s:" + m.id, 6 * 3600e3, async () => {
    let rows = null, src = m.src, note = null;
    if (Date.now() > fredDownUntil) { try { rows = await fredCsv(m); } catch (e) { fredDownUntil = Date.now() + 3600e3; note = `FRED unavailable (${e.message}); used the original agency instead`; } }
    else note = "FRED unreachable from the server recently; used the original agency instead";
    if (!rows) { const f = await macroFallback(m.id, have); rows = f.rows; src = f.src; }
    if (m.yoy) rows = yoy(rows);
    if (m.daily) rows = weekly(rows);
    return { rows, src, note };
  });
}
async function macroData() {
  const hit = cache.get("macro:all");
  if (hit && hit.data && Date.now() - hit.at < (hit.data.complete ? 30 * 60e3 : 20 * 60e3)) return hit.data;
  return cached("macro:all", 0, async () => {
    const have = {}, res = [];
    for (let i = 0; i < MACRO.length; i += 3) { // a few at a time, to be gentle with the sources
      const part = await Promise.allSettled(MACRO.slice(i, i + 3).map((m) => macroSeries(m, have)));
      part.forEach((p, k) => { const m = MACRO[i + k]; if (p.status === "fulfilled" && m.id === "UNRATE") have.UNRATE = p.value.rows; res.push(p); });
    }
    const series = MACRO.map((m, i) => res[i].status === "fulfilled" ? { ...m, data: res[i].value.rows, src: res[i].value.src, note: res[i].value.note } : { ...m, data: null, error: String((res[i].reason && res[i].reason.message) || res[i].reason) });
    return { updated: Date.now(), complete: series.every((s) => s.data), source: "FRED (Federal Reserve Bank of St. Louis), with Treasury, BLS, New York Fed, University of Michigan and NBER as fallbacks", series };
  });
}

// ---------------------------------------------------------------- http
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function parseList(v, max) {
  return [...new Set(String(v || "").toUpperCase().split(",").map((s) => s.trim()).filter((s) => TICKER_RE.test(s)))].slice(0, max);
}

const zlib = require("zlib");
const STATIC_GZ = new Map(); // file -> {mtime, raw, gz, etag}
function send(res, code, body, type = "application/json", extra = {}) {
  const st = costCtx.getStore();
  let buf = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const h = { ...SEC_HEADERS, "Content-Type": type, "Cache-Control": "no-store", ...(st && st.cost > 0 ? { "X-Api-Cost": st.cost.toFixed(6) } : {}), ...extra };
  const ae = String((res.req && res.req.headers["accept-encoding"]) || "");
  if (!h["Content-Encoding"] && /json|text|javascript|svg|xml/.test(type) && buf.length > 1024 && /\bgzip\b/.test(ae)) {
    buf = zlib.gzipSync(buf, { level: 6 }); h["Content-Encoding"] = "gzip"; h.Vary = "Accept-Encoding";
  }
  res.writeHead(code, h);
  res.end(buf);
}

process.on("unhandledRejection", (e) => console.error("unhandled:", e && e.message));
process.on("uncaughtException", (e) => console.error("uncaught:", e && e.message));

http
  .createServer((req, res) => costCtx.run({ cost: 0 }, () => handle(req, res)))
  .listen(PORT, () => console.log(`Stock News Hub running at http://localhost:${PORT}`));
async function handle(req, res) {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname.startsWith("/api/")) {
        const owner = isOwner(req);
        if (u.pathname !== "/api/stream" && u.pathname !== "/api/health" && rateLimited(req, owner)) return send(res, 429, { error: "Too many requests — slow down for a minute." }, "application/json", { "Retry-After": "60" });
        if (!owner && !isPublicApi(u, req)) return send(res, 401, { error: "This part of Market Desk is private.", code: "private" });
        if (u.pathname === "/api/login" && req.method === "POST") {
          let pw = ""; try { pw = (await readBody(req)).password; } catch {}
          const r = siteLogin(req, pw);
          if (r.status !== 200) return send(res, r.status, { error: r.error });
          return send(res, 200, { ok: true }, "application/json", { "Set-Cookie": `md_owner=${r.key}; Path=/; Max-Age=${180 * 86400}; HttpOnly; Secure; SameSite=Lax` });
        }
      }
      if (u.pathname === "/api/news") {
        const r = String(u.searchParams.get("range") || "");
        return send(res, 200, await getNews(parseList(u.searchParams.get("tickers"), 25), r in RANGE_DAYS ? r : ""));
      }
      if (u.pathname === "/api/bestbuys") return send(res, 200, await bestBuys());
      if (u.pathname === "/api/trending") return send(res, 200, await getTrending());
      if (u.pathname === "/api/preview") return send(res, 200, await articlePreview(u.searchParams.get("url") || "").catch((e) => ({ url: u.searchParams.get("url"), limited: true, error: String(e.message || e) })));
      if (u.pathname === "/api/smart") return send(res, 200, await getSmart());
      if (u.pathname === "/api/pub/hist") {
        const [s] = parseList(u.searchParams.get("symbol"), 1); const d = /^\d{4}-\d{2}-\d{2}$/;
        const from = String(u.searchParams.get("from") || ""), to = String(u.searchParams.get("to") || new Date().toISOString().slice(0, 10));
        if (!s || !d.test(from) || !d.test(to)) return send(res, 400, { error: "symbol, from and to (YYYY-MM-DD) are required" });
        try { return send(res, 200, await longHistory(s, from, to, u.searchParams.get("interval"))); }
        catch (e) { return send(res, 502, { error: `No price history for ${s} (${String(e.message || e)}).` }); }
      }
      if (u.pathname === "/api/pub/macro") return send(res, 200, await macroData());
      if (u.pathname === "/api/pub/sec") {
        try { return send(res, 200, await secFundamentals(u.searchParams.get("symbol"))); }
        catch (e) { return send(res, 502, { error: "SEC data is unavailable right now (" + String(e.message || e) + "). Try again in a minute." }); }
      }
      if (u.pathname === "/api/autopilot" && req.method === "GET") return send(res, 200, await apView());
      if (u.pathname === "/api/daytrader" && req.method === "GET") return send(res, 200, await dtView());
      if (u.pathname === "/api/daytrader/restore" && req.method === "POST") { if (!dtLoaded) await dtLoad(); let doc = null; try { doc = await readBody(req); } catch {} return send(res, 200, dtRestore(doc)); }
      if (u.pathname === "/api/autopilot/restore" && req.method === "POST") { // owner-only (signed-in cookie checked above)
        if (!apLoaded) await apLoad();
        let doc = null; try { doc = await readBody(req); } catch {}
        return send(res, 200, apRestore(doc));
      }
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
      // pages: the real site is owner-only; /demo is the public recruiter view
      const owner = isOwner(req);
      const go = (loc, extra = {}) => send(res, 302, "", "text/plain", { Location: loc, ...extra });
      if (u.pathname === "/login") return owner ? go("/") : send(res, 200, LOGIN_HTML, "text/html; charset=utf-8");
      if (u.pathname === "/logout") return go("/login", { "Set-Cookie": "md_owner=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
      let page = null;
      if (u.pathname === "/demo" || u.pathname === "/demo/") page = "index.html";
      else if (u.pathname === "/" || u.pathname === "/index.html" || u.pathname === "/ai-vs-sp500") {
        if (u.searchParams.has("visitor")) return go("/demo");
        if (!owner) return go(u.pathname === "/ai-vs-sp500" ? "/demo#aitrade" : "/login");
        page = "index.html";
      }
      const file = path.normalize(path.join(PUBLIC, page || u.pathname));
      if (!file.startsWith(PUBLIC + path.sep) || (!page && file === path.join(PUBLIC, "index.html"))) return send(res, 404, "Not found", "text/plain");
      fs.stat(file, (err, stt) => {
        if (err || !stt.isFile()) return send(res, 404, "Not found", "text/plain");
        const type = MIME[path.extname(file)] || "application/octet-stream";
        let c = STATIC_GZ.get(file);
        const done = () => {
          const html = /html/.test(type);
          const hdr = { ETag: c.etag, "Cache-Control": html ? "no-cache" : "public, max-age=86400" };
          if (req.headers["if-none-match"] === c.etag) return send(res, 304, "", type, hdr);
          const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] || "")) && c.gz;
          send(res, 200, gz || c.raw, type, gz ? { ...hdr, "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : hdr);
        };
        if (c && c.mtime === stt.mtimeMs) return done();
        fs.readFile(file, (e2, data) => {
          if (e2) return send(res, 404, "Not found", "text/plain");
          const comp = /json|text|javascript|svg|xml|manifest|icon/.test(type) && data.length > 1024;
          c = { mtime: stt.mtimeMs, raw: data, gz: comp ? zlib.gzipSync(data, { level: 9 }) : null, etag: '"' + nodeCrypto.createHash("sha1").update(data).digest("hex").slice(0, 16) + '"' };
          STATIC_GZ.set(file, c); done();
        });
      });
    } catch (e) {
      send(res, 500, { error: String(e.message || e) });
    }
}

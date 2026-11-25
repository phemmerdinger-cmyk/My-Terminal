// Market Desk — zero-dependency Node.js server (Node 22+)
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
// Deploy mode (deploy-mode-core.js): unset = legacy owner sign-in + /demo; "public" = demo-only server
// that runs the bots; "local" = owner desk on 127.0.0.1 that forwards bot/data routes to PUBLIC_URL.
const DM = require("./deploy-mode-core.js");
const DEPLOY = DM.parseMode(process.env);
// data integrity + system health (data/): per-source availability, redacted error log, validation checks
const { createHealth } = require("./data/health.js");
const INTEG = require("./data/integrity.js");
const HEALTH = createHealth();
const PUBLIC = path.join(__dirname, "public");
const FINNHUB = process.env.FINNHUB_API_KEY;
// Free multi-asset data layer: one schema for every instrument (public/instruments-core.js) and keyless sources
// behind a request gate (market-data-core.js), so bursts of clicks or many visitors can't get this server throttled.
const MDC = require("./market-data-core.js");
const INST = require("./public/instruments-core.js");
const YGATE = MDC.createGate({ concurrency: 4, minGapMs: 100 }); // ≈10 Yahoo requests a second at most, shared by pages and bots
const YAHOO_HOST = /^https:\/\/[a-z0-9.]*finance\.yahoo\.com\//;
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
  const go = async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { const e = new Error(`HTTP ${res.status} for ${url}`); e.status = res.status; throw e; }
    return res.text();
  };
  return YAHOO_HOST.test(url) ? YGATE.run(go) : go();
}
get = HEALTH.track(get, (url) => url);

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

const TICKER_RE = /^[A-Z0-9.\-^=]{1,21}$/; // up to 21 for option contracts (AAPL260109C00190000)

// ---------------------------------------------------------------- news archive (older headlines)
// RSS feeds only hold the latest stories, so older news comes from Google News
// searches limited to each outlet's site and split into date windows.
const RANGE_DAYS = { closed: 4, today: 1, "24h": 1, week: 7, month: 31, "6m": 183, year: 366, all: null };
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
  jobs.push(loadOfficial(tickers).then((r) => ({ key: "official", ...r })).catch(() => ({ key: "official", ok: false, items: [] })));
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
    sources: { ...Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, { name: s.name, ok: !!status[k] }])), official: { name: "Official (Fed, SEC, BLS, BEA, Treasury)", ok: !!status.official } },
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

// ---------------------------------------------------------------- official sources (free, public domain or public record)
// Federal Reserve Board, SEC, BLS, BEA and Treasury publish in the public domain (17 U.S.C. §105 / the agencies' own
// website policies), and SEC EDGAR filings are public records. Those are the only pages whose full text the in-site
// reader shows; every other publisher gets its own headline, summary and a link back.
const OFFICIAL_FEEDS = [
  { agency: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { agency: "SEC", url: "https://www.sec.gov/news/pressreleases.rss" },
  { agency: "BLS", url: "https://www.bls.gov/feed/bls_latest.rss" },
  { agency: "BEA", url: "https://apps.bea.gov/rss/rss.xml" },
];
const ITEMS_8K = { "1.01": "material agreement", "1.02": "agreement ended", "1.05": "cybersecurity incident", "2.01": "acquisition or sale completed", "2.02": "results of operations (earnings)", "2.03": "new debt obligation", "2.05": "restructuring costs", "2.06": "impairment", "3.01": "delisting notice", "4.01": "auditor change", "4.02": "prior financials unreliable", "5.01": "change in control", "5.02": "executive or director change", "5.03": "bylaw change", "5.07": "shareholder vote results", "7.01": "Reg FD disclosure", "8.01": "other events", "9.01": "exhibits" };
async function treasuryPress() {
  return cached("off:treasury", 30 * 60e3, async () => {
    const html = await get("https://home.treasury.gov/news/press-releases", "text/html");
    const out = [], seen = new Set();
    for (const m of html.matchAll(/<time[^>]*datetime="([^"]+)"[^>]*>[\s\S]{0,400}?<a[^>]+href="(\/news\/press-releases\/[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const link = "https://home.treasury.gov" + m[2]; if (seen.has(link)) continue; seen.add(link);
      out.push({ title: stripTags(m[3]), link, summary: "", time: Date.parse(m[1]) || null, agency: "Treasury" });
    }
    return out.slice(0, 15);
  });
}
async function filings8K(tickers) {
  const out = [];
  for (const t of tickers.filter((x) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(x)).slice(0, 12)) {
    try {
      const cik = await secCik(t), sub = await secSubs(cik), r = sub.filings && sub.filings.recent; if (!r) continue;
      for (let i = 0; i < Math.min(r.form.length, 60); i++) {
        if (r.form[i] !== "8-K") continue; const when = Date.parse(r.acceptanceDateTime[i] || r.filingDate[i]); if (!when || Date.now() - when > 45 * 864e5) break;
        const items = String(r.items[i] || "").split(",").map((x) => x.trim()).filter((x) => x && x !== "9.01");
        out.push({ title: `${t} 8-K: ${items.map((x) => ITEMS_8K[x] || "item " + x).join(", ") || "current report"}`, link: edgarUrl(cik, r.accessionNumber[i], r.primaryDocument[i]), summary: `Form 8-K filed with the SEC by ${sub.name || t}${items.length ? ` · Item${items.length > 1 ? "s" : ""} ${items.join(", ")}` : ""}.`, time: when, agency: "SEC filing", ticker: t, items });
      }
    } catch {}
  }
  return out;
}
async function loadOfficial(tickers) {
  const feeds = await Promise.allSettled([...OFFICIAL_FEEDS.map((f) => fetchFeed(f.url).then((l) => l.slice(0, 20).map((i) => ({ ...i, agency: f.agency })))), treasuryPress(), filings8K(tickers)]);
  const ok = feeds.some((r) => r.status === "fulfilled" && r.value.length);
  const items = feeds.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).map((it, n, a) => ({
    id: ("official|" + it.agency + "|" + it.title).toLowerCase().replace(/\W+/g, "").slice(0, 120), source: "official", agency: it.agency, title: it.title, link: it.link,
    summary: (it.summary || "").slice(0, 280), time: it.time, mood: sentiment(it.title), tickers: it.ticker ? [it.ticker] : [], pct: 0.5, items8k: it.items || undefined, rights: "public" }));
  return { ok, items };
}

// ---------------------------------------------------------------- in-site article reader
// Full text only for public-domain / public-record hosts, fetched with an allowlist on every redirect hop (no SSRF).
// Everything else: the publisher's own metadata (title, description, author, date) and a link back. The browser
// renders the result as plain text, so nothing from a fetched page can run on this site.
const FULLTEXT_HOSTS = [
  [/^(www\.)?federalreserve\.gov$/i, "Board of Governors of the Federal Reserve System", "Public domain: the Federal Reserve Board's website policy allows copying with credit."],
  [/^(www\.)?bls\.gov$/i, "U.S. Bureau of Labor Statistics", "Public domain: BLS material may be reproduced with credit."],
  [/^(www\.|apps\.)?bea\.gov$/i, "U.S. Bureau of Economic Analysis", "Public domain: a U.S. government work (17 U.S.C. §105)."],
  [/^home\.treasury\.gov$/i, "U.S. Department of the Treasury", "Public domain: a U.S. government work (17 U.S.C. §105)."],
  [/^(www\.)?sec\.gov$/i, "U.S. Securities and Exchange Commission", "Public record on SEC.gov."],
];
const fullHost = (h) => FULLTEXT_HOSTS.find(([re]) => re.test(h));
async function govFetch(url) {
  let u = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== "https:" || !fullHost(u.hostname)) throw new Error("not an allowed host");
    const sec = /(^|\.)sec\.gov$/i.test(u.hostname);
    const r = await fetch(u.href, { redirect: "manual", headers: { "User-Agent": sec ? SEC_UA : UA, Accept: "text/html,application/xhtml+xml,text/plain" }, signal: AbortSignal.timeout(12000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { u = new URL(r.headers.get("location"), u); continue; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const ct = r.headers.get("content-type") || ""; if (!/text\/html|text\/plain|application\/xhtml/.test(ct)) throw new Error("not a text page");
    return { url: u.href, html: (await r.text()).slice(0, 2_500_000) };
  }
  throw new Error("too many redirects");
}
function extractArticle(html) {
  const meta = (n) => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)["']`, "i")); return m ? decode(m[1]).trim() : null; };
  let body = html.replace(/<(script|style|noscript|svg|form|iframe|template)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const pick = body.match(/<div[^>]+id=["']article["'][\s\S]*$/i) || body.match(/<article[\s\S]*?<\/article>/i) || body.match(/<main[\s\S]*?<\/main>/i) || body.match(/<body[\s\S]*?<\/body>/i);
  body = (pick ? pick[0] : body).replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ");
  body = body.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, x) => "\n§PRE§" + x.replace(/<[^>]+>/g, "").replace(/\n/g, "§NL§") + "\n");
  body = body.replace(/<h[1-4][^>]*>/gi, "\n§H§").replace(/<li[^>]*>/gi, "\n• ").replace(/<(br|\/p|p|\/div|\/tr|\/li|\/h\d|\/table|\/blockquote)[^>]*>/gi, "\n").replace(/<td[^>]*>/gi, " │ ").replace(/<[^>]+>/g, " ");
  const text = decode(body).replace(/[ \t ​]+/g, " ");
  const paras = []; let chars = 0;
  for (let line of text.split("\n")) {
    line = line.trim(); if (!line) continue;
    if (line.startsWith("§PRE§")) { for (const block of line.slice(5).split(/§NL§\s*§NL§/)) { const t = block.replace(/§NL§/g, "\n").replace(/[ ]+$/gm, "").trim(); if (t) { paras.push({ t, pre: true }); chars += t.length; } } continue; }
    const h = line.startsWith("§H§"); line = line.replace(/^§H§\s*/, ""); if (!line || line.length < 2) continue;
    if (!h && line.length < 25 && !/[.:;!?]$/.test(line) && paras.length < 3) continue; // menu crumbs before the story
    paras.push(h ? { t: line, h: true } : { t: line }); chars += line.length;
    if (chars > 90_000 || paras.length > 600) { paras.push({ t: "… (shortened here — the full document is at the original link)" }); break; }
  }
  const title = meta("og:title") || stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const published = meta("article:published_time") || meta("dcterms.date") || meta("DC.date.issued") || (html.match(/<time[^>]+datetime="([^"]+)"/i) || [])[1] || null;
  return { title, published, author: meta("author"), description: meta("og:description") || meta("description"), paragraphs: paras };
}
async function articleFull(url) {
  let u; try { u = new URL(String(url)); } catch { throw new Error("bad url"); }
  if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error("only plain https article links can be opened");
  const host = fullHost(u.hostname);
  if (u.protocol === "https:" && host) {
    return cached("art:" + u.href, 6 * 3600e3, async () => {
      const r = await govFetch(u.href), a = extractArticle(r.html);
      const filing = /\/Archives\/edgar\/data\//.test(r.url);
      return { url: r.url, host: new URL(r.url).hostname, full: a.paragraphs.length > 0, publisher: host[1], rights: filing ? "Public SEC filing: written by the company and filed with the SEC (public record)." : host[2], ...a };
    });
  }
  const pv = await articlePreview(u.href).catch(() => ({ url: u.href, limited: true }));
  return { url: u.href, host: u.hostname, full: false, publisher: pv.site || u.hostname.replace(/^www\./, ""), rights: "Publisher's article: only the publisher's own summary is shown here. Read the full story on their site.", title: pv.title || null, description: pv.description || null, author: pv.author || null, published: pv.published || null, image: pv.image || null, paragraphs: [] };
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
const { getExtendedQuotes } = require("./market-session-core.js");
function firstTradingDay(sym, meta) {
  return Number.isFinite(meta.firstTradeDate) && meta.firstTradeDate > 0 ? etParts(new Date(meta.firstTradeDate * 1000)).day : null;
}
// Quotes for every asset class. Yahoo first (stocks, ETFs, global equities, indexes, futures, FX, crypto); when it
// fails, keyless fallbacks by class: crypto → Coinbase, then Binance.US; FX → Frankfurter reference rate;
// Treasury yields → FRED. Fallback quotes say which source they came from and whether they're reference values.
async function quote(sym) {
  return cached("q:" + sym, INST.assetClassOf(sym) === "crypto" ? MDC.TTL.cryptoQuote : 15_000, async () => {
    try { return await yahooQuote(sym); }
    catch (e) { const fb = await quoteFallback(sym).catch(() => null); if (fb) return fb; throw e; }
  });
}
async function quoteFallback(sym) {
  const cls = INST.assetClassOf(sym);
  if (cls === "crypto") {
    try {
      const [t, st] = await Promise.all([get(`https://api.exchange.coinbase.com/products/${encodeURIComponent(sym)}/ticker`, "application/json"), get(`https://api.exchange.coinbase.com/products/${encodeURIComponent(sym)}/stats`, "application/json")]);
      return MDC.coinbaseQuote(sym, JSON.parse(t), JSON.parse(st));
    } catch {
      const b = MDC.binanceUsSymbol(sym); if (!b) return null;
      return MDC.binanceUsQuote(sym, JSON.parse(await get(`https://api.binance.us/api/v3/ticker/24hr?symbol=${b}`, "application/json")));
    }
  }
  if (cls === "forex") { const pair = INST.forexPair(sym); if (!pair) return null; return MDC.frankfurterQuote(sym, JSON.parse(await cached(`fx:${pair.join("")}`, MDC.TTL.fx, () => get(MDC.frankfurterUrl(pair[0], pair[1]), "application/json")))); }
  if (MDC.FRED_FOR[sym]) return MDC.fredQuote(sym, await cached(`fred:${MDC.FRED_FOR[sym]}`, MDC.TTL.fred, () => get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${MDC.FRED_FOR[sym]}`, "text/csv")));
  return null;
}
async function yahooQuote(sym) {
  {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m&includePrePost=true`;
    const j = JSON.parse(await get(url, "application/json"));
    const r = j.chart && j.chart.result && j.chart.result[0];
    if (!r) throw new Error("no data");
    const m = r.meta;
    const bars = r.indicators?.quote?.[0] || {};
    const closes = (bars.close || []).filter((x) => x != null);
    const firstDay = firstTradingDay(sym, m);
    const debut = firstDay && etParts().day === firstDay;
    // On a debut morning the vendor can publish the offer as the last price, with no traded candle.
    const firstPrint = debut ? (r.timestamp || []).findLastIndex((ts, i) => {
      if (!(bars.volume?.[i] > 0 && bars.close?.[i] > 0)) return false;
      const t = etParts(new Date(ts * 1000));
      return t.day === firstDay && t.min >= 570 && t.min < 960;
    }) : -1;
    const regular = m.currentTradingPeriod?.regular;
    const lastRegular = regular ? (r.timestamp || []).findLastIndex((ts, i) => ts >= regular.start && ts < regular.end && bars.close?.[i] > 0) : -1;
    const verifiedDebutMeta = firstPrint >= 0 && Number.isFinite(m.regularMarketPrice) && m.regularMarketPrice > 0 &&
      m.regularMarketVolume > 0 && m.regularMarketTime >= r.timestamp[firstPrint] && m.regularMarketTime <= regular?.end &&
      m.regularMarketTime <= Date.now() / 1000;
    const price = debut && !verifiedDebutMeta ? (firstPrint >= 0 ? bars.close[firstPrint] : null)
      : m.regularMarketPrice ?? (lastRegular >= 0 ? bars.close[lastRegular] : null);
    const prev = debut ? null : m.chartPreviousClose ?? m.previousClose;
    return {
      symbol: m.symbol,
      name: m.shortName || m.longName || m.symbol,
      price,
      prevClose: prev,
      change: debut || price == null ? null : price - prev,
      changePct: debut || price == null ? null : prev ? ((price - prev) / prev) * 100 : 0,
      currency: m.currency,
      exchange: m.fullExchangeName || m.exchangeName,
      ...(regular?.start < regular?.end ? { regularSession: { start: regular.start * 1000, end: regular.end * 1000 } } : {}),
      marketTime: (debut && !verifiedDebutMeta ? (firstPrint >= 0 ? r.timestamp[firstPrint] : 0) : m.regularMarketTime || 0) * 1000,
      ...(debut && firstPrint < 0 ? { status: "awaiting-market-print" } : {}),
      ...getExtendedQuotes(m, r.timestamp || [], bars, { debut: !!debut, barSeconds: 300 }),
      dayHigh: price == null && debut ? null : m.regularMarketDayHigh,
      dayLow: price == null && debut ? null : m.regularMarketDayLow,
      volume: m.regularMarketVolume,
      high52: debut ? null : m.fiftyTwoWeekHigh,
      low52: debut ? null : m.fiftyTwoWeekLow,
      spark: debut && firstPrint < 0 ? [] : closes.length > 60 ? closes.filter((_, i) => i % Math.ceil(closes.length / 60) === 0) : closes,
      // multi-asset fields: the provider's instrument type, its own session times and any exchange delay
      instrumentType: m.instrumentType || null, exchangeTimezone: m.exchangeTimezoneName || null, periods: MDC.tradingPeriods(m),
      delayMin: Number.isFinite(m.exchangeDataDelayedBy) && m.exchangeDataDelayedBy > 0 ? m.exchangeDataDelayedBy : 0, provider: "yahoo",
    };
  }
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
    if (!res) { if (HIST_LAST.has(key)) return HIST_LAST.get(key); throw lastErr || new Error("no history"); }
    const q = res.indicators?.quote?.[0] || {};
    const ipo = firstTradingDay(sym, res.meta) === etParts().day;
    const candles = [];
    (res.timestamp || []).forEach((t, i) => {
      const open = q.open?.[i], high = q.high?.[i], low = q.low?.[i], close = q.close?.[i], volume = q.volume?.[i] || 0;
      if (open == null || close == null) return;
      if (ipo && (!(volume > 0) || ![open, high, low, close].every((price) => Number.isFinite(price) && price > 0))) return;
      candles.push({ time: t, open, high, low, close, volume });
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
// The S&P 500 list refreshes itself once a day from the dataset the bundled public/sp500.json came from (sp500-core.js).
// A download that fails or doesn't look like the S&P 500 keeps the last good list. Served at /sp500.json.
const SPC = require("./sp500-core.js");
let SP500_META = (() => { try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, "public", "sp500.json"), "utf8")); return { asOf: j.asOf, source: j.source }; } catch { return { asOf: null, source: SPC.SOURCE }; } })();
async function sp500Refresh() {
  try {
    const next = SPC.constituentsFromCsv(await get(SPC.CSV_URL, "text/csv"), new Date().toISOString().slice(0, 10));
    const d = SPC.diff(SP500, next.rows);
    SP500.splice(0, SP500.length, ...next.rows);
    SP500_META = { asOf: next.asOf, source: next.source, checkedAt: Date.now(), joined: d.added, left: d.removed };
  } catch (e) { SP500_META = { ...SP500_META, checkedAt: Date.now(), error: String(e.message || e) }; }
}
if (!process.env.AP_TEST) { setTimeout(sp500Refresh, 90_000).unref(); setInterval(sp500Refresh, 24 * 3600e3).unref(); }
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
// local mode: only this computer can connect (127.0.0.1), so everyone here is the owner; public mode: nobody is
const isOwner = (req) => DEPLOY.mode === "local" || (DEPLOY.mode !== "public" && keyOk(cookieOf(req, "md_owner")));
const loginTries = new Map();
function siteLogin(req, pw) {
  const ip = DM.clientIp(req.headers, req.socket.remoteAddress);
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
</style></head><body><form id="f"><div class="b"><i></i>MARKET <span>DESK</span></div><h1>Owner sign-in</h1><p>This is Peter's private site.</p>
<input type="text" name="username" value="owner" autocomplete="username" hidden><input id="p" type="password" placeholder="Password" autocomplete="current-password" autofocus required>
<div class="e" id="e"></div><button id="b">Sign in</button></form>
<script>document.getElementById("f").onsubmit=async function(ev){ev.preventDefault();var b=document.getElementById("b"),e=document.getElementById("e");b.disabled=true;e.textContent="";
try{var r=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:document.getElementById("p").value})});var j=await r.json().catch(function(){return{}});
if(!r.ok)throw new Error(j.error||"Wrong password.");try{localStorage.setItem("ownerMode","1")}catch(x){}var n=new URLSearchParams(location.search).get("next")||"/";location.replace(/^\\/(?!\\/)/.test(n)?n:"/");}
catch(x){e.textContent=x.message;b.disabled=false;document.getElementById("p").select();}};</script></body></html>`;
// API routes anyone may use (the demo needs public market data); everything else is owner-only
const PUBLIC_API = new Set(["/api/article", "/api/news", "/api/bestbuys", "/api/trending", "/api/preview", "/api/smart", "/api/quotes", "/api/sp500", "/api/history", "/api/search", "/api/instrument", "/api/options", "/api/summary", "/api/financials", "/api/movers", "/api/earnings", "/api/stream", "/api/health", "/api/login"]);
const isPublicApi = (u, req) => PUBLIC_API.has(u.pathname) || ((u.pathname === "/api/autopilot" || u.pathname === "/api/daytrader" || u.pathname === "/api/quanttrader") && req.method === "GET") || u.pathname.startsWith("/api/pub/");
// ---------------------------------------------------------------- abuse protection
// Per-visitor request budget for the API (keeps outbound traffic low so the free plan is never suspended)
const RL = new Map();
function rateLimited(req, owner) {
  const ip = DM.clientIp(req.headers, req.socket.remoteAddress);
  const now = Date.now(), max = owner ? 600 : 180;
  let b = RL.get(ip); if (!b || now - b.t > 60e3) { b = { t: now, n: 0 }; RL.set(ip, b); }
  b.n++; if (RL.size > 20000) RL.clear();
  return b.n > max;
}
const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()", "Strict-Transport-Security": "max-age=15552000",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
};
// Returns null if allowed, or [status, body] to send back
function claudeGate(req, pw) {
  const ip = DM.clientIp(req.headers, req.socket.remoteAddress);
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
// Budget: Claude spends real money, so every call is priced from the tokens Anthropic reports and added to a running
// total that is saved on the server. CLAUDE_BUDGET_USD (default $4.00) is the hard ceiling; CLAUDE_DAILY_USD
// (default $1.00) spreads it out. CLAUDE_DAILY_LIMIT=0 switches Claude off entirely.
const DAILY_LIMIT = process.env.CLAUDE_DAILY_LIMIT === "0" ? 0 : Math.max(1, parseInt(process.env.CLAUDE_DAILY_LIMIT || "300", 10) || 300);
const BUDGET_USD = Math.max(0, parseFloat(process.env.CLAUDE_BUDGET_USD || "4") || 0), DAILY_USD = Math.max(0.05, parseFloat(process.env.CLAUDE_DAILY_USD || "1") || 1);
const SPEND_FILE = require("path").join(require("os").tmpdir(), "claude-spend-v1.json"), SPEND_KEY = "pft:claude:spend:v1";
let SPEND = { total: 0, days: {}, calls: 0, since: Date.now() }, spendLoaded = false, spendSaveT = null;
async function spendLoad() {
  if (spendLoaded) return; spendLoaded = true;
  try { const R = process.env.UPSTASH_REDIS_REST_URL, T = process.env.UPSTASH_REDIS_REST_TOKEN; if (R && T) { const j = await (await fetch(`${R}/get/${SPEND_KEY}`, { headers: { Authorization: `Bearer ${T}` }, signal: AbortSignal.timeout(8000) })).json(); if (j.result) { SPEND = { ...SPEND, ...JSON.parse(j.result) }; return; } } } catch {}
  try { SPEND = { ...SPEND, ...JSON.parse(require("fs").readFileSync(SPEND_FILE, "utf8")) }; } catch {}
}
function spendSave() { clearTimeout(spendSaveT); spendSaveT = setTimeout(async () => { const body = JSON.stringify(SPEND); try { require("fs").writeFileSync(SPEND_FILE, body); } catch {}
  try { const R = process.env.UPSTASH_REDIS_REST_URL, T = process.env.UPSTASH_REDIS_REST_TOKEN; if (R && T) await fetch(`${R}/set/${SPEND_KEY}`, { method: "POST", headers: { Authorization: `Bearer ${T}` }, body, signal: AbortSignal.timeout(8000) }); } catch {} }, 1500); }
const spentToday = () => SPEND.days[etDayIso()] || 0;
function etDayIso() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
function budgetView() { return { budget: BUDGET_USD, spent: +SPEND.total.toFixed(4), left: +Math.max(0, BUDGET_USD - SPEND.total).toFixed(4), today: +spentToday().toFixed(4), dailyCap: DAILY_USD, calls: SPEND.calls, since: SPEND.since }; }
spendLoad();
const usage = { day: "", count: 0 };
const etDay = () => new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
function claudeUsed() { if (usage.day !== etDay()) { usage.day = etDay(); usage.count = 0; } return usage.count; }
function spendOne() {
  if (DAILY_LIMIT && BUDGET_USD - SPEND.total < 0.02) { const e = new Error(`Your $${BUDGET_USD.toFixed(2)} Claude budget is used up ($${SPEND.total.toFixed(2)} spent). Raise CLAUDE_BUDGET_USD in Render to keep going.`); e.code = "daily_limit"; throw e; }
  if (DAILY_LIMIT && spentToday() >= DAILY_USD) { const e = new Error(`Today's Claude spending cap of $${DAILY_USD.toFixed(2)} is reached ($${(BUDGET_USD - SPEND.total).toFixed(2)} of your budget left). It resets at midnight Eastern.`); e.code = "daily_limit"; throw e; }
  if (claudeUsed() >= DAILY_LIMIT) {
    const e = new Error(DAILY_LIMIT ? `Daily Claude limit reached (${DAILY_LIMIT} requests). It resets at midnight Eastern, or raise CLAUDE_DAILY_LIMIT in Render.` : "Claude is turned off so the site costs $0. To turn it on, set CLAUDE_DAILY_LIMIT (for example 20) in Render's Environment settings.");
    e.code = "daily_limit"; throw e;
  }
  usage.count++;
}
const perIp = new Map();
const IP_HOURLY = Math.max(1, parseInt(process.env.CLAUDE_HOURLY_LIMIT || "40", 10) || 40);
function ipAllowed(req) {
  const ip = DM.clientIp(req.headers, req.socket.remoteAddress);
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
  SPEND.total += cost; SPEND.calls++; const dk = etDayIso(); SPEND.days[dk] = (SPEND.days[dk] || 0) + cost;
  for (const k of Object.keys(SPEND.days)) if (k < new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)) delete SPEND.days[k]; spendSave();
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
      const spiderCtx = SPIDER ? SPIDER.promptContext([sym]) : "";
      prompt = `Today is ${today}. Give your outlook for ${q.name} (${sym}).${spiderCtx ? `\n\nSPIDER RESEARCH (stored findings from THE WEB; labels show fact vs interpretation)\n${spiderCtx}` : ""}\n\nQUOTE\nPrice ${q.price} ${q.currency}, ${q.changePct?.toFixed(2)}% today, prev close ${q.prevClose}, day ${q.dayLow}-${q.dayHigh}, 52w ${q.low52}-${q.high52}, volume ${q.volume}\n\nTREND\n${h ? summarizeHistory(h) : "n/a"}\n\nLATEST ${sym} HEADLINES\n${heads || "(none found)"}\n\n${SHAPE}`;
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
// Same prompt as ask(), answered by free Gemini in plain text
async function askGemini(body) { return ask(null, body, true); }
async function ask(apiKey, body, viaGemini = false) {
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
  const prompt = `Today is ${today}.\n\n${ctx ? "WHAT I'M LOOKING AT ON MY DASHBOARD RIGHT NOW\n" + ctx + "\n\n" : ""}MARKET\n${idx.map(qline).join("\n")}\n\nWATCHED / HELD STOCKS\n${syms.map(qline).join("\n")}\n\nMY PORTFOLIO\n${port}\n\n${SPIDER ? (() => { const c = SPIDER.promptContext(syms); return c ? "SPIDER RESEARCH (THE WEB)\n" + c + "\n\n" : ""; })() : ""}LATEST HEADLINES\n${news.items.slice(0, 40).map((i) => `- [${SOURCES[i.source].name}] ${i.title}`).join("\n")}\n\nMY QUESTION\n${question}`;
  if (viaGemini) {
    const answer = await gemini({ system: "You are a sharp, balanced investing assistant inside one person's personal stock dashboard. Use the data provided plus general market knowledge, cite specific numbers and headlines, and be honest about uncertainty. This is an opinion, not financial advice. Write a short plain-text reply (no markdown headings, '- ' bullets are fine, under 220 words).", text: prompt, maxTokens: 900 });
    return { answer, action: null, actions: [], model: `Gemini (${GEM_STATE.model}, free tier)`, generated: Date.now() };
  }
  return { ...(await askWithActions(apiKey, prompt)), model: MODEL, generated: Date.now() };
}

function readBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > max) { reject(new Error("too large")); req.destroy(); } });
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
    const res = await YGATE.run(async () => { const r = await fetch(u, { headers: { "User-Agent": UA, Cookie: a.cookie, Accept: "application/json" }, signal: AbortSignal.timeout(12000) }); if (r.status === 429) { const e = new Error("HTTP 429 from Yahoo"); e.status = 429; throw e; } return r; });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) { last = new Error("Yahoo refused the request"); continue; }
    if (!res.ok) { const e = new Error((body.quoteSummary && body.quoteSummary.error && body.quoteSummary.error.description) || `Yahoo error ${res.status}`); e.status = res.status; throw e; }
    return body;
  }
  throw last;
}
yget = HEALTH.track(yget, (url) => url);
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

function yahooSearch(q) {
  return cached("s:" + q.toLowerCase(), 10 * 60_000, async () => {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0&enableFuzzyQuery=true`;
    const j = JSON.parse(await get(url, "application/json"));
    return MDC.searchRows(j.quotes);
  });
}

const listingResult = (entry, recent = false) => ({
  symbol: entry.providerSymbol, name: entry.name, type: entry.isEtf ? "ETF" : "EQUITY",
  typeDisp: recent ? "Newly detected listing" : entry.isEtf ? "ETF" : "Listed security",
  exchange: entry.exchange,
});

const normEntry = (entry) => (entry.assetClass ? entry : { ...INST.normalize({ symbol: entry.symbol, quoteType: entry.type, name: entry.name, exchDisp: entry.exchange }), ...entry });
async function search(q) {
  const refreshing = listingCatalog.refresh();
  if (/^new\s+listings?$/i.test(q)) {
    if (!listingCatalog.ready()) await Promise.race([refreshing, new Promise((resolve) => setTimeout(resolve, 1500))]);
    return listingCatalog.recent().map((entry) => normEntry(listingResult(entry, true)));
  }
  const normalized = q.toUpperCase().replace(".", "-");
  const exact = () => listingCatalog.search(q).filter((entry) => entry.providerSymbol === normalized).map((entry) => listingResult(entry));
  const known = exact();
  if (known.length) return known.map(normEntry);
  let yahoo = [];
  try { yahoo = await yahooSearch(q); } catch {}
  if (!yahoo.length && !listingCatalog.ready()) await Promise.race([refreshing, new Promise((resolve) => setTimeout(resolve, 1200))]);
  const results = [...exact(), ...yahoo, ...listingCatalog.search(q).map((entry) => listingResult(entry))];
  const unique = new Map();
  for (const entry of results) if (!unique.has(entry.symbol)) unique.set(entry.symbol, normEntry(entry));
  return [...unique.values()].slice(0, 12);
}

// ---------------------------------------------------------------- one instrument, any asset class (/api/instrument)
// The normalised instrument + live quote + market status + the details that matter for its class: market cap and P/E
// for stocks, contract specs for futures, 24h volume for crypto, strike/expiry/IV for options, the reference rate for FX.
// Every value comes from a keyless source and says which one; a missing value is shown as unavailable, never guessed.
async function instrumentMeta(sym) {
  return cached("im:" + sym, MDC.TTL.instrument, async () => {
    let hit = null; try { hit = (await yahooSearch(sym)).find((r) => r.symbol === sym) || null; } catch {}
    return hit ? { symbol: sym, quoteType: hit.type, name: hit.name, exchDisp: hit.exchange } : { symbol: sym };
  });
}
async function coinbaseProductMap() {
  return cached("cb:products", MDC.TTL.coinbaseProducts, async () => MDC.coinbaseProducts(JSON.parse(await get("https://api.exchange.coinbase.com/products", "application/json"))));
}
async function optionChain(sym, date) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? Math.floor(Date.parse(date + "T00:00:00Z") / 1000) : null;
  return cached(`opt:${sym}:${d || ""}`, MDC.TTL.options, async () => MDC.optionChain(await yget(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(sym)}${d ? `?date=${d}` : ""}`)));
}
async function instrumentView(sym) {
  const meta = await instrumentMeta(sym);
  let q = null, qErr = null; try { q = await quote(sym); } catch (e) { qErr = String(e.message || e); }
  const inst = INST.normalize({ ...meta, quoteType: meta.quoteType || (q && q.instrumentType), name: meta.name || (q && q.name), exchDisp: meta.exchDisp || (q && q.exchange), currency: q && q.currency, price: q && q.price });
  const details = {}, sources = [q ? q.provider || "yahoo" : null].filter(Boolean);
  const take = async (label, fn) => { try { await fn(); } catch (e) { details[label + "Error"] = "unavailable"; } };
  if (inst.assetClass === "equity" || inst.assetClass === "etf") await take("stats", async () => {
    const r = await cached("istats:" + sym, 3600_000, () => yget(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=summaryDetail,defaultKeyStatistics,price`));
    const x = unwrap(r.quoteSummary.result[0]), sd = x.summaryDetail || {}, ks = x.defaultKeyStatistics || {};
    Object.assign(details, { marketCap: sd.marketCap ?? (x.price && x.price.marketCap) ?? null, trailingPE: sd.trailingPE ?? null, forwardPE: sd.forwardPE ?? ks.forwardPE ?? null,
      dividendYield: sd.dividendYield ?? sd.yield ?? null, beta: sd.beta ?? ks.beta ?? null, avgVolume: sd.averageVolume ?? null, high52: sd.fiftyTwoWeekHigh ?? null, low52: sd.fiftyTwoWeekLow ?? null });
  });
  if (inst.assetClass === "crypto") await take("crypto", async () => {
    const products = await coinbaseProductMap().catch(() => ({})), p = products[sym];
    if (p && p.quoteIncrement) { inst.quoteIncrement = p.quoteIncrement; inst.tickSize = p.quoteIncrement; }
    if (!p) { details.coinbase = "not listed on Coinbase"; return; }
    const st = JSON.parse(await cached("cbstats:" + sym, MDC.TTL.cryptoQuote, () => get(`https://api.exchange.coinbase.com/products/${encodeURIComponent(sym)}/stats`, "application/json")));
    Object.assign(details, { volume24h: +st.volume || null, volume24hQuote: +st.volume && +st.last ? +st.volume * +st.last : null, high24h: +st.high || null, low24h: +st.low || null, open24h: +st.open || null, volume30d: +st.volume_30day || null });
    sources.push("coinbase");
  });
  if (inst.assetClass === "future") await take("contract", async () => {
    details.spec = inst.spec || null;
    const r = await cached("ifut:" + sym, 3600_000, () => yget(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=summaryDetail,price`));
    const x = unwrap(r.quoteSummary.result[0]), sd = x.summaryDetail || {}, pr = x.price || {};
    const exp = sd.expireDate ?? pr.expireDate; details.expiry = exp ? new Date((typeof exp === "number" ? exp : Date.parse(exp) / 1000) * 1000).toISOString().slice(0, 10) : null;
    details.openInterest = sd.openInterest ?? null; details.underlying = pr.underlyingSymbol || null;
  });
  if (inst.assetClass === "option" && inst.option) await take("contract", async () => {
    const chain = await optionChain(inst.option.underlying, inst.option.expiry), list = inst.option.right === "call" ? chain.calls : chain.puts;
    const c = list.find((x) => x.contract === sym) || null;
    Object.assign(details, { underlying: inst.option.underlying, underlyingPrice: chain.underlyingPrice, strike: inst.option.strike, expiry: inst.option.expiry, right: inst.option.right, multiplier: 100,
      ...(c ? { bid: c.bid, ask: c.ask, last: c.last, iv: c.iv, openInterest: c.openInterest, volume: c.volume } : { contract: "not in the provider's chain" }) });
  });
  if (inst.assetClass === "forex") await take("reference", async () => {
    const pair = INST.forexPair(sym); details.base = pair[0]; details.quoteCurrency = pair[1];
    const ref = MDC.frankfurterQuote(sym, JSON.parse(await cached(`fx:${pair.join("")}`, MDC.TTL.fx, () => get(MDC.frankfurterUrl(pair[0], pair[1]), "application/json"))));
    details.referenceRate = ref.price; details.referenceNote = ref.note; sources.push("frankfurter");
  });
  if (MDC.FRED_FOR[sym]) await take("fred", async () => {
    const f = MDC.fredLatest(await cached(`fred:${MDC.FRED_FOR[sym]}`, MDC.TTL.fred, () => get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${MDC.FRED_FOR[sym]}`, "text/csv")));
    details.fredClose = f.value; details.fredDate = f.date; details.fredSeries = MDC.FRED_FOR[sym]; sources.push("fred");
  });
  if (q && q.price != null) inst.tickSize = inst.assetClass === "crypto" && inst.quoteIncrement ? inst.quoteIncrement : INST.tickSizeOf(inst, q.price);
  return { instrument: inst, quote: q, quoteError: qErr, status: INST.marketStatus(inst, Date.now(), q && q.periods), delayMin: (q && q.delayMin) || 0,
    stream: INST.providerFor(inst).stream, details, sources: [...new Set(sources)] };
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
fh = HEALTH.track(fh, () => "https://finnhub.io/");
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
const live = { ws: null, open: false, subs: new Set(), last: new Map(), dirty: new Set(), clients: new Set(), retry: 1000, providerTradeAt: null };
const streamable = (s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s); // stocks, ETFs and COIN-USD (no ^indexes or futures)
const toFeed = (s) => (isCrypto(s) ? `BINANCE:${base(s)}USDT` : s);
const fromFeed = (f) => { const m = f.match(/^BINANCE:(\w+)USDT$/); return m ? m[1] + "-USD" : f; };

function wanted() {
  const want = new Set();
  for (const c of live.clients) {
    if (c.focus) want.add(c.focus);
    if (want.size >= 30) return want;
  }
  for (const c of live.clients) for (const s of c.syms) { if (want.size >= 30) break; want.add(s); }
  return want;
}
function syncSubs() {
  cbSync(); // crypto streams from Coinbase's free public feed, with or without a Finnhub key
  if (!live.open) return;
  const want = new Set([...wanted()].filter((s) => !(cb.products ? cb.products[s] : isCrypto(s))));
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
      if (typeof t?.s !== "string" || !Number.isFinite(t.p) || t.p <= 0 || !Number.isFinite(t.t) || t.t <= 0 || !(t.v > 0)) continue;
      const sym = fromFeed(t.s);
      live.providerTradeAt = Math.max(live.providerTradeAt || 0, t.t);
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
// ---- Coinbase Exchange public WebSocket (no key, no account): real-time crypto 24/7. Coinbase product ids are the same
// as Yahoo's crypto symbols (BTC-USD), so ticks land in the same live-price map the pages already read. It connects only
// while a page is streaming a crypto symbol Coinbase lists, and reconnects with a growing pause if dropped.
const cb = { ws: null, open: false, subs: new Set(), retry: 1000, products: null, loading: null };
function cbWanted() {
  const want = new Set();
  if (!cb.products) return want;
  for (const c of live.clients) { if (c.focus && cb.products[c.focus]) want.add(c.focus); for (const x of c.syms) if (cb.products[x] && want.size < 50) want.add(x); }
  return want;
}
function cbSync() {
  if (typeof WebSocket === "undefined") return;
  const anyCrypto = [...live.clients].some((c) => [...c.syms].some(isCrypto));
  if (anyCrypto && !cb.products && !cb.loading) cb.loading = coinbaseProductMap().then((p) => { cb.products = p; }).catch(() => {}).finally(() => { cb.loading = null; cbSync(); });
  const want = cbWanted();
  if (want.size && !cb.ws) return connectCoinbase();
  if (!cb.open) return;
  const add = [...want].filter((x) => !cb.subs.has(x)), drop = [...cb.subs].filter((x) => !want.has(x));
  if (drop.length) { cb.ws.send(JSON.stringify({ type: "unsubscribe", product_ids: drop, channels: ["ticker"] })); drop.forEach((x) => cb.subs.delete(x)); }
  if (add.length) { cb.ws.send(JSON.stringify({ type: "subscribe", product_ids: add, channels: ["ticker"] })); add.forEach((x) => cb.subs.add(x)); }
}
function connectCoinbase() {
  if (typeof WebSocket === "undefined" || cb.ws) return;
  const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
  cb.ws = ws;
  ws.onopen = () => { cb.open = true; cb.retry = 1000; cb.subs.clear(); cbSync(); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const t = MDC.coinbaseTick(m); if (!t) return;
    const prev = live.last.get(t.sym);
    if (!prev || t.t >= prev.t) { live.last.set(t.sym, { p: t.p, t: t.t }); live.dirty.add(t.sym); }
  };
  ws.onclose = () => {
    cb.open = false; cb.ws = null; cb.subs.clear();
    if (cbWanted().size) setTimeout(() => cbSync(), cb.retry);
    cb.retry = Math.min(cb.retry * 2, 60_000);
  };
  ws.onerror = () => {};
}
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

// Live price streams stay open, so cap them: a few per visitor and a fixed total, owner exempt from the per-visitor cap.
const STREAM_PER_IP = 4, STREAM_MAX = 200;
const streamIps = new Map();
function streamSlot(req, owner) {
  if (live.clients.size >= STREAM_MAX) return null;
  const ip = DM.clientIp(req.headers, req.socket.remoteAddress), n = streamIps.get(ip) || 0;
  if (!owner && n >= STREAM_PER_IP) return null;
  streamIps.set(ip, n + 1);
  return () => { const m = (streamIps.get(ip) || 1) - 1; if (m > 0) streamIps.set(ip, m); else streamIps.delete(ip); };
}
function openStream(res, syms, focus, release) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const client = { res, syms: new Set(syms.filter(streamable)) };
  if (client.syms.has(focus)) client.focus = focus;
  live.clients.add(client);
  const snap = {};
  for (const s of client.syms) if (live.last.has(s)) snap[s] = live.last.get(s);
  res.write(`event: hello\ndata: ${JSON.stringify({ streaming: live.open || cb.open, crypto: cb.open })}\n\n`);
  if (Object.keys(snap).length) res.write(`data: ${JSON.stringify(snap)}\n\n`);
  syncSubs();
  res.once("close", () => { live.clients.delete(client); syncSubs(); if (release) release(); });
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
// One-time reset of all three paper bots: when BOT_RESET_ID changes, each account restarts at its starting value on
// the next server start (the old run is kept in its test-run history) and browser backups from before can't restore it.
const BOT_RESET_ID = "2026-11-17-paper-execution-30k";
// ---- Strategy registry + experiment archive (risk-core.js) ----
// Every run belongs to one strategy version. When the version in this file changes, the bot's current run is archived
// with its full records (never edited afterwards) and a new $30,000 run starts under the new version. Busts are archived
// the same way. Archives live in Upstash lists (pft:archive:v1:<bot>) when configured, plus a local file.
const RISK = require("./risk-core.js");
const TEAM = require("./bot-teamwork-core.js");
const THESIS = require("./thesis-core.js");
const STRATS = {
  swing: { id: "sarah-swing", version: 4, trader: "Swing Trader", since: "2026-11-17",
    hypothesis: "Multi-day momentum + catalysts (earnings beats, news, analyst ratings, 10-K health) in S&P names above their 50/200-day averages earn more than the S&P after costs over 2–30 trading days.",
    changes: ["Market-crash headlines must be about the whole market (single-stock 'X stock tumbles 21%' no longer triggers defense mode)", "Rank-based sells and swaps only at the opening re-score and only after ≥2 days held", "Trade only on fresh post-decision prices, with 7.5 bps of modeled costs", "Zweig put/call exposure tilt", "v3: financial-ratio indicator (Fin 370 units 6–9: profitability/DuPont, leverage, efficiency/CCC, valuation) vs peers and prior year, weight 0.08 — a fixed prior, not yet fitted", "v4: thesis tracker — each buy records its reasons (momentum, news, analysts, 10-K grade, ratios, spider research); sells when at least 2 and at least half of them are clearly gone (after the 2-day minimum hold, at the opening re-score)", "v4: volatility sizing — within each sleeve a slot is sized by the sleeve's median volatility ÷ the stock's volatility (2/3× to 1.5× an equal slot); trims and defense cuts use each holding's own size"],
    params: { ratioWeight: 0.08, sizeMin: 2 / 3, sizeMax: 1.5, slots: 10, riskSlots: 8, slipPerSide: 0.00075, stops: { risk: [0.15, 0.2], safe: [0.08, 0.1] }, rankHoldDays: 2, staleMin: 3 } },
  day: { id: "alex-intraday", version: 5, trader: "Day Trader", since: "2026-11-19",
    hypothesis: "Confirmed ETF reversals and strong forecasts with aligned intraday momentum can earn more than modeled costs.",
    changes: ["Keep confirmed ETF reversals toward session VWAP", "Add momentum entries when a cost-qualified forecast agrees with the last one and five minutes", "Require target room of at least twice modeled round-trip costs and recheck at the exact later opening print", "Use fixed stop and target brackets, a ten-minute max hold, and the capped Day paper allocation under desk loss controls"],
    params: { costPerSide: 0.0005, borrow: 0.0001, bufferX: 0.5, riskPct: 0.0025, grossCap: 1, netCap: 1, dailyLoss: 0.01, maxBarLagSec: 90, holdMinutes: 10 } },
  quant: { id: "daniel-macro-quant", version: 3, trader: "Quant Trader", since: "2026-11-17",
    hypothesis: "A regime-aware, risk-parity allocation across liquid ETFs and mega-caps (12-1 momentum, 3-month momentum, low volatility, 200-day trend filter, 15% vol target) beats the S&P on a risk-adjusted basis after 5 bps costs.",
    changes: ["Zweig put/call nudges the equity sleeve ±10% at sentiment extremes", "v3: quality + value factor from the Fin 370 ratio units (profitability/DuPont, leverage, efficiency, valuation vs peers and prior year) added to the stock ranking at 0.25 weight; ETFs get 0"],
    params: { fundWeight: 0.25, cost: 0.0005, minTrade: 0.015, maxW: 0.2, top: 8, volTarget: 0.15 } },
};
const ARCH_KEY = (bot) => `pft:archive:v1:${bot}`, ARCH_FILE = (bot) => path.join(require("os").tmpdir(), `archive-v1-${bot}.jsonl`);
async function upCmd(cmd) {
  if (!(UP_URL && UP_TOKEN)) return null;
  const r = await fetch(UP_URL, { method: "POST", headers: { Authorization: `Bearer ${UP_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(8000) });
  return (await r.json()).result;
}
async function archivePush(bot, rec) {
  const body = JSON.stringify({ ...rec, archivedAt: Date.now() });
  try { fs.appendFileSync(ARCH_FILE(bot), body + "\n"); } catch {}
  try { await upCmd(["LPUSH", ARCH_KEY(bot), body]); } catch {}
}
async function archiveList(bot, n = 30, full = false) {
  let rows = null;
  try { const r = await upCmd(["LRANGE", ARCH_KEY(bot), 0, n - 1]); if (Array.isArray(r)) rows = r; } catch {}
  if (!rows) { try { rows = fs.readFileSync(ARCH_FILE(bot), "utf8").trim().split("\n").filter(Boolean).reverse().slice(0, n); } catch { rows = []; } }
  return rows.map((x) => { try { const o = JSON.parse(x); if (!full) { delete o.tradeLog; delete o.equity; delete o.daily; delete o.decisions; } return o; } catch { return null; } }).filter(Boolean);
}
const PAPER = require("./paper-execution-core.js");
const AP_START = 30_000, AP_BUST = process.env.AP_TEST_BUST ? 29_990 : 3_000, AP_SLOTS = 10, AP_COST = 0.00075, AP_HOLD_MIN = 60 * 60e3;
const AP_FALLBACK = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","AVGO","TSLA","BRK-B","JPM","LLY","V","UNH","XOM","MA","COST","HD","PG","JNJ","WMT","NFLX","ABBV","BAC","CRM","ORCL","AMD","KO","MRK","CVX","PEP","ADBE","TMO","LIN","MCD","CSCO","ACN","ABT","WFC","GE","QCOM","INTU","CAT","TXN","DIS","IBM"];
const apFresh = () => ({ v: 2, resetId: BOT_RESET_ID, run: 1, runs: [], start: Date.now(), cash: AP_START, positions: {}, trades: [], equity: [], intraday: [], lastRebalance: "", updated: Date.now() });
let AP = apFresh(), apBusy = false, apLoaded = false, apLastScore = 0, apLastPlan = 0, apSig = null;
const apBase = new Map(); // per-symbol daily inputs (moving averages, 3-month-ago price, name matcher)
const etParts = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, wd: p.weekday, min: (+p.hour % 24) * 60 + +p.minute };
};
const apDayFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const apClosedCloses = (candles, day) => PAPER.completedCloses(candles, day, (seconds) => apDayFormat.format(seconds * 1000));
function apFix() {
  if (!AP || AP.v !== 2) AP = apFresh();
  AP.run = AP.run || 1; AP.runs = AP.runs || []; AP.intraday = AP.intraday || []; AP.equity = AP.equity || []; AP.trades = AP.trades || []; AP.recent = AP.recent || {};
}
// The one-time reset (see BOT_RESET_ID). Returns true if it reset, so the caller saves.
async function apResetCheck() {
  if (AP.resetId === BOT_RESET_ID) return false;
  const runs = AP.runs || [], busy = AP.firstTrade || AP.trades.length;
  if (busy) {
    const last = AP.equity.at(-1);
    const v = last?.v ?? (AP.cash + Object.values(AP.positions).reduce((sum, p) => sum + p.shares * p.cost, 0));
    const start = AP.resetId === "2026-11-16-all-30k" ? AP_START : 10_000;
    const vals = [start, ...AP.equity.map((p) => p.v), v];
    const rec = { run: AP.run, start: AP.firstTrade || AP.start, end: Date.now(), startValue: start, endValue: +v.toFixed(2), peak: +Math.max(...vals).toFixed(2), low: +Math.min(...vals).toFixed(2),
      trades: AP.trades.length, days: AP.equity.length, spxRet: AP.spx0 && last?.spx ? +((last.spx / AP.spx0 - 1) * 100).toFixed(2) : null, strategy: AP.strategy, busted: false, reason: "Paper execution audit — restarted at $30,000",
      marked: last ? "last recorded value" : "cost basis (no recorded value)" };
    await archivePush("swing", { ...rec, tradeLog: AP.trades, equity: AP.equity });
    runs.unshift(rec);
  }
  AP = { ...apFresh(), run: busy ? AP.run + 1 : AP.run, runs };
  return true;
}
let apLoading = null;
function apLoad() {
  if (!apLoading) apLoading = apRead().catch((error) => { apLoading = null; throw error; });
  return apLoading;
}
async function apRead() {
  let raw;
  if (UP_URL && UP_TOKEN) {
    const r = await fetch(`${UP_URL}/get/${AP_KEY}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!r.ok || !Object.hasOwn(j, "result")) throw new Error("Swing state could not be loaded");
    if (j.result != null) raw = JSON.parse(j.result);
  }
  if (!raw) {
    try { raw = JSON.parse(fs.readFileSync(AP_FILE, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (raw) AP = raw;
  apFix();
  const reset = await apResetCheck(), changed = await apVersionCheck();
  if (reset || changed) await apCommitFills(AP);
  apLoaded = true;
}
// Strategy registry: a new swing-strategy version archives the current run (full trades + equity) and starts a new one.
async function apVersionCheck() {
  if (!RISK.versionChanged(AP.strategy, STRATS.swing)) return false;
  const busy = AP.firstTrade || AP.trades.length;
  if (busy) {
    const last = AP.equity[AP.equity.length - 1], v = last && last.v > 0 ? last.v : AP.cash + Object.entries(AP.positions || {}).reduce((a, [k, p]) => a + p.shares * (apPx[k] || p.cost || 0), 0);
    const rec = { ...apSummary(v, false, last && last.spx), endValue: +v.toFixed(2), strategy: AP.strategy || { id: "sarah-swing", version: 1, note: "before the strategy registry" }, reason: `Strategy change → v${STRATS.swing.version}`, marked: "positions valued at last known prices" };
    await archivePush("swing", { ...rec, tradeLog: AP.trades, equity: AP.equity });
    AP = { ...apFresh(), run: AP.run + 1, runs: [rec, ...(AP.runs || [])] };
  }
  AP.strategy = { id: STRATS.swing.id, version: STRATS.swing.version, since: Date.now() };
  return true;
}
async function apSave() {
  AP.updated = Date.now();
  const body = JSON.stringify(AP);
  try { fs.writeFileSync(AP_FILE, body); } catch {}
  if (UP_URL && UP_TOKEN) { try { await fetch(`${UP_URL}/set/${AP_KEY}`, { method: "POST", headers: { Authorization: `Bearer ${UP_TOKEN}` }, body, signal: AbortSignal.timeout(8000) }); } catch {} }
}
async function apCommitFills(next) {
  next.updated = Date.now();
  const body = JSON.stringify(next);
  if (UP_URL && UP_TOKEN) {
    const res = await fetch(`${UP_URL}/set/${AP_KEY}`, { method: "POST", headers: { Authorization: `Bearer ${UP_TOKEN}` }, body, signal: AbortSignal.timeout(8000) });
    if (!res.ok || (await res.json()).result !== "OK") throw new Error("Swing fill snapshot could not be saved");
  }
  try { fs.writeFileSync(AP_FILE + ".tmp", body); fs.renameSync(AP_FILE + ".tmp", AP_FILE); }
  catch (err) { if (!UP_URL || !UP_TOKEN) throw err; }
  AP = next;
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
// ---------------------------------------------------------------- Zweig put/call ratio (contrarian sentiment for all three bots)
// Source: Cboe's free daily market statistics (EQUITY put/call ratio, end of day; today's figure is provisional until the
// close). If Cboe can't be reached, a labeled proxy: put vs call volume on the nearest expiry of ten mega-cap stocks
// (Yahoo option chains). Pure logic + the contrarian rules in putcall-core.js. Never estimated: no data → no tilt.
const PCC = require("./putcall-core.js");
const PC_FILE = path.join(require("os").tmpdir(), "putcall-v1.json"), PC_KEY = "pft:putcall:v1";
const PC_PROXY = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX"];
let PC = { cboe: {}, proxy: {}, miss: {}, at: 0, err: null, loaded: false }, pcBusy = false, pcView = null;
async function pcLoad() {
  try { if (UP_URL && UP_TOKEN) { const r = await fetch(`${UP_URL}/get/${PC_KEY}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` }, signal: AbortSignal.timeout(8000) }); const j = await r.json(); if (j.result) Object.assign(PC, JSON.parse(j.result)); } } catch {}
  if (!Object.keys(PC.cboe).length) { try { Object.assign(PC, JSON.parse(fs.readFileSync(PC_FILE, "utf8"))); } catch {} }
  PC.cboe = PC.cboe || {}; PC.proxy = PC.proxy || {}; PC.miss = PC.miss || {}; PC.loaded = true;
}
async function pcSave() {
  const body = JSON.stringify({ cboe: PC.cboe, proxy: PC.proxy, miss: PC.miss, at: PC.at });
  try { fs.writeFileSync(PC_FILE, body); } catch {}
  if (UP_URL && UP_TOKEN) { try { await fetch(`${UP_URL}/set/${PC_KEY}`, { method: "POST", headers: { Authorization: `Bearer ${UP_TOKEN}` }, body, signal: AbortSignal.timeout(8000) }); } catch {} }
}
// trading days, newest first, going back `n` weekdays (holidays simply come back empty and are skipped)
function pcDays(n) {
  const out = []; const d = new Date(etParts().day + "T12:00:00Z");
  for (let i = 0; out.length < n && i < n * 2; i++) { const wd = d.getUTCDay(), k = d.toISOString().slice(0, 10); if (wd && wd < 6 && !NYSE_HOLIDAYS.has(k)) out.push(k); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}
async function pcFetchDay(day) {
  for (const u of [`https://cdn.cboe.com/data/us/options/market_statistics/daily/${day}_daily_options`, `https://www.cboe.com/us/options/market_statistics/daily/?dt=${day}`]) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json,text/html", Referer: "https://www.cboe.com/us/options/market_statistics/daily/" }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue; const txt = await r.text();
      const v = PCC.parseCboe(txt); if (v) return v;
    } catch {}
  }
  return null;
}
async function pcProxyToday() {
  const chains = [];
  for (const s of PC_PROXY) { try { const j = await yget(`https://query2.finance.yahoo.com/v7/finance/options/${s}`); const o = j && j.optionChain && j.optionChain.result && j.optionChain.result[0] && j.optionChain.result[0].options && j.optionChain.result[0].options[0]; if (o) chains.push(o); } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return chains.length >= 6 ? PCC.chainRatio(chains, 20000) : null;
}
async function pcRefresh() {
  if (pcBusy) return; pcBusy = true;
  try {
    if (!PC.loaded) await pcLoad();
    const t = etParts(), today = t.day; let got = 0, tries = 0;
    // past days newest-first, today last (and only after 10 AM ET) so a pre-open page that still shows yesterday is caught as a duplicate
    const days = [...pcDays(260).filter((d) => d !== today), ...(t.min >= 10 * 60 ? [today] : [])].filter((d) => d <= today);
    for (const d of days) {
      const isToday = d === today, have = PC.cboe[d];
      if (have && !have.prov) continue;
      if (!isToday && !have && PC.miss[d] && Date.now() - PC.miss[d] < 7 * 864e5) continue; // holiday / not published: retry weekly
      if (tries >= 40 && !isToday) continue; tries++;
      const v = await pcFetchDay(d);
      // a page identical to another stored day is Cboe falling back to its latest data (holiday / not yet published)
      const dup = v && Object.entries(PC.cboe).some(([k, x]) => k !== d && x.equity === v.equity && x.total === v.total && x.index === v.index);
      if (v && !dup) { PC.cboe[d] = { ...v, prov: isToday && t.min < 16 * 60 + 30 ? 1 : 0, at: Date.now() }; delete PC.miss[d]; got++; }
      else if (!isToday) PC.miss[d] = Date.now();
      if (tries === 3 && !got && !Object.keys(PC.cboe).length) break; // Cboe unreachable — don't hammer it
      await new Promise((r) => setTimeout(r, 400));
    }
    // fallback proxy, one reading per trading day (kept so the proxy builds its own history)
    const wk = !(t.wd === "Sat" || t.wd === "Sun") && !NYSE_HOLIDAYS.has(today);
    if (wk && t.min >= 10 * 60 && (!PC.proxy[today] || PC.proxy[today].prov) && Object.keys(PC.cboe).filter((d) => !PC.cboe[d].prov).length < 10) {
      const r = await pcProxyToday(); if (r) PC.proxy[today] = { v: +r.ratio.toFixed(3), calls: r.calls, puts: r.puts, prov: t.min < 16 * 60 ? 1 : 0, at: Date.now() };
    }
    for (const k of Object.keys(PC.miss)) if (Date.now() - PC.miss[k] > 30 * 864e5) delete PC.miss[k];
    PC.at = Date.now(); PC.err = Object.keys(PC.cboe).length ? null : "Cboe daily statistics unreachable from the server";
    pcView = null; await pcSave();
  } catch (e) { PC.err = e.message; } finally { pcBusy = false; }
}
// The current Zweig reading (cached until the next refresh). Prefers Cboe; the proxy only when Cboe has < 10 days.
function pcState() {
  if (pcView) return pcView;
  const cb = Object.keys(PC.cboe).sort().map((d) => ({ d, v: PC.cboe[d].equity }));
  const px = Object.keys(PC.proxy).sort().map((d) => ({ d, v: PC.proxy[d].v }));
  let z = PCC.zweig(cb), source = "Cboe equity put/call ratio (daily market statistics)";
  if (!z.ok && px.length >= 10) { z = PCC.zweig(px, { bands: { fearHi: 1.0, fear: 0.8, greed: 0.5, greedLo: 0.4 } }); source = "Proxy: put ÷ call volume, nearest expiry, 10 mega-cap stocks (Yahoo option chains)"; }
  const lastD = cb.length ? cb[cb.length - 1].d : null, lastC = lastD ? PC.cboe[lastD] : null;
  pcView = { ...z, source, total: lastC ? lastC.total : null, index: lastC ? lastC.index : null, provisional: !!(lastC && lastC.prov), updated: PC.at || null, error: PC.err,
    rule: "Contrarian (Martin Zweig): more puts than usual = the crowd expects a fall = bullish; more calls than usual = the crowd expects a rise = bearish. 10-day average, judged against its own history; a turn back from an extreme is the signal." };
  return pcView;
}
const pcBrief = () => { const z = pcState(); return z.ok ? { ok: true, score: z.score, ma10: z.ma10, zone: z.zone, signal: z.signal, note: z.note, d: z.d } : { ok: false, why: z.why || z.error }; };
if (DEPLOY.runJobs) setTimeout(() => { pcRefresh(); setInterval(pcRefresh, 30 * 60e3); }, process.env.AP_TEST ? 5000 : 45_000);
// What each bot last did and why — shown on the page so "why no trades?" has an answer
const BOTDIAG = { market: {}, my: { errors: [] }, swing: { errors: [] }, quant: {}, day: { errors: [], scans: 0, signals: 0, barsOk: 0, barsFail: 0 } };
const diagErr = (k, e) => { const l = BOTDIAG[k].errors; l.unshift({ t: Date.now(), e: String((e && e.message) || e).slice(0, 160) }); l.length = Math.min(l.length, 5); };
// latest price and model score per symbol (for "value after trade" and the signal score shown in the trade log)
const apPx = {}, apScoreOf = {};
const apRule = (side, why) => side === "BUY" ? "Ranking signal" : /^Coach:/.test(why) ? "Coach rule" : /^Thesis broken/.test(why) ? "Thesis rule" : /^Failed the 10-K health/.test(why) ? "Health rule" : /^Stop-loss|^Trailing/.test(why) ? "Stop rule" : /earnings/i.test(why) ? "Earnings rule" : /^Bad news/.test(why) ? "News rule" : /average/.test(why) ? "Trend rule" : /^Fell to/.test(why) ? "Ranking rule" : /^Trimmed|^Defense/.test(why) ? "Risk limit" : /^Swapped/.test(why) ? "Swap rule" : /busted/i.test(why) ? "Bust reset" : "Rule";
function apTrade(st, side, sym, shares, price, why, name, sleeve, execution, extra) {
  const px = PAPER.paperFill(side, price, AP_COST);
  const position = st.positions[sym];
  shares = Math.min(shares, side === "BUY" ? Math.max(0, st.cash - 5) / px : position?.shares || 0);
  if (!(shares > 0) || !Number.isFinite(px) || px <= 0) return;
  const amt = shares * px;
  if (st.intents) st.intents.push({ side, sym, shares, referencePrice: price, why, name, sleeve, ...(extra ? { extra } : {}) });
  const p = st.positions[sym]; let pnl = null, pnlPct = null;
  if (side === "BUY") {
    st.cash -= amt;
    if (p) { p.cost = (p.cost * p.shares + amt) / (p.shares + shares); p.shares += shares; p.peak = Math.max(p.peak, px); }
    else st.positions[sym] = { shares, cost: px, at: Date.now(), peak: px, name: name || sym, sleeve: sleeve || "risk", ...(extra && extra.thesis ? { thesis: extra.thesis } : {}), ...(extra && extra.size ? { size: extra.size } : {}), ...(extra && extra.owner ? { owner: true } : {}) };
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
    score: apScoreOf[sym] != null ? +apScoreOf[sym].toFixed(3) : null, after: +after.toFixed(2), cost: +(shares * price * AP_COST).toFixed(2), pnl: pnl == null ? null : +pnl.toFixed(2), pnlPct: pnlPct == null ? null : +pnlPct.toFixed(4),
    ...(execution ? { ...execution, fillReferencePrice: price, modeledCostBps: AP_COST * 1e4 } : {}) });
  st.trades = st.trades.slice(0, 1500);
}

// ---- news sentiment (headline word rules) ----
const AP_POS2 = /\b(beats?|tops?|topped|crush(es|ed)?|smash(es|ed)?) (\w+ )?(estimates|expectations|forecasts?|views?)|raises? (its |full-year |annual )?(guidance|outlook|forecast)|record (revenue|sales|profit|quarter)|upgrade[sd]?\b|\bsoar(s|ed|ing)?\b|\bsurg(e|es|ed|ing)\b|skyrocket|blowout/i;
const AP_POS1 = /\b(jumps?|jumped|rall(y|ies|ied)|gains?|climbs?|rises?|rose|higher|strong(er)?|buyback|approv(al|ed|es)|wins?|won|partnership|outperform|bullish|boost(s|ed)?|expands?|breakthrough|beats?)\b/i;
const AP_NEG2 = /\b(miss(es|ed)? (\w+ )?(estimates|expectations|forecasts?|views?)|cuts? (its |full-year )?(guidance|outlook|forecast)|lowers? (its )?(guidance|outlook|forecast)|downgrade[sd]?|plunge[sd]?|plummet(s|ed)?|tumble[sd]?|crash(es|ed)?|fraud|bankrupt\w*|chapter 11|sec (charges|probe|investigation)|recall(s|ed)?|guidance cut|profit warning)\b/i;
const AP_NEG1 = /\b(falls?|fell|drops?|dropped|slides?|slid|slump(s|ed)?|sinks?|sank|lower|weak(er|ness)?|probe|investigation|lawsuit|sues?|sued|layoffs?|warns?|warning|fined|delay(s|ed)?|halt(s|ed)?|bearish|concerns?|antitrust|misses?)\b/i;
// Market-wide black-swan headline rules live in risk-core.js (RISK.isMarketSwan).
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
  for (const p of pool) if (!swan && p.dated && p.src !== "smart" && p.src !== "trending" && Date.now() - p.time < 24 * 3600e3 && RISK.isMarketSwan(p.title)) swan = p.title;
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
  const h = await history(sym, "1y"); const cl = apClosedCloses(h.candles, day);
  if (cl.length < 120) throw new Error("short history");
  const rets = cl.slice(-127).map((c, i, a) => (i ? Math.log(c / a[i - 1]) : 0)).slice(1), mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length) * Math.sqrt(252);
  const out = { day, name: h.name, vol, last: cl[cl.length - 1], m50: sma(cl, 50), m200: sma(cl, Math.min(200, cl.length)), past: cl[Math.max(0, cl.length - 64)], re: apMatcher(sym, h.name) };
  apBase.set(sym, out); if (apBase.size > 400) apBase.delete(apBase.keys().next().value);
  return out;
}
// ---- health grades for the swing bot: the crawler's scorecard (FIN.health) on each candidate's last two 10-Ks.
// A background job grades names a few seconds apart through the SEC queue; grades last a day. Until a stock has
// a grade it's simply scored without one.
const FINS = require("./public/fin.js"), RATIOS = require("./ratio-core.js");
const AP_HEALTH = new Map(); let apHealthBusy = false;
async function apHealthJob(syms) {
  if (apHealthBusy) return; apHealthBusy = true;
  try {
    for (const sym of syms) {
      const h = AP_HEALTH.get(sym); if (h && Date.now() - h.t < 24 * 3600e3) continue;
      try {
        const f = await secFundamentals(sym), Y = f.available ? f.years.slice(-2) : [], Ypp = f.available && f.years.length >= 3 ? f.years[f.years.length - 3] : null;
        if (Y.length < 2) { AP_HEALTH.set(sym, { t: Date.now(), grade: null }); continue; }
        const H = FINS.health(Y[1], Y[0]);
        AP_HEALTH.set(sym, { t: Date.now(), grade: H.grade, score: H.score, failed: H.failed, flags: H.flags.map((c) => c.label), fy: String(Y[1].end).slice(0, 4), fin: { y: Y[1], p: Y[0], pp: Ypp, shares: f.shares && f.shares.v } });
        BOTDIAG.swing.graded = [...AP_HEALTH.values()].filter((v) => v.grade).length;
      } catch { AP_HEALTH.set(sym, { t: Date.now() - 23 * 3600e3, grade: null }); } // retry in an hour
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  } finally { apHealthBusy = false; }
}
const AP_GRADE_ADJ = { A: 0.04, B: 0.02, C: 0, D: -0.06, F: -0.15 };
// ---- bots × spider teamwork (bot-teamwork-core.js)
let apPmCache = { n: -1, v: null }, apLastList = { t: 0, by: new Map(), n: 0 };
function apPostMortems() {
  const key = AP.trades.length + ":" + (AP.trades[0] ? AP.trades[0].t : 0);
  if (apPmCache.n !== key) apPmCache = { n: key, v: TEAM.postMortems(AP.trades) };
  return apPmCache.v;
}
// next report within ~a week (trading days away), from the same Finnhub calendar the bot already reads
function apEarnNext(sym, cal, today) {
  const s = sym.replace("-", "."), rows = cal.filter((e) => e.symbol === s && e.epsActual == null && e.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rows.length) return null;
  const days = TEAM.tradingDaysUntil(today, rows[0].date);
  return days == null ? null : { date: rows[0].date, hour: rows[0].hour || null, days };
}
const AP_CHECKS = []; // recent pre-buy checks that vetoed or cautioned (newest first)
function apSpiderChecks(out) {
  if (!SPIDER) return;
  const sorted = out.slice().sort((a, b) => b.score - a.score), look = sorted.filter((x, i) => i < 30 || AP.positions[x.sym]);
  let sig = { items: [] }; try { sig = SPIDER.researchSignals({ symbols: look.map((x) => x.sym) }); } catch {}
  const day = etParts().day;
  for (const [i, x] of look.entries()) {
    try {
      x.research = SPIDER.signal(x.sym);
      if (AP.positions[x.sym]) continue; // the check is for new buys
      x.check = TEAM.preBuyCheck({ sym: x.sym, signals: sig.items, trader: SPIDER.signal(x.sym, { trader: true }), researchedAt: SPIDER.researchedAt(x.sym) });
      if (x.check.wantResearch && i < 15) SPIDER.enqueue("company_snapshot", x.sym, { boost: 0.5, reason: "the swing bot is considering buying it" });
      if ((x.check.verdict === "veto" || x.check.verdict === "caution") && !AP_CHECKS.some((c) => c.sym === x.sym && c.day === day && c.verdict === x.check.verdict)) {
        AP_CHECKS.unshift({ t: Date.now(), day, sym: x.sym, rank: i + 1, verdict: x.check.verdict, note: x.check.note, evidence: x.check.evidence });
        AP_CHECKS.length = Math.min(AP_CHECKS.length, 60);
      }
    } catch {}
  }
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
    x.stale = live && !PAPER.usableQuote(qq, Date.now());
    x.mom = x.px / x.past - 1; x.trend = (x.px > x.m50 ? 0.5 : 0) + (x.px > x.m200 ? 0.5 : 0);
    const n = apNewsFor(x.sym, x.re, news.pool); x.news = n.score; x.headlines = n.top;
    x.earn = apEarnFor(x.sym, cal, t.day);
  }
  const pr = (k) => { const v = out.filter((x) => x[k] != null).map((x) => x[k]).sort((a, b) => a - b); return (x) => (x == null || !v.length ? 0.5 : v.filter((y) => y <= x).length / v.length); };
  const ra = pr("adj"), rm = pr("mom");
  // sleeves are set before scoring so the post-mortem lessons can match a candidate's pattern
  { const vs = out.map((x) => x.vol).sort((a, b) => a - b), cut0 = vs[Math.floor(vs.length * 0.4)] || 0; for (const x of out) x.sleeve = x.vol > cut0 ? "risk" : "safe"; }
  const pm = apPostMortems();
  for (const x of out) {
    const e = x.earn, eAdj = !e ? 0 : e.kind === "beat" ? Math.min(0.2, 0.08 + e.surprise) : e.kind === "miss" ? -0.35 : 0;
    const hg = AP_HEALTH.get(x.sym); x.health = hg && hg.grade ? { grade: hg.grade, flags: hg.flags, fy: hg.fy } : null;
    x.score = 0.3 * ra(x.adj) + 0.2 * rm(x.mom) + 0.2 * x.trend + 0.2 * ((x.news + 4) / 8) + 0.1 * clamp((x.day - spyDay) / 6 + 0.5, 0, 1) + eAdj + (x.health ? AP_GRADE_ADJ[x.health.grade] || 0 : 0);
    // THE WEB: research the bot doesn't already score (insider buying, earnings-release tone, sector news patterns), at most ±SPIDER_TRADER_WEIGHT
    try { const sa = SPIDER && SPIDER_W > 0 ? SPIDER.traderAdjust(x.sym, SPIDER_W) : null; x.spider = sa && sa.adj ? { adj: sa.adj, note: sa.note } : null; if (x.spider) x.score += x.spider.adj; } catch { x.spider = null; }
    // lessons from its own losing trades: patterns that keep losing (e.g. chasing big gaps) count against new picks
    const ls = TEAM.lessonPenalty(pm.lessons, TEAM.candidateTags(x)); x.lesson = ls.penalty ? ls : null; if (x.lesson) x.score += x.lesson.penalty;
    x.earnNext = apEarnNext(x.sym, cal, t.day);
  }
  // Fin 370 ratio indicator: each stock's profitability/DuPont, leverage, efficiency and valuation ratios vs the other
  // candidates and vs its own prior year (ratio-core.js). Only stocks with two 10-K years count; others get 0.
  try {
    const items = out.map((x) => { const h = AP_HEALTH.get(x.sym); return h && h.fin ? { sym: x.sym, now: RATIOS.compute(h.fin.y, h.fin.p, { price: x.px, shares: h.fin.shares }), prev: h.fin.pp ? RATIOS.compute(h.fin.p, h.fin.pp) : null } : null; }).filter(Boolean);
    const rs = RATIOS.score(items);
    for (const x of out) { const r = rs[x.sym]; x.ratios = r && r.score != null ? r : null; if (x.ratios) x.score += STRATS.swing.params.ratioWeight * x.ratios.score; }
  } catch { /* ratios are an extra input; never block scoring */ }
  out.sort((a, b) => b.score - a.score); out.forEach((x, i) => { x.rank = i + 1; apPx[x.sym] = x.px; apScoreOf[x.sym] = x.score; });
  apLastList = { t: Date.now(), by: new Map(out.map((x) => [x.sym, x])), n: out.length };
  apHealthJob(out.map((x) => x.sym)).catch(() => {}); // grade anything new in the background
  // 80% risk: the more volatile 60% of names feed the risk sleeve (8 slots), the calmest 40% the safe sleeve (2 slots)
  const vols = out.map((x) => x.vol).sort((a, b) => a - b), cut = vols[Math.floor(vols.length * 0.4)] || 0;
  let rr = 0, sr = 0; for (const x of out) { x.sleeve = x.vol > cut ? "risk" : "safe"; x.srank = x.sleeve === "risk" ? ++rr : ++sr; }
  let spx = null; try { const h = await history("^GSPC", "1y"); const cl = apClosedCloses(h.candles, t.day); const current = PAPER.usableQuote(q["^GSPC"], Date.now()) ? q["^GSPC"] : null; spx = { px: current?.price || cl[cl.length - 1], m200: sma(cl, 200), day: current?.changePct }; } catch {}
  const vix = PAPER.usableQuote(q["^VIX"], Date.now(), 0, 20 * 60_000) ? q["^VIX"] : null; // index feed is intentionally delayed and used only as a signal
  const riskOff = !!(spx && spx.m200 && spx.px < spx.m200);
  // THE WEB: spider research for the names the bot might buy or already holds — pre-buy red-flag check and the
  // research signal used by the earnings warning. Stocks the spider hasn't looked at are queued for research.
  apSpiderChecks(out);
  // defense mode: a broad selloff, or two INDEPENDENT warnings (VIX, S&P drop, black-swan headline, the spider's own
  // macro research). One warning only pauses new high-risk buys.
  let spiderStress = null; try { const ms = SPIDER ? SPIDER.marketStress() : null; spiderStress = ms && ms.on ? ms.note : null; } catch {}
  const lv = live ? out.filter((x) => !x.stale) : [], breadth = lv.length >= 20 ? lv.filter((x) => x.day <= -2).length / lv.length : null;
  const defenseIn = { vix: vix ? vix.price : null, vixChg: vix ? vix.changePct : null, spxDay: spx && spx.day != null ? spx.day : null, swan: news.swan, spider: spiderStress, breadth };
  const defense = TEAM.defenseDecision(defenseIn);
  return { list: out, riskOff, stress: defense.on ? defense.reason : null, caution: defense.caution ? defense.reason : null, defense, defenseIn, macro: news.macro, vix: vix && vix.price, spyDay, putcall: pcBrief(), lessons: pm.lessons.slice(0, 6) };
}
// Trading pace: about 2 trades a day, ~14 a week. A "swap" (sell the weakest holding, buy a better-ranked stock) is
// 2 trades. One swap is allowed per day while fewer than 2 trades have happened today; a second only if the week is
// behind pace. Never more than 4 trades in a day or 14 in 7 days from swaps, and swaps are at least 90 minutes apart.
// Safety sells (stop-loss, bad news, earnings miss, broken trend) are never held back by the pace.
function apPace(trades, t, now = Date.now()) {
  const fills = trades.filter((x) => x.side === "BUY" || x.side === "SELL");
  const today = fills.filter((x) => etParts(new Date(x.t)).day === t.day).length, week = fills.filter((x) => now - x.t < 7 * 864e5).length;
  const lastSwap = fills.find((x) => /^Swapped out/.test(x.why || ""));
  const idx = ["Mon", "Tue", "Wed", "Thu", "Fri"].indexOf(t.wd) + 1, daysLeft = idx > 0 ? 5 - idx : 0;
  let swaps = 0;
  if (today >= 4 || week >= 14 || (lastSwap && now - lastSwap.t < 90 * 60e3)) swaps = 0;
  else if (today < 2) swaps = 1;
  else if (week < 14 - 2 * daysLeft) swaps = 1; // behind for the week — catch up
  return { swaps, gap: 0.02, today, week };
}
// Turns scores into trades on `st` (the real account, or a copy when planning overnight).
function apDecide(st, sc, opening, pace = { swaps: 1, gap: 0.02 }) {
  const by = Object.fromEntries(sc.list.map((x) => [x.sym, x])), now = Date.now();
  const cool = (s) => st.recent && st.recent[s] && now - st.recent[s] < AP_HOLD_MIN;
  const val = () => st.cash + Object.entries(st.positions).reduce((s, [k, p]) => s + p.shares * (by[k] ? by[k].px : p.cost), 0);
  const fmtE = (e) => e.kind === "beat" ? `earnings beat by ${(e.surprise * 100).toFixed(0)}%` : `earnings missed by ${(-e.surprise * 100).toFixed(0)}%`;
  const slv = (s) => (st.positions[s] && st.positions[s].sleeve) || "risk";
  const held = (sl) => Object.keys(st.positions).filter((s) => slv(s) === sl);
  const SLOTS = { risk: AP_RISK_SLOTS, safe: AP_SLOTS - AP_RISK_SLOTS };
  // 1) sells
  let ce = null; // a Coach fix (loss cap, time stop, trim, chart sell)
  for (const [sym, p] of Object.entries(st.positions)) {
    const x = by[sym]; if (!x || x.stale) continue; const risk = slv(sym) === "risk";
    if (x.earn && x.earn.kind === "miss") apTrade(st, "SELL", sym, p.shares, x.px, `${opening ? "At the opening bell: " : ""}${fmtE(x.earn)} — sold before it can fall further`);
    else if (x.news <= -2.5) apTrade(st, "SELL", sym, p.shares, x.px, `Bad news: “${(x.headlines[0] || "").slice(0, 120)}”`);
    else if (x.health && x.health.grade === "F") apTrade(st, "SELL", sym, p.shares, x.px, `Failed the 10-K health scorecard (grade F${x.health.flags.length ? ": " + x.health.flags.slice(0, 2).join(", ").toLowerCase() : ""})`);
    else if (risk ? x.px < x.m50 && x.px < x.m200 : x.px < x.m200) apTrade(st, "SELL", sym, p.shares, x.px, risk ? "Fell below both its 50- and 200-day averages — momentum is gone" : "Price broke below its 200-day average — trend turned down");
    else if (p.owner) continue; // the owner asked for this one: only safety exits (above) and stops apply until they say sell
    else if (x.rank > (risk ? 25 : 35) && !cool(sym) && !x.stale && RISK.rankExitAllowed(now - (p.at || now), opening, STRATS.swing.params.rankHoldDays)) apTrade(st, "SELL", sym, p.shares, x.px, `Fell to #${x.rank} in the ranking at the opening re-score, after ${Math.floor((now - p.at) / 864e5)} days held`);
    else if ((ce = CA.swingExit(COACH_PLAN, p, { sym, price: x.px, bookValue: val(), now, done: st.coachDone || {} }))) {
      apTrade(st, "SELL", sym, p.shares * ce.sell, x.px, ce.reason);
      if (ce.once) (st.coachDone = st.coachDone || {})[ce.actionId] = true;
    }
    else if (p.thesis && !cool(sym) && RISK.rankExitAllowed(now - (p.at || now), opening, STRATS.swing.params.rankHoldDays)) {
      // the spider-off twin can't see spider research, so that pillar is left out of its check
      const th = THESIS.check(sc.spiderOff ? { ...p.thesis, pillars: p.thesis.pillars.filter((k) => k !== "spider") } : p.thesis, x);
      if (th.broken) apTrade(st, "SELL", sym, p.shares, x.px, th.reason);
    }
  }
  // 80% risk profile: fully invested normally; still cuts back when the whole market breaks down
  // Zweig put/call (contrarian): stays more invested when the crowd is loaded with puts, keeps some cash when it's loaded with calls
  const pcT = PCC.exposureTilt(sc.stress ? 0.5 : sc.riskOff ? 0.8 : 0.99, sc.putcall, { stress: !!sc.stress, riskOff: sc.riskOff });
  const exposure = pcT.exposure;
  const target = (val() * exposure) / AP_SLOTS;
  // 1b) earnings early warning: holdings that report within 5 trading days were researched by the spider; hold or trim
  const recentTrades = [...(st.trades || []), ...(st.isTwin ? [] : AP.trades.slice(0, 200))];
  for (const [sym, p] of Object.entries(st.positions)) {
    const x = by[sym]; if (!x || x.stale || !x.earnNext) continue;
    const act = TEAM.earningsAction({ held: true, days: x.earnNext.days, pnlPct: x.px / p.cost - 1, sleeve: slv(sym), research: sc.spiderOff ? null : x.research });
    const done = recentTrades.some((tr) => tr.sym === sym && /before the report/.test(tr.why || "") && now - tr.t < 8 * 864e5);
    if (act.action === "trim" && !done) apTrade(st, "SELL", sym, p.shares * act.fraction, x.px, act.reason);
  }
  // 2) trims. In defense mode the high-risk sleeve is cut back first; the safe sleeve keeps its normal size.
  const normalTarget = (val() * PCC.exposureTilt(sc.riskOff ? 0.8 : 0.99, sc.putcall, { stress: false, riskOff: sc.riskOff }).exposure) / AP_SLOTS;
  for (const [sym, p] of Object.entries(st.positions)) {
    const x = by[sym]; if (!x || x.stale) continue; const v = p.shares * x.px, risk = slv(sym) === "risk";
    if (p.owner && !sc.stress) continue; // a position the owner asked for keeps its size (defense mode still applies)
    const k = p.size || 1; // volatility sizing: each holding's own slot size
    if (sc.stress && risk) { if (v > target * k * 1.1) apTrade(st, "SELL", sym, (v - target * k) / x.px, x.px, `Defense mode — high-risk holdings trimmed first: ${sc.stress}`); continue; }
    const tgt = (sc.stress ? normalTarget : target) * k;
    if (v > tgt * 1.6) apTrade(st, "SELL", sym, (v - tgt) / x.px, x.px, pcT.note && !sc.stress ? `Trimmed — ${pcT.note}` : sc.riskOff ? "Trimmed — S&P 500 is below its 200-day average, so the bot keeps 20% cash" : (k === 1 ? "Trimmed back to an equal slot after a big run-up" : "Trimmed back to its volatility-sized slot after a big run-up"));
  }
  if (sc.stress) return;
  const earnOk = (x) => !x.earnNext || ["none", "ok"].includes(TEAM.earningsAction({ held: false, days: x.earnNext.days, research: sc.spiderOff ? null : x.research }).action);
  const ok = (x, sl) => x.sleeve === sl && !CO.paused(OWNER, "swing") && !CO.blocked(OWNER, "swing", x.sym) && !CA.blocked(COACH_PLAN, "swing", x.sym) && !(sl === "risk" && sc.pauseRisk) && !(x.check && x.check.verdict === "veto" && !sc.spiderOff) && earnOk(x) && !x.stale && !st.positions[x.sym] && !cool(x.sym) && x.px >= 5 && x.news > -1.5 && !(x.health && x.health.grade === "F") && !(x.earn && (x.earn.kind === "miss" || x.earn.kind === "soon")) &&
    (sl === "risk" ? x.px > x.m50 || x.px > x.m200 || (x.earn && x.earn.kind === "beat") : x.px > x.m200);
  const why = (x) => {
    const bits = [x.sleeve === "risk" ? `high-risk pick (${Math.round(x.vol * 100)}% volatility)` : `safe pick (${Math.round(x.vol * 100)}% volatility)`];
    if (x.earn && x.earn.kind === "beat") bits.push(`${opening ? "reported overnight: " : ""}${fmtE(x.earn)}`);
    if (x.news >= 1 && x.headlines[0]) bits.push(`good news: “${x.headlines[0].slice(0, 90)}”`);
    if (x.adj != null) bits.push(`analysts ${x.adj >= 1 ? "strongly positive" : x.adj >= 0.5 ? "positive" : "mixed"}`);
    if (x.health) bits.push(`10-K health grade ${x.health.grade}`);
    if (x.ratios && Math.abs(x.ratios.score) >= 0.15) bits.push(`ratios ${x.ratios.score > 0 ? "beat" : "trail"} peers (${(x.ratios.score > 0 ? x.ratios.best : x.ratios.worst)[0] || ""})`);
    if (x.spider && x.spider.note) bits.push(x.spider.note.replace(/^Spider: /, "Spider research: "));
    if (x.check && !sc.spiderOff) bits.push(x.check.verdict === "ok" ? "spider pre-buy check: no red flags" : x.check.verdict === "caution" ? x.check.note.replace(/^Spider caution/, "spider pre-buy caution") : "not yet researched by the spider");
    bits.push(`${x.mom >= 0 ? "+" : ""}${(x.mom * 100).toFixed(0)}% over 3 months`);
    if (Math.abs(x.day) >= 1) bits.push(`${x.day >= 0 ? "+" : ""}${x.day.toFixed(1)}% today`);
    if (sc.putcall && sc.putcall.signal === "BUY") bits.push("Zweig put/call buy signal (crowd heavy in puts — contrarian bullish)");
    return `Ranked #${x.rank}: ` + bits.join(", ");
  };
  // volatility sizing: the sleeve's median volatility is the reference for an equal-risk slot
  const refVol = { risk: RISK.median(sc.list.filter((x) => x.sleeve === "risk").map((x) => x.vol)), safe: RISK.median(sc.list.filter((x) => x.sleeve === "safe").map((x) => x.vol)) };
  const sizeOf = (x) => RISK.volSize(x.vol, refVol[x.sleeve], { min: STRATS.swing.params.sizeMin, max: STRATS.swing.params.sizeMax });
  for (const sl of ["risk", "safe"]) {
    // 3) swaps inside the sleeve: a much stronger name replaces the weakest holding (held at least an hour)
    for (const x of sc.list) {
      if (pace.swaps <= 0 || held(sl).length < SLOTS[sl]) break;
      if (!ok(x, sl)) continue;
      const weakest = held(sl).filter((s) => by[s] && !by[s].stale && !cool(s) && !st.positions[s].owner && RISK.rankExitAllowed(now - (st.positions[s].at || now), opening, STRATS.swing.params.rankHoldDays)).sort((a, b) => by[a].score - by[b].score)[0];
      if (!weakest || x.score < by[weakest].score + pace.gap) break;
      apTrade(st, "SELL", weakest, st.positions[weakest].shares, by[weakest].px, `Swapped out for ${x.sym}, which scores higher (#${by[weakest].rank} vs #${x.rank})`);
      pace.swaps--;
    }
    // 4) buys into empty slots
    for (const x of sc.list) {
      if (held(sl).length >= SLOTS[sl]) break;
      if (!ok(x, sl)) continue;
      const size = sizeOf(x), amt = Math.min(target * size * CA.sizeFactor(COACH_PLAN, "swing") * CO.sizeFactor(OWNER, "swing"), CO.maxTrade(OWNER, "swing"), st.cash - 5); if (amt < 50) break; // Coach: half size during a losing run; owner size/caps
      const thesis = THESIS.atBuy(sc.spiderOff ? { ...x, spider: null } : x, now);
      apTrade(st, "BUY", x.sym, amt / PAPER.paperFill("BUY", x.px, AP_COST), x.px, why(x) + (size !== 1 ? `; sized ${size.toFixed(2)}× an equal slot for its volatility` : ""), x.name, sl, undefined, { size, ...(thesis ? { thesis } : {}) });
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
  const pick = (x) => ({ sleeve: x.sleeve, vol: +(x.vol || 0).toFixed(3), sym: x.sym, name: x.name, rank: x.rank, score: +x.score.toFixed(3), news: +x.news.toFixed(2), headline: x.headlines[0] || null, earn: x.earn, mom: +x.mom.toFixed(4), adj: x.adj == null ? null : +x.adj.toFixed(2), trend: x.trend, day: +(x.day || 0).toFixed(2), held: !!AP.positions[x.sym], grade: x.health ? x.health.grade : null, spider: x.spider || null, ratios: x.ratios || null,
    check: x.check ? { verdict: x.check.verdict, note: x.check.note } : null, lesson: x.lesson || null, earnNext: x.earnNext || null });
  return { t: Date.now(), riskOff: sc.riskOff, stress: sc.stress, caution: sc.caution || null, defense: sc.defense || null, pauseRisk: !!sc.pauseRisk,
    checks: AP_CHECKS.slice(0, 12).map(({ evidence, ...c }) => c), lessons: sc.lessons || [], macro: +sc.macro.toFixed(2), vix: sc.vix, putcall: sc.putcall || null,
    top: sc.list.slice(0, 15).map(pick),
    news: sc.list.filter((x) => Math.abs(x.news) >= 1).sort((a, b) => Math.abs(b.news) - Math.abs(a.news)).slice(0, 8).map(pick),
    earnings: sc.list.filter((x) => x.earn).sort((a, b) => (a.earn.kind === "soon") - (b.earn.kind === "soon")).slice(0, 12).map(pick) };
}
// ---- spider-off twin (#5): the same swing bot run WITHOUT the spider (no score nudges, no pre-buy checks, no spider
// input to defense or earnings decisions). Hypothetical paper book that fills at scan prices, to measure whether
// the spider's research actually helps. Starts from the real account's holdings so both diverge from one point.
function apTwinInit(now = Date.now()) {
  if (AP.twin && AP.twin.run === AP.run) return AP.twin;
  const value = AP.cash + Object.entries(AP.positions).reduce((a, [k, p]) => a + p.shares * (apPx[k] || p.cost), 0);
  AP.twin = { isTwin: true, run: AP.run, since: now, start: +value.toFixed(2), realStart: +value.toFixed(2), cash: AP.cash, positions: structuredClone(AP.positions), recent: {}, trades: [], equity: [] };
  return AP.twin;
}
async function apTwinStops(q) {
  const T = AP.twin; if (!T || T.run !== AP.run) return;
  const syms = Object.keys(T.positions); if (!syms.length) return;
  const miss = syms.filter((s) => !q[s]), q2 = miss.length ? (await getQuotes(miss)).quotes : {};
  for (const s of syms) {
    const p = T.positions[s], x = q[s] || q2[s]; if (!PAPER.usableQuote(x, Date.now())) continue;
    p.peak = Math.max(p.peak || p.cost, x.price);
    const [sl, tr] = apStops(p), stop = Math.max(p.cost * (1 - sl), p.peak * (1 - tr));
    if (x.price <= stop) apTrade(T, "SELL", s, p.shares, x.price, x.price <= p.cost * (1 - sl) ? `Stop-loss: down ${sl * 100}% from where it was bought` : `Trailing stop: fell ${tr * 100}% from its high`);
  }
  T.trades = T.trades.slice(0, 300);
}
function apTwinStep(sc, opening, t) {
  const T = apTwinInit();
  const list = sc.list.map((x) => ({ ...x, score: x.score - (x.spider ? x.spider.adj : 0), spider: null, check: null, research: null }))
    .sort((a, b) => b.score - a.score);
  list.forEach((x, i) => { x.rank = i + 1; });
  let rr = 0, sr = 0; for (const x of list) x.srank = x.sleeve === "risk" ? ++rr : ++sr;
  const defense = TEAM.defenseDecision({ ...sc.defenseIn, spider: null });
  if (defense.on) T.defenseDay = t.day;
  const sc2 = { ...sc, list, spiderOff: true, stress: defense.on ? defense.reason : null, caution: defense.caution ? defense.reason : null, pauseRisk: !!(defense.caution || T.defenseDay === t.day) };
  apDecide(T, sc2, opening, apPace(T.trades, t));
  T.trades = T.trades.slice(0, 300);
  const v = T.cash + Object.entries(T.positions).reduce((a, [k, p]) => a + p.shares * (apPx[k] || p.cost), 0);
  const real = AP.cash + Object.entries(AP.positions).reduce((a, [k, p]) => a + p.shares * (apPx[k] || p.cost), 0);
  const pt = { d: t.day, v: +v.toFixed(2), real: +real.toFixed(2) };
  if (T.equity.length && T.equity[T.equity.length - 1].d === pt.d) T.equity[T.equity.length - 1] = pt; else T.equity.push(pt);
  T.equity = T.equity.slice(-400);
}
function apTwinView() {
  const T = AP.twin; if (!T || T.run !== AP.run) return null;
  const last = T.equity[T.equity.length - 1];
  const value = last ? last.v : T.start, real = last ? last.real : T.realStart;
  return { since: T.since, start: T.start, value, realValue: real, positions: Object.keys(T.positions).length, trades: T.trades.slice(0, 25), equity: T.equity.slice(-120),
    compare: TEAM.twinCompare({ start: T.realStart, value: real }, { start: T.start, value }) };
}
// ---- "Why" card (#7): every bot's view of one stock plus the spider's evidence. Owner/desk only.
async function whyView(symIn) {
  const sym = String(symIn || "").toUpperCase().replace(/[^A-Z0-9.\-^=]/g, "").slice(0, 12); if (!sym) return { error: "symbol required" };
  const ys = ySym(sym), x = apLastList.by.get(ys), r2 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  const tradesOf = (L, n = 5) => (L || []).filter((t) => t.sym === sym || t.sym === ys).slice(0, n).map((t) => ({ t: t.t, side: t.side, shares: t.shares, price: t.price, pnl: t.pnl ?? null, why: t.why || t.reason || null }));
  const ap = AP.positions[ys], plan = AP.plan && AP.plan.orders ? AP.plan.orders.filter((o) => o.sym === ys) : [], pend = AP.pending ? AP.pending.orders.filter((o) => o.sym === ys) : [];
  const swing = {
    scanned: x ? { at: apLastList.t, rank: x.rank, of: apLastList.n, score: r2(x.score), sleeve: x.sleeve, analysts: x.adj == null ? null : r2(x.adj), momentum3m: r2(x.mom), trend: x.trend, news: r2(x.news), headline: (x.headlines || [])[0] || null,
      grade: x.health ? x.health.grade : null, ratios: x.ratios ? r2(x.ratios.score) : null, spiderNudge: x.spider ? x.spider.adj : null, lesson: x.lesson, check: x.check || null, earnNext: x.earnNext || null } : null,
    holding: ap ? { shares: ap.shares, cost: ap.cost, since: ap.at, sleeve: ap.sleeve, price: apPx[ys] || null } : null,
    plans: [...plan.map((o) => ({ ...o, when: "planned for the open" })), ...pend.map((o) => ({ side: o.side, sym: o.sym, why: o.why, when: "waiting for a fresh quote" }))],
    trades: tradesOf(AP.trades),
    note: x ? null : "Not in the swing bot's current candidate list (it ranks the analyst top 60, fresh earnings beats and its holdings).",
  };
  const dp = DT.positions[sym], day = { holding: dp ? { dir: dp.dir, shares: dp.shares, entry: dp.entry ?? null, stop: dp.stop ?? null, setup: dp.setup || null, why: dp.why || null } : null, queued: DT.entries && DT.entries[sym] ? true : false, trades: tradesOf(DT.trades) };
  const qd = QT.decisions && QT.decisions[0], qp = QT.positions[sym], qr = qd && qd.ranked ? qd.ranked.find((y) => y.s === sym) : null;
  const quant = { inUniverse: [...QTC.QT_EQUITY, ...QTC.QT_DEFENSIVE, QTC.QT_CASH].includes(sym), regime: qd ? qd.regime : null, rawRegime: qd ? qd.rawRegime || qd.regime : null,
    target: qd && qd.target ? qd.target[sym] ?? 0 : null, ranked: qr || null, holding: qp ? { shares: qp.shares, cost: qp.cost } : null,
    queued: QT.pending ? QT.pending.orders.filter((o) => o.sym === sym).map((o) => ({ side: o.side, shares: o.shares, to: o.to })) : [], trades: tradesOf(QT.trades) };
  let spider = null;
  try { if (SPIDER) { const pk = SPIDER.packet(ys), sig = SPIDER.researchSignals({ symbols: [ys] }).items.filter((i) => i.sym === ys);
    spider = { lastResearched: pk.coverage.lastResearched, discoveries: pk.coverage.recent, signal: pk.signal, traderSignal: pk.traderSignal, signals: sig.slice(0, 5),
      developments: pk.developments.slice(0, 5), risks: pk.risks.slice(0, 4), catalysts: pk.catalysts, upcoming: pk.earnings.upcoming, note: pk.note }; } } catch {}
  return { sym, at: Date.now(), swing, day, quant, spider, note: "Paper trading only. Each bot's view comes from its latest scan or decision; spider evidence lists its sources." };
}
// ---- Morning brief (#8)
async function briefView() {
  const t = etParts(), now = Date.now();
  // "overnight" = since the most recent regular close (4 PM ET on the last weekday)
  let since = Date.parse(`${t.day}T21:00:00Z`); if (t.min < 16 * 60 || t.wd === "Sat" || t.wd === "Sun") { since -= 864e5; while ([0, 6].includes(new Date(since).getUTCDay())) since -= 864e5; }
  if (since > now) since -= 864e5;
  const cal = await apEarnings().catch(() => []);
  const held = { swing: Object.keys(AP.positions), day: Object.keys(DT.positions), quant: Object.keys(QT.positions) };
  const earningsHeld = [];
  for (const sym of new Set([...held.swing, ...held.day, ...held.quant])) {
    const e = apEarnNext(sym, cal, t.day); if (!e || e.days > 5) continue;
    const bots = Object.entries(held).filter(([, L]) => L.includes(sym)).map(([k]) => k);
    let research = null; try { research = SPIDER ? SPIDER.signal(sym) : null; } catch {}
    const p = AP.positions[sym], act = TEAM.earningsAction({ held: true, days: e.days, pnlPct: p && apPx[sym] ? apPx[sym] / p.cost - 1 : 0, sleeve: p ? p.sleeve : "risk", research });
    earningsHeld.push({ sym, days: e.days, date: e.date, bots, action: act.reason || act.action });
  }
  const inScope = new Set([...held.swing, ...held.day, ...held.quant, ...[...apLastList.by.values()].slice(0, 40).map((x) => x.sym)]);
  const today = cal.filter((e) => e.date === t.day && e.epsActual == null).map((e) => ({ sym: ySym(e.symbol), hour: e.hour || null, epsEstimate: e.epsEstimate ?? null, relevant: inScope.has(ySym(e.symbol)) }))
    .sort((a, b) => b.relevant - a.relevant);
  let findings = [], heldSignals = [], desk = null;
  try { if (SPIDER) { findings = SPIDER.overnight(since, 8); heldSignals = SPIDER.researchSignals({ symbols: [...held.swing, ...held.day, ...held.quant] }).items.filter((i) => i.sym && inScope.has(i.sym)); } } catch {}
  try { const dv = deskRisk.view(); desk = dv && dv.mode ? { mode: dv.mode, reason: dv.reason } : null; } catch {}
  const qd = QT.decisions && QT.decisions[0];
  const plans = [
    { bot: "Swing bot", orders: (AP.plan && AP.plan.orders || []).map((o) => ({ side: o.side, sym: o.sym, amount: o.amount, why: o.why })), at: AP.plan ? AP.plan.t : null, empty: "No trades planned for the open" },
    { bot: "Quant trader", orders: (QT.pending ? QT.pending.orders : []).map((o) => ({ side: o.side, sym: o.sym, amount: o.shares && o.referencePrice ? +(o.shares * o.referencePrice).toFixed(2) : null, why: QT.pending.why })), at: QT.pending ? QT.pending.at : null, empty: qd ? `No rebalance queued · ${qd.regime}` : "No rebalance queued" },
    { bot: "Day trader", orders: [], at: null, empty: Object.keys(DT.positions).length ? `${Object.keys(DT.positions).length} open position(s); new trades are decided intraday` : "Decides intraday from 5-minute bars — nothing pre-planned" },
  ];
  const sig = apSig || {};
  return TEAM.buildBrief({ day: t.day, now, since, findings, plans, earningsToday: today, earningsHeld, heldSignals, desk,
    defense: sig.defense || null, riskOff: !!sig.riskOff, regime: QT.regimeState || null, vetoes: AP_CHECKS.filter((c) => c.verdict === "veto" && c.t >= since) });
}

// ---- Coach (VP of Finance): reviews the other bots with rules + real prices (public/coach-core.js), then fixes what they do wrong (coach-actions-core.js).
// Chart reads on everything held or top-ranked, a journal review of each bot's last 20 closed trades, and a hypothetical −20% market.
const COACH = require("./public/coach-core.js");
let coachCache = { t: 0, v: null, p: null };
// The Coach acts (coach-actions-core.js): each review becomes automatic, bounded fixes on the paper bots, saved so they
// survive restarts; findings it leaves alone are explained. The bots read COACH_PLAN; the owner sees a report.
const CA = require("./coach-actions-core.js");
let COACH_PLAN = null, coachPlanStoreV = null;
const coachPlanStore = () => (coachPlanStoreV = coachPlanStoreV || paperStore("coach-actions-v1", { url: UP_URL, token: UP_TOKEN }));
// The owner's chat with the Coach (coach-orders-core.js): plain-English instructions become standing orders the bots
// obey, and they outrank the Coach's own fixes. Free rule-based interpreter, no AI model. Saved with the Coach's plan.
const CO = require("./coach-orders-core.js");
// Google Gemini, free tier (GEMINI_API_KEY from Google AI Studio, no card). Used to read the owner's plain English in the
// Coach chat and to answer questions, and by the Research Assistant when no Claude key is set. A daily cap keeps it well
// inside the free quota; with billing off on the Google project it cannot cost anything.
const GEM = require("./gemini-core.js");
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEM_STATE = { model: process.env.GEMINI_MODEL || null, modelAt: 0, day: "", used: 0, cap: Math.max(1, +process.env.GEMINI_DAILY_CAP || 300), lastError: null };
async function gemini(opts) {
  if (!GEMINI_KEY) throw Object.assign(new Error("no Gemini key"), { code: "no_key" });
  const day = new Date().toISOString().slice(0, 10); if (GEM_STATE.day !== day) Object.assign(GEM_STATE, { day, used: 0 });
  if (GEM_STATE.used >= GEM_STATE.cap) throw Object.assign(new Error(`Daily AI cap reached (${GEM_STATE.cap} messages); it resets at midnight UTC.`), { code: "cap" });
  if (!GEM_STATE.model || (!process.env.GEMINI_MODEL && Date.now() - GEM_STATE.modelAt > 24 * 3600e3)) {
    try { const r = await fetch(`${GEM.BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": GEMINI_KEY }, signal: AbortSignal.timeout(10_000) }); if (r.ok) { const L = await r.json(); GEM_STATE.model = GEM.pickModel(L); GEM_STATE.backups = GEM.backupModels(L, GEM_STATE.model); GEM_STATE.modelAt = Date.now(); } } catch {}
    GEM_STATE.model = GEM_STATE.model || "gemini-flash-latest";
  }
  GEM_STATE.used++;
  // free models get "high demand" 503s at busy times: fall through to a backup model instead of giving up
  const tryModels = [GEM_STATE.model, ...(GEM_STATE.backups || ["gemini-flash-latest"]).filter((m) => m !== GEM_STATE.model)].slice(0, 3);
  let r, j;
  for (let i = 0; i < tryModels.length; i++) {
    r = await fetch(`${GEM.BASE}/models/${encodeURIComponent(tryModels[i])}:generateContent`, { method: "POST", headers: { "x-goog-api-key": GEMINI_KEY, "content-type": "application/json" }, body: JSON.stringify(GEM.body(opts)), signal: AbortSignal.timeout(20_000) }).catch((e) => ({ ok: false, status: 503, json: async () => ({ error: { message: String(e.message || e) } }) }));
    j = await r.json().catch(() => ({}));
    if (r.ok || !GEM.retryable(r.status)) { if (r.ok) GEM_STATE.lastModel = tryModels[i]; break; }
    if (i < tryModels.length - 1) await new Promise((ok) => setTimeout(ok, 600));
  }
  if (!r.ok) { if (r.status === 404) GEM_STATE.modelAt = 0; const e = new Error(GEM.errorFor(r.status, j)); e.status = r.status; GEM_STATE.lastError = e.message; throw e; }
  try { const t = GEM.textOf(j); GEM_STATE.lastError = null; return t; }
  catch (e) { GEM_STATE.lastError = e.message; throw e; }
}
const geminiInfo = () => ({ on: !!GEMINI_KEY, model: GEM_STATE.model, backups: GEM_STATE.backups || [], lastModel: GEM_STATE.lastModel || null, usedToday: GEM_STATE.day === new Date().toISOString().slice(0, 10) ? GEM_STATE.used : 0, cap: GEM_STATE.cap, lastError: GEM_STATE.lastError });
let OWNER = CO.fresh();
const ownerReady = (async () => { try { const v = await coachPlanStore().get("orders"); if (v && Array.isArray(v.directives)) OWNER = { ...CO.fresh(), ...v }; } catch {} })();
const ownerSave = () => coachPlanStore().set("orders", OWNER).catch(() => {});
async function ownerResolve(p) {
  for (const c of [p.sym, p.maybeTicker].filter(Boolean)) {
    if (!TICKER_RE.test(c)) continue;
    try { const q = await quote(c); if (q && q.price > 0) return { ok: true, sym: c, name: q.name }; } catch {}
  }
  if (p.symText) {
    try { const r = (await search(p.symText)).find((x) => ["equity", "etf", "future", "crypto", "forex"].includes(x.assetClass)); if (r) return { ok: true, sym: r.symbol, name: r.name }; } catch {}
  }
  return { ok: false };
}
function botsBrief() {
  const L = [], f = (n) => (Number.isFinite(n) ? n.toFixed(2) : "n/a");
  try { const v = AP.cash + Object.entries(AP.positions).reduce((a, [k, p]) => a + p.shares * (apPx[k] || p.cost), 0);
    L.push(`SWING BOT: value $${f(v)} (started $${AP_START}), cash $${f(AP.cash)}. Holdings: ${Object.entries(AP.positions).map(([k, p]) => `${k} ${f(p.shares)} sh @ ${f(p.cost)} now ${f(apPx[k])}${p.owner ? " (owner)" : ""}`).join("; ") || "none"}. Last trades: ${(AP.trades || []).slice(0, 6).map((t) => `${t.side} ${t.sym} @${t.price}${t.pnl != null ? ` P&L ${t.pnl}` : ""} — ${String(t.why || "").slice(0, 80)}`).join(" | ") || "none"}`); } catch {}
  try { L.push(`DAY TRADER: open ${Object.keys(DT.positions || {}).join(", ") || "none"}. Last trades: ${(DT.trades || []).slice(0, 6).map((t) => `${t.side} ${t.sym}${t.pnl != null ? ` P&L ${t.pnl}` : ""} (${t.setup || ""})`).join(" | ") || "none"}`); } catch {}
  try { const d = (QT.decisions || [])[0]; L.push(`QUANT: holdings ${Object.entries(QT.positions || {}).map(([k, p]) => `${k} ${f(p.shares)} sh`).join(", ") || "none"}. Regime ${d ? d.regime : "n/a"}.`); } catch {}
  try { const k = coachCache.v; if (k) { L.push(`COACH: ${k.headline || ""}. Fixes: ${(k.fixed || []).map((x) => `${x.fix} (${x.why})`).join("; ") || "none"}. Left alone: ${(k.noted || []).map((x) => `${x.bot}: ${x.finding} -> ${x.why}`).join("; ") || "none"}.`);
    for (const j of k.journals || []) if (j.ok) L.push(`${j.bot} journal: ${j.closed} closed, win rate ${Math.round(j.winRate * 100)}%, net $${j.net}, mistakes: ${(j.mistakes || []).join(" ")}`); } } catch {}
  L.push(`OWNER INSTRUCTIONS: ${CO.live(OWNER, Date.now()).map((d) => `#${d.id} ${CO.describe(d)}`).join("; ") || "none"}`);
  return L.join("\n").slice(0, 7000);
}
async function coachChat(text) {
  await ownerReady;
  let p = null, via = "rules", note = "";
  if (GEMINI_KEY) {
    try { p = GEM.toParse(GEM.jsonOf(await gemini({ system: GEM.COACH_SYSTEM, text, schema: GEM.COACH_SCHEMA, maxTokens: 300 }))); via = "gemini"; }
    catch (e) { GEM_STATE.lastError = e.message; note = e.code === "cap" || e.status ? `(${e.message})\n` : ""; p = null; }
  }
  if (!p || p.intent === "unknown") { const r = CO.parse(text); if (r.intent !== "unknown" || !p) { p = r; via = "rules"; } }
  if (p.intent === "unknown" && GEMINI_KEY && !note) p = { intent: "question" }; // "hello", "how are we doing?" → let Gemini answer
  CO.chat(OWNER, "you", text);
  if (p.intent === "question" || p.intent === "chat") {
    let reply;
    try { reply = await gemini({ system: GEM.ANSWER_SYSTEM, text: `DATA (paper bots, right now)\n${botsBrief()}\n\nOWNER: ${text}`, history: OWNER.chat.slice(-7, -1), maxTokens: 500 }); }
    catch (e) { reply = `${e.message} Meanwhile I can still follow instructions. ${CO.HELP}`; }
    CO.chat(OWNER, "coach", reply); await ownerSave();
    return { reply, via: "gemini", messages: OWNER.chat.slice(-60), instructions: CO.live(OWNER, Date.now()).map((d) => ({ id: d.id, text: CO.describe(d), status: d.status })), ai: geminiInfo() };
  }
  const res = ["buy", "sell", "avoid", "allow"].includes(p.intent) ? await ownerResolve(p) : {};
  const reply = note + CO.apply(OWNER, p, res);
  CO.chat(OWNER, "coach", reply);
  await ownerSave();
  return { reply, via, messages: OWNER.chat.slice(-60), instructions: CO.live(OWNER, Date.now()).map((d) => ({ id: d.id, text: CO.describe(d), status: d.status })), ai: geminiInfo() };
}
const coachPlanReady = (async () => { try { const v = await coachPlanStore().get("plan"); if (v && v.at) COACH_PLAN = v; } catch {} })();
async function coachBuild() {
  if (!apLoaded) await apLoad(); if (!dtLoaded) await dtLoad(); if (!qtLoaded) await qtLoad();
  const holdings = [
    ...Object.entries(AP.positions).map(([sym, p]) => ({ bot: "Swing bot", sym, value: p.shares * (apPx[sym] || p.cost) })),
    ...Object.entries(DT.positions).map(([sym, p]) => ({ bot: "Day trader", sym, value: (p.dir === "short" ? -1 : 1) * p.shares * (dtPx[sym] || p.entry || 0) })),
    ...Object.entries(QT.positions).map(([sym, p]) => ({ bot: "Quant", sym, value: p.shares * (qtPx[sym] || p.cost) })),
  ].filter((x) => x.value);
  const candidates = [...apLastList.by.values()].slice(0, 6).map((x) => x.sym);
  const syms = [...new Set([...holdings.map((x) => x.sym), ...candidates])].filter((s) => !/^\^/.test(s)).slice(0, 30);
  const closes = {}, failed = [];
  for (const s of ["SPY", ...syms]) {
    try { const hh = await history(s, "1y"); const c = hh.candles.map((k) => k.close); if (c.length) closes[s] = c; else failed.push(s); } catch { failed.push(s); }
  }
  const role = (s) => (holdings.some((x) => x.sym === s) ? "held by " + [...new Set(holdings.filter((x) => x.sym === s).map((x) => x.bot))].join(", ") : "swing candidate");
  const charts = syms.map((s) => (closes[s] ? { ...COACH.chartRead(closes[s], { sym: s }), role: role(s) } : { sym: s, ok: false, role: role(s), why: "Price history unavailable." }));
  const journals = [["Swing bot", AP.trades], ["Day trader", DT.trades], ["Quant", QT.trades]].map(([bot, L]) => ({ bot, ...COACH.journal(L || []) }));
  const stress = COACH.stress(holdings, closes);
  const flags = [];
  for (const j of journals) if (j.ok && j.rules.length) flags.push(`${j.bot}: ${j.rules[0]}`);
  if (stress.ok) { if (stress.pairs.length) flags.push(`${stress.pairs[0].a} and ${stress.pairs[0].b} move together (${stress.pairs[0].corr}); a selloff hits both.`); for (const b of stress.bots) for (const o of b.over) flags.push(`${b.bot}: ${o.sym} is ${o.weight}% of its book.`); }
  for (const c of charts) if (c.ok && c.signal === "Sell" && /held/.test(c.role)) flags.push(`${c.sym} (${c.role}) reads Sell on the chart.`);
  await coachPlanReady;
  COACH_PLAN = CA.plan({ journals, stress, charts }, { prev: COACH_PLAN });
  try { await coachPlanStore().set("plan", COACH_PLAN); } catch {}
  const acts = CA.summary(COACH_PLAN);
  return { at: Date.now(), charts, journals, stress, findings: flags.slice(0, 8), flags: [], fixed: acts.fixed, noted: acts.noted, headline: acts.headline, unavailable: failed,
    note: "The Coach applies its fixes to the paper bots by itself (pauses, half size, cooldowns, loss caps, trims) and explains anything it leaves alone. Reviews use real daily prices; the −20% test is hypothetical." };
}
// ---- My Trader: the owner's own $30,000 paper account, traded by hand (my-trader-core.js). Lives on the bot server.
const MYT = require("./my-trader-core.js");
let mtStoreV = null; const mtStoreGet = () => (mtStoreV = mtStoreV || paperStore("my-trader-v1", { url: UP_URL, token: UP_TOKEN }));
const mtStore = { get: (k) => mtStoreGet().get(k), set: (k, v) => mtStoreGet().set(k, v), get durable() { return mtStoreGet().durable; } };
let MT = null, mtLoading = null, mtQ = Promise.resolve();
async function mtLoad() { if (MT) return MT; if (!mtLoading) mtLoading = mtStore.get("book").then((v) => (MT = v && v.v === 1 ? v : MYT.fresh()), (e) => { mtLoading = null; throw e; }); return mtLoading; }
const mtLocked = (fn) => { const p = mtQ.then(fn, fn); mtQ = p.catch(() => {}); return p; }; // one change at a time
async function mtMark(st, quotes) {
  const px = {}; for (const s of Object.keys(st.positions)) if (quotes[s] && quotes[s].price > 0) px[s] = quotes[s].price;
  const v = MYT.value(st, px), spx = quotes["^GSPC"] && quotes["^GSPC"].price > 0 ? quotes["^GSPC"].price : null;
  MYT.mark(st, { day: etParts().day, value: v.value, spx }); return { ...v, px, spx };
}
// Each instrument trades in its own session: US stocks/ETFs/options use the exchange-calendar check the bots use;
// crypto is 24/7; futures, FX and foreign stocks use their own hours (the provider's session times when it has them).
function mtOpenFn(m, quotes = {}) {
  return (sym) => {
    const q = quotes[sym], inst = INST.normalize({ symbol: sym, quoteType: q && q.instrumentType, exchDisp: q && q.exchange, currency: q && q.currency });
    const usSession = inst.marketHours.session === "us_equity" || inst.marketHours.session === "us_option";
    if (usSession) return !!m.open;
    const c = INST.marketStatus(inst, Date.now(), q && q.periods).code;
    return c === "OPEN" || c === "LIVE";
  };
}
async function mtTick() {
  return mtLocked(async () => {
    const st = await mtLoad(); if (!st.firstTrade && !st.pending.length) return;
    const m = await apMarketOpen(), syms = [...new Set([...Object.keys(st.positions), ...st.pending.map((o) => o.sym)])];
    const q = (await getQuotes([...syms, "^GSPC"])).quotes;
    const done = MYT.work(st, q, { now: Date.now(), open: mtOpenFn(m, q) });
    const fee = MYT.borrow(st, { day: etParts().day, px: Object.fromEntries(Object.keys(st.positions).filter((x) => q[x] && q[x].price > 0).map((x) => [x, q[x].price])) });
    await mtMark(st, q);
    if (done.length || fee || m.open || !st.lastSaved || Date.now() - st.lastSaved > 30 * 60e3) { st.lastSaved = Date.now(); await mtStore.set("book", st); }
  });
}
// Keep the bots awake Mon–Fri 6 AM – 5 PM ET on Render's free plan: while awake, the server visits its own public
// address every 9 minutes (Render sleeps a free service after 15 minutes without inbound traffic). After 5 PM it
// stops and the service sleeps. The GitHub "Keep site awake" workflow wakes it in the morning.
const SELF_URL = process.env.RENDER_EXTERNAL_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : process.env.SELF_URL || "");
if (DEPLOY.runJobs && /^https:\/\//.test(SELF_URL) && !process.env.AP_TEST) {
  const selfUrl = SELF_URL.replace(/\/+$/, "") + "/api/health";
  setInterval(() => { if (DM.awakeWindow()) fetch(selfUrl, { signal: AbortSignal.timeout(20_000) }).catch(() => {}); }, 9 * 60_000).unref();
}
if (DEPLOY.runJobs) setTimeout(() => { mtTick().catch((e) => diagErr("my", e)); setInterval(() => mtTick().catch((e) => diagErr("my", e)), 60e3); }, process.env.AP_TEST ? 4000 : 50_000);
async function mtView() {
  const st = await mtLoad(), syms = Object.keys(st.positions);
  let q = {}; try { q = (await getQuotes([...syms, "^GSPC"])).quotes; } catch {}
  const v = MYT.value(st, Object.fromEntries(syms.filter((s) => q[s] && q[s].price > 0).map((s) => [s, q[s].price])));
  const m = await apMarketOpen().catch(() => ({ open: false }));
  const pxMap = {};
  const positions = syms.map((s) => { const p = st.positions[s], short = p.dir === "short", px = q[s] && q[s].price > 0 ? q[s].price : null, mult = MYT.multOf(p), val = p.shares * mult * (px ?? p.cost);
    if (px != null) pxMap[s] = px;
    return { sym: s, dir: short ? "short" : "long", shares: p.shares, cost: +p.cost.toFixed(4), price: px, value: +val.toFixed(2), pnl: px == null ? null : +((short ? p.cost - px : px - p.cost) * p.shares * mult).toFixed(2), mult, assetClass: INST.assetClassOf(s, q[s] && q[s].instrumentType), pnlPct: px == null ? null : short ? 1 - px / p.cost : px / p.cost - 1,
      dayPct: q[s] ? q[s].changePct ?? null : null, weight: v.value > 0 ? val / v.value : null, at: p.at, priced: px != null, autoCoverAt: short ? +(p.cost * (1 + MYT.SHORT_STOP)).toFixed(2) : null }; })
    .sort((a, b) => b.value - a.value);
  return { startValue: st.start, value: v.value, cash: st.cash, positions, pending: st.pending, trades: st.trades.slice(0, 300), equity: st.equity, intraday: st.intraday, spx0: st.spx0,
    spxNow: q["^GSPC"] && q["^GSPC"].price > 0 ? q["^GSPC"].price : null, firstTrade: st.firstTrade, marketOpen: !!m.open, unpriced: v.missing, stats: MYT.stats(st),
    buyingPower: MYT.buyingPower(st, pxMap), shortReserve: +MYT.shortReserve(st, pxMap).toFixed(2),
    rules: { cost: MYT.COST, start: MYT.START, maxQuoteAge: MYT.MAX_QUOTE_AGE, borrowYr: MYT.BORROW_YR, shortStop: MYT.SHORT_STOP }, durable: mtStore.durable };
}
async function mtOrder(body) {
  return mtLocked(async () => {
    const st = await mtLoad(), sym = String(body && body.sym || "").trim().toUpperCase(), m = await apMarketOpen();
    let fq = null, qs = {}; if (TICKER_RE.test(sym)) { try { const q = await quote(sym); qs[sym] = q; fq = { price: q.price, marketTime: q.marketTime, delayMin: q.delayMin || 0 }; } catch {} }
    const r = MYT.place(st, body || {}, { now: Date.now(), open: mtOpenFn(m, qs), quote: fq });
    if (r.ok) { if (r.filled) { try { await mtMark(st, (await getQuotes([...Object.keys(st.positions), "^GSPC"])).quotes); } catch {} } await mtStore.set("book", st); LB.t = 0; }
    return r;
  });
}
if (DEPLOY.runJobs && !process.env.AP_TEST) setTimeout(() => { const go = () => { coachCache.t = 0; coachView().catch((e) => diagErr("swing", e)); }; go(); setInterval(go, 2 * 3600e3); }, 3 * 60_000);
async function coachView() {
  if (coachCache.v && Date.now() - coachCache.t < 2 * 3600e3) return coachCache.v;
  if (!coachCache.p) coachCache.p = coachBuild().then((v) => { coachCache = { t: Date.now(), v, p: null }; return v; }, (e) => { coachCache.p = null; throw e; });
  return coachCache.p;
}
async function apOwnerOrders(draft) {
  let changed = false;
  const value = AP.cash + Object.entries(AP.positions).reduce((a, [k, p]) => a + p.shares * (apPx[k] || p.cost), 0);
  for (const d of CO.sells(OWNER, "swing")) {
    const p = draft.positions[d.sym];
    if (!p) { if (!AP.positions[d.sym]) { d.status = "done"; d.ended = Date.now(); changed = true; } continue; }
    let q = null; try { q = await quote(d.sym); } catch {}
    if (!PAPER.usableQuote(q, Date.now())) continue;
    apTrade(draft, "SELL", d.sym, p.shares, q.price, `Owner instruction #${d.id}: sell ${d.sym}`); d.status = "queued"; changed = true;
  }
  for (const d of CO.buys(OWNER, "swing")) {
    if (AP.positions[d.sym] && AP.positions[d.sym].owner) { d.status = "done"; d.ended = Date.now(); changed = true; continue; }
    if (draft.positions[d.sym]) { draft.positions[d.sym].owner = true; if (AP.positions[d.sym]) { AP.positions[d.sym].owner = true; d.status = "done"; d.ended = Date.now(); changed = true; } continue; }
    let q = null; try { q = await quote(d.sym); } catch {}
    if (!PAPER.usableQuote(q, Date.now())) continue;
    const amt = Math.min(CO.buyAmount(d, { price: q.price, accountValue: value, slot: value / AP_SLOTS }), draft.cash - 5);
    if (!(amt >= 50)) { d.note = "Not enough cash for this buy"; continue; }
    apTrade(draft, "BUY", d.sym, amt / PAPER.paperFill("BUY", q.price, AP_COST), q.price, `Owner instruction #${d.id}: buy ${d.sym}`, q.name, "risk", undefined, { owner: true });
    d.status = "queued"; changed = true;
  }
  if (changed) await ownerSave();
}
async function apTick() {
  if (apBusy) return; apBusy = true;
  try {
    if (!apLoaded) await apLoad();
    const m = await apMarketOpen(), now = Date.now();
    if (AP.pending && (!m.open || AP.pending.day !== m.t.day || now - AP.pending.at > PAPER.MAX_QUOTE_AGE)) {
      diagErr("swing", new Error("Unfilled paper orders expired before a fresh post-decision quote"));
      AP.pending = null;
    }
    if (!m.open) {
      // overnight / weekend: keep reading news + earnings and plan the opening trades (every 10 minutes)
      if (now - apLastPlan >= 10 * 60e3) {
        apLastPlan = now;
        const sc = await apScore(false); sc.pauseRisk = !!sc.caution; apSig = apSignals(sc);
        const copy = JSON.parse(JSON.stringify({ cash: AP.cash, positions: AP.positions, trades: [], recent: AP.recent }));
        apDecide(copy, sc, true, apPace(AP.trades, m.t));
        AP.plan = { t: now, orders: copy.trades.reverse().map((x) => ({ side: x.side, sym: x.sym, amount: x.amount, why: x.why.replace(/ \([+−]\$\d+\)$/, "") })) };
        AP.lastScan = apSig; await apSave();
      }
      return;
    }
    BOTDIAG.swing.lastOpenTick = now;
    if (AP.pending) {
      const pending = AP.pending;
      const { quotes } = await getQuotes([...new Set(pending.orders.map((order) => order.sym))]);
      const observedAt = Date.now();
      if (!sessionInfo().open || observedAt - pending.at > PAPER.MAX_QUOTE_AGE) return;
      const buys = pending.orders.filter((o) => o.side === "BUY" && PAPER.usableQuote(quotes[o.sym], observedAt, pending.at));
      if (buys.length) await deskRisk.prepare(buys.map((o) => o.sym));
      if (!sessionInfo().open) return;
      const executable = pending.orders.filter((o) => PAPER.usableQuote(quotes[o.sym], Date.now(), pending.at));
      if (!executable.length) return;
      const next = structuredClone(AP), tickets = [];
      try {
        for (const order of executable) {
          const quote = quotes[order.sym];
          let shares = order.shares;
          if (order.side === "BUY") {
            const stop = apStops({ sleeve: order.sleeve })[0];
            const ticket = deskRisk.reserve({ bot: "swing", sym: order.sym, sign: 1, shares, price: quote.price,
              riskPerShare: quote.price * (stop + 2 * AP_COST) });
            if (!ticket.shares) { BOTDIAG.swing.desk = ticket.reason; continue; }
            tickets.push(ticket);
            shares = ticket.shares;
          }
          apPx[order.sym] = quote.price;
          apTrade(next, order.side, order.sym, shares, quote.price, order.why, order.name, order.sleeve,
            { decisionAt: pending.at, decisionPrice: order.referencePrice, marketTime: quote.marketTime }, order.extra);
        }
        const remaining = pending.orders.filter((o) => !executable.includes(o));
        next.pending = remaining.length ? { ...pending, orders: remaining } : null;
        await apCommitFills(next);
      } finally { for (const ticket of tickets) ticket.release(); }
      if (AP.pending) return;
    }
    if (!AP.spx0) { try { AP.spx0 = (await quote("^GSPC")).price; AP.firstTrade = AP.firstTrade || now; } catch (e) { diagErr("swing", e); } }
    let syms = Object.keys(AP.positions), q = syms.length ? (await getQuotes(syms)).quotes : {};
    const draft = { cash: AP.cash, positions: structuredClone(AP.positions), recent: { ...AP.recent }, trades: [], intents: [] };
    // stops every minute
    for (const s of syms) {
      const p = AP.positions[s], x = q[s]; if (!PAPER.usableQuote(x, Date.now())) continue;
      p.peak = Math.max(p.peak || p.cost, x.price); apPx[s] = x.price;
      draft.positions[s].peak = p.peak;
      const [sl, tr] = apStops(p), stop = Math.max(p.cost * (1 - sl), p.peak * (1 - tr));
      if (x.price <= stop) apTrade(draft, "SELL", s, p.shares, x.price, x.price <= p.cost * (1 - sl) ? `Stop-loss: down ${sl * 100}% from where it was bought` : `Trailing stop: fell ${tr * 100}% from its high`);
    }
    try { await apTwinStops(q); } catch (e) { diagErr("swing", e); }
    // owner instructions from the Coach chat: buys and sells at the next fresh price (they outrank the bot's own rules)
    try { await ownerReady; await apOwnerOrders(draft); } catch (e) { diagErr("swing", e); }
    // full re-score every 10 minutes (and right at the opening bell)
    const opening = AP.lastRebalance !== m.t.day;
    if (opening || now - apLastScore >= 10 * 60e3) {
      apLastScore = now;
      const sc = await apScore(true);
      if (sc.stress) AP.defenseDay = m.t.day; // after a defense day, no new high-risk buys until tomorrow
      sc.pauseRisk = !!(sc.caution || AP.defenseDay === m.t.day);
      apSig = apSignals(sc);
      BOTDIAG.swing.lastScan = { t: now, candidates: sc.list.length, stress: sc.stress, riskOff: sc.riskOff, buysBefore: AP.trades.length };
      if (!AP.spx0) { try { AP.spx0 = (await quote("^GSPC")).price; AP.firstTrade = now; } catch {} }
      const pace = apPace(AP.trades, m.t); BOTDIAG.swing.pace = { today: pace.today, week: pace.week };
      apDecide(draft, sc, opening, pace);
      try { apTwinStep(sc, opening, m.t); } catch (e) { diagErr("swing", e); }
      BOTDIAG.swing.lastScan.ordersQueued = draft.intents.length;
      BOTDIAG.swing.lastScan.tradesMade = 0;
      AP.lastRebalance = m.t.day; AP.lastScan = apSig; AP.plan = null;
    }
    syms = Object.keys(AP.positions); q = syms.length ? (await getQuotes(syms)).quotes : {};
    const eq = apValueNow(q);
    let spx = null; try { spx = (await quote("^GSPC")).price; } catch {}
    const pt = { d: m.t.day, v: +eq.toFixed(2), spx };
    if (AP.equity.length && AP.equity[AP.equity.length - 1].d === pt.d) AP.equity[AP.equity.length - 1] = pt; else AP.equity.push(pt);
    if (!AP.intraday.length || AP.intraday[0].d !== m.t.day) AP.intraday = [];
    if (!AP.intraday.length || now - AP.intraday[AP.intraday.length - 1].t >= 5 * 60e3) AP.intraday.push({ d: m.t.day, t: now, v: pt.v, spx });
    // A bust can close positions only through the same paper execution path.
    if (eq < AP_BUST && syms.length) {
      draft.intents = syms.every((s) => PAPER.usableQuote(q[s], Date.now())) ? syms.map((sym) => ({
        side: "SELL", sym, shares: AP.positions[sym].shares, referencePrice: q[sym].price, why: "Account busted — closing everything",
      })) : [];
    } else if (eq < AP_BUST) {
      draft.intents = [];
      AP.runs.unshift({ ...apSummary(AP.cash, true, spx), strategy: AP.strategy || null });
      await archivePush("swing", { ...AP.runs[0], tradeLog: AP.trades, equity: AP.equity });
      Object.assign(AP, { run: AP.run + 1, start: now, cash: AP_START, positions: {}, trades: [], equity: [], intraday: [], recent: {}, spx0: null, firstTrade: null, lastRebalance: "" });
    }
    if (draft.intents.length && sessionInfo().open) {
      AP.pending = { day: m.t.day, at: Date.now(), orders: draft.intents };
    }
    await apSave();
  } catch (e) { console.error("autopilot", e.message); diagErr("swing", e); } finally { apBusy = false; BOTDIAG.swing.lastTick = Date.now(); }
}
async function apView(priv = false) {
  if (!apLoaded) await apLoad();
  const syms = Object.keys(AP.positions);
  const q = (await getQuotes([...syms, "^GSPC"])).quotes;
  const positions = syms.map((s) => { const p = AP.positions[s], x = q[s] || {}; const price = x.price || p.cost; return { sym: s, name: p.name, shares: p.shares, cost: p.cost, price, value: p.shares * price, pnl: (price - p.cost) * p.shares, pnlPct: (price / p.cost - 1) * 100, dayPct: x.changePct || 0, at: p.at, peak: p.peak, sleeve: p.sleeve || "risk", thesis: p.thesis ? p.thesis.labels : null, size: p.size || 1, stop: Math.max(p.cost * (1 - apStops(p)[0]), Math.max(p.peak || p.cost, price) * (1 - apStops(p)[1])) }; }).sort((a, b) => b.value - a.value);
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
    costs: AP.trades.reduce((a, t) => a + (t.cost != null ? t.cost : t.amount * 0.0005), 0), totalReturn: ret, benchmarkReturn: spxRet, excessReturn: spxRet != null ? ret - spxRet : null };
  analytics.expectancy = RISK.expectancyOf(sells.map((t) => t.pnl));
  const { twin: _twin, ...apOut } = AP, pmv = apPostMortems();
  const teamwork = { twin: apTwinView(), checks: AP_CHECKS.slice(0, 20).map((c) => (priv ? c : { ...c, evidence: undefined })), defenseDay: AP.defenseDay || null,
    postMortems: { closed: pmv.closed, causes: pmv.causes, lessons: pmv.lessons, losses: pmv.losses.slice(0, 12), rule: pmv.rule } };
  return { ...apOut, teamwork, strategy: { ...STRATS.swing, active: AP.strategy || null }, diag: { market: BOTDIAG.market, ...BOTDIAG.swing }, trades: tradesOut, analytics, positions, value, startValue: AP_START, bustAt: AP_BUST, spxNow: q["^GSPC"] && q["^GSPC"].price, marketOpen: open, status: mode, current, durable: !!(UP_URL && UP_TOKEN) };
}
// The owner's browser keeps a backup; if a redeploy wiped the server copy, it posts it back.
function apRestore(doc) {
  if (apBusy) return { ok: false, error: "Swing execution is in progress; retry later" };
  if (!doc || typeof doc !== "object" || doc.v !== 2 || typeof doc.cash !== "number" || !doc.positions || !Array.isArray(doc.trades)) return { ok: false, error: "bad data" };
  if (doc.resetId !== BOT_RESET_ID) return { ok: false, error: "backup is from before the reset" };
  const mine = AP.trades.length + (AP.runs || []).length * 1e4, theirs = doc.trades.length + (doc.runs || []).length * 1e4;
  if (theirs < mine || (AP.trades.length && doc.updated <= AP.updated)) return { ok: false, error: "server copy is newer" };
  const keep = ["resetId", "run", "runs", "start", "cash", "positions", "trades", "equity", "intraday", "lastRebalance", "lastScan", "spx0", "firstTrade", "recent", "updated"];
  AP = apFresh(); for (const k of keep) if (doc[k] !== undefined) AP[k] = doc[k];
  AP.trades = AP.trades.slice(0, 1500); AP.equity = (AP.equity || []).slice(-2000); AP.runs = (AP.runs || []).slice(0, 200); apFix();
  apSave(); return { ok: true };
}
if (DEPLOY.runJobs) setTimeout(() => { apTick(); setInterval(apTick, process.env.AP_TEST ? 6000 : 60e3); }, process.env.AP_TEST ? 3000 : 60_000);

// ---------------------------------------------------------------- AI day trader (paper, intraday, longs + shorts)
// A forecast from a completed minute can schedule a paper order for a future minute.
// The later open is a modeled fill. Research observations never reserve an order slot.
const DTC = require("./daytrade-core.js"), DTB = require("./daytrade-brain.js");
const DP = require("./day-pullback-core.js");
const { dayPilot: DT_PILOT } = require("./desk-risk-core.js").POLICY;
const DT_FILE = path.join(require("os").tmpdir(), "daytrader-v1.json"), DT_KEY = "pft:daytrader:v1";
const DT_PARAMS = STRATS.day.params;
const DT_LEV = DT_PARAMS.grossCap, DT_NET = DT_PARAMS.netCap, DT_POS_X = 0.5;
const DT_START = 30_000, DT_PAPER_FLOOR = 25_000, DT_FEE_SHORT = DT_PARAMS.borrow, DT_COST = DT_PARAMS.costPerSide, DT_HOLD = DT_PARAMS.holdMinutes;
const DT_LEGACY_COST = 0.0001;
const DT_UNIVERSE = ["SPY", "QQQ", "IWM", "DIA", "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AMD", "AVGO", "NFLX", "PLTR", "COIN", "MU", "JPM", "XOM", "BA",
  "UBER", "SMCI", "MSTR", "HOOD", "SOFI", "ARM", "INTC", "SHOP", "CRWD", "SNOW", "RIVN", "MARA", "DKNG", "ORCL", "CRM", "ABNB", "GOOG", "BRK-B", "LLY", "V",
  "MA", "UNH", "COST", "WMT", "HD", "PG", "JNJ", "ABBV", "MRK", "PFE", "KO", "PEP", "MCD", "DIS", "NKE", "SBUX", "BAC", "WFC", "C", "GS",
  "MS", "SCHW", "PYPL", "XYZ", "ADBE", "NOW", "PANW", "NET", "DDOG", "ZS", "MDB", "TEAM", "QCOM", "TXN", "AMAT", "LRCX", "KLAC", "MRVL", "ON", "TSM",
  "ASML", "CVX", "COP", "OXY", "SLB", "CAT", "DE", "GE", "LMT", "RTX", "F", "GM", "LCID", "NIO", "AAL", "DAL", "UAL", "CCL", "RBLX", "SNAP"];
const DT_FORECAST_UNIVERSE = new Set(DT_UNIVERSE);
let dtThrottleUntil = 0; // if the free data source starts refusing, drop to the first 50 stocks for 10 minutes
const dtTally = () => ({ n: 0, wins: 0, gw: 0, gl: 0, sq: 0, longs: 0, shorts: 0, longPnl: 0, shortPnl: 0, costs: 0, traded: 0, Rsum: 0, held: 0, kinds: {} });
// Signal scorecard: scheduled open-to-horizon-close move in normalized range units, after modeled costs.
const dtShadow = () => ({ all: { n: 0, sum: 0, sq: 0 }, qual: { n: 0, sum: 0, sq: 0 }, since: Date.now() });
const dtFresh = () => ({ v: 1, resetId: BOT_RESET_ID, run: 1, runs: [], start: Date.now(), cash: DT_START, positions: {}, orders: [], trades: [], equity: [], intraday: [], spx0: null, firstTrade: null, day: null, lastBar: {}, reversalLastBar: {}, tally: dtTally(), shadow: dtShadow(), daily: [], brain: DTB.fresh(), executionHorizon: DT_HOLD, executionSince: Date.now(), pend: {}, entries: {}, updated: Date.now() });
async function dtResetCheck() {
  if (DT.resetId === BOT_RESET_ID) return false;
  const runs = DT.runs || [], busy = DT.firstTrade || DT.trades.length;
  if (busy) {
    const last = DT.equity.at(-1);
    const v = last?.v ?? (DT.cash + Object.values(DT.positions).reduce((sum, p) => sum + (p.dir === "long" ? 1 : -1) * p.shares * p.entry, 0));
    const vals = [DT_START, ...DT.equity.map((p) => p.v), v];
    const rec = { run: DT.run || 1, start: DT.firstTrade || DT.start, end: Date.now(), startValue: DT_START, endValue: +v.toFixed(2), peak: +Math.max(...vals).toFixed(2), low: +Math.min(...vals).toFixed(2),
      trades: DT.tally?.n || 0, days: DT.equity.length, spxRet: DT.spx0 && last?.spx ? +((last.spx / DT.spx0 - 1) * 100).toFixed(2) : null, strategy: DT.strategy, busted: false, reason: "Paper execution audit — restarted at $30,000",
      marked: last ? "last recorded value" : "cost basis (no recorded value)" };
    await archivePush("day", { ...rec, tally: DT.tally, daily: DT.daily, equity: DT.equity, tradeLog: DT.trades, model: DTB.scorecard(DT.brain) });
    runs.unshift(rec);
  }
  DT = { ...dtFresh(), run: busy ? (DT.run || 1) + 1 : DT.run || 1, runs, brain: DT.executionHorizon === DT_HOLD ? DT.brain : DTB.fresh() };
  return true;
}
let DT = dtFresh(), dtLoaded = false, dtBusy = false, dtLoading = null, dtUnsaved = false;
const dtPx = {}, dtSeq = { n: 0 };
function dtLoad() {
  if (!dtLoading) dtLoading = dtRead().catch((error) => { dtLoading = null; throw error; });
  return dtLoading;
}
async function dtRead() {
  let local, remote;
  try { local = JSON.parse(fs.readFileSync(DT_FILE, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") diagErr("day", "Local Day Trader snapshot could not be read"); }
  if (UP_URL && UP_TOKEN) {
    const r = await fetch(`${UP_URL}/get/${DT_KEY}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!r.ok || !Object.hasOwn(j, "result")) throw new Error("Day Trader state could not be loaded");
    if (j.result != null) remote = JSON.parse(j.result);
  }
  const useLocal = local && (!remote || +(local.updated || 0) > +(remote.updated || 0));
  const raw = useLocal ? local : remote;
  if (raw) DT = { ...dtFresh(), ...raw, resetId: raw.resetId, executionHorizon: raw.executionHorizon ?? 1 };
  DT.brain = DTB.fix(DT.brain); DT.pend = DT.pend || {}; DT.entries = DT.entries || {};
  const c1 = await dtResetCheck(), c2 = await dtVersionCheck(), c3 = dtFixExecution();
  const migrated = dtSplitEntries();
  if (c1 || c2 || c3 || migrated || (useLocal && UP_URL && UP_TOKEN)) await dtSave();
  dtLoaded = true;
}
function dtSplitEntries() {
  let migrated = false;
  for (const [sym, old] of Object.entries(DT.pend)) {
    if (!Object.hasOwn(old, "idea")) continue;
    const { idea, approval, ...research } = old;
    DT.pend[sym] = research;
    migrated = true;
  }
  return migrated;
}
function dtFixExecution() {
  if (DT.executionHorizon === DT_HOLD) return false;
  DT.legacyResearch = { horizon: DT.executionHorizon, shadow: DT.shadow, model: DTB.scorecard(DT.brain) };
  DT.executionHorizon = DT_HOLD;
  DT.executionSince = Date.now();
  DT.shadow = dtShadow();
  DT.brain = DTB.fresh();
  DT.pend = {};
  DT.entries = {};
  if (DT.day) Object.assign(DT.day, { forecasts: 0, qualified: 0, vetoed: 0, queued: 0, expired: 0, best: null });
  return true;
}
// Strategy registry: a new day-trader version archives the current run (tally, daily aggregates, kept trades) and starts
// a new one. The forecaster's learned weights carry over (they are research, not account state).
async function dtVersionCheck() {
  if (!RISK.versionChanged(DT.strategy, STRATS.day)) return false;
  if (DT.strategy?.id === STRATS.day.id && [2, 3, 4].includes(DT.strategy.version) && STRATS.day.version === 5) {
    if (DT.strategy.version < 4) DT.entries = {};
    DT.strategy = { id: STRATS.day.id, version: STRATS.day.version, since: Date.now() };
    return true;
  }
  const busy = DT.firstTrade || (DT.trades && DT.trades.length);
  if (busy) {
    const last = (DT.equity || [])[DT.equity.length - 1], v = last && last.v > 0 ? last.v : DT.cash, vals = [DT_START, ...(DT.equity || []).map((p) => p.v), v];
    const rec = { run: DT.run || 1, start: DT.firstTrade || DT.start, end: Date.now(), startValue: DT_START, endValue: +v.toFixed(2), peak: +Math.max(...vals).toFixed(2), low: +Math.min(...vals).toFixed(2), trades: DT.tally ? DT.tally.n || 0 : 0, days: (DT.equity || []).length,
      spxRet: DT.spx0 && last && last.spx ? +((last.spx / DT.spx0 - 1) * 100).toFixed(2) : null, busted: false, strategy: DT.strategy || { id: "alex-intraday", version: 1, note: "before the strategy registry: every stock every minute, 10× leverage" }, reason: `Strategy change → v${STRATS.day.version}` };
    await archivePush("day", { ...rec, tally: DT.tally, daily: DT.daily || [], equity: DT.equity, tradeLog: DT.trades, model: DTB.scorecard(DT.brain) });
    DT = { ...dtFresh(), run: (DT.run || 1) + 1, runs: [rec, ...(DT.runs || [])], brain: DT.brain };
  }
  DT.shadow = DT.shadow || dtShadow(); DT.daily = DT.daily || [];
  DT.strategy = { id: STRATS.day.id, version: STRATS.day.version, since: Date.now() };
  return true;
}
async function dtSave() {
  dtUnsaved = true;
  DT.updated = Date.now(); const body = JSON.stringify(DT);
  try { fs.writeFileSync(DT_FILE + ".tmp", body); fs.renameSync(DT_FILE + ".tmp", DT_FILE); }
  catch (error) { if (!UP_URL || !UP_TOKEN) throw error; }
  if (UP_URL && UP_TOKEN) {
    const r = await fetch(`${UP_URL}/set/${DT_KEY}`, { method: "POST", headers: { Authorization: `Bearer ${UP_TOKEN}` }, body, signal: AbortSignal.timeout(8000) });
    if (!r.ok || (await r.json()).result !== "OK") throw new Error("Day Trader state could not be saved");
  }
  dtUnsaved = false;
}
async function dtBars(sym) {
  return cached("dtb:" + sym, 50e3, async () => {
    const requestedAt = Date.now();
    const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m&includePrePost=true`, "application/json"));
    const r = j.chart && j.chart.result && j.chart.result[0];
    const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
    if (!q || !r.timestamp || !r.timestamp.length) throw new Error("no bars");
    const first = r.timestamp[0], et = etParts(new Date(first * 1000)), start = first - et.min * 60;
    const bars = new Map();
    for (let i = 0; i < r.timestamp.length; i++) {
      const t = r.timestamp[i], m = (t - start) / 60;
      const bar = { t, m, d: et.day, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] || 0 };
      // A cached response cannot turn a partial bar into a sealed bar when its minute ends.
      if (DTC.validMinuteBar(bar) && (t + 60) * 1000 <= requestedAt) bars.set(t, bar);
    }
    if (!bars.size) throw new Error("no completed bars");
    return [...bars.values()].sort((a, b) => a.t - b.t);
  });
}
async function dtPrev(sym, today) {
  return cached(`dtp:${sym}:${today}`, 12 * 3600e3, async () => {
    const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, "application/json"));
    const r = j.chart.result[0], q = r.indicators.quote[0];
    const rows = r.timestamp.map((t, i) => ({ d: etParts(new Date(t * 1000)).day, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter((x) => x.c != null && x.d < today);
    return rows[rows.length - 1] || null;
  });
}
const dtEquity = () => DT.cash + Object.entries(DT.positions).reduce((a, [s, p]) => a + (p.dir === "long" ? 1 : -1) * p.shares * (dtPx[s] || p.entry), 0);
function dtLog(x) { DT.trades.unshift({ id: ++dtSeq.n + "-" + Date.now(), t: x.t || Date.now(), ...x, after: +dtEquity().toFixed(2) }); DT.trades = DT.trades.slice(0, 5000); }
function dtExit(sym, px, why, t) {
  const p = DT.positions[sym]; if (!p) return;
  const cost = p.shares * px * (p.costPerSide ?? DT_LEGACY_COST), gross = DTC.pnlOf(p, px), pnl = gross - cost - (p.cost0 || 0), R = pnl / (Math.abs(p.entry - p.stop0) * p.shares);
  DT.cash += (p.dir === "long" ? 1 : -1) * p.shares * px - cost; delete DT.positions[sym]; dtPx[sym] = px;
  if (DT.day) { DT.day.pnl += pnl; DT.day.closed = (DT.day.closed || 0) + 1; }
  const T = DT.tally || (DT.tally = dtTally()), held = Math.max(1, Math.round(((t ? t * 1000 : Date.now()) - p.at) / 60000));
  T.n++; T.sq = (T.sq || 0) + pnl * pnl; if (pnl > 0) { T.wins++; T.gw += pnl; } else T.gl -= pnl; T.costs += cost + (p.cost0 || 0); T.traded += p.shares * (px + p.entry); T.Rsum += R; T.held += held;
  if (p.dir === "long") { T.longs++; T.longPnl += pnl; } else { T.shorts++; T.shortPnl += pnl; }
  const k = (T.kinds[p.kind || "other"] = T.kinds[p.kind || "other"] || { n: 0, wins: 0, pnl: 0 }); k.n++; if (pnl > 0) k.wins++; k.pnl += pnl;
  dtLog({ t: t ? t * 1000 : Date.now(), side: p.dir === "long" ? "SELL" : "COVER", sym, shares: p.shares, price: +px.toFixed(2), amount: +(p.shares * px).toFixed(2), setup: p.setup, why, pnl: +pnl.toFixed(2), pnlPct: +(pnl / (p.entry * p.shares)).toFixed(5), R: +R.toFixed(2), held, cost: +(cost + (p.cost0 || 0)).toFixed(2), entry: p.entry, dir: p.dir });
}
const DT_KIND = { "vwap-reclaim": "ETF VWAP reversal", "momentum-confirmed": "Confirmed momentum", momentum: "Momentum", reversion: "VWAP snap-back", flow: "Candle pressure (OHLC proxy)", levels: "Liquidity levels", relative: "Relative strength", tape: "Market tape", research: "News & research", spider: "Spider research", consensus: "Bot consensus",
  pullback: "Trend pullback", burst: "Momentum burst", stretch: "VWAP snap-back", momentum: "1-minute momentum", "research-long": "News & research (bullish)", "research-short": "News & research (bearish)" };
// ---- research for the day trader: the same inputs the swing bot uses, refreshed every 10 minutes ----
// For each stock: news headlines (the five outlets, trending, Smart Money, its own Yahoo feed), earnings (beat or miss
// in the last few days, or reporting today/tomorrow), analyst ratings, its 50- and 200-day trend and how it's doing
// today against the S&P 500; plus the whole market's mood (S&P today, VIX fear index, S&P vs its 200-day average).
// Becomes a lean from −1 (bearish) to +1 (bullish) with the reasons attached.
// Every other section of the site is read here too: Financials (health grade from SEC filings), THE WEB Spider's
// findings, the swing bot's ranking, the Quant trader's ranking and regime, the Heatmap's sector moves, and the Macro
// page (yield curve, Sahm rule). The brain (daytrade-brain.js) learns how much each one is worth minute by minute.
let DTR = { t: 0, by: {}, market: null }, dtrBusy = false;
const DTP = {}; // prior-day bar per stock (for liquidity levels and gaps)
const DT_SECTOR_ETF = { "Information Technology": "XLK", Financials: "XLF", "Health Care": "XLV", Energy: "XLE", Industrials: "XLI", "Consumer Discretionary": "XLY", "Consumer Staples": "XLP", Utilities: "XLU", Materials: "XLB", "Communication Services": "XLC", "Real Estate": "XLRE" };
const DT_SECTOR_EXTRA = { COIN: "XLF", HOOD: "XLF", SOFI: "XLF", XYZ: "XLF", ARM: "SMH", TSM: "SMH", ASML: "SMH", MRVL: "SMH", SMCI: "SMH", MU: "SMH", SHOP: "XLK", SNOW: "XLK", NET: "XLK", DDOG: "XLK", ZS: "XLK", MDB: "XLK", TEAM: "XLK", MSTR: "XLK", MARA: "XLK", RBLX: "XLC", SNAP: "XLC", RIVN: "XLY", LCID: "XLY", NIO: "XLY", DKNG: "XLY", UBER: "XLI", PLTR: "XLK" };
const dtSectorEtf = (sym) => DT_SECTOR_EXTRA[sym] || (() => { const r = SP500.find((x) => x[0] === sym || x[0] === sym.replace("-", ".")); return r ? DT_SECTOR_ETF[r[2]] : null; })();
const DT_REGIME = { "Risk-on trend": 0.4, "Choppy / late-cycle": 0, Correction: -0.4, "Risk-off / high volatility": -0.8 };
const DT_GRADE = { A: 1, B: 0.5, C: 0, D: -0.5, F: -1 };
// Quant Lab factor analysis for all 100 stocks, once a day from a year of daily closes (DTB.quantScores, qmath.js math)
let DTQ = { day: null, by: {}, t: 0 };
const DT_QF = { mom12: "12-1 month momentum", residual: "residual momentum vs the S&P", mom3: "3-month momentum", lowvol: "low volatility", trend: "200-day trend", reversal: "short-term reversal", sharpe: "6-month Sharpe ratio" };
async function dtResearch() {
  if (dtrBusy) return; dtrBusy = true;
  try {
    const t = etParts(), cal = await apEarnings();
    const etfs = [...new Set([...Object.values(DT_SECTOR_ETF), "SMH"])];
    const q = (await getQuotes([...DT_UNIVERSE, ...etfs, "SPY", "^VIX", "^GSPC"])).quotes, spyDay = (q.SPY && q.SPY.changePct) || 0;
    const vix = q["^VIX"] && !q["^VIX"].error ? q["^VIX"].price : null;
    let below200 = false; try { const h = await history("^GSPC", "1y"); const cl = h.candles.map((c) => c.close); below200 = cl[cl.length - 1] < sma(cl, 200); } catch {}
    const pcb = pcBrief(), pcLean = PCC.marketLean(pcb); // Zweig put/call: crowd heavy in puts → lean long, heavy in calls → lean short
    const mk = clamp(spyDay / 1.5, -1, 1) * 0.6 + (vix != null ? (vix >= 30 ? -0.4 : vix >= 22 ? -0.2 : vix <= 14 ? 0.1 : 0) : 0) + (below200 ? -0.15 : 0.05) + pcLean;
    // the rest of the site's view of the market: Quant regime, swing-bot defense mode, Spider stress, Macro page
    const qd = QT && QT.decisions && QT.decisions[0], qReg = qd ? qd.regime : null;
    let spStress = null; try { const tv = SPIDER ? SPIDER.traderView() : null; spStress = tv && tv.stress ? tv.stress : null; } catch {}
    const mac = cache.get("macro:all"); if (!mac || !mac.data) macroData().catch(() => {});
    const lastOf = (id) => { const se = mac && mac.data && mac.data.series ? mac.data.series.find((x) => x.id === id) : null, r = se && se.data && se.data[se.data.length - 1]; return r == null ? null : Array.isArray(r) ? r[1] : r.v != null ? r.v : null; };
    const curve = lastOf("T10Y3M"), sahm = lastOf("SAHMREALTIME");
    const stress = (apSig && apSig.stress) || spStress || (vix != null && vix >= 30 ? `VIX at ${vix.toFixed(1)}` : null);
    const regime = clamp(0.55 * clamp(mk, -1, 1) + 0.25 * (DT_REGIME[qReg] || 0) + (apSig && apSig.riskOff ? -0.1 : 0) + (stress ? -0.2 : 0) + (curve != null && curve < 0 ? -0.05 : 0) + (sahm != null && sahm >= 0.5 ? -0.15 : 0), -1, 1);
    const market = { lean: clamp(mk, -1, 1), spyDay, vix, below200, regime: +regime.toFixed(3), quantRegime: qReg, swingRiskOff: !!(apSig && apSig.riskOff), stress: stress || null, curve, sahm, putcall: pcb.ok ? { score: pcb.score, ma10: pcb.ma10, zone: pcb.zone, signal: pcb.signal, lean: pcLean } : null };
    // the swing bot's latest ranking, as a percentile among the stocks it has scored
    const swVals = Object.values(apScoreOf).filter(isFinite).sort((a, b) => a - b);
    const swPct = (sym) => { const v = apScoreOf[sym]; if (v == null || swVals.length < 10) return 0; return (swVals.filter((x) => x <= v).length / swVals.length - 0.5) * 2; };
    const qRank = qd && Array.isArray(qd.ranked) ? Object.fromEntries(qd.ranked.map((x) => [x.s, x])) : {}, qTarget = (qd && qd.target) || {};
    const own = [...DT_UNIVERSE.filter((s) => !/^(SPY|QQQ|IWM|DIA)$/.test(s)).slice(0, 24), ...Object.keys(DT.positions).slice(0, 8)];
    const news = await apNewsPool([...new Set(own)]);
    if (DTQ.day !== t.day) { // daily: the Quant Lab's factor analysis across the whole universe
      const qc = {}; for (const sym of DT_UNIVERSE) { try { const h = await history(sym, "1y"); qc[sym] = h.candles.map((c) => c.close).filter((x) => x > 0); } catch {} }
      const sc = DTB.quantScores(qc, qc.SPY); if (Object.keys(sc).length >= 20) DTQ = { day: t.day, by: sc, t: Date.now() };
    }
    const by = {};
    for (const sym of DT_UNIVERSE) {
      let base = apBase.get(sym); if (!base || base.day !== t.day) { try { base = await apBaseFor(sym, t.day); await new Promise((r) => setTimeout(r, 120)); } catch { base = null; } }
      const qq = q[sym], px = qq && !qq.error && qq.price ? qq.price : base && base.last, day = qq && !qq.error ? qq.changePct || 0 : 0;
      const n = base ? apNewsFor(sym, base.re, news.pool) : { score: 0, top: [] };
      const earn = apEarnFor(sym, cal, t.day);
      const r = BB.ratings[sym.replace("-", ".")], adj = r && r.n >= BB_MIN_N ? bbAdj(r) : null;
      const trend = base && px ? (px > base.m50 ? 0.5 : -0.5) + (px > base.m200 ? 0.5 : -0.5) : 0;
      const parts = [], add = (w, v, label) => { if (v) parts.push({ w, v, label }); };
      add(0.35, clamp(n.score / 2.5, -1, 1), n.top[0] ? `${n.score > 0 ? "good" : "bad"} news: “${n.top[0].slice(0, 80)}”` : null);
      if (earn && (earn.kind === "beat" || earn.kind === "miss")) add(0.3, earn.kind === "beat" ? 1 : -1, `earnings ${earn.kind} by ${Math.abs(earn.surprise * 100).toFixed(0)}%`);
      add(0.1, adj != null ? clamp(adj / 1.5, -1, 1) : 0, adj != null ? `analysts ${adj >= 1 ? "strongly positive" : adj >= 0.4 ? "positive" : adj <= -0.2 ? "negative" : "mixed"}` : null);
      add(0.1, trend, base ? (trend > 0 ? "above its 50- & 200-day averages" : trend < 0 ? "below its 50- & 200-day averages" : "mixed long-term trend") : null);
      add(0.15, clamp((day - spyDay) / 3, -1, 1), Math.abs(day - spyDay) >= 1 ? `${day - spyDay >= 0 ? "beating" : "lagging"} the S&P today (${day >= 0 ? "+" : ""}${day.toFixed(1)}%)` : null);
      const hg = AP_HEALTH.get(sym); if (hg && hg.grade) add(0.1, DT_GRADE[hg.grade] || 0, `financial health grade ${hg.grade} (SEC filings)`);
      // other sections, kept as their own inputs so the brain can weigh each one separately
      let spider = 0, spiderWhy = null; try { const sg = SPIDER ? SPIDER.signal(sym, { trader: true }) : null; if (sg && sg.n) { spider = clamp(sg.score * sg.conf * 2, -1, 1); spiderWhy = sg.reasons[0] ? sg.reasons[0].replace(/^[▲▼] /, "") : null; } } catch {}
      // quant: the factor analysis (65%) plus the Quant trader's own ranking and holdings where it covers the stock (35%)
      const swing = swPct(sym), qr = qRank[sym], qf = DTQ.by[sym], qt = qr ? clamp(qr.score / 2 + (qTarget[sym] > 0 ? 0.3 : 0), -1, 1) : 0;
      const quant = clamp((qf ? 0.65 * qf.score : 0) + (qr ? 0.35 * qt : 0) / (qf ? 1 : 0.35), -1, 1);
      const quantWhy = qf && Math.abs(qf.score) >= 0.2 && qf.lead ? `quant: ${qf.z[qf.lead] >= 0 ? "strong" : "weak"} ${DT_QF[qf.lead]} (z ${qf.z[qf.lead] >= 0 ? "+" : ""}${qf.z[qf.lead]})` : null;
      const etf = /^(SPY|QQQ|IWM|DIA)$/.test(sym) ? null : dtSectorEtf(sym), secDay = etf && q[etf] && !q[etf].error ? q[etf].changePct : null;
      const sector = secDay != null ? clamp((secDay - spyDay) / 1.5, -1, 1) : 0;
      const research = clamp(parts.reduce((a, x) => a + x.w * x.v, 0), -1, 1), lean = clamp(research + 0.2 * market.lean, -1, 1);
      if (quantWhy) parts.push({ w: 1, v: quant * 0.15, label: quantWhy });
      if (Math.abs(spider) >= 0.15 && spiderWhy) parts.push({ w: 1, v: spider * 0.2, label: `Spider: ${spiderWhy.slice(0, 80)}` });
      const reasons = parts.filter((x) => x.label && Math.abs(x.w * x.v) >= 0.03).sort((a, b) => Math.abs(b.w * b.v) - Math.abs(a.w * a.v)).map((x) => x.label);
      const catalyst = earn && earn.kind === "beat" ? 1 : earn && earn.kind === "miss" ? -1 : Math.abs(n.score) >= 1.5 ? Math.sign(n.score) : 0;
      if (!DTP[sym] || DTP[sym].d !== t.day) { try { DTP[sym] = { d: t.day, v: await dtPrev(sym, t.day) }; } catch { DTP[sym] = { d: t.day, v: null }; } }
      by[sym] = { lean: +lean.toFixed(3), research: +research.toFixed(3), spider: +spider.toFixed(3), swing: +swing.toFixed(3), quant: +quant.toFixed(3), sector: +sector.toFixed(3), sectorEtf: etf, catalyst, grade: hg && hg.grade ? hg.grade : null,
        reasons: reasons.slice(0, 3), news: +n.score.toFixed(2), headline: n.top[0] || null, earn, adj: adj == null ? null : +adj.toFixed(2), trend, day: +day.toFixed(2), soon: !!(earn && earn.kind === "soon") };
    }
    DTR = { t: Date.now(), day: t.day, by, market };
    BOTDIAG.day.research = { t: DTR.t, n: Object.keys(by).length };
  } catch (e) { diagErr("day", "research: " + (e.message || e)); } finally { dtrBusy = false; }
}
function dtDecide(bars, sym, ctx, day) {
  const research = DTR.day === day && Date.now() - DTR.t <= 15 * 60e3 ? DTR : null;
  const info = research?.by[sym], market = research?.market;
  const b = bars[bars.length - 1];
  const f = DTB.features(bars, { spy: ctx.spy, breadth: ctx.breadth(b.t), prev: DTP[sym]?.d === day ? DTP[sym].v : null, info, market: market?.regime || 0 });
  if (!f) return null;
  const d = DTB.decide(DT.brain, f, { mom: f.x[0] });
  const short = d.dir === "short", side = short ? -1 : 1;
  const a = f.a * Math.sqrt(DT_HOLD);
  const qual = RISK.netEdge({ mu: d.mu, atrPct: a / f.c, costPerSide: DT_COST, borrow: DT_FEE_SHORT, short, bufferX: DT_PARAMS.bufferX });
  return { day, a, x: f.x, mu: d.mu, side, qualified: qual.ok,
    moveBps: Math.abs(d.mu) * a / f.c * 1e4, hurdleBps: (qual.cost + qual.buffer) * a / f.c * 1e4 };
}
// Gross and net exposure of the open book right now.
function dtBook() { let gross = 0, net = 0; for (const [s, p] of Object.entries(DT.positions)) { const v = p.shares * (dtPx[s] || p.entry); gross += v; net += (p.dir === "long" ? 1 : -1) * v; } return { gross, net }; }
function dtHalted() {
  if (!DT.day.halted && RISK.dailyLossHit(dtEquity() - DT.day.startEq, DT.day.startEq, DT_PARAMS.dailyLoss)) {
    DT.day.halted = true;
    DT.day.haltedAt = Date.now();
    diagErr("day", `daily loss limit hit (${(DT_PARAMS.dailyLoss * 100).toFixed(0)}%) — no new trades today`);
  }
  return DT.day.halted;
}
function dtPilotRoom() {
  const queued = Object.values(DT.entries).reduce((risk, order) =>
    risk + (order.approval?.pilot ? order.approval.riskPerShare * order.approval.shares : 0), 0);
  return DT_PILOT.sessionRisk - (DT.day.reversalRiskUsed || 0) - queued;
}
function dtOpen(sym, forecast, bar, observedAt) {
  const { idea } = forecast, fill = DP.openPullback(forecast, bar, { now: observedAt, maxLagSec: DT_PARAMS.maxBarLagSec });
  if (!fill || DT.positions[sym] || dtHalted()) return;
  const eq = dtEquity(), px = fill.entry;
  if (eq <= 0) return;
  const want = DTC.size(eq, px, fill.stop, DT_PARAMS.riskPct * (idea.sizeX ?? 1), DT_POS_X * eq);
  if (!forecast.approval?.pilot || forecast.approval.at >= bar.t * 1000) return;
  const riskPerShare = Math.abs(px - fill.stop) + px * (2 * DT_COST + (idea.dir === "short" ? DT_FEE_SHORT : 0));
  const plannedRisk = forecast.approval.shares * forecast.approval.riskPerShare;
  const limited = DTB.guard(want, px, idea.dir, dtBook(), eq, { grossCap: DT_LEV, netCap: idea.stressed ? DT_NET / 2 : DT_NET });
  const request = Math.floor(Math.min(limited, forecast.approval.shares, plannedRisk / riskPerShare));
  if (request < 1) return;
  const ticket = deskRisk.reserve({ bot: "day", sym, sign: forecast.side, shares: request, price: px, riskPerShare,
    integer: true, pilotRoom: dtPilotRoom() });
  const shares = ticket.shares;
  if (shares < 1) {
    BOTDIAG.day.desk = ticket.reason;
    return;
  }
  DT.day.reversalRiskUsed = (DT.day.reversalRiskUsed || 0) + shares * riskPerShare;
  const counter = idea.kind === "momentum-confirmed" ? "momentumEntries" : "reversalEntries";
  DT.day[counter] = (DT.day[counter] || 0) + 1;
  const cost0 = shares * px * (DT_COST + (idea.dir === "short" ? DT_FEE_SHORT : 0));
  dtPx[sym] = px;
  DT.positions[sym] = { dir: idea.dir, shares, ...fill, stop0: fill.stop, setup: DT_KIND[idea.kind], kind: idea.kind, why: idea.why, cost0, costPerSide: DT_COST, hold: DT_HOLD, bars: 0 };
  ticket.release();
  DT.cash += forecast.side * -shares * px - cost0;
  DT.day.trades++;
  if (!DT.firstTrade) DT.firstTrade = fill.at;
  dtLog({ t: fill.at, decisionAt: forecast.decisionAt, decisionPrice: forecast.decisionPrice, fillReferencePrice: px, modeledCostBps: DT_COST * 1e4, side: idea.dir === "long" ? "BUY" : "SHORT", sym, shares, price: +px.toFixed(2), amount: +(shares * px).toFixed(2), setup: DT_KIND[idea.kind], why: idea.why, stop: +fill.stop.toFixed(2), target: +fill.target.toFixed(2), cost: +cost0.toFixed(2), dir: idea.dir,
    strategyVersion: STRATS.day.version });
}
function dtScore(forecast, bar, day) {
  const move = (bar.c - forecast.opening) / forecast.a;
  DTB.learn(DT.brain, forecast.x, move, day, forecast.mu);
  const costs = (forecast.opening * (DT_COST + (forecast.side < 0 ? DT_FEE_SHORT : 0)) + bar.c * DT_COST) / forecast.a;
  const net = forecast.side * move - costs;
  const shadow = DT.shadow;
  shadow.all.n++; shadow.all.sum += net; shadow.all.sq += net * net;
  if (forecast.qualified) { shadow.qual.n++; shadow.qual.sum += net; shadow.qual.sq += net * net; }
}
function dtSettle(minute, day) {
  // All entries at a given opening print are sized before any same-minute exits.
  for (const { sym, bar, observedAt } of minute) {
    const order = DT.entries[sym];
    if (order?.fillAt === bar.t) {
      delete DT.entries[sym];
      const before = DT.day.trades;
      dtOpen(sym, order, bar, observedAt);
      if (before === DT.day.trades) DT.day.expired = (DT.day.expired || 0) + 1;
    }
    const f = DT.pend[sym];
    if (f && f.fillAt === bar.t && f.opening == null) f.opening = bar.o;
  }
  for (const { sym, bar } of minute) {
    const p = DT.positions[sym];
    if (p) {
      const ex = DTC.managePaperPosition(p, bar, p.hold ?? 1);
      if (ex) dtExit(sym, ex.px, ex.why, ex.t);
      if (bar.t * 1000 >= p.at) dtPx[sym] = bar.c;
      dtHalted();
    }
    const f = DT.pend[sym];
    if (f && f.evalAt === bar.t && f.opening != null) {
      dtScore(f, bar, day);
      delete DT.pend[sym];
    }
  }
  DTB.step(DT.brain);
}
async function dtTick() {
  if (dtBusy) return; dtBusy = true;
  try {
    if (!dtLoaded) await dtLoad();
    if (dtUnsaved) await dtSave(); // retry the complete state before processing another bar
    const m = process.env.AP_TEST ? { open: true, t: { ...etParts(), wd: "Tue", min: 11 * 60 } } : await apMarketOpen();
    const t = m.t, close = NYSE_EARLY.has(t.day) ? 13 * 60 : DTC.CLOSE;
    const afterClose = t.min >= close;
    const unsettled = Object.keys(DT.pend).length || Object.keys(DT.entries).length;
    const volumeSymbols = process.env.AP_TEST ? [] : dayVolume.symbols();
    const settling = !m.open && afterClose && t.min <= close + 2 && DT.day?.d === t.day &&
      (unsettled || Object.keys(DT.positions).length || volumeSymbols.length);
    if (!m.open && !settling) {
      if (unsettled && (afterClose || DT.day?.d !== t.day)) {
        DT.pend = {};
        DT.entries = {};
        await dtSave();
      }
      return;
    }
    if (m.open && Date.now() - DTR.t > 10 * 60e3) dtResearch();
    if (!DT.day || DT.day.d !== t.day) {
      if (DT.day && DT.day.d) {
        DT.daily = DT.daily || [];
        DT.daily.push({ ...DT.day, endEq: +dtEquity().toFixed(2) });
        DT.daily = DT.daily.slice(-400);
      }
      DT.day = { d: t.day, startEq: dtEquity(), pnl: 0, trades: 0, closed: 0, forecasts: 0, qualified: 0, halted: false };
      DT.pend = {};
      DT.entries = {};
      DT.lastBar = {};
      DT.reversalLastBar = {};
    }
    dtHalted();
    if (!DT.tally) DT.tally = dtTally();
    const uni = m.open ? (Date.now() < dtThrottleUntil ? DT_UNIVERSE.slice(0, 50) : DT_UNIVERSE) : [];
    const syms = [...new Set([...Object.keys(DT.positions), ...Object.keys(DT.entries), ...(m.open ? DP.PULLBACK.universe : []), ...uni, ...Object.keys(DT.pend), ...volumeSymbols])];
    BOTDIAG.day.scans++; BOTDIAG.day.lastOpenTick = Date.now(); BOTDIAG.day.universe = uni.length;
    let fails = 0;
    const one = async (sym) => {
      try {
        const bars = await dtBars(sym);
        BOTDIAG.day.barsOk++;
        return [sym, bars.filter((b) => b.d === t.day && b.m < close), Date.now()];
      } catch (e) {
        fails++; BOTDIAG.day.barsFail++; diagErr("day", `${sym}: ${e.message || e}`);
        return [sym, [], Date.now()];
      }
    };
    const all = [];
    for (let i = 0; i < syms.length; i += 8) all.push(...(await Promise.all(syms.slice(i, i + 8).map(one))));
    if (!process.env.AP_TEST) {
      const prior = Object.fromEntries(Object.entries(DTP).filter(([, row]) => row.d === t.day && row.v).map(([sym, row]) => [sym, row.v]));
      strategyLab.onMinute(all, t.day, close, prior).catch(() => {});
    }
    if (fails > syms.length * 0.2) { dtThrottleUntil = Date.now() + 10 * 60e3; diagErr("day", `data source refused ${fails} of ${syms.length} requests — scanning the first 50 stocks for 10 minutes`); }
    const byMinute = new Map(), latest = new Map();
    const spyBars = (all.find(([s]) => s === "SPY") || [])[1] || [];
    const ctx = { spy: new Map(spyBars.filter((b) => b.m >= DTC.OPEN).map((b) => [b.t, b.c])),
      breadth: DTB.breadthMap(all.filter(([sym]) => DT_FORECAST_UNIVERSE.has(sym))) };
    for (const [sym, bars, observedAt] of all) {
      const session = bars.filter((b) => b.m >= DTC.OPEN), last = session.at(-1);
      if (last && DTC.paperBarReady(last, observedAt, DT_PARAMS.maxBarLagSec)) latest.set(sym, { bars, last });
      const position = DT.positions[sym], research = DT.pend[sym], entry = DT.entries[sym];
      if (!position && !research && !entry) continue;
      const observed = DTC.paperObservations(session, observedAt, DT_PARAMS.maxBarLagSec, { position, research, entry });
      if (observed.missedResearch) {
        delete DT.pend[sym];
        BOTDIAG.day.gaps = (BOTDIAG.day.gaps || 0) + 1;
      }
      if (observed.missedEntry) {
        delete DT.entries[sym];
        DT.day.expired = (DT.day.expired || 0) + 1;
      }
      for (const bar of observed.bars) {
        if (!byMinute.has(bar.t)) byMinute.set(bar.t, []);
        byMinute.get(bar.t).push({ sym, bar, observedAt });
      }
    }
    for (const [, events] of [...byMinute].sort((a, b) => a[0] - b[0])) dtSettle(events, t.day);

    const activeUniverse = new Set(uni), drafted = [], setups = [];
    for (const [sym, { bars, last }] of latest) {
      dtPx[sym] = last.c;
      if (!m.open || DT.entries[sym] || DT.positions[sym]) continue;
      let reversal = null;
      if (DP.PULLBACK.universe.includes(sym) && last.t > (DT.reversalLastBar[sym] || 0)) {
        DT.reversalLastBar[sym] = last.t;
        DT.day.reversalChecks = (DT.day.reversalChecks || 0) + 1;
        reversal = DP.findPullback(sym, bars, { day: t.day, now: Date.now(), close, maxLagSec: DT_PARAMS.maxBarLagSec,
          costPerSide: DT_COST, shortBorrow: DT_FEE_SHORT });
        if (reversal) {
          setups.push({ sym, last, idea: reversal, kind: "reversal" });
          DT.day.reversalSignals = (DT.day.reversalSignals || 0) + 1;
        }
      }
      if (!activeUniverse.has(sym) || last.t <= (DT.lastBar[sym] || 0)) continue;
      const forecast = dtDecide(bars, sym, ctx, t.day);
      if (!forecast) continue;
      drafted.push({ sym, last, forecast });
      if (!reversal) {
        const options = { day: t.day, now: Date.now(), close, maxLagSec: DT_PARAMS.maxBarLagSec, costPerSide: DT_COST, shortBorrow: DT_FEE_SHORT };
        const idea = DP.findMomentum(bars, forecast, options) || DP.findPriceMomentum(bars, options);
        if (idea) {
          setups.push({ sym, last, idea, kind: "momentum" });
          DT.day.momentumSignals = (DT.day.momentumSignals || 0) + 1;
        }
      }
    }
    if (!process.env.AP_TEST) dayVolume.observe({ series: all, candidates: drafted, day: t.day, close, now: Date.now(),
      maxLagSec: DT_PARAMS.maxBarLagSec });
    for (const { sym, last, forecast } of drafted) {
      const decisionAt = Date.now();
      const fillAt = DTC.paperEntryMinute(last, decisionAt, close, DT_PARAMS.maxBarLagSec, DT_HOLD);
      if (fillAt == null) continue;
      DT.lastBar[sym] = last.t;
      const betweenSamples = !!DT.pend[sym];
      if (betweenSamples) DT.day.extraForecasts = (DT.day.extraForecasts || 0) + 1;
      if (!betweenSamples) {
        const { day, a, x, mu, side, qualified } = forecast;
        DT.pend[sym] = { day, a, x, mu, side, qualified, fillAt, evalAt: fillAt + (DT_HOLD - 1) * 60 };
        DT.day.sampled = (DT.day.sampled || 0) + 1;
      }
      DT.day.forecasts++;
      if (forecast.qualified) DT.day.qualified++;
      if (!DT.day.best || forecast.moveBps / forecast.hurdleBps > DT.day.best.moveBps / DT.day.best.hurdleBps) {
        DT.day.best = { sym, moveBps: forecast.moveBps, hurdleBps: forecast.hurdleBps };
      }
    }
    if (setups.length && !dtHalted()) {
      const ranked = setups.sort((a, b) => b.idea.netTargetBps - a.idea.netTargetBps).slice(0, 6);
      await deskRisk.prepare(ranked.map(({ sym }) => sym));
      for (const { sym, last, idea, kind } of ranked) {
        if (CO.paused(OWNER, "day") || CO.blocked(OWNER, "day", sym) || (idea.side < 0 && CO.noShorts(OWNER, "day"))) { DT.day.ownerSkipped = (DT.day.ownerSkipped || 0) + 1; continue; }
        if (CA.setupPaused(COACH_PLAN, "day", DT_KIND[idea.kind] || DT_KIND[kind] || kind) || CA.blocked(COACH_PLAN, "day", sym)) { DT.day.coachSkipped = (DT.day.coachSkipped || 0) + 1; continue; }
        const decisionAt = Date.now(), side = idea.side;
        const fillAt = DTC.paperEntryMinute(last, decisionAt, close, DT_PARAMS.maxBarLagSec, DT_HOLD);
        if (fillAt == null) continue;
        const riskPerShare = idea.stopDistance + last.c * (2 * DT_COST + (side < 0 ? DT_FEE_SHORT : 0));
        const shares = Math.floor(Math.min(DTC.size(dtEquity(), last.c, idea.stop, DT_PARAMS.riskPct, DT_PILOT.entryGross) * CA.sizeFactor(COACH_PLAN, "day") * CO.sizeFactor(OWNER, "day"), CO.maxTrade(OWNER, "day") / last.c));
        const ticket = deskRisk.reserve({ bot: "day", sym, sign: side, shares, price: last.c, riskPerShare,
          integer: true, pilotRoom: dtPilotRoom() });
        if (!ticket.shares) {
          const counter = kind + "Blocked";
          DT.day[counter] = (DT.day[counter] || 0) + 1;
          BOTDIAG.day.desk = ticket.reason;
          continue;
        }
        DT.entries[sym] = { day: t.day, side, idea, decisionAt, decisionPrice: last.c, fillAt,
          approval: { at: decisionAt, shares: ticket.shares, price: last.c, riskPerShare, pilot: true } };
        ticket.release();
        const counter = kind + "Queued";
        DT.day[counter] = (DT.day[counter] || 0) + 1;
        DT.day.queued = (DT.day.queued || 0) + 1;
      }
    }
    BOTDIAG.day.model = { n: DT.brain.n, steps: DT.brain.steps };
    BOTDIAG.day.signals = DT.tally.n;
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
    // The paper challenge restarts after breaching its configured risk floor.
    if (DT.firstTrade && v < DT_PAPER_FLOOR && !Object.keys(DT.positions).length) {
      const vals = [DT_START, ...DT.equity.map((p) => p.v)];
      DT.runs.unshift({ run: DT.run, start: DT.firstTrade || DT.start, end: nowMs, startValue: DT_START, endValue: +dtEquity().toFixed(2), peak: +Math.max(...vals).toFixed(2), low: +Math.min(...vals, dtEquity()).toFixed(2), trades: DT.tally ? DT.tally.n : DT.trades.filter((x) => x.pnl != null).length, days: DT.equity.length, spxRet: DT.spx0 && spx ? +((spx / DT.spx0 - 1) * 100).toFixed(2) : null, busted: true, reason: "Paper risk floor (< $25,000)", strategy: DT.strategy || null });
      await archivePush("day", { ...DT.runs[0], tally: DT.tally, daily: DT.daily || [], equity: DT.equity, tradeLog: DT.trades, model: DTB.scorecard(DT.brain) });
      DT = { ...dtFresh(), run: DT.run + 1, runs: DT.runs, brain: DT.brain, strategy: DT.strategy }; // a new run keeps what the brain has learned
    }
    dtFixExecution();
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
  const q = (await getQuotes([...syms.filter((s) => !dtPx[s]), "^GSPC"])).quotes;
  // A position may close while the quote request is pending. Read the book once
  // after the await, and keep display-only quotes out of the execution marks.
  const positions = Object.entries(DT.positions).map(([s, p]) => {
    const price = dtPx[s] || q[s]?.price || p.entry, pnl = DTC.pnlOf(p, price);
    return { sym: s, dir: p.dir, shares: p.shares, entry: p.entry, stop: p.stop, target: p.target, price, pnl, value: p.shares * price, R: pnl / (Math.abs(p.entry - p.stop0) * p.shares), setup: p.setup, at: p.at, why: p.why, be: !!p.be };
  });
  const value = DT.cash + positions.reduce((sum, p) => sum + (p.dir === "long" ? 1 : -1) * p.value, 0);
  const open = sessionInfo().open, spxNow = q["^GSPC"] && q["^GSPC"].price;
  const vals = [DT_START, ...DT.equity.map((p) => p.v), value];
  const current = { run: DT.run, start: DT.firstTrade || DT.start, end: Date.now(), startValue: DT_START, endValue: +value.toFixed(2), peak: +Math.max(...vals).toFixed(2), low: +Math.min(...vals).toFixed(2), trades: DT.tally ? DT.tally.n : 0, days: DT.equity.length, spxRet: DT.spx0 && spxNow ? +((spxNow / DT.spx0 - 1) * 100).toFixed(2) : null, busted: false };
  const T = DT.tally || dtTally(), st = botStats(DT.trades, DT.equity, DT_START, value, DT.spx0, spxNow);
  Object.assign(st, { trades: T.n * 2, closed: T.n, winRate: T.n ? T.wins / T.n : null, avgWin: T.wins ? T.gw / T.wins : null, avgLoss: T.n - T.wins ? -T.gl / (T.n - T.wins) : null, profitFactor: T.gl > 0 ? T.gw / T.gl : null, grossWins: T.gw, grossLosses: T.gl, costs: T.costs, traded: T.traded, avgR: T.n ? T.Rsum / T.n : null, avgHold: T.n ? T.held / T.n : null, longs: T.longs, shorts: T.shorts, longPnl: T.longPnl, shortPnl: T.shortPnl,
    bySetup: Object.entries(T.kinds).map(([k, x]) => ({ setup: DT_KIND[k] || k, n: x.n, win: x.wins / x.n, pnl: x.pnl })),
    expectancy: RISK.expectancy(T.n, T.gw - T.gl, T.sq || 0), grossBeforeCosts: T.gw - T.gl + T.costs });
  const SH = DT.shadow || dtShadow(), research = { since: SH.since, unit: `${DT_HOLD}-minute scheduled open-to-close move after modeled costs, normalized to the one-minute average range × √${DT_HOLD}. Paper trades can exit earlier at their bracket`,
    allForecasts: RISK.expectancy(SH.all.n, SH.all.sum, SH.all.sq), qualified: RISK.expectancy(SH.qual.n, SH.qual.sum, SH.qual.sq) };
  return { ...DT, kind: "day", diag: { market: BOTDIAG.market, ...BOTDIAG.day }, rawPositions: DT.positions, positions, value, startValue: DT_START, bustAt: DT_PAPER_FLOOR, spxNow, marketOpen: open, current, analytics: st, universe: DT_UNIVERSE, quantFactors: { day: DTQ.day, t: DTQ.t, weights: DTB.QW, labels: DT_QF, top: Object.entries(DTQ.by).sort((a, b) => b[1].score - a[1].score).slice(0, 8).map(([s, x]) => ({ sym: s, score: +x.score.toFixed(2), lead: x.lead })), bottom: Object.entries(DTQ.by).sort((a, b) => a[1].score - b[1].score).slice(0, 8).map(([s, x]) => ({ sym: s, score: +x.score.toFixed(2), lead: x.lead })) },
    research: { t: DTR.t, market: DTR.market, top: Object.entries(DTR.by).sort((a, b) => b[1].lean - a[1].lean).filter(([, x]) => Math.abs(x.lean) >= 0.08).map(([sym, x]) => ({ sym, lean: x.lean, reasons: x.reasons, spider: x.spider, swing: x.swing, quant: x.quant, sector: x.sector, grade: x.grade })) }, durable: !!(UP_URL && UP_TOKEN),
    status: open ? (DT.day?.halted ? "Daily loss limit hit — entry pause" : `${DT.day?.reversalSignals || 0} ETF reversal setups · ${DT.day?.momentumSignals || 0} confirmed momentum setups today`) : "Market closed — returns at the opening bell; unmatched positions wait for an observed price",
    strategy: { ...STRATS.day, active: DT.strategy || null }, researchMode: research, daily: (DT.daily || []).slice(-30),
    model: DTB.scorecard(DT.brain), pend: undefined, entries: undefined, legacyShadow: undefined, legacyResearch: undefined,
    orders: Object.entries(DT.entries).map(([sym, f]) => ({ sym, dir: f.idea.dir, at: f.fillAt * 1000 })),
    rules: { maxPos: DT_UNIVERSE.length, cost: DT_COST, borrow: DT_FEE_SHORT, hold: DT_HOLD, lev: DT_LEV, net: DT_NET,
      dailyLoss: DT_PARAMS.dailyLoss, bufferX: DT_PARAMS.bufferX, reversal: DP.PULLBACK, allocation: DT_PILOT } };
}
async function dtRestore(doc) {
  if (dtBusy) return { ok: false, error: "Day Trader execution is in progress; retry later" };
  if (!doc || typeof doc !== "object" || doc.v !== 1 || typeof doc.cash !== "number" || !Array.isArray(doc.trades)) return { ok: false, error: "bad data" };
  if (doc.resetId !== BOT_RESET_ID) return { ok: false, error: "backup is from before the reset" };
  const mine = DT.trades.length + DT.runs.length * 1e4, theirs = doc.trades.length + (doc.runs || []).length * 1e4;
  if (theirs < mine || (DT.trades.length && doc.updated <= DT.updated)) return { ok: false, error: "server copy is newer" };
  dtBusy = true;
  try {
    DT = { ...dtFresh(), ...doc, executionHorizon: doc.executionHorizon ?? 1, trades: doc.trades.slice(0, 5000) };
    DT.brain = DTB.fix(DT.brain); DT.pend = {}; DT.entries = {}; dtFixExecution();
    await dtSave();
    return { ok: true };
  } finally { dtBusy = false; }
}
if (DEPLOY.runJobs) setTimeout(() => { dtTick(); setInterval(dtTick, process.env.AP_TEST ? 7000 : 60e3); }, process.env.AP_TEST ? 5000 : 75_000);

// ---------------------------------------------------------------- Quant Trader (third paper bot): systematic, uses the Quant Lab's math
// Once per trading day after the close (and once right away when the account is new) it reads the regime, ranks the
// universe on momentum and low volatility, sizes by risk parity, targets 15% volatility, and trades the differences
// at the next eligible regular-session open (5 bps per side). Paper money only. Rules live in quant-trader.js.
const QTC = require("./quant-trader.js"), QMS = require("./public/qmath.js"), TOUGH = require("./robustness-core.js");
// One-time Quant-only capital reset; include the global marker so future all-bot resets still work.
const QT_RESET_ID = `${BOT_RESET_ID}:quant-30k-2026-11-16-1`;
const QT_FILE = path.join(require("os").tmpdir(), "quanttrader-v1.json"), QT_KEY = "pft:quanttrader:v1";
const qtFresh = () => ({ v: 1, resetId: QT_RESET_ID, runs: [], start: Date.now(), cash: QTC.QT_START, positions: {}, trades: [], equity: [], decisions: [], spx0: null, firstTrade: null, lastDay: null, pending: null, lastError: null, updated: Date.now() });
let QT = qtFresh(), qtLoaded = false, qtBusy = false; const qtPx = {};
// Serialize the load as well as each tick, since readers may initialize the book first.
let qtLoading = null;
function qtLoad() {
  if (!qtLoading) qtLoading = qtRead().catch((error) => { qtLoading = null; throw error; });
  return qtLoading;
}
async function qtRead() {
  let raw;
  if (UP_URL && UP_TOKEN) {
    const r = await fetch(`${UP_URL}/get/${QT_KEY}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!r.ok || !Object.hasOwn(j, "result")) throw new Error("Quant state could not be loaded");
    if (j.result != null) raw = JSON.parse(j.result);
  }
  if (!raw) {
    try { raw = JSON.parse(fs.readFileSync(QT_FILE, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (raw) QT = { ...qtFresh(), ...raw, resetId: raw.resetId };
  const c1 = await qtResetCheck(), c2 = await qtVersionCheck();
  if (c1 || c2) await qtCommit(QT);
  qtLoaded = true;
}
// Strategy registry: a new Quant-trader version archives the run (marked at the last recorded value, not at cost) and starts a new one.
async function qtVersionCheck() {
  if (!RISK.versionChanged(QT.strategy, STRATS.quant)) return false;
  const busy = QT.firstTrade || (QT.trades && QT.trades.length);
  if (busy) {
    const last = (QT.equity || [])[QT.equity.length - 1], v = last && last.v > 0 ? last.v : QT.cash + Object.values(QT.positions || {}).reduce((a, p) => a + p.shares * p.cost, 0);
    const rec = { start: QT.firstTrade || QT.start, end: Date.now(), startValue: QTC.QT_START, endValue: +v.toFixed(2), trades: (QT.trades || []).length, days: (QT.equity || []).length,
      spxRet: QT.spx0 && last && last.s ? +((last.s / QT.spx0 - 1) * 100).toFixed(2) : null, strategy: QT.strategy || { id: "daniel-macro-quant", version: 1, note: "before the strategy registry" }, reason: `Strategy change → v${STRATS.quant.version}`, marked: last ? "last recorded daily value" : "cost basis (no recorded value)" };
    await archivePush("quant", { ...rec, tradeLog: QT.trades, equity: QT.equity, decisions: QT.decisions });
    QT = { ...qtFresh(), runs: [rec, ...(Array.isArray(QT.runs) ? QT.runs : [])] };
  }
  QT.strategy = { id: STRATS.quant.id, version: STRATS.quant.version, since: Date.now() };
  return true;
}
async function qtResetCheck() {
  if (QT.resetId === QT_RESET_ID) return false;
  const runs = QT.runs, busy = QT.firstTrade || QT.trades.length;
  if (busy) {
    const last = QT.equity.at(-1), v = last?.v ?? (QT.cash + Object.values(QT.positions).reduce((sum, p) => sum + p.shares * p.cost, 0));
    const rec = { start: QT.firstTrade || QT.start, end: Date.now(), startValue: QTC.QT_START, endValue: +v.toFixed(2), trades: QT.trades.length, days: QT.equity.length, strategy: QT.strategy, reason: "Paper execution audit — restarted at $30,000",
      marked: last ? "last recorded value" : "cost basis (no recorded value)" };
    await archivePush("quant", { ...rec, tradeLog: QT.trades, equity: QT.equity, decisions: QT.decisions });
    runs.unshift(rec);
  }
  QT = { ...qtFresh(), runs };
  return true;
}
// Persist a complete replacement before publishing it to readers or allowing another tick.
async function qtCommit(next) {
  const updated = { ...next, updated: Date.now() }, body = JSON.stringify(updated);
  const writeLocal = () => {
    const temp = QT_FILE + ".tmp";
    fs.writeFileSync(temp, body);
    fs.renameSync(temp, QT_FILE);
  };
  if (UP_URL && UP_TOKEN) {
    const r = await fetch(`${UP_URL}/set/${QT_KEY}`, { method: "POST", headers: { Authorization: `Bearer ${UP_TOKEN}` }, body, signal: AbortSignal.timeout(8000) });
    if (!r.ok || (await r.json()).result !== "OK") throw new Error("Quant state could not be saved");
    try { writeLocal(); } catch {} // Remote storage has accepted the snapshot.
  } else {
    writeLocal();
  }
  QT = updated;
}
const qtValue = (px) => QT.cash + Object.entries(QT.positions).reduce((a, [s, p]) => a + p.shares * (px[s] || qtPx[s] || p.cost), 0);
// Daniel's quality/value factor: the Fin 370 ratio score for each single stock in his universe (SEC 10-K data, cached 12 h)
async function qtFundamentals(series) {
  const items = [], ETF = /^(SPY|QQQ|IWM|DIA|XL\w|SMH|IEF|TLT|GLD|BIL|HYG)$/;
  for (const s of QTC.QT_EQUITY) {
    if (ETF.test(s) || !series[s]) continue;
    try { const f = await secFundamentals(s); if (!f.available || f.years.length < 2) continue; const Y = f.years, n = Y.length, c = series[s].close;
      items.push({ sym: s, now: RATIOS.compute(Y[n - 1], Y[n - 2], { price: c[c.length - 1], shares: f.shares && f.shares.v }), prev: n >= 3 ? RATIOS.compute(Y[n - 2], Y[n - 3]) : null }); } catch {}
  }
  const sc = RATIOS.score(items), score = {}; for (const [k, v] of Object.entries(sc)) if (v.score != null) score[k] = v.score;
  return { score, detail: sc };
}
const QT_OPEN_MINUTE = 9 * 60 + 30, QT_OPEN_CUTOFF = 10 * 60;
async function qtExecute(t, started) {
  const plan = QT.pending;
  const open = Math.floor(started / 60_000) * 60 - (t.min - QT_OPEN_MINUTE) * 60;
  const at = plan.fillAt || open, targets = plan.orders.map((o) => o.sym);
  const quotes = await Promise.allSettled([...new Set([...targets, "^GSPC"])].map(async (sym) => {
    const bar = (await dtBars(sym)).find((b) => b.t === at && b.d === t.day);
    return [sym, bar && (!plan.fillAt || DTC.paperBarReady(bar, Date.now(), 90)) ? bar.o : null];
  }));
  const prices = Object.fromEntries(quotes.filter((r) => r.status === "fulfilled").map((r) => r.value));
  const now = etParts();
  if (now.day !== plan.executeDay || now.min >= QT_OPEN_CUTOFF) throw new Error("Opening-price retry window ended");
  if (!plan.fillAt) {
    const exits = plan.orders.filter((o) => o.side === "SELL" && prices[o.sym] > 0);
    const remaining = plan.orders.filter((o) => !exits.includes(o));
    if (exits.length) await qtSettleOrders(plan, exits, prices, open, remaining.length ? { ...plan, orders: remaining } : null);
    if (!remaining.length) return;
    if (remaining.some((o) => o.side === "SELL")) return;
    if (remaining.some((o) => !(prices[o.sym] > 0)) || !(prices["^GSPC"] > 0)) return;
    const tickets = [], orders = [];
    await deskRisk.prepare(remaining.map((o) => o.sym));
    try {
      for (const order of remaining) {
        const price = prices[order.sym], riskPerShare = price * (0.02 + 2 * QTC.QT_COST);
        // BIL is the cash sleeve (1–3 month T-bills): it adds no stop risk, so the desk's per-trade risk cap doesn't clip it.
        // Before this, a 2% "stop" on BIL capped each buy near $3k and left most of the account in plain cash.
        if (order.sym === QTC.QT_CASH) { orders.push({ ...order, riskPerShare: price * 0.001, approvalPrice: price }); continue; }
        const ticket = deskRisk.reserve({ bot: "quant", sym: order.sym, sign: 1, shares: order.shares, price, riskPerShare });
        if (!ticket.shares) { BOTDIAG.quant.desk = ticket.reason; continue; }
        tickets.push(ticket);
        orders.push({ ...order, shares: ticket.shares, riskPerShare, approvalPrice: price });
      }
      const approvedAt = Date.now(), fillAt = (Math.floor(approvedAt / 60_000) + 1) * 60;
      await qtCommit({ ...QT, pending: orders.length ? { ...plan, orders, approvedAt, fillAt } : null });
      if (orders.length) setTimeout(qtTick, Math.max(0, (fillAt + 62) * 1000 - Date.now()));
    } finally { for (const ticket of tickets) ticket.release(); }
    return;
  }
  if (plan.approvedAt >= at * 1000 || targets.some((sym) => !(prices[sym] > 0)) || !(prices["^GSPC"] > 0)) {
    if (Date.now() > (at + 150) * 1000) await qtCommit({ ...QT, pending: null, lastError: "Approved entry bar unavailable" });
    else setTimeout(qtTick, 12_000);
    return;
  }
  if (!deskRisk.mayExecute()) {
    await qtCommit({ ...QT, pending: null, lastError: "Approved entries canceled by current desk risk checks" });
    return;
  }
  const orders = plan.orders.map((o) => ({ ...o, shares: Math.min(o.shares, o.shares * o.approvalPrice / prices[o.sym]) }));
  await qtSettleOrders(plan, orders, prices, at, null);
}
async function qtSettleOrders(plan, orders, prices, at, pending) {
  const book = QTC.fillOrders(QT, orders, prices, at * 1000, plan.why);
  const references = Object.fromEntries(plan.orders.map((o) => [o.sym, o.referencePrice]));
  for (const fill of book.trades) Object.assign(fill, {
    decisionAt: plan.at, riskApprovedAt: plan.approvedAt ?? null, decisionPrice: references[fill.sym], fillReferencePrice: prices[fill.sym], modeledCostBps: QTC.QT_COST * 1e4,
  });
  const decisions = QT.decisions.map((d) => d.d === plan.signalDay ? { ...d, trades: (d.trades || 0) + book.trades.length, executed: plan.executeDay } : d);
  await qtCommit({
    ...QT, cash: book.cash, positions: book.positions, decisions, pending, lastError: null,
    trades: [...book.trades.reverse(), ...QT.trades].slice(0, 1500),
    firstTrade: QT.firstTrade || (book.trades.length ? at * 1000 : null),
    spx0: QT.spx0 || (book.trades.length ? prices["^GSPC"] || null : null),
  });
  for (const [sym, price] of Object.entries(prices)) if (price > 0) qtPx[sym] = price;
}

async function qtPlan(t, close) {
  const y = +t.day.slice(0, 4);
  const from = `${y - (y % 2) - 2}-01-01`;
  const syms = [...new Set([...QTC.QT_EQUITY, ...QTC.QT_DEFENSIVE, QTC.QT_CASH, ...QTC.QT_SIGNALS, ...Object.keys(QT.positions), "^GSPC"])];
  const history = await Promise.allSettled(syms.map(async (s) => [s, await fetchLongHistory(s, from, t.day, "1d", close)]));
  const series = Object.fromEntries(history.filter((r) => r.status === "fulfilled").map((r) => r.value));
  const required = ["SPY", "^GSPC", ...Object.keys(QT.positions)];
  const missing = required.filter((s) => !series[s]);
  if (missing.length) throw new Error(`Final closes unavailable for ${missing.join(", ")}`);
  const spx = series["^GSPC"].close.at(-1);
  delete series["^GSPC"]; // the index is a benchmark, not a factor or a proposed holding
  const A = QMS.align(series);
  if (A.dates.at(-1) !== Date.parse(t.day) / 1000) throw new Error("Aligned series lack the latest final close");
  const fund = await qtFundamentals(series);
  // regime changes are confirmed first: 3 trading days in a row, or sooner toward safety when the spider's own market research agrees
  let spiderStress = null; try { const ms = SPIDER ? SPIDER.marketStress() : null; spiderStress = ms && ms.on ? ms.note : null; } catch {}
  let conf = null;
  const D = QTC.decide(A.px, { putcall: pcBrief(), fund: fund.score, fundWeight: STRATS.quant.params.fundWeight,
    regimeLabel: (raw) => (conf = TEAM.confirmRegime(QT.regimeState, raw, t.day, { spiderStress })).label });
  // owner instructions: an avoided symbol's weight goes to cash (T-bills); a paused Quant keeps what it holds
  await ownerReady;
  for (const s of Object.keys(D.w)) if (s !== QTC.QT_CASH && CO.blocked(OWNER, "quant", s)) { D.w[QTC.QT_CASH] = (D.w[QTC.QT_CASH] || 0) + D.w[s]; delete D.w[s]; }
  const prices = Object.fromEntries(Object.entries(series).map(([s, row]) => [s, row.close.at(-1)]));
  if (Object.keys(D.w).some((s) => !(prices[s] > 0))) throw new Error("Final closes unavailable for target allocation");
  const value = qtValue(prices), holdings = Object.fromEntries(Object.entries(QT.positions).map(([s, p]) => [s, p.shares]));
  const orders = CO.paused(OWNER, "quant") ? [] : QTC.orders(D.w, holdings, prices, value);
  const executeDay = QTC.nextTradingDay(t.day, NYSE_HOLIDAYS);
  if (etParts().day >= executeDay) throw new Error("Decision missed its overnight planning window");
  const why = `${D.regime}${D.rawRegime !== D.regime ? ` (raw signal ${D.rawRegime}, not yet confirmed)` : ""} · ${Math.round(D.split * 100)}% equity sleeve${D.pcTilt ? ` (Zweig put/call ${D.pcTilt > 0 ? "+" : "−"}${Math.round(Math.abs(D.pcTilt) * 100)}%)` : ""} · vol ${(D.vol * 100).toFixed(1)}%`;
  const now = Date.now(), pending = orders.length ? { signalDay: t.day, executeDay, at: now, orders: orders.map((order) => ({ ...order, referencePrice: prices[order.sym] })), why } : null;
  const decision = { t: now, d: t.day, fundCovered: Object.keys(fund.score).length, regime: D.regime, rawRegime: D.rawRegime, regimeNote: conf ? conf.note : null, spiderStress, score: D.score, ind: D.ind, split: D.split, vol: D.vol, exVol: D.exVol, scale: D.scale, enb: D.enb, ranked: D.ranked, target: D.w, trades: 0 };
  const equity = QT.firstTrade ? [...QT.equity.filter((p) => p.d !== t.day), { t: now, d: t.day, v: +value.toFixed(2), s: spx }].slice(-1500) : QT.equity;
  // toughness test, weekly: replay its own rules monthly on the same aligned closes (shown, never blocks the main bot)
  let robust = QT.robust || null;
  if (!robust || !robust.testedOn || Date.parse(t.day) - Date.parse(robust.testedOn) >= 6 * 864e5) {
    try { robust = { ...TOUGH.quantToughness(QTC.decide, A.px, A.dates.map((d) => new Date(d * 1000).toISOString().slice(0, 10))), testedOn: t.day }; }
    catch (e) { robust = { status: "error", label: "Test couldn't run: " + String(e.message || e).slice(0, 80), testedOn: t.day }; }
  }
  await qtCommit({ ...QT, pending, equity, decisions: [decision, ...QT.decisions].slice(0, 60), lastDay: t.day, lastError: null, regimeState: conf ? conf.state : QT.regimeState || null, robust });
  Object.assign(qtPx, prices);
}

async function qtTick() {
  if (qtBusy) return;
  qtBusy = true;
  try {
    if (!qtLoaded) await qtLoad();
    const started = Date.now(), t = etParts(new Date(started)), tradingDay = t.wd !== "Sat" && t.wd !== "Sun" && !NYSE_HOLIDAYS.has(t.day);
    if (QT.pending && t.day >= QT.pending.executeDay) {
      if (tradingDay && t.day === QT.pending.executeDay && t.min < QT_OPEN_CUTOFF) {
        if (t.min > QT_OPEN_MINUTE) await qtExecute(t, started);
        return;
      }
      await qtCommit({ ...QT, pending: null, lastError: `Missed ${QT.pending.executeDay} opening window; rebalance expired` });
    }
    const close = NYSE_EARLY.has(t.day) ? 13 * 60 : 16 * 60;
    if (tradingDay && t.min >= close + 25 && QT.lastDay !== t.day) await qtPlan(t, close);
  } catch (e) {
    QT.lastError = String(e.message || e);
  } finally {
    qtBusy = false;
  }
}
async function qtView() {
  if (!qtLoaded) await qtLoad();
  const syms = Object.keys(QT.positions); let q = {};
  try { q = (await getQuotes([...syms, "^GSPC"])).quotes; } catch {}
  for (const s of syms) if (q[s] && q[s].price) qtPx[s] = q[s].price;
  const value = qtValue({}), positions = syms.map((s) => { const p = QT.positions[s], price = qtPx[s] || p.cost; return { sym: s, shares: p.shares, cost: p.cost, price, value: p.shares * price, pnl: (price - p.cost) * p.shares - QTC.entryFee(p), weight: (p.shares * price) / value }; }).sort((a, b) => b.value - a.value);
  const t = etParts(), open = !(t.wd === "Sat" || t.wd === "Sun") && t.min >= 570 && t.min < 960;
  return { ...QT, trades: QT.trades.map((trade) => trade.side === "SELL" ? { ...trade, pnl: QTC.closedPnl(trade) } : trade), kind: "quant", strategy: { ...STRATS.quant, active: QT.strategy || null }, value, startValue: QTC.QT_START, spxNow: q["^GSPC"] && q["^GSPC"].price, positions, rawPositions: QT.positions, marketOpen: open, latest: QT.decisions[0] || null,
    rules: { universe: QTC.QT_EQUITY, defensive: QTC.QT_DEFENSIVE, cash: QTC.QT_CASH, top: QTC.QT_TOP, maxW: QTC.QT_MAX_W, volTarget: QTC.QT_VOL_TARGET, minTrade: QTC.QT_MIN_TRADE, cost: QTC.QT_COST, split: QTC.SPLIT },
    status: QT.lastError || (QT.pending ? `Paper rebalance queued for the ${QT.pending.executeDay} open` : QT.lastDay ? `Plans after the close for the next open · last decision ${QT.lastDay}` : "Waiting for the first completed trading session") };
}
if (DEPLOY.runJobs) setTimeout(() => {
  qtTick();
  setInterval(() => { const t = etParts(); if (QT.pending?.fillAt || (t.min >= QT_OPEN_MINUTE && t.min < QT_OPEN_CUTOFF) || t.min % 10 === 0 || process.env.AP_TEST) qtTick(); },
    process.env.AP_TEST ? 15_000 : 60_000);
}, process.env.AP_TEST ? 8000 : 90_000);


// ---------------------------------------------------------------- live money (both bots, marked to market every few seconds)
// While someone has the AI vs S&P page open, the server fetches live prices for every stock the bots hold — one batched
// Yahoo request every 4 seconds — and the page polls this compact snapshot every ~2.5 seconds. Real-time Finnhub trades
// are used instead when they're fresher. Nobody watching → no requests at all. Trading decisions don't use these prices
// (they run on 1-minute bars); this is only the live scoreboard.
const BL = { px: {}, t: 0, want: 0, busy: false, fails: 0, snap: null, snapT: 0 };

const { createDeskRisk } = require("./desk-risk.js");
const { paperStore } = require("./paper-state-store.js");
function adjacentSession(day, direction) {
  const date = new Date(day + "T12:00:00Z");
  for (let i = 0; i < 12; i++) {
    date.setUTCDate(date.getUTCDate() + direction);
    const key = date.toISOString().slice(0, 10), wd = date.getUTCDay();
    if (wd > 0 && wd < 6 && !NYSE_HOLIDAYS.has(key)) return key;
  }
  throw new Error("Adjacent trading session unavailable");
}
function deskClock() {
  const t = sessionInfo();
  return { ...t, trading: t.wd !== "Sat" && t.wd !== "Sun" && !NYSE_HOLIDAYS.has(t.day), close: NYSE_EARLY.has(t.day) ? 780 : 960 };
}
const deskRisk = createDeskRisk({
  store: paperStore("desk-risk-v1", { url: UP_URL, token: UP_TOKEN }),
  clock: deskClock, previousDay: (day) => adjacentSession(day, -1),
  sessionOf: (at) => etParts(new Date(at)),
  loadBooks: async () => Promise.all([apLoaded || apLoad(), dtLoaded || dtLoad(), qtLoaded || qtLoad()]),
  quotes: async (syms) => (await getQuotes(syms)).quotes,
  closes: async (sym, day) => {
    const candles = (await history(sym, "1y")).candles;
    return new Map(candles.map((bar) => [apDayFormat.format(bar.time * 1000), bar.close])
      .filter(([date, price]) => date < day && price > 0));
  },
  books: () => [
    { bot: "swing", cash: AP.cash, lots: Object.entries(AP.positions).map(([sym, p]) => ({ sym, shares: p.shares, sign: 1, risk: (price) => {
      const [sl, tr] = apStops(p), stop = Math.max(p.cost * (1 - sl), (p.peak || p.cost) * (1 - tr));
      return Math.max(0, price - stop) + 2 * AP_COST * price;
    } })) },
    { bot: "day", cash: DT.cash, lots: Object.entries(DT.positions).map(([sym, p]) => ({ sym, shares: p.shares,
      sign: p.dir === "short" ? -1 : 1,
      risk: (price) => Math.max(0, (p.dir === "short" ? -1 : 1) * (price - p.stop), Math.abs(p.entry - p.stop0)) + (2 * DT_COST + (p.dir === "short" ? DT_FEE_SHORT : 0)) * price })),
      queued: Object.entries(DT.entries).map(([sym, f]) => ({ sym, sign: f.side, ...f.approval })) },
    { bot: "quant", cash: QT.cash, lots: Object.entries(QT.positions).map(([sym, p]) => ({ sym, shares: p.shares,
      sign: 1, risk: (price) => price * (sym === QTC.QT_CASH ? 0.001 : 0.02 + 2 * QTC.QT_COST) })),
      queued: QT.pending?.approvedAt ? QT.pending.orders.map((o) => ({ sym: o.sym, sign: 1, shares: o.shares, riskPerShare: o.riskPerShare, price: o.approvalPrice })) : [] },
  ],
});
if (!process.env.AP_TEST && DEPLOY.runJobs) setTimeout(() => {
  deskRisk.prepare(); setInterval(() => { deskRisk.refresh().then(() => deskRisk.prepare()).catch(() => {}); }, 60_000);
}, 30_000);

const LAB = require("./strategy-lab.js");
const { createDayVolume } = require("./day-volume.js");
const dayVolume = createDayVolume({ store: paperStore("day-volume-v1", { url: UP_URL, token: UP_TOKEN }) });
async function labQuarterly(sym, day) {
  if (!LAB.SWING_UNIVERSE.includes(sym)) return null;
  return cached(`lab:quarter:${sym}:${day}`, 12 * 3600_000, async () => {
    const company = await secCik(sym);
    if (!company) return null;
    const facts = await secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(company.cik).padStart(10, "0")}.json`);
    return LAB.quarterlyComparison(facts.facts, day, Date.now());
  });
}
const labFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
function labMinute(ts) {
  const [h, m] = labFormat.format(new Date(ts * 1000)).split(":").map(Number);
  return h * 60 + m;
}
const strategyLab = LAB.createStrategyLab({
  store: paperStore("desk-strategy-lab-v1", { url: UP_URL, token: UP_TOKEN }),
  clock: (at) => {
    if (at == null) return deskClock();
    const t = etParts(new Date(at)); return { ...t, close: NYSE_EARLY.has(t.day) ? 780 : 960 };
  },
  nextSession: (day) => adjacentSession(day, 1),
  minuteHistory: async (sym) => (await history(sym, "5d", "5m")).candles.map((bar) => ({ t: bar.time,
    d: apDayFormat.format(bar.time * 1000), m: labMinute(bar.time), o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume })),
  dailyData: async (sym, t) => {
    const from = `${+t.day.slice(0, 4) - 2}-01-01`;
    const [prices, formatted, fundamental] = await Promise.all([
      fetchLongHistory(sym, from, t.day, "1d", t.close),
      history(sym, "2y", "1d"),
      labQuarterly(sym, t.day).catch(() => null),
    ]);
    const raw = {}, adjusted = {};
    for (let i = 0; i < prices.t.length; i++) {
      const day = apDayFormat.format(prices.t[i] * 1000);
      if (day > t.day || !(prices.close[i] > 0)) continue;
      raw[day] = prices.close[i];
      if (prices.adj?.[i] > 0) adjusted[day] = prices.adj[i];
    }
    const bars = formatted.candles.map((b) => ({ ...b, day: apDayFormat.format(b.time * 1000) }))
      .filter((b) => b.day <= t.day && raw[b.day] > 0);
    const last = bars.at(-1);
    if (!last || last.day !== t.day || Math.abs(last.close - raw[t.day]) > Math.max(0.0001, raw[t.day] * 0.00005)) {
      throw new Error("Final daily OHLC is not aligned");
    }
    return { bars, raw, adjusted, fundamental };
  },
  bars: dtBars,
  rates: (day) => getT(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3MO&cosd=${+day.slice(0, 4) - 1}-01-01`, "text/csv", 3_500),
  treasuryRates: async (day) => {
    const year = Number(day.slice(0, 4));
    const years = day.slice(5) < "01-09" ? [year, year - 1] : [year];
    const results = await Promise.allSettled(years.map((y) => treasuryYearCsv(y, year)));
    return results.filter((r) => r.status === "fulfilled").map((r, i) =>
      i ? r.value.trim().split(/\r?\n/).slice(1).join("\n") : r.value.trim()).join("\n");
  },
  liveDesk: () => deskRisk.view(),
  // toughness results for the three main bots (shown only; main bots aren't paused by it)
  mainBots: () => {
    const rec = (trades, sides) => { const c = (trades || []).filter((x) => sides.includes(x.side) && x.pnl != null); return { closed: c.length, wins: c.filter((x) => x.pnl > 0).length, realizedPnl: c.reduce((a, x) => a + x.pnl, 0) }; };
    const live = (name, book) => { const r = TOUGH.liveRecord(book); return { bot: name, ...r, gate: "Shown for information: main bots keep trading.", why: "Uses news, analyst ratings or intraday bars that have no free history, so it's judged on its live paper record." }; };
    return [QT.robust ? { bot: "Quant trader", ...QT.robust } : { bot: "Quant trader", status: "pending", label: "Runs after the next close" },
      live("Swing bot", rec(AP.trades, ["SELL"])), live("Day trader", rec(DT.trades, ["SELL", "COVER"]))];
  },
  // inputs for the earnings-drift and insider-buying lab bots (the same free sources the swing bot and spider use)
  events: async () => {
    const sp = new Set(SP500.map((r) => r[0]));
    const earnings = (await apEarnings()).filter((e) => e.epsActual != null && e.epsEstimate != null && Math.abs(e.epsEstimate) >= 0.01 && sp.has(e.symbol))
      .map((e) => ({ symbol: ySym(e.symbol), date: e.date, hour: e.hour || null, surprise: (e.epsActual - e.epsEstimate) / Math.abs(e.epsEstimate) }))
      .filter((e) => e.surprise >= 0.05).sort((a, b) => b.surprise - a.surprise).slice(0, 25);
    const by = new Map();
    try {
      for (const d of SPIDER ? SPIDER.discoveries({ cat: "insider", since: Date.now() - 10 * 864e5, limit: 200 }).items : []) {
        if (!(d.tone > 0)) continue;
        // the spider writes "SYM: N insiders bought $X on the open market (90 days)" from Form 4 code-P trades
        const m = /: (\d+) insiders? bought/.exec(d.headline || ""), buyers = m ? +m[1] : d.tone >= 2 ? 2 : 1;
        for (const tk of (d.tickers || []).slice(0, 1)) {
          const k = ySym(tk), e = by.get(k);
          if (!e || d.u > e.lastAt) by.set(k, { symbol: k, buyers: Math.max(buyers, e ? e.buyers : 0), lastAt: d.u, headline: d.headline, source: (d.sources && d.sources[0] && d.sources[0].name) || "SEC Form 4" });
        }
      }
    } catch {}
    return { earnings, insider: [...by.values()].sort((a, b) => b.buyers - a.buyers).slice(0, 15) };
  },
});
if (!process.env.AP_TEST && DEPLOY.runJobs) setTimeout(() => {
  strategyLab.tick();
  const t = deskClock();
  if (t.trading && t.open) strategyLab.warmDay(t.day).catch(() => {});
  setInterval(() => strategyLab.tick(), 30_000);
}, 35_000);
const blOpenish = () => { const t = etParts(); return !(t.wd === "Sat" || t.wd === "Sun") && t.min >= 9 * 60 + 25 && t.min <= 16 * 60 + 5; };
async function blRefresh() {
  if (BL.busy) return; BL.busy = true;
  try {
    const syms = [...new Set([...Object.keys(AP.positions), ...Object.keys(DT.positions), ...Object.keys(QT.positions || {}), "^GSPC"])];
    for (let i = 0; i < syms.length; i += 150) {
      const j = await yget(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms.slice(i, i + 150).join(","))}&fields=regularMarketPrice,regularMarketTime`);
      for (const q of (j.quoteResponse && j.quoteResponse.result) || []) if (q.regularMarketPrice != null) BL.px[q.symbol] = { p: q.regularMarketPrice, t: (q.regularMarketTime || 0) * 1000 || Date.now() };
    }
    BL.t = Date.now(); BL.fails = 0;
  } catch (e) { BL.fails++; } finally { BL.busy = false; }
}
// back off to every 30 s if Yahoo keeps refusing, so the bots' own data never gets blocked
setInterval(() => { if (Date.now() - BL.want < 30e3 && blOpenish() && (BL.fails < 3 || Date.now() - BL.t > 30e3)) blRefresh(); }, 4000);
function blPx(sym, fallback) {
  const a = BL.px[sym], f = live.last.get(sym), fT = f ? f.t : 0;
  if (f && (!a || fT > a.t) && Date.now() - fT < 120e3) return f.p;
  return a ? a.p : fallback;
}
// ---------------------------------------------------------------- Three-Trader Challenge leaderboard (competition-core.js)
// Same windows for all three: today, week, month, quarter, lifetime of the current runs. Ranked by net profit after
// modeled costs; risk measures beside it; a trader past the shared drawdown limit is ineligible. Paper money only.
const COMP = require("./competition-core.js");
const TRADERS = {
  swing: { name: "Swing Trader", role: "Swing trader", focus: "Multi-day trends, breakouts and earnings catalysts (2–30 days)" },
  quant: { name: "Quant Trader", role: "Quantitative economist", focus: "Market regime, factor ranking and risk-parity allocation across ETFs and mega-caps" },
  day: { name: "Day Trader", role: "Intraday trader", focus: "Confirmed momentum and ETF VWAP reversals, with a ten-minute maximum hold" },
  me: { name: "My Trader", role: "Human (Peter)", focus: "Hand-picked long and short trades, same $30,000 start and the same modeled costs as the bots", human: true },
};
let LB = { t: 0, v: null };
async function leaderboard() {
  if (LB.v && Date.now() - LB.t < 30e3) return LB.v;
  if (!apLoaded) await apLoad(); if (!dtLoaded) await dtLoad(); if (!qtLoaded) await qtLoad();
  const live = botsLive(), today = etParts().day, spxNow = live.spx || null;
  const series = (pts, value) => { const m = new Map(); for (const p of pts || []) if (p && p.d && p.v > 0) m.set(p.d, { d: p.d, v: p.v, spx: p.spx != null ? p.spx : p.s }); if (value > 0) m.set(today, { d: today, v: value, spx: spxNow || (m.get(today) || {}).spx }); return [...m.values()].sort((a, b) => (a.d < b.d ? -1 : 1)); };
  const sells = (tr) => (tr || []).filter((t) => t.side === "SELL" && t.pnl != null).map((t) => t.pnl);
  const pf = (p) => { const w = p.filter((x) => x > 0).reduce((a, b) => a + b, 0), l = -p.filter((x) => x <= 0).reduce((a, b) => a + b, 0); return l > 0 ? w / l : null; };
  const T = DT.tally || {}, dBook = dtBook();
  const bots = {
    swing: { value: live.swing.value, start: AP_START, spx0: AP.spx0, eq: AP.equity, run: AP.run, since: AP.firstTrade, strategy: AP.strategy, trades: AP.trades.length, costs: AP.trades.reduce((a, t) => a + (t.cost || 0), 0), pnls: sells(AP.trades), exposure: live.swing.value > 0 ? 1 - AP.cash / live.swing.value : null,
      latest: AP.trades[0] ? `${AP.trades[0].side} ${AP.trades[0].sym}: ${(AP.trades[0].why || "").slice(0, 140)}` : AP.plan && AP.plan.orders && AP.plan.orders.length ? `Planned for the open: ${AP.plan.orders.length} orders` : "No trades yet", thesis: apSig ? (apSig.stress ? `Defense mode — ${apSig.stress}` : apSig.riskOff ? "S&P below its 200-day average — keeping 20% cash" : `Holding ${Object.keys(AP.positions).length} names; top-ranked now: ${(apSig.top || []).slice(0, 3).map((x) => x.sym).join(", ")}`) : null },
    quant: { value: live.quant.value, start: QTC.QT_START, spx0: QT.spx0, eq: QT.equity, run: (QT.runs || []).length + 1, since: QT.firstTrade, strategy: QT.strategy, trades: (QT.trades || []).length, costs: (QT.trades || []).reduce((a, t) => a + (t.cost ?? (t.value || 0) * QTC.QT_COST), 0), pnls: QT.trades.filter((t) => t.side === "SELL" && t.pnl != null).map(QTC.closedPnl), exposure: live.quant.value > 0 ? 1 - (QT.cash + ((QT.positions || {}).BIL ? QT.positions.BIL.shares * (qtPx.BIL || QT.positions.BIL.cost) : 0)) / live.quant.value : null,
      latest: QT.decisions && QT.decisions[0] ? `${QT.decisions[0].d}: ${QT.pending ? QT.pending.orders.length + " queued" : QT.decisions[0].trades + " trades"} · ${QT.decisions[0].regime} · ${Math.round(QT.decisions[0].split * 100)}% equity sleeve` : "No decision yet", thesis: QT.decisions && QT.decisions[0] ? `Regime "${QT.decisions[0].regime}"; ex-ante volatility ${(QT.decisions[0].vol * 100).toFixed(1)}% vs a 15% target` : null },
    day: { value: live.day.value, start: DT_START, spx0: DT.spx0, eq: DT.equity, run: DT.run, since: DT.firstTrade, strategy: DT.strategy, trades: T.n || 0, costs: T.costs || 0, agg: T, exposure: live.day.value > 0 ? dBook.gross / live.day.value : null,
      latest: DT.trades[0] ? `${DT.trades[0].side} ${DT.trades[0].sym}: ${(DT.trades[0].why || "").slice(0, 140)}` : "No trades yet in this run", thesis: DT.day ? `${DT.day.reversalSignals || 0} confirmed ETF reversals today${DT.day.halted ? " · daily loss limit hit" : ""}` : null },
  };
  try { // the owner's own account joins once it has made a trade
    const st = await mtLoad();
    if (st.firstTrade) { const syms = Object.keys(st.positions); let q = {}; try { q = (await getQuotes(syms)).quotes; } catch {}
      const v = MYT.value(st, Object.fromEntries(syms.filter((x) => q[x] && q[x].price > 0).map((x) => [x, q[x].price]))).value, ms = MYT.stats(st);
      bots.me = { value: v, start: st.start, spx0: st.spx0, eq: st.equity, run: 1, since: st.firstTrade, strategy: null, trades: ms.fills, costs: ms.costs, pnls: st.trades.filter((t) => (t.side === "SELL" || t.side === "COVER") && t.pnl != null).map((t) => t.pnl),
        exposure: v > 0 ? Object.values(st.positions).reduce((a, p) => a + p.shares * p.cost, 0) / v : null, latest: st.trades[0] ? `${st.trades[0].side} ${st.trades[0].sym}${st.trades[0].note ? ": " + st.trades[0].note.slice(0, 140) : ""}` : "No trades yet", thesis: null }; }
  } catch {}
  const out = { t: Date.now(), today, spxNow, limits: COMP.LIMITS, periods: COMP.PERIODS.map(([k, label]) => ({ k, label })), boards: {}, traders: {} };
  for (const [k, b] of Object.entries(bots)) {
    const s = series(b.eq, b.value), life = COMP.windowStats(s, { start: b.start, today, days: null, spx0: b.spx0 });
    const E = b.agg ? RISK.expectancy(b.agg.n || 0, (b.agg.gw || 0) - (b.agg.gl || 0), b.agg.sq || 0) : RISK.expectancyOf(b.pnls);
    const wins = b.agg ? b.agg.wins || 0 : b.pnls.filter((x) => x > 0).length, closed = b.agg ? b.agg.n || 0 : b.pnls.length;
    out.traders[k] = { ...TRADERS[k], key: k, strategy: STRATS[k], run: b.run, since: b.since || null, value: b.value, start: b.start, trades: b.trades, closed, costs: +b.costs.toFixed(2),
      winRate: closed ? wins / closed : null, profitFactor: b.agg ? (b.agg.gl > 0 ? b.agg.gw / b.agg.gl : null) : pf(b.pnls), expectancy: E, exposure: b.exposure, latest: b.latest, thesis: b.thesis, lifeDrawdown: life.ok ? life.maxDrawdown : null };
  }
  for (const [pk, , days] of COMP.PERIODS) {
    out.boards[pk] = COMP.rank(Object.keys(bots).map((k) => ({ key: k, lifeDrawdown: out.traders[k].lifeDrawdown, stats: COMP.windowStats(series(bots[k].eq, bots[k].value), { start: bots[k].start, today, days, spx0: bots[k].spx0 }) })));
  }
  const ai = (b) => b.filter((r) => r.key !== "me"); // the hero compares the three bots only; you're ranked beside them
  out.summary = { day: COMP.combine(ai(out.boards.day)), life: COMP.combine(ai(out.boards.life)) };
  LB = { t: Date.now(), v: out }; return out;
}
function botsLive() {
  BL.want = Date.now();
  if (BL.snap && Date.now() - BL.snapT < 1000) return BL.snap;
  const spx = blPx("^GSPC", null), r2 = (x) => +x.toFixed(2);
  const sw = Object.entries(AP.positions).map(([sym, p]) => { const px = blPx(sym, apPx[sym] || p.cost), v = p.shares * px; return [sym, r2(px), r2(v), r2(v - p.shares * p.cost), +(px / p.cost - 1).toFixed(5)]; });
  const swV = AP.cash + sw.reduce((a, x) => a + x[2], 0);
  const dy = Object.entries(DT.positions).map(([sym, p]) => { const px = blPx(sym, dtPx[sym] || p.entry), pnl = DTC.pnlOf(p, px); return [sym, r2(px), r2(p.shares * px), r2(pnl), +(pnl / (p.shares * p.entry)).toFixed(5)]; });
  const dyV = DT.cash + Object.entries(DT.positions).reduce((a, [sym, p]) => a + (p.dir === "long" ? 1 : -1) * p.shares * blPx(sym, dtPx[sym] || p.entry), 0);
  BL.snap = { t: Date.now(), pricesAt: BL.t || null, open: blOpenish(), spx,
    swing: { value: r2(swV), start: AP_START, spx0: AP.spx0 || null, cash: r2(AP.cash), pos: sw },
    day: { value: r2(dyV), start: DT_START, spx0: DT.spx0 || null, cash: r2(DT.cash), pos: dy, run: DT.run, since: DT.firstTrade || null, tradesToday: DT.day && DT.day.d === etParts().day ? DT.day.closed || 0 : 0, hitRate: DT.brain && DT.brain.day && DT.brain.day.scored ? +(DT.brain.day.hits / DT.brain.day.scored).toFixed(4) : null },
    quant: (() => { const qp = Object.entries(QT.positions || {}).map(([sym, p]) => [sym, r2(p.shares * blPx(sym, qtPx[sym] || p.cost))]); const d = QT.decisions && QT.decisions[0];
      return { value: r2(QT.cash + qp.reduce((a, x) => a + x[1], 0)), start: QTC.QT_START, spx0: QT.spx0 || null, cash: r2(QT.cash), n: qp.length, since: QT.firstTrade || null, regime: d ? d.regime : null, error: QT.lastError || null }; })() };
  BL.snap.swing.run = AP.run; BL.snap.swing.since = AP.firstTrade || null; BL.snap.swing.n = sw.length;
  BL.snapT = Date.now(); return BL.snap;
}

// ---------------------------------------------------------------- SEC EDGAR fundamentals (free, no key)
// Annual figures from companies' own 10-K filings via the SEC's XBRL "company facts" API.
// SEC fair-access rules: at most 10 requests/second and a User-Agent naming a contact
// (set SEC_USER_AGENT in Render, e.g. "Market Desk research your@email"). We stay far below
// the limit: one SEC request at a time, results cached for 12 hours.
const SEC_UA = process.env.SEC_USER_AGENT || "Market Desk personal research project (github.com/phemmerdinger-cmyk/My-Terminal)";
let secChain = Promise.resolve();
// SEC requests: retry twice on dropped connections or 5xx (with a growing pause), and report the real network reason
async function secFetch(url, accept, timeout) {
  let last;
  for (let a = 0; a < 3; a++) {
    if (a) await new Promise((ok) => setTimeout(ok, 1200 * a));
    try {
      const r = await fetch(url, { headers: { "User-Agent": SEC_UA, Accept: accept, "Accept-Encoding": "gzip, deflate" }, signal: AbortSignal.timeout(timeout) });
      if (r.status >= 500 || r.status === 429) { last = new Error(`SEC returned ${r.status}`); continue; }
      return r;
    } catch (e) { const c = e && e.cause; last = new Error(c ? `${e.message}: ${c.code || c.name || ""} ${c.message || ""}`.trim() : String(e.message || e)); }
  }
  throw last;
}
secFetch = HEALTH.track(secFetch, (url) => url);
function secGet(url) {
  const run = secChain.then(async () => {
    const r = await secFetch(url, "application/json", 20000);
    await new Promise((ok) => setTimeout(ok, 250)); // ≤ 4 requests/second
    if (!r.ok) throw new Error(`SEC returned ${r.status}`);
    return r.json();
  });
  secChain = run.catch(() => {});
  return run;
}
const { createListingCatalog, REFRESH_MS: LISTING_REFRESH } = require("./listing-catalog.js");
const listingCatalog = createListingCatalog({
  store: paperStore("listing-catalog-v1", { url: UP_URL, token: UP_TOKEN }),
  feeds: {
    sec: () => secGet("https://www.sec.gov/files/company_tickers_exchange.json"),
    nasdaqListed: () => getT("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt", "text/plain", 9_000),
    otherListed: () => getT("https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt", "text/plain", 9_000),
  },
});
if (!process.env.AP_TEST) setTimeout(() => {
  listingCatalog.refresh();
  setInterval(() => listingCatalog.refresh(), LISTING_REFRESH);
}, 4_000);

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
  receivables: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent", "AccountsNotesAndLoansReceivableNetCurrent"],
  payables: ["AccountsPayableCurrent", "AccountsPayableTradeCurrent", "AccountsPayableAndAccruedLiabilitiesCurrent"],
  dividends: ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"],
  totalAssets: ["Assets"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  ltDebt: ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"],
  ltDebtCurrent: ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent", "DebtCurrent"],
  ltDebtTotal: ["LongTermDebt"],
  shortDebt: ["ShortTermBorrowings", "CommercialPaper"],
  // used by the data-integrity checks (accounting identity, cash-flow reconciliation)
  totalLiabilities: ["Liabilities"],
  liabilitiesAndEquity: ["LiabilitiesAndStockholdersEquity"],
  equityTotal: ["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  cfi: ["NetCashProvidedByUsedInInvestingActivities", "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations"],
  cashChange: ["CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect", "CashAndCashEquivalentsPeriodIncreaseDecrease", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseExcludingExchangeRateEffect"],
  fx: ["EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "EffectOfExchangeRateOnCashAndCashEquivalents"],
  dilutedShares: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
};
const FLOW = new Set(["revenue", "cogs", "grossProfit", "operatingIncome", "pretaxIncome", "incomeTax", "netIncome", "eps", "interestExpense", "da", "capex", "cfo", "cff", "dilutedShares", "cfi", "cashChange", "fx", "dividends"]);
function secSeries(facts, tag, flow) {
  const f = facts["us-gaap"] && facts["us-gaap"][tag]; if (!f) return null;
  const unitKey = Object.keys(f.units).find((u) => u === "USD" || u === "USD/shares" || u === "shares") || Object.keys(f.units)[0];
  const byEnd = {}, hist = {};
  for (const x of f.units[unitKey]) {
    if (!/^(10-K|10-K\/A|20-F|20-F\/A|40-F)$/.test(x.form || "")) continue;
    if (flow) { if (!x.start) continue; const d = (Date.parse(x.end) - Date.parse(x.start)) / 864e5; if (d < 340 || d > 380) continue; } // full fiscal years only
    else if (x.start) continue;
    const prev = byEnd[x.end]; if (!prev || (x.filed || "") > (prev.filed || "")) byEnd[x.end] = x; // latest filing wins (restatements)
    (hist[x.end] = hist[x.end] || []).push({ val: x.val, filed: x.filed, form: x.form, fy: x.fy, fp: x.fp });
  }
  for (const k in hist) hist[k].sort((a, b) => ((a.filed || "") < (b.filed || "") ? -1 : 1));
  return { unit: unitKey, byEnd, hist };
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
      for (const [tag, s] of S[k]) for (const e in s.byEnd) if (Math.abs(Date.parse(e) - Date.parse(end)) < 20 * 864e5) return { v: s.byEnd[e].val, tag, unit: s.unit, filed: s.byEnd[e].filed, form: s.byEnd[e].form, fy: s.byEnd[e].fy, fp: s.byEnd[e].fp, hist: s.hist[e] };
      return null;
    };
    const rows = years.slice(0, 6).map((end) => {
      const r = { end }; const src = {};
      r._hist = {};
      for (const k in SEC_TAGS) { const p = pick(k, end); if (p) { r[k] = p.v; src[k] = p.tag; r._unit = r._unit || (p.unit.startsWith("USD") ? "USD" : p.unit); r._filed = p.filed; r._form = p.form; if (p.fy && !r._fy) { r._fy = p.fy; r._fp = p.fp; } if (p.hist && new Set(p.hist.map((h) => h.val)).size > 1) r._hist[k] = p.hist; } }
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
    return { symbol: sym, available: true, name: j.entityName || hit.name, cik: hit.cik, currency: (rows[0] && rows[0]._unit) || "USD", years: rows.reverse(), shares, mergedPeriods: Math.max(0, sorted.length - years.length), source: "SEC EDGAR XBRL company facts (10-K / 20-F annual filings)", fetched: Date.now() };
  });
}

// ---------------------------------------------------------------- 10-K filing crawler: statements + real filing text
// Numbers come from secFundamentals (XBRL company facts). Text comes from the latest 10-K's main document on EDGAR:
// the start of Item 1 (Business), the risk-factor headlines in Item 1A, and forward-looking sentences in Item 7 (MD&A).
// One HTML download per company per day, through the same polite SEC request queue.
// big filing documents get their own queue so a download never holds up the quick JSON requests (≤ 4/s each, under SEC's 10/s)
let secDocChain = Promise.resolve();
function secText(url, maxBytes = 12e6) {
  const run = secDocChain.then(async () => {
    const r = await secFetch(url, "text/html,*/*", 30000);
    await new Promise((ok) => setTimeout(ok, 250));
    if (!r.ok) throw new Error(`SEC returned ${r.status}`);
    const buf = await r.arrayBuffer(); if (buf.byteLength > maxBytes) throw new Error("filing too large");
    return new TextDecoder("utf-8").decode(buf);
  });
  secDocChain = run.catch(() => {});
  return run;
}
const FENT = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", bull: "•", reg: "®", trade: "™", copy: "©" };
function htmlToText(h) {
  return h.replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ").replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/table)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&([a-z]+);/gi, (m, k) => FENT[k.toLowerCase()] ?? m)
    .replace(/[ \t  ​]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim();
}
// the real section (not the table of contents): the heading whose next section heading is far away
function secSection(text, startRe, endRe, minLen = 800) {
  for (const m of text.matchAll(startRe)) { const i = m.index + m[0].length, rest = text.slice(i), e = rest.search(endRe), len = e < 0 ? rest.length : e; if (len >= minLen) return text.slice(m.index, i + Math.min(len, 400000)); }
  return "";
}
// every risk-factor headline in an Item 1A section (bold one-sentence titles), in order
function riskHeadlines(risk) {
  const paras = risk.replace(/^Item\s*1A\.?\s*Risk\s*Factors/i, "").split("\n").map((x) => x.trim()).filter((x) => x.length > 40);
  const intro = paras.find((x) => x.length > 120) || "";
  const heads = paras.filter((x) => x !== intro && x.length >= 50 && x.length <= 300 && /[.:]$/.test(x) && (x.match(/\.\s/g) || []).length === 0 && !/^(The following|This section|You should|Investing in|In addition|Risks? (Related|Relating) to)/i.test(x)
    // closing sentences of a risk's body text, not headlines
    && !/^(Any of the foregoing|Any of these|All of the foregoing|Each of (the foregoing|these)|The foregoing|These (risks|factors|events|matters|and other)|Such (risks|events|matters)|As a result|Accordingly|Consequently|In such (event|case)|If any of (the foregoing|these)|There can be no assurance|Additionally|Further(more)?|Moreover)\b/i.test(x));
  return { intro, heads: [...new Set(heads)] };
}
const secSubs = (cik) => cached("sec:subs:" + cik, 3600e3, () => secGet(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`));
const secCik = async (sym) => { sym = String(sym || "").toUpperCase().replace("-", "."); if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(sym)) throw new Error("bad symbol"); const m = await secTickers(), h = m[sym] || m[sym.replace(".", "-")]; return h ? { sym, cik: h.cik, name: h.name } : null; };
const edgarUrl = (cik, acc, doc) => `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${doc}`;
// risk headlines of one 10-K document, cached for a day (shared by the crawler and the year-over-year risk comparison)
const tenKRisks = (url) => cached("sec:rh2:" + url, 24 * 3600e3, async () => riskHeadlines(secSection(htmlToText(await secText(url)), /Item\s*1A\.?\s*\n?\s*Risk\s*Factors/gi, /Item\s*1B\.?|Item\s*1C\.?|Item\s*2\.?\s*\n?\s*Properties/gi)));
async function filingDoc(sym) {
  sym = String(sym || "").toUpperCase().replace("-", ".");
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(sym)) throw new Error("bad symbol");
  return cached("sec:doc:" + sym, 24 * 3600e3, async () => {
    const f = await secFundamentals(sym); if (!f.available) return { ...f, text: null };
    const out = { ...f, filing: null, text: null };
    try {
      const sub = await secSubs(f.cik), r = sub.filings && sub.filings.recent;
      const i = r ? r.form.findIndex((x) => x === "10-K" || x === "20-F" || x === "40-F") : -1;
      if (i >= 0) {
        const acc = r.accessionNumber[i], url = `https://www.sec.gov/Archives/edgar/data/${f.cik}/${acc.replace(/-/g, "")}/${r.primaryDocument[i]}`;
        out.filing = { form: r.form[i], accession: acc, filed: r.filingDate[i], period: r.reportDate[i], url, fiscalYearEnd: sub.fiscalYearEnd || null, exchange: (sub.exchanges || [])[0] || null, sic: sub.sicDescription || null };
        const text = htmlToText(await secText(url));
        const paras = (t) => t.split("\n").map((x) => x.trim()).filter((x) => x.length > 40);
        const biz = secSection(text, /Item\s*1\.?\s*\n?\s*Business/gi, /Item\s*1A\.?\s*\n?\s*Risk\s*Factors/gi);
        const risk = secSection(text, /Item\s*1A\.?\s*\n?\s*Risk\s*Factors/gi, /Item\s*1B\.?|Item\s*1C\.?|Item\s*2\.?\s*\n?\s*Properties/gi);
        const mdna = secSection(text, /Item\s*7\.?\s*\n?\s*Management.{0,3}s\s*Discussion/gi, /Item\s*7A\.?|Item\s*8\.?\s*\n?\s*Financial\s*Statements/gi);
        const clip = (x, n) => (x.length > n ? x.slice(0, n).replace(/\s+\S*$/, "") + "…" : x);
        const bizP = paras(biz.replace(/^Item\s*1\.?\s*Business/i, "")).filter((x) => !/^(Company Background|General|Overview|Business)$/i.test(x)).slice(0, 3).map((x) => clip(x, 600));
        // risk-factor headlines: one-sentence paragraphs (bold titles in the filing) between 50 and 300 characters
        const riskP = paras(risk.replace(/^Item\s*1A\.?\s*Risk\s*Factors/i, ""));
        const intro0 = riskP.find((x) => x.length > 120) || "";
        const rh = riskHeadlines(risk); cached("sec:rh2:" + url, 24 * 3600e3, async () => rh).catch(() => {});
        const heads = rh.heads.slice(0, 10);
        const intro = intro0;
        const sents = mdna.replace(/\n/g, " ").split(/(?<=[.!?])\s+(?=[A-Z“"])/).map((x) => x.trim());
        const guide = sents.filter((x) => x.length >= 70 && x.length <= 320 && /\b(expects?|anticipates?|outlook|plans? to|intends? to|believes?[^.]{0,80}\bwill\b|will continue to|guidance|forecast)\b/i.test(x) && !/forward-looking statements|Private Securities Litigation|Part I, Item 1A/i.test(x)).slice(0, 6).map((x) => clip(x, 320));
        const mdIntro = paras(mdna.replace(/^Item\s*7\.?[^\n]*/i, "")).filter((x) => x.length > 150).slice(0, 2).map((x) => clip(x, 520));
        out.text = { business: bizP, riskIntro: clip(intro, 420), risks: heads, mdna: mdIntro, guidance: guide };
      }
    } catch (e) { out.textError = String(e.message || e); }
    return out;
  });
}

// ---------------------------------------------------------------- document intelligence: three more crawler modes
// 1) Insider scanner — the company's Form 4 filings from the last 12 months (who traded, buy or sell, size, price,
//    10b5-1 plan or not). Form 4 XML is structured, so this is exact. Up to 30 filings, cached 6 hours.
// value of a Form 4 field: <tag><value>x</value>…</tag> (footnote references can sit beside the value) or <tag>x</tag>
const xv = (x, tag) => { const m = x.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i")); if (!m) return null; const v = m[1].match(/<value>\s*([^<]*?)\s*<\/value>/i); return (v ? v[1] : m[1].replace(/<[^>]+>/g, "")).trim(); };
async function insiderScan(symIn) {
  const id = await secCik(symIn); if (!id) return { symbol: String(symIn).toUpperCase(), available: false, reason: "Not an SEC filer." };
  return cached("sec:ins:" + id.sym, 6 * 3600e3, async () => {
    const r = (await secSubs(id.cik)).filings.recent, since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10), picks = [];
    for (let i = 0; i < r.form.length && picks.length < 30; i++) if ((r.form[i] === "4" || r.form[i] === "4/A") && r.filingDate[i] >= since) picks.push(i);
    const filings = [];
    for (const i of picks) {
      const url = edgarUrl(id.cik, r.accessionNumber[i], r.primaryDocument[i].replace(/^xsl[^/]+\//, ""));
      try {
        const x = await secText(url, 2e6);
        const owner = (x.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/i) || [""])[0], foot = {};
        for (const m of x.matchAll(/<footnote id="(F\d+)">([\s\S]*?)<\/footnote>/gi)) foot[m[1]] = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const role = [xv(owner, "isDirector") === "1" || xv(owner, "isDirector") === "true" ? "Director" : null, xv(owner, "officerTitle"), xv(owner, "isTenPercentOwner") === "1" || xv(owner, "isTenPercentOwner") === "true" ? "10% owner" : null].filter(Boolean);
        const plan = /<aff10b5One>\s*(1|true)\s*<\/aff10b5One>/i.test(x);
        const tx = [...x.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)].map((m) => {
          const t = m[1], code = xv(t, "transactionCode"), sh = +xv(t, "transactionShares") || 0, px = +xv(t, "transactionPricePerShare") || 0;
          const fids = [...t.matchAll(/footnoteId id="(F\d+)"/gi)].map((f) => f[1]), notes = fids.map((f) => foot[f] || "").join(" ");
          return { date: xv(t, "transactionDate"), code, ad: xv(t, "transactionAcquiredDisposedCode"), shares: sh, price: px, value: +(sh * px).toFixed(2), after: +xv(t, "sharesOwnedFollowingTransaction") || null, direct: xv(t, "directOrIndirectOwnership") !== "I", security: xv(t, "securityTitle"), plan10b51: plan || /10b5-1/i.test(notes) };
        }).filter((t) => t.code && t.shares > 0);
        filings.push({ filed: r.filingDate[i], accession: r.accessionNumber[i], url: edgarUrl(id.cik, r.accessionNumber[i], r.primaryDocument[i]), owner: (xv(owner, "rptOwnerName") || "").replace(/\s+/g, " "), role: role.join(", ") || "Other", officer: /chief|ceo|cfo|coo|president|officer|chair|evp|svp|vice president|general counsel|treasurer|controller/i.test(role.join(" ")), tx });
      } catch (e) { /* skip one unreadable filing */ }
    }
    return { symbol: id.sym, available: true, name: id.name, cik: id.cik, since, filings, source: "SEC EDGAR Form 4 filings (last 12 months, up to 30 most recent)" };
  });
}
// 2) Earnings release auditor — the latest 8-K under Item 2.02 (results) and its press-release exhibit (EX-99.1):
//    every sentence tagged bullish, cautious/hedging or guidance, guidance figures pulled out, management quotes found.
const TONE_UP = /\b(record|records|grew|grow(s|ing)?|growth|increase[ds]?|rose|strong(er|est)?|exceed(ed|s)?|beat|raised|raising|accelerat\w*|momentum|all-time|robust|expan(d|ded|ding|sion)|outperform\w*|double-digit|best-ever|surpass\w*|exceptional|healthy)\b/i;
const TONE_DN = /\b(headwinds?|uncertain(ty|ties)?|challeng\w*|softness|soft(er)?|cautious(ly)?|declin\w*|decreas\w*|lower|weak(er|ness)?|pressures?|volatil\w*|tariffs?|macro(economic)?|slow(er|ing|down)?|lumpy|visibility|impairment|restructuring|disruption|constrain\w*|shortfall|down \d)/i;
const TONE_GUIDE = /\b(expects?|expected|outlook|guidance|anticipates?|forecast|projects?|projected|plans? to|targets?)\b/i;
const relPeriod = (t) => (t.match(/\b(first|second|third|fourth) (fiscal )?quarter( of fiscal \d{4}| of \d{4}| \d{4})?|\b(fiscal|full[- ]year|calendar) (year )?\d{4}|\bfull[- ]year\b|\bQ[1-4]( F?Y?\d{2,4})?\b/i) || [""])[0];
function releaseGuidance(sent, lastPer) {
  const out = [], per = relPeriod(sent);
  const add = (metric, m, unit) => m && out.push({ metric, value: m[1].replace(/,/g, "") + (unit || (m[2] ? " " + m[2].toLowerCase() : "")), range: m[3] ? m[3].trim() : null, period: per || lastPer || null });
  add("Revenue", sent.match(/\b(?:revenue|net sales|total sales|sales)\b[^.;]{0,70}?\$\s?([\d.,]+)\s?(billion|million)?(\s*(?:(?:,?\s*plus or minus\s*[\d.]+\s?(?:%|percent))|±|to \$?[\d.,]+\s?(?:billion|million)?))?/i));
  add("Gross margin", sent.match(/\bgross margins?\b[^.;]{0,60}?([\d.]+)\s?(?:%|percent)()(\s*(?:(?:,?\s*plus or minus\s*[\d.]+\s?(?:%|percent))|±|to [\d.]+\s?(?:%|percent)))?/i), "%");
  add("Operating margin", sent.match(/\boperating margins?\b[^.;]{0,60}?([\d.]+)\s?(?:%|percent)()(\s*(?:to [\d.]+\s?(?:%|percent)))?/i), "%");
  add("Operating expenses", sent.match(/\boperating expenses\b[^.;]{0,60}?\$\s?([\d.,]+)\s?(billion|million)?(\s*(?:to \$?[\d.,]+\s?(?:billion|million)?))?/i));
  add("EPS", sent.match(/\b(?:earnings per (?:diluted )?share|EPS)\b[^.;]{0,60}?\$\s?([\d.]+)()(\s*(?:to \$?[\d.]+))?/i), " $/share");
  add("Capital expenditures", sent.match(/\b(?:capital expenditures|capex)\b[^.;]{0,60}?\$\s?([\d.,]+)\s?(billion|million)?(\s*(?:to \$?[\d.,]+\s?(?:billion|million)?))?/i));
  add("Tax rate", sent.match(/\btax rate\b[^.;]{0,60}?([\d.]+)\s?(?:%|percent)()(\s*(?:(?:,?\s*plus or minus\s*[\d.]+\s?(?:%|percent))|±|to [\d.]+\s?(?:%|percent)))?/i), "%");
  return out;
}
async function earningsRelease(symIn) {
  const id = await secCik(symIn); if (!id) return { symbol: String(symIn).toUpperCase(), available: false, reason: "Not an SEC filer." };
  return cached("sec:er3:" + id.sym, 6 * 3600e3, async () => {
    const r = (await secSubs(id.cik)).filings.recent;
    const i = r.form.findIndex((f, k) => (f === "8-K" || f === "6-K") && /2\.02/.test(r.items ? r.items[k] || "" : ""));
    if (i < 0) return { symbol: id.sym, available: false, name: id.name, reason: "No earnings press release (8-K, Item 2.02) found in the company's recent filings." };
    const acc = r.accessionNumber[i], dir = `https://www.sec.gov/Archives/edgar/data/${id.cik}/${acc.replace(/-/g, "")}/`;
    // the filing index page labels every file's type, so the press release is the row typed EX-99.1 (or the first EX-99.x)
    let ex = null;
    try {
      const ix = await secText(dir + acc + "-index.htm", 1e6), rows = [...ix.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
      const pick = (re) => { for (const row of rows) { const t = row.match(/<td[^>]*>\s*(EX-[\d.A-Z]+)\s*<\/td>/i), h = row.match(/href="([^"]+\.html?)"/i); if (t && h && re.test(t[1])) return h[1].split("/").pop(); } return null; };
      ex = pick(/^EX-99\.0?1$/i) || pick(/^EX-99/i);
    } catch {}
    if (!ex) { const idx = await secGet(dir + "index.json"), items = ((idx.directory && idx.directory.item) || []).filter((x) => /\.html?$/i.test(x.name) && x.name !== r.primaryDocument[i] && !/^R\d+\.htm/i.test(x.name));
      ex = (items.find((x) => /ex-?99[-_.]?0?1\b|ex99[-_]?1|exhibit-?99[-_.]?1|ex991|_991\b|991\./i.test(x.name)) || items.sort((a, b) => (+b.size || 0) - (+a.size || 0))[0] || {}).name || r.primaryDocument[i]; }
    const url = dir + ex, text = htmlToText(await secText(url, 6e6));
    // narrative paragraphs only (financial tables come out as rows of numbers)
    const paras = text.split("\n").map((x) => x.trim()).filter((x) => x.length > 60 && (x.match(/\d/g) || []).length / x.length < 0.18 && !/^(This press release contains|Forward-Looking Statements|Safe Harbor|About [A-Z])/i.test(x)).slice(0, 45);
    const out = [], guide = []; let lastPer = null, title = (text.split("\n").map((x) => x.trim()).find((x) => x.length > 20 && x.length < 200 && !/\.html?\b|^exhibit|securities and exchange|^form\b|^press release$|^\d|^(for immediate release|news release|contacts?:?)\b/i.test(x)) || "Earnings press release").slice(0, 200);
    for (const p of paras) {
      const said = p.match(/[”"]\s*,?\s*(?:said|says)\s+([A-Z][\w.'’ -]{2,40}?),\s*([^.,”"]{3,80})/) || p.match(/(?:said|says)\s+([A-Z][\w.'’ -]{2,40}?),\s*([^.,”"]{3,80})/);
      const speaker = said ? (/chief executive|ceo|president/i.test(said[2]) ? "CEO" : /chief financial|cfo/i.test(said[2]) ? "CFO" : said[2].trim().slice(0, 40)) + " — " + said[1].trim() : /\boutlook|guidance|expects?\b/i.test(p) ? "Outlook" : "Release";
      const sents = p.split(/(?<=[.!?”])\s+(?=[A-Z“"])/).filter((x) => x.length > 25).map((t) => {
        const g = TONE_GUIDE.test(t) && /(\$|%|percent|billion|million|quarter|fiscal|year)/i.test(t), up = TONE_UP.test(t), dn = TONE_DN.test(t);
        const tone = g ? "guide" : dn && !up ? "bear" : up && !dn ? "bull" : up && dn ? "mixed" : null, hedge = dn ? (t.match(TONE_DN) || [""])[0].toLowerCase() : null;
        if (TONE_GUIDE.test(t) && relPeriod(t)) lastPer = relPeriod(t);
        if (g) for (const x of releaseGuidance(t, lastPer)) { guide.push({ ...x, text: t.slice(0, 300) }); if (x.period) lastPer = x.period; }
        return { text: t.slice(0, 420), tone, hedge };
      });
      if (sents.length) out.push({ speaker, sents });
    }
    return { symbol: id.sym, available: true, name: id.name, cik: id.cik, title, filing: { form: r.form[i], filed: r.filingDate[i], period: r.reportDate[i] || null, accession: acc, url, items: r.items[i] }, paragraphs: out, guidance: guide.slice(0, 12), source: "SEC EDGAR 8-K Item 2.02 earnings press release (EX-99.1)" };
  });
}
// 3) Risk-factor comparison — this year's 10-K Item 1A headlines against last year's: new, removed, reworded.
const RK_STOP = new Set("the a an and or of to in on for with our we us its it is are be may could can by as from that this which have has other such any including or not will would than these".split(" "));
const rkWords = (t) => new Set(t.toLowerCase().replace(/[’']/g, "").replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !RK_STOP.has(w)));
const rkSim = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, a.size + b.size - n); };
// containment: how much of the shorter headline appears in the longer one (catches shortened or extended rewrites)
const rkCont = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n++; return n / Math.max(1, Math.min(a.size, b.size)); };
async function riskDiff(symIn) {
  const id = await secCik(symIn); if (!id) return { symbol: String(symIn).toUpperCase(), available: false, reason: "Not an SEC filer." };
  return cached("sec:rd2:" + id.sym, 24 * 3600e3, async () => {
    const r = (await secSubs(id.cik)).filings.recent, ks = [];
    for (let i = 0; i < r.form.length && ks.length < 2; i++) if (r.form[i] === "10-K") ks.push(i);
    if (ks.length < 2) return { symbol: id.sym, available: false, name: id.name, reason: "Needs two 10-K filings to compare." };
    const meta = (i) => ({ filed: r.filingDate[i], period: r.reportDate[i], url: edgarUrl(id.cik, r.accessionNumber[i], r.primaryDocument[i]) });
    const cur = meta(ks[0]), prev = meta(ks[1]), A = await tenKRisks(cur.url), B = await tenKRisks(prev.url);
    const bw = B.heads.map((h) => ({ h, w: rkWords(h), used: false })), heads = [];
    for (const h of A.heads) {
      const w = rkWords(h); let best = null, bs = 0;
      for (const b of bw) { if (b.used) continue; const s = Math.max(rkSim(w, b.w), rkCont(w, b.w) >= 0.8 ? 0.6 : 0); if (s > bs) { bs = s; best = b; } }
      if (best && bs >= 0.5) { best.used = true; const j = rkSim(w, best.w); heads.push({ text: h, status: j >= 0.86 ? "same" : "reworded", before: j >= 0.86 ? null : best.h, sim: +j.toFixed(2) }); }
      else heads.push({ text: h, status: "new", sim: +bs.toFixed(2) });
    }
    const removed = bw.filter((b) => !b.used).map((b) => b.h);
    return { symbol: id.sym, available: A.heads.length > 0, name: id.name, cik: id.cik, current: { ...cur, count: A.heads.length }, prior: { ...prev, count: B.heads.length }, intro: A.intro.slice(0, 500), heads, removed,
      reason: A.heads.length ? null : "Couldn't find risk-factor headlines in this 10-K.", source: "Item 1A of the two most recent 10-K filings on SEC EDGAR" };
  });
}

// ---- filing alerts: each company's latest 10-K, 10-Q, earnings release (8-K Item 2.02) and insider filing (Form 4)
async function latestFilings(symbols) {
  const out = {};
  for (const raw of symbols.slice(0, 40)) {
    try {
      const id = await secCik(raw); if (!id) continue;
      const r = (await secSubs(id.cik)).filings.recent, first = (test) => { for (let i = 0; i < r.form.length; i++) if (test(i)) return i; return -1; };
      const pick = (i, extra) => (i < 0 ? null : { date: r.filingDate[i], form: r.form[i], period: r.reportDate[i] || null, url: edgarUrl(id.cik, r.accessionNumber[i], r.primaryDocument[i]), acc: r.accessionNumber[i], ...extra });
      const k = first((i) => r.form[i] === "10-K" || r.form[i] === "20-F"), q = first((i) => r.form[i] === "10-Q"), er = first((i) => (r.form[i] === "8-K" || r.form[i] === "6-K") && /2\.02/.test((r.items && r.items[i]) || "")), f4 = first((i) => r.form[i] === "4");
      const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      out[raw] = { name: id.name, k: pick(k), q: pick(q), er: pick(er), f4: pick(f4, { n30: r.form.filter((f, i) => f === "4" && r.filingDate[i] >= since).length }) };
    } catch { /* skip one */ }
  }
  return { updated: Date.now(), filings: out };
}

// Fast path: if the full filing (numbers + text) is ready, send it; otherwise send the numbers now (usually cached or
// one SEC request) with pending: true, and keep downloading the 10-K text in the background for the follow-up request.
const FDOC = new Map(); // symbol → { t, v } once the full document has been built
function filingKick(sym) {
  const k = String(sym || "").toUpperCase().replace("-", ".");
  const run = filingDoc(k).then((v) => { FDOC.set(k, { t: Date.now(), v }); if (FDOC.size > 300) FDOC.delete(FDOC.keys().next().value); return v; });
  run.catch(() => {}); return run;
}
async function filingFast(sym) {
  const k = String(sym || "").toUpperCase().replace("-", "."), hit = FDOC.get(k);
  if (hit && Date.now() - hit.t < 20 * 3600e3) return hit.v;
  const full = filingKick(k);
  const quick = await Promise.race([full.then((v) => ({ v })), new Promise((ok) => setTimeout(() => ok(null), 400))]); // already cached → full doc
  if (quick) return quick.v;
  const f = await secFundamentals(k);
  return f.available ? { ...f, filing: null, text: null, pending: true } : f;
}
// warm the crawler's quick picks a minute after start (one at a time through the polite SEC queue)
setTimeout(async () => { for (const s of ["AAPL", "NVDA", "MSFT", "TSLA", "AMZN", "JPM"]) { try { await filingKick(s); } catch {} } }, 60_000);

// ---------------------------------------------------------------- long price history for backtests and stress tests
// Daily or weekly closes plus Yahoo's dividend-and-split adjusted closes ("adj") between two dates.
// Cached for 6 hours; the backtester and risk tools run their math in the browser.
// Yahoo throttles bursts of long-history downloads from one IP, so they go through a small queue:
// at most 2 at a time, spaced 150 ms apart.
const YQ = { active: 0, wait: [], last: 0 };
function yahooChartQueue(fn) {
  return new Promise((resolve, reject) => {
    const go = async () => { YQ.active++; const gap = Math.max(0, YQ.last + 150 - Date.now()); if (gap) await new Promise((ok) => setTimeout(ok, gap)); YQ.last = Date.now();
      try { resolve(await fn()); } catch (e) { reject(e); } finally { YQ.active--; const n = YQ.wait.shift(); if (n) n(); } };
    if (YQ.active < 2) go(); else YQ.wait.push(go);
  });
}
// One canonical download per symbol per day (from Jan 1 of the requested start year to today), shared by every page
// that asks for any slice of it; the requested window is cut from that copy.
async function longHistory(sym, from, to, interval) {
  const today = new Date().toISOString().slice(0, 10), iv = interval === "1wk" ? "1wk" : interval === "1mo" ? "1mo" : "1d";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) throw new Error("bad dates");
  if (to < today) return fetchLongHistory(sym, from, to, interval); // a fixed past window: cache it as asked
  const y = +from.slice(0, 4), canon = `${y - (y % 2)}-01-01`; // even years, so nearby start dates share one copy
  const full = await fetchLongHistory(sym, canon, today, iv), lo = Date.parse(from + "T00:00:00Z") / 1000, hi = Date.parse(to + "T23:59:59Z") / 1000, keep = [];
  full.t.forEach((t, i) => { if (t >= lo && t <= hi) keep.push(i); });
  if (!keep.length) throw new Error("no history in that window");
  return { ...full, t: keep.map((i) => full.t[i]), close: keep.map((i) => full.close[i]), adj: full.adj ? keep.map((i) => full.adj[i]) : null };
}
async function fetchLongHistory(sym, from, to, interval, closeMinute = null) {
  const p1 = Math.floor(Date.parse(from + "T00:00:00Z") / 1000), p2 = Math.floor(Date.parse(to + "T23:59:59Z") / 1000);
  if (!isFinite(p1) || !isFinite(p2) || p2 <= p1) throw new Error("bad dates");
  const iv = interval === "1wk" ? "1wk" : interval === "1mo" ? "1mo" : "1d";
  const key = `lh:${sym}:${p1}:${p2}:${iv}` + (closeMinute == null ? "" : ":final-close");
  return cached(key, 6 * 3600e3, async () => {
    let j = null, err;
    // alternate hosts and back off when Yahoo throttles a burst (429 / 5xx / timeouts)
    for (const [i, host] of ["query1", "query2", "query1", "query2"].entries()) {
      try {
        if (i) await new Promise((ok) => setTimeout(ok, [0, 700, 2000, 4500][i]));
        j = JSON.parse(await yahooChartQueue(() => get(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=${iv}&events=div%2Csplit`, "application/json")));
        if (j.chart && j.chart.result && j.chart.result[0]) break;
      } catch (e) { err = e; j = null; }
    }
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) throw err || new Error((j && j.chart && j.chart.error && j.chart.error.description) || "no history");
    const q = r.indicators.quote[0], adj = (r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || null;
    const t = [], c = [], a = [];
    r.timestamp.forEach((ts, i) => { if (q.close[i] == null) return; t.push(ts); c.push(+q.close[i].toFixed(4)); a.push(adj && adj[i] != null ? +adj[i].toFixed(4) : null); });
    if (closeMinute != null) {
      const sourceTime = r.meta.regularMarketTime;
      if (!t.length || !(c.at(-1) > 0) || !(sourceTime > 0)) throw new Error("Final daily close unavailable");
      const closeStamp = etParts(new Date(sourceTime * 1000)), barDay = etParts(new Date(t.at(-1) * 1000)).day;
      if (barDay !== to || closeStamp.day !== to || closeStamp.min < closeMinute - 1) throw new Error("Final daily close unavailable");
    }
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
getT = HEALTH.track(getT, (url) => url);
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
function treasuryYearCsv(year, currentYear) {
  return cached("ust:" + year, year < currentYear ? 7 * 864e5 : 6 * 3600e3, () =>
    getT(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`, "text/csv", 10000));
}
async function treasuryYields() {
  return cached("ust:all", 6 * 3600e3, async () => {
    const y0 = new Date().getUTCFullYear(), rows = [];
    for (let y = y0 - 9; y <= y0; y++) {
      const csv = await treasuryYearCsv(y, y0);
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

// ---------------------------------------------------------------- THE WEB: the autonomous research Spider (web/)
// Runs inside this server on a timer (no browser needed). It reads the same internal services the site uses — never
// crawls this site's own pages — and stores its research in Upstash (if configured) or the server's temp folder.
// It only READS the trading bots' state; it has no access to apTrade/dtOpen and never places trades.
const { createSpider } = require("./web/spider.js");
const { createStore: createWebStore } = require("./web/store.js");
// ---------------------------------------------------------------- DESK: the owner's personal data (Home layouts,
// Investor DNA, theses, journal, …). One JSON doc, last-writer-wins by `updated`. Same free storage as THE WEB.
const DESK_STORE = createWebStore({ url: UP_URL, token: UP_TOKEN, prefix: "pft:desk:v1:" });
const DESK_KEYS = new Set(["home", "dna", "theses", "journal", "alerts", "tournaments", "learning", "pitches", "workspaces", "memory", "prefs"]);
function deskValidate(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "bad data";
  if (!Number.isFinite(doc.updated) || doc.updated <= 0 || doc.updated > Date.now() + 5 * 60e3) return "bad timestamp";
  if (!doc.data || typeof doc.data !== "object" || Array.isArray(doc.data)) return "bad data";
  for (const k of Object.keys(doc.data)) if (!DESK_KEYS.has(k)) return "unknown section: " + String(k).slice(0, 40);
  return null;
}
async function deskRoute(req, res) {
  try {
    if (req.method === "GET") { const doc = await DESK_STORE.get("doc"); return send(res, 200, { doc: doc || null, durable: DESK_STORE.durable }); }
    if (req.method === "PUT") {
      let doc; try { doc = await readBody(req, 800_000); } catch { return send(res, 413, { error: "Too much data" }); }
      const bad = deskValidate(doc); if (bad) return send(res, 400, { error: bad });
      const cur = await DESK_STORE.get("doc");
      if (cur && cur.updated > doc.updated && !/[?&]force=1/.test(req.url)) return send(res, 409, { error: "newer", doc: cur });
      await DESK_STORE.set("doc", { updated: doc.updated, data: doc.data });
      return send(res, 200, { ok: true, durable: DESK_STORE.durable });
    }
    return send(res, 405, { error: "method not allowed" });
  } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
}
const SPIDER_W = Math.max(0, Math.min(0.15, process.env.SPIDER_TRADER_WEIGHT != null ? +process.env.SPIDER_TRADER_WEIGHT || 0 : 0.05));
const SPIDER = process.env.SPIDER_OFF || !DEPLOY.runJobs ? null : createSpider({ // local mode: THE WEB runs on the public server
  store: createWebStore({ url: UP_URL, token: UP_TOKEN }),
  sp500List: SP500, holidays: NYSE_HOLIDAYS, earlyClose: NYSE_EARLY,
  quotes: (syms) => getQuotes(syms),
  history: (sym, range) => history(sym, range),
  news: (tickers, range) => getNews(tickers, range),
  trending: () => getTrending(),
  smart: () => getSmart(),
  sp500: () => sp500Snapshot(),
  earnings: (syms) => earningsCalendar(syms),
  earningsActuals: () => apEarnings(),
  macro: () => macroData(),
  filings: (syms) => latestFilings(syms),
  release: (sym) => earningsRelease(sym),
  insiders: (sym) => insiderScan(sym),
  fundamentals: (sym) => secFundamentals(sym),
  health: (y, p) => FINS.health(y, p),
  analyst: (sym) => { const r = BB.ratings[String(sym).replace("-", ".")]; return r && r.n >= BB_MIN_N ? { adj: bbAdj(r), n: r.n } : null; },
  trader: () => (apLoaded ? { positions: AP.positions, lastScan: AP.lastScan || null, plan: AP.plan || null, trades: (AP.trades || []).slice(0, 60), value: null } : null), // read-only view
  tone: (title) => apTone(title),
  matcher: (sym, name) => apMatcher(sym, name),
  sourceName: (k) => (SOURCES[k] ? SOURCES[k].name : k),
});
if (SPIDER) SPIDER.start(15e3, process.env.SPIDER_FIRST_DELAY_MS ? +process.env.SPIDER_FIRST_DELAY_MS : 45e3);
const webManual = { briefing: 0, run: [] };
async function webRoute(req, res, u) {
  if (!SPIDER) return send(res, 503, { error: "THE WEB is turned off (SPIDER_OFF is set)." });
  await SPIDER.load();
  const p = u.pathname.slice("/api/web/".length), qp = (k) => u.searchParams.get(k);
  if (p === "status") return send(res, 200, SPIDER.status());
  if (p === "context" && req.method === "POST") { let b = {}; try { b = await readBody(req); } catch { return send(res, 400, { error: "bad data" }); } return send(res, 200, SPIDER.setContext(b || {})); }
  if (p === "discoveries") return send(res, 200, SPIDER.discoveries({ group: qp("group"), cat: qp("cat"), q: qp("q") ? String(qp("q")).slice(0, 60) : null, mine: qp("mine") === "1", ai: qp("ai") === "1", explore: qp("explore") === "1", min: +qp("min") || 0, since: +qp("since") || 0, symbols: parseList(qp("symbols"), 60), limit: +qp("limit") || 60, sort: qp("sort") }));
  if (p === "discovery") { const d = SPIDER.getDiscovery(String(qp("id") || "")); return d ? send(res, 200, d) : send(res, 404, { error: "not found" }); }
  if (p === "briefings") return send(res, 200, await SPIDER.briefings({ q: qp("q") ? String(qp("q")).slice(0, 60) : null, from: /^\d{4}-\d{2}-\d{2}$/.test(qp("from") || "") ? qp("from") : null, to: /^\d{4}-\d{2}-\d{2}$/.test(qp("to") || "") ? qp("to") : null, limit: Math.min(200, +qp("limit") || 60) }));
  if (p === "briefing" && req.method === "GET") { const b = await SPIDER.briefing(String(qp("id") || "latest").slice(0, 60)); return b ? send(res, 200, b) : send(res, 404, { error: "No briefing yet." }); }
  if (p === "briefing/generate" && req.method === "POST") {
    if (Date.now() - webManual.briefing < 90e3) return send(res, 429, { error: "A briefing was just requested — give it a minute." });
    webManual.briefing = Date.now();
    const s = SPIDER.session(), slot = s.min < 12 * 60 ? "morning" : s.min < 16 * 60 + 10 ? "midday" : "close";
    SPIDER.runNow("briefing", null, { slot, reason: "you pressed Generate briefing" }).catch(() => {});
    return send(res, 202, { started: true, slot });
  }
  if (p === "summary") return send(res, 200, await SPIDER.liveSummary());
  if (p === "signals") return send(res, 200, { ...SPIDER.researchSignals({ symbols: parseList(qp("symbols"), 40) }), traderWeight: SPIDER_W, traderUse: SPIDER_W > 0 ? `The swing bot adds at most ±${SPIDER_W.toFixed(2)} to a stock's ranking score from the spider's insider, earnings and sector-news findings (paper money only).` : "The bots don't use spider research right now (SPIDER_TRADER_WEIGHT is 0)." });
  if (p === "control") { // pause/resume, frequency, monitored companies and sectors, job types, notifications
    if (req.method === "POST") { let b = {}; try { b = await readBody(req); } catch { return send(res, 400, { error: "bad data" }); } return send(res, 200, SPIDER.setCtrl(b || {})); }
    return send(res, 200, SPIDER.status().ctrl);
  }
  if (p === "export") { res.setHeader("Content-Disposition", `attachment; filename="spider-backup-${new Date().toISOString().slice(0, 10)}.json"`); return send(res, 200, SPIDER.exportData()); }
  if (p === "import" && req.method === "POST") { let b = null; try { b = await readBody(req, 8_000_000); } catch (e) { return send(res, 400, { error: "That file is too big or isn't JSON." }); } try { return send(res, 200, await SPIDER.importData(b)); } catch (e) { return send(res, 400, { error: String(e.message || e) }); } }
  if (p === "timeline") { // a company's intelligence timeline: spider findings + SEC filings + headlines, each with a source
    const [sym] = parseList(qp("symbol"), 1); if (!sym) return send(res, 400, { error: "symbol required" });
    const out = SPIDER.timeline(sym).map((x) => ({ ...x, src: "spider" }));
    try { const id = await secCik(sym), sub = await secSubs(id.cik), r = sub.filings.recent, since = Date.now() - 365 * 864e5;
      for (let i = 0; i < r.form.length && out.length < 400; i++) { const f = r.form[i]; if (!/^(8-K|10-Q|10-K|20-F|6-K|DEF 14A|S-1|4)$/.test(f)) continue; const t = Date.parse(r.acceptanceDateTime[i] || r.filingDate[i]); if (t < since) break;
        if (f === "4") continue; const items = String(r.items[i] || "").split(",").map((x) => x.trim()).filter((x) => x && x !== "9.01");
        out.push({ t, src: "sec", cat: f === "8-K" && items.includes("2.02") ? "earnings" : "filing", kind: "fact", headline: `${f}${items.length ? ": " + items.map((x) => ITEMS_8K[x] || "item " + x).join(", ") : f === "10-Q" ? ": quarterly report" : f === "10-K" ? ": annual report" : ""}`, summary: `Filed with the SEC on ${r.filingDate[i]}${r.reportDate[i] ? ` for the period ending ${r.reportDate[i]}` : ""}.`, sources: [{ name: "SEC EDGAR", url: edgarUrl(id.cik, r.accessionNumber[i], r.primaryDocument[i]) }] }); }
      const f4 = r.form.filter((f, i) => f === "4" && Date.parse(r.filingDate[i]) > Date.now() - 90 * 864e5).length; if (f4) out.push({ t: Date.now(), src: "sec", cat: "insider", kind: "fact", headline: `${f4} insider filing${f4 > 1 ? "s" : ""} (Form 4) in the last 90 days`, summary: "Officers and directors must report trades in the company's stock on Form 4.", sources: [{ name: "SEC EDGAR", url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${id.cik}&type=4` }] });
    } catch {}
    try { const news = await fetchFeed(SOURCES.yahoo.ticker(sym)[0]); for (const n of news.slice(0, 15)) out.push({ t: n.time, src: "news", cat: "news", kind: "fact", headline: n.title, summary: "", sources: [{ name: n.publisher || "Yahoo Finance", url: n.link }], tone: sentiment(n.title) }); } catch {}
    out.sort((a, b) => (b.t || 0) - (a.t || 0));
    return send(res, 200, { symbol: sym, items: out.slice(0, 200) });
  }
  if (p === "graph") return send(res, 200, SPIDER.graph({ focus: qp("focus") ? String(qp("focus")).slice(0, 80) : null }));
  if (p === "trader") return send(res, 200, { ...SPIDER.traderView(), weight: SPIDER_W, explain: SPIDER_W > 0 ? `Spider research nudges the swing bot's ranking score by at most ±${SPIDER_W.toFixed(2)} (scores run about 0–1), using only inputs the bot doesn't already score: insider buying, earnings-release tone and sector news patterns. Stops, news and trend rules still decide every trade, and the Spider itself never trades.` : "The Spider shares research with AI Trader for display only (SPIDER_TRADER_WEIGHT is 0, so it doesn't change the bot's scores)." });
  if (p === "research") { const [s] = parseList(qp("symbol"), 1); if (!s) return send(res, 400, { error: "symbol required" }); return send(res, 200, SPIDER.packet(s)); }
  if (p === "run" && req.method === "POST") {
    let b = {}; try { b = await readBody(req); } catch {}
    webManual.run = webManual.run.filter((t) => Date.now() - t < 10 * 60e3); if (webManual.run.length >= 12) return send(res, 429, { error: "Too many manual research requests — try again in a few minutes." });
    const ALLOW = new Set(["company_snapshot", "investigate_mover", "fundamentals", "insiders", "earnings_release", "portfolio_scan", "market_pulse", "news_sweep", "policy_watch", "macro_check", "earnings_watch", "filings_watch", "explore", "ai_trader_sync"]);
    const type = String(b.type || "company_snapshot"), [sym] = parseList(b.symbol, 1);
    if (!ALLOW.has(type)) return send(res, 400, { error: "unknown research type" });
    webManual.run.push(Date.now());
    const j = SPIDER.enqueue(type, sym || null, { boost: 1, force: true, reason: "you asked for this research", manual: true });
    return j ? send(res, 202, { queued: true, id: j.id, label: type }) : send(res, 400, { error: "Couldn't queue that (needs a valid symbol, or it's already running)." });
  }
  if (p === "ask" && req.method === "POST") {
    let b = {}; try { b = await readBody(req); } catch {}
    let claudeFn = null;
    if (b.useClaude && process.env.ANTHROPIC_API_KEY) { // optional, spends credits: same password gate and caps as every other Claude feature
      const g = claudeGate(req, req.headers["x-claude-pass"]); if (g) return send(res, ...g);
      if (!ipAllowed(req)) return send(res, 429, { error: "Hourly Claude limit reached." });
      claudeFn = async (prompt) => { const j = await anthropic(process.env.ANTHROPIC_API_KEY, { model: MODEL, max_tokens: 900, system: "You are a careful financial research assistant. Use only the evidence given. Cite as [n]. Never invent numbers.", messages: [{ role: "user", content: prompt }] }); return (j.content || []).filter((x) => x.type === "text").map((x) => x.text).join(""); };
    }
    let opts = { claude: claudeFn };
    if (!claudeFn && GEMINI_KEY) // free Gemini writes the answer from the cited evidence (and handles plain-English questions)
      opts = { claude: (prompt) => gemini({ system: "You are a careful financial research assistant. Use only the evidence given. Cite as [n]. Never invent numbers.", text: prompt, maxTokens: 900 }), modelName: "gemini", general: true };
    try { return send(res, 200, { ...(await SPIDER.ask(String(b.question || "").slice(0, 600), opts)), ai: geminiInfo() }); }
    catch (e) { return send(res, 502, { error: String(e.message || e) }); }
  }
  return send(res, 404, { error: "unknown THE WEB endpoint" });
}

// ---------------------------------------------------------------- data integrity + system health
// /api/pub/integrity?symbol=  — validation report for a company's SEC data and its quote (public data, public route)
// /api/pub/integrity/status   — the small header indicator: current / delayed / stale / unavailable
// /api/system/health          — owner-only System Health page (sources, errors, freshness, scheduler, bots, CI)
let INTEG_STORE = null;
const integStore = () => INTEG_STORE || (INTEG_STORE = createWebStore({ url: UP_URL, token: UP_TOKEN, prefix: "pft:integrity:v1:" }));
function sessionInfo() { const t = etParts(); return { ...t, open: !(t.wd === "Sat" || t.wd === "Sun") && !NYSE_HOLIDAYS.has(t.day) && t.min >= 570 && t.min < (NYSE_EARLY.has(t.day) ? 780 : 960) }; }
async function integrityReport(symIn) {
  const sym = String(symIn || "").toUpperCase().trim();
  const f = await secFundamentals(sym);
  let prev = null; if (f.available) { try { prev = await integStore().get("snap:" + f.symbol); } catch {} }
  const rep = INTEG.fundamentalsReport(f, { ratiosFn: FINS.ratios, previousSnapshot: prev });
  if (rep.available) { // revision tracking: compare with what we stored last time, keep a log of changes
    if (!prev || JSON.stringify(prev) !== JSON.stringify(rep.snapshot)) { try { await integStore().set("snap:" + f.symbol, rep.snapshot); } catch {} }
    let log = []; try { log = (await integStore().get("rev:" + f.symbol)) || []; } catch {}
    if (rep.revisions.length) { log = [...rep.revisions, ...log].slice(0, 60); try { await integStore().set("rev:" + f.symbol, log); } catch {} }
    rep.revisionLog = log; rep.firstCheck = !prev; delete rep.snapshot;
  }
  const ys = sym.replace(".", "-"), ses = sessionInfo();
  let q = null; try { q = (await getQuotes([ys])).quotes[ys]; } catch {}
  const quote = { symbol: ys, price: q && q.price != null ? q.price : null, marketTime: (q && q.marketTime) || null, ...INTEG.classifyQuote(q, { marketOpen: ses.open }), source: "Yahoo Finance chart API (unadjusted last price)", retrieved: Date.now() };
  if (FINNHUB && quote.price) { try { const fq = await cached("fhq:" + ys, 60e3, () => fh(`/quote?symbol=${encodeURIComponent(ys.replace("-", "."))}`)); quote.crossCheck = INTEG.crossCheckPrice(quote.price, fq && fq.c); } catch { quote.crossCheck = { status: "skip", detail: "Finnhub didn't answer" }; } }
  else quote.crossCheck = { status: "skip", detail: FINNHUB ? "no price to compare" : "no second price source configured (set FINNHUB_API_KEY)" };
  return { symbol: sym, fundamentals: rep, quote, formula: INTEG.CONFIDENCE_FORMULA, note: INTEG.CONFIDENCE_NOTE };
}
let integStatusCache = null;
async function integrityStatus() {
  if (integStatusCache && Date.now() - integStatusCache.at < 30e3) return integStatusCache.v;
  const ses = sessionInfo(), syms = ["^GSPC", "SPY", "^IXIC", "QQQ", "^VIX"];
  let qs = {}; try { qs = (await getQuotes(syms)).quotes; } catch {}
  const sum = INTEG.summarizeQuotes(syms.map((k) => (qs[k] && !qs[k].error ? qs[k] : { symbol: k, error: true })), { marketOpen: ses.open });
  const label = { current: ses.open ? "Current" : "Current · last close", delayed: "Delayed", stale: "Stale", unavailable: "Unavailable" }[sum.overall];
  const newest = Math.max(0, ...syms.map((k) => (qs[k] && qs[k].marketTime) || 0));
  const v = { status: sum.overall, label, marketOpen: ses.open, checkedAt: Date.now(), newestQuote: newest || null, counts: sum.counts, rows: sum.rows.map((r) => ({ symbol: r.symbol, status: r.status, reason: r.reason })) };
  integStatusCache = { at: Date.now(), v }; return v;
}
let ciCache = null;
async function ciRuns() {
  if (ciCache && Date.now() - ciCache.at < 10 * 60e3) return ciCache.v;
  const repo = process.env.GITHUB_REPO || "phemmerdinger-cmyk/My-Terminal"; let v;
  try {
    const url = `https://api.github.com/repos/${repo}/actions/runs?branch=main&per_page=6`;
    const r = await fetch(url, { headers: { "User-Agent": "Market-Desk-health", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(8000) });
    HEALTH.note(url, r.ok, r.ok ? null : "HTTP " + r.status);
    const j = await r.json();
    v = { repo, runs: (j.workflow_runs || []).map((w) => ({ name: w.name, status: w.status, conclusion: w.conclusion, sha: w.head_sha, at: Date.parse(w.updated_at || w.created_at), url: w.html_url, event: w.event })) };
  } catch (e) { v = { repo, runs: [], error: require("./data/health.js").redact(e.message) }; }
  ciCache = { at: Date.now(), v }; return v;
}
async function systemHealth() {
  const { redact } = require("./data/health.js"), hv = HEALTH.view();
  let feedAt = 0; for (const [k, e] of cache) if (k.startsWith("feed:") && e.at > feedAt) feedAt = e.at;
  const macro = cache.get("macro:all"), sec = hv.sources.find((x) => x.name === "SEC EDGAR");
  const st = SPIDER ? SPIDER.status() : null;
  const red = (l) => (l || []).map((e) => ({ t: e.t, e: redact(e.e) }));
  return {
    now: Date.now(), deployed: { commit: process.env.RENDER_GIT_COMMIT || null, node: process.version, startedAt: hv.started, uptimeSec: hv.uptimeSec },
    config: { finnhub: !!FINNHUB, durableStorage: !!(UP_URL && UP_TOKEN), claudeDailyLimit: DAILY_LIMIT, spider: !!SPIDER, secUserAgent: !!process.env.SEC_USER_AGENT },
    sources: hv.sources, errors: hv.errors,
    freshness: { quotes: await integrityStatus(), news: { at: feedAt || null }, macro: macro && macro.data ? { at: macro.at, complete: !!macro.data.complete } : null, sec: { lastOk: sec ? sec.lastOk : null, lastFail: sec ? sec.lastFail : null }, analystScan: { rated: Object.keys(BB.ratings || {}).length, universe: (BB.universe || []).length } },
    scheduler: st ? { state: st.state, running: st.running ? st.running.label : null, lastTick: st.scheduler.lastTick, error: st.scheduler.error ? redact(st.scheduler.error) : null, jobsToday: st.stats.jobs, errorsToday: st.stats.errors, queued: st.queued, budget: st.stats.budget, memory: st.stats.memory, storage: st.storage.backend, durable: st.storage.durable, nextBriefing: st.scheduler.nextBriefing,
      recentFailures: st.recent.filter((j) => j.status === "error").slice(0, 6).map((j) => ({ t: j.ended, label: j.label, error: redact(j.error) })) } : null,
    trader: { swing: { loaded: apLoaded, updated: AP.updated || null, lastTick: BOTDIAG.swing.lastTick || null, lastOpenTick: BOTDIAG.swing.lastOpenTick || null, market: BOTDIAG.market, errors: red(BOTDIAG.swing.errors) }, day: { loaded: dtLoaded, updated: (DT && DT.updated) || null, errors: red(BOTDIAG.day.errors) } },
    ci: await ciRuns(),
  };
}

// ---------------------------------------------------------------- local mode: forward bot/data routes
// In MODE=local the paper bots, THE WEB, sync and the desk store live on the public server. Their routes are
// forwarded there with DESK_TOKEN (x-desk-token header), which never leaves this server.
function readRaw(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > max) { reject(new Error("too large")); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
async function proxyToPublic(req, res, u) {
  if (!DEPLOY.remoteReady) return send(res, 503, { error: "The paper bots, THE WEB and your saved data live on the public server. Set PUBLIC_URL and DESK_TOKEN to reach them.", code: "remote_off" });
  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readRaw(req);
    const r = await fetch(DEPLOY.publicUrl + u.pathname + u.search, {
      method: req.method, body, redirect: "manual", signal: AbortSignal.timeout(/^\/api\/(coach\/chat|ai\/ask|web\/ask)$/.test(u.pathname) ? 75_000 : 20_000), // AI answers can take a while when Gemini is busy
      headers: { "x-desk-token": DEPLOY.token, "content-type": req.headers["content-type"] || "application/json", "accept-encoding": "identity" },
    });
    const extra = {}; const cd = r.headers.get("content-disposition"); if (cd) extra["Content-Disposition"] = cd;
    return send(res, r.status, Buffer.from(await r.arrayBuffer()), r.headers.get("content-type") || "application/json", extra);
  } catch (e) {
    return send(res, 502, { error: "Couldn't reach the public server (" + String(e.message || e) + ").", code: "remote_down" });
  }
}

// ---------------------------------------------------------------- http
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };

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

// The hosted worker only serves the desktop's authenticated API and the readiness probe.
function handleDashboard(req, res) {
  const pathname = new URL(req.url, "http://x").pathname;
  const noStore = { "Cache-Control": "no-store" };
  if (/^\/demo(?:\/|$)/i.test(pathname)) return send(res, 404, "Not found", "text/plain", noStore);
  if (DEPLOY.mode === "public") {
    if (pathname === "/api/health" && (req.method === "GET" || req.method === "HEAD")) return send(res, 200, { ok: true }, "application/json", noStore);
    if (!DM.isRemoteRoute(pathname) || !DM.tokenOk(req.headers["x-desk-token"], DEPLOY.token)) return send(res, 404, { error: "Not found" }, "application/json", noStore);
  } else if (DEPLOY.mode === "" && pathname.startsWith("/api/") && pathname !== "/api/login" && pathname !== "/api/health" && !isOwner(req)) {
    return send(res, 401, { error: "This part of Market Desk is private.", code: "private" }, "application/json", noStore);
  }
  return handle(req, res);
}

http
  .createServer((req, res) => costCtx.run({ cost: 0 }, () => handleDashboard(req, res)))
  .listen(PORT, DEPLOY.host, () => console.log(`${DEPLOY.mode === "hq" ? "Bot HQ" : "Market Desk"} (${DEPLOY.mode || "legacy"} mode) running at http://${DEPLOY.host || "localhost"}:${PORT}`));
if (DEPLOY.hqPort && DEPLOY.hqPort !== +PORT) {
  http.createServer((req, res) => costCtx.run({ cost: 0 }, () => handle(req, res)))
    .on("error", (e) => console.error("Bot HQ couldn't start on port " + DEPLOY.hqPort + ": " + e.message))
    .listen(DEPLOY.hqPort, DEPLOY.host, () => console.log(`Bot HQ running at http://${DEPLOY.host}:${DEPLOY.hqPort}`));
}
function serveFile(req, res, file) {
      fs.stat(file, (err, stt) => {
    if (err || !stt.isFile()) return send(res, 404, "Not found", "text/plain");
    const type = MIME[path.extname(file)] || "application/octet-stream";
    let c = STATIC_GZ.get(file);
    const done = () => {
      const html = /html/.test(type);
      const hdr = { ETag: c.etag, "Cache-Control": html || /javascript|css/.test(type) ? "no-cache" : "public, max-age=86400" }; // code always revalidates (cheap 304) so a deploy never mixes old and new files
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
}
// ---- Bot HQ as its own website: MODE=hq, or the desk's second port (127.0.0.1:HQ_PORT)
const HQ_LOGIN_HTML = LOGIN_HTML.replace("<title>Market Desk · Sign in</title>", "<title>Bot HQ · Sign in</title>")
  .replace(/href="\/favicon-owner\.svg[^"]*"/, 'href="/hq-favicon.svg"').replace(/<link rel="apple-touch-icon"[^>]*>/, "")
  .replace(/MARKET <span>DESK<\/span>/, "BOT <span>HQ</span>").replace(/<h1>[^<]*<\/h1><p>[^<]*<\/p>/, "<h1>Bot HQ sign-in</h1><p>Peter's private control room for the paper-trading bots.</p>")
  .replace(/<a href="\/demo">[^<]*<\/a>/, "");
async function handleHq(req, res, u) {
  try {
    const owner = isOwner(req);
    if (u.pathname.startsWith("/api/")) {
      if (u.pathname !== "/api/health" && rateLimited(req, owner)) return send(res, 429, { error: "Too many requests — slow down for a minute." }, "application/json", { "Retry-After": "60" });
      const act = DM.hqAccess({ path: u.pathname, method: req.method, owner, remote: DEPLOY.remoteReady || DEPLOY.mode === "local" || DEPLOY.mode === "hq" });
      if (act === "notfound") return send(res, 404, { error: "Not found" });
      if (act === "deny") return send(res, 401, { error: "Sign in to Bot HQ first.", code: "private" });
      if (u.pathname === "/api/health") return send(res, 200, { ok: true, site: "hq", mode: DEPLOY.mode, remote: DEPLOY.remoteReady, mainUrl: DEPLOY.mode === "local" ? `http://127.0.0.1:${PORT}/` : process.env.MAIN_URL || null });
      if (u.pathname === "/api/login" && req.method === "POST") {
        let pw = ""; try { pw = (await readBody(req)).password; } catch {}
        const r = siteLogin(req, pw);
        if (r.status !== 200) return send(res, r.status, { error: r.error });
        return send(res, 200, { ok: true }, "application/json", { "Set-Cookie": `md_owner=${r.key}; Path=/; Max-Age=${180 * 86400}; HttpOnly; Secure; SameSite=Lax` });
      }
      if (act === "proxy") return proxyToPublic(req, res, u);
      return send(res, 404, { error: "Not found" });
    }
    const go = (loc, extra = {}) => send(res, 302, "", "text/plain", { Location: loc, ...extra });
    const r = DM.hqPage(u.pathname, owner);
    if (!r) return send(res, 404, "Not found", "text/plain");
    if (r.redirect) return go(r.redirect);
    if (r.login) return send(res, 200, HQ_LOGIN_HTML, "text/html; charset=utf-8");
    if (r.logout) return go("/login", { "Set-Cookie": "md_owner=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
    return serveFile(req, res, path.join(PUBLIC, r.page || r.file));
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}
async function handle(req, res) {
    if (DEPLOY.mode === "hq" || (DEPLOY.hqPort && req.socket.localPort === DEPLOY.hqPort)) return handleHq(req, res, new URL(req.url, "http://x"));
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname.startsWith("/api/")) {
        const owner = isOwner(req), token = DEPLOY.mode === "public" && DM.tokenOk(req.headers["x-desk-token"], DEPLOY.token);
        if (u.pathname !== "/api/stream" && u.pathname !== "/api/health" && rateLimited(req, owner || token)) return send(res, 429, { error: "Too many requests — slow down for a minute." }, "application/json", { "Retry-After": "60" });
        const act = DM.access({ mode: DEPLOY.mode, path: u.pathname, owner, token, isPublic: isPublicApi(u, req) });
        if (act === "notfound") return send(res, 404, { error: "Not found" });
        if (act === "deny") return send(res, 401, { error: "This part of Market Desk is private.", code: "private" });
        if (act === "proxy") return proxyToPublic(req, res, u);
        if (u.pathname === "/api/login" && req.method === "POST") {
          let pw = ""; try { pw = (await readBody(req)).password; } catch {}
          const r = siteLogin(req, pw);
          if (r.status !== 200) return send(res, r.status, { error: r.error });
          return send(res, 200, { ok: true }, "application/json", { "Set-Cookie": `md_owner=${r.key}; Path=/; Max-Age=${180 * 86400}; HttpOnly; Secure; SameSite=Lax` });
        }
      }
      if (u.pathname.startsWith("/api/web/")) return webRoute(req, res, u); // owner-only (not in PUBLIC_API)
      if (u.pathname === "/api/news") {
        const r = String(u.searchParams.get("range") || "");
        return send(res, 200, await getNews(parseList(u.searchParams.get("tickers"), 25), r in RANGE_DAYS ? r : ""));
      }
      if (u.pathname === "/api/bestbuys") return send(res, 200, await bestBuys());
      if (u.pathname === "/api/trending") return send(res, 200, await getTrending());
      if (u.pathname === "/api/article") { try { return send(res, 200, await articleFull(u.searchParams.get("url") || "")); } catch (e) { return send(res, 400, { error: String(e.message || e) }); } }
      if (u.pathname === "/api/preview") return send(res, 200, await articlePreview(u.searchParams.get("url") || "").catch((e) => ({ url: u.searchParams.get("url"), limited: true, error: String(e.message || e) })));
      if (u.pathname === "/api/smart") return send(res, 200, await getSmart());
      if (u.pathname === "/api/pub/hist") {
        const [s] = parseList(u.searchParams.get("symbol"), 1); const d = /^\d{4}-\d{2}-\d{2}$/;
        const from = String(u.searchParams.get("from") || ""), to = String(u.searchParams.get("to") || new Date().toISOString().slice(0, 10));
        if (!s || !d.test(from) || !d.test(to)) return send(res, 400, { error: "symbol, from and to (YYYY-MM-DD) are required" });
        try { return send(res, 200, await longHistory(s, from, to, u.searchParams.get("interval"))); }
        catch (e) { return send(res, 502, { error: `No price history for ${s} (${String(e.message || e)}).` }); }
      }
      if (u.pathname === "/api/pub/integrity/status") return send(res, 200, await integrityStatus());
      if (u.pathname === "/api/pub/integrity") {
        const [sym] = parseList(u.searchParams.get("symbol"), 1); if (!sym) return send(res, 400, { error: "symbol required" });
        try { return send(res, 200, await integrityReport(sym)); } catch (e) { return send(res, 502, { error: "Couldn't validate " + sym + " right now (" + String(e.message || e) + ")." }); }
      }
      if (u.pathname === "/api/system/health") return send(res, 200, await systemHealth()); // owner-only (not public)
      if (u.pathname === "/api/pub/macro") return send(res, 200, await macroData());
      if (u.pathname === "/api/pub/events") { // earnings-release dates (8-K Item 2.02) with SEC acceptance times, for event studies
        const [sym] = parseList(u.searchParams.get("symbol"), 1); if (!sym) return send(res, 400, { error: "symbol required" });
        try { const id = await secCik(sym), r = (await secSubs(id.cik)).filings.recent, ev = [];
          for (let i = 0; i < r.form.length; i++) if ((r.form[i] === "8-K" || r.form[i] === "6-K") && /2\.02/.test(r.items[i] || "")) ev.push({ accepted: r.acceptanceDateTime[i] || null, filed: r.filingDate[i], url: edgarUrl(id.cik, r.accessionNumber[i], r.primaryDocument[i]) });
          return send(res, 200, { symbol: sym, name: id.name, source: "SEC EDGAR submissions (8-K Item 2.02: results of operations)", events: ev.slice(0, 40) });
        } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/pub/filings") {
        const syms = [...new Set(String(u.searchParams.get("symbols") || "").toUpperCase().split(",").map((x) => x.trim()).filter((x) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(x)))];
        try { return send(res, 200, await latestFilings(syms)); } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/pub/insiders" || u.pathname === "/api/pub/release" || u.pathname === "/api/pub/riskdiff") {
        const fn = { "/api/pub/insiders": insiderScan, "/api/pub/release": earningsRelease, "/api/pub/riskdiff": riskDiff }[u.pathname];
        try { return send(res, 200, await fn(u.searchParams.get("symbol"))); }
        catch (e) { return send(res, 502, { error: "SEC data is unavailable right now (" + String(e.message || e) + "). Try again in a minute." }); }
      }
      if (u.pathname === "/api/pub/filing") {
        try { const sym = u.searchParams.get("symbol"); return send(res, 200, u.searchParams.get("fast") ? await filingFast(sym) : await filingKick(sym)); }
        catch (e) { return send(res, 502, { error: "SEC data is unavailable right now (" + String(e.message || e) + "). Try again in a minute." }); }
      }
      if (u.pathname === "/api/pub/sec") {
        try { return send(res, 200, await secFundamentals(u.searchParams.get("symbol"))); }
        catch (e) { return send(res, 502, { error: "SEC data is unavailable right now (" + String(e.message || e) + "). Try again in a minute." }); }
      }
      if (u.pathname === "/api/autopilot" && req.method === "GET") return send(res, 200, await apView(isOwner(req) || (DEPLOY.mode === "public" && DM.tokenOk(req.headers["x-desk-token"], DEPLOY.token))));
      if (u.pathname === "/api/why" && req.method === "GET") { const w = await whyView(u.searchParams.get("symbol")); return send(res, w.error ? 400 : 200, w); }
      if (u.pathname === "/api/mytrader" && req.method === "GET") { try { return send(res, 200, await mtView()); } catch (e) { return send(res, 502, { error: String(e.message || e) }); } }
      if (u.pathname === "/api/mytrader/order" && req.method === "POST") { const b = await readBody(req, 4000).catch(() => null); if (!b) return send(res, 400, { error: "Bad order." }); try { const r = await mtOrder(b); return send(res, r.ok ? 200 : 400, r); } catch (e) { return send(res, 502, { error: String(e.message || e) }); } }
      if (u.pathname === "/api/mytrader/cancel" && req.method === "POST") { const b = await readBody(req, 4000).catch(() => null); try { const ok = await mtLocked(async () => { const st = await mtLoad(); const did = MYT.cancel(st, String(b && b.id || "")); if (did) await mtStore.set("book", st); return did; }); return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "No waiting order with that id." }); } catch (e) { return send(res, 502, { error: String(e.message || e) }); } }
      if (u.pathname === "/api/ai/ask" && req.method === "POST") { // free Gemini only (Claude never runs on the public server)
        if (!GEMINI_KEY) return send(res, 401, { error: "no_key" });
        try { return send(res, 200, await askGemini(await readBody(req))); } catch (e) { return send(res, e.code === "cap" ? 429 : 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/coach/chat") {
        if (req.method === "GET") { await ownerReady; return send(res, 200, { messages: OWNER.chat.slice(-60), instructions: CO.live(OWNER, Date.now()).map((d) => ({ id: d.id, text: CO.describe(d), status: d.status })), ai: geminiInfo() }); }
        if (req.method === "POST") { let b = null; try { b = await readBody(req, 4000); } catch {} const text = String((b && b.text) || "").trim(); if (!text) return send(res, 400, { error: "Type an instruction." });
          try { return send(res, 200, await coachChat(text)); } catch (e) { return send(res, 502, { error: String(e.message || e) }); } }
      }
      if (u.pathname === "/api/coach" && req.method === "GET") { try { return send(res, 200, await coachView()); } catch (e) { return send(res, 502, { error: String(e.message || e) }); } }
      if (u.pathname === "/api/brief" && req.method === "GET") return send(res, 200, { ...(await briefView()), since: undefined });
      if (u.pathname === "/api/daytrader" && req.method === "GET") return send(res, 200, await dtView());
      if (u.pathname === "/api/quanttrader" && req.method === "GET") return send(res, 200, await qtView());
      if (u.pathname === "/api/quanttrader/run" && req.method === "POST") { qtTick(); return send(res, 202, { ok: true }); } // owner-only (signed-in cookie checked above)
      if (u.pathname === "/api/desk-risk" && req.method === "GET") return send(res, 200, deskRisk.view());
      if (u.pathname === "/api/strategy-lab" && req.method === "GET") return send(res, 200, await strategyLab.view());
      if (u.pathname === "/api/day-volume" && req.method === "GET") return send(res, 200, await dayVolume.view());
      if (u.pathname === "/api/strategy-lab/borrow" && req.method === "POST") {
        try { return send(res, 200, await strategyLab.saveBorrow(await readBody(req))); }
        catch (error) { return send(res, 400, { error: error.message }); }
      }
      if (u.pathname === "/api/desk-risk/review" && req.method === "POST") {
        const ok = await deskRisk.review();
        return send(res, ok ? 200 : 409, { ok, risk: deskRisk.view() });
      }
      if (u.pathname === "/api/pub/botslive") return send(res, 200, botsLive());
      if (u.pathname === "/api/pub/archive") { // finished experiments per bot (busts, resets, strategy changes) — never edited
        const bot = u.searchParams.get("bot"); if (!["swing", "day", "quant"].includes(bot)) return send(res, 400, { error: "bot must be swing, day or quant" });
        return send(res, 200, { bot, strategy: STRATS[bot], runs: await archiveList(bot, 30, u.searchParams.get("full") === "1") });
      }
      if (u.pathname === "/api/pub/strategies") return send(res, 200, STRATS);
      if (u.pathname === "/api/pub/leaderboard") return send(res, 200, await leaderboard());
      if (u.pathname === "/api/pub/putcall") { if (!PC.loaded) await pcLoad(); return send(res, 200, pcState()); }
      if (u.pathname === "/api/daytrader/restore" && req.method === "POST") { if (!dtLoaded) await dtLoad(); let doc = null; try { doc = await readBody(req); } catch {} return send(res, 200, await dtRestore(doc)); }
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
        // no Claude key here and no Gemini key on this laptop: the free Gemini key lives on the bot server, so ask it there
        if (!key && !GEMINI_KEY && DEPLOY.mode === "local" && DEPLOY.remoteReady) return proxyToPublic(req, res, { pathname: "/api/ai/ask", search: "" });
        if (!key && GEMINI_KEY) { // free Gemini answers (no portfolio-building actions; those need Claude's tool calls)
          if (!ipAllowed(req)) return send(res, 429, { error: "Hourly AI limit reached. Try again a bit later." });
          try { return send(res, 200, await askGemini(await readBody(req))); } catch (e) { return send(res, e.code === "cap" ? 429 : 502, { error: String(e.message || e) }); }
        }
        if (!key) return send(res, 401, { error: "no_key" });
        { const g = claudeGate(req, req.headers["x-claude-pass"]); if (g) return send(res, ...g); }
        if (!ipAllowed(req)) return send(res, 429, { error: "Hourly Claude limit reached (safety cap to protect your credits). Try again a bit later." });
        try { return send(res, 200, await ask(key, await readBody(req))); }
        catch (e) { return send(res, e.code === "daily_limit" ? 429 : 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/instrument") {
        const sym = parseList(u.searchParams.get("symbol"), 1)[0]; if (!sym) return send(res, 400, { error: "symbol required" });
        try { return send(res, 200, await instrumentView(sym)); } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/options") {
        const sym = parseList(u.searchParams.get("symbol"), 1)[0]; if (!sym) return send(res, 400, { error: "symbol required" });
        try { return send(res, 200, await optionChain(sym, String(u.searchParams.get("date") || ""))); } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
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
        if (typeof WebSocket === "undefined") return send(res, 404, { error: "streaming_off" }); // crypto streams without a key
        const streamOwner = isOwner(req); // (the block's own `owner` is declared further down, so it can't be used here)
        const focus = streamOwner ? parseList(u.searchParams.get("focus"), 1)[0] : undefined;
        const release = streamSlot(req, streamOwner);
        if (!release) return send(res, 429, { error: "Too many open live-price connections.", code: "stream_busy" }, "application/json", { "Retry-After": "30" });
        return openStream(res, parseList(u.searchParams.get("symbols"), 60), focus, release);
      }
      if (u.pathname === "/api/desk") return deskRoute(req, res); // owner-only (not in PUBLIC_API): personal layouts, profile, research
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
      if (u.pathname === "/api/health") return send(res, 200, { ok: true, mode: DEPLOY.mode || "legacy", hqUrl: isOwner(req) ? (DEPLOY.hqPort ? `http://127.0.0.1:${DEPLOY.hqPort}/` : process.env.HQ_URL || null) : null, serverKey: !!process.env.ANTHROPIC_API_KEY, claudeUsedToday: claudeUsed(), claudeDailyLimit: DAILY_LIMIT, claudeBudget: budgetView(), durableSync: !!(UP_URL && UP_TOKEN), streaming: typeof WebSocket !== "undefined", stocksStreaming: !!FINNHUB, feeds: { yahoo: YGATE.stats(), coinbase: cb.open }, streamConnected: live.open, streamTradeAt: live.providerTradeAt, web: SPIDER ? { on: true, durable: !!(UP_URL && UP_TOKEN) } : { on: false } });
      // The dashboard is owner-only.
      const owner = isOwner(req);
      const go = (loc, extra = {}) => send(res, 302, "", "text/plain", { Location: loc, ...extra });
      { const to = DM.pageRedirect(DEPLOY.mode, u.pathname); if (to) return go(to); }
      if (u.pathname === "/login") return owner ? go("/") : send(res, 200, LOGIN_HTML, "text/html; charset=utf-8");
      if (u.pathname === "/logout") return go("/login", { "Set-Cookie": "md_owner=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
      if (u.pathname === "/sp500.json") return send(res, 200, { ...SP500_META, rows: SP500 }, "application/json", { "Cache-Control": "public, max-age=3600" });
      let page = null;
      if (u.pathname === "/" || u.pathname === "/index.html" || u.pathname === "/ai-vs-sp500") {
        if (u.searchParams.has("visitor")) return go(u.pathname);
        if (!owner) return go("/login");
        page = "index.html";
      }
      const file = path.normalize(path.join(PUBLIC, page || u.pathname));
      if (!file.startsWith(PUBLIC + path.sep) || (!page && (file === path.join(PUBLIC, "index.html") || file === path.join(PUBLIC, "hq.html")))) return send(res, 404, "Not found", "text/plain");
      return serveFile(req, res, file);
    } catch (e) {
      send(res, 500, { error: String(e.message || e) });
    }
}

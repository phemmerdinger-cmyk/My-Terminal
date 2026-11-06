// Personal Stock News Hub — zero-dependency Node.js server (Node 18+)
// Pulls headlines from Yahoo Finance, CNBC, Morningstar, Seeking Alpha and
// The Wall Street Journal, plus live quotes, and serves the dashboard in /public.
//
//   node server.js            -> http://localhost:3000
//   PORT=8080 node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
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
    market: [
      "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
      "https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml",
      "https://feeds.a.dj.com/rss/RSSWSJD.xml",
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
    if (it.publisher && !new RegExp(src.name.split(" ")[0], "i").test(it.publisher)) return null;
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
  };
}

async function loadSource(srcKey, urls, ticker) {
  const src = SOURCES[srcKey];
  const results = await Promise.allSettled(urls.map(fetchFeed));
  let items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  let ok = results.some((r) => r.status === "fulfilled" && r.value.length);
  // Fallback: if the outlet's own feed failed, use Google News for that site
  if (!ok) {
    const q = ticker ? `${base(ticker)} ${kind(ticker)} site:${src.domain} when:7d` : `site:${src.domain} stocks when:2d`;
    try {
      items = await fetchFeed(gnews(q));
      ok = items.length > 0;
    } catch {}
  }
  return { ok, items: items.map((i) => cleanItem(i, srcKey, ticker)).filter(Boolean) };
}

const TICKER_RE = /^[A-Z0-9.\-^=]{1,12}$/;

async function getNews(tickers) {
  const jobs = [];
  for (const key of Object.keys(SOURCES)) {
    jobs.push(loadSource(key, SOURCES[key].market, null).then((r) => ({ key, ...r })));
    for (const t of tickers) jobs.push(loadSource(key, SOURCES[key].ticker(t), t).then((r) => ({ key, ...r })));
  }
  const done = await Promise.all(jobs);
  const status = {};
  const byId = new Map();
  for (const { key, ok, items } of done) {
    status[key] = status[key] || ok;
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
  const items = [...byId.values()]
    .filter((i) => !i.time || i.time > Date.now() - 1000 * 60 * 60 * 24 * 21)
    .sort((a, b) => (b.time || 0) - (a.time || 0))
    .slice(0, 400);
  return {
    updated: Date.now(),
    sources: Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, { name: s.name, ok: !!status[k] }])),
    items,
  };
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
  "1d": ["1d", "5m"], "5d": ["5d", "15m"], "1mo": ["1mo", "1h"], "6mo": ["6mo", "1d"],
  ytd: ["ytd", "1d"], "1y": ["1y", "1d"], "5y": ["5y", "1wk"], max: ["max", "1mo"],
};
async function history(sym, range = "6mo") {
  const [r, iv] = RANGES[range] || RANGES["6mo"];
  return cached(`h:${sym}:${r}`, r === "1d" || r === "5d" ? 30_000 : 10 * 60_000, async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${r}&interval=${iv}`;
    const j = JSON.parse(await get(url, "application/json"));
    const res = j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.timestamp) throw new Error("no history");
    const q = res.indicators.quote[0];
    const candles = [];
    res.timestamp.forEach((t, i) => {
      if (q.open[i] == null || q.close[i] == null) return;
      candles.push({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
    });
    return { symbol: res.meta.symbol, name: res.meta.shortName || res.meta.symbol, range: r, interval: iv, candles };
  });
}

// ---------------------------------------------------------------- Claude predictions
// Needs an Anthropic API key: set ANTHROPIC_API_KEY on the server
// (or paste one in the site's settings, sent only to this server).
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

async function askClaude(apiKey, prompt, raw = false) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1800,
      system:
        "You are a sharp, balanced equity strategist writing for one individual investor's personal dashboard. " +
        "Use ONLY the data provided plus general market knowledge. Be specific, cite the headlines and numbers you rely on, " +
        "state uncertainty honestly, and never present a forecast as certain. This is an opinion, not financial advice. " +
        (raw
          ? "Answer in plain text: short paragraphs or '- ' bullets, no markdown headings, under 250 words."
          : "Reply with a single JSON object and nothing else."),
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error((j.error && j.error.message) || `Anthropic API error ${res.status}`);
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (raw) return text.trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude did not return a prediction");
  return JSON.parse(m[0]);
}

const SHAPE = `Return JSON exactly in this shape:
{"stance":"Bullish"|"Bearish"|"Neutral","confidence":0-100,"headline":"one-sentence call",
 "shortTerm":{"horizon":"next 1-2 weeks","view":"2-3 sentences","range":"expected price/level range as text"},
 "mediumTerm":{"horizon":"next 3-6 months","view":"2-3 sentences","range":"expected price/level range as text"},
 "bullCase":["..."],"bearCase":["..."],"catalysts":["upcoming events to watch"],
 "newsRead":"what the latest headlines say, 2-3 sentences"}`;

async function predict(sym, apiKey) {
  const isMarket = sym === "MARKET";
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
    const out = await askClaude(apiKey, prompt);
    return { symbol: sym, model: MODEL, generated: Date.now(), ...out };
  });
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
  const prompt = `Today is ${today}.\n\nMARKET\n${idx.map(qline).join("\n")}\n\nWATCHED / HELD STOCKS\n${syms.map(qline).join("\n")}\n\nMY PORTFOLIO\n${port}\n\nLATEST HEADLINES\n${news.items.slice(0, 40).map((i) => `- [${SOURCES[i.source].name}] ${i.title}`).join("\n")}\n\nMY QUESTION\n${question}`;
  return { answer: await askClaude(apiKey, prompt, true), model: MODEL, generated: Date.now() };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 100_000) req.destroy(); });
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
  return {
    symbol: sym, limited: true,
    price: { longName: q.name, regularMarketPrice: q.price, regularMarketChange: q.change, regularMarketChangePercent: q.changePct / 100, exchangeName: q.exchange, currency: q.currency },
    summaryDetail: { previousClose: q.prevClose, dayLow: q.dayLow, dayHigh: q.dayHigh, fiftyTwoWeekLow: q.low52, fiftyTwoWeekHigh: q.high52, volume: q.volume, marketCap: val.MarketCap, trailingPE: val.PeRatio, forwardPE: val.ForwardPeRatio, priceToSalesTrailing12Months: val.PsRatio },
    defaultKeyStatistics: { enterpriseValue: val.EnterpriseValue, pegRatio: val.PegRatio, priceToBook: val.PbRatio, enterpriseToRevenue: val.EnterprisesValueRevenueRatio, enterpriseToEbitda: val.EnterprisesValueEBITDARatio },
  };
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

// ---------------------------------------------------------------- live streaming prices (Finnhub)
// With FINNHUB_API_KEY set (free at finnhub.io), the server keeps one WebSocket to
// Finnhub and streams every trade to open browsers via Server-Sent Events.
// Free tier: real-time US stock trades, up to 30 symbols at once. Needs Node 22+.
const FINNHUB = process.env.FINNHUB_API_KEY;
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

// ---------------------------------------------------------------- http
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function parseList(v, max) {
  return [...new Set(String(v || "").toUpperCase().split(",").map((s) => s.trim()).filter((s) => TICKER_RE.test(s)))].slice(0, max);
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname === "/api/news") return send(res, 200, await getNews(parseList(u.searchParams.get("tickers"), 25)));
      if (u.pathname === "/api/quotes") return send(res, 200, await getQuotes(parseList(u.searchParams.get("symbols"), 120)));
      if (u.pathname === "/api/history") {
        const [s] = parseList(u.searchParams.get("symbol"), 1);
        if (!s) return send(res, 400, { error: "symbol required" });
        return send(res, 200, await history(s, u.searchParams.get("range")));
      }
      if (u.pathname === "/api/predict") {
        const raw = String(u.searchParams.get("symbol") || "MARKET").toUpperCase();
        const [s] = raw === "MARKET" ? ["MARKET"] : parseList(raw, 1);
        if (!s) return send(res, 400, { error: "Enter a valid ticker" });
        const key = process.env.ANTHROPIC_API_KEY || req.headers["x-anthropic-key"];
        if (!key) return send(res, 401, { error: "no_key" });
        try { return send(res, 200, await predict(s, key)); }
        catch (e) { return send(res, 502, { error: String(e.message || e) }); }
      }
      if (u.pathname === "/api/ask" && req.method === "POST") {
        const key = process.env.ANTHROPIC_API_KEY || req.headers["x-anthropic-key"];
        if (!key) return send(res, 401, { error: "no_key" });
        try { return send(res, 200, await ask(key, await readBody(req))); }
        catch (e) { return send(res, 502, { error: String(e.message || e) }); }
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
      if (u.pathname === "/api/stream") {
        if (!FINNHUB || typeof WebSocket === "undefined") return send(res, 404, { error: "streaming_off" });
        return openStream(req, res, parseList(u.searchParams.get("symbols"), 60));
      }
      if (u.pathname === "/api/health") return send(res, 200, { ok: true, serverKey: !!process.env.ANTHROPIC_API_KEY, streaming: !!FINNHUB && typeof WebSocket !== "undefined" });
      let file = path.normalize(path.join(PUBLIC, u.pathname === "/" ? "index.html" : u.pathname));
      if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden", "text/plain");
      fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, "Not found", "text/plain");
        send(res, 200, data, MIME[path.extname(file)] || "application/octet-stream");
      });
    } catch (e) {
      send(res, 500, { error: String(e.message || e) });
    }
  })
  .listen(PORT, () => console.log(`Stock News Hub running at http://localhost:${PORT}`));

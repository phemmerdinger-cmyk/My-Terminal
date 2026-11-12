// THE WEB — the Spider: an autonomous, rules-based research agent that runs on the server.
//
// How it works
//   • A planner (every 15 s) decides which research is due: each recurring job has a freshness window that is
//     shorter while the market is open, and events found by one job (an earnings report, a Fed release, a stock
//     moving 6%) queue follow-up jobs for specific companies.
//   • A priority engine scores every queued job on portfolio relevance, market impact, freshness, source
//     reliability, price move, catalyst proximity, research gaps, existing coverage and AI Trader relevance, and
//     re-sorts the queue every tick — so an earnings report from a holding jumps to the front.
//   • One worker runs one job at a time, each with a hard time limit, at most 2 retries, an hourly job budget,
//     a queue cap and a follow-up depth limit (no infinite loops, no request storms).
//   • Everything a job learns becomes a "discovery" in persistent research memory: deduplicated by a stable key,
//     versioned when it changes, linked to related discoveries, given an expiry, and scored for importance,
//     portfolio relevance and AI Trader relevance. Facts carry their source and timestamp; interpretations,
//     estimates and speculation are labeled as such.
//   • Directional discoveries (an earnings beat, insider buying) record a testable hypothesis — "should beat the
//     S&P 500 over the next week" — that a later job grades against real prices. That grading is the only
//     feedback loop; the Spider does not otherwise learn.
//
// The Spider never trades. It has no access to the bots' order functions; it only reads their state.
"use strict";
const { createStore } = require("./store");
const { buildBriefing } = require("./briefing");

const DAY = 864e5, HOUR = 3600e3, MIN = 60e3;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r1 = (x) => Math.round(x * 10) / 10, r2 = (x) => Math.round(x * 100) / 100;
const pctS = (x, d = 1) => (x == null || !isFinite(x) ? "n/a" : (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(d) + "%");
const money = (x) => (x == null || !isFinite(x) ? "n/a" : (x < 0 ? "−" : "") + "$" + (Math.abs(x) >= 1e9 ? (Math.abs(x) / 1e9).toFixed(1) + "B" : Math.abs(x) >= 1e6 ? (Math.abs(x) / 1e6).toFixed(1) + "M" : Math.abs(x) >= 1e3 ? (Math.abs(x) / 1e3).toFixed(1) + "K" : Math.abs(x).toFixed(0)));
const uniq = (a) => [...new Set(a.filter(Boolean))];
// what kind of evidence a finding mainly rests on: verified facts, or only interpretation/estimates/speculation
const kindOf = (d) => ((d.facts || []).some((f) => f.kind === "fact") ? "fact" : ((d.facts || [])[0] || {}).kind || (d.interp && d.interp.kind) || "fact");
// a promise with a hard time limit whose timer is always cleared (no dangling timers)
function withTimeout(p, ms, msg = "timed out") { let h; return Promise.race([p, new Promise((_, no) => { h = setTimeout(() => no(new Error(msg)), ms); })]).finally(() => clearTimeout(h)); }
const isCrypto = (s) => /-USD$/.test(s);
const isIndexish = (s) => /[\^=]/.test(s);

// ---------------------------------------------------------------- reference tables (explainable relationships)
const SECTOR_ETF = { "Information Technology": "XLK", "Communication Services": "XLC", "Consumer Discretionary": "XLY", "Consumer Staples": "XLP", Financials: "XLF", "Health Care": "XLV", Industrials: "XLI", Energy: "XLE", Materials: "XLB", Utilities: "XLU", "Real Estate": "XLRE" };
const ETF_SECTOR = Object.fromEntries(Object.entries(SECTOR_ETF).map(([k, v]) => [v, k]));
const FUND_CLASS = {
  SPY: "Broad market", VOO: "Broad market", IVV: "Broad market", VTI: "Broad market", ITOT: "Broad market", SCHB: "Broad market", DIA: "Broad market", RSP: "Broad market", SCHD: "Broad market", VIG: "Broad market", VYM: "Broad market",
  VFIAX: "Broad market", FXAIX: "Broad market", VTSAX: "Broad market", SWPPX: "Broad market", QQQ: "Nasdaq-100 (growth)", QQQM: "Nasdaq-100 (growth)", IWM: "Small caps",
  VEA: "International", VXUS: "International", EFA: "International", VWO: "International", IEMG: "International", VTIAX: "International",
  BND: "Bonds", AGG: "Bonds", TLT: "Bonds", IEF: "Bonds", SHY: "Bonds", TIP: "Bonds", LQD: "Bonds", HYG: "Bonds", MUB: "Bonds", BNDX: "Bonds", VBTLX: "Bonds",
  GLD: "Commodities", IAU: "Commodities", SLV: "Commodities", USO: "Commodities", ARKK: "Thematic growth",
};
// Rule-of-thumb sensitivities used to connect economic indicators to sectors. Shown to the user as interpretation.
const MACRO_LINKS = [
  { id: "rates", name: "Interest rates", series: ["DGS10", "DGS2", "FEDFUNDS"], quote: "^TNX", sectors: { "Real Estate": "higher rates raise financing costs and compete with property yields", Utilities: "bond-like dividends look less attractive when yields rise", Financials: "rates drive banks' net interest margins", "Information Technology": "long-duration growth valuations are sensitive to discount rates", "Nasdaq-100 (growth)": "growth valuations are sensitive to discount rates", Bonds: "bond prices move opposite to yields" } },
  { id: "inflation", name: "Inflation", series: ["CPIAUCSL", "CPILFESL"], sectors: { "Consumer Staples": "input costs versus pricing power", "Consumer Discretionary": "inflation squeezes real spending power", Bonds: "inflation erodes fixed coupons and shapes the Fed's path" } },
  { id: "jobs", name: "Labor market", series: ["UNRATE", "SAHMREALTIME"], sectors: { "Consumer Discretionary": "employment drives discretionary spending", Industrials: "cyclical demand follows hiring", Financials: "job losses raise credit losses" } },
  { id: "growth", name: "Economic growth", series: ["A191RL1Q225SBEA"], sectors: { Industrials: "cyclical demand", Materials: "commodity demand", Energy: "fuel demand", "Small caps": "smaller companies are more tied to the domestic cycle" } },
  { id: "curve", name: "Yield curve", series: ["T10Y2Y", "T10Y3M"], sectors: { Financials: "banks borrow short and lend long, so a flat or inverted curve squeezes margins" } },
  { id: "sentiment", name: "Consumer sentiment", series: ["UMCSENT"], sectors: { "Consumer Discretionary": "confidence leads discretionary purchases" } },
  { id: "oil", name: "Crude oil", quote: "CL=F", sectors: { Energy: "producer revenue tracks oil prices", Industrials: "fuel is a major cost for airlines and transports", "Consumer Discretionary": "gasoline prices compete with other spending" } },
  { id: "dollar", name: "US dollar", quote: "DX-Y.NYB", sectors: { "Information Technology": "a stronger dollar shrinks overseas revenue in dollar terms", Materials: "commodities are priced in dollars", International: "foreign returns translate into fewer dollars when the dollar rises" } },
];
const THEMES = [
  ["Fed & interest rates", /\b(fed|fomc|powell|rate (cut|hike)s?|interest rates?|treasury yields?|bond yields?)\b/i, "rates"],
  ["Inflation", /\b(inflation|cpi|ppi|consumer prices)\b/i, "inflation"],
  ["Jobs & layoffs", /\b(jobs report|payrolls|unemployment|jobless|layoffs?|hiring)\b/i, "jobs"],
  ["Tariffs & trade", /\b(tariffs?|trade (war|deal|talks)|export controls?|import duties)\b/i, null],
  ["AI & chips", /\b(ai|artificial intelligence|chips?|semiconductors?|data cent(er|re)s?|nvidia)\b/i, null],
  ["Oil & energy", /\b(oil|opec|crude|natural gas|gasoline)\b/i, "oil"],
  ["Earnings season", /\b(earnings|quarterly (results|profit|revenue)|guidance|eps)\b/i, null],
  ["Banks & credit", /\b(banks?|banking|credit|lending|loan defaults?)\b/i, null],
  ["China", /\b(china|chinese|beijing)\b/i, null],
  ["Recession risk", /\b(recession|slowdown|contraction|hard landing)\b/i, "growth"],
  ["Crypto", /\b(bitcoin|crypto(currency)?|ether(eum)?)\b/i, null],
];
// how long a discovery stays in memory (days), by category
const EXPIRY = { news: 4, mover: 7, market: 3, sector: 4, pattern: 7, policy: 21, macro: 45, earnings: 30, filing: 120, fundamentals: 400, insider: 60, company: 30, portfolio: 14, ai_trader: 7 };
const CAT_BASE = { policy: 0.7, macro: 0.6, earnings: 0.6, market: 0.6, portfolio: 0.6, pattern: 0.55, filing: 0.5, insider: 0.5, mover: 0.5, fundamentals: 0.5, ai_trader: 0.5, sector: 0.45, news: 0.4, company: 0.35 };
// source reliability used by the priority engine (official primary sources first)
const RELIABILITY = { sec: 1, fred: 1, fed: 1, bls: 1, treasury: 1, exchange: 0.85, calendar: 0.8, news: 0.6, internal: 0.9 };

// ---------------------------------------------------------------- job catalog
// ttl: minutes between runs [market open, market closed]; null = event-driven only
const JOBS = {
  portfolio_scan: { label: "Analyzing portfolio exposure", area: "Portfolio", go: "#portfolio", ttl: [15, 180], timeout: 90, rel: "internal" },
  market_pulse: { label: "Investigating market & sector performance", area: "Markets › Overview & Heatmap", go: "#data", ttl: [3, 90], timeout: 75, rel: "exchange" },
  news_sweep: { label: "Comparing market sentiment across news sources", area: "Markets › News", go: "#news", ttl: [8, 45], timeout: 90, rel: "news" },
  policy_watch: { label: "Monitoring Fed, Treasury, SEC & BLS releases", area: "Markets › Macro", go: "#macro", ttl: [30, 60], timeout: 90, rel: "fed" },
  macro_check: { label: "Monitoring economic releases", area: "Markets › Macro", go: "#macro", ttl: [360, 360], timeout: 150, rel: "fred" },
  earnings_watch: { label: "Checking company earnings", area: "Markets › Upcoming earnings", go: "#data", ttl: [120, 240], timeout: 120, rel: "calendar" },
  filings_watch: { label: "Reviewing SEC filings", area: "Research › 10-K crawler", go: "#filings", ttl: [120, 240], timeout: 240, rel: "sec" },
  earnings_release: { label: (s) => `Reading ${s}'s earnings release (SEC 8-K)`, area: "Research › 10-K crawler", go: (s) => `#filings/${s}/release`, timeout: 180, rel: "sec", sym: true },
  fundamentals: { label: (s) => `Checking ${s}'s 10-K financial health`, area: "Research › Financials", go: (s) => `#filings/${s}/fin`, timeout: 180, rel: "sec", sym: true },
  insiders: { label: (s) => `Scanning ${s} insider trades (Form 4)`, area: "Research › 10-K crawler", go: (s) => `#filings/${s}/insiders`, timeout: 240, rel: "sec", sym: true },
  investigate_mover: { label: (s) => `Evaluating possible catalysts for ${s}`, area: "Research › Stock research", timeout: 75, rel: "exchange", sym: true },
  company_snapshot: { label: (s) => `Researching ${s}`, area: "Research › Stock research", timeout: 180, rel: "internal", sym: true },
  explore: { label: "Exploring the broader market for research gaps", area: "Markets › Heatmap", go: "#nyse", ttl: [20, 45], timeout: 30, rel: "internal" },
  ai_trader_sync: { label: "Sending research to AI Trader", area: "AI Lab › AI vs S&P 500", go: "#aitrade", ttl: [10, 60], timeout: 30, rel: "internal" },
  hypothesis_review: { label: "Checking whether earlier hypotheses held up", area: "THE WEB › Research memory", ttl: [360, 360], timeout: 150, rel: "exchange" },
  maintenance: { label: "Updating research memory (dedupe, expiry)", area: "THE WEB › Research memory", ttl: [360, 360], timeout: 30, rel: "internal" },
  briefing: { label: (s) => `Writing the ${s} briefing`, area: "THE WEB › Daily briefing", timeout: 300, rel: "internal" },
};
const SLOTS = {
  morning: { label: "Morning", title: "Morning briefing · pre-market", from: 7 * 60 + 45, to: 9 * 60 + 30 },
  midday: { label: "Intraday", title: "Intraday update", from: 12 * 60, to: 15 * 60 + 30 },
  close: { label: "After-market", title: "After-market wrap", from: 16 * 60 + 10, to: 23 * 60 + 59 },
};
const VISUAL = { fetch: "researching", analyze: "analyzing", connect: "connecting", discover: "discovering", save: "updating" };

function createSpider(deps) {
  const now = deps.now || Date.now;
  const store = deps.store || createStore(deps.storeOptions || {});
  const MAX_PER_HOUR = deps.maxJobsPerHour || 80, QUEUE_CAP = 60, MAX_DEPTH = 2, DISC_CAP = 700, LOG_CAP = 80;
  const SP = new Map((deps.sp500List || []).map((r) => [r[0], { sym: r[0], name: r[1], sector: r[2], industry: r[3] }]));

  // ------------------------------------------------------------ state
  let ST = fresh(), DISC = [], BIDX = [];
  let loaded = false, loading = null, dirty = false, lastSave = 0, saving = false;
  let running = null, timer = null, stopped = false, lastTickAt = 0, lastTickError = null;
  const listeners = new Set();
  function fresh() {
    return { v: 1, created: now(), context: { portfolios: [], watchlist: [], active: null, updated: 0 }, queue: [], lastRun: {}, researched: {}, jobs: [], hour: [],
      seen: { filings: {}, policy: {}, macro: {}, earn: {} }, funda: {}, exposure: null, market: null, macro: null, earnings: null, newsDigest: null, trader: null, explore: [],
      stats: { day: "", jobs: 0, discoveries: 0, errors: 0, total: 0 }, hyp: { supported: 0, refuted: 0, inconclusive: 0 }, seq: 0 };
  }
  const nextId = (p) => p + (++ST.seq).toString(36) + now().toString(36).slice(-4);

  async function load() {
    if (loaded) return; if (loading) return loading;
    loading = (async () => {
      try {
        const [s, d, b] = await Promise.all([store.get("state"), store.get("disc"), store.get("bidx")]);
        if (s && s.v === 1) ST = { ...fresh(), ...s, seen: { ...fresh().seen, ...(s.seen || {}) }, stats: { ...fresh().stats, ...(s.stats || {}) }, hyp: { ...fresh().hyp, ...(s.hyp || {}) } };
        if (Array.isArray(d)) DISC = d;
        if (Array.isArray(b)) BIDX = b;
        ST.queue = (ST.queue || []).filter((j) => JOBS[j.type]).slice(0, QUEUE_CAP);
      } catch (e) { lastTickError = "load: " + e.message; }
      loaded = true;
    })();
    return loading;
  }
  const markDirty = () => { dirty = true; };
  async function save(force) {
    if (saving || (!dirty && !force)) return;
    saving = true; dirty = false; lastSave = now();
    try {
      const st = { ...ST, jobs: ST.jobs.slice(0, LOG_CAP) };
      await store.set("state", st); await store.set("disc", DISC); await store.set("bidx", BIDX);
    } catch (e) { dirty = true; lastTickError = "save: " + e.message; } finally { saving = false; }
  }

  // ------------------------------------------------------------ calendar (Eastern time)
  function et(t = now()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, wd: p.weekday, min: (+p.hour % 24) * 60 + +p.minute };
  }
  const tradingDay = (day, wd) => !(wd === "Sat" || wd === "Sun") && !(deps.holidays && deps.holidays.has(day));
  function marketOpen(t = now()) {
    const e = et(t); if (!tradingDay(e.day, e.wd)) return false;
    const close = deps.earlyClose && deps.earlyClose.has(e.day) ? 13 * 60 : 16 * 60;
    return e.min >= 9 * 60 + 30 && e.min < close;
  }
  function session(t = now()) {
    const e = et(t), td = tradingDay(e.day, e.wd), close = deps.earlyClose && deps.earlyClose.has(e.day) ? 13 * 60 : 16 * 60;
    const phase = !td ? "closed (" + (e.wd === "Sat" || e.wd === "Sun" ? "weekend" : "holiday") + ")" : e.min < 4 * 60 ? "overnight" : e.min < 9 * 60 + 30 ? "pre-market" : e.min < close ? "open" : e.min < 20 * 60 ? "after-hours" : "overnight";
    return { ...e, trading: td, open: td && e.min >= 570 && e.min < close, phase, closeMin: close };
  }
  // the most recent completed or current trading day (for weekend/holiday briefings)
  function lastTradingDay(t = now()) {
    for (let i = 0; i < 10; i++) { const e = et(t - i * DAY); if (tradingDay(e.day, e.wd) && (i > 0 || e.min >= 570)) return e.day; }
    return et(t).day;
  }

  // ------------------------------------------------------------ context: portfolios, watchlist, exposure
  function setContext(c) {
    const clean = (s) => String(s || "").toUpperCase().trim().slice(0, 12);
    const ok = (s) => /^[A-Z0-9.\-^=]{1,12}$/.test(s);
    const pfs = (Array.isArray(c.portfolios) ? c.portfolios : []).slice(0, 12).map((p) => ({
      id: String(p.id || "").slice(0, 40), name: String(p.name || "Portfolio").slice(0, 40),
      holdings: (Array.isArray(p.holdings) ? p.holdings : []).slice(0, 60).map((h) => ({ symbol: clean(h.symbol), shares: +h.shares || 0, cost: +h.cost || 0 })).filter((h) => ok(h.symbol) && h.shares > 0),
    }));
    const wl = uniq((Array.isArray(c.watchlist) ? c.watchlist : []).map(clean).filter(ok)).slice(0, 40);
    const before = JSON.stringify([ST.context.portfolios, ST.context.watchlist]);
    ST.context = { portfolios: pfs, watchlist: wl, active: String(c.active || "").slice(0, 40) || (pfs[0] && pfs[0].id) || null, updated: now() };
    const changed = before !== JSON.stringify([pfs, wl]);
    if (changed) {
      for (const t of ["portfolio_scan", "news_sweep", "earnings_watch", "filings_watch"]) enqueue(t, null, { boost: 0.25, reason: "your portfolios or watchlist changed" });
    }
    markDirty();
    return { ok: true, changed, holdings: held().length, watchlist: wl.length };
  }
  const held = () => uniq(ST.context.portfolios.flatMap((p) => p.holdings.map((h) => h.symbol)));
  const tracked = () => uniq([...held(), ...ST.context.watchlist]);
  const traderState = () => { try { return (deps.trader && deps.trader()) || null; } catch { return null; } };
  const traderHeld = () => Object.keys((traderState() || {}).positions || {});
  const traderTop = () => (((traderState() || {}).lastScan || {}).top || []).map((x) => x.sym);
  function sectorOf(sym) {
    const s = String(sym || "").toUpperCase();
    if (isCrypto(s)) return "Crypto";
    if (ETF_SECTOR[s]) return ETF_SECTOR[s];
    if (FUND_CLASS[s]) return FUND_CLASS[s];
    const r = SP.get(s) || SP.get(s.replace(".", "-")) || SP.get(s.replace("-", "."));
    return r ? r.sector : null;
  }
  const industryOf = (sym) => { const r = SP.get(sym); return r ? r.industry : null; };
  const nameOf = (sym) => { const r = SP.get(sym); return r ? r.name : (((ST.exposure || {}).names || {})[sym]) || sym; };

  // ------------------------------------------------------------ relevance + importance
  function relevance(tickers = [], sectors = [], why = []) {
    const ex = ST.exposure || { symWeight: {}, sectorWeight: {}, holders: {} };
    let rel = 0; const syms = [], pfs = new Set(), reasons = [...why];
    for (const t of tickers) {
      const w = ex.symWeight[t];
      if (w != null) { syms.push(t); (ex.holders[t] || []).forEach((n) => pfs.add(n)); rel = Math.max(rel, 0.45 + Math.min(0.55, w * 2.2)); reasons.push(`you hold ${t} (${(w * 100).toFixed(0)}% of a portfolio)`); }
      else if (held().includes(t)) { syms.push(t); rel = Math.max(rel, 0.5); reasons.push(`you hold ${t}`); }
      else if (ST.context.watchlist.includes(t)) { rel = Math.max(rel, 0.35); reasons.push(`${t} is on your watchlist`); }
    }
    for (const s of uniq([...sectors, ...tickers.map(sectorOf)])) {
      const w = ex.sectorWeight[s];
      if (w && w >= 0.05 && !syms.length) { rel = Math.max(rel, Math.min(0.4, w * 1.2)); reasons.push(`${(w * 100).toFixed(0)}% of a portfolio is in ${s}`); }
    }
    return { rel: r2(rel), syms: uniq(syms), pfs: [...pfs], why: uniq(reasons).slice(0, 3) };
  }
  function aiRelevance(tickers = [], cat, tone) {
    const h = traderHeld(), top = traderTop();
    let rel = 0, why = null;
    for (const t of tickers) {
      if (h.includes(t)) { rel = Math.max(rel, 0.9); why = `AI Trader holds ${t}`; }
      else if (top.includes(t)) { if (rel < 0.6) { rel = 0.6; why = `${t} is in AI Trader's top-ranked candidates`; } }
      else if (SP.has(t) && tone) { if (rel < 0.25) { rel = 0.25; why = `${t} is in AI Trader's S&P 500 universe`; } }
    }
    if (!tickers.length && ["market", "macro", "policy"].includes(cat)) { rel = Math.max(rel, 0.4); why = why || "AI Trader's market filters use the S&P 500 trend, VIX and stress headlines"; }
    return { rel: r2(rel), why };
  }
  function importance(d) {
    const base = CAT_BASE[d.cat] ?? 0.4, mag = clamp(d.mag ?? 0.4, 0, 1);
    const v = 100 * (0.35 * base + 0.35 * mag + 0.2 * (d.pf ? d.pf.rel : 0) + 0.1 * (d.ai ? d.ai.rel : 0));
    return Math.round(clamp(v, 1, 100));
  }

  // ------------------------------------------------------------ research memory
  const byKey = () => { const m = new Map(); for (const d of DISC) m.set(d.key, d); return m; };
  let KEYS = null; const keys = () => (KEYS || (KEYS = byKey()));
  function discover(input, job) {
    const t = now(), k = keys();
    const d0 = k.get(input.key);
    const tickers = uniq((input.tickers || []).map((x) => String(x).toUpperCase())).slice(0, 12);
    const sectors = uniq([...(input.sectors || []), ...tickers.map(sectorOf)]).slice(0, 6);
    const pf = relevance(tickers, sectors, input.pfWhy || []);
    if (input.pfBoost) pf.rel = r2(Math.max(pf.rel, input.pfBoost));
    const ai = aiRelevance(tickers, input.cat, input.tone);
    const sig = (input.headline || "") + "|" + (input.summary || "");
    const fields = {
      cat: input.cat, headline: String(input.headline || "").slice(0, 220), summary: String(input.summary || "").slice(0, 900),
      facts: (input.facts || []).slice(0, 10).map((f) => (typeof f === "string" ? { text: f, kind: "fact" } : { text: String(f.text).slice(0, 400), kind: f.kind || "fact", src: f.src || null, at: f.at || null })),
      interp: input.interp ? { text: String(input.interp.text || input.interp).slice(0, 600), kind: input.interp.kind || "interpretation" } : null,
      tickers, sectors, tone: clamp(input.tone || 0, -2, 2), mag: input.mag ?? 0.4, conf: clamp(input.conf ?? 0.6, 0, 1),
      sources: (input.sources || []).filter((s) => s && s.name).slice(0, 8).map((s) => ({ name: String(s.name).slice(0, 80), url: s.url && /^https:\/\//.test(s.url) ? s.url : null, at: s.at || null })),
      links: (input.links || []).slice(0, 4), pf, ai, explore: !!input.explore, data: input.data || null,
    };
    fields.importance = input.importance != null ? input.importance : importance(fields);
    if (d0) {
      if (d0.sig === sig) { d0.u = t; d0.seen = (d0.seen || 1) + 1; d0.pf = pf; d0.ai = ai; markDirty(); return { d: d0, isNew: false, changed: false }; }
      d0.prev = [{ v: d0.v, u: d0.u, headline: d0.headline, summary: d0.summary }, ...(d0.prev || [])].slice(0, 5);
      Object.assign(d0, fields, { v: (d0.v || 1) + 1, u: t, sig, job: job ? job.id : d0.job, exp: t + (EXPIRY[input.cat] || 7) * DAY });
      if (input.hyp && !d0.hyp) d0.hyp = { ...input.hyp, t0: t, status: "open", due: t + (input.hyp.days || 7) * DAY };
      relink(d0); markDirty(); emit({ type: "discovery", d: d0, changed: true });
      return { d: d0, isNew: false, changed: true };
    }
    const d = { id: nextId("d"), key: input.key, v: 1, t, u: t, sig, ...fields, job: job ? job.id : null, exp: t + (EXPIRY[input.cat] || 7) * DAY, rel: [] };
    if (input.hyp) d.hyp = { ...input.hyp, t0: t, status: "open", due: t + (input.hyp.days || 7) * DAY };
    DISC.unshift(d); k.set(d.key, d); relink(d);
    if (DISC.length > DISC_CAP) prune(true);
    const day = et(t).day; if (ST.stats.day !== day) ST.stats = { ...ST.stats, day, jobs: 0, discoveries: 0, errors: 0 };
    ST.stats.discoveries++;
    markDirty(); emit({ type: "discovery", d, changed: false });
    return { d, isNew: true, changed: false };
  }
  // connect a discovery to earlier ones about the same company (or the same sector for sector-level findings)
  function relink(d) {
    const cutoff = now() - 30 * DAY, out = [];
    for (const o of DISC) {
      if (o === d || o.u < cutoff) continue;
      const shared = d.tickers.find((t) => o.tickers.includes(t)) || (!d.tickers.length && d.sectors.find((s) => o.sectors.includes(s) && !o.tickers.length));
      if (shared) { out.push(o.id); if (!(o.rel || []).includes(d.id)) o.rel = [d.id, ...(o.rel || [])].slice(0, 8); }
      if (out.length >= 8) break;
    }
    d.rel = out;
  }
  function prune(force) {
    const t = now(), before = DISC.length;
    DISC = DISC.filter((d) => d.exp > t || (d.hyp && d.hyp.status === "open"));
    if (DISC.length > DISC_CAP || force) { DISC.sort((a, b) => b.u - a.u); DISC = DISC.slice(0, DISC_CAP - 50); }
    KEYS = null; const live = new Set(DISC.map((d) => d.id));
    for (const d of DISC) d.rel = (d.rel || []).filter((id) => live.has(id));
    if (DISC.length !== before) markDirty();
    return before - DISC.length;
  }
  const discFor = (sym, days = 30) => DISC.filter((d) => d.tickers.includes(sym) && d.u >= now() - days * DAY).sort((a, b) => b.u - a.u);
  const coverage = (sym) => DISC.filter((d) => d.tickers.includes(sym) && d.u >= now() - DAY).length;

  // ------------------------------------------------------------ queue + priority engine
  function prioritize(j) {
    const spec = JOBS[j.type], t = now(), open = marketOpen(t), x = j.extra || {};
    const ttl = spec.ttl ? spec.ttl[open ? 0 : 1] * MIN : 6 * HOUR;
    const last = ST.lastRun[j.key];
    const P = {};
    if (j.sym) {
      const r = relevance([j.sym]);
      P.portfolio = r.rel; P.ai = aiRelevance([j.sym], null, 1).rel;
      P.gap = ST.researched[j.sym] ? clamp((t - ST.researched[j.sym]) / (14 * DAY), 0, 1) : 1;
      P.coverage = clamp(coverage(j.sym) / 5, 0, 1);
    } else {
      P.portfolio = { portfolio_scan: held().length ? 1 : 0, news_sweep: 0.6, earnings_watch: 0.7, filings_watch: 0.6, market_pulse: 0.5, policy_watch: 0.4, macro_check: 0.4, ai_trader_sync: 0.3, explore: 0.1, briefing: 0.8 }[j.type] ?? 0.1;
      P.ai = { ai_trader_sync: 0.8, market_pulse: 0.5, news_sweep: 0.4, briefing: 0.4 }[j.type] ?? 0.1;
      P.gap = 0.3; P.coverage = 0;
    }
    P.impact = x.impact ?? ({ market_pulse: open ? 0.7 : 0.3, policy_watch: 0.6, macro_check: 0.5, news_sweep: 0.5, earnings_watch: 0.6, filings_watch: 0.5, briefing: 0.7, explore: 0.3 }[j.type] ?? 0.4);
    P.freshness = last ? clamp((t - last) / ttl, 0, 2) / 2 : 1;
    P.reliability = RELIABILITY[spec.rel] ?? 0.7;
    P.move = clamp(Math.abs(x.move || 0) / 10, 0, 1);
    P.catalyst = clamp(x.catalyst || 0, 0, 1);
    const W = { portfolio: 0.22, impact: 0.16, freshness: 0.12, reliability: 0.06, move: 0.1, catalyst: 0.1, gap: 0.08, ai: 0.1, coverage: -0.1 };
    let score = 0; const contrib = [];
    for (const k in W) { const c = W[k] * (P[k] || 0); score += c; contrib.push([k, c]); }
    score = Math.round(clamp(score * 100 + (j.boost || 0) * 100, 0, 150));
    const NAMES = { portfolio: "portfolio relevance", impact: "market impact", freshness: "data is due for a refresh", reliability: "reliable primary source", move: "large price move", catalyst: "upcoming catalyst", gap: "not researched recently", ai: "matters to AI Trader" };
    const why = contrib.filter(([k, c]) => c > 0.02 && NAMES[k]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => NAMES[k]);
    if (j.reason) why.unshift(j.reason);
    if (P.coverage > 0.5) why.push("already well covered today");
    j.prio = { score, parts: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, r2(v)])), why: uniq(why).slice(0, 4) };
    return j;
  }
  function enqueue(type, sym, opts = {}) {
    if (!JOBS[type]) return null;
    if (JOBS[type].sym && !sym) return null;
    const key = type + ":" + (sym || opts.slot || "");
    const ex = ST.queue.find((j) => j.key === key);
    if (ex) { // re-prioritize: keep the strongest reason
      if ((opts.boost || 0) > (ex.boost || 0)) { ex.boost = opts.boost; ex.reason = opts.reason || ex.reason; ex.extra = { ...(ex.extra || {}), ...(opts.extra || {}) }; }
      return ex;
    }
    if (running && running.key === key) return null;
    if ((opts.depth || 0) > MAX_DEPTH) return null;
    // event-driven jobs for one company don't repeat within a cool-down unless something new happened
    const last = ST.lastRun[key];
    if (sym && last && now() - last < (opts.cooldown ?? 3 * HOUR) && !opts.force) return null;
    if (ST.queue.length >= QUEUE_CAP) { // drop the weakest job to make room only if the new one is stronger
      ST.queue.forEach(prioritize); ST.queue.sort((a, b) => b.prio.score - a.prio.score);
      const j0 = prioritize({ type, sym, key, boost: opts.boost || 0, extra: opts.extra || {} });
      if (j0.prio.score <= ST.queue[ST.queue.length - 1].prio.score) return null;
      ST.queue.pop();
    }
    const j = prioritize({ id: nextId("j"), type, sym: sym || null, slot: opts.slot || null, key, boost: opts.boost || 0, reason: opts.reason || null, depth: opts.depth || 0, extra: opts.extra || {}, created: now(), notBefore: opts.notBefore || 0, tries: 0, manual: !!opts.manual });
    ST.queue.push(j); markDirty();
    return j;
  }
  function plan() {
    const t = now(), open = marketOpen(t);
    for (const [type, spec] of Object.entries(JOBS)) {
      if (!spec.ttl) continue;
      if (type === "portfolio_scan" && !held().length) continue;
      const last = ST.lastRun[type] || 0;
      if (t - last >= spec.ttl[open ? 0 : 1] * MIN) enqueue(type, null, {});
    }
    // briefings: one per slot per trading day, generated inside the slot's window (catch-up after a wake-up)
    const s = session(t);
    if (s.trading) for (const [slot, w] of Object.entries(SLOTS)) {
      const from = slot === "close" && s.closeMin === 13 * 60 ? 13 * 60 + 10 : w.from;
      if (s.min >= from && s.min <= w.to && !BIDX.some((b) => b.day === s.day && b.slot === slot)) enqueue("briefing", null, { slot, boost: 0.6, reason: `the ${w.label.toLowerCase()} briefing is due` });
    }
  }

  // ------------------------------------------------------------ worker
  const activity = { state: "idle", note: "", at: 0 };
  function setPhase(job, phase, note) {
    activity.state = VISUAL[phase] || phase; activity.note = note || ""; activity.at = now();
    if (job) { job.phase = activity.state; job.note = note || job.note; job.phases = [...(job.phases || []), { t: now(), p: activity.state, n: (note || "").slice(0, 120) }].slice(-12); }
    emit({ type: "phase", state: activity.state, note: activity.note, job: job ? job.id : null });
  }
  function emit(ev) { for (const fn of listeners) { try { fn(ev); } catch {} } }
  const labelOf = (j) => { const L = JOBS[j.type].label; return typeof L === "function" ? L(j.sym || (j.slot && SLOTS[j.slot] ? SLOTS[j.slot].label.toLowerCase() : j.slot) || "") : L; };
  const goOf = (j) => { const g = JOBS[j.type].go; return typeof g === "function" ? g(j.sym) : g || (j.sym ? "q:" + j.sym : null); };

  async function runJob(j) {
    const spec = JOBS[j.type];
    running = { ...j, label: labelOf(j), started: now() };
    const log = { id: j.id, type: j.type, sym: j.sym, slot: j.slot, label: running.label, area: spec.area, go: goOf(j), started: running.started, prio: j.prio, status: "running", found: 0, updated: 0, phases: [] };
    ST.jobs.unshift(log); ST.jobs = ST.jobs.slice(0, LOG_CAP);
    let found = 0, updated = 0;
    const ctx = {
      job: j, deps, sym: j.sym,
      phase: (p, note) => { setPhase(log, p, note); },
      discover: (d) => { const r = discover(d, j); if (r.isNew) found++; else if (r.changed) updated++; log.found = found; log.updated = updated; if (r.isNew || r.changed) setPhase(log, "discover", d.headline); return r.d; },
      follow: (type, sym, opts = {}) => enqueue(type, sym, { ...opts, depth: (j.depth || 0) + 1 }),
    };
    try {
      const res = await withTimeout(RUNNERS[j.type](ctx), spec.timeout * 1000, `timed out after ${spec.timeout}s`);
      Object.assign(log, { status: "done", ended: now(), result: (res && res.summary) || null, found, updated });
      ST.lastRun[j.key] = now(); if (!j.sym && j.type !== "briefing") ST.lastRun[j.type] = now();
      if (j.sym) ST.researched[j.sym] = now();
      setPhase(log, "save", "saved to research memory");
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      Object.assign(log, { status: "error", ended: now(), error: msg, found, updated });
      ST.stats.errors++; lastTickError = `${j.type}: ${msg}`;
      if (j.tries < 2) { // retry with a growing pause
        const rj = { ...j, id: nextId("j"), tries: j.tries + 1, notBefore: now() + (j.tries + 1) * 4 * MIN };
        delete rj.prio; ST.queue.push(prioritize(rj));
      } else { ST.lastRun[j.key] = now(); if (!j.sym && j.type !== "briefing") ST.lastRun[j.type] = now(); }
      activity.state = "error"; activity.note = msg; activity.at = now();
      emit({ type: "phase", state: "error", note: msg, job: j.id });
    } finally {
      log.phases = (log.phases || []).slice(-8);
      ST.stats.jobs++; ST.stats.total = (ST.stats.total || 0) + 1; ST.hour.push(now());
      running = null; markDirty();
      if (activity.state !== "error") { activity.state = "idle"; activity.note = ""; }
    }
    return log;
  }
  async function tick() {
    if (stopped) return;
    lastTickAt = now();
    try {
      await load();
      const day = et().day; if (ST.stats.day !== day) ST.stats = { ...ST.stats, day, jobs: 0, discoveries: 0, errors: 0 };
      plan();
      if (running) return;
      ST.hour = ST.hour.filter((t) => now() - t < HOUR);
      if (ST.hour.length >= MAX_PER_HOUR) { activity.state = "idle"; activity.note = `hourly research budget reached (${MAX_PER_HOUR} jobs) — resuming shortly`; return; }
      ST.queue.forEach(prioritize);
      ST.queue.sort((a, b) => b.prio.score - a.prio.score || a.created - b.created);
      const i = ST.queue.findIndex((j) => (j.notBefore || 0) <= now());
      if (i < 0) return;
      const [j] = ST.queue.splice(i, 1);
      await runJob(j);
      if (now() - lastSave > 60e3 || ["briefing"].includes(j.type)) await save();
    } catch (e) { lastTickError = String(e.message || e); }
  }
  function start(intervalMs = 15e3, firstDelay = 20e3) {
    stopped = false;
    const loop = () => { if (stopped) return; tick().finally(() => { if (!stopped) timer = setTimeout(loop, intervalMs); }); };
    timer = setTimeout(loop, firstDelay); if (timer.unref) timer.unref();
    const saver = setInterval(() => { if (dirty && now() - lastSave > 60e3) save(); }, 30e3); if (saver.unref) saver.unref();
  }
  function stop() { stopped = true; clearTimeout(timer); }
  async function runNow(type, sym, opts = {}) { // used by tests and the manual "Generate briefing" / "Research" actions
    await load();
    const j = enqueue(type, sym, { ...opts, force: true, boost: (opts.boost || 0) + 1, manual: true });
    if (!j) return null;
    if (running) return { queued: true, job: j };
    ST.queue = ST.queue.filter((x) => x !== j);
    return runJob(j);
  }

  // ------------------------------------------------------------ helpers for runners
  const q = async (syms) => (syms.length ? (await deps.quotes(syms)).quotes || {} : {});
  const ok = (x) => x && !x.error && x.price != null;
  const quoteAge = (x) => (x && x.marketTime ? now() - x.marketTime : null);
  function freshness(quotes) {
    const times = Object.values(quotes).filter(ok).map((x) => x.marketTime).filter(Boolean);
    const latest = times.length ? Math.max(...times) : null, open = marketOpen();
    const status = !latest ? "unavailable" : open ? (now() - latest < 20 * MIN ? "live" : "delayed") : "close";
    return { latest, status };
  }
  async function returnsOf(sym, range = "6mo") {
    const h = await deps.history(sym, range); const c = (h.candles || []).filter((x) => x.close != null);
    const map = new Map(); for (let i = 1; i < c.length; i++) map.set(Math.floor(c[i].time / 86400), Math.log(c[i].close / c[i - 1].close));
    return { map, candles: c, name: h.name };
  }
  function corr(a, b) {
    const xs = [], ys = []; for (const [k, v] of a) if (b.has(k)) { xs.push(v); ys.push(b.get(k)); }
    const n = xs.length; if (n < 40) return null;
    const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }
  const tone = (title) => { try { return deps.tone ? deps.tone(title) : 0; } catch { return 0; } };
  const srcName = (k) => (deps.sourceName ? deps.sourceName(k) : k) || k;
  const toneWord = (x) => (x >= 1.5 ? "clearly positive" : x >= 0.5 ? "leaning positive" : x <= -1.5 ? "clearly negative" : x <= -0.5 ? "leaning negative" : "mixed / neutral");
  let SPM = null; // S&P 500 headline matchers, built once
  const spMatchers = () => SPM || (SPM = [...SP.values()].map((r) => { try { return [r.sym, deps.matcher ? deps.matcher(r.sym, r.name) : new RegExp(`\\(${r.sym}\\)`)]; } catch { return null; } }).filter(Boolean));

  // ------------------------------------------------------------ job runners
  const RUNNERS = {
    async portfolio_scan(c) {
      const pfs = ST.context.portfolios.filter((p) => p.holdings.length);
      if (!pfs.length) return { summary: "No holdings shared yet — open your Portfolio tab once so the Spider can see them." };
      c.phase("fetch", `Pricing ${held().length} holdings across ${pfs.length} portfolio${pfs.length > 1 ? "s" : ""}`);
      const Q = await q(uniq([...held(), ...ST.context.watchlist]).slice(0, 80));
      c.phase("analyze", "Measuring allocation, sector exposure and concentration");
      const symWeight = {}, sectorWeight = {}, holders = {}, names = {}, out = [];
      for (const p of pfs) {
        const rows = p.holdings.map((h) => { const x = Q[h.symbol]; const px = ok(x) ? x.price : h.cost; if (ok(x)) names[h.symbol] = x.name; return { ...h, px, value: h.shares * px, day: ok(x) ? h.shares * (x.change || 0) : 0, dayPct: ok(x) ? x.changePct || 0 : 0, priced: ok(x) }; });
        const value = rows.reduce((a, r) => a + r.value, 0) || 1;
        const agg = {}; for (const r of rows) agg[r.symbol] = (agg[r.symbol] || 0) + r.value;
        const weights = Object.fromEntries(Object.entries(agg).map(([s, v]) => [s, v / value]));
        const sectors = {}; for (const [s, w] of Object.entries(weights)) { const k = sectorOf(s) || "Unclassified"; sectors[k] = (sectors[k] || 0) + w; }
        for (const [s, w] of Object.entries(weights)) { symWeight[s] = Math.max(symWeight[s] || 0, w); (holders[s] = holders[s] || []).push(p.name); }
        for (const [k, w] of Object.entries(sectors)) sectorWeight[k] = Math.max(sectorWeight[k] || 0, w);
        const pricedN = rows.filter((r) => r.priced).length;
        const day = pricedN ? rows.reduce((a, r) => a + r.day, 0) : null, dayPct = pricedN ? (day / Math.max(1, value - day)) * 100 : null;
        const hhi = Object.values(weights).reduce((a, w) => a + w * w, 0);
        const top = Object.entries(weights).sort((a, b) => b[1] - a[1]), topSec = Object.entries(sectors).sort((a, b) => b[1] - a[1]);
        out.push({ id: p.id, name: p.name, value, day, dayPct, weights, sectors, hhi, top, topSec, rows, priced: pricedN });
      }
      ST.exposure = { at: now(), symWeight, sectorWeight, holders, names, pfs: out.map((p) => ({ id: p.id, name: p.name, value: r2(p.value), day: p.day == null ? null : r2(p.day), dayPct: p.dayPct == null ? null : r2(p.dayPct), priced: p.priced, holdings: p.rows.length, hhi: r2(p.hhi), weights: Object.fromEntries(Object.entries(p.weights).map(([k, v]) => [k, r2(v)])), sectors: Object.fromEntries(Object.entries(p.sectors).map(([k, v]) => [k, r2(v)])) })) };
      const fr = freshness(Q), today = et().day, srcQ = { name: "Yahoo Finance quotes", at: fr.latest };
      for (const p of out) {
        const [s1, w1] = p.top[0] || [], [sec1, sw1] = p.topSec[0] || [];
        const effN = p.hhi ? 1 / p.hhi : 0;
        const conc = (w1 || 0) >= 0.25 || (sw1 || 0) >= 0.45;
        c.discover({ key: `exposure:${p.id}`, cat: "portfolio", tickers: p.top.slice(0, 3).map((x) => x[0]), pfBoost: 0.8,
          headline: `${p.name}: ${(sw1 * 100).toFixed(0)}% in ${sec1}${s1 ? `, largest holding ${s1} at ${(w1 * 100).toFixed(0)}%` : ""}`,
          summary: `${p.rows.length} holdings worth ${money(p.value)}${p.priced < p.rows.length ? ` (${p.rows.length - p.priced} valued at cost — no live price)` : ""}. Sector mix: ${p.topSec.slice(0, 4).map(([k, w]) => `${k} ${(w * 100).toFixed(0)}%`).join(", ")}. It behaves like about ${effN.toFixed(1)} equal-sized positions (Herfindahl ${p.hhi.toFixed(2)}).`,
          facts: [{ text: `Weights from shares × latest price: ${p.top.slice(0, 5).map(([k, w]) => `${k} ${(w * 100).toFixed(1)}%`).join(", ")}`, src: "Yahoo Finance quotes + your holdings", at: fr.latest }, { text: "Sectors from the S&P 500 constituent list (GICS) and fund categories", src: "github.com/datasets/s-and-p-500-companies" }],
          interp: conc ? { text: `Concentrated: ${(w1 >= 0.25 ? `${s1} alone drives about a quarter or more of results` : `${sec1} dominates`)} — a single company or sector event can move the whole portfolio.`, kind: "interpretation" } : { text: "Reasonably spread out — no single holding or sector dominates.", kind: "interpretation" },
          mag: conc ? 0.7 : 0.3, tone: 0, conf: 0.9, sources: [srcQ], links: [{ label: "Open portfolio", go: "#portfolio" }, { label: "Risk & stress test", go: "#risk" }], data: { value: p.value, sectors: p.sectors, top: p.top.slice(0, 8) } });
        if (p.dayPct != null && Math.abs(p.dayPct) >= 1.5) {
          const movers = p.rows.slice().sort((a, b) => Math.abs(b.day) - Math.abs(a.day)).slice(0, 3);
          c.discover({ key: `pfday:${p.id}:${today}`, cat: "portfolio", tickers: movers.map((m) => m.symbol), pfBoost: 0.85,
            headline: `${p.name} is ${p.dayPct >= 0 ? "up" : "down"} ${Math.abs(p.dayPct).toFixed(1)}% today (${p.day >= 0 ? "+" : "−"}${money(Math.abs(p.day)).replace("−", "")})`,
            summary: `Biggest contributors: ${movers.map((m) => `${m.symbol} ${pctS(m.dayPct)} (${m.day >= 0 ? "+" : "−"}${money(Math.abs(m.day)).replace("−", "")})`).join(", ")}.`,
            facts: [{ text: `Day change summed from each holding's change since the previous close`, src: "Yahoo Finance quotes", at: fr.latest }], mag: clamp(Math.abs(p.dayPct) / 4, 0, 1), tone: p.dayPct >= 0 ? 1 : -1, conf: 0.9, sources: [srcQ], links: [{ label: "Open portfolio", go: "#portfolio" }] });
        }
        for (const r of p.rows) if (r.priced && Math.abs(r.dayPct) >= 4) {
          c.follow("investigate_mover", r.symbol, { boost: 0.35, reason: `you hold ${r.symbol} and it moved ${pctS(r.dayPct)}`, extra: { move: r.dayPct }, cooldown: 2 * HOUR });
        }
      }
      // correlations inside the largest portfolio (shared risk that weights alone don't show)
      const big = out.slice().sort((a, b) => b.value - a.value)[0];
      const corrSyms = big ? big.top.map((x) => x[0]).filter((s) => !isIndexish(s)).slice(0, 10) : [];
      if (corrSyms.length >= 2) {
        c.phase("fetch", `Loading 6 months of prices for ${corrSyms.length} holdings`);
        const R = {}; for (const s of corrSyms) { try { R[s] = (await returnsOf(s, "6mo")).map; } catch {} }
        c.phase("connect", "Measuring which holdings move together");
        const pairs = [];
        const ks = Object.keys(R); for (let i = 0; i < ks.length; i++) for (let k = i + 1; k < ks.length; k++) { const v = corr(R[ks[i]], R[ks[k]]); if (v != null) pairs.push([ks[i], ks[k], v]); }
        ST.exposure.corr = pairs.map(([a, b, v]) => [a, b, r2(v)]);
        const tight = pairs.filter((p) => p[2] >= 0.75).sort((a, b) => b[2] - a[2]);
        if (tight.length) {
          c.discover({ key: `corr:${big.id}`, cat: "portfolio", tickers: uniq(tight.slice(0, 3).flatMap((p) => [p[0], p[1]])), pfBoost: 0.75,
            headline: `${big.name}: ${tight.length} pair${tight.length > 1 ? "s" : ""} of holdings move almost in lockstep`,
            summary: tight.slice(0, 4).map(([a, b, v]) => `${a} & ${b} (correlation ${v.toFixed(2)})`).join(", ") + " over the past 6 months of daily returns.",
            facts: [{ text: "Pearson correlation of daily log returns, ~6 months, at least 40 shared trading days", src: "Yahoo Finance daily prices" }],
            interp: { text: "Highly correlated holdings add less diversification than their count suggests — they tend to fall together.", kind: "interpretation" },
            mag: clamp((tight[0][2] - 0.6) * 2.5, 0.3, 0.9), conf: 0.85, sources: [{ name: "Yahoo Finance daily prices", at: now() }], links: [{ label: "Risk & stress test", go: "#risk" }] });
        }
      }
      // shared-event pattern: several holdings in one sector moving the same way today
      const bySec = {};
      for (const p of out) for (const r of p.rows) if (r.priced && Math.abs(r.dayPct) >= 2.5) { const s = sectorOf(r.symbol) || "Unclassified"; (bySec[s] = bySec[s] || new Map()).set(r.symbol, r.dayPct); }
      for (const [s, m] of Object.entries(bySec)) {
        const up = [...m].filter(([, v]) => v > 0), dn = [...m].filter(([, v]) => v < 0), grp = up.length >= 2 ? up : dn.length >= 2 ? dn : null;
        if (grp) c.discover({ key: `pfsec:${s}:${today}:${grp === up ? "up" : "dn"}`, cat: "pattern", tickers: grp.map((x) => x[0]), sectors: [s], pfBoost: 0.7,
          headline: `${grp.length} of your ${s} holdings are ${grp === up ? "rising" : "falling"} together today`, summary: grp.map(([k, v]) => `${k} ${pctS(v)}`).join(", "),
          facts: [{ text: "Same-day moves of 2.5% or more", src: "Yahoo Finance quotes", at: fr.latest }], interp: { text: "A shared move usually points to a sector-wide driver (rates, a peer's results, policy) rather than company news.", kind: "interpretation" },
          mag: 0.6, tone: grp === up ? 1 : -1, conf: 0.7, sources: [srcQ] });
      }
      return { summary: `${out.length} portfolio${out.length > 1 ? "s" : ""} · ${held().length} holdings mapped to ${Object.keys(sectorWeight).length} sectors` };
    },

    async market_pulse(c) {
      c.phase("fetch", "Indexes, VIX, Treasury yields, oil, dollar and the 11 sector ETFs");
      const IDX = ["^GSPC", "^IXIC", "^DJI", "^RUT", "^VIX", "^TNX", "CL=F", "GC=F", "DX-Y.NYB", "BTC-USD"];
      const Q = await q([...IDX, ...Object.values(SECTOR_ETF)]);
      let snap = null; try { c.phase("fetch", "S&P 500 heatmap snapshot (all 503 companies)"); snap = await deps.sp500(); } catch {}
      c.phase("analyze", "Index moves, breadth, sector rotation and unusual movers");
      const fr = freshness(Q), src = { name: "Yahoo Finance quotes", at: fr.latest };
      const idx = Object.fromEntries(IDX.filter((s) => ok(Q[s])).map((s) => [s, { name: Q[s].name, price: Q[s].price, chg: Q[s].changePct, change: Q[s].change, t: Q[s].marketTime }]));
      const sectors = Object.entries(SECTOR_ETF).filter(([, e]) => ok(Q[e])).map(([n, e]) => ({ name: n, etf: e, chg: Q[e].changePct })).sort((a, b) => b.chg - a.chg);
      let breadth = null, movers = [];
      if (snap && snap.quotes) {
        const rows = Object.entries(snap.quotes).filter(([, v]) => v && v[2] != null);
        const up = rows.filter(([, v]) => v[2] > 0).length, dn = rows.filter(([, v]) => v[2] < 0).length;
        breadth = { up, down: dn, n: rows.length, at: snap.updated };
        movers = rows.map(([s, v]) => ({ sym: s, chg: v[2], cap: v[3] })).filter((m) => Math.abs(m.chg) >= 5).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 12);
      }
      ST.market = { at: now(), fresh: fr, idx, sectors, breadth, movers };
      const day = et().day, spx = idx["^GSPC"], vix = idx["^VIX"], tnx = idx["^TNX"], oil = idx["CL=F"];
      const asOf = fr.status === "live" ? "live" : fr.status === "delayed" ? "delayed quote" : "last close";
      if (spx && Math.abs(spx.chg) >= 1) {
        const lead = sectors[0], lag = sectors[sectors.length - 1];
        c.discover({ key: `idx:spx:${day}`, cat: "market", tickers: [], headline: `S&P 500 ${spx.chg >= 0 ? "up" : "down"} ${Math.abs(spx.chg).toFixed(1)}% (${asOf})`,
          summary: `${breadth ? `${breadth.up} of ${breadth.n} S&P 500 stocks are higher. ` : ""}${lead && lag ? `${lead.name} leads (${pctS(lead.chg)}), ${lag.name} lags (${pctS(lag.chg)}).` : ""}`,
          facts: [{ text: `S&P 500 at ${spx.price.toFixed(2)}, ${pctS(spx.chg, 2)} vs. the previous close`, src: "Yahoo Finance", at: spx.t }],
          interp: { text: Math.abs(spx.chg) >= 2 ? "A move this large is unusual — most days the index moves less than 1%." : "A notable but not extreme day.", kind: "interpretation" },
          mag: clamp(Math.abs(spx.chg) / 3, 0.3, 1), tone: spx.chg > 0 ? 1 : -1, conf: 0.95, sources: [src], links: [{ label: "Market analysis", go: "#analysis" }, { label: "Heatmap", go: "#nyse" }] });
      }
      if (vix && (vix.price >= 22 || Math.abs(vix.chg) >= 12)) c.discover({ key: `vix:${day}`, cat: "market", headline: `Volatility ${vix.chg >= 0 ? "jumps" : "eases"}: VIX ${vix.price.toFixed(1)} (${pctS(vix.chg)})`,
        summary: vix.price >= 30 ? "Fear is elevated: options traders are paying up for protection." : vix.price >= 22 ? "Above its long-run average near 19–20 — investors are nervous." : "A big swing in expected volatility.",
        facts: [{ text: `VIX ${vix.price.toFixed(2)}, ${pctS(vix.chg)} today`, src: "Cboe VIX via Yahoo Finance", at: vix.t }], interp: { text: "AI Trader enters defense mode when the VIX reaches 35 or jumps 25% in a day.", kind: "interpretation" },
        mag: clamp((vix.price - 15) / 20, 0.3, 1), tone: vix.chg > 0 ? -1 : 1, conf: 0.9, sources: [src] });
      if (tnx && Math.abs(tnx.change) >= 0.07) c.discover({ key: `tnx:${day}`, cat: "macro", sectors: Object.keys(MACRO_LINKS[0].sectors), headline: `10-year Treasury yield ${tnx.change > 0 ? "rises" : "falls"} ${Math.abs(tnx.change * 100).toFixed(0)} bp to ${tnx.price.toFixed(2)}%`,
        summary: "Moves of 7+ basis points in a day matter for rate-sensitive stocks.", facts: [{ text: `^TNX ${tnx.price.toFixed(3)}%, change ${(tnx.change * 100).toFixed(1)} bp`, src: "Yahoo Finance (CBOE 10-year yield index)", at: tnx.t }],
        interp: { text: `Rate-sensitive areas: ${Object.entries(MACRO_LINKS[0].sectors).slice(0, 4).map(([k, v]) => `${k} (${v})`).join("; ")}.`, kind: "interpretation" }, mag: clamp(Math.abs(tnx.change) / 0.2, 0.3, 1), tone: tnx.change > 0 ? -1 : 1, conf: 0.9, sources: [src], links: [{ label: "Macro dashboard", go: "#macro" }] });
      if (oil && Math.abs(oil.chg) >= 3) c.discover({ key: `oil:${day}`, cat: "macro", sectors: ["Energy"], headline: `Crude oil ${oil.chg >= 0 ? "jumps" : "drops"} ${Math.abs(oil.chg).toFixed(1)}% to $${oil.price.toFixed(2)}`, summary: "Large oil moves feed through to energy producers and fuel-heavy industries.",
        facts: [{ text: `WTI front-month futures ${oil.price.toFixed(2)}, ${pctS(oil.chg)}`, src: "NYMEX via Yahoo Finance", at: oil.t }], interp: { text: Object.entries(MACRO_LINKS[6].sectors).map(([k, v]) => `${k}: ${v}`).join("; "), kind: "interpretation" }, mag: clamp(Math.abs(oil.chg) / 6, 0.3, 1), tone: 0, conf: 0.9, sources: [src] });
      if (sectors.length >= 6 && sectors[0].chg - sectors[sectors.length - 1].chg >= 2) {
        const def = ["Utilities", "Consumer Staples", "Health Care", "Real Estate"], top3 = sectors.slice(0, 3);
        const style = top3.filter((s) => def.includes(s.name)).length >= 2 ? "defensive (risk-off)" : top3.filter((s) => ["Information Technology", "Consumer Discretionary", "Communication Services", "Financials", "Industrials"].includes(s.name)).length >= 2 ? "cyclical / growth (risk-on)" : "mixed";
        c.discover({ key: `rotation:${day}`, cat: "sector", sectors: [sectors[0].name, sectors[sectors.length - 1].name], headline: `Sector rotation: ${sectors[0].name} ${pctS(sectors[0].chg)} vs. ${sectors[sectors.length - 1].name} ${pctS(sectors[sectors.length - 1].chg)}`,
          summary: `Leaders: ${top3.map((s) => `${s.name} ${pctS(s.chg)}`).join(", ")}. Laggards: ${sectors.slice(-3).reverse().map((s) => `${s.name} ${pctS(s.chg)}`).join(", ")}.`,
          facts: [{ text: "Moves of the 11 SPDR sector ETFs (XLK, XLF, XLE…)", src: "Yahoo Finance", at: fr.latest }], interp: { text: `Leadership looks ${style}.`, kind: "interpretation" }, mag: clamp((sectors[0].chg - sectors[sectors.length - 1].chg) / 4, 0.3, 0.9), conf: 0.8, sources: [src], links: [{ label: "Heatmap", go: "#nyse" }] });
      }
      if (breadth && breadth.n > 100 && (breadth.up / breadth.n >= 0.8 || breadth.down / breadth.n >= 0.8)) c.discover({ key: `breadth:${day}`, cat: "market", headline: `Lopsided breadth: ${breadth.up} up / ${breadth.down} down in the S&P 500`, summary: breadth.up > breadth.down ? "A broad rally — most companies are participating, not just a few megacaps." : "Broad selling — the decline is not confined to a few names.",
        facts: [{ text: `Advancers ${breadth.up}, decliners ${breadth.down} of ${breadth.n}`, src: "Yahoo Finance S&P 500 snapshot", at: breadth.at }], mag: 0.6, tone: breadth.up > breadth.down ? 1 : -1, conf: 0.85, sources: [{ name: "Yahoo Finance S&P 500 snapshot", at: breadth.at }] });
      // unusual movers become follow-up investigations (holdings first, then the biggest moves)
      const H = new Set(tracked());
      movers.sort((a, b) => (H.has(b.sym) - H.has(a.sym)) || Math.abs(b.chg) - Math.abs(a.chg)).slice(0, 4).forEach((m) => c.follow("investigate_mover", m.sym, { boost: H.has(m.sym) ? 0.3 : 0.1, reason: `${m.sym} moved ${pctS(m.chg)} today`, extra: { move: m.chg } }));
      // pattern: several S&P companies in one sector making big moves the same direction
      const bySec = {}; for (const m of movers) { const s = sectorOf(m.sym); if (s) (bySec[s + (m.chg > 0 ? "+" : "-")] = bySec[s + (m.chg > 0 ? "+" : "-")] || []).push(m); }
      for (const [k, list] of Object.entries(bySec)) if (list.length >= 3) {
        const s = k.slice(0, -1), up = k.endsWith("+");
        c.discover({ key: `secmove:${k}:${day}`, cat: "pattern", sectors: [s], tickers: list.map((m) => m.sym).slice(0, 6), headline: `Pattern: ${list.length} ${s} stocks ${up ? "up" : "down"} 5%+ today`, summary: list.map((m) => `${m.sym} ${pctS(m.chg)}`).join(", "),
          facts: [{ text: "S&P 500 members with daily moves of 5% or more", src: "Yahoo Finance S&P 500 snapshot", at: breadth && breadth.at }], interp: { text: "When several peers move together, the driver is usually industry-wide (a peer's earnings, regulation, input costs).", kind: "interpretation" }, mag: 0.7, tone: up ? 1 : -1, conf: 0.75, sources: [{ name: "Yahoo Finance S&P 500 snapshot", at: breadth && breadth.at }] });
      }
      return { summary: `${Object.keys(idx).length} indexes, ${sectors.length} sectors${breadth ? `, breadth ${breadth.up}/${breadth.n}` : ""}, ${movers.length} big movers` };
    },

    async news_sweep(c) {
      const syms = tracked().filter((s) => !isIndexish(s)).slice(0, 25);
      c.phase("fetch", `Reading Yahoo Finance, CNBC, Morningstar, Seeking Alpha and WSJ${syms.length ? ` for ${syms.length} of your tickers` : ""}`);
      const N = await deps.news(syms, "24h");
      const items = (N.items || []).filter((i) => !i.time || now() - i.time < 30 * HOUR);
      let trending = []; try { trending = ((await deps.trending()).items || []).slice(0, 40); } catch {}
      c.phase("analyze", `Scoring tone of ${items.length} headlines`);
      const tkey = (s) => String(s).toLowerCase().replace(/\W+/g, "").slice(0, 60);
      const trendSet = new Set(trending.map((x) => tkey(x.title)));
      for (const i of items) { i._tone = tone(i.title); i._trend = trendSet.has(tkey(i.title)); }
      const day = et().day;
      // per-ticker news catalysts
      for (const s of syms) {
        const mine = items.filter((i) => (i.tickers || []).includes(s));
        if (!mine.length) continue;
        const sum = mine.reduce((a, i) => a + i._tone, 0), strong = mine.slice().sort((a, b) => Math.abs(b._tone) - Math.abs(a._tone) || (b.time || 0) - (a.time || 0))[0];
        if (mine.length < 4 && Math.abs(strong._tone) < 2) continue;
        const outlets = uniq(mine.map((i) => srcName(i.source)));
        c.discover({ key: `news:${s}:${day}`, cat: "news", tickers: [s], headline: `${s}: ${mine.length} headline${mine.length > 1 ? "s" : ""} in 24h, tone ${toneWord(sum / Math.max(1, Math.sqrt(mine.length)))}`,
          summary: `Strongest: “${strong.title}” (${srcName(strong.source)}).`, facts: mine.slice(0, 4).map((i) => ({ text: `“${i.title}”`, src: srcName(i.source), at: i.time })),
          interp: { text: `Tone is scored from headline wording only (rules, not reading the articles). Covered by ${outlets.join(", ")}.`, kind: "interpretation" },
          mag: clamp(Math.abs(sum) / 6 + mine.length / 20, 0.2, 0.9), tone: clamp(Math.round(sum / 2), -2, 2), conf: clamp(0.4 + outlets.length * 0.1, 0.4, 0.8),
          sources: mine.slice(0, 4).map((i) => ({ name: srcName(i.source), url: i.link, at: i.time })), links: [{ label: `${s} research`, go: "q:" + s }, { label: "News", go: "#news" }],
          hyp: Math.abs(sum) >= 4 && SP.has(s) ? { sym: s, dir: sum > 0 ? 1 : -1, days: 7, claim: `If the ${sum > 0 ? "positive" : "negative"} news matters, ${s} should ${sum > 0 ? "beat" : "trail"} the S&P 500 over the next week.` } : null });
      }
      // market-wide themes
      const themes = THEMES.map(([name, re, link]) => ({ name, link, hits: items.filter((i) => re.test(i.title)) })).filter((t) => t.hits.length >= 6).sort((a, b) => b.hits.length - a.hits.length).slice(0, 4);
      for (const th of themes) {
        const ml = MACRO_LINKS.find((m) => m.id === th.link), t = th.hits.reduce((a, i) => a + i._tone, 0);
        c.discover({ key: `theme:${th.name}:${day}`, cat: ml ? "macro" : "news", sectors: ml ? Object.keys(ml.sectors) : [], headline: `Theme in the news: ${th.name} (${th.hits.length} headlines in 24h)`,
          summary: `Top: ${th.hits.slice(0, 2).map((i) => `“${i.title}” (${srcName(i.source)})`).join("; ")}.`, facts: [{ text: `${th.hits.length} of ${items.length} headlines from the five outlets mention ${th.name.toLowerCase()}`, src: "Market Desk news feeds", at: now() }],
          interp: { text: `Coverage tone ${toneWord(t / Math.sqrt(th.hits.length))}.${ml ? ` Sectors usually sensitive to ${ml.name.toLowerCase()}: ${Object.keys(ml.sectors).join(", ")}.` : ""}`, kind: "interpretation" },
          mag: clamp(th.hits.length / 25, 0.3, 0.8), tone: 0, conf: 0.6, sources: th.hits.slice(0, 3).map((i) => ({ name: srcName(i.source), url: i.link, at: i.time })) });
      }
      // sector patterns: three or more S&P companies in one sector with same-direction headlines
      c.phase("connect", "Matching headlines to S&P 500 companies and sectors");
      const M = spMatchers(), hitsBySec = {};
      for (const i of items) { if (!i._tone) continue; for (const [sym, re] of M) if (re.test(i.title)) { const s = sectorOf(sym); if (!s) continue; const k = s + (i._tone > 0 ? "+" : "-"); (hitsBySec[k] = hitsBySec[k] || new Map()).set(sym, i); } }
      for (const [k, m] of Object.entries(hitsBySec)) if (m.size >= 3) {
        const s = k.slice(0, -1), up = k.endsWith("+"), list = [...m].slice(0, 6);
        c.discover({ key: `newspat:${k}:${day}`, cat: "pattern", sectors: [s], tickers: list.map((x) => x[0]), headline: `Pattern: ${m.size} ${s} companies with ${up ? "positive" : "negative"} headlines today`,
          summary: list.map(([sym, i]) => `${sym}: “${i.title.slice(0, 90)}”`).join(" · "), facts: list.slice(0, 4).map(([sym, i]) => ({ text: `${sym}: “${i.title}”`, src: srcName(i.source), at: i.time })),
          interp: { text: "Similar news across several companies in one sector can signal an industry-wide development worth checking.", kind: "speculation" }, mag: clamp(m.size / 6, 0.4, 0.85), tone: up ? 1 : -1, conf: 0.5, sources: list.slice(0, 4).map(([, i]) => ({ name: srcName(i.source), url: i.link, at: i.time })) });
      }
      // a compact digest the briefing uses for "most important news"
      const ranked = items.map((i) => ({ i, s: (i._trend ? 3 : 0) + Math.abs(i._tone) + (1 - (i.pct ?? 0.5)) * 1.5 + ((i.tickers || []).some((t) => held().includes(t)) ? 1.5 : 0) + (i.time ? clamp(1 - (now() - i.time) / DAY, 0, 1) : 0) }))
        .sort((a, b) => b.s - a.s).slice(0, 12).map(({ i }) => ({ title: i.title, link: i.link, source: srcName(i.source), time: i.time, tone: i._tone, tickers: i.tickers || [], trending: i._trend }));
      ST.newsDigest = { at: now(), count: items.length, outlets: Object.entries(N.sources || {}).filter(([, v]) => v.ok).map(([k]) => srcName(k)), top: ranked, themes: themes.map((t) => ({ name: t.name, n: t.hits.length })) };
      return { summary: `${items.length} headlines · ${themes.length} themes · tone scored for ${syms.length} tickers` };
    },

    async policy_watch(c) {
      c.phase("fetch", "Federal Reserve, SEC, Treasury and BLS press feeds");
      const sm = await deps.smart();
      const items = (sm.items || []).filter((i) => i.g === "policy" && (!i.time || now() - i.time < 10 * DAY)).slice(0, 60);
      c.phase("analyze", `Checking ${items.length} official releases for anything new`);
      const firstRun = !Object.keys(ST.seen.policy).length; let fresh = 0;
      const exp = ST.exposure ? ST.exposure.sectorWeight : {};
      for (const i of items) {
        const k = (i.src + "|" + i.title).toLowerCase().replace(/\W+/g, "").slice(0, 100);
        if (ST.seen.policy[k]) continue; ST.seen.policy[k] = now();
        if (firstRun && i.time && now() - i.time > 2 * DAY) continue; // don't flood memory with last week's releases on day one
        fresh++;
        const fedPolicy = i.src === "fed" && /\b(fomc|federal open market|monetary policy|federal funds|policy rate|statement|minutes|discount rate|balance sheet)\b/i.test(i.title);
        const blsKey = i.src === "bls" && /\b(consumer price|cpi|employment situation|payroll|unemployment|producer price|ppi|job openings|jolts|employment cost)\b/i.test(i.title);
        const imp = fedPolicy ? 0.95 : blsKey ? 0.8 : i.src === "treasury" ? 0.45 : i.src === "fed" ? 0.5 : 0.3;
        const ml = fedPolicy ? MACRO_LINKS[0] : blsKey ? (/price|cpi|ppi/i.test(i.title) ? MACRO_LINKS[1] : MACRO_LINKS[2]) : null;
        const yours = ml ? Object.keys(ml.sectors).filter((s) => (exp[s] || 0) >= 0.05) : [];
        // a press release that names a company you follow
        const named = tracked().filter((s) => { const n = nameOf(s); return n && n !== s && n.length > 3 && new RegExp(`\\b${n.split(" ")[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(i.title); });
        c.discover({ key: `policy:${k}`, cat: "policy", tickers: named, sectors: ml ? Object.keys(ml.sectors) : [], headline: `${i.name}: ${i.title}`,
          summary: fedPolicy ? "A monetary-policy release from the Federal Reserve." : blsKey ? "A major economic data release from the Bureau of Labor Statistics." : `Official release from the ${i.name}.`,
          facts: [{ text: `Published by ${i.name}`, src: i.name, at: i.time }],
          interp: ml ? { text: `${ml.name} drive${ml.name.endsWith("s") ? "" : "s"} ${Object.keys(ml.sectors).join(", ")}.${yours.length ? ` Your exposure: ${yours.map((s) => `${s} ${((exp[s] || 0) * 100).toFixed(0)}%`).join(", ")}.` : ""}`, kind: "interpretation" } : null,
          pfWhy: yours.length ? [`you have ${yours.join(", ")} exposure`] : [], pfBoost: yours.length ? 0.55 : 0,
          mag: imp, tone: 0, conf: 0.95, sources: [{ name: i.name, url: i.link, at: i.time }], links: [{ label: "Macro dashboard", go: "#macro" }] });
        if (fedPolicy || blsKey) {
          c.follow("macro_check", null, { boost: 0.4, reason: `new ${fedPolicy ? "Fed policy" : "BLS"} release — checking the broader implications` });
          c.follow("market_pulse", null, { boost: 0.3, reason: "measuring the market's reaction to an official release" });
        }
      }
      const cut = now() - 30 * DAY; for (const k of Object.keys(ST.seen.policy)) if (ST.seen.policy[k] < cut) delete ST.seen.policy[k];
      return { summary: `${items.length} official releases checked · ${fresh} new` };
    },

    async macro_check(c) {
      c.phase("fetch", "FRED: Fed funds, CPI, unemployment, GDP, yields, curve, sentiment, Sahm rule");
      const M = await deps.macro();
      c.phase("analyze", "Comparing the latest readings with what the Spider saw last time");
      const rows = []; let fresh = 0; const firstRun = !Object.keys(ST.seen.macro).length;
      for (const s of M.series || []) {
        if (!s.data || s.data.length < 2 || s.hidden) continue;
        const [d1, v1] = s.data[s.data.length - 1], [d0, v0] = s.data[s.data.length - 2];
        rows.push({ id: s.id, name: s.name, unit: s.unit, freq: s.freq, date: d1, value: v1, prevDate: d0, prev: v0, src: s.src });
        if (s.freq === "Daily") continue; // daily yields are covered by the market pulse
        if (ST.seen.macro[s.id] === d1) continue;
        const was = ST.seen.macro[s.id]; ST.seen.macro[s.id] = d1;
        if (firstRun || !was) continue;
        fresh++;
        const ml = MACRO_LINKS.find((m) => (m.series || []).includes(s.id)), chg = v1 - v0;
        const big = s.id === "UNRATE" ? Math.abs(chg) >= 0.2 : /CPI/.test(s.id) ? Math.abs(chg) >= 0.2 : s.id === "FEDFUNDS" ? Math.abs(chg) >= 0.2 : Math.abs(chg) >= Math.abs(v0) * 0.05;
        c.discover({ key: `macro:${s.id}:${d1}`, cat: "macro", sectors: ml ? Object.keys(ml.sectors) : [], headline: `New data: ${s.name} ${(+v1).toFixed(2)}${s.unit === "%" ? "%" : ""} (${d1}), ${chg >= 0 ? "up" : "down"} from ${(+v0).toFixed(2)}`,
          summary: `${s.freq} series; the new reading covers ${d1}.`, facts: [{ text: `${s.name}: ${(+v1).toFixed(2)} for ${d1}; previous ${(+v0).toFixed(2)} for ${d0}`, src: s.src || "FRED", at: now() }],
          interp: ml ? { text: `Usually matters for ${Object.entries(ml.sectors).map(([k, v]) => `${k} (${v})`).join("; ")}.`, kind: "interpretation" } : null,
          mag: big ? 0.75 : 0.4, tone: 0, conf: 0.95, sources: [{ name: s.src || "FRED", url: `https://fred.stlouisfed.org/series/${s.id}`, at: now() }], links: [{ label: "Macro dashboard", go: "#macro" }] });
      }
      const g = (id) => rows.find((r) => r.id === id);
      const sahm = g("SAHMREALTIME"), c10y2 = g("T10Y2Y"), c10y3m = g("T10Y3M");
      if (sahm && sahm.value >= 0.5) c.discover({ key: `sahm:${sahm.date}`, cat: "macro", sectors: ["Consumer Discretionary", "Financials", "Industrials"], headline: `Recession signal: Sahm rule at ${sahm.value.toFixed(2)} (trigger 0.50)`, summary: "The 3-month average unemployment rate is at least 0.5 pts above its low of the past year.",
        facts: [{ text: `SAHMREALTIME ${sahm.value} for ${sahm.date}`, src: "Claudia Sahm via FRED", at: now() }], interp: { text: "Historically this has coincided with the early months of US recessions; it is a signal, not a certainty.", kind: "interpretation" }, mag: 0.9, tone: -1, conf: 0.9, sources: [{ name: "FRED", url: "https://fred.stlouisfed.org/series/SAHMREALTIME", at: now() }] });
      if (c10y3m && c10y3m.value < 0) c.discover({ key: `curve3m:${c10y3m.date.slice(0, 7)}`, cat: "macro", sectors: ["Financials"], headline: `Yield curve inverted: 10-year minus 3-month at ${c10y3m.value.toFixed(2)} pts`, summary: "Short-term rates above long-term rates.",
        facts: [{ text: `T10Y3M ${c10y3m.value} on ${c10y3m.date}${c10y2 ? `; T10Y2Y ${c10y2.value}` : ""}`, src: "FRED", at: now() }], interp: { text: "Inversions have preceded past recessions, often by a year or more, and squeeze bank lending margins.", kind: "interpretation" }, mag: 0.6, tone: -1, conf: 0.9, sources: [{ name: "FRED", url: "https://fred.stlouisfed.org/series/T10Y3M", at: now() }] });
      ST.macro = { at: now(), rows, source: M.source };
      return { summary: `${rows.length} indicators · ${fresh} new readings${firstRun ? " (baseline recorded)" : ""}` };
    },

    async earnings_watch(c) {
      const syms = tracked().filter((s) => !isIndexish(s) && !isCrypto(s)).slice(0, 40);
      c.phase("fetch", "Earnings calendar for your companies and the largest US stocks");
      const cal = await deps.earnings(syms);
      let act = []; try { act = (await deps.earningsActuals()) || []; } catch {}
      c.phase("analyze", "Upcoming reports, fresh results and surprises");
      const today = et().day, inDays = (d) => Math.round((Date.parse(d + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / DAY);
      const H = new Set(held()), T = new Set(syms);
      const up = [...(cal.yours || []).map((e) => ({ ...e, mine: true })), ...(cal.notable || [])].filter((e) => e.date && inDays(e.date) >= 0 && inDays(e.date) <= 7);
      for (const e of up) {
        const n = inDays(e.date), mine = T.has(e.symbol); if (!mine && n > 2) continue;
        const when = n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days (${e.date})`, hour = e.hour === "bmo" ? " before the open" : e.hour === "amc" ? " after the close" : "";
        c.discover({ key: `earnup:${e.symbol}:${e.date}`, cat: "earnings", tickers: [e.symbol], headline: `${e.symbol} reports earnings ${when}${hour}`,
          summary: `${e.epsEstimate != null ? `Consensus EPS estimate $${(+e.epsEstimate).toFixed(2)}` : "No EPS estimate available"}${e.revenueEstimate ? `, revenue estimate ${money(e.revenueEstimate)}` : ""}.`,
          facts: [{ text: `Scheduled ${e.date}${hour}`, src: cal.source || "Earnings calendar", at: now() }, ...(e.epsEstimate != null ? [{ text: `EPS estimate $${(+e.epsEstimate).toFixed(2)}`, kind: "estimate", src: cal.source || "Earnings calendar" }] : [])],
          interp: H.has(e.symbol) ? { text: "A scheduled catalyst for a holding: results and guidance can move the stock sharply in either direction.", kind: "interpretation" } : null,
          mag: clamp(1 - n / 8, 0.3, 0.9) * (mine ? 1 : 0.6), tone: 0, conf: 0.8, sources: [{ name: cal.source || "Earnings calendar", at: now() }], links: [{ label: `${e.symbol} research`, go: "q:" + e.symbol }] });
        if (H.has(e.symbol) && n <= 1) c.follow("company_snapshot", e.symbol, { boost: 0.3, reason: `${e.symbol} reports ${when} — refreshing its research`, extra: { catalyst: 1 }, cooldown: 12 * HOUR });
      }
      const rep = [];
      for (const e of act) {
        if (e.epsActual == null || e.epsEstimate == null) continue;
        const sym = String(e.symbol).replace(".", "-"), ago = -inDays(e.date); if (ago < 0 || ago > 3) continue;
        const mine = T.has(sym), bigCo = SP.has(sym); const surprise = (e.epsActual - e.epsEstimate) / Math.max(0.01, Math.abs(e.epsEstimate));
        if (!mine && !(bigCo && Math.abs(surprise) >= 0.1)) continue;
        rep.push({ sym, date: e.date, surprise, actual: e.epsActual, est: e.epsEstimate, mine });
        const kind = surprise >= 0.03 ? "beat" : surprise <= -0.03 ? "miss" : "in line";
        c.discover({ key: `earnrep:${sym}:${e.date}`, cat: "earnings", tickers: [sym], headline: `${sym} ${kind === "in line" ? "reported in line with" : kind === "beat" ? "beat" : "missed"} EPS estimates by ${Math.abs(surprise * 100).toFixed(0)}%`,
          summary: `EPS $${(+e.epsActual).toFixed(2)} vs. $${(+e.epsEstimate).toFixed(2)} expected (${e.date}${e.hour === "bmo" ? ", before the open" : e.hour === "amc" ? ", after the close" : ""}).`,
          facts: [{ text: `Reported EPS $${(+e.epsActual).toFixed(2)}`, src: "Finnhub earnings calendar", at: now() }, { text: `Consensus estimate $${(+e.epsEstimate).toFixed(2)}`, kind: "estimate", src: "Finnhub earnings calendar" }],
          interp: { text: "An EPS surprise is one input; guidance and revenue usually matter as much for the reaction.", kind: "interpretation" },
          mag: clamp(Math.abs(surprise) * 3, 0.35, 0.9) * (mine ? 1 : 0.7), tone: kind === "beat" ? 1 : kind === "miss" ? -1 : 0, conf: 0.85, sources: [{ name: "Finnhub earnings calendar", url: "https://finnhub.io/", at: now() }],
          links: [{ label: "Earnings release", go: `#filings/${sym}/release` }], hyp: kind !== "in line" && bigCo ? { sym, dir: kind === "beat" ? 1 : -1, days: 7, claim: `After the ${kind}, ${sym} should ${kind === "beat" ? "beat" : "trail"} the S&P 500 over the next week.` } : null });
        if (mine || Math.abs(surprise) >= 0.15) c.follow("earnings_release", sym, { boost: mine ? 0.45 : 0.1, reason: `${sym} just reported — reading the press release`, extra: { catalyst: 1 }, cooldown: 24 * HOUR });
      }
      ST.earnings = { at: now(), source: cal.source, upcoming: up.slice(0, 40).map((e) => ({ symbol: e.symbol, date: e.date, hour: e.hour, eps: e.epsEstimate, mine: T.has(e.symbol), held: H.has(e.symbol) })), reported: rep.slice(0, 20) };
      return { summary: `${up.length} reports in the next 7 days · ${rep.length} fresh results` };
    },

    async filings_watch(c) {
      const syms = tracked().filter((s) => /^[A-Z][A-Z.\-]{0,6}$/.test(s) && !isCrypto(s) && !FUND_CLASS[s] && !ETF_SECTOR[s]).slice(0, 40);
      if (!syms.length) return { summary: "No companies to watch yet" };
      c.phase("fetch", `SEC EDGAR filing index for ${syms.length} companies`);
      const F = (await deps.filings(syms)).filings || {};
      c.phase("analyze", "Looking for new 10-K, 10-Q, 8-K earnings and Form 4 filings");
      let fresh = 0; const recent = (d) => d && now() - Date.parse(d + "T12:00:00Z") < 4 * DAY;
      for (const [sym, f] of Object.entries(F)) {
        const seen = ST.seen.filings[sym] || {}; const firstTime = !ST.seen.filings[sym];
        const next = { k: f.k && f.k.acc, q: f.q && f.q.acc, er: f.er && f.er.acc, f4: f.f4 && f.f4.acc };
        const neu = (t) => f[t] && f[t].acc && f[t].acc !== seen[t] && (!firstTime || recent(f[t].date));
        const say = { k: "annual report (10-K)", q: "quarterly report (10-Q)", er: "earnings release (8-K Item 2.02)", f4: "insider trade filing (Form 4)" };
        for (const t of ["k", "q", "er", "f4"]) if (neu(t)) {
          fresh++; const x = f[t];
          c.discover({ key: `filing:${sym}:${x.acc}`, cat: "filing", tickers: [sym], headline: `${sym} filed a new ${say[t]}${x.period ? ` for the period ending ${x.period}` : ""}`,
            summary: `${f.name || sym} · filed ${x.date}${t === "f4" && f.f4.n30 ? ` · ${f.f4.n30} insider filings in the last 30 days` : ""}.`,
            facts: [{ text: `${x.form} filed ${x.date}, accession ${x.acc}`, src: "SEC EDGAR", at: Date.parse(x.date + "T12:00:00Z") }],
            mag: t === "k" ? 0.6 : t === "er" ? 0.65 : t === "q" ? 0.5 : 0.35, tone: 0, conf: 1, sources: [{ name: "SEC EDGAR", url: x.url, at: Date.parse(x.date + "T12:00:00Z") }],
            links: [{ label: "Open in 10-K crawler", go: `#filings/${sym}/${t === "er" ? "release" : t === "f4" ? "insiders" : "fin"}` }] });
          if (t === "er") c.follow("earnings_release", sym, { boost: 0.35, reason: `new earnings release from ${sym}`, cooldown: 12 * HOUR });
          if (t === "k" || t === "q") c.follow("fundamentals", sym, { boost: 0.25, reason: `new ${x.form} from ${sym}`, cooldown: 12 * HOUR });
          if (t === "f4" && (f.f4.n30 || 0) >= 2) c.follow("insiders", sym, { boost: 0.15, reason: `${f.f4.n30} insider filings at ${sym} this month`, cooldown: 24 * HOUR });
        }
        ST.seen.filings[sym] = next;
      }
      return { summary: `${Object.keys(F).length} companies checked on EDGAR · ${fresh} new filings` };
    },

    async earnings_release(c) {
      const s = c.sym; c.phase("fetch", `Downloading ${s}'s latest 8-K earnings press release from EDGAR`);
      const R = await deps.release(s);
      if (!R || !R.available) return { summary: (R && R.reason) || "No earnings release found" };
      c.phase("analyze", "Tagging upbeat, cautious and guidance sentences");
      const sents = (R.paragraphs || []).flatMap((p) => p.sents || []);
      const bull = sents.filter((x) => x.tone === "bull").length, bear = sents.filter((x) => x.tone === "bear").length, guide = (R.guidance || []);
      const hedges = uniq(sents.filter((x) => x.hedge).map((x) => x.hedge)).slice(0, 5);
      const net = bull - bear, toneV = net >= 6 ? 1 : net <= -2 ? -1 : 0;
      c.discover({ key: `release:${R.symbol.replace(".", "-")}:${R.filing.accession}`, cat: "earnings", tickers: [s], headline: `${s} earnings release: ${bull} upbeat vs. ${bear} cautious sentences${guide.length ? `, ${guide.length} guidance figure${guide.length > 1 ? "s" : ""}` : ""}`,
        summary: `${R.title}. ${guide.slice(0, 3).map((g) => `${g.metric}: ${g.value}${g.range ? " " + g.range : ""}${g.period ? ` (${g.period})` : ""}`).join("; ")}${guide.length ? "." : "No numeric guidance found."}`,
        facts: [{ text: `${R.filing.form} filed ${R.filing.filed}${R.filing.period ? `, period ${R.filing.period}` : ""}`, src: "SEC EDGAR", at: Date.parse(R.filing.filed + "T12:00:00Z") }, ...guide.slice(0, 4).map((g) => ({ text: `Guidance — ${g.metric}: ${g.value}${g.range ? " " + g.range : ""}${g.period ? ` (${g.period})` : ""}`, kind: "estimate", src: "Company press release (EX-99.1)" }))],
        interp: { text: `Tone count is mechanical (word rules over ${sents.length} sentences).${hedges.length ? ` Cautious words used: ${hedges.join(", ")}.` : ""}`, kind: "interpretation" },
        mag: clamp(0.4 + Math.abs(net) / 20 + guide.length / 20, 0.4, 0.85), tone: toneV, conf: 0.7, sources: [{ name: "SEC EDGAR 8-K", url: R.filing.url, at: Date.parse(R.filing.filed + "T12:00:00Z") }],
        links: [{ label: "Open release in crawler", go: `#filings/${s}/release` }] });
      return { summary: `${sents.length} sentences · ${guide.length} guidance items` };
    },

    async fundamentals(c) {
      const s = c.sym; c.phase("fetch", `SEC XBRL company facts for ${s}`);
      const f = await deps.fundamentals(s);
      if (!f || !f.available || !f.years || f.years.length < 2) return { summary: (f && f.reason) || "Not enough 10-K history" };
      c.phase("analyze", "Running the 10-K health scorecard on the last two fiscal years");
      const Y = f.years.slice(-2), y = Y[1], p = Y[0], H = deps.health ? deps.health(y, p) : null;
      const g = (k) => (y[k] != null && p[k] ? (y[k] - p[k]) / Math.abs(p[k]) : null), m = (a, b) => (y[a] != null && y[b] ? y[a] / y[b] : null);
      const fy = String(y.end).slice(0, 4), prev = ST.funda[s];
      const now1 = { fy, grade: H && H.grade, score: H && H.score, rev: y.revenue, ni: y.netIncome, fcf: y.fcf, revG: g("revenue"), nm: m("netIncome", "revenue") };
      ST.funda[s] = { ...now1, t: now() };
      const changed = prev && (prev.fy !== fy || prev.grade !== now1.grade);
      c.phase("connect", changed ? `Comparing with the previous record (grade ${prev.grade}, FY${prev.fy})` : "Recording the baseline");
      const flags = H ? (H.flags || []).map((x) => x.label || x).slice(0, 4) : [];
      c.discover({ key: `funda:${s}`, cat: "fundamentals", tickers: [s], headline: `${s} 10-K health${H && H.grade ? ` grade ${H.grade}` : ""} (FY${fy})${changed ? (prev.fy !== fy ? " — new fiscal year" : ` — changed from ${prev.grade}`) : ""}`,
        summary: `Revenue ${money(y.revenue)} (${pctS((now1.revG || 0) * 100)} y/y), net margin ${now1.nm != null ? (now1.nm * 100).toFixed(1) + "%" : "n/a"}, free cash flow ${money(y.fcf)}.${flags.length ? ` Flags: ${flags.join(", ").toLowerCase()}.` : ""}`,
        facts: [{ text: `From ${y._form || "10-K"} filed ${y._filed || "n/a"} (fiscal year ended ${y.end})`, src: "SEC EDGAR XBRL", at: y._filed ? Date.parse(y._filed + "T12:00:00Z") : null }, ...(H ? [{ text: `Scorecard ${H.score != null ? H.score + "/100, " : ""}${(H.checks || []).filter((x) => x.status === "pass").length} of ${(H.checks || []).length} checks passed`, src: "Market Desk 10-K health scorecard" }] : [])],
        interp: H ? { text: H.grade === "A" || H.grade === "B" ? "Financially healthy on the standard analyst checks." : H.grade === "F" ? "Fails several basic checks — AI Trader sells or avoids F grades." : "Some checks are weak; worth reading the flags.", kind: "interpretation" } : null,
        mag: changed ? 0.7 : 0.35, tone: H ? ({ A: 1, B: 0, C: 0, D: -1, F: -2 }[H.grade] || 0) : 0, conf: 0.9, sources: [{ name: "SEC EDGAR XBRL company facts", url: f.cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${f.cik}&type=10-K` : null, at: now() }],
        links: [{ label: "Financial statements", go: "#fin" }, { label: "10-K crawler", go: `#filings/${s}/fin` }], data: now1 });
      return { summary: `FY${fy}${H ? ` grade ${H.grade}` : ""}${changed ? " (changed)" : ""}` };
    },

    async insiders(c) {
      const s = c.sym; c.phase("fetch", `Reading ${s}'s Form 4 filings from EDGAR (up to 30)`);
      const R = await deps.insiders(s);
      if (!R || !R.available) return { summary: (R && R.reason) || "No insider data" };
      c.phase("analyze", "Separating open-market buys and sells from plan sales and grants");
      const since = now() - 90 * DAY, tx = [];
      for (const f of R.filings || []) for (const t of f.tx || []) if (Date.parse(t.date) >= since && (t.code === "P" || t.code === "S")) tx.push({ ...t, owner: f.owner, role: f.role, officer: f.officer, url: f.url });
      const buys = tx.filter((t) => t.code === "P"), sells = tx.filter((t) => t.code === "S" && !t.plan10b51);
      const bv = buys.reduce((a, t) => a + t.value, 0), sv = sells.reduce((a, t) => a + t.value, 0), buyers = uniq(buys.map((t) => t.owner));
      if (!buys.length && sv < 5e6) return { summary: `${tx.length} open-market trades in 90 days — nothing notable` };
      const cluster = buyers.length >= 2;
      c.discover({ key: `ins:${s}:${(R.filings[0] || {}).accession || et().day}`, cat: "insider", tickers: [s], headline: buys.length ? `${s}: ${buyers.length} insider${buyers.length > 1 ? "s" : ""} bought ${money(bv)} on the open market (90 days)` : `${s}: insiders sold ${money(sv)} outside pre-set plans (90 days)`,
        summary: `${buys.length ? `Buyers: ${buyers.slice(0, 3).join(", ")}. ` : ""}${sells.length ? `Discretionary sales ${money(sv)} by ${uniq(sells.map((t) => t.owner)).slice(0, 3).join(", ")}.` : ""}`,
        facts: [...buys.slice(0, 3), ...sells.slice(0, 2)].map((t) => ({ text: `${t.owner} (${t.role}) ${t.code === "P" ? "bought" : "sold"} ${Math.round(t.shares).toLocaleString()} shares at $${t.price.toFixed(2)} on ${t.date}`, src: "SEC Form 4", at: Date.parse(t.date) })),
        interp: { text: buys.length ? (cluster ? "Several insiders buying with their own money is one of the more informative insider signals." : "A single open-market purchase is a mildly positive signal.") : "Discretionary selling has many motives (taxes, diversification); it is a weak signal on its own.", kind: "interpretation" },
        mag: buys.length ? (cluster ? 0.8 : 0.5) : 0.4, tone: buys.length ? (cluster ? 2 : 1) : -1, conf: 0.8, sources: [{ name: "SEC EDGAR Form 4", url: (buys[0] || sells[0] || {}).url, at: now() }],
        links: [{ label: "Insider trades", go: `#filings/${s}/insiders` }], hyp: buys.length && cluster && SP.has(s) ? { sym: s, dir: 1, days: 14, claim: `With an insider buying cluster, ${s} should beat the S&P 500 over the next two weeks.` } : null });
      return { summary: `${buys.length} buys, ${sells.length} discretionary sells` };
    },

    async investigate_mover(c) {
      const s = c.sym; c.phase("fetch", `${s}: quote, 3-month volume and its own headlines`);
      const [Q, H, N] = await Promise.all([q([s, "SPY"]), deps.history(s, "6mo").catch(() => null), deps.news([s], "24h").catch(() => ({ items: [] }))]);
      const x = Q[s]; if (!ok(x)) return { summary: "No quote available" };
      c.phase("analyze", "Volume vs. normal, catalyst headlines, sector peers");
      const vols = H ? (H.candles || []).slice(-64, -1).map((k) => k.volume).filter((v) => v > 0) : [], avgV = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
      const vr = avgV && x.volume ? x.volume / avgV : null;
      const mine = (N.items || []).filter((i) => (i.tickers || []).includes(s) && (!i.time || now() - i.time < 30 * HOUR)).map((i) => ({ ...i, _t: tone(i.title) })).sort((a, b) => Math.abs(b._t) - Math.abs(a._t) || (b.time || 0) - (a.time || 0));
      const cat = mine[0] || null, sec = sectorOf(s), etf = SECTOR_ETF[sec];
      const peers = ((ST.market && ST.market.movers) || []).filter((m) => m.sym !== s && sectorOf(m.sym) === sec && Math.sign(m.chg) === Math.sign(x.changePct));
      let secMove = null; if (etf) { try { const e = (await q([etf]))[etf]; if (ok(e)) secMove = e.changePct; } catch {} }
      const earn = ((ST.earnings && ST.earnings.reported) || []).find((e) => e.sym === s);
      c.phase("connect", "Deciding whether the move is company-specific or sector-wide");
      const spotted = (c.job.extra || {}).move;
      if (Math.abs(x.changePct) < 2 && !(spotted && Math.abs(spotted) >= 4)) return { summary: `${pctS(x.changePct)} now — not an unusual move, nothing recorded` };
      const broad = peers.length >= 2 || (secMove != null && Math.abs(secMove) >= 1.5 && Math.sign(secMove) === Math.sign(x.changePct));
      const spy = Q.SPY && ok(Q.SPY) ? Q.SPY.changePct : null;
      c.discover({ key: `mover:${s}:${et().day}`, cat: "mover", tickers: [s, ...peers.slice(0, 3).map((p) => p.sym)], sectors: sec ? [sec] : [],
        headline: `${s} ${x.changePct >= 0 ? "+" : "−"}${Math.abs(x.changePct).toFixed(1)}% today${spotted && Math.abs(x.changePct) < 2 ? ` (was ${pctS(spotted)} when spotted)` : ""}${vr ? ` on ${vr.toFixed(1)}× normal volume` : ""} — ${broad ? `part of a sector-wide ${sec} move` : cat ? "likely catalyst found" : "no clear catalyst in tracked sources"}`,
        summary: `${earn ? `Reported earnings ${earn.date} (${earn.surprise >= 0 ? "beat" : "miss"} ${Math.abs(earn.surprise * 100).toFixed(0)}%). ` : ""}${cat ? `Top headline: “${cat.title}” (${srcName(cat.source)}). ` : ""}${secMove != null ? `${sec} ETF ${pctS(secMove)}` : ""}${spy != null ? `, S&P 500 ${pctS(spy)}.` : "."}${peers.length ? ` Peers also moving: ${peers.slice(0, 3).map((p) => `${p.sym} ${pctS(p.chg)}`).join(", ")}.` : ""}`,
        facts: [{ text: `${x.name || s} ${x.price.toFixed(2)}, ${pctS(x.changePct, 2)}${x.volume ? `, volume ${Math.round(x.volume).toLocaleString()}` : ""}`, src: "Yahoo Finance", at: x.marketTime }, ...(avgV ? [{ text: `Average daily volume over the prior ~3 months ${Math.round(avgV).toLocaleString()}`, src: "Yahoo Finance daily history" }] : []), ...(cat ? [{ text: `“${cat.title}”`, src: srcName(cat.source), at: cat.time }] : [])],
        interp: { text: broad ? "Peers moved the same way, so the driver is probably industry-wide rather than company-specific." : cat ? "The headline is a plausible cause, but timing alone doesn't prove it." : "No matching headline in the five news sources; the cause may be in sources the Spider can't read (analyst notes, options flow).", kind: cat || broad ? "interpretation" : "speculation" },
        mag: clamp(Math.abs(x.changePct) / 10 + (vr ? Math.min(0.3, vr / 15) : 0), 0.35, 1), tone: x.changePct >= 0 ? 1 : -1, conf: cat || broad ? 0.65 : 0.4,
        sources: [{ name: "Yahoo Finance", at: x.marketTime }, ...(cat ? [{ name: srcName(cat.source), url: cat.link, at: cat.time }] : [])], links: [{ label: `${s} research`, go: "q:" + s }] });
      return { summary: `${pctS(x.changePct)}${vr ? `, ${vr.toFixed(1)}× volume` : ""}${broad ? ", sector-wide" : cat ? ", catalyst found" : ", no catalyst"}` };
    },

    async company_snapshot(c) {
      const s = c.sym; c.phase("fetch", `${s}: quote, 1-year price history and 7 days of headlines`);
      const [Q, H, N] = await Promise.all([q([s]), deps.history(s, "1y").catch(() => null), deps.news([s], "week").catch(() => ({ items: [] }))]);
      const x = Q[s]; if (!ok(x)) return { summary: "No quote" };
      const cl = H ? (H.candles || []).map((k) => k.close).filter((v) => v != null) : [];
      const sma = (n) => (cl.length >= n ? cl.slice(-n).reduce((a, b) => a + b, 0) / n : null), m200 = sma(Math.min(200, cl.length)), m50 = sma(50);
      const r3 = cl.length > 64 ? x.price / cl[cl.length - 64] - 1 : null, r12 = cl.length > 240 ? x.price / cl[0] - 1 : null;
      const mine = (N.items || []).filter((i) => (i.tickers || []).includes(s)), nt = mine.reduce((a, i) => a + tone(i.title), 0);
      let A = null; try { A = deps.analyst ? deps.analyst(s) : null; } catch {}
      let fund = null; const isFiler = SP.has(s);
      if (isFiler) { c.phase("fetch", `${s}: 10-K numbers from SEC EDGAR`); try { const f = await deps.fundamentals(s); if (f && f.available && f.years.length >= 2) { const Y = f.years.slice(-2); fund = deps.health ? deps.health(Y[1], Y[0]) : null; if (fund) fund.fy = String(Y[1].end).slice(0, 4); } } catch {} }
      c.phase("analyze", "Trend, momentum, news tone, analysts and financial health");
      const bits = [];
      if (r3 != null) bits.push(`${pctS(r3 * 100, 0)} over 3 months`);
      if (m200) bits.push(x.price > m200 ? "above its 200-day average" : "below its 200-day average");
      if (fund && fund.grade) bits.push(`10-K health grade ${fund.grade}`);
      if (A && A.n) bits.push(`analysts ${A.adj >= 1 ? "strongly positive" : A.adj >= 0.5 ? "positive" : A.adj > -0.2 ? "mixed" : "negative"} (${A.n} ratings)`);
      bits.push(`${mine.length} headline${mine.length === 1 ? "" : "s"} in 7 days${mine.length ? `, tone ${toneWord(nt / Math.max(1, Math.sqrt(mine.length)))}` : ""}`);
      const notable = (r3 != null && Math.abs(r3) >= 0.2) || (fund && (fund.grade === "A" || fund.grade === "F")) || (A && A.adj >= 1) || Math.abs(nt) >= 4;
      const sec = sectorOf(s);
      c.discover({ key: `snap:${s}`, cat: "company", tickers: [s], sectors: sec ? [sec] : [], explore: !tracked().includes(s), headline: `Research note: ${s}${nameOf(s) !== s ? ` (${nameOf(s)})` : ""} — ${bits.slice(0, 2).join(", ")}`,
        summary: bits.join("; ") + ".", facts: [{ text: `Price ${x.price.toFixed(2)}${m50 ? `, 50-day avg ${m50.toFixed(2)}` : ""}${m200 ? `, 200-day avg ${m200.toFixed(2)}` : ""}${r12 != null ? `, 1-year ${pctS(r12 * 100, 0)}` : ""}`, src: "Yahoo Finance", at: x.marketTime },
          ...(fund && fund.grade ? [{ text: `10-K health ${fund.grade} (FY${fund.fy})`, src: "SEC EDGAR + Market Desk scorecard" }] : []), ...(A && A.n ? [{ text: `Analyst score ${A.adj.toFixed(2)} on a −2…+2 scale from ${A.n} ratings`, src: "Finnhub recommendation trends" }] : [])],
        interp: notable ? { text: "Stands out on at least one measure — a candidate for deeper research.", kind: "interpretation" } : { text: "Nothing unusual on these measures right now.", kind: "interpretation" },
        mag: notable ? 0.55 : 0.25, tone: (r3 || 0) > 0.15 && (fund ? fund.grade !== "F" : true) ? 1 : (r3 || 0) < -0.2 ? -1 : 0, conf: 0.6, sources: [{ name: "Yahoo Finance", at: x.marketTime }, ...(isFiler ? [{ name: "SEC EDGAR", at: now() }] : [])],
        links: [{ label: `${s} research`, go: "q:" + s }, ...(isFiler ? [{ label: "10-K crawler", go: `#filings/${s}/fin` }] : [])], data: { r3, r12, m200, price: x.price, grade: fund && fund.grade, analyst: A && A.adj } });
      return { summary: bits.slice(0, 3).join(", ") };
    },

    async explore(c) {
      c.phase("analyze", "Looking for S&P 500 companies the Spider hasn't researched recently");
      const T = new Set(tracked()), snap = (ST.market && ST.market.movers) || [];
      const cands = [...SP.keys()].filter((s) => !T.has(s) && (!ST.researched[s] || now() - ST.researched[s] > 14 * DAY));
      if (!cands.length) return { summary: "Every S&P 500 company was researched in the last 2 weeks" };
      // prefer today's big movers, then analyst favorites, then whatever has gone longest without research
      const moveOf = new Map(snap.map((m) => [m.sym, Math.abs(m.chg)]));
      const score = (s) => (moveOf.get(s) || 0) / 5 + ((deps.analyst && (deps.analyst(s) || {}).adj) || 0) / 2 + (ST.researched[s] ? 0 : 0.5) + (ST.explore.includes(s) ? -2 : 0);
      const pick = cands.map((s) => [s, score(s)]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      ST.explore = [pick, ...ST.explore].slice(0, 60);
      c.follow("company_snapshot", pick, { boost: 0.05, reason: moveOf.get(pick) ? `${pick} is moving today and hasn't been researched` : `research gap: ${pick} hasn't been researched yet`, cooldown: 7 * DAY });
      return { summary: `Queued ${pick} (${cands.length} companies with research gaps)` };
    },

    async ai_trader_sync(c) {
      const T = traderState(); if (!T) return { summary: "AI Trader not loaded yet" };
      const syms = uniq([...Object.keys(T.positions || {}), ...((T.lastScan || {}).top || []).map((x) => x.sym)]).slice(0, 25);
      c.phase("connect", `Matching Spider research to ${syms.length} AI Trader holdings and candidates`);
      const packets = {}; let conflicts = 0;
      for (const s of syms) {
        const sig = signal(s); packets[s] = { ...sig, at: now() };
        const holds = !!(T.positions || {})[s];
        if (holds && sig.score <= -0.4 && sig.n) {
          conflicts++;
          c.discover({ key: `aiconf:${s}:${et().day}`, cat: "ai_trader", tickers: [s], headline: `AI Trader holds ${s}, but Spider research leans negative`, summary: sig.reasons.slice(0, 3).join(" · "),
            facts: sig.reasons.slice(0, 4).map((r) => ({ text: r, kind: "interpretation" })), interp: { text: "The swing bot weighs this as a small score penalty; its stop-loss and news rules decide any sale.", kind: "interpretation" },
            mag: 0.6, tone: -1, conf: sig.conf, sources: [{ name: "THE WEB research memory", at: now() }], links: [{ label: "AI vs S&P 500", go: "#aitrade" }] });
        }
        if (!holds && sig.score >= 0.5 && sig.n >= 2) c.discover({ key: `aisupp:${s}:${et().day}`, cat: "ai_trader", tickers: [s], headline: `Spider research supports AI Trader candidate ${s}`, summary: sig.reasons.slice(0, 3).join(" · "),
          facts: sig.reasons.slice(0, 4).map((r) => ({ text: r, kind: "interpretation" })), mag: 0.45, tone: 1, conf: sig.conf, sources: [{ name: "THE WEB research memory", at: now() }], links: [{ label: "AI vs S&P 500", go: "#aitrade" }] });
      }
      ST.trader = { at: now(), packets, held: Object.keys(T.positions || {}), riskOff: (T.lastScan || {}).riskOff, stress: (T.lastScan || {}).stress };
      return { summary: `Research packets for ${syms.length} stocks · ${conflicts} conflicts flagged` };
    },

    async hypothesis_review(c) {
      const due = DISC.filter((d) => d.hyp && d.hyp.status === "open" && now() >= d.hyp.due).slice(0, 12);
      if (!due.length) return { summary: `No hypotheses due (${DISC.filter((d) => d.hyp && d.hyp.status === "open").length} open)` };
      c.phase("fetch", `Prices for ${due.length} hypotheses and the S&P 500`);
      let spy = null; try { spy = (await deps.history("SPY", "3mo")).candles; } catch {}
      const at = (cs, t) => { if (!cs) return null; const day = Math.floor(t / 1000 / 86400); const i = cs.findIndex((k) => Math.floor(k.time / 86400) >= day); return i < 0 ? null : cs[i].close; };
      let graded = 0;
      for (const d of due) {
        try {
          const cs = (await deps.history(d.hyp.sym, "3mo")).candles; if (!cs || !cs.length || !spy) continue;
          const p0 = at(cs, d.hyp.t0), p1 = cs[cs.length - 1].close, s0 = at(spy, d.hyp.t0), s1 = spy[spy.length - 1].close; if (!p0 || !s0) continue;
          const rel = (p1 / p0 - 1) - (s1 / s0 - 1), v = d.hyp.dir * rel;
          d.hyp.status = v >= 0.01 ? "supported" : v <= -0.01 ? "refuted" : "inconclusive"; d.hyp.rel = r2(rel * 100); d.hyp.graded = now();
          ST.hyp[d.hyp.status] = (ST.hyp[d.hyp.status] || 0) + 1; graded++; markDirty();
          c.phase("analyze", `${d.hyp.sym}: ${d.hyp.status} (${pctS(rel * 100)} vs. S&P 500)`);
        } catch {}
      }
      return { summary: `${graded} graded · record ${ST.hyp.supported} supported, ${ST.hyp.refuted} refuted, ${ST.hyp.inconclusive} inconclusive` };
    },

    async maintenance(c) {
      c.phase("save", "Removing expired research and compacting memory");
      const n = prune(false);
      for (const k of Object.keys(ST.researched)) if (now() - ST.researched[k] > 60 * DAY) delete ST.researched[k];
      for (const k of Object.keys(ST.lastRun)) if (now() - ST.lastRun[k] > 14 * DAY) delete ST.lastRun[k];
      BIDX = BIDX.filter((b) => now() - b.t < 400 * DAY).slice(0, 600);
      await save(true);
      return { summary: `${n} expired discoveries removed · ${DISC.length} in memory` };
    },

    async briefing(c) {
      const slot = c.job.slot || "manual";
      // make sure the inputs are fresh (each refresh is itself a bounded job run inline)
      const need = [["market_pulse", 15], ["news_sweep", 20], ["earnings_watch", 180], ["portfolio_scan", 20], ["ai_trader_sync", 20], ["policy_watch", 60]];
      for (const [t, mins] of need) {
        if (t === "portfolio_scan" && !held().length) continue;
        if (now() - (ST.lastRun[t] || 0) > mins * MIN) {
          c.phase("fetch", `Refreshing ${JOBS[t].label.toLowerCase()} first`);
          try { await withTimeout(RUNNERS[t]({ ...c, job: { ...c.job, type: t } }), JOBS[t].timeout * 1000); ST.lastRun[t] = now(); } catch {}
        }
      }
      c.phase("analyze", "Writing the executive summary and 12 research sections");
      const s = session(), dayForData = s.trading && s.min >= 570 ? s.day : lastTradingDay();
      const doc = buildBriefing({ slot, slots: SLOTS, session: s, dataDay: dayForData, ST, DISC, trader: traderState(), now: now(), sectorOf, nameOf, held: held(), tracked: tracked(), MACRO_LINKS, manual: !!c.job.manual });
      c.phase("save", "Saving the briefing to history");
      await store.set("b:" + doc.id, doc);
      BIDX = [{ id: doc.id, day: doc.day, slot: doc.slot, label: doc.label, t: doc.generatedAt, headline: doc.headline, keywords: doc.keywords, tickers: doc.tickers, trading: doc.trading, manual: doc.manual }, ...BIDX.filter((b) => b.id !== doc.id)].slice(0, 600);
      markDirty(); await save(true);
      return { summary: `${doc.label} briefing saved (${doc.sections.filter((x) => x.items.length).length} sections with content)` };
    },
  };

  // ------------------------------------------------------------ AI Trader interface
  // A small, explainable research signal per stock, from the last 7 days of discoveries: tone × recency × confidence.
  // trader: true keeps only information the swing bot does NOT already score itself (it already uses price momentum,
  // trend, headline sentiment, EPS beats/misses and the 10-K health grade), so nothing is counted twice.
  const ownPortfolio = (d) => d.cat === "portfolio" || d.cat === "ai_trader" || /^pfsec:/.test(d.key);
  const traderNew = (d) => d.cat === "insider" || (d.cat === "earnings" && /^release:/.test(d.key)) || (d.cat === "pattern" && /^(newspat|secmove):/.test(d.key));
  function signal(sym, o = {}) {
    const ds = discFor(sym, 7).filter((d) => d.tone && !ownPortfolio(d) && (!o.trader || traderNew(d)));
    let sum = 0, w = 0; const parts = [];
    for (const d of ds) { const age = (now() - d.u) / DAY, k = Math.exp(-age / 3) * (d.conf || 0.5) * (0.5 + (d.mag || 0.4)); sum += d.tone * k; w += k; parts.push([d.tone * k, `${d.tone > 0 ? "▲" : "▼"} ${d.headline}`]); }
    const score = clamp(sum / 3, -1, 1);
    // strongest contributors first, leading with the side that wins
    const reasons = parts.sort((a, b) => (score < 0 ? a[0] - b[0] : b[0] - a[0])).slice(0, 5).map((x) => x[1]);
    return { sym, score: r2(score), n: ds.length, conf: r2(clamp(w / 3, 0, 1)), reasons, basis: o.trader ? "insider trades, earnings-release tone and sector news patterns (inputs the bot doesn't already score)" : "all directional Spider findings from the last 7 days" };
  }
  // The full structured research packet AI Trader, the Claude Predictor and the UI use for one stock.
  function packet(symIn) {
    const s = String(symIn || "").toUpperCase(), all = discFor(s, 120), recent = all.filter((d) => d.u >= now() - 14 * DAY);
    const pick = (cats, list = recent) => list.filter((d) => cats.includes(d.cat));
    const brief = (d) => ({ id: d.id, t: d.u, cat: d.cat, headline: d.headline, summary: d.summary, tone: d.tone, importance: d.importance, conf: d.conf, kind: kindOf(d), interpretation: d.interp ? d.interp.text : null, sources: d.sources });
    const sec = sectorOf(s), macro = DISC.filter((d) => ["macro", "policy"].includes(d.cat) && d.u >= now() - 7 * DAY && sec && d.sectors.includes(sec)).slice(0, 5);
    const sent = pick(["news"]), sig = signal(s), funda = ST.funda[s] || null;
    const mkt = ST.market, secRow = mkt && sec ? (mkt.sectors || []).find((x) => x.name === sec) : null;
    const up = ((ST.earnings || {}).upcoming || []).find((e) => e.symbol === s), rep = ((ST.earnings || {}).reported || []).find((e) => e.sym === s);
    const snap = all.find((d) => d.cat === "company");
    return {
      symbol: s, name: nameOf(s), sector: sec, industry: industryOf(s), generatedAt: now(),
      coverage: { discoveries: all.length, recent: recent.length, lastResearched: ST.researched[s] || null },
      developments: recent.slice(0, 8).map(brief),
      financialChanges: funda ? { fiscalYear: funda.fy, grade: funda.grade, score: funda.score, revenueGrowth: funda.revG, netMargin: funda.nm, freeCashFlow: funda.fcf, checked: funda.t, source: "SEC EDGAR XBRL (10-K)" } : null,
      earnings: { upcoming: up || null, lastReported: rep || null, release: pick(["earnings"]).map(brief).slice(0, 3) },
      sentiment: { score: sent.length ? r2(sent.reduce((a, d) => a + d.tone, 0) / sent.length) : null, items: sent.map(brief).slice(0, 3), method: "headline word rules (not article text)" },
      macro: macro.map(brief), sectorPerformance: secRow ? { sector: sec, etf: secRow.etf, todayPct: r2(secRow.chg), asOf: mkt.at } : null,
      valuation: snap && snap.data ? { price: snap.data.price, vs200d: snap.data.m200 ? r2((snap.data.price / snap.data.m200 - 1) * 100) : null, return3m: snap.data.r3 != null ? r2(snap.data.r3 * 100) : null, analystScore: snap.data.analyst ?? null, note: "price-based observations; no P/E model is run here" } : null,
      catalysts: [...(up ? [`Earnings ${up.date}${up.hour === "bmo" ? " before the open" : up.hour === "amc" ? " after the close" : ""}`] : []), ...pick(["filing", "earnings", "policy"]).slice(0, 3).map((d) => d.headline)],
      risks: recent.filter((d) => d.tone < 0 || (d.cat === "portfolio" && d.mag >= 0.6)).slice(0, 5).map(brief),
      history: all.filter((d) => d.u < now() - 14 * DAY).slice(0, 6).map(brief),
      hypotheses: all.filter((d) => d.hyp).map((d) => ({ claim: d.hyp.claim, status: d.hyp.status, rel: d.hyp.rel ?? null, from: d.hyp.t0 })).slice(0, 5),
      signal: sig, traderSignal: signal(s, { trader: true }), confidence: sig.conf,
      sources: uniq(recent.flatMap((d) => d.sources.map((x) => x.name))).slice(0, 10),
      note: "Research only. The Spider never places trades.",
    };
  }
  // Score adjustment for the swing bot: at most ±maxAdj, and only from inputs it doesn't already have.
  function traderAdjust(sym, maxAdj = 0.05) {
    const sg = signal(sym, { trader: true });
    if (!sg.n) return { adj: 0, note: null };
    const adj = r2(maxAdj * sg.score * sg.conf * 100) / 100;
    return { adj, note: Math.abs(adj) >= 0.01 ? `Spider: ${sg.reasons[0].replace(/^[▲▼] /, "")}` : null, signal: sg };
  }
  const traderView = () => ({ at: ST.trader ? ST.trader.at : null, held: ST.trader ? ST.trader.held : traderHeld(), packets: ST.trader ? ST.trader.packets : {}, riskOff: ST.trader ? ST.trader.riskOff : null, stress: ST.trader ? ST.trader.stress : null });
  // compact text block for Claude prompts (predictor / Ask Claude)
  function promptContext(syms, max = 1800) {
    const out = [];
    for (const s of syms.slice(0, 12)) {
      const ds = discFor(s, 14).slice(0, 4); if (!ds.length) continue;
      out.push(`${s}: ` + ds.map((d) => `[${new Date(d.u).toISOString().slice(0, 10)} ${d.cat}, ${kindOf(d)}] ${d.headline}`).join(" | "));
    }
    const mk = DISC.filter((d) => ["macro", "policy", "market", "pattern", "sector"].includes(d.cat) && d.u >= now() - 2 * DAY).sort((a, b) => b.importance - a.importance).slice(0, 5);
    if (mk.length) out.push("MARKET: " + mk.map((d) => d.headline).join(" | "));
    const txt = out.join("\n"); return txt.length > max ? txt.slice(0, max) + "…" : txt;
  }

  // ------------------------------------------------------------ public views
  function status() {
    const s = session(), cur = running ? { id: running.id, type: running.type, sym: running.sym, slot: running.slot, label: running.label, area: JOBS[running.type].area, go: goOf(running), started: running.started, prio: running.prio, phase: activity.state, note: activity.note } : null;
    const nextSlot = Object.entries(SLOTS).find(([k, w]) => s.trading && s.min < w.to && !BIDX.some((b) => b.day === s.day && b.slot === k));
    return {
      t: now(), state: running ? activity.state : (activity.state === "error" && now() - activity.at < 90e3 ? "error" : "idle"), note: running ? activity.note : activity.state === "error" ? activity.note : (ST.hour.length >= MAX_PER_HOUR ? activity.note : ""),
      running: cur, session: { phase: s.phase, open: s.open, trading: s.trading, day: s.day },
      queue: ST.queue.slice().sort((a, b) => b.prio.score - a.prio.score).slice(0, 14).map((j) => ({ id: j.id, type: j.type, sym: j.sym, slot: j.slot, label: labelOf(j), area: JOBS[j.type].area, score: j.prio.score, why: j.prio.why, parts: j.prio.parts, waiting: j.notBefore > now() ? j.notBefore : null, retry: j.tries || 0 })),
      queued: ST.queue.length, recent: ST.jobs.slice(0, 30),
      stats: { ...ST.stats, memory: DISC.length, briefings: BIDX.length, budget: { used: ST.hour.filter((t) => now() - t < HOUR).length, max: MAX_PER_HOUR }, hypotheses: { ...ST.hyp, open: DISC.filter((d) => d.hyp && d.hyp.status === "open").length } },
      scheduler: { lastTick: lastTickAt, error: lastTickError, nextBriefing: nextSlot ? { slot: nextSlot[0], label: nextSlot[1].label, at: nextSlot[1].from } : null },
      context: { holdings: held().length, watchlist: ST.context.watchlist.length, portfolios: ST.context.portfolios.length, updated: ST.context.updated },
      storage: store.info(),
    };
  }
  const CAT_GROUP = { stocks: ["company", "mover", "filing", "insider", "fundamentals", "news"], sectors: ["sector", "pattern"], macro: ["macro", "policy", "market"], earnings: ["earnings"], portfolio: ["portfolio"], ai: ["ai_trader"] };
  function discoveries(o = {}) {
    let L = DISC.slice();
    if (o.group && CAT_GROUP[o.group]) L = L.filter((d) => CAT_GROUP[o.group].includes(d.cat));
    if (o.cat) L = L.filter((d) => d.cat === o.cat);
    if (o.symbols && o.symbols.length) L = L.filter((d) => d.tickers.some((t) => o.symbols.includes(t)));
    if (o.mine) L = L.filter((d) => d.pf && d.pf.rel >= 0.45);
    if (o.ai) L = L.filter((d) => d.ai && d.ai.rel >= 0.5);
    if (o.explore) L = L.filter((d) => d.explore);
    if (o.min) L = L.filter((d) => d.importance >= o.min);
    if (o.since) L = L.filter((d) => d.u >= o.since);
    if (o.q) { const re = new RegExp(String(o.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); L = L.filter((d) => re.test(d.headline) || re.test(d.summary) || d.tickers.some((t) => re.test(t)) || d.sectors.some((s) => re.test(s))); }
    L.sort(o.sort === "importance" ? (a, b) => b.importance - a.importance || b.u - a.u : (a, b) => b.u - a.u);
    const total = L.length; L = L.slice(0, clamp(o.limit || 60, 1, 200));
    return { total, items: L.map((d) => ({ ...d, sig: undefined })) };
  }
  const getDiscovery = (id) => { const d = DISC.find((x) => x.id === id); return d ? { ...d, related: (d.rel || []).map((r) => DISC.find((x) => x.id === r)).filter(Boolean).map((x) => ({ id: x.id, headline: x.headline, cat: x.cat, u: x.u, importance: x.importance })) } : null; };
  async function briefings(o = {}) {
    let L = BIDX.slice();
    if (o.from) L = L.filter((b) => b.day >= o.from); if (o.to) L = L.filter((b) => b.day <= o.to);
    if (o.q) { const re = new RegExp(String(o.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); L = L.filter((b) => re.test(b.headline) || re.test(b.keywords || "") || (b.tickers || []).some((t) => re.test(t)) || re.test(b.day)); }
    return { total: L.length, items: L.slice(0, o.limit || 60) };
  }
  // Live summary for THE WEB page: rebuilt from the latest research while the market is open (cached 45 s);
  // once the market closes it is frozen as that day's final summary.
  let LIVE = null;
  const AREA_RULES = [[/flagged risk/i, "filings"], [/S&P 500|members/i, "data"], [/\bled \(|\blagged \(/i, "nyse"], [/theme|top story/i, "news"], [/Next catalyst|reports /i, "data"]];
  function summaryLines(doc) {
    const pfNames = ((ST.exposure || {}).pfs || []).map((p) => p.name);
    const lines = doc.exec.map((t) => ({ t, area: pfNames.some((n) => t.includes(n)) ? "portfolio" : (AREA_RULES.find(([re]) => re.test(t)) || [, "data"])[1] }));
    const sec = (k) => (doc.sections.find((x) => x.key === k) || { items: [] }).items;
    const eco = sec("economic")[0]; if (eco) lines.push({ t: `Economy: ${eco.text.replace(/\.$/, "")}.`, area: "macro" });
    const ai = sec("ai")[0]; if (ai) lines.push({ t: `AI Trader: ${ai.text.replace(/^Market mode: /, "mode ").replace(/\.$/, "")}.`, area: "aitrade" });
    return lines;
  }
  async function liveSummary() {
    await load(); const s = session();
    if (s.open) {
      if (LIVE && LIVE.live && now() - LIVE.at < 45e3) return LIVE;
      const doc = buildBriefing({ slot: "live", slots: { ...SLOTS, live: { label: "Live", title: "Live market summary" } }, session: s, dataDay: s.day, ST, DISC, trader: traderState(), now: now(), sectorOf, nameOf, held: held(), tracked: tracked(), MACRO_LINKS, manual: false });
      return (LIVE = { at: now(), live: true, day: s.day, generatedAt: doc.generatedAt, freshness: doc.freshness, lines: summaryLines(doc), title: "Live market summary" });
    }
    const b = BIDX[0] ? await store.get("b:" + BIDX[0].id) : null;
    if (LIVE && !LIVE.live && b && LIVE.id === b.id) return LIVE;
    if (!b) return { at: now(), live: false, day: s.day, lines: [], title: "Market summary", empty: true, phase: s.phase };
    return (LIVE = { id: b.id, at: now(), live: false, day: b.day, generatedAt: b.generatedAt, freshness: b.freshness, lines: summaryLines(b), title: `Final summary · ${b.dataDay || b.day}`, phase: s.phase });
  }
  async function briefing(id) { await load(); if (id === "latest") id = (BIDX[0] || {}).id; return id ? store.get("b:" + id) : null; }

  const self = {
    load, save, start, stop, tick, runNow, liveSummary, enqueue, setContext, status, discoveries, getDiscovery, briefings, briefing, packet, signal, traderAdjust, traderView, promptContext, session, marketOpen,
    graph: (o) => require("./intel").graph({ ST, DISC, SP, sectorOf, industryOf, nameOf, held: held(), tracked: tracked(), traderHeld: traderHeld(), MACRO_LINKS, now: now(), ...o }),
    ask: (question, opts = {}) => require("./intel").ask({ question, spider: self, ST, DISC, BIDX, SP, sectorOf, nameOf, held: held(), tracked: tracked(), now: now(), ...opts }),
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    _internal: { get ST() { return ST; }, get DISC() { return DISC; }, get BIDX() { return BIDX; }, RUNNERS, JOBS, prioritize, discover, plan, relevance, prune, et },
  };
  return self;
}
module.exports = { createSpider, withTimeout, kindOf, JOBS, SLOTS, MACRO_LINKS, SECTOR_ETF, FUND_CLASS };

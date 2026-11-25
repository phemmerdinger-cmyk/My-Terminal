"use strict";
const Day = require("./day-shadow-runner.js");
const Swing = require("./swing-shadow-runner.js");
const Pair = require("./quant-pairs-runner.js");
const PairRules = require("./quant-pairs-core.js");
const RiskFree = require("./risk-free-core.js");
const Extra = require("./extra-bots-runner.js");
const ExtraRules = require("./extra-bots-core.js");
const Tough = require("./robustness-core.js");
const FRED = { source: "FRED · DGS3MO", url: "https://fred.stlouisfed.org/series/DGS3MO" };
const TREASURY = { source: "U.S. Treasury · 3-month par yield", url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve" };

const START = 30_000;
const DAY_UNIVERSE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMD", "JPM", "XOM", "META", "AMZN", "TSLA"];
const SWING_UNIVERSE = ["AAPL", "MSFT", "AMD", "NVDA", "META", "GOOGL", "AMZN", "TSLA", "JPM", "V", "XOM", "CVX", "PG", "WMT", "COST", "LLY", "UNH", "CAT", "GE", "NEE", "PLD", "LIN"];
const PAIR_UNIVERSE = [...new Set(PairRules.PAIRS.flatMap((p) => [p.left, p.right]))];
const UNIVERSE = [...new Set(["SPY", "^VIX", ...SWING_UNIVERSE, ...PAIR_UNIVERSE, ...ExtraRules.SECTORS])];
const EXPERIMENTS = [
  ["day-base", "Day · continuation + reversal", "day"],
  ["day-fvg", "Day · fair-value gap filter", "day"],
  ["swing-technical", "Swing · Stage 2 and contraction", "swing"],
  ["swing-canslim", "Swing · earnings confirmation", "swing"],
  ["quant-pairs", "Quant · hedged spread book", "quant"],
  ["extra-pullback", "Swing · 2-day pullback (RSI 2)", "swing"],
  ["extra-rotation", "Quant · monthly sector rotation", "quant"],
  ["extra-earnings", "Swing · post-earnings drift", "swing"],
  ["extra-insider", "Swing · insider buying (spider)", "swing"],
];
const pairCosts = Object.fromEntries(PAIR_UNIVERSE.map((sym) => [sym, { halfSpreadBps: 2.5, slippageBps: 2.5, feeBps: 0 }]));
const recordBook = (b) => ({
  cash: b?.cash ?? START, value: b?.value ?? START, positions: Object.keys(b?.positions || {}).length, pending: Object.keys(b?.pending || {}).length,
  closed: b?.closed ?? 0, costs: b?.costs ?? 0, pnl: (b?.value ?? START) - START,
});
const SOURCES = [
  ["Linda Raschke and Larry Connors", "Their Holy Grail rules use a strong ADX trend and a pullback to a 20-period EMA. The lab adds a separate opening-range filter.", "https://lindaraschke.net/wp-content/uploads/2026/01/august1997.pdf"],
  ["Al Brooks", "Brooks separates trend continuation from trading-range behavior. The lab records separate continuation and reversal signals.", "https://www.brookstradingcourse.com/wp-content/uploads/2016/05/Al-Brooks-Webinar-Distinguishing-Strong-Legs-TR-vs-Trends-May-3-2016.pdf"],
  ["ICT · Liquidity Purge & Revert", "The lab tests price reclaims and a separate three-candle gap filter. OHLC bars show prices, without identifying resting orders.", "https://www.youtube.com/watch?v=aWFSvqxEfg8"],
  ["Mark Minervini", "The publisher describes Minervini's SEPA approach to precise entries and risk control. The lab tests its own predeclared contraction screen.", "https://www.mheducation.com/highered/mhp/product/trade-like-stock-market-wizard-how-achieve-super-performance-stocks-any-market.html"],
  ["William O'Neil", "O'Neil explains why market direction belongs in CAN SLIM. The lab compares a technical screen with a separate earnings-confirmation variant.", "https://www.aaii.com/journal/article/the-big-picture-how-to-determine-the-stock-market-s-direction"],
  ["Stan Weinstein", "Weinstein's Stage Analysis describes the transition into an advancing stage. The lab requires a rising 30-week average before testing a breakout.", "https://books.google.com/books/about/Stan_Weinstein_s_Secrets_For_Profiting_i.html?id=RTB_yclEGqQC"],
  ["Ernest Chan", "Chan's published mean-reversion work motivates testing a hedged spread for stationarity before trading it.", "https://onlinelibrary.wiley.com/doi/abs/10.1002/9781118676998.ch2"],
  ["Jim Simons · Simons Foundation", "The foundation's career profile describes his mathematical modeling. Renaissance's trading signals are proprietary, so the lab uses a published, testable pairs method.", "https://www.simonsfoundation.org/news/simons-foundation-chair-jim-simons-on-his-career-in-mathematics/"],
  ["Ed Thorp", "Thorp describes fractional Kelly for limiting exposure to estimation error. The pairs study starts with fixed stop-risk caps while the edge is unproven.", "https://www.edwardothorp.com/wp-content/uploads/2016/11/thorpwilmottqfinrev2003.pdf"],
  ["Frazzini, Israel and Moskowitz", "The authors use execution records to measure trading cost by instrument and trade. The lab reports a doubled-cost sensitivity alongside modeled cost.", "https://www.aqr.com/insights/research/working-paper/trading-costs"],
  ["Bailey and López de Prado", "Their work shows how testing many variants inflates reported performance. The lab records outcomes by experiment with no automatic promotion.", "https://davidhbailey.com/dhbpapers/deflated-sharpe.pdf"],
  ["Larry Connors · RSI(2)", "Buy above the 200-day average when the 2-period RSI drops under 10; exit on a close above the 5-day average. The lab adds an 8% stop and a 7-session limit.", "https://chartschool.stockcharts.com/table-of-contents/trading-strategies-and-models/trading-strategies/rsi-2"],
  ["Mebane Faber", "Faber's tactical allocation paper uses long moving averages to step out of falling assets. The sector bot holds the 3 strongest sector funds only while each is above its 200-day average.", "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461"],
  ["Bernard and Thomas", "They document prices drifting after earnings surprises. The lab requires a 5% EPS beat confirmed by a 2% up day and holds up to 40 sessions.", "https://www.jstor.org/stable/2491062"],
  ["Cohen, Malloy and Pomorski", "They find predictive power in opportunistic, not routine, insider trades. The spider leaves out pre-set 10b5-1 plan trades and amended repeats, but doesn't otherwise tell routine from opportunistic buying, so the lab requires two or more different insiders buying on the open market.", "https://www.nber.org/papers/w16454"],
].map(([title, summary, url]) => ({ title, summary, url }));

function quarterlyComparison(facts, sessionDay, observedAt) {
  const quarterly = (units) => {
    const found = new Map();
    for (const row of units || []) {
      if (!row.start || !row.end || !row.filed || row.filed >= sessionDay || !["10-K", "10-Q", "10-Q/A", "10-K/A"].includes(row.form)) continue;
      const duration = (Date.parse(row.end) - Date.parse(row.start)) / 86_400_000;
      if (duration < 75 || duration > 105 || !Number.isFinite(row.val)) continue;
      if (!found.has(row.end) || found.get(row.end).filed < row.filed) found.set(row.end, row);
    }
    return found;
  };
  const taxonomy = facts?.["us-gaap"];
  const eps = quarterly(taxonomy?.EarningsPerShareDiluted?.units?.["USD/shares"]);
  const sales = ["RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "Revenues"]
    .map((tag) => quarterly(taxonomy?.[tag]?.units?.USD)).find((group) => group.size >= 2);
  if (!sales) return null;
  const matches = [...eps.keys()].filter((end) => sales.has(end)).sort();
  const end = matches.at(-1);
  const prior = matches.findLast((candidate) => {
    const days = (Date.parse(end) - Date.parse(candidate)) / 86_400_000;
    return days >= 350 && days <= 380;
  });
  if (!prior) return null;
  return { availableAt: observedAt, eps: eps.get(end).val, priorYearEps: eps.get(prior).val,
    sales: sales.get(end).val, priorYearSales: sales.get(prior).val, periodEnd: end, source: "SEC EDGAR Company Facts" };
}

function createStrategyLab({ store, clock, now = Date.now, nextSession, minuteHistory, dailyData, bars, rates, treasuryRates, liveDesk, events = async () => ({ earnings: [], insider: [] }), mainBots = () => [] }) {
  let state, serial = Promise.resolve(), lastFault = null, rateCache = null, rateInFlight = null;
  const warm = new Map(), daily = new Map();
  let warmInFlight = null, dailyInFlight = null, openInFlight = null;
  const fresh = () => ({ since: now(), day: null, swing: Swing.freshSwingShadows(now()), pairs: Pair.freshPairShadows(), extra: Extra.freshExtraBots(now()), borrow: {}, records: [], regime: null, scannedDay: null });

  function run(fn) {
    const next = serial.then(async () => {
      if (!state) state = await store.get("lab") || fresh();
      if (!state.extra) state.extra = Extra.freshExtraBots(now()); // labs saved before the four extra bots existed
      return fn(state);
    });
    serial = next.catch((e) => { lastFault = String(e.message || e).slice(0, 240); });
    return next;
  }

  async function commit(next) {
    await store.set("lab", next);
    state = next;
    lastFault = null;
  }

  function warmDay(day) {
    if (warmInFlight) return warmInFlight;
    if (DAY_UNIVERSE.every((sym) => warm.get(sym)?.day === day)) return Promise.resolve();
    warmInFlight = (async () => {
      for (let i = 0; i < DAY_UNIVERSE.length; i += 4) {
        await Promise.allSettled(DAY_UNIVERSE.slice(i, i + 4).map(async (sym) => {
          if (warm.get(sym)?.day === day) return;
          const h = await minuteHistory(sym);
          const relevant = h.filter((b) => b.d < day && b.m >= 570 && b.m < clock(b.t * 1000).close);
          if (relevant.length >= 30) warm.set(sym, { day, bars: relevant.slice(-156) });
        }));
      }
    })().finally(() => { warmInFlight = null; });
    return warmInFlight;
  }

  function onMinute(series, day, close, prior) {
    const observed = now();
    const chosen = series.filter(([symbol]) => DAY_UNIVERSE.includes(symbol));
    return run(async s => {
      if (s.day?.updated >= observed || (s.day?.day && s.day.day > day)) return;
      const warmup = Object.fromEntries([...warm.entries()].filter(([, w]) => w.day === day).map(([sym, w]) => [sym, w.bars]));
      const next = structuredClone(s);
      next.day = Day.advanceDayShadows(next.day, { series: chosen, day, close, now: observed, warmup, prior });
      await commit(next);
    });
  }

  function loadRates() {
    if (rateCache && now() < rateCache.refreshAt) return Promise.resolve(rateCache);
    if (rateInFlight) return rateInFlight;
    rateInFlight = (async () => {
      const date = clock().day;
      for (const [feed, parse, provider] of [[rates, RiskFree.parseDgs3moCsv, FRED], [treasuryRates, RiskFree.parseTreasuryCsv, TREASURY]]) {
        if (!feed) continue;
        try {
          const observations = parse(await feed(date));
          if (!RiskFree.rateBefore(observations, date)) continue;
          rateCache = { refreshAt: now() + 6 * 3600_000, observations, provider, error: null };
          return rateCache;
        } catch { /* Fall through to the next official source. */ }
      }
      rateCache = { refreshAt: now() + 15 * 60_000, observations: rateCache?.observations || [],
        provider: rateCache?.provider || FRED, error: "Treasury rate feeds unavailable" };
      return rateCache;
    })().finally(() => { rateInFlight = null; });
    return rateInFlight;
  }

  function summaries(s) {
    const pair = Pair.pairSummary(s.pairs);
    const books = [recordBook(s.day?.books?.base), recordBook(s.day?.books?.fvg), recordBook(s.swing.books.technical), recordBook(s.swing.books.canSlim),
      { value: pair.value, cash: pair.cash, closed: pair.closedPairs, pending: pair.queued, positions: pair.openPairs, costs: pair.costs + pair.borrow, pnl: pair.value - START },
      ...Extra.BOTS.map((b) => recordBook(s.extra?.books?.[b]))];
    return EXPERIMENTS.map(([id, label, bot], i) => ({ id, label, bot, ...books[i] }));
  }

  function flags(barsBySymbol) {
    const avg = (a) => a.reduce((sum, x) => sum + x, 0) / a.length;
    const spy = barsBySymbol.SPY || [], vix = barsBySymbol["^VIX"] || [];
    const universe = SWING_UNIVERSE.map((symbol) => (barsBySymbol[symbol] || []).slice(-20).map((bar) => bar.close)).filter((x) => x.length === 20);
    const breadth = universe.length >= Math.ceil(SWING_UNIVERSE.length * 0.8) ? universe.filter((s) => s.at(-1) > avg(s)).length / universe.length : null;
    const above = spy.length >= 200 ? spy.at(-1).close > avg(spy.slice(-200).map((b) => b.close)) : null;
    const current = vix.at(-1)?.close, prior = vix.at(-2)?.close;
    const shock = current > 0 && prior > 0 ? current >= 30 && current / prior - 1 >= 0.2 : null;
    const riskOff = shock !== false || breadth == null || breadth < 0.55 || above !== true;
    return { available: universe.length, universe: SWING_UNIVERSE.length, breadth, spyAbove200: above,
      shock, riskOff, reason: shock ? "Volatility shock" : shock == null ? "VIX data unavailable" : breadth == null ? "Insufficient eligible-stock breadth" :
        riskOff ? "Swing requires 55% breadth and SPY above its 200-day average" : "Swing regime eligible" };
  }

  async function planDaily(t) {
    if (dailyInFlight) return dailyInFlight;
    const already = await run(s => s.scannedDay === t.day);
    if (already) return;
    if (dailyInFlight) return dailyInFlight;
    dailyInFlight = (async () => {
      for (let i = 0; i < UNIVERSE.length; i += 4) {
        await Promise.allSettled(UNIVERSE.slice(i, i + 4).map(async (sym) => {
          if (daily.get(sym)?.day === t.day) return;
          daily.set(sym, { ...(await dailyData(sym, t)), day: t.day });
        }));
      }
      // the four extra bots: today's earnings and insider-buying candidates plus anything they hold (best effort)
      let ev = { earnings: [], insider: [] };
      try { ev = await events(t); } catch { /* no events → no new earnings/insider ideas today */ }
      const held = await run((s) => Extra.neededSymbols(s.extra));
      const extraSyms = [...new Set([...held, ...(ev.earnings || []).map((e) => e.symbol), ...(ev.insider || []).map((e) => e.symbol)])].filter((sym) => !UNIVERSE.includes(sym)).slice(0, 40);
      for (let i = 0; i < extraSyms.length; i += 4) {
        await Promise.allSettled(extraSyms.slice(i, i + 4).map(async (sym) => {
          if (daily.get(sym)?.day === t.day) return;
          daily.set(sym, { ...(await dailyData(sym, t)), day: t.day });
        }));
      }
      const bundle = [...daily.entries()].filter(([, d]) => d.day === t.day);
      const barsBySymbol = Object.fromEntries(bundle.map(([symbol, result]) => [symbol, result.bars]));
      if (!barsBySymbol.SPY?.length || !barsBySymbol["^VIX"]?.length) throw new Error("Waiting for finalized SPY and VIX closes");
      const observed = bundle.filter(([sym]) => UNIVERSE.includes(sym)).length;
      if (observed < UNIVERSE.length && clock().min < t.close + 85) {
        throw new Error(`Waiting for finalized security data (${observed}/${UNIVERSE.length})`);
      }
      const { observations } = await loadRates();
      if (clock().day !== t.day) return;
      const latest = (syms, field) => Object.fromEntries(bundle.filter(([sym]) => syms.includes(sym)).map(([sym, v]) => [sym, v[field]?.[t.day]]));
      const asOf = now(), executeDay = nextSession(t.day), regime = flags(barsBySymbol);
      const adjustedCloses = Object.fromEntries(bundle.filter(([sym]) => PAIR_UNIVERSE.includes(sym)).map(([sym, v]) => [sym, v.adjusted]));
      const sessions = barsBySymbol.SPY.map((b) => b.day);
      await run(async s => {
        if (s.scannedDay === t.day) return;
        const next = structuredClone(s);
        const swingBars = Object.fromEntries(Object.entries(barsBySymbol).filter(([sym]) => sym === "SPY" || SWING_UNIVERSE.includes(sym)));
        const fundamentalsBySymbol = Object.fromEntries(bundle.filter(([, d]) => d.fundamental).map(([sym, d]) => [sym, [d.fundamental]]));
        next.swing = Swing.prepareSwingShadows(next.swing, { barsBySymbol: swingBars, signalDay: t.day, asOf, nextSession: executeDay, regime, fundamentalsBySymbol });
        next.pairs = Pair.preparePairShadows(next.pairs, { sessions, adjustedCloses, signal: { day: t.day, time: asOf,
          adjustedPrices: latest(PAIR_UNIVERSE, "adjusted"), rawPrices: latest(PAIR_UNIVERSE, "raw") },
          borrow: next.borrow, executionCosts: pairCosts, executeDay, now: asOf, riskOff: regime.shock !== false }) || next.pairs;
        // toughness test (weekly): replay pullback and rotation on ~2 years of daily bars; earnings and insider have no
        // free history, so they're judged on their live paper record. A "fail" pauses that bot's new buys automatically.
        if (!next.robust || !next.robust.day || Date.parse(t.day) - Date.parse(next.robust.day) >= 6 * 864e5) {
          const pick = (syms) => Object.fromEntries(["SPY", ...syms].filter((sym) => barsBySymbol[sym]).map((sym) => [sym, barsBySymbol[sym]]));
          const results = {};
          try { results.pullback = Tough.toughness("pullback", pick(SWING_UNIVERSE), { universe: SWING_UNIVERSE }); } catch (e) { results.pullback = { status: "error", label: "Test couldn't run: " + String(e.message || e).slice(0, 80) }; }
          try { results.rotation = Tough.toughness("rotation", pick(ExtraRules.SECTORS)); } catch (e) { results.rotation = { status: "error", label: "Test couldn't run: " + String(e.message || e).slice(0, 80) }; }
          next.robust = { day: t.day, at: asOf, results };
        }
        for (const b of ["earnings", "insider"]) next.robust.results[b] = Tough.liveRecord(next.extra.books[b]);
        const paused = Object.fromEntries(Object.entries(next.robust.results).map(([b, r]) => [b, Tough.paused(r)]));
        next.extra = Extra.prepareExtraBots(next.extra, { barsBySymbol, signalDay: t.day, asOf, nextSession: executeDay, sessions,
          universe: SWING_UNIVERSE, earningsEvents: ev.earnings, insiderEvents: ev.insider, paused }) || next.extra;
        next.regime = regime;
        next.scannedDay = t.day;
        const desk = liveDesk(), sp = barsBySymbol.SPY.at(-1).close;
        const shadowMarks = [...Object.values(next.swing.books).flatMap((book) => Object.keys(book.positions)),
          ...Object.values(next.pairs.positions).flatMap((p) => p.orders.map((leg) => leg.symbol)),
          ...Object.keys(next.extra.books.rotation.positions)]; // extra stock bots keep their last mark if one daily bar is late
        if (desk.state?.closeDay === t.day && desk.equity && !desk.error &&
            shadowMarks.every((sym) => barsBySymbol[sym]?.at(-1)?.day === t.day)) {
          next.records.push({ day: t.day, at: asOf, benchmark: sp, active: desk.equity, rate: RiskFree.rateBefore(observations, t.day),
            shadow: Object.fromEntries(summaries(next).map((r) => [r.id, { value: r.value, costs: r.costs }])) });
          next.records = next.records.slice(-300);
        }
        await commit(next);
      });
    })().finally(() => { dailyInFlight = null; });
    return dailyInFlight;
  }

  async function settleOpen(t) {
    if (openInFlight) return openInFlight;
    openInFlight = (async () => {
      const expected = await run(s => {
        const swing = Object.values(s.swing.books).flatMap((book) => (book.pending || []).filter((p) => p.openDay === t.day).map((p) => p.symbol));
        const pair = s.pairs.pending.filter((p) => p.executeDay === t.day).flatMap((p) => p.orders.map((l) => l.symbol));
        return [...new Set([...swing, ...pair, ...Extra.openingSymbols(s.extra, t.day)])];
      });
      if (!expected.length) return;
      const marketTime = (Math.floor(now() / 60_000) - (clock().min - 570)) * 60_000;
      const fetched = await Promise.allSettled(expected.map(async (sym) => [sym, (await bars(sym)).find((b) => b.d === t.day && b.t * 1000 === marketTime)]));
      const openingBars = Object.fromEntries(fetched.filter((x) => x.status === "fulfilled" && x.value[1]).map((x) => x.value));
      const opens = Object.fromEntries(Object.entries(openingBars).map(([sym, bar]) => [sym, { price: bar.o, marketTime }]));
      const observed = now();
      await run(async s => {
        const next = { ...s, swing: Swing.openSwingShadows(s.swing, { day: t.day, openingBars, now: observed }),
          pairs: Pair.openPairShadows(s.pairs, { day: t.day, opens, openTime: marketTime, now: observed, borrow: s.borrow }) || s.pairs,
          extra: Extra.openExtraBots(s.extra, { day: t.day, openingBars, now: observed, minute: clock().min }) || s.extra };
        await commit(next);
      });
    })().finally(() => { openInFlight = null; });
    return openInFlight;
  }

  function tick() {
    const t = clock();
    if (!t.trading) return;
    if (t.min >= 540 && t.min < t.close && t.min % 15 === 0) warmDay(t.day).catch(() => {});
    if (t.min >= 571 && t.min <= 575) return settleOpen(t).catch((e) => { lastFault = String(e.message || e).slice(0, 240); });
    if (t.min >= t.close + 25 && t.min <= t.close + 90 && t.min % 5 === 0) {
      return planDaily(t).catch((e) => { lastFault = String(e.message || e).slice(0, 240); });
    }
  }

  async function saveBorrow(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > PAIR_UNIVERSE.length) throw new Error("Expected one or more pair-universe borrow quotes");
    const received = now(), quotes = {};
    for (const r of rows) {
      const sym = typeof r.symbol === "string" ? r.symbol.toUpperCase().trim() : "";
      const time = typeof r.marketTime === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(r.marketTime) ? Date.parse(r.marketTime) : r.marketTime;
      if (!PAIR_UNIVERSE.includes(sym) || !Number.isFinite(time) || time > received || time < received - 7 * 86_400_000 ||
          !Number.isFinite(r.annualBps) || r.annualBps < 0 || r.annualBps > 100_000 ||
          typeof r.available !== "boolean" || typeof r.source !== "string" || !r.source.trim() || r.source.length > 100) throw new Error("Invalid borrow quote");
      quotes[sym] = { available: r.available, annualBps: r.annualBps, source: r.source.trim(), marketTime: time };
    }
    return run(async s => {
      for (const [sym, q] of Object.entries(quotes)) if (s.borrow[sym]?.marketTime > q.marketTime) throw new Error("A newer borrow quote is already saved for " + sym);
      await commit({ ...s, borrow: { ...s.borrow, ...quotes } });
      return { accepted: Object.keys(quotes).length };
    });
  }

  async function view() {
    const [fc, s] = await Promise.all([loadRates(), run((s) => s)]);
    const observations = fc.observations, reference = clock().day, rf = RiskFree.rateBefore(observations, reference);
    const base = s.records[0], latest = s.records.at(-1);
    const recordedRates = Object.fromEntries(s.records.filter((r) => Object.hasOwn(r, "rate")).map((r) => [r.day, r.rate]));
    const cash = RiskFree.cashBenchmark({ sessions: s.records.map((r) => r.day), observations, recordedRates });
    const cashLast = cash.points.at(-1)?.value;
    const cashReturn = cash.points.length >= 2 && cashLast != null ? cashLast - 1 : null;
    const experiments = summaries(s).map((p) => {
      const baseValue = base?.shadow[p.id]?.value, end = latest?.shadow[p.id];
      const enough = s.records.length >= 2 && baseValue > 0 && end?.value > 0;
      const shadowReturn = enough ? end.value / baseValue - 1 : null;
      let high = START, drawdown = 0;
      for (const v of [...s.records.map((r) => r.shadow[p.id]?.value), p.value]) { if (v > 0) { high = Math.max(v, high); drawdown = Math.max(drawdown, 1 - v / high); } }
      const baselineReturn = enough && base.active[p.bot] > 0 ? latest.active[p.bot] / base.active[p.bot] - 1 : null;
      const costStressReturn = enough ? (end.value - Math.max(0, end.costs - base.shadow[p.id].costs)) / baseValue - 1 : null;
      const notice = p.id === "extra-pullback" ? "22 large caps · RSI(2) dip above the 200-day · exits on the bounce" :
        p.id === "extra-rotation" ? "11 sector funds · rebalanced monthly · cash when a top sector is below its 200-day" :
        p.id === "extra-earnings" ? "Finnhub EPS surprises · needs a confirmed up day after the report" :
        p.id === "extra-insider" ? "Insider-buying findings from THE WEB spider (SEC Form 4) · only companies the spider covers" :
        p.id === "swing-canslim" ? "Requires timestamped earnings and sales inputs" : p.bot === "day" ? "Locked experiment universe · 12 symbols · modeled costs" :
        p.bot === "quant" ? "Requires current borrow data and both opening prices" : "Completed daily data and opening prints";
      const latestNote = p.id.startsWith("extra-") && s.extra?.lastNotes ? s.extra.lastNotes[p.id.slice(6)] : null;
      const tough = p.id.startsWith("extra-") ? s.robust?.results?.[p.id.slice(6)] || null : null;
      const toughNote = tough ? `Toughness test: ${tough.label}` : p.id.startsWith("extra-") ? "Toughness test: runs after the next close" : null;
      return { ...p, notice: [notice, latestNote, toughNote].filter(Boolean).join(" · "), toughness: tough, sessions: s.records.length, shadowReturn, baselineReturn, drawdown, costStressReturn,
        excessCash: shadowReturn != null && cashReturn != null ? shadowReturn - cashReturn : null };
    });
    return { asOf: now(), since: s.since, experiments, regime: s.regime?.reason ?? "Waiting for a completed session",
      recordedSessions: s.records.length, benchmarkReturn: s.records.length >= 2 && base.benchmark > 0 ? latest.benchmark / base.benchmark - 1 : null,
      riskFree: { ...rf, cashReturn, ...fc.provider, method: "ACT/365 estimated cash benchmark. Observations precede the decision date." },
      borrowSymbols: PAIR_UNIVERSE, borrowEntries: Object.entries(s.borrow).map(([symbol, q]) => ({ symbol, ...q })),
      extraNotes: s.extra?.lastNotes || null,
      toughness: { testedOn: s.robust?.day || null, mainBots: (() => { try { return mainBots(); } catch { return []; } })(),
        rule: "Pass = made money after costs, in the later 40% of the period, with settings ±20%, with doubled costs, and in 1,000 bad-luck reshuffles. Two or more misses (or a loss) = fail, which pauses that lab bot's new buys automatically. No approval needed." },
      errors: [lastFault, fc.error].filter(Boolean), pairDiagnostics: s.pairs.diagnostics.slice(-10), sources: SOURCES };
  }
  return { tick, view, warmDay, onMinute, saveBorrow };
}

module.exports = { createStrategyLab, quarterlyComparison, DAY_UNIVERSE, SWING_UNIVERSE };

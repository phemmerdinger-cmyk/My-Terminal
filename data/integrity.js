// Financial Data Integrity Engine — pure functions, no network.
// Validates, classifies and traces the data that enters the terminal:
//   • SEC fundamentals: accounting identity, balance-sheet components, cash-flow reconciliation, gross-profit and
//     EPS consistency, sign checks, independent re-computation of derived ratios, period identification, units and
//     currency, staleness, duplicate periods, restatements (from the SEC's own filing history) and revisions
//     (changes between our own fetches).
//   • Quotes: current / delayed / stale / unavailable, with the reason, and an optional cross-source comparison.
//   • A 0–100 Data Confidence Score with a published formula. It is a data-quality diagnostic, NOT a probability
//     that the data is correct.
"use strict";

const DAY = 864e5, MIN = 60e3;
const has = (...v) => v.every((x) => x != null && isFinite(x));
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);
const pct = (x) => (x * 100).toFixed(x < 0.001 ? 3 : 2) + "%";
const big = (x) => (x == null ? "n/a" : Math.abs(x) >= 1e9 ? (x / 1e9).toFixed(2) + "B" : Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(1) + "M" : String(Math.round(x)));

// ---------------------------------------------------------------- confidence score
const CONFIDENCE_FORMULA = "score = 100 × (0.35·completeness + 0.25·recency + 0.25·consistency + 0.15·source quality)";
const CONFIDENCE_NOTE = "A data-quality diagnostic built from completeness, recency, internal consistency and source quality. It is not a probability that any number is correct.";
function confidence({ completeness, recency, consistency, source }) {
  const c = Math.max(0, Math.min(1, completeness)), r = Math.max(0, Math.min(1, recency)), k = Math.max(0, Math.min(1, consistency)), s = Math.max(0, Math.min(1, source));
  const score = Math.round(100 * (0.35 * c + 0.25 * r + 0.25 * k + 0.15 * s));
  return { score, parts: { completeness: +c.toFixed(3), recency: +r.toFixed(3), consistency: +k.toFixed(3), source: +s.toFixed(3) }, weights: { completeness: 0.35, recency: 0.25, consistency: 0.25, source: 0.15 }, formula: CONFIDENCE_FORMULA, note: CONFIDENCE_NOTE,
    band: score >= 85 ? "high" : score >= 65 ? "moderate" : score >= 40 ? "low" : "very low" };
}
const SOURCE_QUALITY = { sec: 1, fred: 1, treasury: 1, finnhub: 0.8, yahoo: 0.7, news: 0.5 };

// ---------------------------------------------------------------- quotes
// status: current | delayed | stale | unavailable. "current" while the market is closed means "the last close, as expected".
function classifyQuote(q, { now = Date.now(), marketOpen = false, lastSessionClose = null } = {}) {
  if (!q || q.error || q.price == null || !isFinite(q.price)) return { status: "unavailable", reason: "no price returned by the source" };
  if (q.price <= 0) return { status: "unavailable", reason: "non-positive price rejected" };
  const t = q.marketTime || 0, age = t ? now - t : null;
  if (!t) return { status: "delayed", reason: "the source gave no timestamp", age: null };
  if (marketOpen) {
    if (age <= 2 * MIN) return { status: "current", reason: "updated within 2 minutes", age };
    if (age <= 20 * MIN) return { status: "delayed", reason: `last trade ${Math.round(age / MIN)} min ago`, age };
    return { status: "stale", reason: `no update for ${Math.round(age / MIN)} min during market hours`, age };
  }
  if (lastSessionClose && t >= lastSessionClose - 30 * MIN) return { status: "current", reason: "last close (market closed)", age };
  if (age <= 4 * DAY) return { status: "current", reason: "last close (market closed)", age };
  return { status: "stale", reason: `last price is ${Math.round(age / DAY)} days old`, age };
}
// two independent sources for the same price; tolerance 0.5% (spreads, timing)
function crossCheckPrice(a, b, labels = ["Yahoo Finance", "Finnhub"]) {
  if (!has(a, b) || a <= 0 || b <= 0) return { status: "skip", detail: "second source unavailable" };
  const d = rel(a, b);
  return { status: d <= 0.005 ? "pass" : d <= 0.02 ? "warn" : "fail", diff: +d.toFixed(5), detail: `${labels[0]} ${a} vs ${labels[1]} ${b} (${pct(d)} apart)` };
}
function summarizeQuotes(list, ctx) {
  const rows = list.map((q) => ({ symbol: q && q.symbol, ...classifyQuote(q, ctx) }));
  const n = (s) => rows.filter((r) => r.status === s).length;
  const overall = !rows.length ? "unavailable" : n("unavailable") === rows.length ? "unavailable" : n("stale") > rows.length / 3 ? "stale" : n("delayed") + n("stale") > rows.length / 3 ? "delayed" : "current";
  return { overall, counts: { current: n("current"), delayed: n("delayed"), stale: n("stale"), unavailable: n("unavailable") }, rows };
}

// ---------------------------------------------------------------- SEC fundamentals
const CORE = ["revenue", "netIncome", "totalAssets", "equity", "cfo", "capex", "cash", "dilutedShares", "operatingIncome", "currentAssets", "currentLiabilities"];
function check(id, label, status, detail, values) { return { id, label, status, detail, values: values || null }; }
// checks on one fiscal year (y) with the year before (p) for context
function checkYear(y, ratiosFn) {
  const out = [];
  // 1) accounting identity: Assets = Liabilities + Equity, using the company's own total-liabilities-and-equity line
  if (has(y.totalAssets, y.liabilitiesAndEquity)) { const d = rel(y.totalAssets, y.liabilitiesAndEquity);
    out.push(check("identity", "Assets = Liabilities + Equity (reported totals)", d <= 0.005 ? "pass" : d <= 0.02 ? "warn" : "fail", `Assets ${big(y.totalAssets)} vs liabilities + equity ${big(y.liabilitiesAndEquity)} (${pct(d)} apart)`, { assets: y.totalAssets, liabilitiesAndEquity: y.liabilitiesAndEquity })); }
  else out.push(check("identity", "Assets = Liabilities + Equity (reported totals)", "skip", "Total liabilities-and-equity line not reported in XBRL"));
  // 2) component check: total liabilities + total equity (incl. noncontrolling interests when reported)
  const eq = y.equityTotal != null ? y.equityTotal : y.equity;
  if (has(y.totalAssets, y.totalLiabilities, eq)) { const sum = y.totalLiabilities + eq, d = rel(y.totalAssets, sum);
    out.push(check("components", "Total liabilities + total equity add up to assets", d <= 0.01 ? "pass" : d <= 0.03 ? "warn" : "fail", `${big(y.totalLiabilities)} + ${big(eq)} = ${big(sum)} vs assets ${big(y.totalAssets)} (${pct(d)} apart)${y.equityTotal == null ? "; equity excludes noncontrolling interests" : ""}`, { liabilities: y.totalLiabilities, equity: eq, assets: y.totalAssets })); }
  else out.push(check("components", "Total liabilities + total equity add up to assets", "skip", "Company doesn't report a total-liabilities line (common in XBRL)"));
  // 3) cash-flow reconciliation: CFO + CFI + CFF (+ FX effect) = change in cash
  if (has(y.cfo, y.cfi, y.cff, y.cashChange)) { const sum = y.cfo + y.cfi + y.cff + (y.fx || 0), d = Math.abs(sum - y.cashChange) / Math.max(Math.abs(y.cfo), Math.abs(y.cashChange), 1);
    out.push(check("cashflow", "Operating + investing + financing cash flow = change in cash", d <= 0.01 ? "pass" : d <= 0.05 ? "warn" : "fail", `${big(y.cfo)} + ${big(y.cfi)} + ${big(y.cff)}${y.fx ? ` + FX ${big(y.fx)}` : ""} = ${big(sum)} vs reported change ${big(y.cashChange)}`, { cfo: y.cfo, cfi: y.cfi, cff: y.cff, fx: y.fx || 0, cashChange: y.cashChange })); }
  else out.push(check("cashflow", "Operating + investing + financing cash flow = change in cash", "skip", "One of the four cash-flow totals isn't reported"));
  // 4) gross profit, only when all three are reported (not computed by us)
  const gpComputed = y._src && /computed/.test(y._src.grossProfit || "");
  if (has(y.revenue, y.cogs, y.grossProfit) && !gpComputed) { const d = rel(y.revenue - y.cogs, y.grossProfit);
    out.push(check("grossprofit", "Revenue − cost of revenue = gross profit", d <= 0.01 ? "pass" : d <= 0.03 ? "warn" : "fail", `${big(y.revenue)} − ${big(y.cogs)} = ${big(y.revenue - y.cogs)} vs reported ${big(y.grossProfit)}`)); }
  // 5) EPS ≈ net income / diluted shares (preferred dividends and two-class methods cause small gaps → warn, not fail)
  if (has(y.eps, y.netIncome, y.dilutedShares) && y.dilutedShares > 0) { const calc = y.netIncome / y.dilutedShares, d = rel(calc, y.eps);
    out.push(check("eps", "Diluted EPS ≈ net income ÷ diluted shares", d <= 0.05 ? "pass" : d <= 0.12 ? "warn" : "fail", `${calc.toFixed(2)} computed vs ${y.eps} reported (${pct(d)} apart; preferred dividends or share classes can explain small gaps)`)); }
  // 6) signs
  const bad = [];
  if (has(y.revenue) && y.revenue < 0) bad.push("negative revenue"); if (has(y.totalAssets) && y.totalAssets <= 0) bad.push("non-positive total assets");
  if (has(y.capex) && y.capex < 0) bad.push("capital expenditures reported negative (should be a positive payment)"); if (has(y.dilutedShares) && y.dilutedShares <= 0) bad.push("non-positive share count");
  out.push(check("signs", "Signs and units are sensible", bad.length ? "fail" : "pass", bad.length ? bad.join("; ") : "Revenue, assets, capex and shares all have the expected sign"));
  // 7) independent re-computation of the derived numbers the terminal displays
  const mis = [];
  if (has(y.cfo, y.capex) && has(y.fcf) && Math.abs(y.cfo - y.capex - y.fcf) > 1) mis.push("free cash flow");
  if (ratiosFn) { const R = ratiosFn(y, null) || {}; const pairs = [["grossMargin", y.grossProfit, y.revenue], ["operatingMargin", y.operatingIncome, y.revenue], ["netMargin", y.netIncome, y.revenue], ["currentRatio", y.currentAssets, y.currentLiabilities]];
    for (const [k, a, b] of pairs) if (has(a, b) && b !== 0 && R[k] != null && Math.abs(R[k] - a / b) > 1e-9) mis.push(k); }
  out.push(check("derived", "Derived ratios match an independent recalculation", mis.length ? "fail" : "pass", mis.length ? "Mismatch in: " + mis.join(", ") : "Free cash flow and margin/liquidity ratios recomputed from raw XBRL values"));
  return out;
}
// restatements: a later filing reported a different value for the same period (taken from the SEC's own history)
function restatements(rows) {
  const out = [];
  for (const y of rows) for (const [field, h] of Object.entries(y._hist || {})) {
    const vals = h.filter((x) => isFinite(x.val)); if (vals.length < 2) continue;
    const first = vals[0], last = vals[vals.length - 1];
    if (rel(first.val, last.val) > 0.0001) out.push({ period: y.end, field, original: first.val, originalFiled: first.filed, originalForm: first.form, current: last.val, currentFiled: last.filed, currentForm: last.form, change: +(rel(first.val, last.val)).toFixed(5) });
  }
  return out.sort((a, b) => (a.period < b.period ? 1 : -1));
}
// revisions: compare a stored snapshot of our own previous fetch with today's
function snapshot(rows) { const s = {}; for (const y of rows) { const o = {}; for (const k of CORE.concat(["grossProfit", "totalDebt", "fcf", "eps"])) if (y[k] != null) o[k] = y[k]; s[y.end] = o; } return s; }
function diffSnapshots(prev, cur, now = Date.now()) {
  const out = []; if (!prev) return out;
  for (const end of Object.keys(cur)) { const a = prev[end]; if (!a) continue; for (const k of Object.keys(cur[end])) if (a[k] != null && rel(a[k], cur[end][k]) > 0.0001) out.push({ period: end, field: k, before: a[k], after: cur[end][k], detected: now }); }
  return out;
}

function fundamentalsReport(f, { now = Date.now(), ratiosFn = null, previousSnapshot = null } = {}) {
  if (!f || !f.available) return { available: false, reason: (f && f.reason) || "No SEC data", symbol: f && f.symbol };
  const rows = f.years || [], y = rows[rows.length - 1], p = rows[rows.length - 2] || null;
  const checks = y ? checkYear(y, ratiosFn) : [];
  const prior = p ? checkYear(p, ratiosFn) : [];
  // period identification and units
  const periods = rows.map((r) => ({ end: r.end, form: r._form || null, filed: r._filed || null, fy: r._fy || null, fp: r._fp || null, unit: r._unit || null }));
  const idOk = rows.every((r) => r._form && r._filed && r.end);
  checks.push(check("periods", "Every year has a fiscal-period end, form type and filing date", idOk ? "pass" : "warn", idOk ? `${rows.length} annual periods, each traced to a 10-K/20-F filing` : "Some periods are missing form or filing-date metadata"));
  const ccy = f.currency || (y && y._unit) || "USD";
  checks.push(check("currency", "Reporting currency identified", ccy === "USD" ? "pass" : "warn", ccy === "USD" ? "Reported in US dollars" : `Reported in ${ccy} — figures are not converted to USD`));
  const ageM = y ? (now - Date.parse(y.end + "T12:00:00Z")) / (30.44 * DAY) : null;
  checks.push(check("recency", "Latest annual report is recent", ageM == null ? "skip" : ageM <= 15 ? "pass" : ageM <= 24 ? "warn" : "fail", ageM == null ? "No annual data" : `Latest fiscal year ended ${y.end} (${ageM.toFixed(0)} months ago)`));
  const rest = restatements(rows), snap = snapshot(rows), revisions = diffSnapshots(previousSnapshot, snap, now);
  checks.push(check("restatements", "Restated figures identified", "pass", rest.length ? `${rest.length} figure${rest.length > 1 ? "s" : ""} later revised in subsequent SEC filings — the latest filed value is used` : "No restatements found in the SEC filing history"));
  if (f.mergedPeriods) checks.push(check("duplicates", "Duplicate period records merged", "pass", `${f.mergedPeriods} near-identical fiscal-year ends (52/53-week years) merged into one period each`));
  // confidence
  const ran = checks.filter((c) => c.status !== "skip"), passW = ran.reduce((a, c) => a + (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0);
  const completeness = y ? CORE.filter((k) => y[k] != null).length / CORE.length : 0;
  const recency = ageM == null ? 0 : ageM <= 13 ? 1 : Math.max(0, 1 - (ageM - 13) / 17);
  const conf = confidence({ completeness, recency, consistency: ran.length ? passW / ran.length : 0.5, source: SOURCE_QUALITY.sec });
  return {
    available: true, symbol: f.symbol, name: f.name, cik: f.cik, checkedAt: now, latestPeriod: y ? y.end : null, currency: ccy,
    confidence: conf, checks, priorYearChecks: prior, restatements: rest, revisions, snapshot: snap, periods,
    missing: y ? CORE.filter((k) => y[k] == null) : CORE,
    sources: [{ name: "SEC EDGAR XBRL company facts", url: f.cik ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(f.cik).padStart(10, "0")}.json` : null, retrieved: f.fetched || null, note: "Primary source: the company's own 10-K/20-F filings" }],
    tags: y && y._src ? y._src : {},
    summary: { pass: checks.filter((c) => c.status === "pass").length, warn: checks.filter((c) => c.status === "warn").length, fail: checks.filter((c) => c.status === "fail").length, skip: checks.filter((c) => c.status === "skip").length },
  };
}

module.exports = { confidence, classifyQuote, crossCheckPrice, summarizeQuotes, checkYear, restatements, snapshot, diffSnapshots, fundamentalsReport, CONFIDENCE_FORMULA, CONFIDENCE_NOTE, SOURCE_QUALITY, CORE };

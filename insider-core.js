"use strict";
// Insider trades (SEC Form 4) → the signal the bots use. Pure functions, no network; used by web/spider.js and tested
// in tests/insider-core.test.js. Guards against the usual ways insider data gives a confident wrong answer:
//  1. only open-market trades count: code P (purchase) and S (sale). Grants, option exercises and shares withheld
//     for tax (A, M, F, …) are not buying or selling decisions.
//  2. trades under a pre-set 10b5-1 plan carry little signal: left out of both buys and sells, and counted.
//  3. amendments (Form 4/A) restate trades already filed: the same owner, day, code, shares and price count once.
//  4. impossible amounts (a misread price) are flagged: their share counts stay, their dollars stay out of totals.
//  5. a window the scan didn't fully reach is reported as partial, never as a complete total.
// The window is on the trade date (when it happened), not the filing date (when it reached the SEC).

const DAY = 864e5;
const ok = (x) => Number.isFinite(x);
const median = (a) => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

// filings: [{ filed, owner, role, officer, url, tx: [{ date, code, shares, price, value, plan10b51 }] }], newest first
// opts: { now, days = 90, oldestFiled (the oldest filing date the scan read), complete (scan reached the window start) }
function summarize(filings, { now = Date.now(), days = 90, complete = true } = {}) {
  const since = now - days * DAY, seen = new Set(), tx = [];
  let dupes = 0, planBuys = 0, planSells = 0, other = 0;
  for (const f of filings || []) for (const t of f.tx || []) {
    const at = Date.parse(t.date);
    if (!ok(at) || at < since) continue;
    if (t.code !== "P" && t.code !== "S") { other++; continue; }
    const key = [String(f.owner || "").toUpperCase(), t.date, t.code, +t.shares, +t.price].join("|");
    if (seen.has(key)) { dupes++; continue; }
    seen.add(key);
    if (t.plan10b51) { if (t.code === "P") planBuys++; else planSells++; continue; }
    tx.push({ ...t, owner: f.owner, role: f.role, officer: f.officer, url: f.url, filed: f.filed });
  }
  // a price far from the other open-market prices in the same window is almost always a misread field
  const mid = median(tx.map((t) => t.price).filter((p) => p > 0));
  for (const t of tx) t.amountSuspect = !(t.price > 0) || (mid != null && tx.length >= 3 && (t.price > mid * 3 || t.price < mid / 3));
  const buys = tx.filter((t) => t.code === "P"), sells = tx.filter((t) => t.code === "S");
  const dollars = (L) => L.filter((t) => !t.amountSuspect).reduce((a, t) => a + (ok(t.value) ? t.value : 0), 0);
  const buyers = [...new Set(buys.map((t) => t.owner))];
  const notes = [];
  if (!complete) notes.push(`The scan didn't reach back the full ${days} days, so these totals may be incomplete.`);
  if (dupes) notes.push(`${dupes} trade${dupes > 1 ? "s" : ""} repeated in amended filings counted once.`);
  if (planBuys + planSells) notes.push(`${planBuys + planSells} trade${planBuys + planSells > 1 ? "s" : ""} under pre-set 10b5-1 plans left out (weak signal).`);
  const sus = tx.filter((t) => t.amountSuspect);
  if (sus.length) notes.push(`${sus.length} trade${sus.length > 1 ? "s have" : " has"} an implausible price, so ${sus.length > 1 ? "their" : "its"} dollar value is left out of the totals (shares kept).`);
  return { since, days, complete, buys, sells, buyers, buyValue: dollars(buys), sellValue: dollars(sells), buyShares: buys.reduce((a, t) => a + t.shares, 0), sellShares: sells.reduce((a, t) => a + t.shares, 0),
    dupes, planBuys, planSells, other, suspect: sus.length, notes };
}

// How far back to read: every Form 4 filed since the window start (trades are reported within days of happening),
// up to a hard cap. Returns the indexes to fetch and whether the window is fully covered.
function pickFilings(recent, { now = Date.now(), days = 90, slack = 30, cap = 60 } = {}) {
  const startDay = new Date(now - (days + slack) * DAY).toISOString().slice(0, 10), picks = [];
  let reached = false;
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== "4" && recent.form[i] !== "4/A") continue;
    if (recent.filingDate[i] < startDay) { reached = true; break; }
    if (picks.length >= cap) break;
    picks.push(i);
  }
  // filings are newest first; if no older filing exists at all, the company's whole Form 4 history was read
  if (!reached && picks.length < cap) reached = true;
  return { picks, complete: reached };
}

module.exports = { summarize, pickFilings };

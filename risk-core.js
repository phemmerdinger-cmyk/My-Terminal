// Market Desk — shared risk and research checks for the three paper traders (pure, no network; tested in tests/risk-core.test.js).
// The bots call these before acting; nothing here can be overridden by the AI/explanation layer.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RISK = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- data quality: market-wide "black swan" headlines ------------------------------------------------------------
  // Only headlines about the whole market count. "Helus Pharma stock tumbles 21%" is one company and must NOT trip
  // the market-crash rule (it did on 2026-11-16 and sent the swing bot into defense mode).
  const SWAN = [/circuit breakers?\b.*\b(trigger|halt|trip)|\b(trigger|halt|trip)\w*\b.*circuit breaker/i, /(market|trading)[- ]wide halt|exchange (halted|outage)/i, /flash crash/i,
    /bank run|run on (the )?banks?\b/i, /emergency (rate|interest[- ]rate) cut|emergency (fed|central bank) (meeting|action)/i, /sovereign default|(u\.s\.|us|government) debt default/i,
    /declares? war|invasion of|act of war/i, /nuclear (attack|strike|detonation)|martial law/i,
    /\b(stock market|stocks|markets|wall street|dow|s&p( 500)?|nasdaq)('s)? (worst (day|week|selloff|sell-off|crash) since (19\d\d|20[01]\d))/i,
    /\b(stock market|stocks|global markets|markets|wall street|dow( jones)?|s&p( 500)?|nasdaq)\b (crash|plunge|tumble|plummet|sink|dive)s?\b.{0,25}?\b([3-9]|\d{2,})(\.\d+)?%/i,
    /black swan/i];
  // A headline led by a single company ("<Name> stock/shares …") is never market-wide.
  const SINGLE = /^[A-Z][\w.&'-]*(\s+[A-Z][\w.&'-]*){0,4}\s+(\(\w+\)\s+)?(stock|shares)\b/;
  function isMarketSwan(title) {
    if (typeof title !== "string" || !title) return false;
    if (SINGLE.test(title.trim()) && !/^(Stock market|Stocks|Wall Street|Markets)\b/i.test(title.trim())) return false;
    return SWAN.some((re) => re.test(title));
  }

  // ---- data quality: stale quotes ----------------------------------------------------------------------------------
  // During the session, a quote whose last trade is older than maxAgeMs is stale: don't trade on it.
  function staleQuote(q, now, sessionOpen, maxAgeMs = 15 * 60e3) {
    if (!q || q.error || !(q.price > 0)) return true;
    if (!sessionOpen) return false;
    return !(q.marketTime > 0) || now - q.marketTime > maxAgeMs;
  }

  // ---- Alex's trade qualification rule ------------------------------------------------------------------------------
  // All in units of the stock's 1-minute average range (ATR). expected gross advantage − round-trip costs
  // (spread + slippage + fees, both sides) − short borrow − an uncertainty buffer (a share of the costs) must be > 0.
  function netEdge({ mu, atrPct, costPerSide, borrow = 0, short = false, bufferX = 0.5 }) {
    if (!(atrPct > 0)) return { ok: false, net: -Infinity, cost: Infinity, why: "no range estimate" };
    const cost = (2 * costPerSide + (short ? borrow : 0)) / atrPct, buffer = bufferX * cost, net = Math.abs(mu) - cost - buffer;
    return { ok: net > 0, net, cost, buffer };
  }

  // ---- daily loss limit -----------------------------------------------------------------------------------------------
  const dailyLossHit = (dayPnl, startEq, limit = 0.01) => startEq > 0 && dayPnl <= -limit * startEq;

  // ---- expectancy with uncertainty ----------------------------------------------------------------------------------
  // From aggregates (n, sum, sum of squares of net P&L per trade). Normal-approximation 95% interval for the mean.
  function expectancy(n, sum, sumSq) {
    if (!(n >= 2)) return { n: n || 0, mean: n ? sum / n : null, se: null, lo: null, hi: null, significant: false };
    const mean = sum / n, varS = Math.max(0, (sumSq - n * mean * mean) / (n - 1)), se = Math.sqrt(varS / n);
    return { n, mean, se, lo: mean - 1.96 * se, hi: mean + 1.96 * se, t: se > 0 ? mean / se : null, significant: se > 0 && Math.abs(mean / se) >= 1.96 };
  }
  // Same from a list of P&Ls.
  const expectancyOf = (pnls) => expectancy(pnls.length, pnls.reduce((a, b) => a + b, 0), pnls.reduce((a, b) => a + b * b, 0));

  // ---- swing holding discipline ---------------------------------------------------------------------------------------
  // A swing position (2–30 trading days) may only be sold or swapped for a lower ranking at the day's opening re-score,
  // and only after it has been held at least minDays calendar days. Safety exits (stops, misses, bad news) are separate.
  function rankExitAllowed(heldMs, opening, minDays = 2) { return !!opening && heldMs >= minDays * 864e5; }

  // ---- strategy registry ------------------------------------------------------------------------------------------------
  // A run belongs to exactly one strategy version. If the code's version differs from the stored run's, the old run must
  // be archived (never edited) and a new run started.
  const versionChanged = (stored, current) => !stored || stored.id !== current.id || stored.version !== current.version;

  // ---- data gaps (server asleep / feed outage) -------------------------------------------------------------------------
  // Minutes between the last processed bar and the next one. Above maxGapMin the bars in between can't be trusted to
  // replay (they weren't seen live), so open intraday positions are closed at the first bar after the gap — not managed
  // as if every minute had been watched.
  const gapMinutes = (lastT, nextT) => (lastT > 0 && nextT > lastT ? Math.round((nextT - lastT) / 60) : 0);

  return { isMarketSwan, staleQuote, netEdge, dailyLossHit, expectancy, expectancyOf, rankExitAllowed, versionChanged, gapMinutes, SWAN };
});

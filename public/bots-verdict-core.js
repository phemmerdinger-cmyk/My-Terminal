(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MDBotsVerdict = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Plain-English summary of the bots-vs-S&P race for a casual reader.
  // Every bot is compared with the S&P 500 over ITS OWN dates (its run start → now),
  // which is why each bot shows a different S&P number.
  const EARLY_DAYS = 20;

  const num = (x) => typeof x === "number" && Number.isFinite(x);
  const pts = (x) => Math.abs(x * 100).toFixed(2) + " pts";
  const signed = (x) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x * 100).toFixed(2) + "%";

  function fmtDate(t) {
    if (!num(t)) return null;
    return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  }

  // One bot's race: its return, the S&P's return over the same dates, and the gap.
  function botRace(name, d) {
    if (!d || !num(d.value) || !num(d.startValue) || d.startValue <= 0) return null;
    const started = num(d.firstTrade);
    const ret = d.value / d.startValue - 1;
    const spx = num(d.spx0) && num(d.spxNow) && d.spx0 > 0 ? d.spxNow / d.spx0 - 1 : null;
    const days = Array.isArray(d.equity) ? d.equity.filter((p) => p && num(p.v)).length : 0;
    return { name, started, ret, spx, gap: spx == null ? null : ret - spx, since: fmtDate(d.firstTrade), days };
  }

  // Headline words for the big "who's ahead" box. `lead` is in dollars (bot minus S&P).
  function leadText(ret, lead, name) {
    if (!num(lead)) return "vs. the S&P 500";
    return lead >= 0 ? "Ahead of the S&P" : "Behind the S&P";
  }

  function raceLine(r) {
    if (!r.started) return r.name + ": hasn't made its first trade yet.";
    const spx = r.spx == null ? "S&P unavailable" : "S&P " + signed(r.spx);
    const gap = r.gap == null ? "" : r.gap >= 0 ? " → " + pts(r.gap) + " ahead" : " → " + pts(r.gap) + " behind";
    return r.name + ": " + signed(r.ret) + " vs. " + spx + (r.since ? " since " + r.since : "") + gap;
  }

  function summarize(entries) {
    const races = (entries || []).map(([name, d]) => botRace(name, d)).filter(Boolean);
    const live = races.filter((r) => r.started && r.gap != null);
    if (!live.length) {
      return { headline: "The race hasn't started yet — the bots make their first trades at the opening bell.", lines: races.map(raceLine), early: true, days: 0 };
    }
    const n = live.length, up = live.filter((r) => r.ret > 0).length, beat = live.filter((r) => r.gap > 0).length;
    const all = (k) => (k === n ? (n === 1 ? "The bot" : n === 2 ? "Both accounts" : "All " + n + " accounts") : k + " of " + n);
    const money = up === 0 ? all(n) + " " + (n === 1 ? "is" : "are") + " down" : up === n ? all(n) + " " + (n === 1 ? "is" : "are") + " up" : up + " of " + n + (up === 1 ? " is" : " are") + " up";
    const vs = beat === 0 ? "none is beating the S&P 500 over the same dates"
      : beat === n ? (n === 1 ? "it's ahead of" : "all are ahead of") + " the S&P 500 over the same dates"
      : beat + " of " + n + " " + (beat === 1 ? "is" : "are") + " ahead of the S&P 500 over the same dates";
    const days = Math.max(...live.map((r) => r.days));
    const early = days < EARLY_DAYS;
    const headline = money + " since " + (n === 1 ? "it" : "they") + " started; " + vs + ".";
    const note = early
      ? "Too early to call: the longest-running bot has " + days + " trading day" + (days === 1 ? "" : "s") + " of results. Short records swing a lot — give it at least " + EARLY_DAYS + " trading days."
      : "Based on " + days + " trading days. Paper money and modeled costs — past results don't predict future ones.";
    return { headline, note, lines: races.map(raceLine), early, days };
  }

  return { summarize, botRace, leadText, EARLY_DAYS };
});

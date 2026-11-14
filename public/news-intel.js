/* Market Desk · free, transparent personalization for the existing News reader.
 * No external requests, AI calls or trading signals. Scores mean RELEVANCE, not expected returns.
 * UMD so the very same implementation can be tested by Node's built-in test runner. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDNewsIntel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const HOUR = 3600000;
  const uniq = (values) => [...new Set(values.filter(Boolean))];
  const ticker = (v) => String(v || "").trim().toUpperCase();
  const tickerList = (values) => uniq((Array.isArray(values) ? values : []).map(ticker));
  function titleWords(title) {
    return String(title || "").toLowerCase()
      .replace(/\s+[-–|]\s+[^-–|]{2,45}$/, "")
      .replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !/^(the|and|for|with|from|after|amid|into|says|said|are|has|have|will|that|this|stock|shares)$/.test(w));
  }
  function contextOf(context) {
    const c = context || {}, held = new Set(), watched = new Set(tickerList(c.watchlist));
    for (const pf of Array.isArray(c.portfolios) ? c.portfolios : []) {
      for (const h of Array.isArray(pf.holdings) ? pf.holdings : []) {
        if (+h.shares > 0 && h.symbol) held.add(ticker(h.symbol));
      }
    }
    for (const h of Array.isArray(c.holdings) ? c.holdings : []) {
      if (+h.shares > 0 && h.symbol) held.add(ticker(h.symbol));
    }
    return { held, watched, now: Number.isFinite(c.now) ? c.now : Date.now() };
  }
  function explain(article, context) {
    const c = contextOf(context), t = tickerList(article && article.tickers);
    const owned = t.filter((x) => c.held.has(x));
    const watched = t.filter((x) => !c.held.has(x) && c.watched.has(x));
    const sources = uniq([article && article.source, ...((article && article.also) || []).map((s) => s.source)]);
    const ageMs = Number.isFinite(article && article.time) ? Math.max(0, c.now - article.time) : null;
    let score = 0;
    const reasons = [];
    if (owned.length) { score += 100 + Math.min(25, (owned.length - 1) * 8); reasons.push("You hold " + owned.join(", ")); }
    if (watched.length) { score += 45 + Math.min(12, (watched.length - 1) * 4); reasons.push("On your watchlist: " + watched.join(", ")); }
    if (article && article.source === "official") { score += 15; reasons.push("Official primary source"); }
    if (sources.length > 1) { score += Math.min(18, (sources.length - 1) * 5); reasons.push(sources.length + " sources covering the story"); }
    if (ageMs !== null) {
      const hours = ageMs / HOUR;
      if (hours <= 6) score += 12;
      else if (hours <= 24) score += 7;
      else if (hours <= 72) score += 3;
    }
    if (article && (article._bs || article._top)) score += 8;
    const level = owned.length ? "Holding" : watched.length ? "Watchlist" : article && article.source === "official" ? "Official" : "General";
    if (!reasons.length) reasons.push("General market coverage");
    return { score, level, owned, watched, sources: sources.length, reasons, ageHours: ageMs === null ? null : ageMs / HOUR };
  }
  function sameStory(a, b) {
    if (!a || !b || !a.title || !b.title) return false;
    if (!Number.isFinite(a.time) || !Number.isFinite(b.time) || Math.abs(a.time - b.time) > 36 * HOUR) return false;
    const ta = tickerList(a.tickers), tb = tickerList(b.tickers);
    if (ta.length && tb.length && !ta.some((x) => tb.includes(x))) return false;
    const aw = new Set(titleWords(a.title)), bw = new Set(titleWords(b.title));
    if (Math.min(aw.size, bw.size) < 4) return false;
    let overlap = 0; for (const w of aw) if (bw.has(w)) overlap++;
    return overlap >= 4 && overlap / Math.min(aw.size, bw.size) >= 0.85;
  }
  function prioritize(articles, context, limit = 300) {
    if (!Array.isArray(articles)) return [];
    const ranked = articles.filter((a) => a && a.title).map((a) => ({
      ...a, _priority: explain(a, context),
      also: Array.isArray(a.also) ? a.also.slice() : []
    })).sort((a, b) => b._priority.score - a._priority.score || (b.time || 0) - (a.time || 0));
    const out = [];
    for (const item of ranked) {
      const matched = out.find((prior) => sameStory(prior, item));
      if (!matched) { out.push(item); continue; }
      const known = new Set([matched.source, ...matched.also.map((s) => s.source)]);
      for (const s of [{ source: item.source, link: item.link }, ...item.also]) {
        if (s && s.source && !known.has(s.source)) { matched.also.push(s); known.add(s.source); }
      }
      matched.tickers = uniq([...tickerList(matched.tickers), ...tickerList(item.tickers)]);
      if (!matched.summary && item.summary) matched.summary = item.summary;
      matched._priority = explain(matched, context);
    }
    return out.sort((a, b) => b._priority.score - a._priority.score || (b.time || 0) - (a.time || 0))
      .slice(0, Math.max(0, Math.min(500, Number(limit) || 300)));
  }
  return { explain, prioritize, sameStory };
});

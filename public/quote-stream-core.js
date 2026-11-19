(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MDQuoteStream = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const positive = (value) => Number.isFinite(value) && value > 0;
  const inSession = (time, session) => positive(session?.start) && positive(session?.end) &&
    time >= session.start && time < session.end;

  function withTrade(quote, price, marketTime) {
    const change = positive(quote.prevClose) ? price - quote.prevClose : null;
    const changePct = change === null ? null : (change / quote.prevClose) * 100;
    const next = {
      ...quote, price, marketTime, change,
      changePct: Number.isFinite(changePct) ? changePct : null,
      dayHigh: positive(quote.dayHigh) ? Math.max(quote.dayHigh, price) : price,
      dayLow: positive(quote.dayLow) ? Math.min(quote.dayLow, price) : price,
      streamed: true,
    };
    if (Array.isArray(quote.spark) && quote.spark.length) {
      next.spark = quote.spark.slice();
      next.spark[next.spark.length - 1] = price;
    }
    if (next.status === "awaiting-market-print") delete next.status;
    return next;
  }

  function applyTrade(quote, tick, now = Date.now()) {
    if (!quote || quote.error || !positive(tick?.p) || !positive(tick?.t) || !positive(now) || tick.t > now ||
        (Object.hasOwn(tick, "v") && !positive(tick.v)) ||
        (Object.hasOwn(tick, "volume") && !positive(tick.volume)) ||
        (positive(quote.marketTime) && tick.t < quote.marketTime)) return quote;
    const session = quote.regularSession;
    if (session != null && !inSession(tick.t, session)) return quote;
    if (quote.status === "awaiting-market-print" && !inSession(now, session)) return quote;
    return withTrade(quote, tick.p, tick.t);
  }

  function mergeQuote(current, incoming) {
    if (!incoming || incoming.error) return current || incoming;
    if (!current?.streamed || current.error || !positive(current.price) || !positive(current.marketTime) ||
        (positive(incoming.marketTime) && current.marketTime <= incoming.marketTime) ||
        (incoming.regularSession != null && !inSession(current.marketTime, incoming.regularSession))) return incoming;

    const highs = [current.dayHigh, incoming.dayHigh].filter(positive);
    const lows = [current.dayLow, incoming.dayLow].filter(positive);
    const spark = Array.isArray(incoming.spark) && incoming.spark.length ? incoming.spark : current.spark;
    return withTrade({ ...incoming, dayHigh: Math.max(...highs), dayLow: Math.min(...lows), spark },
      current.price, current.marketTime);
  }

  return { applyTrade, mergeQuote };
});

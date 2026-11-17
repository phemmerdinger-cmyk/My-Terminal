// Quote-based paper fills. A trade print is a reference, so the model adds
// an adverse half-spread and slippage assumption where bid/ask is unavailable.
const MAX_QUOTE_AGE = 3 * 60_000;

function usableQuote(quote, now, after = 0, maxAge = MAX_QUOTE_AGE) {
  return !!quote && !quote.error && Number.isFinite(quote.price) && quote.price > 0 &&
    Number.isFinite(quote.marketTime) && quote.marketTime > after && quote.marketTime <= now &&
    now - quote.marketTime <= maxAge;
}

function paperFill(side, price, costRate) {
  return price * (1 + (side === "BUY" ? costRate : -costRate));
}

function completedCloses(candles, session, sessionOf) {
  return candles.filter((bar) => Number.isFinite(bar.time) &&
    Number.isFinite(bar.close) && bar.close > 0 && sessionOf(bar.time) < session)
    .map((bar) => bar.close);
}

module.exports = { MAX_QUOTE_AGE, usableQuote, paperFill, completedCloses };

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MDPortfolioPreview = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const positive = (value) => Number.isFinite(value) && value > 0;

  function copyPortfolio(portfolio) {
    if (!portfolio || !Array.isArray(portfolio.holdings)) throw new TypeError("A portfolio with holdings is required.");
    return { portfolioId: portfolio.id, name: portfolio.name, holdings: structuredClone(portfolio.holdings) };
  }

  function previewPortfolioChange(portfolio, rows, { now = Date.now() } = {}) {
    if (!Array.isArray(rows) || !Number.isFinite(now) || now < 0) throw new TypeError("Valid holdings rows and preview time are required.");
    const preview = copyPortfolio(portfolio);
    const changes = [];
    let totalAmount = 0;

    for (const row of rows) {
      const symbol = typeof row?.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
      const { amount, cost } = row || {};
      if (!/^[A-Z0-9.\-^=]{1,12}$/.test(symbol) || !/[A-Z0-9]/.test(symbol)) throw new TypeError("Enter a valid ticker.");
      if (!positive(amount) || !positive(cost)) throw new RangeError(`Enter a positive amount and price for ${symbol}.`);

      const existing = preview.holdings.find((holding) => holding?.symbol === symbol);
      const shares = amount / cost;
      const sharesAdded = existing ? shares : Number(shares.toFixed(6));
      const sharesBefore = existing?.shares ?? 0;
      const sharesAfter = sharesBefore + sharesAdded;
      if (!positive(sharesAdded) || !positive(sharesAfter) || sharesAfter <= sharesBefore) {
        throw new RangeError(`The amount for ${symbol} is outside the supported share precision.`);
      }

      let costBasis;
      if (existing) {
        if (!positive(existing.shares) || !positive(existing.cost)) throw new RangeError(`The existing holding for ${symbol} has an invalid cost basis.`);
        costBasis = (existing.cost * sharesBefore + cost * sharesAdded) / sharesAfter;
        existing.shares = sharesAfter;
        existing.cost = costBasis;
      } else {
        costBasis = Number(cost.toFixed(4));
        preview.holdings.push({ symbol, shares: sharesAfter, cost: costBasis, added: now });
      }

      totalAmount += amount;
      if (!positive(costBasis) || !Number.isFinite(totalAmount)) throw new RangeError(`The cost for ${symbol} is outside the supported precision.`);
      changes.push({ symbol, sharesAdded, sharesBefore, sharesAfter, cost, costBasis });
    }

    return { ...preview, changes, totalAmount };
  }

  function previewHoldingRemoval(portfolio, index) {
    const preview = copyPortfolio(portfolio);
    if (!Number.isInteger(index) || index < 0 || index >= preview.holdings.length) throw new RangeError("The holding to remove no longer exists.");
    const [removed] = preview.holdings.splice(index, 1);
    return { ...preview, removed };
  }

  return { previewPortfolioChange, previewHoldingRemoval };
});

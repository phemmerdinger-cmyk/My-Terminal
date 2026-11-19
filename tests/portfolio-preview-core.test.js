"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { previewPortfolioChange, previewHoldingRemoval } = require("../public/portfolio-preview-core.js");

const base = () => ({ id: "p1", name: "Portfolio 1", holdings: [
  { symbol: "AAPL", shares: 2, cost: 100, added: 123, metadata: { tag: "imported" } },
  { symbol: "SPY", shares: 1, cost: 400, added: 456 },
] });

test("portfolio previews calculate weighted basis on a detached copy", () => {
  const portfolio = base();
  const preview = previewPortfolioChange(portfolio, [{ symbol: " aapl ", amount: 150, cost: 150 }], { now: 1_000 });
  assert.equal(preview.portfolioId, "p1");
  assert.equal(preview.name, "Portfolio 1");
  assert.equal(preview.totalAmount, 150);
  assert.deepEqual(preview.changes, [{ symbol: "AAPL", sharesAdded: 1, sharesBefore: 2,
    sharesAfter: 3, cost: 150, costBasis: 350 / 3 }]);
  assert.deepEqual(preview.holdings[0], { symbol: "AAPL", shares: 3, cost: 350 / 3, added: 123, metadata: { tag: "imported" } });
  assert.deepEqual(preview.holdings[1], portfolio.holdings[1]);
  preview.holdings[0].metadata.tag = "changed";
  assert.deepEqual(portfolio, base());
});

test("new holdings preserve share and cost precision and accept blank portfolios", () => {
  const portfolio = { id: "p2", name: "", holdings: [] };
  const row = { symbol: "BRK-B", amount: 12.34, cost: 512.34567 };
  const preview = previewPortfolioChange(portfolio, [row], { now: 2_000 });
  assert.deepEqual(preview.holdings, [{ symbol: "BRK-B", shares: 0.024085, cost: 512.3457, added: 2_000 }]);
  assert.equal(preview.changes[0].sharesBefore, 0);
  assert.equal(preview.changes[0].cost, 512.34567);
  assert.equal(preview.totalAmount, 12.34);
  assert.deepEqual(previewPortfolioChange(portfolio, []).holdings, []);
  assert.deepEqual(portfolio.holdings, []);
});

test("multiple rows for one symbol build one holding in input order", () => {
  const portfolio = { id: "p3", name: "Draft", holdings: [] };
  const preview = previewPortfolioChange(portfolio, [
    { symbol: "MSFT", amount: 100, cost: 100 }, { symbol: " msft ", amount: 200, cost: 200 },
  ], { now: 3_000 });
  assert.deepEqual(preview.holdings, [{ symbol: "MSFT", shares: 2, cost: 150, added: 3_000 }]);
  assert.equal(preview.totalAmount, 300);
  assert.deepEqual(preview.changes.map(({ sharesBefore, sharesAfter }) => [sharesBefore, sharesAfter]), [[0, 1], [1, 2]]);
});

test("a bad row rejects the entire operation and leaves the source unchanged", () => {
  const portfolio = base();
  const valid = { symbol: "AAPL", amount: 10, cost: 100 };
  for (const invalid of [{ ...valid, amount: Infinity }, { ...valid, amount: "10" }, { ...valid, cost: NaN },
    { ...valid, cost: 0 }, { ...valid, symbol: "!!" }, { ...valid, symbol: "SPY", amount: 1e-42 },
    { ...valid, symbol: "MSFT", amount: 0.00000001 }, { ...valid, symbol: "MSFT", cost: 0.000001 }]) {
    assert.throws(() => previewPortfolioChange(portfolio, [valid, invalid]));
    assert.deepEqual(portfolio, base());
  }
});

test("holding removal previews the selected row and preserves the original portfolio", () => {
  const portfolio = base();
  const preview = previewHoldingRemoval(portfolio, 0);
  assert.equal(preview.portfolioId, "p1");
  assert.deepEqual(preview.removed, portfolio.holdings[0]);
  assert.deepEqual(preview.holdings, [portfolio.holdings[1]]);
  assert.deepEqual(portfolio, base());
  assert.throws(() => previewHoldingRemoval(portfolio, -1), /no longer exists/);
  assert.throws(() => previewHoldingRemoval(portfolio, 2), /no longer exists/);
});

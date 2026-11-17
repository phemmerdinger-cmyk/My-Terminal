const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../ratio-core.js");
const near = (a, b, e = 1e-4) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

test("DuPont matches the Unit 6 Sage Inc. workbook (2016 column F)", () => {
  const r = R.compute({ revenue: 215600, netIncome: 9394, totalAssets: 95298, equity: 45935 });
  const d = r.profitability.dupont;
  near(d.netMargin, 9394 / 215600); near(d.assetTurnover, 215600 / 95298); near(d.equityMultiplier, 95298 / 45935);
  near(d.roa, (9394 / 215600) * (215600 / 95298));
  near(d.roe, 9394 / 45935); // the three-step product equals NI / equity, as the workbook's check row shows
  near(r.profitability.roe, 0.2045, 1e-4);
});

test("Unit 7 leverage ratios (total liabilities as 'total debt')", () => {
  const r = R.compute({ totalAssets: 15374.6, totalLiabilities: 8296.3, equity: 7078.3, ltDebt: 5630.4 });
  near(r.leverage.debtToEquity, 8296.3 / 7078.3); near(r.leverage.debtToAssets, 8296.3 / 15374.6);
  near(r.leverage.assetsToEquity, 15374.6 / 7078.3); near(r.leverage.ltDebtToCapital, 5630.4 / (5630.4 + 7078.3));
  // liabilities missing → assets − equity
  near(R.compute({ totalAssets: 100, equity: 40 }).leverage.debtToAssets, 0.6);
  assert.equal(R.compute({ totalAssets: 100, equity: -5, totalLiabilities: 105 }).leverage.debtToEquity, null);
});

test("Unit 8 efficiency uses average balances; CCC = DIO + DSO − DPO", () => {
  const y = { revenue: 3600, cogs: 1800, receivables: 689.7, inventory: 1293.5, payables: 160.6, totalAssets: 15374.6 };
  const p = { receivables: 1143.7, inventory: 1316, payables: 213, totalAssets: 15873.2 };
  const e = R.compute(y, p).efficiency;
  near(e.receivablesTurnover, 3600 / ((689.7 + 1143.7) / 2)); near(e.inventoryTurnover, 1800 / ((1293.5 + 1316) / 2));
  near(e.assetTurnover, 3600 / ((15374.6 + 15873.2) / 2));
  near(e.ccc, e.dio + e.dso - e.dpo); near(e.dpo, (365 * (160.6 + 213) / 2) / 1800);
});

test("Unit 9 valuation needs a price; negative earnings give no P/E", () => {
  const y = { revenue: 1000, netIncome: 100, eps: 2, equity: 500, cfo: 150, operatingIncome: 160, da: 40, totalDebt: 300, cash: 100, dividends: -30 };
  const v = R.compute(y, { eps: 1.6 }, { price: 40, shares: 50 }).valuation; // market cap 2,000
  near(v.pe, 20); near(v.ps, 2); near(v.pb, 4); near(v.pcf, 2000 / 150);
  near(v.peg, 20 / 25); // EPS grew 25%
  near(v.evEbitda, (2000 + 300 - 100) / 200); near(v.dividendYield, 30 / 2000);
  assert.equal(R.compute({ eps: -1 }, {}, { price: 10, shares: 5 }).valuation.pe, null);
  assert.equal(R.compute(y, {}, {}).valuation.pe, null);
});

test("score: compared to peers AND to last year; better ratios score higher, cheap beats expensive", () => {
  const mk = (i) => ({ sym: "S" + i, now: R.compute({ revenue: 1000, grossProfit: 300 + i * 20, operatingIncome: 100 + i * 10, netIncome: 50 + i * 8, totalAssets: 2000, equity: 1000, totalLiabilities: 1000 + i * 30 }, {}, {}), prev: null });
  const items = Array.from({ length: 10 }, (_, i) => mk(i));
  const s = R.score(items);
  assert.ok(s.S9.families.profitability > s.S0.families.profitability);
  assert.ok(s.S9.families.leverage < s.S0.families.leverage); // S9 carries the most debt
  assert.ok(s.S9.best.length && /top/.test(s.S9.best[0]));
  // too few peers → no score rather than a misleading one
  assert.equal(R.score(items.slice(0, 3)).S0.score, null);
  // improving on last year adds to the score
  const a = { ...items[5], prev: R.compute({ revenue: 1000, grossProfit: 300, operatingIncome: 100, netIncome: 50, totalAssets: 2000, equity: 1000, totalLiabilities: 1150 }) };
  const s2 = R.score([...items.slice(0, 5), a, ...items.slice(6)]);
  assert.ok(s2.S5.families.profitability > s.S5.families.profitability);
});

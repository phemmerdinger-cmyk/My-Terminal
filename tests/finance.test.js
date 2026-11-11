// Checks the financial formulas in public/fin.js against hand-worked answers.
const { test } = require("node:test");
const assert = require("node:assert");
const F = require("../public/fin.js");
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

test("DCF: a no-growth company is worth its cash flow ÷ WACC", () => {
  // UFCF = 100 × 20% × (1 − 25%) + 5 − 5 − 0 = 15 every year; at 10% with 0% terminal growth EV = 15 / 0.10 = 150
  const r = F.dcf({ revenue: 100, growth: 0, operatingMargin: 0.2, taxRate: 0.25, daPct: 0.05, capexPct: 0.05, nwcPct: 0.1, wacc: 0.1, terminalGrowth: 0, debt: 20, cash: 10, shares: 10, price: 10 });
  r.rows.forEach((x) => close(x.ufcf, 15));
  close(r.sumPv, 15 * (1 - 1.1 ** -5) / 0.1);
  close(r.terminalValue, 150);
  close(r.enterpriseValue, 150);
  close(r.equityValue, 140); // 150 − 20 debt + 10 cash
  close(r.perShare, 14);
  close(r.upside, 0.4);
});
test("DCF: growth, working capital and terminal growth follow the formulas", () => {
  const a = { revenue: 1000, growth: [0.1, 0.1, 0.05, 0.05, 0.03], operatingMargin: 0.25, taxRate: 0.21, daPct: 0.04, capexPct: 0.06, nwcPct: 0.1, wacc: 0.09, terminalGrowth: 0.025, debt: 0, cash: 0, shares: 1 };
  const r = F.dcf(a);
  close(r.rows[0].revenue, 1100);
  close(r.rows[0].dNwc, 10); // 10% of the 100 revenue increase
  close(r.rows[0].ufcf, 1100 * 0.25 * 0.79 + 44 - 66 - 10);
  const last = r.rows[4];
  close(r.terminalValue, last.ufcf * 1.025 / (0.09 - 0.025));
  close(r.pvTerminal, r.terminalValue / 1.09 ** 5);
  close(r.enterpriseValue, r.rows.reduce((s, x) => s + x.ufcf / 1.09 ** x.t, 0) + r.pvTerminal);
  assert.ok(F.dcf({ ...a, wacc: 0.02 }).error, "WACC below terminal growth is rejected");
});
test("Sensitivity: value falls as WACC rises and rises with terminal growth", () => {
  const base = { revenue: 500, growth: 0.05, operatingMargin: 0.2, taxRate: 0.2, daPct: 0.03, capexPct: 0.04, nwcPct: 0.05, debt: 50, cash: 20, shares: 10 };
  const t = F.sensitivity(base, [0.08, 0.09, 0.1], [0.02, 0.03]);
  assert.ok(t[0][0] > t[0][1] && t[0][1] > t[0][2]);
  assert.ok(t[1][0] > t[0][0]);
});
test("WACC: CAPM cost of equity and weights", () => {
  const w = F.wacc({ riskFree: 0.04, beta: 1.2, erp: 0.05, costOfDebt: 0.05, taxRate: 0.2, equityValue: 800, debtValue: 200 });
  close(w.costOfEquity, 0.1);
  close(w.wacc, 0.8 * 0.1 + 0.2 * 0.05 * 0.8);
});
test("Ratios from one year of statements", () => {
  const prev = { revenue: 80, equity: 90, totalAssets: 190 };
  const y = { revenue: 100, grossProfit: 40, operatingIncome: 20, netIncome: 15, pretaxIncome: 20, incomeTax: 4, currentAssets: 60, inventory: 10, currentLiabilities: 40, totalDebt: 30, equity: 110, totalAssets: 210, cash: 20, fcf: 12 };
  const r = F.ratios(y, prev);
  close(r.revenueGrowth, 0.25); close(r.grossMargin, 0.4); close(r.operatingMargin, 0.2); close(r.netMargin, 0.15);
  close(r.currentRatio, 1.5); close(r.quickRatio, 1.25); close(r.debtToEquity, 30 / 110);
  close(r.roe, 15 / 100); close(r.roa, 15 / 200); close(r.effectiveTaxRate, 0.2);
  close(r.roic, (20 * 0.8) / (110 + 30 - 20));
});
test("Beta, correlation, drawdown and VaR", () => {
  const m = [0.01, -0.02, 0.015, 0.003, -0.01, 0.02, -0.005, 0.007, 0.012, -0.018, 0.004];
  close(F.beta(m.map((x) => 2 * x), m), 2);
  close(F.correlation(m, m.map((x) => -x)), -1);
  const d = F.maxDrawdown([100, 120, 90, 130, 65, 70]);
  close(d.maxDrawdown, 65 / 130 - 1); assert.equal(d.from, 3); assert.equal(d.to, 4);
  const rets = Array.from({ length: 100 }, (_, i) => (i - 50) / 1000); // −5.0% … +4.9%
  const v = F.varEs(rets, 0.95);
  close(v.var, 0.046); close(v.es, (0.05 + 0.049 + 0.048 + 0.047 + 0.046) / 5);
});
test("Backtest: buy-and-hold math, no look-ahead, benchmark alignment", () => {
  const day = 86400, t0 = Date.UTC(2020, 0, 1) / 1000;
  const mk = (arr) => arr.map((close, i) => ({ t: t0 + i * day * 30, close }));
  const series = { A: mk([10, 11, 12, 6, 12]), B: mk([20, 20, 20, 20, 20]) };
  const r = F.backtest({ series, weights: { A: 50, B: 50 }, initial: 1000, benchmark: mk([100, 100, 110, 99, 121]) });
  // 50 shares of A + 25 shares of B: values 1000, 1050, 1100, 800, 1100
  assert.deepEqual(r.values.map((x) => Math.round(x)), [1000, 1050, 1100, 800, 1100]);
  close(r.stats.totalReturn, 0.1);
  close(r.stats.maxDrawdown, 800 / 1100 - 1);
  assert.deepEqual(r.bench.map(Math.round), [1000, 1000, 1100, 990, 1210]);
  // changing a future price must not change any earlier value (no look-ahead)
  const r2 = F.backtest({ series: { ...series, A: mk([10, 11, 12, 6, 50]) }, weights: { A: 50, B: 50 }, initial: 1000 });
  assert.deepEqual(r2.values.slice(0, 4), r.values.slice(0, 4));
  // monthly rebalancing restores 50/50 after the first month
  const rb = F.backtest({ series, weights: { A: 1, B: 1 }, initial: 1000, rebalance: "monthly" });
  assert.equal(Math.round(rb.values[1]), 1050);
});

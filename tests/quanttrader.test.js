// Quant Trader rules: allocations respect the caps, the regime sets the equity share, orders only trade meaningful changes.
const test = require("node:test"), assert = require("node:assert/strict");
const Q = require("../quant-trader.js");
function market(kind, n = 400) {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const px = {}; const all = [...Q.QT_EQUITY, ...Q.QT_DEFENSIVE, Q.QT_CASH, "HYG"];
  for (const [k, s] of all.entries()) { let p = 100; const drift = kind === "crash" && !Q.QT_DEFENSIVE.includes(s) && s !== Q.QT_CASH ? -0.004 : 0.0004 + (k % 7) * 0.0001;
    px[s] = Array.from({ length: n }, (_, i) => (p *= Math.exp((i > n - 60 || kind !== "crash" ? drift : 0.0004) + 0.01 * (rnd() - 0.5) + 0.004 * Math.sin(i / 9 + k)))); }
  return px;
}
test("allocation sums to 100%, respects the 20% cap and the volatility target", () => {
  const D = Q.decide(market("up")), w = Object.values(D.w), tot = w.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(tot - 1) < 1e-6, "fully allocated incl. T-bills");
  for (const [s, v] of Object.entries(D.w)) if (Q.QT_EQUITY.includes(s)) assert.ok(v <= Q.QT_MAX_W + 1e-6, s + " over cap");
  assert.ok(D.vol <= Q.QT_VOL_TARGET + 1e-6);
  assert.equal(D.ranked.filter((x) => x.picked).length <= Q.QT_TOP, true);
});
test("a crash regime moves the book into the defensive sleeve", () => {
  const up = Q.decide(market("up")), dn = Q.decide(market("crash"));
  const eqShare = (D) => Object.entries(D.w).filter(([s]) => Q.QT_EQUITY.includes(s)).reduce((a, [, v]) => a + v, 0);
  assert.ok(eqShare(dn) < eqShare(up), `equity ${eqShare(dn)} vs ${eqShare(up)}`);
  assert.match(dn.regime, /Risk-off|Correction/);
});
test("orders skip small changes, always exit dropped names, and sell before buying", () => {
  const o = Q.orders({ AAA: 0.5, BBB: 0.505 }, { BBB: 50, CCC: 10 }, { AAA: 10, BBB: 10, CCC: 10 }, 1000);
  assert.deepEqual(o.map((x) => [x.sym, x.side]), [["CCC", "SELL"], ["AAA", "BUY"]]); // BBB 50% → 50.5% skipped
  assert.ok(Math.abs(o[1].shares - 50) < 1e-9);
});

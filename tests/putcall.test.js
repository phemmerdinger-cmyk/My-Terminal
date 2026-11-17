const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../putcall-core.js");

const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10);
const series = (vals) => vals.map((v, i) => ({ d: day(i), v }));
const flat = (n, v) => Array.from({ length: n }, () => v);

test("parseCboe reads the equity/total/index ratios from JSON or HTML", () => {
  const json = '{"ratios":[{"name":"TOTAL PUT/CALL RATIO","value":"0.76"},{"name":"INDEX PUT/CALL RATIO","value":"1.06"},{"name":"EQUITY PUT/CALL RATIO","value":"0.54"}]}';
  assert.deepEqual(P.parseCboe(json), { equity: 0.54, total: 0.76, index: 1.06 });
  const html = "<tr><td>TOTAL PUT/CALL RATIO</td><td>1.00</td></tr><tr><td>EQUITY PUT/CALL RATIO</td><td>0.86</td></tr>";
  assert.equal(P.parseCboe(html).equity, 0.86);
  assert.equal(P.parseCboe("<html>no data</html>"), null);
  assert.equal(P.parseCboe(null), null);
});

test("chainRatio sums put and call volume; null without enough calls", () => {
  const r = P.chainRatio([{ calls: [{ volume: 800 }, { volume: 400 }], puts: [{ volume: 600 }] }]);
  assert.equal(r.ratio, 0.5);
  assert.equal(P.chainRatio([{ calls: [{ volume: 10 }], puts: [] }]), null);
});

test("needs 10 days; never invents a reading", () => {
  const z = P.zweig(series(flat(9, 0.6)));
  assert.equal(z.ok, false);
});

test("contrarian direction: heavy PUT buying (crowd bearish) is BULLISH, heavy CALL buying (crowd bullish) is BEARISH", () => {
  const fear = P.zweig(series(flat(15, 0.9)));
  assert.ok(fear.score > 0, "lots of puts → positive (bullish) score");
  assert.match(fear.lean, /bullish/);
  const greed = P.zweig(series(flat(15, 0.42)));
  assert.ok(greed.score < 0, "lots of calls → negative (bearish) score");
  assert.match(greed.lean, /bearish/);
  assert.equal(P.zweig(series(flat(15, 0.6))).score, 0);
  assert.equal(fear.basis, "fixed bands");
});

test("percentile basis with history; reversal from extreme fear triggers BUY, from extreme greed SELL", () => {
  const base = Array.from({ length: 120 }, (_, i) => 0.6 + 0.05 * Math.sin(i / 5));
  const spike = [...base, ...flat(12, 1.1), 0.7, 0.65, 0.6, 0.6]; // put buying spikes, then fades
  const z = P.zweig(series(spike));
  assert.equal(z.basis, "percentile");
  assert.equal(z.signal, "BUY");
  assert.ok(z.score >= 0.6);
  const calls = [...base, ...flat(12, 0.35), 0.5, 0.55, 0.6, 0.6]; // call buying spikes, then fades
  const g = P.zweig(series(calls));
  assert.equal(g.signal, "SELL");
  assert.ok(g.score <= -0.6);
});

test("swing exposure tilt: buys fear in a downtrend, holds cash in euphoria, never overrides defense mode", () => {
  const fear = { ok: true, score: 0.8, ma10: 0.95 }, greed = { ok: true, score: -0.8, ma10: 0.42 };
  assert.ok(P.exposureTilt(0.8, fear, { riskOff: true }).exposure > 0.8);
  assert.ok(P.exposureTilt(0.99, greed, { riskOff: false }).exposure < 0.99);
  assert.equal(P.exposureTilt(0.5, fear, { stress: true, riskOff: true }).exposure, 0.5);
  assert.equal(P.exposureTilt(0.99, null, {}).exposure, 0.99);
});

test("quant split tilt and day-trader lean follow the contrarian sign", () => {
  const fear = { ok: true, score: 0.8 }, greed = { ok: true, score: -0.8 };
  assert.ok(P.splitTilt(0.7, fear, "Choppy / late-cycle").split > 0.7);
  assert.ok(P.splitTilt(0.7, greed, "Choppy / late-cycle").split < 0.7);
  assert.equal(P.splitTilt(0.1, fear, "Risk-off / high volatility").split, 0.1);
  assert.ok(P.marketLean(fear) > 0 && P.marketLean(greed) < 0);
});

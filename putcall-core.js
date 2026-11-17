// Market Desk — Zweig put/call ratio (pure functions, no network). Used by server.js for all three paper bots and by the tests.
//
// Martin Zweig (Winning on Wall Street, 1986) popularized reading the put/call ratio as a CONTRARIAN gauge of the crowd:
//   • lots of puts vs calls  → the crowd is bearish  → too many people already expect a fall → BULLISH for stocks
//   • few puts vs lots of calls → the crowd is bullish → everyone's already in              → BEARISH for stocks
// The daily ratio is noisy, so Zweig smoothed it (10-day average here, with a 20-day average as a slower check).
// The ratio's normal range drifts over the decades, so extremes are judged against the ratio's own recent history
// (percentile of the 10-day average over up to a year); with too little history, fixed bands for the CBOE equity ratio.
// A reversal (the average rolling back from an extreme) is the classic trigger: fear peaking = buy, greed peaking = sell.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PCC = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

  // Pull the ratios out of a CBOE daily-market-statistics response (the JSON feed or the HTML page — both carry
  // rows like "EQUITY PUT/CALL RATIO … 0.54"). Returns null when the equity ratio isn't there.
  function parseCboe(text) {
    if (typeof text !== "string" || !text) return null;
    const grab = (label) => {
      const re = new RegExp(label.replace(/\//g, "\\/") + "[^0-9]{0,120}?([0-9]+(?:\\.[0-9]+)?)", "i");
      const m = text.match(re); const v = m ? +m[1] : NaN;
      return isFinite(v) && v > 0 && v < 10 ? v : null;
    };
    const equity = grab("EQUITY PUT/CALL RATIO"), total = grab("TOTAL PUT/CALL RATIO"), index = grab("INDEX PUT/CALL RATIO");
    return equity == null ? null : { equity, total, index };
  }

  // Put/call ratio from option-chain volumes ({calls:[{volume}], puts:[{volume}]} per stock). Null without enough volume.
  function chainRatio(chains, minCalls = 1000) {
    let c = 0, p = 0;
    for (const ch of chains || []) {
      for (const o of (ch && ch.calls) || []) c += +o.volume || 0;
      for (const o of (ch && ch.puts) || []) p += +o.volume || 0;
    }
    return c >= minCalls ? { ratio: p / c, calls: c, puts: p } : null;
  }

  // Fixed bands for the 10-day average of the CBOE EQUITY put/call ratio (used only until ~3 months of history exist).
  const BANDS = { fearHi: 0.85, fear: 0.7, greed: 0.52, greedLo: 0.45 };
  const ZONES = [[0.9, "Extreme fear"], [0.7, "Fear"], [0.3, "Neutral"], [0.1, "Complacent"], [0, "Extreme complacency"]];

  // series: [{d: "YYYY-MM-DD", v: ratio}] oldest → newest (one per trading day).
  // Returns the Zweig reading: score −1…+1 where + = BULLISH for stocks (the crowd is too bearish).
  function zweig(series, opts = {}) {
    const s = (series || []).filter((x) => x && isFinite(x.v) && x.v > 0);
    const n10 = opts.n10 || 10, n20 = opts.n20 || 20, look = opts.lookback || 252, minRank = opts.minRank || 60;
    if (s.length < n10) return { ok: false, n: s.length, need: n10, why: `needs ${n10} trading days of put/call data (has ${s.length})` };
    const ma = []; // 10-day average at each day
    for (let i = n10 - 1; i < s.length; i++) ma.push({ d: s[i].d, v: avg(s.slice(i - n10 + 1, i + 1).map((x) => x.v)) });
    const last = s[s.length - 1], ma10 = ma[ma.length - 1].v, ma20 = s.length >= n20 ? avg(s.slice(-n20).map((x) => x.v)) : null;
    const hist = ma.slice(-look).map((x) => x.v);
    let basis, pct, raw;
    if (hist.length >= minRank) {
      basis = "percentile";
      pct = hist.filter((v) => v < ma10).length / (hist.length - 1 || 1); // where today's average sits in its own history
      const t = (pct - 0.5) * 2; // −1…+1
      raw = Math.sign(t) * Math.max(0, (Math.abs(t) - 0.4) / 0.6); // middle 30–70th percentile = no signal
    } else {
      basis = "fixed bands";
      const B = opts.bands || BANDS;
      raw = ma10 >= B.fear ? clamp((ma10 - B.fear) / (B.fearHi - B.fear), 0, 1) : ma10 <= B.greed ? -clamp((B.greed - ma10) / (B.greed - B.greedLo), 0, 1) : 0;
      pct = null;
    }
    // reversal: was the average at an extreme in the last two weeks, and has it started to come back?
    const prev = ma.length > 3 ? ma[ma.length - 4].v : null, rolling = prev != null ? ma10 - prev : 0;
    const recent = ma.slice(-10).map((x) => x.v);
    const ext = (v) => (basis === "percentile" ? hist.filter((h) => h < v).length / (hist.length - 1 || 1) : v >= (opts.bands || BANDS).fear ? 0.95 : v <= (opts.bands || BANDS).greed ? 0.05 : 0.5);
    const peakFear = Math.max(...recent.map(ext)), peakGreed = Math.min(...recent.map(ext));
    let signal = null;
    if (peakFear >= 0.9 && rolling < 0) signal = "BUY";
    else if (peakGreed <= 0.1 && rolling > 0) signal = "SELL";
    // a confirmed reversal counts in full; an extreme that is still building counts 75%
    let score = raw;
    if (signal === "BUY") score = Math.max(score, 0.6); else if (signal === "SELL") score = Math.min(score, -0.6);
    else score *= 0.75;
    score = +clamp(score, -1, 1).toFixed(3);
    const B = opts.bands || BANDS;
    const zone = pct != null ? ZONES.find(([lo]) => pct >= lo)[1] : ma10 >= B.fearHi ? "Extreme fear" : ma10 >= B.fear ? "Fear" : ma10 <= B.greedLo ? "Extreme complacency" : ma10 <= B.greed ? "Complacent" : "Neutral";
    const crowd = score > 0 ? "bearish (lots of puts)" : score < 0 ? "bullish (lots of calls)" : "balanced";
    const lean = score > 0 ? "bullish for stocks" : score < 0 ? "bearish for stocks" : "no edge";
    const note = `Zweig put/call: 10-day avg ${ma10.toFixed(2)} (${zone.toLowerCase()}${pct != null ? `, ${Math.round(pct * 100)}th percentile of the last ${hist.length} days` : ""}) — crowd ${crowd}, contrarian read ${lean}${signal ? `; ${signal === "BUY" ? "fear is peaking" : "greed is peaking"} → ${signal} signal` : ""}`;
    return { ok: true, n: s.length, d: last.d, ratio: last.v, ma10: +ma10.toFixed(3), ma20: ma20 == null ? null : +ma20.toFixed(3), pct: pct == null ? null : +pct.toFixed(3), basis, zone, signal, rolling: +rolling.toFixed(3), score, crowd, lean, note,
      ma: ma.slice(-look).map((x) => ({ d: x.d, v: +x.v.toFixed(3) })) };
  }

  // Swing bot: tilt the invested share of the account. Never overrides defense mode (stress).
  // Crowd scared (score ≥ 0.5) while the S&P is below its 200-day → stay more invested than the usual 80%.
  // Crowd euphoric (score ≤ −0.5) in an uptrend → hold back some cash.
  function exposureTilt(base, pc, ctx = {}) {
    if (!pc || !pc.ok || ctx.stress) return { exposure: base, note: null };
    const s = pc.score;
    if (s >= 0.5 && ctx.riskOff) return { exposure: +Math.min(0.95, base + 0.15 * s).toFixed(3), note: `Zweig put/call: the crowd is loaded with puts (10-day avg ${pc.ma10.toFixed(2)}) — contrarian buy, so the bot stays ${Math.round(Math.min(0.95, base + 0.15 * s) * 100)}% invested instead of ${Math.round(base * 100)}%` };
    if (s <= -0.5 && !ctx.riskOff) return { exposure: +Math.max(0.85, base - 0.14 * -s).toFixed(3), note: `Zweig put/call: the crowd is loaded with calls (10-day avg ${pc.ma10.toFixed(2)}) — contrarian caution, so the bot keeps ${Math.round((1 - Math.max(0.85, base - 0.14 * -s)) * 100)}% cash` };
    return { exposure: base, note: null };
  }

  // Quant trader: nudge the equity sleeve ±10% at the extremes (never in risk-off / high volatility).
  function splitTilt(split, pc, regime) {
    if (!pc || !pc.ok || Math.abs(pc.score) < 0.5 || /Risk-off/.test(regime || "")) return { split, tilt: 0 };
    const tilt = +(0.1 * pc.score).toFixed(3);
    return { split: +clamp(split + tilt, 0, 1).toFixed(3), tilt };
  }

  // Day trader: a market-wide lean term (−0.25…+0.25) added to the existing market mood.
  const marketLean = (pc) => (pc && pc.ok ? +(0.25 * pc.score).toFixed(3) : 0);

  return { parseCboe, chainRatio, zweig, exposureTilt, splitTilt, marketLean, BANDS };
});

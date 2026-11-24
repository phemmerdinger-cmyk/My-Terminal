/* Coach · the seventh agent. It never trades; it reviews the other bots with fixed rules and real data.
 *  - chartRead(closes)         support/resistance, trend, moving averages, RSI, momentum → Buy / Hold / Sell (rule-based read)
 *  - journal(trades)           last 20 closed trades: win rate, profit factor, recurring mistakes, 3 rules
 *  - stress(holdings, rets)    a hypothetical −20% market: estimated hit from 1-year beta, overexposure, pairs that move together, hedge
 * Pure functions, no network. Used by server.js (/api/coach) and the Research "Why (bots)" card. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDCoach = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const ok = (x) => Number.isFinite(x);
  const r2 = (x) => (ok(x) ? Math.round(x * 100) / 100 : null);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  function sma(a, n) { return a.length >= n ? mean(a.slice(-n)) : null; }
  function ema(a, n) { if (a.length < n) return null; const k = 2 / (n + 1); let e = mean(a.slice(0, n)); for (let i = n; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }
  function rsi(a, n = 14) {
    if (a.length < n + 1) return null; let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; d > 0 ? (g += d) : (l -= d); }
    g /= n; l /= n;
    for (let i = n + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  // Local highs/lows (pivot with `w` bars each side) clustered within `tol`; returns levels with touch counts.
  function levels(a, { w = 5, tol = 0.015, look = 250 } = {}) {
    const s = a.slice(-look), piv = [];
    for (let i = w; i < s.length - w; i++) {
      const win = s.slice(i - w, i + w + 1);
      if (s[i] === Math.max(...win)) piv.push(s[i]);
      if (s[i] === Math.min(...win)) piv.push(s[i]);
    }
    piv.sort((x, y) => x - y);
    const out = [];
    for (const p of piv) { const c = out[out.length - 1]; if (c && p <= c.hi * (1 + tol)) { c.n++; c.sum += p; c.hi = p; } else out.push({ lo: p, hi: p, sum: p, n: 1 }); }
    return out.map((c) => ({ price: c.sum / c.n, touches: c.n }));
  }
  // least-squares slope of the last n closes, as % of the average price per ~21 trading days (a month)
  function trend(a, n = 60) {
    const s = a.slice(-n); if (s.length < 20) return null;
    const m = s.length, xm = (m - 1) / 2, ym = mean(s); let num = 0, den = 0;
    s.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) ** 2; });
    return (num / den) * 21 / ym * 100;
  }

  function chartRead(closes, { sym = "" } = {}) {
    const a = (closes || []).filter((x) => ok(x) && x > 0);
    if (a.length < 60) return { sym, ok: false, why: `Needs at least 60 daily closes (has ${a.length}).` };
    const px = a[a.length - 1], s20 = sma(a, 20), s50 = sma(a, 50), s200 = sma(a, 200), R = rsi(a);
    const macd = ema(a, 12) != null && ema(a, 26) != null ? ema(a, 12) - ema(a, 26) : null;
    const mom = (n) => (a.length > n ? (px / a[a.length - 1 - n] - 1) * 100 : null);
    const lv = levels(a), below = lv.filter((x) => x.price < px * 0.995).sort((x, y) => y.price - x.price), above = lv.filter((x) => x.price > px * 1.005).sort((x, y) => x.price - y.price);
    const sup = below.find((x) => x.touches >= 2) || below[0] || null, res = above.find((x) => x.touches >= 2) || above[0] || null;
    const tr = trend(a), pts = [];
    let score = 0;
    const add = (n, text) => { score += n; pts.push({ n, text }); };
    if (s50 != null) add(px > s50 ? 1 : -1, px > s50 ? "Above its 50-day average" : "Below its 50-day average");
    if (s200 != null) add(px > s200 ? 1 : -1, px > s200 ? "Above its 200-day average (long-term uptrend)" : "Below its 200-day average (long-term downtrend)");
    if (s50 != null && s200 != null) add(s50 > s200 ? 1 : -1, s50 > s200 ? "50-day above 200-day" : "50-day below 200-day");
    if (R != null) { if (R > 75) add(-1, `RSI ${R.toFixed(0)}: overbought, stretched`); else if (R < 30) add(0, `RSI ${R.toFixed(0)}: oversold, could bounce but trend is weak`); else if (R >= 45) add(1, `RSI ${R.toFixed(0)}: healthy momentum`); else add(0, `RSI ${R.toFixed(0)}: soft momentum`); }
    if (mom(63) != null) add(mom(63) > 0 ? 1 : -1, `${mom(63) >= 0 ? "+" : ""}${mom(63).toFixed(1)}% over 3 months`);
    if (res && (res.price / px - 1) < 0.02) add(-1, `Just under resistance at $${res.price.toFixed(2)}`);
    if (sup && (px / sup.price - 1) < 0.02) add(0, `Sitting on support at $${sup.price.toFixed(2)}`);
    const signal = score >= 4 ? "Buy" : score <= 0 ? "Sell" : "Hold";
    const stop = sup ? sup.price * 0.98 : null, target = res ? res.price : null;
    const rr = stop != null && target != null && px > stop ? (target - px) / (px - stop) : null;
    return { sym, ok: true, price: r2(px), signal, score, points: pts,
      sma20: r2(s20), sma50: r2(s50), sma200: r2(s200), rsi: R == null ? null : Math.round(R * 10) / 10, macd: r2(macd),
      mom1m: r2(mom(21)), mom3m: r2(mom(63)), trendPerMonth: r2(tr), trend: tr == null ? null : tr > 1 ? "up" : tr < -1 ? "down" : "sideways",
      support: sup ? { price: r2(sup.price), touches: sup.touches } : null, resistance: res ? { price: r2(res.price), touches: res.touches } : null,
      plan: { stop: r2(stop), target: r2(target), rewardRisk: rr == null ? null : Math.round(rr * 10) / 10 },
      note: "Rule-based read of the daily closes, not advice." };
  }

  // ---- trading journal ----
  const isClose = (t) => (t.side === "SELL" || t.side === "COVER") && ok(t.pnl);
  const isOpen = (t) => t.side === "BUY" || t.side === "SHORT";
  function causeOf(why) {
    const w = String(why || "");
    if (/earnings/i.test(w)) return "earnings";
    if (/^Bad news|Spider veto|bad news/i.test(w)) return "bad news";
    if (/Defense mode|black-swan|VIX|S&P 500 down|risk-off/i.test(w)) return "market selloff";
    if (/stop/i.test(w)) return "hit its stop";
    if (/average|trend/i.test(w)) return "trend broke";
    if (/Swapped out|Fell to #|ranking|rebalanc/i.test(w)) return "faded / rebalanced";
    if (/close|end of day|time/i.test(w)) return "ran out of time";
    return "other";
  }
  // trades newest first (every bot's ledger). Pairs each close with the open before it in the same symbol.
  function journal(trades, { n = 20 } = {}) {
    const asc = (trades || []).filter((t) => t && t.sym && ok(t.t)).slice().sort((x, y) => x.t - y.t), open = {}, closed = [];
    for (const t of asc) {
      if (isOpen(t)) { if (!open[t.sym]) open[t.sym] = t; }
      else if (isClose(t)) { const o = open[t.sym]; closed.push({ sym: t.sym, t: t.t, pnl: t.pnl, held: o ? (t.t - o.t) / 864e5 : null, setup: t.setup || (o && o.setup) || null, cause: causeOf(t.why), openWhy: o ? o.why || "" : "", why: t.why || "" }); if (!/^Trimmed|partial/i.test(t.why || "")) delete open[t.sym]; }
    }
    const last = closed.slice(-n).reverse();
    if (last.length < 5) return { ok: false, closed: last.length, why: `Only ${last.length} closed trade${last.length === 1 ? "" : "s"} so far; the review needs at least 5.`, trades: last };
    const w = last.filter((t) => t.pnl > 0), l = last.filter((t) => t.pnl <= 0), gw = w.reduce((s, t) => s + t.pnl, 0), gl = -l.reduce((s, t) => s + t.pnl, 0);
    const avgW = w.length ? gw / w.length : 0, avgL = l.length ? gl / l.length : 0;
    const hold = (L) => { const h = L.map((t) => t.held).filter(ok); return h.length ? mean(h) : null; };
    const findings = [];
    // 1. losses bigger than wins
    if (l.length && w.length && avgL > avgW * 1.2) findings.push({ weight: avgL / avgW, text: `Average loss ($${avgL.toFixed(0)}) is ${(avgL / avgW).toFixed(1)}× the average win ($${avgW.toFixed(0)}).`, rule: `Cut losers sooner: exit any trade down more than about $${Math.round(avgW)} (the size of an average win).` });
    // 2. holding losers longer than winners
    const hw = hold(w), hl = hold(l);
    if (hw != null && hl != null && hl > hw * 1.5 && hl - hw >= 0.5) findings.push({ weight: hl / hw, text: `Losers were held ${hl.toFixed(1)} days on average vs ${hw.toFixed(1)} for winners.`, rule: `Don't wait on a losing trade: if it isn't working after ${Math.max(1, Math.round(hw))} day${Math.round(hw) > 1 ? "s" : ""}, close it.` });
    // 3. one exit reason dominating the losses
    const byCause = {}; l.forEach((t) => { (byCause[t.cause] = byCause[t.cause] || { n: 0, pnl: 0 }); byCause[t.cause].n++; byCause[t.cause].pnl += t.pnl; });
    const topCause = Object.entries(byCause).filter(([k]) => k !== "other").sort((a, b) => b[1].n - a[1].n)[0];
    if (topCause && topCause[1].n >= 3 && topCause[1].n / l.length >= 0.4) {
      const R = { "hit its stop": "Enter closer to support so the stop is tighter, or skip setups that need a wide stop.", "earnings": "Don't hold through earnings unless the trade is already well in profit.", "bad news": "Check the spider's news before buying; skip names with fresh negative headlines.", "market selloff": "When the market is falling, open fewer new trades and keep them smaller.", "trend broke": "Only buy stocks above their 50-day and 200-day averages.", "faded / rebalanced": "Wait for a stronger ranking before buying; marginal picks fade.", "ran out of time": "Take trades only when there is enough time left for the setup to play out." };
      findings.push({ weight: topCause[1].n, text: `${topCause[1].n} of ${l.length} losses ended the same way: ${topCause[0]} ($${(-topCause[1].pnl).toFixed(0)} lost).`, rule: R[topCause[0]] });
    }
    // 4. a setup that keeps losing
    const bySetup = {}; last.forEach((t) => { if (!t.setup) return; const s = (bySetup[t.setup] = bySetup[t.setup] || { n: 0, pnl: 0, wins: 0 }); s.n++; s.pnl += t.pnl; s.wins += t.pnl > 0; });
    const bad = Object.entries(bySetup).filter(([, s]) => s.n >= 3 && s.pnl < 0).sort((a, b) => a[1].pnl - b[1].pnl)[0];
    if (bad) findings.push({ weight: bad[1].n, text: `The "${bad[0]}" setup lost $${(-bad[1].pnl).toFixed(0)} over ${bad[1].n} trades (${bad[1].wins} wins).`, rule: `Pause or tighten the "${bad[0]}" setup until it shows a profit again.` });
    // 5. the same stock losing again and again
    const bySym = {}; l.forEach((t) => { bySym[t.sym] = (bySym[t.sym] || 0) + 1; });
    const rep = Object.entries(bySym).filter(([, k]) => k >= 3).sort((a, b) => b[1] - a[1])[0];
    if (rep) findings.push({ weight: rep[1], text: `${rep[0]} lost ${rep[1]} times in these trades.`, rule: `After two losses in the same stock, stay out of it for at least two weeks.` });
    // 6. losing streak
    let streak = 0, worst = 0; last.slice().reverse().forEach((t) => { streak = t.pnl <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); });
    if (worst >= 4) findings.push({ weight: worst / 2, text: `Had a run of ${worst} losses in a row.`, rule: `After 3 losses in a row, halve the trade size until the next win.` });
    findings.sort((a, b) => b.weight - a.weight);
    const best = Object.entries(bySetup).filter(([, s]) => s.n >= 3 && s.pnl > 0).sort((a, b) => b[1].pnl - a[1].pnl)[0];
    return { ok: true, closed: last.length, wins: w.length, losses: l.length, winRate: w.length / last.length,
      profitFactor: gl > 0 ? Math.round(gw / gl * 100) / 100 : null, net: r2(gw - gl), avgWin: r2(avgW), avgLoss: r2(avgL), holdWin: r2(hw), holdLoss: r2(hl),
      best: best ? { setup: best[0], pnl: r2(best[1].pnl), n: best[1].n } : null,
      mistakes: findings.map((f) => f.text), rules: findings.slice(0, 3).map((f) => f.rule),
      enough: findings.length >= 3 ? null : findings.length ? `Only ${findings.length} clear problem${findings.length > 1 ? "s" : ""} in these trades, so fewer than 3 rules.` : "No recurring mistake stands out in these trades.",
      trades: last.slice(0, n).map((t) => ({ sym: t.sym, t: t.t, pnl: r2(t.pnl), held: t.held == null ? null : Math.round(t.held * 10) / 10, setup: t.setup, cause: t.cause })) };
  }

  // ---- −20% market stress ----
  const dailyRets = (c) => { const out = []; for (let i = 1; i < c.length; i++) if (c[i - 1] > 0 && c[i] > 0) out.push(c[i] / c[i - 1] - 1); return out; };
  function beta(r, m) { const n = Math.min(r.length, m.length); if (n < 60) return null; const a = r.slice(-n), b = m.slice(-n), ma = mean(a), mb = mean(b); let cov = 0, v = 0; for (let i = 0; i < n; i++) { cov += (a[i] - ma) * (b[i] - mb); v += (b[i] - mb) ** 2; } return v > 0 ? cov / v : null; }
  function corr(r, m) { const n = Math.min(r.length, m.length); if (n < 60) return null; const a = r.slice(-n), b = m.slice(-n), ma = mean(a), mb = mean(b); let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : null; }
  // holdings: [{bot, sym, value}] (value > 0 long, < 0 short). closes: {SYM: [daily closes, oldest first], SPY: [...]}. Same-length tails are compared.
  function stress(holdings, closes, { drop = 0.2, maxWeight = 0.2, hiCorr = 0.8 } = {}) {
    const H = (holdings || []).filter((x) => x && x.sym && ok(x.value) && x.value !== 0);
    const mkt = dailyRets((closes && closes.SPY) || []);
    if (!H.length) return { ok: false, why: "No bot holds anything right now." };
    if (mkt.length < 60) return { ok: false, why: "S&P 500 history unavailable, so the stress test can't run." };
    const rets = {}, bs = {};
    for (const s of new Set(H.map((x) => x.sym))) { const c = closes[s]; if (!c) continue; rets[s] = dailyRets(c); bs[s] = beta(rets[s], mkt); }
    const rows = H.map((x) => { const b = bs[x.sym]; return { ...x, beta: b == null ? null : Math.round(b * 100) / 100, hit: b == null ? null : r2(x.value * b * -drop) }; });
    const missing = rows.filter((r) => r.beta == null).map((r) => r.sym);
    const sum = (L, f) => L.reduce((s, x) => s + f(x), 0);
    const bots = [...new Set(rows.map((r) => r.bot))].map((bot) => {
      const L = rows.filter((r) => r.bot === bot), gross = sum(L, (r) => Math.abs(r.value)), known = L.filter((r) => r.hit != null), hit = sum(known, (r) => r.hit);
      const over = L.filter((r) => gross > 0 && Math.abs(r.value) / gross > maxWeight).map((r) => ({ sym: r.sym, weight: r2(Math.abs(r.value) / gross * 100) }));
      return { bot, invested: r2(gross), hit: r2(hit), hitPct: gross > 0 ? r2(hit / gross * 100) : null, over, unknown: L.filter((r) => r.hit == null).map((r) => r.sym) };
    });
    const known = rows.filter((r) => r.hit != null), totalHit = sum(known, (r) => r.hit), betaDollars = sum(known, (r) => r.value * r.beta);
    // pairs that move together
    const syms = Object.keys(rets).filter((s) => rets[s].length >= 60), pairs = [];
    for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) { const c = corr(rets[syms[i]], rets[syms[j]]); if (c != null && c >= hiCorr) pairs.push({ a: syms[i], b: syms[j], corr: Math.round(c * 100) / 100 }); }
    pairs.sort((a, b) => b.corr - a.corr);
    // same stock in more than one bot
    const by = {}; rows.forEach((r) => { (by[r.sym] = by[r.sym] || new Set()).add(r.bot); });
    const shared = Object.entries(by).filter(([, b]) => b.size > 1).map(([sym, b]) => ({ sym, bots: [...b] }));
    // hedge: offset the beta-weighted dollars with an inverse S&P fund, or trim the biggest contributors
    const top = known.filter((r) => r.hit < 0).sort((a, b) => a.hit - b.hit).slice(0, 3);
    const trims = top.map((r) => ({ bot: r.bot, sym: r.sym, beta: r.beta, value: r2(r.value), hit: r.hit, trimHalfSaves: r2(-r.hit / 2) }));
    return { ok: true, drop: drop * 100, totalHit: r2(totalHit), betaDollars: r2(betaDollars), bots, rows: rows.sort((a, b) => (a.hit ?? 0) - (b.hit ?? 0)), pairs: pairs.slice(0, 8), shared, missing,
      hedge: betaDollars > 0 ? { inverseFund: "SH", amount: r2(betaDollars), text: `About $${Math.round(betaDollars).toLocaleString("en-US")} of a −1× S&P 500 fund (e.g. SH) would offset most of the estimated hit; trimming the names below by half also helps.` } : { inverseFund: null, amount: 0, text: "The books are already net short or flat against the market; no hedge needed." },
      trims, note: `Hypothetical: each holding's 1-year beta to SPY times a ${drop * 100}% market drop. Real crashes can be worse; correlations jump in selloffs.` };
  }

  return { sma, ema, rsi, levels, trend, chartRead, journal, causeOf, dailyRets, beta, corr, stress };
});

// Quant Trader — the third paper-trading bot. A systematic, rules-only allocator built on the same math as the
// Quant Lab (public/qmath.js). Once per trading day, after the close, it:
//   1. reads the market regime from SPY (trend, 50/200-day cross, realized volatility, drawdown) and credit (HYG/IEF)
//   2. sets the equity / defensive split from that regime
//   3. ranks the equity universe on 12-1 month momentum, 3-month momentum and low volatility (cross-sectional z-scores),
//      keeping only names above their 200-day average
//   4. sizes the picks by risk parity on a 6-month covariance matrix (each ≤ 20%), sizes the defensive sleeve the same way
//   5. scales risk down to a 15% annualized volatility target, parking the rest in T-bills (BIL)
//   6. trades only weight changes above 1.5% of the account, paying 5 bps per side
// Paper money only. Pure functions here; server.js supplies prices and keeps the account.
const QM = require("./public/qmath.js");

const QT_EQUITY = ["SPY", "QQQ", "IWM", "XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB", "XLC", "XLRE", "SMH",
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "LLY", "JPM", "V", "UNH", "XOM", "COST", "WMT", "HD", "PG", "MA", "NFLX", "AMD", "CRM", "ORCL", "CAT", "GE"];
const QT_DEFENSIVE = ["IEF", "TLT", "GLD"];
const QT_CASH = "BIL";
const QT_SIGNALS = ["HYG"]; // credit gauge for the regime (with IEF)
const QT_START = 10000, QT_COST = 0.0005, QT_MIN_TRADE = 0.015, QT_MAX_W = 0.2, QT_TOP = 8, QT_VOL_TARGET = 0.15;
const SPLIT = { "Risk-on trend": 1.0, "Choppy / late-cycle": 0.7, Correction: 0.4, "Risk-off / high volatility": 0.1 };

const z = (a) => { const v = a.filter(isFinite), m = QM.mean(v), s = QM.sd(v) || 1; return a.map((x) => (isFinite(x) ? (x - m) / s : 0)); };

// px: { SYM: aligned adjusted closes }, all the same length (oldest → newest). Returns target weights + the reasoning.
function decide(px) {
  const n = px.SPY.length, last = n - 1;
  if (n < 280) throw new Error("need at least ~13 months of aligned history");
  const credit = px.HYG && px.IEF ? px.HYG.map((v, i) => v / px.IEF[i]) : null;
  const reg = QM.regimeAt(px.SPY, last, credit);
  const split = SPLIT[reg.label] ?? 0.5;
  // ---- rank equities
  const eq = QT_EQUITY.filter((s) => px[s]), ret = (s, a, b) => px[s][last - b] / px[s][last - a] - 1;
  const raw = eq.map((s) => { const r = QM.returns(px[s].slice(-127)); return { s, m12: ret(s, 252, 21), m3: ret(s, 63, 0), vol: QM.annVol(r), trend: px[s][last] > QM.sma(px[s], 200, last) }; });
  const zm12 = z(raw.map((x) => x.m12)), zm3 = z(raw.map((x) => x.m3)), zlv = z(raw.map((x) => -x.vol));
  raw.forEach((x, i) => (x.score = 0.5 * zm12[i] + 0.25 * zm3[i] + 0.25 * zlv[i]));
  const ranked = [...raw].sort((a, b) => b.score - a.score), picks = ranked.filter((x) => x.trend).slice(0, QT_TOP);
  // ---- size each sleeve by risk parity on 6 months of daily returns
  const rp = (syms, cap) => { if (!syms.length) return {}; if (syms.length === 1) return { [syms[0]]: 1 }; const R = syms.map((s) => QM.returns(px[s].slice(-127))), C = QM.covMatrix(R);
    const hi = Math.max(cap, 1 / syms.length + 1e-9), w = QM.riskParity(C, 0, hi); return Object.fromEntries(syms.map((s, i) => [s, w[i]])); };
  const wEq = rp(picks.map((x) => x.s), QT_MAX_W / Math.max(split, 0.01)), def = QT_DEFENSIVE.filter((s) => px[s]), wDef = rp(def, 1);
  let w = {}; const eqShare = picks.length ? split : 0, defShare = 1 - eqShare;
  for (const [s, v] of Object.entries(wEq)) w[s] = (w[s] || 0) + v * eqShare;
  for (const [s, v] of Object.entries(wDef)) w[s] = (w[s] || 0) + v * defShare;
  // ---- volatility target on the combined book (ex-ante, 6-month covariance)
  const syms = Object.keys(w), R = syms.map((s) => QM.returns(px[s].slice(-127))), C = QM.covMatrix(R).map((r) => r.map((x) => x * QM.DAYS)), wv = syms.map((s) => w[s]);
  const exVol = Math.sqrt(QM.pVar(wv, C)), scale = exVol > QT_VOL_TARGET ? QT_VOL_TARGET / exVol : 1;
  for (const s of syms) w[s] *= scale;
  for (const k of Object.keys(w)) if (!(w[k] > 1e-9)) delete w[k];
  const cash = Math.max(0, 1 - Object.values(w).reduce((a, b) => a + b, 0)); if (cash > 0.001) w[QT_CASH] = (w[QT_CASH] || 0) + cash;
  const ws = syms.map((s) => w[s]), enb = QM.enb(ws.map((x) => x / (ws.reduce((a, b) => a + b, 0) || 1)), C.map((r) => r.map((x) => x / QM.DAYS))).enb;
  return { w, regime: reg.label, score: reg.score, ind: reg.ind, split, exVol, vol: exVol * scale, scale, enb,
    ranked: ranked.slice(0, 15).map((x) => ({ s: x.s, score: +x.score.toFixed(2), m12: +x.m12.toFixed(4), m3: +x.m3.toFixed(4), vol: +x.vol.toFixed(4), trend: x.trend, picked: picks.includes(x) })) };
}

// Turn target weights into orders against current holdings ({ SYM: shares }) at prices ({ SYM: price }).
function orders(target, holdings, prices, value) {
  const syms = [...new Set([...Object.keys(target), ...Object.keys(holdings)])], out = [];
  for (const s of syms) { const p = prices[s]; if (!(p > 0)) continue; const cur = ((holdings[s] || 0) * p) / value, want = target[s] || 0, d = want - cur;
    if (Math.abs(d) < QT_MIN_TRADE && !(want === 0 && cur > 0)) continue; // skip small changes, but always exit dropped names
    out.push({ sym: s, side: d > 0 ? "BUY" : "SELL", shares: +(Math.abs(d) * value / p).toFixed(4), price: p, from: cur, to: want }); }
  return out.sort((a, b) => (a.side === b.side ? 0 : a.side === "SELL" ? -1 : 1)); // sells first
}

module.exports = { decide, orders, QT_EQUITY, QT_DEFENSIVE, QT_CASH, QT_SIGNALS, QT_START, QT_COST, QT_MIN_TRADE, QT_MAX_W, QT_TOP, QT_VOL_TARGET, SPLIT };

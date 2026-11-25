/* Coach tuner · turns the Coach's journal findings into small, bounded setting changes on the paper bots,
 * checks each change against the trades that follow it, and undoes it when results got worse.
 *  - plan(state, bot, { closed, findings, now })  one review pass for one bot; mutates state, returns new log entries
 *  - effective(state, bot, now)                    the settings the bot should trade with right now
 *  - status(closed, vsSpx)                         progress toward the "successful trader" bar
 * Rules, not AI: no network, no paid calls. Never touches the risk desk, drawdown lock, costs or bust level.
 * Pure functions; used by server.js and tested in tests/coach-tuner-core.test.js. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDCoachTuner = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const DAY = 864e5;
  const ok = (x) => Number.isFinite(x);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const usd = (x) => "$" + Math.round(Math.abs(x)).toLocaleString("en-US");

  // Hard limits. The Coach can move a setting only inside these, one step at a time.
  const LIMITS = {
    lossCap: { start: 0.12, step: 0.8, min: 0.05 }, // swing: sell a holding that's this far below its cost
    loserDays: { min: 2, max: 10 },                  // swing: close a losing holding after this many days
    newsFloor: { from: -1.5, to: -0.5 },             // swing: skip buys with news this negative or worse
    sizeMult: { min: 0.5 },                          // trade size multiplier
  };
  const RULES = {
    MIN_TRADES: 10,      // closed trades needed before the first change, and between changes to the same bot
    GAP: 7 * DAY,        // at most one lasting setting change per bot per week
    REVIEW_N: 10,        // closed trades after a change before it's judged
    BASE_N: 20,          // closed trades before a change used as its baseline
    AVOID_DAYS: 14,      // stay out of a stock that keeps losing
    PAUSE_DAYS: 14,      // pause a setup that keeps losing
    BAR_N: 40,           // "successful": over the last 40 closed trades…
    BAR_PF: 1.3,         // …profit factor of at least 1.3…
  };
  // What each bot lets the Coach change. The quant trader's settings are set by its weekly replay test instead.
  const CAN = {
    swing: ["lossCap", "loserDays", "requireTrend", "newsFloor", "sizeMult", "avoid", "pause"],
    day: ["sizeMult", "avoid", "pause"],
    quant: [],
  };
  const LABEL = { lossCap: "loss cap per holding", loserDays: "days a losing holding may stay open", requireTrend: "buy only above both the 50- and 200-day averages",
    newsFloor: "skip buys with negative news", sizeMult: "trade size" };

  function fresh() { return { v: 1, bots: {}, log: [] }; }
  function botState(state, bot) {
    state.bots = state.bots || {};
    const b = (state.bots[bot] = state.bots[bot] || { set: {}, avoid: {}, paused: {}, streak: null, lastChange: 0, pending: [] }); b.rejected = b.rejected || {}; return b;
  }
  function fmt(key, v) {
    if (v == null) return key === "lossCap" ? "the bot's own stops" : key === "loserDays" ? "no time limit" : key === "sizeMult" ? "full size" : key === "newsFloor" ? "very negative news only" : "off";
    if (key === "lossCap") return `−${Math.round(v * 100)}%`;
    if (key === "loserDays") return `${v} days`;
    if (key === "sizeMult") return `${Math.round(v * 100)}%`;
    if (key === "newsFloor") return v >= -0.5 ? "any negative news" : "very negative news only";
    return v ? "on" : "off";
  }
  const entry = (state, e) => { state.log = [e, ...(state.log || [])].slice(0, 200); return e; };
  const avgPnl = (L) => mean(L.map((t) => t.pnl));

  // A lasting setting change the Coach would make for a finding, or a reason it can't.
  function proposal(bot, b, f) {
    const can = new Set(CAN[bot] || []), cur = (k) => b.set[k] ?? null;
    if (f.kind === "bigLosses") {
      if (!can.has("lossCap")) return { why: "needs a change to the bot's exit rules" };
      const from = cur("lossCap"), to = from == null ? LIMITS.lossCap.start : Math.max(LIMITS.lossCap.min, Math.round(from * LIMITS.lossCap.step * 1000) / 1000);
      return from === to ? { why: "the loss cap is already at its tightest allowed setting" } : { key: "lossCap", from, to };
    }
    if (f.kind === "holdLosers") {
      if (!can.has("loserDays") || !ok(f.holdWin)) return { why: "needs a change to the bot's exit rules" };
      const to = Math.min(LIMITS.loserDays.max, Math.max(LIMITS.loserDays.min, Math.round(f.holdWin) + 1)), from = cur("loserDays");
      return from != null && from <= to ? { why: "the time limit on losers is already that tight" } : { key: "loserDays", from, to };
    }
    if (f.kind === "cause") {
      if (f.cause === "trend broke" && can.has("requireTrend")) return cur("requireTrend") ? { why: "trend filter already on" } : { key: "requireTrend", from: null, to: true };
      if (f.cause === "bad news" && can.has("newsFloor")) return cur("newsFloor") === LIMITS.newsFloor.to ? { why: "news filter already strict" } : { key: "newsFloor", from: cur("newsFloor"), to: LIMITS.newsFloor.to };
      if (f.cause === "market selloff" && can.has("sizeMult")) { const from = cur("sizeMult"), to = Math.max(LIMITS.sizeMult.min, Math.round(((from ?? 1) - 0.25) * 100) / 100); return from === to ? { why: "trade size is already at its smallest allowed setting" } : { key: "sizeMult", from, to }; }
      return { why: `losses that "${f.cause}" need a change to the bot's code, which the Coach doesn't make on its own` };
    }
    return null;
  }

  // One review pass for one bot. closed: closed trades oldest first ({ t, pnl, sym, setup }); findings: journal().findings.
  function plan(state, bot, { closed = [], findings = [], now = Date.now() } = {}) {
    const b = botState(state, bot), out = [], can = new Set(CAN[bot] || []), L = closed.filter((t) => ok(t.t) && ok(t.pnl));
    const add = (e) => out.push(entry(state, { t: now, bot, ...e }));
    // 1) temporary blocks run out on their own
    for (const [sym, until] of Object.entries(b.avoid)) if (now >= until) { delete b.avoid[sym]; add({ action: "expired", what: `Can trade ${sym} again`, why: `${RULES.AVOID_DAYS}-day break after repeated losses is over.` }); }
    for (const [setup, until] of Object.entries(b.paused)) if (now >= until) { delete b.paused[setup]; add({ action: "expired", what: `"${setup}" setup back on`, why: `${RULES.PAUSE_DAYS}-day pause is over.` }); }
    if (b.streak && L.some((t) => t.t > b.streak.t && t.pnl > 0)) {
      const from = b.streak.mult; b.streak = null;
      add({ action: "expired", what: `Trade size back to normal (was ${fmt("sizeMult", from)})`, why: "First win after the losing streak." });
    }
    // 2) judge lasting changes once enough trades have followed them; undo the ones that made things worse
    for (const c of b.pending.slice()) {
      const after = L.filter((t) => t.t > c.t);
      if (after.length < RULES.REVIEW_N) continue;
      b.pending = b.pending.filter((x) => x !== c);
      const a = avgPnl(after.slice(0, RULES.REVIEW_N));
      if (ok(c.base) && a < c.base) {
        if (c.from == null) delete b.set[c.key]; else b.set[c.key] = c.from;
        b.rejected[c.key + ":" + c.to] = now; // don't try the same setting again
        add({ action: "reverted", key: c.key, from: c.to, to: c.from, what: `Undid: ${LABEL[c.key]} back to ${fmt(c.key, c.from)}`,
          why: `The ${RULES.REVIEW_N} trades after the change averaged ${a < 0 ? "−" : ""}${usd(a)} per trade vs ${c.base < 0 ? "−" : ""}${usd(c.base)} before it.` });
      } else add({ action: "kept", key: c.key, what: `Kept: ${LABEL[c.key]} at ${fmt(c.key, c.to)}`,
        why: ok(c.base) ? `The ${RULES.REVIEW_N} trades after the change averaged ${a < 0 ? "−" : ""}${usd(a)} per trade vs ${c.base < 0 ? "−" : ""}${usd(c.base)} before it.` : "Not enough trades before the change to compare; kept." });
    }
    if (L.length < RULES.MIN_TRADES) return out;
    const sorted = findings.slice().sort((x, y) => (y.weight || 0) - (x.weight || 0));
    // 3) quick, temporary fixes (they expire by themselves, so they don't wait for the weekly slot)
    for (const f of sorted) {
      if (f.kind === "repeatSym" && can.has("avoid") && f.sym && !b.avoid[f.sym]) {
        b.avoid[f.sym] = now + RULES.AVOID_DAYS * DAY;
        add({ action: "changed", what: `Stays out of ${f.sym} for ${RULES.AVOID_DAYS} days`, why: f.text });
      }
      if (f.kind === "setup" && can.has("pause") && f.setup && !b.paused[f.setup]) {
        b.paused[f.setup] = now + RULES.PAUSE_DAYS * DAY;
        add({ action: "changed", what: `Paused the "${f.setup}" setup for ${RULES.PAUSE_DAYS} days`, why: f.text });
      }
      if (f.kind === "streak" && can.has("sizeMult") && !b.streak) {
        let run = 0; for (let i = L.length - 1; i >= 0 && L[i].pnl <= 0; i--) run++;
        if (run >= 3) { b.streak = { t: L[L.length - 1].t, mult: LIMITS.sizeMult.min }; add({ action: "changed", what: `Half-size trades until the next win`, why: `${run} losses in a row right now. ${f.text}` }); }
      }
    }
    // 4) at most one lasting change per bot per week, and only with enough new trades since the last one
    const since = L.filter((t) => t.t > b.lastChange).length;
    if (now - b.lastChange < RULES.GAP || since < RULES.MIN_TRADES) return out;
    for (const f of sorted) {
      const p = proposal(bot, b, f);
      if (!p || !p.key || b.rejected[p.key + ":" + p.to]) continue;
      const before = L.slice(-RULES.BASE_N);
      b.set[p.key] = p.to; b.lastChange = now;
      b.pending.push({ t: L[L.length - 1].t, key: p.key, from: p.from, to: p.to, base: before.length >= 5 ? avgPnl(before) : null });
      add({ action: "changed", key: p.key, from: p.from, to: p.to, what: `${LABEL[p.key][0].toUpperCase() + LABEL[p.key].slice(1)}: ${fmt(p.key, p.from)} → ${fmt(p.key, p.to)}`,
        why: `${f.text} It will be checked after the next ${RULES.REVIEW_N} closed trades and undone if they do worse.` });
      break;
    }
    return out;
  }

  // Findings the Coach can't fix by itself, with the reason (shown, not logged on every pass).
  function cantFix(state, bot, findings) {
    const b = botState(state, bot), quick = new Set(["repeatSym", "setup", "streak"]), can = new Set(CAN[bot] || []);
    return findings.filter((f) => !(quick.has(f.kind) && can.has(f.kind === "repeatSym" ? "avoid" : f.kind === "setup" ? "pause" : "sizeMult")))
      .map((f) => { const p = proposal(bot, b, f); return p && p.key ? null : { text: f.text, why: !can.size ? "The quant trader's settings are set by its weekly replay test; the Coach doesn't change them." : (p && p.why) || "needs a code change" }; })
      .filter(Boolean);
  }

  // The settings a bot trades with right now.
  function effective(state, bot, now = Date.now()) {
    const b = (state && state.bots && state.bots[bot]) || { set: {}, avoid: {}, paused: {}, streak: null };
    const avoid = new Set(Object.entries(b.avoid || {}).filter(([, u]) => now < u).map(([s]) => s));
    const paused = new Set(Object.entries(b.paused || {}).filter(([, u]) => now < u).map(([s]) => s));
    const sizeMult = Math.max(LIMITS.sizeMult.min, (b.set.sizeMult ?? 1) * (b.streak ? b.streak.mult : 1));
    return { lossCap: b.set.lossCap ?? null, loserDays: b.set.loserDays ?? null, requireTrend: !!b.set.requireTrend, newsFloor: b.set.newsFloor ?? LIMITS.newsFloor.from, sizeMult, avoid, paused };
  }

  // Progress toward the bar: over the last 40 closed trades, a profit after costs, profit factor ≥ 1.3, and ahead of the S&P since the run began.
  function status(closed, vsSpx) {
    const L = (closed || []).filter((t) => ok(t.pnl)).slice(-RULES.BAR_N), w = L.filter((t) => t.pnl > 0), gw = w.reduce((s, t) => s + t.pnl, 0), gl = -L.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
    const pf = gl > 0 ? gw / gl : gw > 0 ? Infinity : null, net = gw - gl;
    const checks = [
      { label: `${RULES.BAR_N} closed trades`, pass: L.length >= RULES.BAR_N, value: `${L.length}` },
      { label: "Made money after costs", pass: L.length > 0 && net > 0, value: L.length ? `${net < 0 ? "−" : "+"}${usd(net)}` : "—" },
      { label: `Profit factor ≥ ${RULES.BAR_PF}`, pass: pf != null && pf >= RULES.BAR_PF, value: pf == null ? "—" : pf === Infinity ? "no losses" : pf.toFixed(2) },
      { label: "Ahead of the S&P 500 since its run began", pass: ok(vsSpx) && vsSpx > 0, value: ok(vsSpx) ? `${vsSpx >= 0 ? "+" : "−"}${Math.abs(vsSpx * 100).toFixed(2)} pts` : "unavailable" },
    ];
    const met = checks.every((c) => c.pass);
    return { met, checks, text: met ? "Meets the bar. The Coach keeps watching and will step in if results slip." : L.length < RULES.BAR_N ? `Too early to judge: ${L.length} of ${RULES.BAR_N} closed trades.` : "Not there yet. The Coach keeps adjusting." };
  }

  return { LIMITS, RULES, CAN, fresh, plan, cantFix, effective, status };
});

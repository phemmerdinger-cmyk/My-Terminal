// Market Desk — the Coach acts. Turns the Coach's review (public/coach-core.js) into automatic, bounded fixes on the
// paper bots, and explains the findings it deliberately does not act on. Pure functions (tests/coach-actions-core.test.js);
// server.js stores the plan and the bots read it. Paper money only.
//
// Fixes it applies (each one names its reason and ends on its own):
//   pauseSetup  a setup that keeps losing stops opening trades for 5 days, then gets a fresh chance
//   halfSize    after 3+ losses in a row, new trades are half size until the next win
//   cooldown    a stock that lost 3+ times is off-limits to that bot for 14 days
//   lossCap     swing trades are closed once they lose more than an average win
//   timeStop    swing trades still losing after the winners' typical hold time are closed
//   trim        a stock over 20% of a trading bot's book is trimmed back to 20%
//   sellHalf    a swing holding whose chart reads Sell is cut in half (once)
// It never overrides an allocator's design (the Quant sizes by a volatility target and holds bond/cash funds on purpose)
// and never repeats a pause on the same old trades: a setup or stock is paused again only on losses after the last pause.
"use strict";
const DAY = 864e5;
const BOT_ID = { "Swing bot": "swing", "Day trader": "day", Quant: "quant" };
const ALLOCATORS = new Set(["quant"]);
// funds that are defensive by nature: concentration in them is a hedge, not a risk to trim
const SAFE_FUNDS = new Set(["IEF", "TLT", "SHY", "BIL", "SHV", "SGOV", "AGG", "BND", "GOVT", "IEI", "VGSH", "VGIT", "SCHO", "TIP", "GLD", "IAU"]);
const r2 = (x) => Math.round(x * 100) / 100;

function currentLossStreak(trades) { let n = 0; for (const t of trades || []) { if (t.pnl <= 0) n++; else break; } return n; }

// review: the Coach's output ({journals, stress, charts}); prev: the last plan (to expire actions and avoid re-pausing
// on the same evidence). Returns {at, actions, skipped}.
function plan(review, { now = Date.now(), prev = null } = {}) {
  const actions = [], skipped = [], old = new Map(((prev && prev.actions) || []).map((a) => [a.id, a]));
  const ended = new Map(((prev && prev.ended) || []).map((e) => [e.id, e.at]));
  for (const a of old.values()) if (a.until && a.until <= now) ended.set(a.id, a.until);
  const add = (a) => {
    const was = old.get(a.id);
    // keep the original start and end of an action that is still running, so a review can't extend it forever
    const x = was && (!was.until || was.until > now) ? { ...a, since: was.since, until: was.until ?? a.until, done: was.done } : { ...a, since: now };
    actions.push(x);
  };
  const skip = (bot, finding, why) => skipped.push({ bot, finding, why });

  for (const j of (review && review.journals) || []) {
    const bot = BOT_ID[j.bot] || String(j.bot || "").toLowerCase();
    if (!j.ok) continue;
    for (const f of j.findings || []) {
      if (ALLOCATORS.has(bot)) { skip(j.bot, f.text, "The Quant sizes every position from its volatility target and rebalances on its own schedule, so the Coach doesn't override it. Its regime filter already moves it to bonds when the market falls."); continue; }
      const freshAfter = (id) => ended.get(id) || 0; // evidence must be newer than the last time this fix ended
      if (f.kind === "setup") {
        const id = `${bot}:pauseSetup:${f.setup}`, since = freshAfter(id), recent = (j.trades || []).filter((t) => t.setup === f.setup && t.t > since);
        const net = recent.reduce((s, t) => s + (t.pnl || 0), 0);
        if (since && !(recent.length >= 3 && net < 0)) { skip(j.bot, f.text, `Already paused once; it gets a fresh chance and is paused again only if it loses over 3+ new trades (${recent.length} so far).`); continue; }
        add({ id, bot, kind: "pauseSetup", setup: f.setup, until: now + 5 * DAY, why: f.text, fix: `Paused the "${f.setup}" setup for 5 days.` });
      } else if (f.kind === "streak" || (f.kind === "cause" && f.cause === "market selloff")) {
        const n = currentLossStreak(j.trades);
        if (n >= 3) add({ id: `${bot}:halfSize`, bot, kind: "halfSize", factor: 0.5, until: null, why: `${n} losses in a row right now.`, fix: "New trades are half size until the next win." });
        else skip(j.bot, f.text, n ? `The current run is ${n} loss${n > 1 ? "es" : ""}, under the 3 that trigger half size.` : "The losing run already ended with a win.");
      } else if (f.kind === "repeatSym") {
        const id = `${bot}:cooldown:${f.sym}`, since = freshAfter(id), recentLosses = (j.trades || []).filter((t) => t.sym === f.sym && t.pnl <= 0 && t.t > since).length;
        if (since && recentLosses < 2) { skip(j.bot, f.text, `${f.sym} already sat out 14 days; it's blocked again only after 2 new losses.`); continue; }
        add({ id, bot, kind: "cooldown", sym: f.sym, until: now + 14 * DAY, why: f.text, fix: `No new ${f.sym} trades for 14 days.` });
      } else if (f.kind === "lossSize") {
        if (bot !== "swing") { skip(j.bot, f.text, "Day trades already exit at a fixed stop within 10 minutes, so each loss is capped by design."); continue; }
        if (!(f.avgWin >= 25)) { skip(j.bot, f.text, "The average win is too small to set a sensible loss cap yet."); continue; }
        add({ id: "swing:lossCap", bot, kind: "lossCap", dollars: Math.round(f.avgWin), until: null, why: f.text, fix: `Swing trades are closed once they're down more than $${Math.round(f.avgWin)}.` });
      } else if (f.kind === "holdLosers") {
        if (bot !== "swing") { skip(j.bot, f.text, "Day trades are held at most 10 minutes."); continue; }
        const days = Math.max(2, Math.ceil(f.holdWin * 1.5));
        add({ id: "swing:timeStop", bot, kind: "timeStop", days, until: null, why: f.text, fix: `Swing trades still losing after ${days} days are closed.` });
      } else if (f.kind === "cause") {
        const handled = { "hit its stop": "Stops are part of each setup; the setup pause above handles setups whose stops keep getting hit.", earnings: "The swing bot already holds or trims ahead of earnings and waits to buy until after the report.",
          "bad news": "The spider's pre-buy check already vetoes stocks with fresh negative news.", "trend broke": "The trend-break exit is already a sell rule.", "faded / rebalanced": "Rank-based exits are part of the strategy.", "ran out of time": "Time exits are part of the setup." };
        skip(j.bot, f.text, handled[f.cause] || "No automatic fix for this one; it's shown for information.");
      }
    }
  }

  const st = review && review.stress;
  if (st && st.ok) {
    for (const b of st.bots || []) {
      const bot = BOT_ID[b.bot] || String(b.bot).toLowerCase();
      for (const o of b.over || []) {
        const text = `${b.bot}: ${o.sym} is ${o.weight}% of its book.`;
        if (ALLOCATORS.has(bot)) { skip(b.bot, text, SAFE_FUNDS.has(o.sym) ? `${o.sym} is a bond/defensive fund the Quant holds on purpose in a risk-off regime; trimming it would just hold cash.` : "The Quant's own max weight and rebalancing decide its position sizes."); continue; }
        if (SAFE_FUNDS.has(o.sym)) { skip(b.bot, text, `${o.sym} is a bond/defensive fund; concentration there lowers risk.`); continue; }
        if (bot !== "swing") { skip(b.bot, text, "Day-trade positions close within minutes."); continue; }
        add({ id: `swing:trim:${o.sym}`, bot, kind: "trim", sym: o.sym, maxWeight: 0.2, until: now + DAY, why: text, fix: `Trim ${o.sym} back to 20% of the swing book.` });
      }
    }
    for (const p of st.pairs || []) skip("All bots", `${p.a} and ${p.b} move together (${p.corr}).`, "Shown for information: trimming either one is covered by the 20% limit.");
  }
  for (const c of (review && review.charts) || []) {
    if (!(c.ok && c.signal === "Sell" && /held/.test(c.role || ""))) continue;
    const text = `${c.sym} (${c.role}) reads Sell on the chart.`;
    if (/Swing bot/.test(c.role)) add({ id: `swing:sellHalf:${c.sym}`, bot: "swing", kind: "sellHalf", sym: c.sym, until: now + 5 * DAY, why: text, fix: `Sold half of ${c.sym}.` });
    else if (/Quant/.test(c.role)) skip("Quant", text, SAFE_FUNDS.has(c.sym) ? `${c.sym} is the Quant's defensive holding; its regime model, not a chart read, decides when to leave it.` : "The Quant's regime and momentum model decides its exits.");
    else skip("Day trader", text, "Day-trade positions close within minutes on their own stops.");
  }
  const endedList = [...ended].filter(([, at]) => now - at < 60 * DAY).map(([id, at]) => ({ id, at }));
  return { at: now, actions: actions.filter((a) => !a.until || a.until > now), skipped, ended: endedList };
}

// ---- what the bots ask
const active = (p, bot, now = Date.now()) => ((p && p.actions) || []).filter((a) => a.bot === bot && (!a.until || a.until > now));
function sizeFactor(p, bot, now) { return active(p, bot, now).filter((a) => a.kind === "halfSize").reduce((f, a) => f * (a.factor || 0.5), 1); }
function blocked(p, bot, sym, now) { return active(p, bot, now).some((a) => a.kind === "cooldown" && a.sym === sym); }
function setupPaused(p, bot, setup, now) { return active(p, bot, now).some((a) => a.kind === "pauseSetup" && a.setup === setup); }
// swing exits from the Coach for one position: {sell: fraction 0–1, reason, actionId} or null
function swingExit(p, pos, { sym, price, bookValue, now = Date.now(), done = {} } = {}) {
  if (!pos || !(price > 0)) return null;
  for (const a of active(p, "swing", now)) {
    const loss = (pos.cost - price) * pos.shares, heldDays = (now - (pos.at || now)) / DAY;
    if (a.kind === "lossCap" && loss > a.dollars) return { sell: 1, reason: `Coach: down $${loss.toFixed(0)}, more than the $${a.dollars} loss cap`, actionId: a.id };
    if (a.kind === "timeStop" && loss > 0 && heldDays >= a.days) return { sell: 1, reason: `Coach: still losing after ${Math.floor(heldDays)} days (time stop ${a.days} days)`, actionId: a.id };
    if (a.kind === "sellHalf" && a.sym === sym && !done[a.id]) return { sell: 0.5, reason: `Coach: chart reads Sell, sold half`, actionId: a.id, once: true };
    if (a.kind === "trim" && a.sym === sym && bookValue > 0) {
      const v = pos.shares * price, w = v / bookValue;
      if (w > a.maxWeight + 0.01) return { sell: r2(1 - (a.maxWeight * bookValue) / v), reason: `Coach: ${sym} was ${(w * 100).toFixed(0)}% of the book, trimmed to ${Math.round(a.maxWeight * 100)}%`, actionId: a.id };
    }
  }
  return null;
}
// the short report shown when the owner clicks the Coach
function summary(p, now = Date.now()) {
  const acts = ((p && p.actions) || []).filter((a) => !a.until || a.until > now);
  return { fixed: acts.map((a) => ({ bot: a.bot, fix: a.fix, why: a.why, since: a.since, until: a.until || null })), noted: (p && p.skipped) || [],
    headline: acts.length ? `${acts.length} fix${acts.length === 1 ? "" : "es"} applied automatically` : "Nothing needed fixing" };
}

module.exports = { plan, sizeFactor, blocked, setupPaused, swingExit, summary, currentLossStreak, SAFE_FUNDS };

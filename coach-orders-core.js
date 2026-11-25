// Market Desk — the owner's chat with the Coach (VP of Finance). Plain-English instructions become standing orders the
// bots obey: "swing bot buy NVDA $3,000", "day trader no shorts", "never buy TSLA for 2 weeks", "pause the quant",
// "half size", "list", "cancel 3". A free rule-based interpreter (no AI model, no paid API): it reads the instruction
// back so the owner can see exactly what it understood, and says plainly when a bot can't do something and why.
// Owner instructions outrank the Coach's own fixes. Pure functions (tests/coach-orders-core.test.js). Paper money only.
"use strict";
const DAY = 864e5;
const BOTS = ["swing", "day", "quant"];
const NAME = { swing: "Swing bot", day: "Day trader", quant: "Quant" };
const r2 = (x) => Math.round(x * 100) / 100;

function fresh() { return { seq: 0, directives: [], chat: [] }; }

// ---- parsing
function botsIn(t) {
  if (/\b(all( the)? bots|every ?(bot|one)|everyone|all of them|all bots)\b/.test(t)) return [...BOTS];
  const out = [];
  if (/\b(swing|swinger|sarah)\b/.test(t)) out.push("swing");
  if (/\b(day ?trader|day bot|day|alex|intraday)\b/.test(t)) out.push("day");
  if (/\b(quant|daniel|allocator)\b/.test(t)) out.push("quant");
  return out;
}
function money(t) {
  const m = t.match(/\$\s?([\d,]+(?:\.\d+)?)\s*(k|m)?\b|\b([\d,]+(?:\.\d+)?)\s*(k|m)?\s*(?:dollars|usd|bucks)\b/) || t.match(/()()\b([\d,]+(?:\.\d+)?)\s*(k|m)\b/);
  if (!m) return null;
  const n = +(m[1] || m[3]).replace(/,/g, ""), u = (m[2] || m[4] || "").toLowerCase();
  return n * (u === "k" ? 1e3 : u === "m" ? 1e6 : 1);
}
function shares(t) { const m = t.match(/\b(\d+(?:\.\d+)?)\s*(shares?|contracts?|units?)\b/); return m ? +m[1] : null; }
function pctOf(t) { const m = t.match(/\b(\d+(?:\.\d+)?)\s*%/); return m ? +m[1] / 100 : null; }
function days(t) {
  const m = t.match(/\bfor\s+(?:the\s+next\s+)?(\d+|a|one|two|three)\s*(day|days|week|weeks|month|months)\b/); if (!m) return null;
  const n = { a: 1, one: 1, two: 2, three: 3 }[m[1]] || +m[1];
  return n * (/week/.test(m[2]) ? 7 : /month/.test(m[2]) ? 30 : 1);
}
const STOP = new Set(["tell", "ask", "have", "get", "make", "let", "can", "could", "would", "should", "will", "you", "i", "i'd", "id", "want", "wanna", "like", "go", "ahead", "kindly", "him", "her", "them", "its", "it's", "is", "be", "do", "that", "this", "some", "shares", "stock", "stocks", "of", "hey", "coach", "yo", "ok", "okay", "just", "also", "then", "right", "away", "immediately", "asap", "today", "tomorrow", "much", "lot", "little", "bit", "new", "position",
  "the", "a", "an", "some", "of", "in", "into", "on", "to", "for", "and", "more", "stock", "shares", "share", "worth", "please", "now", "it", "bot", "swing", "day", "trader", "quant", "all", "bots", "every", "everyone", "me", "my", "dollars", "usd", "anymore", "again", "any", "trading", "contracts", "contract", "units", "unit", "with", "at", "least", "about", "around", "up", "position", "positions"]);
// what's left after the verb, amounts and bot names: a ticker ("NVDA", "$NVDA", "ES=F") or a company name ("apple")
function subject(raw, verbRe) {
  const after = raw.replace(verbRe, " ").replace(/\$\s?[\d,]+(\.\d+)?\s*[km]?\b/gi, " ").replace(/\b\d+(\.\d+)?\s*(k|m|%|shares?|contracts?|units?|dollars|usd|bucks)?\b/gi, " ").replace(/\bfor\s+(the\s+next\s+)?\w+\s+(days?|weeks?|months?)\b/gi, " ");
  const words = after.split(/[\s,.;:!?]+/).filter(Boolean).filter((w) => !STOP.has(w.toLowerCase()) && !/^(sarah|alex|daniel|intraday|allocator)$/i.test(w));
  const tick = words.find((w) => /^\$?[A-Z][A-Z0-9.\-=^]{0,20}$/.test(w) && w.replace("$", "").length <= 21 && w === w.toUpperCase() && /[A-Z]/.test(w));
  if (tick) return { sym: tick.replace(/^\$/, ""), text: tick.replace(/^\$/, "") };
  const text = words.join(" ").trim();
  if (/^[a-z][a-z0-9.\-=^]{0,5}$/i.test(text)) return { sym: null, text, maybeTicker: text.toUpperCase() };
  return text ? { sym: null, text } : null;
}

const VERBS = {
  buy: /\b(buy|invest(?:\s+in)?|purchase|go long(?:\s+on)?|pick up|add)\b/i,
  sell: /\b(sell|exit|close( out)?|dump|out of|liquidate|unload)\b/i,
  avoid: /\b(avoid|never (buy|trade|touch)|don'?t (buy|trade|touch)|do not (buy|trade|touch)|stay away from|stay out of|keep out of|ban|stop buying|no more|blacklist)\b/i,
  allow: /\b(allow|unban|ok to (buy|trade)|you can (buy|trade)|remove the ban on|lift the ban on|whitelist)\b/i,
};
// → {intent, bots, sym?, symText?, amount?, shares?, pct?, days?, factor?, max?, n?} or {intent: "unknown"}
function parse(input) {
  const raw = String(input || "").trim().slice(0, 300), t = raw.toLowerCase();
  if (!t) return { intent: "unknown" };
  const bots = botsIn(t);
  if (/^(help|\?|what can (you|i) (do|say)|commands|examples?)\b/.test(t)) return { intent: "help" };
  if (/\b(list|show|what are)( me)?( my| the| all)?( (current|active|standing))? ?(instructions|orders|rules|directives)\b|^(list|status)$/.test(t)) return { intent: "list" };
  let m = t.match(/\b(cancel|remove|delete|undo|drop)\s+(?:instruction\s+|order\s+|rule\s+|#)?#?(\d+)\b/); if (m) return { intent: "cancel", n: +m[2] };
  if (/\b(cancel|clear|remove|delete|drop)\s+(all|every|everything)\b|\bclear (my )?(instructions|orders|rules)\b/.test(t)) return { intent: "clear", bots };
  if (/\b(allow|resume|ok to|can)\s+(short|shorting|shorts)\b/.test(t)) return { intent: "allowShorts", bots: bots.length ? bots : ["day"] };
  if (/\bno short|\b(don'?t|do not|never|stop|no more)\s+short|\bnot? (to )?short/.test(t)) return { intent: "noShorts", bots: bots.length ? bots : ["day"] };
  if (/\b(resume|unpause|restart|start (trading|buying) again|back to (normal|work)|turn .* back on)\b/.test(t)) return { intent: "resume", bots: bots.length ? bots : [...BOTS] };
  if (/\b(pause|stop (trading|buying)|freeze|halt|sit out|take a break)\b/.test(t)) return { intent: "pause", bots: bots.length ? bots : [...BOTS] };
  if (/\b(normal|full|regular) size\b|\breset (the )?size\b/.test(t)) return { intent: "size", bots: bots.length ? bots : ["swing", "day"], factor: 1 };
  if (/\bhalf (size|sized|the size)\b|\bsmaller (trades|positions|size)\b|\brisk less\b|\breduce (the )?size\b/.test(t)) return { intent: "size", bots: bots.length ? bots : ["swing", "day"], factor: 0.5 };
  m = t.match(/\bsize (?:to |at )?(\d+)\s*%/); if (m) return { intent: "size", bots: bots.length ? bots : ["swing", "day"], factor: Math.min(2, Math.max(0.1, +m[1] / 100)) };
  m = t.match(/\bmax(?:imum)?\s+(?:of\s+)?\$?\s?([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:per|a|each)\s+(trade|position|buy)\b/);
  if (m) return { intent: "maxTrade", bots: bots.length ? bots : ["swing", "day"], max: +m[1].replace(/,/g, "") * (m[2] ? 1e3 : 1) };
  for (const intent of ["avoid", "allow", "sell", "buy"]) {
    if (!VERBS[intent].test(raw)) continue;
    const s = subject(raw, new RegExp(VERBS[intent].source, "gi"));
    if (!s) return { intent: "unknown", why: `Which stock? Try "${intent} NVDA".` };
    return { intent, bots, sym: s.sym, symText: s.text, maybeTicker: s.maybeTicker || null, amount: money(t), shares: shares(t), pct: pctOf(t), days: days(t) };
  }
  return { intent: "unknown" };
}

// ---- applying (the server resolves the symbol first: sym, name, quote ok)
const HELP = [
  "Examples:",
  "• \"swing bot buy NVDA $3,000\" or \"swing bot invest in apple, 10 shares\" — buys at the next fresh price and holds it until you say sell (stops still protect it)",
  "• \"swing bot sell AMD\" — sells it at the next fresh price",
  "• \"never buy TSLA for 2 weeks\" / \"day trader avoid QQQ\" / \"quant avoid TLT\" — keeps that bot (or all) out of it",
  "• \"allow TSLA\" — lifts a ban",
  "• \"day trader no shorts\" / \"allow shorts\"",
  "• \"pause the quant\" / \"resume all bots\"",
  "• \"half size\" / \"normal size\" / \"max $2,000 per trade\"",
  "• \"list\" shows your standing instructions · \"cancel 3\" removes #3 · \"clear all\"",
].join("\n");
const CANT = {
  buy: { day: "The Day trader only takes its own intraday setups and closes within 10 minutes, so it can't hold an investment. Ask the Swing bot instead.", quant: "The Quant only holds its fixed list of ETFs and mega-caps in the weights its model sets. I can make it avoid something, or ask the Swing bot to buy it." },
  size: { quant: "The Quant sizes everything from its volatility target, so I left its size alone." },
  maxTrade: { quant: "The Quant sizes everything from its volatility target, so I left its size alone." },
  noShorts: { swing: "The Swing bot never shorts.", quant: "The Quant never shorts." },
  allowShorts: { swing: "The Swing bot never shorts.", quant: "The Quant never shorts." },
};
function describe(d) {
  const until = d.until ? ` until ${new Date(d.until).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "";
  const who = NAME[d.bot] || d.bot;
  switch (d.kind) {
    case "buy": return `${who}: buy ${d.sym}${d.amount ? ` ($${d.amount.toLocaleString("en-US")})` : d.shares ? ` (${d.shares} shares)` : d.pct ? ` (${Math.round(d.pct * 100)}% of the account)` : " (one normal slot)"} and hold it until you say sell`;
    case "sell": return `${who}: sell all of ${d.sym}`;
    case "avoid": return `${who}: never buy ${d.sym}${until}`;
    case "noShorts": return `${who}: no short selling${until}`;
    case "pause": return `${who}: paused, no new trades${until}`;
    case "size": return `${who}: new trades at ${Math.round(d.factor * 100)}% size`;
    case "maxTrade": return `${who}: at most $${d.max.toLocaleString("en-US")} per new trade`;
    default: return `${who}: ${d.kind}`;
  }
}
const live = (st, now) => st.directives.filter((d) => (d.status === "active" || d.status === "queued") && (!d.until || d.until > now));
function add(st, d, now) { const x = { id: ++st.seq, at: now, status: "active", ...d }; st.directives.push(x); return x; }
function retire(st, pred, status = "replaced", now = Date.now()) { for (const d of live(st, now)) if (pred(d)) { d.status = status; d.ended = now; } }

// p = parse(...); res = {sym, name, ok, why} from the server's symbol lookup. Mutates st; returns the reply text.
function apply(st, p, res = {}, now = Date.now()) {
  if (p.intent === "help") return HELP;
  if (p.intent === "list") { const L = live(st, now); return L.length ? "Your standing instructions:\n" + L.map((d) => `#${d.id} ${describe(d)}${d.status === "queued" ? " — order sent, waiting for a fresh price" : ""}`).join("\n") : "You have no standing instructions. The bots are following their own rules and the Coach's fixes."; }
  if (p.intent === "cancel") { const d = live(st, now).find((x) => x.id === p.n); if (!d) return `There's no active instruction #${p.n}. Say "list" to see them.`; d.status = "cancelled"; d.ended = now; return `Cancelled #${d.id}: ${describe(d)}.`; }
  if (p.intent === "clear") { const L = live(st, now).filter((d) => !p.bots.length || p.bots.includes(d.bot)); L.forEach((d) => { d.status = "cancelled"; d.ended = now; }); return L.length ? `Cleared ${L.length} instruction${L.length > 1 ? "s" : ""}. The bots are back on their own rules.` : "Nothing to clear."; }
  if (p.intent === "unknown") return (p.why ? p.why + "\n\n" : "I didn't catch that. ") + HELP;

  const needsSym = ["buy", "sell", "avoid", "allow"].includes(p.intent);
  if (needsSym && !res.ok) return res.why || `I couldn't find "${p.symText}". Try its ticker, like NVDA.`;
  const sym = res.sym, label = res.name && res.name !== sym ? `${sym} (${res.name})` : sym;
  let bots = p.bots && p.bots.length ? p.bots : p.intent === "buy" || p.intent === "sell" ? ["swing"] : [...BOTS];
  const lines = [], skipped = [];
  for (const bot of bots) {
    const cant = CANT[p.intent] && CANT[p.intent][bot];
    if (cant) { skipped.push(cant); continue; }
    if (p.intent === "buy") {
      retire(st, (d) => d.bot === bot && d.sym === sym && (d.kind === "avoid" || d.kind === "sell" || d.kind === "buy"), "replaced", now);
      const d = add(st, { bot, kind: "buy", sym, amount: p.amount || null, shares: p.shares || null, pct: p.pct || null }, now); lines.push(`#${d.id} ${describe(d)}.`);
    } else if (p.intent === "sell") {
      retire(st, (d) => d.bot === bot && d.sym === sym && (d.kind === "buy" || d.kind === "sell"), "replaced", now);
      if (bot === "quant") { const d = add(st, { bot, kind: "avoid", sym, until: p.days ? now + p.days * DAY : null }, now); lines.push(`#${d.id} ${describe(d)} — it sells at its next rebalance and stays out until you say "allow ${sym}".`); }
      else if (bot === "day") { const d = add(st, { bot, kind: "avoid", sym, until: now + DAY }, now); lines.push(`#${d.id} Day trader: its trades close within minutes on their own; it won't open new ${sym} trades for a day.`); }
      else { const d = add(st, { bot, kind: "sell", sym }, now); lines.push(`#${d.id} ${describe(d)} at the next fresh price.`); }
    } else if (p.intent === "avoid") {
      retire(st, (d) => d.bot === bot && d.sym === sym && (d.kind === "avoid" || d.kind === "buy"), "replaced", now);
      const d = add(st, { bot, kind: "avoid", sym, until: p.days ? now + p.days * DAY : null }, now); lines.push(`#${d.id} ${describe(d)}.`);
    } else if (p.intent === "allow") {
      const before = live(st, now).filter((d) => d.bot === bot && d.sym === sym && d.kind === "avoid").length;
      retire(st, (d) => d.bot === bot && d.sym === sym && d.kind === "avoid", "cancelled", now);
      if (before) lines.push(`${NAME[bot]} may trade ${sym} again.`);
    } else if (p.intent === "noShorts") {
      retire(st, (d) => d.bot === bot && d.kind === "noShorts", "replaced", now);
      const d = add(st, { bot, kind: "noShorts", until: p.days ? now + p.days * DAY : null }, now); lines.push(`#${d.id} ${describe(d)}.`);
    } else if (p.intent === "allowShorts") {
      const n = live(st, now).filter((d) => d.bot === bot && d.kind === "noShorts").length;
      retire(st, (d) => d.bot === bot && d.kind === "noShorts", "cancelled", now); lines.push(n ? `${NAME[bot]} may short again.` : `${NAME[bot]} had no short ban.`);
    } else if (p.intent === "pause") {
      retire(st, (d) => d.bot === bot && d.kind === "pause", "replaced", now);
      const d = add(st, { bot, kind: "pause", until: p.days ? now + p.days * DAY : null }, now); lines.push(`#${d.id} ${describe(d)} (it still manages and protects what it holds).`);
    } else if (p.intent === "resume") {
      const n = live(st, now).filter((d) => d.bot === bot && d.kind === "pause").length;
      retire(st, (d) => d.bot === bot && d.kind === "pause", "cancelled", now); lines.push(n ? `${NAME[bot]} is trading again.` : `${NAME[bot]} wasn't paused.`);
    } else if (p.intent === "size") {
      retire(st, (d) => d.bot === bot && d.kind === "size", "replaced", now);
      if (p.factor === 1) lines.push(`${NAME[bot]}: back to normal size.`);
      else { const d = add(st, { bot, kind: "size", factor: p.factor }, now); lines.push(`#${d.id} ${describe(d)}.`); }
    } else if (p.intent === "maxTrade") {
      retire(st, (d) => d.bot === bot && d.kind === "maxTrade", "replaced", now);
      const d = add(st, { bot, kind: "maxTrade", max: p.max }, now); lines.push(`#${d.id} ${describe(d)}.`);
    }
  }
  if (p.intent === "allow" && !lines.length) lines.push(`No bot was banned from ${sym}.`);
  const head = needsSym && res.name && res.name !== sym ? `Got it — ${label}.\n` : "Got it.\n";
  return (lines.length ? head + lines.join("\n") : "") + (skipped.length ? (lines.length ? "\n" : "") + [...new Set(skipped)].join("\n") : "");
}

// ---- what the bots ask (owner instructions outrank the Coach's fixes)
const activeFor = (st, bot, kind, now = Date.now()) => (st ? live(st, now).filter((d) => d.bot === bot && d.kind === kind) : []);
const blocked = (st, bot, sym, now) => activeFor(st, bot, "avoid", now).some((d) => d.sym === sym);
const paused = (st, bot, now) => activeFor(st, bot, "pause", now).length > 0;
const noShorts = (st, bot, now) => activeFor(st, bot, "noShorts", now).length > 0;
const sizeFactor = (st, bot, now) => activeFor(st, bot, "size", now).reduce((f, d) => f * d.factor, 1);
const maxTrade = (st, bot, now) => { const L = activeFor(st, bot, "maxTrade", now); return L.length ? Math.min(...L.map((d) => d.max)) : Infinity; };
const buys = (st, bot, now) => activeFor(st, bot, "buy", now);
const sells = (st, bot, now) => activeFor(st, bot, "sell", now);
// how much a buy instruction spends: its amount, its shares × price, its % of the account, or one normal slot
function buyAmount(d, { price, accountValue, slot }) {
  if (d.amount) return d.amount;
  if (d.shares && price > 0) return d.shares * price;
  if (d.pct && accountValue > 0) return r2(d.pct * accountValue);
  return slot;
}
function chat(st, who, text, now = Date.now()) { st.chat.push({ t: now, who, text: String(text).slice(0, 2000) }); if (st.chat.length > 200) st.chat.splice(0, st.chat.length - 200); }

module.exports = { BOTS, NAME, fresh, parse, apply, describe, live, blocked, paused, noShorts, sizeFactor, maxTrade, buys, sells, buyAmount, chat, HELP };

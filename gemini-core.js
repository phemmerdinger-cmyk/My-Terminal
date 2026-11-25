// Market Desk — Google Gemini on its free tier (Google AI Studio key, no card, no billing). Pure helpers: request bodies,
// model choice, reading answers, and turning a chat message into a checked instruction for the Coach. The network call
// lives in server.js behind a daily cap. Gemini only *reads* the owner's English: every instruction it extracts still
// goes through coach-orders-core.js's rules, so the AI can't make a bot do anything those rules don't allow.
// Note for the owner: keep billing OFF on the Google project; without billing the API can't charge anything.
"use strict";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

// Model names change often (3.5 / 3.6 / 3.7 Flash…), so ask the API which ones this key can use and pick the newest
// plain "Flash" text model. Falls back to Google's moving alias.
// Backups to try when the first model is overloaded (503) or rate-limited: older flash models, then flash-lite.
function backupModels(list, first) {
  const ms = ((list && list.models) || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => String(m.name || "").replace(/^models\//, ""));
  const v = (n) => parseFloat(n.split("-")[1]) || 0;
  const plain = ms.filter((n) => /^gemini-[\d.]+-flash$/.test(n)).sort((a, b) => v(b) - v(a));
  const lite = ms.filter((n) => /^gemini-[\d.]+-flash-lite$/.test(n)).sort((a, b) => v(b) - v(a));
  return [...new Set([...plain, ...lite, "gemini-flash-latest"])].filter((n) => n !== first).slice(0, 3);
}
const retryable = (status) => status === 429 || status === 500 || status === 503 || status === 504;
function pickModel(list) {
  const ms = ((list && list.models) || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => String(m.name || "").replace(/^models\//, ""));
  const plain = ms.filter((n) => /^gemini-[\d.]+-flash$/.test(n)).sort((a, b) => parseFloat(b.split("-")[1]) - parseFloat(a.split("-")[1]));
  if (plain.length) return plain[0];
  const flash = ms.filter((n) => /flash/.test(n) && !/image|tts|live|audio|embed|vision|exp|preview/.test(n));
  return flash[0] || "gemini-flash-latest";
}

// Newer Gemini models "think" first, and that thinking counts against maxOutputTokens, so the budget is generous
// (the answer itself is kept short by the instructions, not by this cap).
function body({ system, text, history = [], schema = null, maxTokens = 700 }) {
  const contents = [...history.slice(-8).map((m) => ({ role: m.who === "you" ? "user" : "model", parts: [{ text: String(m.text).slice(0, 1500) }] })), { role: "user", parts: [{ text: String(text).slice(0, 4000) }] }];
  return { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents,
    generationConfig: { temperature: schema ? 0 : 0.4, maxOutputTokens: Math.max(4096, maxTokens), ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}) } };
}
function jsonOf(text) {
  const t = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]);
  throw new Error("Gemini's reply wasn't readable JSON");
}
function textOf(j) {
  const c = j && j.candidates && j.candidates[0];
  const t = ((c && c.content && c.content.parts) || []).map((p) => p.text || "").join("").trim();
  if (!t) throw new Error(c && c.finishReason ? `Gemini returned no text (${c.finishReason})` : "Gemini returned no text");
  return t;
}
// Friendly error for the owner from an HTTP status
function errorFor(status, j) {
  const msg = j && j.error && j.error.message ? String(j.error.message).slice(0, 160) : "";
  if (status === 429) return "Gemini's free daily limit is used up for now; I'll use the basic interpreter until it resets.";
  if (status === 400 && /api key/i.test(msg)) return "The Gemini key isn't valid. Check GEMINI_API_KEY on Render.";
  if (status === 403) return "Google refused the Gemini key (403). Check that the key is from Google AI Studio and the Generative Language API is enabled.";
  return `Gemini error ${status}${msg ? ": " + msg : ""}`;
}

// ---- reading a Coach chat message
const INTENTS = ["buy", "sell", "avoid", "allow", "noShorts", "allowShorts", "pause", "resume", "size", "maxTrade", "list", "cancel", "clear", "help", "question", "chat"];
const BOT_IDS = ["swing", "day", "quant"];
const COACH_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: { type: "STRING", enum: INTENTS, description: "What the owner wants. 'question' = asks something about the bots/markets; 'chat' = greeting or small talk." },
    bots: { type: "ARRAY", items: { type: "STRING", enum: BOT_IDS }, description: "Which bots it applies to: swing = Swing bot/swing trader, day = Day trader, quant = Quant. Empty if not said; all three if 'all bots'." },
    ticker: { type: "STRING", description: "Ticker symbol if the owner gave one or it is obvious (NVDA for Nvidia). Empty if unsure." },
    company: { type: "STRING", description: "The company/asset name as the owner wrote it, if any." },
    amount: { type: "NUMBER", description: "Dollar amount to invest, if given (2k = 2000)." },
    shares: { type: "NUMBER", description: "Number of shares/contracts, if given." },
    percent: { type: "NUMBER", description: "Percent of the account, as a number 0-100, if given." },
    days: { type: "NUMBER", description: "How many days a ban/pause should last, if given (2 weeks = 14)." },
    sizePercent: { type: "NUMBER", description: "For intent size: new trade size as a percent of normal (half = 50, normal = 100)." },
    maxDollars: { type: "NUMBER", description: "For intent maxTrade: the dollar cap per trade." },
    instructionNumber: { type: "NUMBER", description: "For intent cancel: the instruction number." },
  },
  required: ["intent"],
};
const COACH_SYSTEM = "You read messages that a trader sends to the Coach, the VP of Finance of their paper-trading bots (Swing bot, Day trader, Quant). " +
  "Classify the message into one instruction and its details. Never invent a ticker you are not sure of; leave it empty and fill 'company'. " +
  "Examples: 'tell swing trader to buy nvda' -> buy, [swing], NVDA. 'keep everyone out of tesla for two weeks' -> avoid, [swing,day,quant], TSLA, days 14. " +
  "'why is the day trader losing?' -> question. 'stop the quant for now' -> pause, [quant]. 'only half size from now on' -> size, sizePercent 50.";

const clampN = (x, lo, hi) => (Number.isFinite(+x) && +x > lo && +x <= hi ? +x : null);
// Gemini's JSON → the same shape coach-orders-core.parse() returns, with every field checked
function toParse(a) {
  const intent = INTENTS.includes(a && a.intent) ? a.intent : "unknown";
  const bots = [...new Set(((a && a.bots) || []).filter((b) => BOT_IDS.includes(b)))];
  const tick = String((a && a.ticker) || "").toUpperCase().replace(/^\$/, "").trim();
  const sym = /^[A-Z0-9^][A-Z0-9.\-=]{0,20}$/.test(tick) ? tick : null;
  const company = String((a && a.company) || "").trim().slice(0, 60);
  const p = { intent, bots, sym: null, maybeTicker: sym, symText: company || sym || "", amount: clampN(a && a.amount, 0, 1e8), shares: clampN(a && a.shares, 0, 1e9),
    pct: clampN(a && a.percent, 0, 100) != null ? +a.percent / 100 : null, days: clampN(a && a.days, 0, 3650) };
  if (intent === "size") p.factor = Math.min(2, Math.max(0.1, (clampN(a && a.sizePercent, 0, 1000) ?? 100) / 100));
  if (intent === "maxTrade") { p.max = clampN(a && a.maxDollars, 0, 1e8); if (!p.max) p.intent = "unknown"; }
  if (intent === "cancel") { p.n = clampN(a && a.instructionNumber, 0, 1e6); if (!p.n) p.intent = "unknown"; }
  if (["pause", "resume"].includes(p.intent) && !bots.length) p.bots = [...BOT_IDS];
  if (["noShorts", "allowShorts"].includes(p.intent) && !bots.length) p.bots = ["day"];
  if (p.intent === "size" && !bots.length) p.bots = ["swing", "day"];
  if (p.intent === "maxTrade" && !bots.length) p.bots = ["swing", "day"];
  if (["buy", "sell", "avoid", "allow"].includes(p.intent) && !p.symText) p.intent = "unknown";
  return p;
}
const ANSWER_SYSTEM = "Write plain text only: no markdown, no ** bold, no headings; use '- ' for bullets. " + "You are the Coach, VP of Finance for the owner's paper-trading bots (Swing bot, Day trader, Quant; paper money only). " +
  "Answer the owner's question in plain English using ONLY the data below and general market knowledge. Be specific and short (under 150 words), cite numbers from the data, " +
  "say plainly when the data doesn't show something, and never claim a trade happened unless the data shows it. This is not financial advice. " +
  "If the owner seems to want a bot to do something, tell them the exact words to type (e.g. 'swing bot buy NVDA $2,000').";

module.exports = { BASE, pickModel, backupModels, retryable, body, textOf, jsonOf, errorFor, COACH_SCHEMA, COACH_SYSTEM, ANSWER_SYSTEM, toParse, INTENTS };

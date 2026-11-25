const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../gemini-core.js");

test("picks the newest plain Flash text model the key can use", () => {
  const list = { models: [
    { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.7-flash-image", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.8-pro", supportedGenerationMethods: ["generateContent"] },
    { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
  ] };
  assert.equal(G.pickModel(list), "gemini-3.7-flash");
  assert.equal(G.pickModel({ models: [{ name: "models/gemini-flash-lite-latest", supportedGenerationMethods: ["generateContent"] }] }), "gemini-flash-lite-latest");
  assert.equal(G.pickModel({}), "gemini-flash-latest");
});

test("request bodies and answers", () => {
  const b = G.body({ system: "S", text: "hi", history: [{ who: "you", text: "a" }, { who: "coach", text: "b" }], schema: { type: "OBJECT" } });
  assert.deepEqual(b.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(b.generationConfig.responseMimeType, "application/json"); assert.equal(b.generationConfig.temperature, 0);
  assert.equal(G.textOf({ candidates: [{ content: { parts: [{ text: "Hello" }, { text: " there" }] } }] }), "Hello there");
  assert.throws(() => G.textOf({ candidates: [{ finishReason: "SAFETY" }] }), /SAFETY/);
  assert.match(G.errorFor(429), /free daily limit/);
});

test("Gemini's reading is checked before the Coach acts on it", () => {
  const p = G.toParse({ intent: "buy", bots: ["swing", "robot"], ticker: "nvda", amount: 2000 });
  assert.deepEqual([p.intent, p.bots, p.maybeTicker, p.amount], ["buy", ["swing"], "NVDA", 2000]);
  assert.equal(G.toParse({ intent: "avoid", bots: ["swing", "day", "quant"], company: "Tesla", days: 14 }).symText, "Tesla");
  assert.equal(G.toParse({ intent: "delete_everything" }).intent, "unknown", "only known instructions");
  assert.equal(G.toParse({ intent: "buy", ticker: "DROP TABLE;" }).intent, "unknown", "junk tickers are dropped");
  assert.equal(G.toParse({ intent: "size", sizePercent: 50 }).factor, 0.5);
  assert.deepEqual(G.toParse({ intent: "pause" }).bots, ["swing", "day", "quant"]);
  assert.equal(G.toParse({ intent: "maxTrade" }).intent, "unknown", "a cap needs a number");
  assert.equal(G.toParse({ intent: "buy", ticker: "AAPL", amount: -5 }).amount, null);
  assert.equal(G.toParse({ intent: "question" }).intent, "question");
});

test("if Gemini can't be reached, the Coach chat falls back to the free interpreter", async () => {
  const { spawn } = require("node:child_process"), path = require("node:path"), fs = require("node:fs"), os = require("node:os");
  const port = 39900 + Math.floor(Math.random() * 90), TMP = fs.mkdtempSync(path.join(os.tmpdir(), "md-gem-"));
  const env = { ...process.env, PORT: String(port), SITE_PASSWORD: "gem-test-pw-123", GEMINI_API_KEY: "not-a-real-key", GEMINI_MODEL: "gemini-test", FINNHUB_API_KEY: "", ANTHROPIC_API_KEY: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", SPIDER_OFF: "1", AP_TEST: "closed", TMPDIR: TMP };
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/health"); break; } catch { await new Promise((ok) => setTimeout(ok, 200)); } }
    const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.6" }, body: JSON.stringify({ password: "gem-test-pw-123" }) });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const r = await (await fetch(base + "/api/coach/chat", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "day trader no shorts" }), signal: AbortSignal.timeout(40_000) })).json();
    assert.match(r.reply, /Day trader: no short selling/); assert.equal(r.via, "rules"); assert.equal(r.ai.on, true);
  } finally { srv.kill(); }
});

test("thinking models get room to answer, and JSON is read even when wrapped", () => {
  assert.ok(G.body({ text: "x", maxTokens: 300 }).generationConfig.maxOutputTokens >= 4096);
  assert.deepEqual(G.jsonOf('```json\n{"intent":"chat"}\n```'), { intent: "chat" });
  assert.deepEqual(G.jsonOf('Sure! {"intent":"buy","ticker":"NVDA"}'), { intent: "buy", ticker: "NVDA" });
  assert.throws(() => G.jsonOf("no json here"), /readable/);
});

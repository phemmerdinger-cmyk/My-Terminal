// Credential-exposure check: no API keys, tokens or passwords committed to the repository.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"), path = require("node:path");
const ROOT = path.join(__dirname, "..");
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === ".git" || e.name === "node_modules" ? [] : e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
const PATTERNS = [[/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"], [/\bghp_[A-Za-z0-9]{30,}/, "GitHub token"], [/\bAKIA[0-9A-Z]{16}\b/, "AWS key"], [/UPSTASH_REDIS_REST_TOKEN\s*[=:]\s*["']?[A-Za-z0-9]{20,}/, "Upstash token"], [/FINNHUB_API_KEY\s*[=:]\s*["']?[a-z0-9]{15,}/, "Finnhub key"], [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "private key"]];
test("no credentials are committed", () => {
  const hits = [];
  for (const f of files(ROOT)) { if (/\.(png|ico|jpg|gif)$/.test(f)) continue; const t = fs.readFileSync(f, "utf8"); for (const [re, what] of PATTERNS) if (re.test(t)) hits.push(`${path.relative(ROOT, f)}: ${what}`); }
  assert.deepEqual(hits, []);
});
test(".env files are ignored by git", () => { assert.match(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"), /^\.env$/m); });

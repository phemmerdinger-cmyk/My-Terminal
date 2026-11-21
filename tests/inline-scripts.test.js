// Every inline <script> in index.html must at least parse (a syntax error there blanks the whole site).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");

test("index.html inline scripts parse", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type="(application\/ld\+json|module)"/.test(m[1]));
  assert.ok(blocks.length > 0);
  for (const [, , code] of blocks) assert.doesNotThrow(() => new vm.Script(code), code.slice(0, 80));
});

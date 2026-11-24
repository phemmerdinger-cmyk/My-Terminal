"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const L = require("../public/lazy-core.js");

test("each tool group lists its scripts in dependency order", () => {
  const q = L.GROUPS.quant, s = L.GROUPS.studio;
  assert.ok(q.indexOf("/quant.js") < q.indexOf("/quant-ui.js"), "Backtest UI needs the QUANT engine");
  assert.ok(q.indexOf("/qmath.js") < q.indexOf("/quant-lab.js"), "Quant Lab needs QMATH");
  assert.deepEqual(s.slice(0, q.length), [...q], "Studio reuses the Quant engine first");
  assert.ok(s.indexOf("/studio-core.js") < s.indexOf("/studio.js"));
  for (const list of Object.values(L.GROUPS)) for (const src of list)
    assert.ok(fs.existsSync(path.join(__dirname, "..", "public", src)), src + " exists");
});

test("tabs map to the group they need", () => {
  assert.equal(L.groupForTab("quant"), "quant");
  assert.equal(L.groupForTab("backtest"), "quant");
  assert.equal(L.groupForTab("studio-graph"), "studio");
  assert.equal(L.groupForTab("workspace"), null, "the Workspace tab was removed");
  assert.equal(L.groupForTab("news"), null);
  assert.equal(L.groupForTab(undefined), null);
});

test("the loader fetches each script once, in order, and retries after a failure", async () => {
  const added = []; let fail = new Set(["/qmath.js"]);
  const doc = { createElement: () => ({}), body: { appendChild: (s) => { added.push(s.src); setTimeout(() => (fail.has(s.src) ? s.onerror() : s.onload()), 0); } } };
  const loader = L.createLoader(doc);
  await assert.rejects(loader.load("quant"), /qmath/);
  assert.deepEqual(added, ["/quant.js", "/quant-batch.js", "/quant-ui.js", "/qmath.js"]);
  fail = new Set();
  await loader.load("quant");
  assert.deepEqual(added.slice(4), ["/qmath.js", "/quant-lab.js"], "already-loaded files are not fetched again");
  await loader.load("studio");
  assert.deepEqual(added.slice(6), ["/studio-core.js", "/studio-strategies.js", "/studio.js", "/market-charts.js"]);
  assert.equal(L.GROUPS.quant.every(loader.loaded), true);
});

test("the page loads tools on demand and keeps the spider out of the demo", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  for (const src of [...L.GROUPS.studio, ...L.GROUPS.web]) assert.ok(!html.includes(`<script src="${src}"`), src + " is not loaded eagerly");
  assert.ok(html.indexOf('src="/lazy-core.js"') < html.indexOf("function setTab("));
  assert.ok(html.includes('if(!VIEW){ const web=()=>L.load("web")'), "THE WEB loads for the owner only");
});

test("the Morning brief pop-up loads the teamwork UI on demand", () => {
  const L = require("../public/lazy-core.js");
  assert.equal(L.groupForTab("brief"), null, "the brief is a pop-up, not a tab");
  assert.deepEqual([...L.GROUPS.team], ["/coach-core.js", "/teamwork.js"]);
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "../public/index.html"), "utf8");
  assert.ok(!html.includes('<script src="/teamwork.js"'), "teamwork.js is not loaded eagerly");
});

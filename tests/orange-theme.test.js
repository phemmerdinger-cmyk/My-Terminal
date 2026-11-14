"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..","public");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"orange-theme.css"),"utf8");
const studio=fs.readFileSync(path.join(root,"studio.js"),"utf8");
test("global black-orange stylesheet is loaded after existing inline and feature CSS",()=>{
 const marker='<link rel="stylesheet" href="/orange-theme.css?v=1">';
 assert.equal(html.split(marker).length,2);
 assert.ok(html.indexOf(marker)>html.indexOf("</style>"));
 for(const sheet of ["studio.css","reader.css","quant.css","web.css","health.css"])
   assert.ok(html.indexOf(marker)>html.indexOf('href="/'+sheet+'"'),sheet);
});
test("orange palette covers shell, studio, news and quant while preserving gains/losses",()=>{
 for(const selector of [":root{","header{","nav.tabs","#tab-studio .mds-hero","#tab-studio .mds-strategy-card","#rdr{",".qb-five{",".md-example-starter"])
  assert.ok(css.includes(selector),selector);
 assert.ok(css.includes("--orange:#ff991f"));
 assert.ok(css.includes("--up:#22c68a"));
 assert.ok(css.includes("--down:#fa5967"));
 assert.ok(css.includes("prefers-reduced-motion"));
});
test("studio appearance defaults to orange and still has a reversible legacy option",()=>{
 assert.ok(studio.includes('color: "amber", motion: "system"'));
 assert.ok(studio.includes('value="amber">Black &amp; orange'));
 assert.ok(studio.includes('value="cyan">Legacy cyber cyan'));
});

"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..","public");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"orange-theme.css"),"utf8");
const studio=fs.readFileSync(path.join(root,"studio.js"),"utf8");
test("global black-green stylesheet is loaded after existing inline and feature CSS",()=>{
 const marker='<link rel="stylesheet" href="/orange-theme.css?v=3">';
 assert.equal(html.split(marker).length,2);
 assert.ok(html.indexOf(marker)>html.indexOf("</style>"));
 for(const sheet of ["studio.css","reader.css","quant.css","web.css","health.css"])
   assert.ok(html.indexOf(marker)>html.indexOf('href="/'+sheet+'"'),sheet);
});
test("military-green palette covers shell, studio, news and quant while preserving gains/losses",()=>{
 for(const selector of [":root{","header{","nav.tabs","#tab-studio .mds-hero","#tab-studio .mds-strategy-card","#rdr{",".qb-five{",".md-example-starter"])
  assert.ok(css.includes(selector),selector);
 assert.ok(css.includes("--orange:#879f55"));
 assert.ok(css.includes("--up:#22c68a"));
 assert.ok(css.includes("--down:#fa5967"));
 assert.ok(css.includes("prefers-reduced-motion"));
});
test("studio appearance defaults to military green and still has a reversible legacy option",()=>{
 assert.ok(studio.includes('color: "amber", motion: "system"'));
 assert.ok(studio.includes('value="amber">Black &amp; military green'));
 assert.ok(studio.includes('value="cyan">Legacy cyber cyan'));
});

test("both owner and visitor tab favicons are green and not the legacy pink/orange",()=>{
 const visitor=fs.readFileSync(path.join(root,"favicon-visitor.svg"),"utf8");
 const owner=fs.readFileSync(path.join(root,"favicon-owner.svg"),"utf8");
 assert.ok(visitor.includes("#91ad65"));assert.ok(owner.includes("#91ad65"));
 assert.ok(!visitor.includes("#ff9e1b"));assert.ok(!owner.includes("#ff4fa3"));
 assert.ok(html.includes("/favicon-visitor.svg?v=4"));assert.ok(html.includes("/favicon-owner.svg?v=4"));
 assert.ok(html.includes("%2391ad65"));
});
test("moving Spider and navbar spider button use green instead of orange",()=>{
 const web=fs.readFileSync(path.join(root,"web.js"),"utf8");
 assert.ok(web.includes("#a9c77b"));
 assert.ok(web.includes("#7f9c50"));
 assert.ok(css.includes(".tw-crawler .sp-leg-core"));
 assert.ok(css.includes(".sp-btn .sp-ico"));
});

test("no bright blue or cyan accent colors remain in terminal stylesheets",()=>{
 const files=["index.html","web.css","studio.css","quant.css","reader.css","quant-batch.css","orange-theme.css"];
 const hex=/#([0-9a-f]{6})(?:[0-9a-f]{2})?\b/gi;
 for(const name of files){
  let source=fs.readFileSync(path.join(root,name),"utf8");
  if(name==="index.html")source=source.split("<style>")[1].split("</style>")[0];
  for(const match of source.matchAll(hex)){
   const v=match[1],r=parseInt(v.slice(0,2),16),g=parseInt(v.slice(2,4),16),b=parseInt(v.slice(4,6),16);
   const hi=Math.max(r,g,b),lo=Math.min(r,g,b);
   assert.ok(!(b>145&&b>r*1.35&&b>g*1.18&&hi-lo>65),name+": #"+v);
  }
 }
});

"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..","public");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const css=fs.readFileSync(path.join(root,"orange-theme.css"),"utf8");
const studio=fs.readFileSync(path.join(root,"studio.js"),"utf8");
test("global black-and-orange stylesheet is loaded after existing inline and feature CSS",()=>{
 const marker='<link rel="stylesheet" href="/orange-theme.css?v=4">';
 assert.equal(html.split(marker).length,2);
 assert.ok(html.indexOf(marker)>html.indexOf("</style>"));
 for(const sheet of ["studio.css","reader.css","quant.css","web.css","health.css"])
   assert.ok(html.indexOf(marker)>html.indexOf('href="/'+sheet+'"'),sheet);
});
test("orange palette covers shell, studio, news and quant while preserving gains/losses",()=>{
 for(const selector of [":root{","header{","nav.tabs","#tab-studio .mds-hero","#tab-studio .mds-strategy-card","#rdr{",".qb-five{",".md-example-starter"])
  assert.ok(css.includes(selector),selector);
 assert.ok(css.includes("--orange:#ff991f"));
 assert.ok(css.includes("--up:#22c68a"),"gains stay green");
 assert.ok(css.includes("--down:#fa5967"),"losses stay red");
 assert.ok(css.includes("prefers-reduced-motion"));
});
// Military/olive green (hue 60-125°) may only appear in data palettes, never as the theme accent
const olive=(v)=>{const r=parseInt(v.slice(0,2),16)/255,g=parseInt(v.slice(2,4),16)/255,b=parseInt(v.slice(4,6),16)/255,
 mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2,d=mx-mn; if(!d) return false; const s=d/(1-Math.abs(2*l-1));
 let h=mx===r?((g-b)/d)%6:mx===g?(b-r)/d+2:(r-g)/d+4; h=(h*60+360)%360; return h>=60&&h<=125&&s>=.12&&l>=.12&&l<=.92;};
test("no olive-green accents remain in the theme stylesheets",()=>{
 for(const name of ["orange-theme.css","web.css","studio.css","quant.css","reader.css","quant-batch.css","market-charts.css"]){
  const source=fs.readFileSync(path.join(root,name),"utf8");
  for(const m of source.matchAll(/#([0-9a-f]{6})\b/gi)) assert.ok(!olive(m[1]),name+": #"+m[1]);
 }
});
test("studio appearance defaults to black and orange and still has a reversible legacy option",()=>{
 assert.ok(studio.includes('color: "amber", motion: "system"'));
 assert.ok(studio.includes('value="amber">Black &amp; orange'));
 assert.ok(studio.includes('value="cyan">Legacy cyber cyan'));
});
test("owner and visitor tab favicons are orange",()=>{
 const visitor=fs.readFileSync(path.join(root,"favicon-visitor.svg"),"utf8");
 const owner=fs.readFileSync(path.join(root,"favicon-owner.svg"),"utf8");
 for(const svg of [visitor,owner]) for(const m of svg.matchAll(/#([0-9a-f]{6})\b/gi)) assert.ok(!olive(m[1]),"#"+m[1]);
 assert.ok(html.includes("/favicon-visitor.svg?v=5"));assert.ok(html.includes("/favicon-owner.svg?v=5"));
 assert.ok(!html.includes("%2391ad65"));
});
test("moving Spider and navbar spider button use orange",()=>{
 const web=fs.readFileSync(path.join(root,"web.js"),"utf8");
 const spider=web.slice(web.indexOf('id="spAbd"'),web.indexOf('id="spAbd"')+900);
 for(const m of spider.matchAll(/#([0-9a-f]{6})\b/gi)) assert.ok(!olive(m[1]),"spider #"+m[1]);
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

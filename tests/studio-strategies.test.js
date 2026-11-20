"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../public/studio-strategies.js");
const Q = require("../public/quant.js");
test("all 14 strategy examples link to implemented quant models, unique IDs and valid assumptions",()=>{
  assert.equal(L.CATALOG.length,14);
  assert.deepEqual(L.validateCatalog(Q),[]);
  const types=new Set(L.CATALOG.map(s=>s.strategy));
  for(const model of ["momentum","meanrev","rsi","smacross","multifactor","riskparity","rebalance","buyhold"])
    assert.ok(types.has(model));
  for(const x of L.CATALOG){
    const s=L.makeSpec(x,new Date("2026-11-14T18:00:00Z"));
    assert.equal(s.benchmark,"SPY");assert.equal(s.from,"2021-11-14");assert.equal(s.to,"2026-11-14");
    assert.equal(s.initial,10000);assert.equal(s.costs.spreadBps,5);assert.equal(s.costs.slippageBps,5);
    assert.ok(s.limits.maxWeight<=1);
    assert.ok(s.limits.minCash>=0);
  }
});
test("every strategy example can be executed by actual QUANT.run using deterministic test-only fixture history",()=>{
  const universe=[...new Set(L.CATALOG.flatMap(x=>x.universe).concat("SPY"))];
  const t=[];
  for(let dt=Date.UTC(2019,0,1)/1000;dt<=Date.UTC(2026,11,31)/1000;dt+=86400){
    const day=new Date(dt*1000).getUTCDay();if(day!==0 && day!==6)t.push(dt);
  }
  let x=1;const series={};
  for(const symbol of universe){
    x++;
    const close=t.map((_,i)=>Math.max(1,80*Math.exp(i*(.00007+(x%8)*.000025)+Math.sin(i/(13+x))*0.05+Math.cos(i/37+x)*0.03)));
    series[symbol]={t,close,adj:close};
  }
  for(const model of L.CATALOG){
    const spec=L.makeSpec(model,new Date("2026-11-14T18:00:00Z"));
    const r=Q.run({...spec,series,from:Date.parse(spec.from)/1000,to:Date.parse(spec.to+"T23:59:59Z")/1000});
    assert.equal(r.kind,"backtest",model.id);
    assert.ok(r.equity.length>1000,model.id);
    assert.ok(Number.isFinite(r.metrics.totalReturn),model.id);
    assert.ok(Number.isFinite(r.metrics.finalValue),model.id);
    assert.deepEqual(r.assumptions.costs,spec.costs,model.id);
    assert.ok(Array.isArray(r.trades),model.id);
  }
});
test("studio header no longer receives fixed-height global header CSS and includes real-strategy results",()=>{
  const root=path.join(__dirname,"..","public");
  const js=fs.readFileSync(path.join(root,"studio.js"),"utf8");
  const css=fs.readFileSync(path.join(root,"studio.css"),"utf8");
  const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
  const backtest=fs.readFileSync(path.join(root,"quant-ui.js"),"utf8");
  assert.ok(!js.includes('<header class="mds-hero">'));
  assert.ok(css.includes('#tab-studio .mds-hero{display:flex;flex-direction:column'));
  assert.ok(css.includes('height:auto;min-height:0'));
  assert.ok(css.includes('.mds-strategy-grid'));
  const G=require("../public/lazy-core.js").GROUPS.studio; // loaded on demand when a Studio tool opens
  assert.ok(G.includes("/studio-strategies.js"));
  assert.ok(G.indexOf("/studio-strategies.js")<G.indexOf("/studio.js"));
  assert.ok(html.includes('src="/empty-examples.js"'));
  assert.ok(js.includes('window.QUANT.run'));
  assert.ok(js.includes('window.MD.hist'));
  assert.ok(backtest.includes('md_qb_pending_spec_v1'));
  assert.ok(backtest.includes('fillStudioSpec'));
});
test("starter examples never fabricate market data or automatically modify a portfolio",()=>{
  const s=fs.readFileSync(path.join(__dirname,"..","public/empty-examples.js"),"utf8");
  assert.ok(s.includes('function empty(type)'));
  assert.ok(s.includes('case "fin"'));
  assert.ok(s.includes('case "dcf"'));
  assert.ok(s.includes('case "portfolio"'));
  assert.ok(s.includes('case "risk"'));
  assert.ok(s.includes('case "backtest"'));
  assert.ok(!s.includes('addHolding('));
  assert.ok(!s.includes('/api/predict'));
});

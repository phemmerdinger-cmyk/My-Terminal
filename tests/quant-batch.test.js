"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const B = require("../public/quant-batch.js");
const Q = require("../public/quant.js");
const TODAY = "2026-11-14T18:00:00Z";
const build = (random) => B.generateFive({today:TODAY,random});
test("five independently selected experiments with no duplicate strategy", () => {
  const x = build(() => .347);
  assert.equal(x.length,5);
  assert.equal(new Set(x.map(v => v.id)).size,5);
  assert.equal(new Set(x.map(v => v.spec.strategy)).size,5);
  assert.equal(x.every(v => v.spec.from === x[0].spec.from && v.spec.to === x[0].spec.to),true);
  assert.equal(x[0].spec.benchmark,"SPY");
  assert.equal(x[0].spec.initial,10000);
  assert.deepEqual(x[0].spec.costs,{commissionBps:0,spreadBps:5,slippageBps:5});
});
test("the generator uses genuine choices but is reproducible when a random source is injected", () => {
  const a=build(()=>.01),b=build(()=>.01),c=build(()=>.97);
  assert.deepEqual(a,b);
  assert.notDeepEqual(a.map(x=>x.id),c.map(x=>x.id));
  assert.equal(a[0].spec.from,"2021-11-14");
  assert.equal(a[0].spec.to,"2026-11-14");
});
test("all possible selected strategies have valid parameter choices and unlevered limits", () => {
  for (const pick of [0,.12,.3,.55,.9,.999999]) {
    for (const x of build(()=>pick)) {
      const s=x.spec;
      assert.ok(Q.STRATEGIES[s.strategy]);
      assert.equal(s.universe.length>=4,true);
      assert.equal(s.universe.length<=15,true);
      assert.equal(new Set(s.universe).size,s.universe.length);
      assert.ok(s.limits.maxWeight<=1 && s.limits.minCash>=0);
      assert.ok(s.params.top==null || s.params.top<=s.universe.length);
      assert.ok(s.params.fast==null || s.params.fast<s.params.slow);
      assert.ok(s.params.buy==null || s.params.buy<s.params.sell);
      if(s.weights)assert.deepEqual(Object.keys(s.weights).sort(),s.universe.slice().sort());
    }
  }
});
function sampleHist() {
  const symbols=new Set([...B.CANDIDATES.flatMap(x=>x.universe),"SPY"]);
  const series={};
  const ts=[];
  for(let day=Date.UTC(2019,0,1)/1000;day<=Date.UTC(2026,11,31)/1000;day+=86400){
    const dow=new Date(day*1000).getUTCDay();
    if(dow!==0&&dow!==6)ts.push(day);
  }
  let j=0;
  for(const sym of symbols){
    j++;
    const close=ts.map((t,i)=>Math.max(5,50*Math.exp(.00016*i+(j%7)*.000032*i + .06*Math.sin(i/(11+j)) + .04*Math.cos(i/29+j))));
    series[sym]={t:ts,close,adj:close};
  }
  return series;
}
test("real Quant engine can calculate the five generated specifications with fixture price series", () => {
  const prices=sampleHist();
  for(const exp of build(()=>.53)){
    const s=exp.spec;
    const r=Q.run({...s,series:prices,from:Date.parse(s.from)/1000,to:Date.parse(s.to+"T23:59:59Z")/1000});
    assert.equal(r.kind,"backtest");
    assert.ok(r.dates.length>1000);
    assert.ok(Number.isFinite(r.metrics.finalValue));
    assert.ok(Number.isFinite(r.metrics.cagr));
    assert.ok(Number.isFinite(r.metrics.maxDrawdown));
    assert.ok(Array.isArray(r.trades));
    assert.deepEqual(r.assumptions.costs,s.costs);
  }
});
test("production UI uses actual data provider, saves five metrics and links to details", () => {
  const base=path.join(__dirname,"..","public");
  const html=fs.readFileSync(path.join(base,"index.html"),"utf8");
  const ui=fs.readFileSync(path.join(base,"quant-ui.js"),"utf8");
  assert.ok(html.includes('src="/quant-batch.js"'));
  assert.ok(html.indexOf('src="/quant-batch.js"')<html.indexOf('src="/quant-ui.js"'));
  assert.ok(ui.includes('window.MD.hist(sym, pad, spec.to)'));
  assert.ok(ui.includes('QB.batchDetails.set'));
  assert.ok(ui.includes('remember(item.spec, result, "backtest")'));
  assert.ok(ui.includes('window.qbOpen = function () {'));
  assert.ok(ui.includes('const pending=studioSpec();'));
  assert.ok(ui.includes('if(pending){fillStudioSpec(pending);go("run");}else maybeAutoFive();'));
  assert.ok(ui.includes('Missing tickers are not silently dropped.'));
  assert.ok(ui.includes('data-batchview'));
});

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const D = require("../public/studio-core.js");
const NOW = Date.parse("2026-11-14T17:00:00Z");
const pf = { id: "p1", name: "Test", holdings: [{ symbol: "NVDA", shares: 10 }, { symbol: "MSFT", shares: 3 }, { symbol: "AMD", shares: 2 }] };
const quotes = { NVDA: { price: 120, changePct: 6, marketTime: NOW-30e3 }, MSFT: { price: 300, changePct: -2, marketTime: NOW-30e3 } };
const sectors = { NVDA: "Information Technology", MSFT: "Information Technology", AMD: "Information Technology" };
test("scenario uses available market quotes and excludes unpriced holdings", () => {
  const s=D.holdings(pf, quotes, sectors);
  assert.equal(s.total, 2100);
  assert.equal(s.totalPositions, 3);
  assert.deepEqual(s.unpriced, ["AMD"]);
  const r=D.shockPortfolio(s,{market:-10,tech:-5,custom:-5,symbol:"NVDA"});
  assert.equal(r.before, 2100);
  assert.equal(r.pnl, -375); // NVDA: 1200 × -20%; MSFT: 900 × -15%
  assert.equal(r.after, 1725);
  assert.equal(r.partial, true);
  assert.equal(r.rows[0].symbol, "NVDA");
});

test("scenario combines positions by ticker, returns exact P&L and floors losses at -100%", () => {
  const s=D.holdings({holdings:[{symbol:"AAPL",shares:2},{symbol:"AAPL",shares:3},{symbol:"BND",shares:1}]},
    { AAPL:{price:100},BND:{price:70} },{ AAPL:"Information Technology",BND:"Fixed income" });
  assert.equal(s.total,570);
  const out=D.shockPortfolio(s,{market:-90,tech:-90,custom:-20,symbol:"AAPL"});
  assert.equal(out.pnl,-563);
  assert.equal(out.after,7); // AAPL -100%, BND -90%
  assert.ok(out.rows.every(r=>r.future>=0));
});

test("scenario never presents cost basis as a replacement for missing market quotes", () => {
  const s=D.holdings({holdings:[{symbol:"NVDA",shares:2,cost:400}]},{},{});
  assert.equal(s.total,0);assert.deepEqual(s.unpriced,["NVDA"]);
  assert.equal(D.shockPortfolio(s,{market:-20}).pct,null);
});

test("research evidence ranks owned-company sourced findings and validates links", () => {
  const items=[
    {id:"other",headline:"Unrelated",tickers:["IBM"],importance:90,u:NOW,sources:[{name:"News",url:"https://example.com/1"}]},
    {id:"mine",headline:"SEC report",tickers:["NVDA"],importance:60,u:NOW,sources:[{name:"SEC EDGAR",url:"https://www.sec.gov/a"}]}
  ];
  const r=D.evidence(items,["NVDA"],NOW);
  assert.equal(r[0].id,"mine");
  assert.equal(r[0].matched[0],"NVDA");
  assert.equal(r[0].verifiedUrl,"https://www.sec.gov/a");
  assert.equal(r[0].evidenceStatus,"Sourced");
});

test("freshness distinguishes current delayed stale and missing values", () => {
  assert.equal(D.freshness(NOW-60e3,NOW).state,"current");
  assert.equal(D.freshness(NOW-30*60e3,NOW).state,"delayed");
  assert.equal(D.freshness(NOW-4*3600e3,NOW).state,"stale");
  assert.equal(D.freshness(null,NOW).state,"unavailable");
});

test("quant audit describes out-of-sample and nonzero costs without inventing validation", () => {
  const a=D.validateBacktest({kind:"walk-forward",costs:{spreadBps:5,slippageBps:5,commissionBps:0},from:"2020-01-01",to:"2026-01-01"});
  assert.equal(a.level,"out-of-sample");
  assert.match(a.reasons.join(" "),/Trading-cost|Cost settings/);
  const b=D.validateBacktest({kind:"backtest",costs:{spreadBps:0,slippageBps:0,commissionBps:0}});
  assert.equal(b.level,"in-sample");
  assert.match(b.reasons.join(" "),/Zero trading costs/);
});

test("important holding findings alert once; general-market findings do not",()=>{
  const prefs={research:true,price:false,importance:75};
  const disc=[{id:"one",headline:"New filing",tickers:["NVDA"],u:NOW-1000,importance:82},{id:"other",headline:"Other",tickers:["TSLA"],u:NOW-1000,importance:99}];
  const one=D.alerts({holdings:pf.holdings, discoveries:disc,quotes,preferences:prefs,lastSeen:{},now:NOW,quoteAt:NOW});
  assert.equal(one.events.length,1);
  assert.equal(one.events[0].kind,"Spider research");
  assert.equal(D.alerts({holdings:pf.holdings,discoveries:disc,quotes,preferences:prefs,lastSeen:one.lastSeen,now:NOW,quoteAt:NOW}).events.length,0);
});

test("price alerts require fresh exchange timestamps, not a recent website fetch alone",()=>{
  const prefs={research:false,price:true,priceMove:5};
  const one=D.alerts({holdings:pf.holdings,discoveries:[],quotes,preferences:prefs,lastSeen:{},now:NOW,quoteAt:NOW});
  assert.equal(one.events.length,1);
  assert.equal(one.events[0].symbol,"NVDA");
  const stale={NVDA:{price:120,changePct:16,marketTime:NOW-864e5}};
  assert.equal(D.alerts({holdings:pf.holdings,discoveries:[],quotes:stale,preferences:prefs,lastSeen:{},now:NOW,quoteAt:NOW}).events.length,0);
  assert.equal(D.alerts({holdings:pf.holdings,discoveries:[],quotes,preferences:prefs,lastSeen:{},now:NOW,quoteAt:NOW-2*3600e3}).events.length,0);
});

test("navigation loads Studio core before UI and opens the appropriate page",()=>{
  const html=fs.readFileSync(path.join(__dirname,"..","public/index.html"),"utf8");
  const ui=fs.readFileSync(path.join(__dirname,"..","public/studio.js"),"utf8");
  assert.ok(html.includes('id="tab-studio"'));
  assert.ok(!html.includes('["studio","Intelligence Studio"]'), "no separate Intelligence navigation");
  assert.ok(html.includes('"studio-scenario": "scenario"'), "Studio tools are routed from their own sections");
  assert.ok(html.indexOf('src="/studio-core.js"') < html.indexOf('src="/studio.js"'));
  assert.ok(html.includes('if(STUDIO_ROUTES[t]&&typeof studioOpen==="function"){ studioOpen();'));
  assert.ok(html.includes('if(t==="studio") t="studio-strategies";'), "old #studio links still work");
  assert.ok(ui.includes('useClaude:false'));
});

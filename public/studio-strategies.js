/* Strategy catalog — executable configurations for Market Desk's existing QUANT engine.
 * These are strategy examples and presets, NOT historical performance claims.
 * Historical returns are always computed from real daily price data on demand. */
(function (root, factory) {
  "use strict";
  const library = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = library;
  if (root) root.MDStrategyLibrary = library;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const CATALOG = [
    { id:"mega-mom", category:"trend", title:"Mega-cap momentum", universe:["AAPL","MSFT","NVDA","AMZN","META"], strategy:"momentum",
      params:{lookback:126,skip:21,top:3,absolute:1}, summary:"Monthly rotation into the strongest six-month mega-caps, skipping the latest month.", trigger:"Rank 6-month winners monthly" },
    { id:"sector-mom", category:"trend", title:"Sector leadership rotation", universe:["XLK","XLF","XLE","XLV","XLI","XLP"], strategy:"momentum",
      params:{lookback:189,skip:21,top:2,absolute:1}, summary:"Hold the top two sectors by longer-term momentum, stay in cash if their momentum is negative.", trigger:"9-month sector ranking" },
    { id:"cross-trend", category:"trend", title:"50/200 trend filter", universe:["SPY","QQQ","IWM","GLD","TLT"], strategy:"smacross",
      params:{fast:50,slow:200}, summary:"Follow trends with a 50-day versus 200-day moving-average crossover.", trigger:"Fast SMA > slow SMA" },
    { id:"fast-trend", category:"trend", title:"20/150 tactical trend", universe:["SPY","QQQ","GLD","TLT","IWM"], strategy:"smacross",
      params:{fast:20,slow:150}, summary:"A faster trend-following model that responds to momentum shifts sooner.", trigger:"20-day SMA > 150-day SMA" },
    { id:"sector-dip", category:"reversal", title:"Sector dip buyers", universe:["XLK","XLF","XLV","XLE","XLI","XLP"], strategy:"meanrev",
      params:{lookback:5,top:3,trend:200}, summary:"Buy the three most oversold sectors of the last five days, provided each is above its 200-day average.", trigger:"Weekly five-day reversion" },
    { id:"fast-dip", category:"reversal", title:"Fast 3-day rebound", universe:["SPY","QQQ","IWM","XLK","XLF","XLE"], strategy:"meanrev",
      params:{lookback:3,top:2,trend:200}, summary:"Short-horizon dip buying with a strict longer-term trend filter.", trigger:"Weekly three-day reversion" },
    { id:"rsi-base", category:"reversal", title:"RSI oversold recovery", universe:["XLK","XLF","XLV","XLE","XLI","XLP"], strategy:"rsi",
      params:{period:14,buy:30,sell:55}, summary:"Enter when 14-day RSI falls below 30 and exit above 55.", trigger:"RSI < 30 / RSI > 55" },
    { id:"rsi-strict", category:"reversal", title:"Deep RSI reversal", universe:["AAPL","MSFT","NVDA","AMZN","META"], strategy:"rsi",
      params:{period:14,buy:25,sell:60}, summary:"More selective entry and exit thresholds on a diversified mega-cap group.", trigger:"RSI < 25 / RSI > 60" },
    { id:"multi-factor", category:"factors", title:"Momentum + low volatility", universe:["AAPL","MSFT","NVDA","GOOGL","JPM","XOM"], strategy:"multifactor",
      params:{top:3}, summary:"Monthly ranking on medium-term momentum, trailing volatility and price trend.", trigger:"Top three ranked factors" },
    { id:"sector-factor", category:"factors", title:"Sector factor composite", universe:["XLK","XLF","XLV","XLE","XLI","XLP"], strategy:"multifactor",
      params:{top:2}, summary:"Compare equity sectors using a composite of trend, momentum and relative low volatility.", trigger:"Top two factor-ranked ETFs" },
    { id:"risk-63", category:"allocation", title:"63-day inverse volatility", universe:["SPY","QQQ","GLD","TLT","AGG"], strategy:"riskparity",
      params:{window:63}, summary:"Allocate more to lower-volatility assets using a 63-day rolling volatility estimate.", trigger:"Monthly inverse-volatility weights" },
    { id:"risk-126", category:"allocation", title:"126-day stable allocation", universe:["SPY","IWM","GLD","TLT","AGG"], strategy:"riskparity",
      params:{window:126}, summary:"Slower, cross-asset inverse-volatility allocations with longer estimation windows.", trigger:"126-day rolling volatility" },
    { id:"balanced", category:"allocation", title:"Balanced stock-bond-gold", universe:["SPY","QQQ","AGG","GLD","IWM"], strategy:"rebalance",
      weights:{SPY:30,QQQ:20,AGG:25,GLD:15,IWM:10},params:{freq:"quarterly"}, summary:"Quarterly rebalancing to fixed equities, bond and gold targets.", trigger:"Quarterly allocation rebalance" },
    { id:"buyhold", category:"allocation", title:"60/30/10 buy & hold", universe:["SPY","AGG","GLD"], strategy:"buyhold",
      weights:{SPY:60,AGG:30,GLD:10},params:{},summary:"Passive 60% equity, 30% bonds, 10% gold baseline without systematic rebalancing.",trigger:"Buy once; hold positions" }
  ];
  function makeSpec(entry, today = new Date()) {
    const item = typeof entry === "string" ? CATALOG.find((x) => x.id === entry) : entry;
    if (!item) throw new Error("Unknown strategy preset");
    const end = new Date(today);
    if (!Number.isFinite(end.getTime())) throw new Error("Invalid historical window");
    const to = end.toISOString().slice(0,10), d = new Date(to + "T00:00:00Z");
    d.setUTCFullYear(d.getUTCFullYear()-5);
    return { strategy:item.strategy,universe:[...item.universe],params:{...item.params},
      weights:item.weights ? {...item.weights} : null,benchmark:"SPY",from:d.toISOString().slice(0,10),
      to,initial:10000,costs:{commissionBps:0,spreadBps:5,slippageBps:5},
      limits:{maxWeight:0.65,minCash:0.02},rf:0.03 };
  }
  function validateCatalog(q) {
    const errors=[], ids=new Set(), known=q && q.STRATEGIES ? q.STRATEGIES : {};
    for (const x of CATALOG) {
      if (ids.has(x.id)) errors.push("Duplicate ID " + x.id);
      ids.add(x.id);
      if (!known[x.strategy]) errors.push("Missing engine " + x.strategy);
      if (!Array.isArray(x.universe) || x.universe.length < 3 || new Set(x.universe).size !== x.universe.length) errors.push("Invalid universe " + x.id);
      if (x.params.fast && x.params.fast >= x.params.slow) errors.push("Invalid SMA " + x.id);
      if (x.params.buy && x.params.buy >= x.params.sell) errors.push("Invalid RSI " + x.id);
      if (x.params.top && x.params.top > x.universe.length) errors.push("Invalid top size " + x.id);
      if (x.weights && Math.abs(Object.values(x.weights).reduce((s,v)=>s+v,0) - 100)>1e-6) errors.push("Weights don't sum 100% " + x.id);
    }
    return errors;
  }
  return { CATALOG, makeSpec, validateCatalog };
});

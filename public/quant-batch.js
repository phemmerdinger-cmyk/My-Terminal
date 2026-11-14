/* Five real backtests: random selection of distinct, predefined and explainable strategies.
 * Config generation is pure/testable in Node. All price histories and returns are fetched
 * and calculated by the existing browser QUANT engine, never estimated or fabricated. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.QBATCH = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const CANDIDATES = Object.freeze([
    { id:"momentum", label:"Mega-cap momentum", strategy:"momentum", universe:["AAPL","MSFT","NVDA","AMZN","META"],
      choose:(pick)=>({lookback:pick([126,189]),skip:21,top:pick([2,3]),absolute:1}),
      note:"Monthly 12–1 style relative-strength rotation; buys up to three leaders." },
    { id:"meanrev", label:"Sector ETF dip buying", strategy:"meanrev", universe:["XLK","XLF","XLE","XLV","XLI","XLP"],
      choose:(pick)=>({lookback:pick([3,5,10]),top:pick([2,3]),trend:200}),
      note:"Weekly short-term mean reversion restricted to long-term uptrends." },
    { id:"smacross", label:"Cross-asset trend following", strategy:"smacross", universe:["SPY","QQQ","IWM","GLD","TLT"],
      choose:(pick)=>({fast:pick([20,50]),slow:pick([150,200])}),
      note:"Hold assets while their shorter moving average exceeds the long-term average." },
    { id:"rsi", label:"Sector oversold rebounds", strategy:"rsi", universe:["XLK","XLF","XLV","XLE","XLI","XLP"],
      choose:(pick)=>({period:14,buy:pick([25,30]),sell:pick([55,60])}),
      note:"Systematic RSI entry and exit with zero leverage and no shorting." },
    { id:"multifactor", label:"Multi-factor stock selection", strategy:"multifactor", universe:["AAPL","MSFT","NVDA","GOOGL","JPM","XOM"],
      choose:(pick)=>({top:pick([2,3])}),
      note:"Ranks price momentum, volatility and trend; rebalances monthly." },
    { id:"riskparity", label:"Diversified inverse volatility", strategy:"riskparity", universe:["SPY","QQQ","GLD","TLT","AGG"],
      choose:(pick)=>({window:pick([42,63,126])}),
      note:"Monthly risk-weighting across stocks, bonds and gold." },
    { id:"rebalance", label:"Cross-asset balanced portfolio", strategy:"rebalance", universe:["SPY","QQQ","AGG","GLD","IWM"],
      weights:{SPY:30,QQQ:20,AGG:25,GLD:15,IWM:10},
      choose:(pick)=>({freq:pick(["monthly","quarterly"])}),
      note:"Rule-based monthly or quarterly rebalance to preset allocation weights." }
  ]);
  const rng01 = (random) => { const x = Number(random()); return Number.isFinite(x) ? Math.min(1-Number.EPSILON,Math.max(0,x)) : 0; };
  const dateISO = (d) => new Date(d).toISOString().slice(0, 10);
  function generateFive(options = {}) {
    const count = 5;
    const random = typeof options.random === "function" ? options.random : Math.random;
    const today = options.today == null ? new Date() : new Date(options.today);
    if (!Number.isFinite(today.getTime())) throw new Error("Invalid backtest reference date");
    const dateEnd = dateISO(today);
    const start = new Date(dateEnd+"T00:00:00Z");
    start.setUTCFullYear(start.getUTCFullYear()-5);
    const dateStart = dateISO(start);
    const shuffled = CANDIDATES.slice();
    for (let i=shuffled.length-1;i>0;i--) {
      const j=Math.floor(rng01(random)*(i+1));
      [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
    }
    return shuffled.slice(0,count).map((c,idx)=>{
      const pick=(v)=>v[Math.floor(rng01(random)*v.length)];
      const params=c.choose(pick);
      return { id:c.id, title:c.label, note:c.note, ordinal:idx+1,
        spec:{strategy:c.strategy, universe:c.universe.slice(), params, weights:c.weights ? {...c.weights}:null,
          benchmark:"SPY",from:dateStart,to:dateEnd,initial:10000,
          costs:{commissionBps:0,spreadBps:5,slippageBps:5},
          limits:{maxWeight:0.35,minCash:0.02},rf:0.03} };
    });
  }
  return { CANDIDATES, generateFive };
});

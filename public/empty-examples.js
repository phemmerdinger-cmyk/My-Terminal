/* Contextual starter examples for genuinely empty research, portfolio and risk views.
 * Suggestions are inputs, NOT mock SEC filings, holdings, trades, or fabricated returns.
 * Never alters user holdings, API settings, or market data. */
(function () {
  "use strict";
  const scenarios = {
    fin:{ host:"finOut", title:"Try real SEC filings", desc:"Choose a company to load its real published statements, annual revenue and ratios. No sample filing values are substituted.",tickers:["AAPL","MSFT","NVDA"],action:"fin" },
    dcf:{ host:"dcfOut", title:"Try a real DCF model", desc:"Start with a company that reports public cash flow data. All model assumptions remain editable after loading.",tickers:["MSFT","AAPL","JPM"],action:"dcf" },
    research:{host:"rsBody", title:"Open a company research example", desc:"These are ticker shortcuts; charts, filings and quotes load from their original data feeds.",tickers:["NVDA","AMD","JPM"],action:"quote" },
    portfolio:{host:"pfChart", title:"Example holdings to explore", desc:"Your portfolio is empty. Look at the research pages for these tickers, then choose your own holdings; nothing is added without your action.",tickers:["SPY","AAPL","NVDA"],action:"quote" },
    risk:{host:"rkOut",title:"Risk scenario examples",desc:"Once you add holdings, analyze concentration, the 2008 financial crisis, the 2020 selloff, and your own hypothetical shocks. No fictitious portfolio results are shown.",action:"portfolio" },
    backtest:{host:"qbRuns",title:"Start with an actual strategy",desc:"Explore trend following, RSI rebounds, sector rotation or inverse-volatility allocation. Performance appears only after a real historical backtest.",action:"studio"}
  };
  const q=(id)=>document.getElementById(id);
  function empty(type) {
    const tab=q("tab-"+type);if(!tab||tab.hidden)return false;
    switch(type){
      case "fin":return !!q("finOut")?.querySelector(".fx-empty");
      case "dcf":return !!q("dcfOut")?.querySelector(".fx-empty");
      case "research":return !q("rsHead")?.textContent?.trim() && !q("rsBody")?.textContent?.trim();
      case "portfolio":return typeof S!=="undefined" && Array.isArray(S.port) && !S.port.some(h=>+h.shares>0);
      case "risk":return !!q("rkOut")?.querySelector(".fx-empty");
      case "backtest":return !!q("qbRuns")?.textContent?.includes("Runs you make appear here");
      default:return false;
    }
  }
  function add(type) {
    const c=scenarios[type],node=q("mdExample-"+type),host=q(c.host);
    if(!host)return;
    if(!empty(type)){if(node)node.remove();return;}
    if(node)return;
    const div=document.createElement("aside");div.className="md-example-starter";div.id="mdExample-"+type;
    const title=document.createElement("h3");title.textContent=c.title;div.appendChild(title);
    const desc=document.createElement("p");desc.textContent=c.desc;div.appendChild(desc);
    const row=document.createElement("div");row.className="md-example-buttons";
    for(const ticker of c.tickers||[]){
      const btn=document.createElement("button");btn.type="button";btn.textContent=ticker;btn.dataset.ticker=ticker;row.appendChild(btn);
    }
    if(type==="risk"||type==="backtest"){
      const btn=document.createElement("button");btn.type="button";btn.textContent=type==="risk"?"Open Portfolio →":"Open Strategy Library →";row.appendChild(btn);
    }
    row.onclick=(event)=>{
      const b=event.target.closest("button");if(!b)return;
      const t=b.dataset.ticker;
      if(c.action==="fin"||c.action==="dcf"){
        const field=q(c.action+"Sym"),form=q(c.action+"Form");if(field&&form){field.value=t;form.requestSubmit();}
      }else if(c.action==="quote"&&t){if(typeof openQuote==="function")openQuote(t);}
      else if(c.action==="portfolio")setTab("portfolio");
      else if(c.action==="studio"){setTab("studio");if(typeof studioSelectMode==="function")studioSelectMode("strategies");}
    };
    div.appendChild(row);host.after(div);
  }
  function update() {
    if(typeof S==="undefined")return;
    for(const key of Object.keys(scenarios))add(key);
  }
  // Market data refreshes and tab bodies are mounted asynchronously; unobtrusive rechecks
  // leave completed widgets alone and remove examples once actual content appears.
  setTimeout(update,400);
  setInterval(()=>{if(!document.hidden)update();},4500);
})();

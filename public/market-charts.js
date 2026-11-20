/* Market Charts: price-based, zero-paid-API analytics in the Research section.
   All series are sourced from existing /api/pub/hist. Returns and drawdowns are
   calculated from adjusted daily closes when available, never mock values. */
(function () {
  "use strict";
  const el = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? "" : value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const palette = ["#abd57b","#ecb870","#d7e7bf"];
  const ranges = { "3M":100, "6M":195, "1Y":380, "3Y":1130 };
  const state = { mounted:false, ticker:"", compare:"QQQ", range:"1Y", token:0, key:"", loadedAt:0 };
  const tickerOk = (s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s);
  const fmt = (n,dec=1) => Number.isFinite(n) ? (n>=0?"+":"") + n.toFixed(dec)+"%" : "—";
  const etDate = (s) => s ? new Date(s+"T12:00:00Z").toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"}) : "—";
  function defaultTicker() {
    const p = (typeof S !== "undefined" && S.pfs || []).find((p) => p.id === S.pfActive) || (typeof S !== "undefined" && S.pfs || [])[0];
    const held = p && (p.holdings || []).find((h) => h.symbol && +h.shares > 0);
    return held && tickerOk(String(held.symbol).toUpperCase()) ? held.symbol.toUpperCase() : "NVDA";
  }
  function build() {
    const host=el("mdcHost");if(!host)return;
    state.mounted=true;state.ticker=defaultTicker();
    host.innerHTML = '<div class="mdc-head"><div><div class="mdc-kicker">RESEARCH / PRICE ANALYTICS</div><h2>Market Charts</h2><p>Compare asset returns with the S&amp;P 500, quantify downside, and monitor realized volatility using actual historical closes.</p></div><span class="mdc-source">FREE HISTORICAL DATA · DAILY</span></div>'
      + '<form id="mdcForm" class="mdc-controls"><label>Stock or ETF <input id="mdcTicker" type="text" maxlength="10" autocomplete="off" class="field" spellcheck="false" aria-label="Symbol"></label><label>Comparison <select id="mdcCompare" class="field"><option value="QQQ">QQQ · Nasdaq 100</option><option value="SPY">SPY · S&amp;P 500</option><option value="IWM">IWM · Small caps</option><option value="XLK">XLK · Technology</option><option value="XLF">XLF · Financials</option><option value="GLD">GLD · Gold</option></select></label><fieldset class="mdc-ranges" id="mdcRanges"><legend>Period</legend><button type="button" data-range="3M">3M</button><button type="button" data-range="6M">6M</button><button type="button" data-range="1Y">1Y</button><button type="button" data-range="3Y">3Y</button></fieldset><button class="mdc-apply" type="submit">Update charts</button></form>'
      + '<div class="mdc-status" id="mdcStatus" role="status" aria-live="polite"></div>'
      + '<div class="mdc-kpis" id="mdcKpis"></div>'
      + '<div class="mdc-charts"><article class="mdc-chart mdc-chart-wide"><div class="mdc-chart-title"><h3>Indexed Price Performance</h3><span>Percentage return since the common start date</span></div><div id="mdcPerformance"></div></article><article class="mdc-chart"><div class="mdc-chart-title"><h3>Peak-to-Trough Drawdown</h3><span>Decline from the period-to-date high</span></div><div id="mdcDrawdown"></div></article><article class="mdc-chart"><div class="mdc-chart-title"><h3>Realized Volatility</h3><span>21 trading-day rolling · annualized</span></div><div id="mdcVolatility"></div></article></div>'
      + '<p class="mdc-method">Methodology: adjusted closes where supplied, otherwise unadjusted closes; all symbols use matching trading dates. Returns are historical, not forecasts. Realized volatility is the sample standard deviation of 21 daily log returns × √252. The maximum drawdown is measured within the selected window. Data: the terminal’s existing free Yahoo Finance history service.</p>';
    el("mdcTicker").value=state.ticker;el("mdcCompare").value=state.compare;markRanges();
    el("mdcForm").onsubmit=(ev)=>{ev.preventDefault();const ticker=el("mdcTicker").value.trim().toUpperCase();if(!tickerOk(ticker)){el("mdcStatus").textContent="Enter a valid US stock or ETF ticker (for example NVDA or JPM).";return;}state.ticker=ticker;state.compare=el("mdcCompare").value;load(true);};
    el("mdcCompare").onchange=()=>{state.compare=el("mdcCompare").value;load(true);};
    el("mdcRanges").onclick=(e)=>{const button=e.target.closest("[data-range]");if(!button)return;state.range=button.dataset.range;markRanges();load(true);};
  }
  function markRanges() {
    const root=el("mdcRanges");if(!root)return;
    root.querySelectorAll("[data-range]").forEach((b)=>{const on=b.dataset.range===state.range;b.classList.toggle("on",on);b.setAttribute("aria-pressed",String(on));});
  }
  function sampleValue(json) {
    if(!json || !Array.isArray(json.t) || !Array.isArray(json.close))throw new Error("No valid price history returned");
    const map=new Map();
    json.t.forEach((t,i)=>{
      const a=json.adj && Number(json.adj[i]),c=Number(json.close[i]);
      const v=Number.isFinite(a)&&a>0?a:c;
      if(Number.isFinite(v)&&v>0&&Number.isFinite(+t))map.set(new Date(t*1000).toISOString().slice(0,10),v);
    });
    if(map.size<22)throw new Error("Fewer than 22 valid daily closing prices");
    return map;
  }
  async function request(symbol,from,to) {
    const url="/api/pub/hist?symbol="+encodeURIComponent(symbol)+"&from="+from+"&to="+to+"&interval=1d";
    const resp=await fetch(url,{credentials:"same-origin"});
    if(!resp.ok)throw new Error("Price history unavailable ("+resp.status+")");
    return sampleValue(await resp.json());
  }
  function getSeries(prices) {
    const first=prices[0];let peak=first;
    const perf=prices.map((p)=>100*(p/first-1));
    const dd=prices.map((p)=>{peak=Math.max(peak,p);return 100*(p/peak-1);});
    const vol=prices.map((_,i)=>{
      if(i<21)return NaN;
      const returns=[];
      for(let j=i-20;j<=i;j++)returns.push(Math.log(prices[j]/prices[j-1]));
      const avg=returns.reduce((a,b)=>a+b,0)/returns.length;
      const variance=returns.reduce((a,b)=>a+(b-avg)**2,0)/(returns.length-1);
      return Math.sqrt(variance*252)*100;
    });
    return {perf,dd,vol};
  }
  function corr(a,b) {
    if(!a||!b||a.length!==b.length||a.length<3)return NaN;
    const x=[],y=[];
    for(let i=1;i<a.length;i++){x.push(Math.log(a[i]/a[i-1]));y.push(Math.log(b[i]/b[i-1]));}
    const mx=x.reduce((p,v)=>p+v,0)/x.length,my=y.reduce((p,v)=>p+v,0)/y.length;
    const vx=x.reduce((p,v)=>p+(v-mx)**2,0),vy=y.reduce((p,v)=>p+(v-my)**2,0);
    return vx>0&&vy>0?x.reduce((p,v,i)=>p+(v-mx)*(y[i]-my),0)/Math.sqrt(vx*vy):NaN;
  }
  function renderChart(id,series,dates,kind) {
    const host=el(id),points=series.flatMap((s)=>s.values.filter(Number.isFinite));
    if(!host)return;
    if(!points.length){host.innerHTML='<p class="mdc-unavailable">Not enough observations for this chart.</p>';return;}
    const L=50,R=950,T=22,B=268,W=R-L,H=B-T,n=dates.length;
    let low=Math.min(...points),high=Math.max(...points);
    if(kind==="dd")high=0;
    if(kind==="vol")low=Math.min(0,low);
    let pad=(high-low)*.08;if(pad===0)pad=1;
    low-=pad;high+=pad;
    const x=(i)=>L+(W*i/(n-1)),y=(v)=>T+(high-v)*H/(high-low);
    const grid=Array.from({length:5},(_,i)=>{const value=high-(high-low)*i/4, yy=y(value);return '<line x1="'+L+'" y1="'+yy+'" x2="'+R+'" y2="'+yy+'" stroke="#926225" stroke-opacity=".30"/><text x="'+(L-9)+'" y="'+(yy+4)+'" text-anchor="end" fill="#e3bf92" font-size="12">'+value.toFixed(1)+'%</text>';}).join("");
    const paths=series.map((s)=>{let d="",previous=false;
      s.values.forEach((v,i)=>{if(!Number.isFinite(v)){previous=false;return;}d+=(previous?"L":"M")+x(i).toFixed(2)+","+y(v).toFixed(2)+" ";previous=true;});
      return '<path d="'+d+'" stroke="'+s.color+'" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none" vector-effect="non-scaling-stroke"/>';
    }).join("");
    const labels=[0,Math.floor((n-1)/2),n-1].map(i=>'<text x="'+x(i)+'" y="298" text-anchor="'+(i===0?"start":i===n-1?"end":"middle")+'" fill="#d9b483" font-size="12">'+etDate(dates[i])+'</text>').join("");
    const legend=series.map(s=>'<span><i style="background:'+s.color+'"></i>'+esc(s.symbol)+'</span>').join("");
    host.innerHTML='<div class="mdc-legend">'+legend+'</div><div class="mdc-svgwrap"><svg role="img" aria-label="'+esc(kind)+" historical "+'chart" viewBox="0 0 970 310" preserveAspectRatio="xMidYMid meet"><g>'+grid+labels+paths+'</g><line class="mdc-crosshair" x1="0" x2="0" y1="'+T+'" y2="'+B+'" stroke="#ffe8cb" stroke-dasharray="5 4" stroke-width="1" visibility="hidden"/></svg></div><div class="mdc-readout" aria-live="off">Move over the chart to inspect a trading day.</div>';
    const svg=host.querySelector("svg"),cross=host.querySelector(".mdc-crosshair"),readout=host.querySelector(".mdc-readout");
    svg.addEventListener("pointermove",(event)=>{
      const r=svg.getBoundingClientRect(),pos=Math.max(0,Math.min(1,(event.clientX-r.left)/r.width));
      const approx=(pos*970-L)/W,idx=Math.max(0,Math.min(n-1,Math.round(approx*(n-1))));
      cross.setAttribute("x1",x(idx));cross.setAttribute("x2",x(idx));cross.setAttribute("visibility","visible");
      readout.textContent=etDate(dates[idx])+"  ·  "+series.map(s=>s.symbol+" "+fmt(s.values[idx])).join("  ·  ");
    });
    svg.addEventListener("pointerleave",()=>{cross.setAttribute("visibility","hidden");readout.textContent="Move over the chart to inspect a trading day.";});
  }
  function render(symbols,prices,dates,failures) {
    const datasets=symbols.map((s,i)=>({symbol:s,color:palette[i],prices:prices[s],...getSeries(prices[s])}));
    const main=datasets.find((d)=>d.symbol===state.ticker)||datasets[0];
    const spy=datasets.find((d)=>d.symbol==="SPY");
    const annual=main.vol.filter(Number.isFinite).at(-1);
    const metric=(label,value,extra)=>'<div class="mdc-kpi"><span>'+label+'</span><strong>'+value+'</strong><small>'+extra+'</small></div>';
    el("mdcKpis").innerHTML=metric("Period return",fmt(main.perf.at(-1)),"Historical total return")+
      metric("Maximum drawdown",fmt(Math.min(...main.dd)),"Worst peak-to-trough loss")+
      metric("Recent volatility",fmt(annual),"21-day realized · annualized")+
      metric("Daily correlation to SPY",spy&&main!==spy&&Number.isFinite(corr(main.prices,spy.prices))?corr(main.prices,spy.prices).toFixed(2):"—","Pearson correlation of log returns");
    renderChart("mdcPerformance",datasets.map(d=>({symbol:d.symbol,color:d.color,values:d.perf})),dates,"return");
    renderChart("mdcDrawdown",datasets.filter(d=>d===main||d===spy).map(d=>({symbol:d.symbol,color:d.color,values:d.dd})),dates,"dd");
    renderChart("mdcVolatility",datasets.filter(d=>d===main||d===spy).map(d=>({symbol:d.symbol,color:d.color,values:d.vol})),dates,"vol");
    el("mdcStatus").textContent=etDate(dates[0])+" – "+etDate(dates.at(-1))+" · "+dates.length+" matched trading days · "+symbols.join(" / ")+(failures.length?" · Unavailable: "+failures.join(", "):"");
  }
  async function load(force) {
    if(!state.mounted)build();
    if(!state.mounted)return;
    const rangeDays=ranges[state.range],date=new Date(),to=date.toISOString().slice(0,10);
    const from=new Date(date.getTime()-rangeDays*864e5).toISOString().slice(0,10);
    const symbols=[...new Set([state.ticker,"SPY",state.compare])];
    const key=[state.ticker,state.compare,state.range,to].join("|");
    if(!force&&state.key===key&&Date.now()-state.loadedAt<10*60e3)return;
    const token=++state.token;
    el("mdcStatus").textContent="Loading daily price histories…";el("mdcKpis").innerHTML="";
    for(const id of ["mdcPerformance","mdcDrawdown","mdcVolatility"])el(id).innerHTML='<div class="mdc-loading">Calculating historical risk metrics…</div>';
    const tasks=await Promise.allSettled(symbols.map(s=>request(s,from,to)));
    if(token!==state.token)return;
    const data={},failures=[];
    symbols.forEach((s,i)=>{if(tasks[i].status==="fulfilled")data[s]=tasks[i].value;else failures.push(s);});
    if(!data[state.ticker]){el("mdcStatus").textContent="No usable price history for "+state.ticker+". Check the ticker and try another one.";for(const id of ["mdcPerformance","mdcDrawdown","mdcVolatility"])el(id).innerHTML="";return;}
    const available=symbols.filter(s=>data[s]);
    const dates=[...data[state.ticker].keys()].filter(d=>available.every(s=>data[s].has(d))).sort();
    if(dates.length<22){el("mdcStatus").textContent="Not enough overlapping daily price data to calculate charts. Try a shorter period or another comparison.";return;}
    const prices={};for(const s of available)prices[s]=dates.map(d=>data[s].get(d));
    render(available,prices,dates,failures);
    state.key=key;state.loadedAt=Date.now();
  }
  window.MDMarketCharts={open:function(){if(!state.mounted)build();load(false);}};
  if(typeof S!=="undefined" && S.tab==="studio-graph")window.MDMarketCharts.open();
})();
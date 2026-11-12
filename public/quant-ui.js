/* Quant › Backtest lab — UI for public/quant.js. Prices come from /api/pub/hist (free Yahoo daily history);
   all simulation math runs in the browser, so it costs nothing on the server. */
(function () {
  const Q = window.QUANT; if (!Q) return;
  const QB = { cache: new Map(), runs: [], last: null, busy: false };
  try { QB.runs = JSON.parse(localStorage.getItem("md_qb_runs") || "[]"); } catch {}
  const PRESETS = [["Sector ETFs", "XLK, XLF, XLE, XLV, XLY, XLP, XLI, XLU, XLB, XLRE, XLC"], ["Mega caps", "AAPL, MSFT, NVDA, AMZN, GOOGL, META, AVGO, JPM, LLY, XOM"], ["Stocks & bonds", "SPY, QQQ, IWM, AGG, TLT, GLD"], ["Factor ETFs", "MTUM, QUAL, USMV, VLUE, SIZE, SPY"]];
  const DESC = {
    buyhold: "Buy the weights once and never trade again. The simplest baseline.", rebalance: "Hold fixed weights and trade back to them on a schedule.",
    momentum: "Each month, hold the assets with the best return over the lookback (skipping the most recent month). Losers' slots stay in cash when absolute = 1.",
    meanrev: "Each week, buy the assets that fell most over a few days, but only while they're above their long-term average.", smacross: "Hold an asset while its fast moving average is above its slow one; otherwise that slot is cash.",
    rsi: "Buy when RSI falls below the buy level (oversold); sell when it recovers above the sell level.", multifactor: "Each month, rank assets on 12-1 month momentum, low volatility and trend (price vs. 200-day average); hold the top ones.",
    riskparity: "Weight each asset by the inverse of its volatility so each contributes similar risk; rebalanced monthly.", custom: "Write your own entry and exit rules with price, sma(n), ema(n), rsi(n), ret(n), vol(n), high(n), low(n).",
  };
  const pc = (x, d = 1) => (x == null || !isFinite(x) ? "—" : (x >= 0 ? "" : "−") + Math.abs(x * 100).toFixed(d) + "%");
  const nf = (x, d = 2) => (x == null ? "—" : x === Infinity ? "∞" : (+x).toFixed(d));
  const money = (x) => (x == null ? "—" : (x < 0 ? "−$" : "$") + Math.abs(Math.round(x)).toLocaleString("en-US"));
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const symsOf = (s) => [...new Set(String(s || "").toUpperCase().split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^[A-Z0-9.\-^=]{1,12}$/.test(x)))].slice(0, 15);

  function shell() {
    const el = $("tab-backtest"); if (el.dataset.ready) return; el.dataset.ready = "1";
    const today = new Date().toISOString().slice(0, 10), ten = new Date(Date.now() - 10 * 365.25 * 864e5).toISOString().slice(0, 10);
    el.innerHTML = `<div class="fx-head"><div><div class="fx-kick">∑ QUANT</div><h1>Backtest lab</h1>
      <p class="fx-sub">Test rule-based strategies on historical prices with trading costs, position limits and no look-ahead, then check whether the result survives data it was never tuned on. Results are <b>backtested</b> — hypothetical — and kept separate from AI Trader's <b>paper-traded</b> results and live <b>market-observed</b> prices.</p></div></div>
      <div class="qb-grid"><form class="fx-card qb-form" id="qbForm" autocomplete="off">
        <label>Strategy<select class="field" id="qbStrat">${Object.entries(Q.STRATEGIES).map(([k, s]) => `<option value="${k}">${esc(s.name)}</option>`).join("")}</select></label>
        <p class="qb-desc" id="qbDesc"></p>
        <label>Universe <em>up to 15 tickers</em><input class="field" id="qbUni" value="SPY, QQQ, IWM, AGG, TLT, GLD"></label>
        <div class="qb-pre">${PRESETS.map(([n, v]) => `<button type="button" data-v="${esc(v)}">${esc(n)}</button>`).join("")}<button type="button" data-pf="1">My portfolio</button></div>
        <label id="qbWL" hidden>Weights <em>TICKER:weight, e.g. SPY:60, AGG:40</em><input class="field" id="qbW" value="SPY:60, AGG:40"></label>
        <div id="qbParams" class="qb-params"></div>
        <div class="qb-two"><label>Start<input type="date" class="field" id="qbFrom" value="${ten}"></label><label>End<input type="date" class="field" id="qbTo" value="${today}"></label></div>
        <div class="qb-two"><label>Benchmark<input class="field" id="qbBench" value="SPY"></label><label>Starting capital ($)<input type="number" class="field" id="qbInit" value="10000" min="100" step="100"></label></div>
        <details class="qb-adv" open><summary>Costs, limits &amp; cash</summary>
          <div class="qb-three"><label>Commission (bps)<input type="number" class="field" id="qbCom" value="0" min="0" step="0.5"></label><label>Bid-ask spread (bps)<input type="number" class="field" id="qbSpr" value="5" min="0" step="0.5"></label><label>Slippage (bps)<input type="number" class="field" id="qbSlip" value="5" min="0" step="0.5"></label></div>
          <div class="qb-three"><label>Max per position (%)<input type="number" class="field" id="qbMax" value="100" min="1" max="100"></label><label>Min cash (%)<input type="number" class="field" id="qbCash" value="0" min="0" max="99"></label><label>Risk-free rate (%)<input type="number" class="field" id="qbRf" value="3" step="0.1"></label></div>
          <p class="qb-desc" id="qbRfNote">Cash earns the risk-free rate; Sharpe and Sortino use it too.</p></details>
        <div class="qb-act"><button class="btn" type="submit" data-mode="run">Run backtest</button><button class="btn ghost" type="button" data-mode="optimize" title="Tune on the first 70%, test once on the last 30%">Optimize + out-of-sample</button><button class="btn ghost" type="button" data-mode="walk" title="Re-tune every year on the previous 3 years">Walk-forward</button><button class="btn ghost" type="button" data-mode="sens">Parameter sensitivity</button></div>
      </form>
      <div id="qbOut"><div class="fx-empty">Pick a strategy and press <b>Run backtest</b>.</div></div></div>
      <div class="fx-card" id="qbRuns"></div>
      <div class="fx-card" id="qbPaper"></div>`;
    $("qbStrat").onchange = paramsUI; paramsUI();
    el.querySelector(".qb-pre").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.pf) { const s = (S.port || []).map((h) => h.symbol); if (!s.length) return toast("Your active portfolio has no holdings yet."); $("qbUni").value = s.slice(0, 15).join(", "); const tot = (S.port || []).reduce((a, h) => a + h.shares * ((S.quotes[h.symbol] || {}).price || h.cost), 0) || 1; $("qbW").value = (S.port || []).slice(0, 15).map((h) => `${h.symbol}:${((h.shares * ((S.quotes[h.symbol] || {}).price || h.cost)) / tot * 100).toFixed(1)}`).join(", "); } else $("qbUni").value = b.dataset.v; };
    $("qbForm").onsubmit = (e) => { e.preventDefault(); go("run"); };
    el.querySelector(".qb-act").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b && b.type === "button") go(b.dataset.mode); };
    $("qbRuns").onclick = (e) => { const x = e.target.closest("[data-del]"); if (x) { QB.runs.splice(+x.dataset.del, 1); saveRuns(); runsUI(); } };
    runsUI(); paperUI(); rfDefault();
  }
  async function rfDefault() { try { const q = (await api("/api/quotes?symbols=%5EIRX")).quotes["^IRX"]; if (q && q.price > 0 && q.price < 20) { $("qbRf").value = (+q.price).toFixed(2); $("qbRfNote").textContent = `Default = today's 13-week Treasury bill yield (${(+q.price).toFixed(2)}%). Cash earns it; Sharpe and Sortino use it.`; } } catch {} }
  function paramsUI() {
    const k = $("qbStrat").value, s = Q.STRATEGIES[k]; $("qbDesc").textContent = DESC[k] || "";
    $("qbWL").hidden = !(k === "buyhold" || k === "rebalance");
    const P = { ...s.params }; if (k === "rebalance") P.freq = P.freq || "quarterly";
    $("qbParams").innerHTML = Object.entries(P).map(([p, v]) => p === "freq" ? `<label>Rebalance<select class="field" data-p="freq"><option value="monthly">Monthly</option><option value="quarterly" selected>Quarterly</option><option value="annual">Yearly</option></select></label>`
      : typeof v === "string" ? `<label class="qb-wide">${p === "entry" ? "Entry rule" : "Exit rule"}<input class="field" data-p="${p}" value="${esc(v)}"></label>` : `<label>${esc(p)}<input type="number" class="field" data-p="${p}" value="${v}"></label>`).join("");
  }
  function readSpec() {
    const k = $("qbStrat").value, uni = symsOf($("qbUni").value), bench = symsOf($("qbBench").value)[0] || "SPY";
    const params = {}; $("qbParams").querySelectorAll("[data-p]").forEach((i) => { params[i.dataset.p] = i.type === "number" ? +i.value : i.value; });
    let weights = null, universe = uni;
    if (k === "buyhold" || k === "rebalance") { weights = {}; for (const part of $("qbW").value.split(",")) { const m = part.trim().toUpperCase().match(/^([A-Z0-9.\-^=]{1,12})\s*[:=]\s*([\d.]+)%?$/); if (m) weights[m[1]] = +m[2]; } universe = Object.keys(weights); if (!universe.length) throw new Error("Enter weights like SPY:60, AGG:40"); }
    if (!universe.length) throw new Error("Add at least one ticker to the universe.");
    if (k === "custom") { Q.compileRule(params.entry); Q.compileRule(params.exit); }
    const from = $("qbFrom").value, to = $("qbTo").value; if (!from || !to || from >= to) throw new Error("Pick a start date before the end date.");
    return { strategy: k, universe, weights, params, benchmark: bench, from, to, initial: Math.max(100, +$("qbInit").value || 10000),
      costs: { commissionBps: Math.max(0, +$("qbCom").value || 0), spreadBps: Math.max(0, +$("qbSpr").value || 0), slippageBps: Math.max(0, +$("qbSlip").value || 0) },
      limits: { maxWeight: Math.min(1, Math.max(0.01, (+$("qbMax").value || 100) / 100)), minCash: Math.min(0.99, Math.max(0, (+$("qbCash").value || 0) / 100)) }, rf: (+$("qbRf").value || 0) / 100 };
  }
  async function loadSeries(syms, from, to) {
    const pad = new Date(Date.parse(from) - 420 * 864e5).toISOString().slice(0, 10), out = {}, todo = [...syms]; let done = 0, failed = [];
    const one = async () => { while (todo.length) { const s = todo.shift(), key = `${s}|${pad}|${to}`;
      try { const j = await window.MD.hist(s, pad, to); out[s] = { t: j.t, close: j.close, adj: j.adj }; } catch (e) { failed.push(s); }
      $("qbOut").innerHTML = `<div class="fx-empty"><span class="spin"></span> Loading daily price history… ${++done}/${syms.length}</div>`; } };
    await Promise.all([one(), one(), one()]);
    return { series: out, failed };
  }
  async function go(mode) {
    if (QB.busy) return; let spec; try { spec = readSpec(); } catch (e) { return toast(e.message); }
    QB.busy = true; const out = $("qbOut");
    try {
      const { series, failed } = await loadSeries([...new Set([...spec.universe, spec.benchmark])], spec.from, spec.to);
      if (!series[spec.benchmark]) throw new Error(`Couldn't load history for the benchmark ${spec.benchmark}.`);
      const full = { ...spec, series, from: Date.parse(spec.from + "T00:00:00Z") / 1000, to: Date.parse(spec.to + "T23:59:59Z") / 1000 };
      out.innerHTML = `<div class="fx-empty"><span class="spin"></span> ${mode === "run" ? "Simulating" : "Running many simulations"}…</div>`;
      await new Promise((r) => setTimeout(r, 30));
      const t0 = performance.now();
      if (mode === "run") { const r = Q.run(full); QB.last = r; out.innerHTML = resultHTML(r, failed); wire(r); remember(spec, r, "backtest"); }
      else if (mode === "optimize") { const o = Q.optimize(full); out.innerHTML = optHTML(o, failed); wire(o.outOfSample); remember({ ...spec, params: { ...spec.params, ...o.inSample.best } }, o.outOfSample, "out-of-sample"); }
      else if (mode === "walk") { const w = Q.walkForward(full); out.innerHTML = walkHTML(w, failed); wireChart("qbWfC", w.dates, [{ n: "Walk-forward (out-of-sample)", v: w.equity, c: "#4da3ff" }, { n: spec.benchmark, v: w.bench, c: "#8a93a3" }]); remember(spec, { metrics: w.metrics, strategy: Q.STRATEGIES[spec.strategy].name }, "walk-forward"); }
      else if (mode === "sens") { out.innerHTML = sensHTML(Q.sensitivity(full)); }
      out.insertAdjacentHTML("beforeend", `<p class="fx-note">Computed in your browser in ${((performance.now() - t0) / 1000).toFixed(1)} s · price data: Yahoo Finance daily history via this site.</p>`);
    } catch (e) { out.innerHTML = `<div class="fx-warn">${esc(e.message)}</div>`; }
    QB.busy = false;
  }
  const KPIS = (m, b) => [["CAGR", pc(m.cagr), b && pc(b.cagr)], ["Total return", pc(m.totalReturn, 0), b && pc(b.totalReturn, 0)], ["Volatility (ann.)", pc(m.vol), b && pc(b.vol)], ["Sharpe", nf(m.sharpe), b && nf(b.sharpe)], ["Sortino", nf(m.sortino), b && nf(b.sortino)],
    ["Max drawdown", pc(m.maxDrawdown), b && pc(b.maxDrawdown)], ["Calmar", nf(m.calmar), b && nf(b.calmar)], ["Alpha (ann.)", pc(m.alpha), null], ["Beta", nf(m.beta), null], ["Information ratio", nf(m.infoRatio), null],
    ["1-day VaR 95%", pc(m.var95), b && pc(b.var95)], ["Expected shortfall 95%", pc(m.es95), b && pc(b.es95)], ["Win rate", m.winRate == null ? "—" : pc(m.winRate, 0), null], ["Profit factor", nf(m.profitFactor), null],
    ["Avg win / loss", `${money(m.avgWin)} / ${money(m.avgLoss)}`, null], ["Turnover (per year)", m.turnover == null ? "—" : nf(m.turnover, 1) + "×", null], ["Trading costs", money(m.costs), null], ["Avg invested", pc(m.avgExposure, 0), null]];
  const kpiHTML = (m, b, bn) => `<div class="qb-kpis">${KPIS(m, b).map(([k, v, bv]) => `<div><span>${k}</span><b>${v}</b>${bv != null ? `<em>${esc(bn)} ${bv}</em>` : ""}</div>`).join("")}</div>`;
  function heat(monthly, bm) {
    const yrs = [...new Set(Object.keys(monthly).map((k) => k.slice(0, 4)))];
    const col = (v) => (v == null ? "transparent" : v >= 0 ? `rgba(15,191,125,${Math.min(0.85, 0.15 + v * 8)})` : `rgba(246,70,93,${Math.min(0.85, 0.15 - v * 8)})`);
    return `<div class="tbl-wrap"><table class="qb-heat"><tr><th>Year</th>${"JFMAMJJASOND".split("").map((m) => `<th>${m}</th>`).join("")}<th>Year</th><th>Bench</th></tr>${yrs.map((y) => { const ms = [...Array(12)].map((_, i) => monthly[`${y}-${String(i + 1).padStart(2, "0")}`]);
      const yr = ms.filter((v) => v != null).reduce((a, v) => a * (1 + v), 1) - 1, by = [...Array(12)].map((_, i) => bm[`${y}-${String(i + 1).padStart(2, "0")}`]).filter((v) => v != null).reduce((a, v) => a * (1 + v), 1) - 1;
      return `<tr><td>${y}</td>${ms.map((v) => `<td style="background:${col(v)}">${v == null ? "" : (v * 100).toFixed(1)}</td>`).join("")}<td class="${yr >= 0 ? "up" : "down"}"><b>${(yr * 100).toFixed(1)}%</b></td><td>${(by * 100).toFixed(1)}%</td></tr>`; }).join("")}</table></div>`;
  }
  const banner = (kind, extra) => `<div class="qb-banner ${kind}"><b>${{ backtest: "BACKTESTED", oos: "OUT-OF-SAMPLE BACKTEST", walk: "WALK-FORWARD (OUT-OF-SAMPLE)", sens: "SENSITIVITY (DESCRIPTIVE)" }[kind]}</b> · hypothetical results from historical prices — not paper-traded, not live${extra ? " · " + extra : ""}</div>`;
  function resultHTML(r, failed, title) {
    const m = r.metrics, b = r.benchMetrics, a = r.assumptions;
    return `${title || banner("backtest")}<h2 class="qb-h">${esc(r.strategy)} <em>${day(m.start)} → ${day(m.end)} · ${m.years} years · ${Object.entries(r.params).filter(([k]) => k !== "weights").map(([k, v]) => `${k} ${v}`).join(", ")}</em></h2>
      ${failed && failed.length ? `<div class="fx-warn">No price history for ${failed.map(esc).join(", ")} — left out.</div>` : ""}
      ${kpiHTML(m, b, "Benchmark")}
      <div class="fx-card bt-chart" id="qbEq"><h3>Growth of ${money(r.equity[0])} <em class="bt-read">hover for values</em></h3>${svgLines(r.dates, [{ v: r.bench, c: "#8a93a3" }, { v: r.equity, c: "#4da3ff" }], { h: 260 })}</div>
      <div class="fx-card bt-chart" id="qbDd"><h3>Drawdown <em class="bt-read">distance below the previous peak</em></h3>${svgLines(r.dates, [{ v: r.metrics.drawdown, c: "#ff6b6b" }], { h: 140, pct: true, fills: true })}</div>
      <div class="fx-card"><h3>Monthly returns (%)</h3>${heat(r.monthly, r.benchMonthly)}</div>
      <div class="fx-card"><h3>Trade history <em>${r.trades.length} orders · signal on one day, filled at the next close</em></h3><div class="tbl-wrap qb-trades"><table><tr><th>Signal</th><th>Filled</th><th>Side</th><th>Ticker</th><th>Shares</th><th>Price</th><th>Value</th><th>Cost</th><th>Reason</th></tr>${r.trades.slice(-150).reverse().map((t) => `<tr><td>${day(t.signalDate)}</td><td>${day(t.t)}</td><td class="${t.side === "BUY" ? "up" : "down"}">${t.side}</td><td><b>${esc(t.sym)}</b></td><td class="num">${t.shares}</td><td class="num">${t.price.toFixed(2)}</td><td class="num">${money(t.value)}</td><td class="num">$${t.cost.toFixed(2)}</td><td class="qb-why">${esc(t.why)}</td></tr>`).join("")}</table></div>${r.trades.length > 150 ? `<p class="fx-note">Showing the latest 150 of ${r.trades.length} orders.</p>` : ""}</div>
      <div class="fx-card"><h3>Assumptions &amp; limitations</h3><ul class="qb-list"><li>${esc(a.execution)}</li><li>${esc(a.prices)}; trading calendar = ${esc(a.calendar)}.</li><li>Costs per trade: ${a.costs.commissionBps} bps commission + ${a.costs.spreadBps / 2} bps (half the ${a.costs.spreadBps} bps spread) + ${a.costs.slippageBps} bps slippage.</li><li>Limits: at most ${(a.limits.maxWeight * 100).toFixed(0)}% per position, at least ${(a.limits.minCash * 100).toFixed(0)}% cash; cash earns ${(a.rf * 100).toFixed(2)}% a year.</li>${r.limitations.map((x) => `<li class="warn">${esc(x)}</li>`).join("")}</ul></div>`;
  }
  function wireChart(id, dates, lines) { const el = $(id); if (el) btHover(el, dates, lines, (v) => money(v)); }
  function wire(r) { wireChart("qbEq", r.dates, [{ n: "Strategy", v: r.equity, c: "#4da3ff" }, { n: "Benchmark", v: r.bench, c: "#8a93a3" }]); const d = $("qbDd"); if (d) btHover(d, r.dates, [{ n: "Drawdown", v: r.metrics.drawdown, c: "#ff6b6b" }], (v) => (v * 100).toFixed(1) + "%"); }
  function optHTML(o, failed) {
    const is = o.inSample, im = is.metrics, om = o.outOfSample.metrics;
    return `${banner("oos")}<div class="fx-card qb-split"><h3>In-sample tuning vs. out-of-sample test</h3><p class="fx-note">${esc(o.note)}</p>
      <table class="qb-cmp"><tr><th></th><th>In-sample (tuned)</th><th>Out-of-sample (unseen)</th></tr><tr><td>Period</td><td>${day(is.from)} → ${day(is.to)}</td><td>${day(om.start)} → ${day(om.end)}</td></tr>
      <tr><td>Parameters</td><td colspan="2">${Object.entries(is.best).map(([k, v]) => `${k} = ${v}`).join(", ")} (best Sharpe of ${is.tried} combinations)</td></tr>
      ${[["CAGR", pc(im.cagr), pc(om.cagr)], ["Sharpe", nf(im.sharpe), nf(om.sharpe)], ["Max drawdown", pc(im.maxDrawdown), pc(om.maxDrawdown)], ["Volatility", pc(im.vol), pc(om.vol)]].map(([k, a, b]) => `<tr><td>${k}</td><td class="dim">${a}</td><td><b>${b}</b></td></tr>`).join("")}</table>
      <p class="fx-note">${im.sharpe != null && om.sharpe != null ? (om.sharpe < im.sharpe * 0.5 ? "⚠ The out-of-sample Sharpe is less than half the tuned one — a sign of overfitting." : "The out-of-sample result holds up reasonably against the tuned period.") : ""}</p></div>
      ${resultHTML(o.outOfSample, failed, `<h2 class="qb-h" style="margin-top:6px">Out-of-sample run</h2>`)}`;
  }
  function walkHTML(w, failed) {
    return `${banner("walk")}${failed.length ? `<div class="fx-warn">No price history for ${failed.map(esc).join(", ")} — left out.</div>` : ""}<p class="fx-note">${esc(w.note)}</p>${kpiHTML(w.metrics, w.benchMetrics, "Benchmark")}
      <div class="fx-card bt-chart" id="qbWfC"><h3>Chained out-of-sample equity <em class="bt-read">hover for values</em></h3>${svgLines(w.dates, [{ v: w.bench, c: "#8a93a3" }, { v: w.equity, c: "#4da3ff" }], { h: 240 })}</div>
      <div class="fx-card"><h3>Windows</h3><div class="tbl-wrap"><table class="qb-cmp"><tr><th>Tuned on</th><th>Tested on</th><th>Chosen parameters</th><th>Tuned Sharpe</th><th>Test return</th><th>Test Sharpe</th></tr>${w.windows.map((x) => `<tr><td>${day(x.trainFrom)} → ${day(x.trainTo)}</td><td>${day(x.testFrom)} → ${day(x.testTo)}</td><td>${Object.entries(x.params).map(([k, v]) => `${k} ${v}`).join(", ")}</td><td class="dim">${nf(x.inSampleSharpe)}</td><td class="${x.outReturn >= 0 ? "up" : "down"}">${pc(x.outReturn)}</td><td>${nf(x.outSharpe)}</td></tr>`).join("")}</table></div></div>`;
  }
  function sensHTML(s) {
    const vals = s.rows.flat().filter(Boolean).map((c) => c.sharpe).filter((v) => v != null), lo = Math.min(...vals), hi = Math.max(...vals);
    const col = (v) => { if (v == null) return "transparent"; const t = hi > lo ? (v - lo) / (hi - lo) : 0.5; return `rgba(${Math.round(246 - 231 * t)},${Math.round(70 + 121 * t)},${Math.round(93 + 32 * t)},.55)`; };
    return `${banner("sens")}<div class="fx-card"><h3>Sharpe ratio for each parameter choice <em>full period</em></h3><p class="fx-note">${esc(s.note)} Spread between best and worst cell: <b>${nf(s.spread)}</b>.</p>
      <div class="tbl-wrap"><table class="qb-heat"><tr><th>${esc(s.y ? s.y.key : "")} ↓ / ${esc(s.x.key)} →</th>${s.x.values.map((v) => `<th>${v}</th>`).join("")}</tr>${s.rows.map((row, i) => `<tr><th>${s.y ? s.y.values[i] : ""}</th>${row.map((c) => `<td style="background:${col(c && c.sharpe)}" title="${c ? `CAGR ${pc(c.cagr)} · max drawdown ${pc(c.mdd)}` : "invalid combination"}">${c ? nf(c.sharpe) : "—"}</td>`).join("")}</tr>`).join("")}</table></div></div>`;
  }
  // ---- run history: compare iterations without rewriting earlier results
  function remember(spec, r, kind) {
    const m = r.metrics; QB.runs.unshift({ at: Date.now(), kind, strategy: Q.STRATEGIES[spec.strategy].name, universe: spec.universe.join(", "), params: Object.entries(spec.params || {}).map(([k, v]) => `${k} ${v}`).join(", "), from: spec.from, to: spec.to, costs: spec.costs,
      cagr: m.cagr, sharpe: m.sharpe, mdd: m.maxDrawdown, vol: m.vol, var95: m.var95 });
    QB.runs = QB.runs.slice(0, 25); saveRuns(); runsUI();
  }
  function saveRuns() { try { localStorage.setItem("md_qb_runs", JSON.stringify(QB.runs)); } catch {} }
  function runsUI() {
    $("qbRuns").innerHTML = `<h3>Saved runs <em>kept in this browser · compare strategy versions side by side</em></h3>${QB.runs.length ? `<div class="tbl-wrap"><table class="qb-cmp"><tr><th>When</th><th>Type</th><th>Strategy</th><th>Universe</th><th>Settings</th><th>Period</th><th>CAGR</th><th>Sharpe</th><th>Max DD</th><th></th></tr>${QB.runs.map((x, i) => `<tr><td>${new Date(x.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td><td><span class="qb-tag ${x.kind === "backtest" ? "" : "oos"}">${esc(x.kind)}</span></td><td>${esc(x.strategy)}</td><td class="dim">${esc(x.universe)}</td><td class="dim">${esc(x.params)}</td><td class="dim">${esc(x.from)} → ${esc(x.to)}</td><td>${pc(x.cagr)}</td><td>${nf(x.sharpe)}</td><td class="${x.mdd < -0.3 ? "down" : ""}">${pc(x.mdd)}</td><td><button type="button" class="qb-x" data-del="${i}" title="Remove">✕</button></td></tr>`).join("")}</table></div>` : '<p class="fx-note">Runs you make appear here so you can compare versions.</p>'}`;
  }
  // ---- the three kinds of results, side by side
  async function paperUI() {
    const el = $("qbPaper"); el.innerHTML = `<h3>Backtested vs. paper-traded vs. live</h3><p class="fx-note"><b>Backtested</b>: simulated on past prices (this page). <b>Paper-traded</b>: AI Trader's simulated orders placed in real time at live prices, with no hindsight. <b>Market-observed</b>: what the benchmark actually did over the same days.</p><div id="qbPaperB"><span class="spin"></span></div>`;
    if (window.__VISITOR) { $("qbPaperB").innerHTML = ""; }
    try { const d = await api("/api/autopilot"), a = d.analytics || {};
      $("qbPaperB").innerHTML = `<div class="qb-kpis"><div><span>AI Trader (paper-traded)</span><b class="${(a.totalReturn || 0) >= 0 ? "up" : "down"}">${pc(a.totalReturn)}</b><em>since ${new Date(d.firstTrade || d.start).toLocaleDateString("en-US")}</em></div><div><span>S&amp;P 500 (market-observed)</span><b>${pc(a.benchmarkReturn)}</b><em>same period</em></div><div><span>Max drawdown (paper)</span><b>${pc(a.maxDrawdown)}</b><em>${a.tradingDays || 0} trading days</em></div><div><span>Trades</span><b>${a.trades || 0}</b><em><a href="#aitrade" data-gotab="aitrade">open AI vs S&amp;P 500 →</a></em></div></div>
        <p class="fx-note">AI Trader's live rules use news, analyst ratings and earnings data that have no free history, so they can't be backtested faithfully here; its record is paper-traded only.</p>`; }
    catch { $("qbPaperB").innerHTML = '<p class="fx-note">AI Trader results unavailable right now.</p>'; }
  }
  window.qbOpen = function () { shell(); };
  if (S.tab === "backtest") window.qbOpen();
})();

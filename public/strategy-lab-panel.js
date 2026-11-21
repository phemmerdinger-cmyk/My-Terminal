(() => {
  "use strict";
  const panel = document.getElementById("strategyLabPanel");
  const tab = document.getElementById("tab-aitrade");
  if (!panel || !tab || window.__VISITOR) return;

  const dollar = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });
  const east = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const money = (x) => Number.isFinite(x) ? dollar.format(x) : "—";
  const rate = (x) => Number.isFinite(x) ? percent.format(x) : "—";
  const count = (x) => Array.isArray(x) ? x.length : x && typeof x === "object" ? Object.keys(x).length :
    Number.isFinite(x) ? x : "—";
  const sign = (x) => x > 0 ? "up" : x < 0 ? "down" : "";
  function add(parent, tag, value, className) {
    const node = document.createElement(tag);
    if (value != null) node.textContent = String(value);
    if (className) node.className = className;
    parent.append(node);
    return node;
  }

  const heading = add(panel, "h4", "Strategy Lab");
  add(heading, "em", "Forward paper experiments");
  const stats = add(panel, "div", null, "ap-mini");
  const results = add(panel, "div");
  const status = add(panel, "p", "Loading experiment data…", "ap-note");
  status.setAttribute("role", "status");
  const errors = add(panel, "div");
  const pairNotes = add(panel, "details");
  pairNotes.hidden = true;
  add(pairNotes, "summary", "Quant pair decisions");
  const pairList = add(pairNotes, "ul", null, "ap-note");
  const research = add(panel, "details");
  research.hidden = true;
  add(research, "summary", "Research and trader profiles");
  const sourceList = add(research, "ul", null, "ap-note");
  const borrow = add(panel, "details");
  borrow.hidden = true;
  add(borrow, "summary", "Import observed borrow quotes");
  const form = add(borrow, "form");
  const instructions = add(form, "p", "Paste a JSON array from your borrow source. Only enter availability and annual rates you actually observed. Timestamps need a time zone or epoch milliseconds.", "ap-note");
  instructions.id = "strategyLabBorrowHelp";
  const label = add(form, "label", "Borrow quotes (JSON)");
  label.htmlFor = "strategyLabBorrowInput";
  const input = add(form, "textarea");
  input.id = label.htmlFor;
  input.setAttribute("aria-describedby", instructions.id);
  input.rows = 4;
  input.required = true;
  input.spellcheck = false;
  input.style.width = "100%";
  input.style.boxSizing = "border-box";
  input.style.background = "var(--panel2)";
  input.style.color = "var(--text)";
  input.style.fontFamily = "var(--mono)";
  input.placeholder = '[{"symbol":"TICKER","annualBps":100,"source":"Broker","marketTime":"2026-01-01T15:00:00Z","available":true}]';
  const submit = add(form, "button", "Import quotes", "btn ghost");
  submit.type = "submit";
  const importStatus = add(form, "p", null, "ap-note");
  importStatus.setAttribute("role", "status");

  function tile(label, value, hint) {
    const item = add(stats, "div");
    add(item, "span", label);
    add(item, "b", value);
    if (hint) add(item, "small", hint);
    return item;
  }

  function addLink(parent, url, label) {
    const link = add(parent, "a", label);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }

  function render(data) {
    stats.replaceChildren();
    results.replaceChildren();
    errors.replaceChildren();
    pairList.replaceChildren();
    sourceList.replaceChildren();
    const regime = data.regime;
    const regimeName = typeof regime === "string" ? regime : regime?.label || regime?.name || regime?.state ||
      (regime?.riskOff === true ? "Risk off" : regime?.riskOff === false ? "Risk on" : "Waiting for market data");
    tile("Market regime", regimeName, typeof regime?.reason === "string" ? regime.reason : null);
    tile("Recorded sessions", count(data.recordedSessions), "Forward observations");
    const currentBorrow = (data.borrowEntries || []).filter((q) => q.available && data.asOf - q.marketTime >= 0 &&
      data.asOf - q.marketTime <= 86_400_000).length;
    tile("Current borrow availability", `${currentBorrow}/${count(data.borrowSymbols)}`, "Quotes expire after 24 hours");
    const rf = data.riskFree;
    const yieldTile = tile("3-month Treasury yield", rate(rf?.ratePct / 100), rf?.day ? `Observed ${rf.day}` : "Waiting for a prior observation");
    if (rf?.url) addLink(yieldTile, rf.url, rf.source);
    tile("Treasury cash return", rate(rf?.cashReturn), "Over the comparison period");
    tile("SPY price return", rate(data.benchmarkReturn), "Over the comparison period");

    const experiments = Array.isArray(data.experiments) ? data.experiments.filter(Boolean) : [];
    if (!experiments.length) {
      add(results, "p", "Waiting for the first experiment snapshot.", "ap-note");
    } else {
      const wrap = add(results, "div", null, "ap-wrap");
      wrap.tabIndex = 0;
      wrap.setAttribute("aria-label", "Paper experiment results");
      const table = add(wrap, "table", null, "ap-tbl");
      table.setAttribute("aria-label", "Paper experiment results");
      const header = add(add(table, "thead"), "tr");
      for (const title of ["Experiment", "Equity", "Cash", "Paper P&L", "Costs", "Drawdown", "Current bot", "Experiment return",
        "Above cash", "At 2× cost", "Activity"]) {
        add(header, "th", title).scope = "col";
      }
      const body = add(table, "tbody");
      for (const item of experiments) {
        const row = add(body, "tr");
        const detail = add(row, "td", null, "n");
        add(detail, "b", item.label || item.id || "Experiment");
        const subtitle = [item.bot, item.notice].filter((x) => typeof x === "string" && x).join(" · ");
        if (subtitle) add(detail, "small", subtitle);
        add(row, "td", money(item.value));
        add(row, "td", money(item.cash));
        add(row, "td", money(item.pnl), sign(item.pnl));
        add(row, "td", money(item.costs));
        add(row, "td", rate(item.drawdown), item.drawdown ? "down" : "");
        add(row, "td", rate(item.baselineReturn), sign(item.baselineReturn));
        add(row, "td", rate(item.shadowReturn), sign(item.shadowReturn));
        add(row, "td", rate(item.excessCash), sign(item.excessCash));
        add(row, "td", rate(item.costStressReturn), sign(item.costStressReturn));
        const activity = add(row, "td", null, "n");
        add(activity, "span", `${count(item.positions)} open · ${count(item.pending)} queued`);
        add(activity, "small", `${count(item.closed)} closed · ${count(item.sessions)} sessions`);
      }
      add(results, "p", "Returns appear after two aligned closing snapshots. The cash benchmark uses previously published Treasury yields. The cost test applies twice the modeled cost to the recorded fills.", "ap-note");
    }
    // toughness test: lab rows show it in their subtitle; the three main bots are listed here (no approvals needed)
    const tough = data.toughness;
    if (tough) {
      const main = Array.isArray(tough.mainBots) ? tough.mainBots : [];
      for (const b of main) {
        const line = add(results, "p", null, "ap-note");
        add(line, "b", `Toughness test · ${b.bot}: ${b.label || b.status}`, b.status === "pass" ? "up" : b.status === "fail" ? "down" : "");
        const bits = [b.detail, Array.isArray(b.checks) ? b.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label} (${c.value})`).join(" · ") : null, b.why, b.gate].filter(Boolean);
        if (bits.length) add(line, "span", " — " + bits.join(" "));
      }
      for (const item of experiments.filter((x) => x.toughness && Array.isArray(x.toughness.checks))) {
        const line = add(results, "p", null, "ap-note");
        add(line, "b", `${item.label}: ${item.toughness.label}`, item.toughness.status === "pass" ? "up" : item.toughness.status === "fail" ? "down" : "");
        add(line, "span", " — " + item.toughness.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label} (${c.value})`).join(" · ") + ` ${item.toughness.gate || ""}`);
      }
      add(results, "p", `${tough.rule}${tough.testedOn ? ` Last tested on ${tough.testedOn}.` : ""} Replays are hypothetical: today's stock list, daily bars and modeled costs.`, "ap-note");
    }
    for (const decision of data.pairDiagnostics || []) {
      add(pairList, "li", [decision.pairId, decision.reason || decision.stage].filter(Boolean).join(" · "));
    }
    pairNotes.hidden = !pairList.childElementCount;
    for (const source of data.sources || []) {
      const entry = add(sourceList, "li");
      if (typeof source.url === "string" && source.url.startsWith("https://")) addLink(entry, source.url, source.title);
      if (source.summary) add(entry, "span", ` — ${source.summary}`);
    }
    research.hidden = !sourceList.childElementCount;
    for (const issue of Array.isArray(data.errors) ? data.errors.slice(0, 4) : []) {
      const message = typeof issue === "string" ? issue : issue?.error || issue?.message;
      if (typeof message === "string" && message) add(errors, "p", message, "ap-note");
    }
    const asOf = data.asOf == null ? NaN : +new Date(data.asOf);
    status.textContent = Number.isFinite(asOf) ? `Updated ${east.format(asOf)}` : "Waiting for an update timestamp.";
    borrow.hidden = false;
  }

  let polling = false;
  const visible = () => !document.hidden && !tab.hidden && !window.__VISITOR;
  async function request(path, options) {
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  async function poll() {
    if (!visible() || polling) return;
    polling = true;
    try {
      const data = await request("/api/strategy-lab", { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (visible()) render(data);
    } catch {
      status.textContent = "Strategy Lab data is temporarily unavailable.";
    } finally {
      polling = false;
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!visible() || submit.disabled) return;
    let rows;
    try {
      rows = JSON.parse(input.value);
      if (!Array.isArray(rows) || !rows.length) throw new Error();
    } catch {
      importStatus.textContent = "Enter a JSON array containing at least one borrow quote.";
      return;
    }
    submit.disabled = true;
    importStatus.textContent = "Importing borrow quotes…";
    try {
      const result = await request("/api/strategy-lab/borrow", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rows), signal: AbortSignal.timeout(15_000) });
      const saved = result?.accepted ?? result?.count;
      importStatus.textContent = Number.isFinite(saved) ? `Imported ${saved} borrow quotes.` : "Borrow quote import completed.";
      input.value = "";
      poll();
    } catch (error) {
      importStatus.textContent = `Could not import borrow quotes. ${error.message || "Try again."}`;
    } finally {
      submit.disabled = false;
    }
  });
  new MutationObserver(poll).observe(tab, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", poll);
  setInterval(poll, 30_000);
  panel.hidden = false;
  poll();
})();

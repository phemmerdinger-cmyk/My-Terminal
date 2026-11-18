(() => {
  "use strict";
  const panel = document.getElementById("dayVolumePanel");
  const page = document.getElementById("tab-aitrade");
  const selector = document.getElementById("apSwitch");
  if (!panel || !page || !selector || window.__VISITOR) return;

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const number = new Intl.NumberFormat("en-US");
  const marketTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const dollars = (value) => Number.isFinite(value) ? money.format(value) : "—";
  const count = (value) => Number.isFinite(value) ? number.format(value) : "—";
  const sign = (value) => value > 0 ? "up" : value < 0 ? "down" : "";

  function add(parent, tag, label = "", className = "") {
    const element = document.createElement(tag);
    element.textContent = label;
    if (className) element.className = className;
    parent.append(element);
    return element;
  }

  const title = add(panel, "h4", "Day Trader volume test");
  add(title, "em", "Separate paper record");
  add(panel, "p", "This test includes forecasts below the regular entry threshold and applies modeled costs to every fill.", "ap-note");
  const stats = add(panel, "div", "", "ap-mini");
  const status = add(panel, "p", "Waiting for the experiment status…", "ap-note");
  status.setAttribute("role", "status");
  const recent = add(panel, "details");
  recent.hidden = true;
  add(recent, "summary", "Recent completed test trades");
  const wrap = add(recent, "div", "", "ap-wrap");
  wrap.tabIndex = 0;
  wrap.setAttribute("aria-label", "Recent completed test trades");
  const table = add(wrap, "table", "", "ap-tbl");
  const header = add(add(table, "thead"), "tr");
  for (const column of ["Closed", "Symbol", "Side", "Net P&L", "Costs", "Regular threshold", "Exit reason"]) {
    add(header, "th", column).scope = "col";
  }
  const body = add(table, "tbody");
  const history = add(panel, "details");
  history.hidden = true;
  add(history, "summary", "Prior session results");
  const historyWrap = add(history, "div", "", "ap-wrap");
  historyWrap.tabIndex = 0;
  historyWrap.setAttribute("aria-label", "Prior session results");
  const historyTable = add(historyWrap, "table", "", "ap-tbl");
  const historyHeader = add(add(historyTable, "thead"), "tr");
  for (const label of ["Session", "Completed / target", "Met regular threshold", "Net P&L", "Costs"]) {
    add(historyHeader, "th", label).scope = "col";
  }
  const historyBody = add(historyTable, "tbody");

  function tile(label, value, hint = "", className = "") {
    const item = add(stats, "div");
    add(item, "span", label);
    add(item, "b", value, className);
    if (hint) add(item, "small", hint);
  }

  function render(data) {
    stats.replaceChildren();
    const target = Number.isFinite(data.target) ? `${count(data.target)} target for the session` : "No target for this session";
    tile("Completed test trades", count(data.closed), data.day ? target : "Waiting for a market session");
    tile("Opened this session", count(data.opened));
    tile("Orders waiting", count(data.pending ?? data.queued));
    tile("Open positions", count(data.open));
    tile("Missed entries", count(data.expired ?? data.missed));
    tile("Paper equity", dollars(data.equity));
    tile("Session net P&L", dollars(data.pnl), "Closed positions, after modeled costs", sign(data.pnl));
    tile("Modeled costs", dollars(data.costs), "This session");
    if (Number.isFinite(data.costQualified)) {
      tile("Met regular threshold", count(data.costQualified), "Of the completed test trades");
    }

    const note = [data.status, Number.isFinite(data.asOf) ? `Observed ${marketTime.format(data.asOf)}` : null];
    status.textContent = [data.error, ...note].filter(Boolean).join(" · ");
    body.replaceChildren();
    const trades = data.recent ?? data.trades;
    for (const trade of Array.isArray(trades) ? trades.slice(0, 10) : []) {
      const row = add(body, "tr");
      add(row, "td", Number.isFinite(trade.closeAt) ? marketTime.format(trade.closeAt) : "—", "n");
      add(row, "td", trade.symbol ?? "—", "n");
      add(row, "td", trade.direction === "long" ? "Long" : trade.direction === "short" ? "Short" : "—", "n");
      add(row, "td", dollars(trade.netPnl), sign(trade.netPnl));
      add(row, "td", dollars(trade.cost));
      const qualification = trade.qualifiedAtEntry === true ? "Met" : trade.qualifiedAtEntry === false ? "Below" : "—";
      add(row, "td", qualification);
      add(row, "td", trade.reason ?? "—", "n");
    }
    recent.hidden = !body.childElementCount;
    historyBody.replaceChildren();
    for (const session of data.recentSessions || []) {
      const row = add(historyBody, "tr");
      add(row, "td", session.day, "n");
      add(row, "td", `${count(session.closed)} / ${count(session.target)}`);
      add(row, "td", count(session.costQualified));
      add(row, "td", dollars(session.netPnl), sign(session.netPnl));
      add(row, "td", dollars(session.costs));
    }
    history.hidden = !historyBody.childElementCount;
  }

  let busy = false;
  async function poll() {
    if (busy || page.hidden || panel.hidden || document.hidden) return;
    busy = true;
    try {
      const response = await fetch("/api/day-volume", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("Request failed");
      const data = await response.json();
      if (!panel.hidden) render(data);
    } catch {
      if (!panel.hidden) status.textContent = "The current experiment status is temporarily unavailable.";
    } finally {
      busy = false;
    }
  }

  function select() {
    const show = !page.hidden && !!selector.querySelector('[data-bot="day"].on');
    const opened = show && panel.hidden;
    panel.hidden = !show;
    if (opened) poll();
  }

  const observer = new MutationObserver(select);
  observer.observe(page, { attributes: true, attributeFilter: ["hidden"] });
  observer.observe(selector, { childList: true });
  document.addEventListener("visibilitychange", poll);
  setInterval(poll, 20_000);
  select();
})();

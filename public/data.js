/* Market Desk · shared data layer.
   One place in the browser for data that several pages use, so every tab reads the same copy instead of keeping its own:
   - MD.hist(sym, from, to)   daily price history. One canonical download per symbol per day (the same window the server
                              caches), sliced locally for each caller, kept in memory and in this browser until midnight.
   - MD.cached(key, ms, fn)   time-limited cache with in-flight sharing: two pages asking at once make one request.
   - MD.earnings(), MD.macro(), MD.discoveries(n), MD.sp500()  common feeds behind the same cache.
   Pages: Quant Lab, Backtest lab, Risk & stress, THE WEB, Overview, Portfolio. */
(function () {
  const today = () => new Date().toISOString().slice(0, 10);
  const mem = new Map(); // key -> {t, v} or {t, p} while loading
  function cached(key, ms, fn) {
    const c = mem.get(key);
    if (c && (c.p || Date.now() - c.t < ms)) return c.p || Promise.resolve(c.v);
    const p = Promise.resolve().then(fn).then((v) => { mem.set(key, { t: Date.now(), v }); return v; }, (e) => { mem.delete(key); throw e; });
    mem.set(key, { t: Date.now(), p }); return p;
  }
  const getJSON = (url) => (typeof api === "function" ? api(url) : fetch(url).then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error || r.status))))));

  // ---- price history
  const LS = "mdh:"; // localStorage key prefix: mdh:SYM|CANON|DAY
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && (k.startsWith(LS) || k.startsWith("qh2:")) && !k.endsWith("|" + today())) localStorage.removeItem(k); } } catch {}
  const canonOf = (from) => { const y = +from.slice(0, 4); return `${y - (y % 2)}-01-01`; }; // same rule as the server
  const full = new Map(); // sym -> {canon, p}
  function fullHist(sym, canon) {
    const have = full.get(sym);
    if (have && have.canon <= canon) return have.p; // an earlier start already covers this window
    const key = `${sym}|${canon}|${today()}`;
    let hit = null; try { const v = localStorage.getItem(LS + key); if (v) hit = JSON.parse(v); } catch {}
    const p = hit ? Promise.resolve(hit) : getJSON(`/api/pub/hist?symbol=${encodeURIComponent(sym)}&from=${canon}&to=${today()}&interval=1d`).then((j) => {
      try { localStorage.setItem(LS + key, JSON.stringify({ symbol: j.symbol, name: j.name, currency: j.currency, first: j.first, t: j.t, close: j.close, adj: j.adj })); } catch {}
      return j; });
    full.set(sym, { canon, p }); p.catch(() => { if (full.get(sym) && full.get(sym).p === p) full.delete(sym); });
    return p;
  }
  function slice(j, from, to) {
    const lo = Date.parse(from + "T00:00:00Z") / 1000, hi = Date.parse(to + "T23:59:59Z") / 1000, keep = [];
    j.t.forEach((t, i) => { if (t >= lo && t <= hi) keep.push(i); });
    if (!keep.length) throw new Error(`No price history for ${j.symbol || ""} in that window`);
    return { ...j, t: keep.map((i) => j.t[i]), close: keep.map((i) => j.close[i]), adj: j.adj ? keep.map((i) => j.adj[i]) : null };
  }
  function hist(sym, from, to, interval) {
    sym = String(sym || "").toUpperCase(); to = to || today();
    if ((interval && interval !== "1d") || to < today()) // a fixed past window or weekly/monthly bars: fetch exactly that
      return cached(`hx:${sym}|${from}|${to}|${interval || "1d"}`, 6 * 3600e3, () => getJSON(`/api/pub/hist?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&interval=${interval || "1d"}`));
    return fullHist(sym, canonOf(from)).then((j) => slice(j, from, to));
  }
  const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

  window.MD = {
    cached, hist, daysAgo, today,
    histDays: (sym, days) => hist(sym, daysAgo(days), today()),
    earnings: (syms) => cached("earn:" + [...new Set(syms || [])].sort().join(","), 30 * 60e3, () => getJSON("/api/earnings?symbols=" + encodeURIComponent([...new Set(syms || [])].join(",")))),
    macro: () => cached("macro", 30 * 60e3, () => getJSON("/api/pub/macro")),
    discoveries: (n = 20) => cached("disc:" + n, 2 * 60e3, () => getJSON("/api/web/discoveries?limit=" + n)),
    sp500: () => cached("sp500", 60e3, () => getJSON("/api/sp500")),
  };
})();

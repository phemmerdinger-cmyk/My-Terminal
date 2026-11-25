/* System Doctor, browser side: reports page errors and failed /api calls from the owner's own browser to the server's
   System Doctor (/api/doctor/report), which turns repeated ones into findings. Owner pages only; batched; nothing
   personal is sent (message, file:line, page tab). */
(function () {
  if (window.__VISITOR || window.__mdDoctor) return; window.__mdDoctor = true;
  const q = [], seen = new Map(), page = () => (location.pathname === "/hq" || /hq/.test(document.title) ? "hq" : "desk") + (location.hash || "");
  function add(kind, msg, where) {
    msg = String(msg || "").slice(0, 400); if (!msg) return;
    const k = kind + msg, n = Date.now(); if (seen.has(k) && n - seen.get(k) < 10 * 60e3) return; seen.set(k, n); // same error once per 10 min
    q.push({ kind, msg, where: String(where || "").slice(0, 200), page: page() }); if (q.length > 20) q.shift();
  }
  window.addEventListener("error", (e) => add("js", e.message, (e.filename || "").replace(location.origin, "") + ":" + (e.lineno || 0)));
  window.addEventListener("unhandledrejection", (e) => add("js", e.reason && (e.reason.message || e.reason), "promise"));
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const r = await realFetch(input, init);
    try { if (r.status >= 500 && /\/api\//.test(url) && !/\/api\/doctor\//.test(url)) add("api", `${r.status} from ${url.replace(location.origin, "").split("?")[0]}`, url.replace(location.origin, "").slice(0, 200)); } catch {}
    return r;
  };
  setInterval(() => {
    if (!q.length) return; const reports = q.splice(0, 10);
    realFetch("/api/doctor/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reports }) }).catch(() => {});
  }, 30_000);
})();

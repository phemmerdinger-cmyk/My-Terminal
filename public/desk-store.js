/* Market Desk · personal data store (window.MDDesk).
 * One document of named sections (home, dna, theses, journal, …) kept in this browser's localStorage and,
 * for the signed-in owner, mirrored to the owner-only /api/desk endpoint (Upstash free tier if configured,
 * otherwise the server temp folder, which Render wipes on redeploy — hence export/import).
 * Visitors (public demo): nothing is saved and the server is never called. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDDeskFactory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const SECTIONS = ["home", "dna", "theses", "journal", "alerts", "tournaments", "learning", "pitches", "workspaces", "memory", "prefs"];
  function create({ storage, fetchImpl, visitor = false, key = "md_desk_v1", delay = 1500, now = () => Date.now(), timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) } } = {}) {
    const read = () => { try { const v = JSON.parse(storage.getItem(key)); return v && v.data ? v : { updated: 0, data: {} }; } catch { return { updated: 0, data: {} }; } };
    let doc = visitor ? { updated: 0, data: {} } : read();
    const subs = new Set();
    const state = { status: visitor ? "visitor" : "local", durable: null, lastSync: 0, error: null };
    let timer = 0;
    const emit = (section) => subs.forEach((fn) => { try { fn(section); } catch {} });
    const persist = () => { if (visitor) return; try { storage.setItem(key, JSON.stringify(doc)); } catch (e) { state.error = "Browser storage is full"; } };
    function get(section, fallback) {
      const v = doc.data[section];
      return v === undefined ? (typeof fallback === "function" ? fallback() : fallback) : JSON.parse(JSON.stringify(v));
    }
    function set(section, value) {
      if (!SECTIONS.includes(section)) throw new Error("Unknown desk section: " + section);
      if (visitor) { doc.data[section] = JSON.parse(JSON.stringify(value)); emit(section); return; } // demo: in-memory only
      doc = { updated: Math.max(now(), doc.updated + 1), data: { ...doc.data, [section]: JSON.parse(JSON.stringify(value)) } };
      persist(); emit(section); schedule();
    }
    function schedule() { if (visitor || !fetchImpl) return; timers.clear(timer); timer = timers.set(push, delay); }
    async function push(force) {
      if (visitor || !fetchImpl) return false;
      try {
        const r = await fetchImpl("/api/desk" + (force ? "?force=1" : ""), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 409 && j.doc) { adopt(j.doc); return false; }
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        state.status = "synced"; state.durable = !!j.durable; state.lastSync = now(); state.error = null; return true;
      } catch (e) { state.status = "offline"; state.error = String(e.message || e); return false; }
    }
    function adopt(remote) {
      if (!remote || !remote.data || !(remote.updated > doc.updated)) return false;
      doc = { updated: remote.updated, data: { ...remote.data } }; persist();
      Object.keys(doc.data).forEach(emit); return true;
    }
    async function pull() {
      if (visitor || !fetchImpl) return false;
      try {
        const r = await fetchImpl("/api/desk"); const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        state.durable = !!j.durable; state.lastSync = now(); state.status = "synced"; state.error = null;
        if (adopt(j.doc)) return true;
        if (doc.updated && (!j.doc || j.doc.updated < doc.updated)) await push();
        return false;
      } catch (e) { state.status = "offline"; state.error = String(e.message || e); return false; }
    }
    function exportDoc() { return { kind: "market-desk-personal-data", version: 1, exported: new Date(now()).toISOString(), ...doc }; }
    function importDoc(obj) {
      if (!obj || obj.kind !== "market-desk-personal-data" || !obj.data || typeof obj.data !== "object") throw new Error("That file isn't a Market Desk personal-data backup.");
      const data = {}; for (const k of Object.keys(obj.data)) if (SECTIONS.includes(k)) data[k] = obj.data[k];
      doc = { updated: Math.max(now(), doc.updated + 1), data }; persist(); Object.keys(data).forEach(emit); schedule();
      return Object.keys(data);
    }
    return { get, set, pull, push, exportDoc, importDoc, on: (fn) => { subs.add(fn); return () => subs.delete(fn); }, state: () => ({ ...state }), sections: SECTIONS.slice() };
  }
  return { create, SECTIONS };
});
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const visitor = !!window.__VISITOR || document.documentElement.classList.contains("viewonly");
  window.MDDesk = window.MDDeskFactory.create({ storage: window.localStorage, fetchImpl: visitor ? null : window.fetch.bind(window), visitor });
  if (!visitor) window.MDDesk.pull();
})();

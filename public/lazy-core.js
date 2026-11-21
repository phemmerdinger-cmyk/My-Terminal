/* Load heavy tools only when they are needed, so the first page load stays light.
 * Each group lists scripts in the order they must run (later files use globals from earlier ones). */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MDLazyCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const QUANT = ["/quant.js", "/quant-batch.js", "/quant-ui.js", "/qmath.js", "/quant-lab.js"];
  const GROUPS = Object.freeze({
    // Quant Lab and Backtest Lab (each opens itself when it loads while its tab is showing)
    quant: Object.freeze(QUANT),
    // Studio tools reuse the Quant engine, then add the Studio UI and Market Charts
    studio: Object.freeze([...QUANT, "/studio-core.js", "/studio-strategies.js", "/studio.js", "/market-charts.js"]),
    // THE WEB research spider (owner only; the public demo has no access to its data)
    web: Object.freeze(["/web.js", "/web-env.js", "/web-control.js"]),
    // Bots × spider teamwork: Morning brief pop-up and the Research "Why" card (owner / private desk only)
    team: Object.freeze(["/teamwork.js"]),
  });

  // Which group a tab needs before it can show anything, or null when the page has it already.
  function groupForTab(tab) {
    if (tab === "quant" || tab === "backtest") return "quant";
    if (typeof tab === "string" && tab.startsWith("studio-")) return "studio";
    return null;
  }

  // Browser loader: each script is requested once; a group loads its files one after another.
  function createLoader(doc) {
    const seen = new Map();
    const one = (src) => {
      if (!seen.has(src)) {
        seen.set(src, new Promise((resolve, reject) => {
          const s = doc.createElement("script");
          s.src = src;
          s.onload = () => resolve(src);
          s.onerror = () => { seen.delete(src); reject(new Error("Couldn't load " + src)); };
          doc.body.appendChild(s);
        }));
      }
      return seen.get(src);
    };
    return {
      load(group) {
        const list = GROUPS[group];
        if (!list) return Promise.reject(new Error("Unknown group " + group));
        return list.reduce((p, src) => p.then(() => one(src)), Promise.resolve());
      },
      loaded: (src) => seen.has(src),
    };
  }

  return { GROUPS, groupForTab, createLoader };
});

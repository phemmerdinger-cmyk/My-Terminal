// Thesis tracker for the swing bot (idea from the equity-research plugin's thesis tracker). When the bot buys, it
// writes down the reasons that were true at that moment ("pillars"). Every re-score checks each pillar against the
// same inputs. If most of the reasons it bought for are gone, it sells, even if no stop or trend rule has fired yet.
// Missing data never counts as broken: an input the bot can't see today is "unknown", not "failed".
// Pure functions, no I/O (tests/thesis-core.test.js).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MDThesis = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Each pillar: when it counts as a reason to buy, and when that reason is gone. Thresholds sit well apart so a
  // value drifting around one line can't flip a pillar back and forth.
  const PILLARS = {
    momentum: { label: "rising over 3 months", holds: (x) => x.mom != null && x.mom > 0.02, broken: (x) => x.mom != null && x.mom < -0.02, now: (x) => `3-month return now ${(x.mom * 100).toFixed(0)}%` },
    news: { label: "good news", holds: (x) => x.news != null && x.news >= 1, broken: (x) => x.news != null && x.news <= -1, now: () => "news turned negative" },
    analysts: { label: "analysts positive", holds: (x) => x.adj != null && x.adj >= 0.5, broken: (x) => x.adj != null && x.adj < 0.15, now: () => "analyst view turned mixed" },
    health: { label: "strong 10-K (A/B)", holds: (x) => !!x.health && (x.health.grade === "A" || x.health.grade === "B"), broken: (x) => !!x.health && (x.health.grade === "D" || x.health.grade === "F"), now: (x) => `10-K grade now ${x.health.grade}` },
    ratios: { label: "ratios beat peers", holds: (x) => !!x.ratios && x.ratios.score >= 0.15, broken: (x) => !!x.ratios && x.ratios.score <= -0.15, now: () => "ratios now trail peers" },
    spider: { label: "spider research positive", holds: (x) => !!x.spider && x.spider.adj > 0, broken: (x) => !!x.spider && x.spider.adj < 0, now: () => "spider research turned negative" },
  };

  // The thesis recorded at a buy: the names of the pillars that held. Fewer than 2 = no thesis to track
  // (a single reason is already covered by the bot's other exit rules).
  function atBuy(x, now = Date.now()) {
    const pillars = Object.keys(PILLARS).filter((k) => { try { return PILLARS[k].holds(x); } catch { return false; } });
    return pillars.length >= 2 ? { at: now, pillars, labels: pillars.map((k) => PILLARS[k].label) } : null;
  }

  // Broken when at least 2 pillars, and at least half of them, are clearly gone.
  function check(thesis, x) {
    if (!thesis || !Array.isArray(thesis.pillars) || thesis.pillars.length < 2 || !x) return { broken: false, gone: [], kept: [] };
    const gone = [], kept = [];
    for (const k of thesis.pillars) {
      const p = PILLARS[k]; if (!p) continue;
      let b = false; try { b = p.broken(x); } catch { b = false; }
      (b ? gone : kept).push(k);
    }
    const n = gone.length + kept.length, broken = gone.length >= 2 && gone.length * 2 >= n;
    return { broken, gone, kept,
      reason: broken ? `Thesis broken: bought for ${thesis.pillars.map((k) => PILLARS[k] ? PILLARS[k].label : k).join(", ")}; now ${gone.map((k) => PILLARS[k].now(x)).join(", ")}` : null };
  }

  return { PILLARS, atBuy, check };
});

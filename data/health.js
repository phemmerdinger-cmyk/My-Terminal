// System health bookkeeping: success/failure counts per external data source, and a short log of recent errors.
// Every message is passed through redact() first, so API keys, tokens and crumbs never reach the page or a log.
"use strict";

const HOSTS = [
  [/finance\.yahoo\.com|yahoo\.com/, "Yahoo Finance"], [/news\.google\.com/, "Google News"], [/cnbc\.com/, "CNBC"], [/seekingalpha\.com/, "Seeking Alpha"],
  [/dj\.com|wsj\.com/, "Wall Street Journal"], [/morningstar\.com/, "Morningstar"], [/sec\.gov/, "SEC EDGAR"], [/fred\.stlouisfed\.org/, "FRED (St. Louis Fed)"],
  [/finnhub\.io/, "Finnhub"], [/federalreserve\.gov/, "Federal Reserve"], [/bls\.gov/, "Bureau of Labor Statistics"], [/treasury\.gov|fiscaldata/, "U.S. Treasury"],
  [/newyorkfed\.org/, "New York Fed"], [/umich\.edu/, "University of Michigan"], [/reddit\.com/, "Reddit"], [/anthropic\.com/, "Anthropic (Claude)"], [/upstash\.io/, "Upstash Redis"], [/api\.github\.com/, "GitHub"],
];
function hostLabel(url) { let h = ""; try { h = new URL(url).hostname; } catch { h = String(url || "?"); } const m = HOSTS.find(([re]) => re.test(h)); return m ? m[1] : h.replace(/^www\./, ""); }
function redact(s) {
  return String(s == null ? "" : s)
    .replace(/([?&](token|apikey|api_key|key|crumb|access_token|sig)=)[^&\s"']+/gi, "$1***")
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1***")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***")
    .replace(/\b(ghp|gho|github_pat)_[A-Za-z0-9_]+/g, "$1_***");
}

function createHealth(now = () => Date.now()) {
  const H = { started: now(), sources: {}, errors: [] };
  function note(url, ok, err) {
    const label = hostLabel(url), r = (H.sources[label] = H.sources[label] || { ok: 0, fail: 0, lastOk: null, lastFail: null, lastError: null });
    if (ok) { r.ok++; r.lastOk = now(); return; }
    r.fail++; r.lastFail = now(); r.lastError = redact((err && err.message) || err).slice(0, 180);
    H.errors.unshift({ t: now(), source: label, error: r.lastError }); if (H.errors.length > 50) H.errors.length = 50;
  }
  function error(source, err) { H.errors.unshift({ t: now(), source, error: redact((err && err.message) || err).slice(0, 180) }); if (H.errors.length > 50) H.errors.length = 50; }
  // wrap an async fetcher; urlOf(args) says which source it hit. A returned Response with ok=false counts as a failure.
  function track(fn, urlOf) {
    return async function (...a) {
      const u = urlOf(...a);
      try { const r = await fn.apply(this, a); if (r && typeof r.ok === "boolean" && typeof r.status === "number" && !r.ok) note(u, false, "HTTP " + r.status); else note(u, true); return r; }
      catch (e) { note(u, false, e); throw e; }
    };
  }
  // available = recent success and no newer failure; degraded = both recently; down = only failures recently
  function view() {
    const t = now();
    const rows = Object.entries(H.sources).map(([name, r]) => {
      const recentOk = r.lastOk && t - r.lastOk < 30 * 60e3, recentFail = r.lastFail && t - r.lastFail < 30 * 60e3;
      const status = recentOk && (!recentFail || r.lastOk > r.lastFail) ? "available" : recentOk && recentFail ? "degraded" : recentFail ? "down" : "idle";
      return { name, status, ...r, successRate: r.ok + r.fail ? +(r.ok / (r.ok + r.fail)).toFixed(3) : null };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { started: H.started, uptimeSec: Math.round((t - H.started) / 1000), sources: rows, errors: H.errors.slice(0, 30) };
  }
  return { note, error, track, view, _H: H };
}

module.exports = { createHealth, hostLabel, redact };

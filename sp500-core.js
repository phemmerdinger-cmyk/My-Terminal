"use strict";
// S&P 500 constituents, refreshed automatically from the public dataset the bundled public/sp500.json came from
// (github.com/datasets/s-and-p-500-companies). Pure parsing + validation here; server.js fetches and serves.
const SOURCE = "github.com/datasets/s-and-p-500-companies";
const CSV_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const MIN_ROWS = 480, MAX_ROWS = 520; // the index has ~503 lines (some companies have two share classes)

// RFC 4180-style CSV: quoted fields, doubled quotes, commas and newlines inside quotes.
function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  const s = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

// Returns { rows: [[symbol, name, sector, subIndustry]], asOf } or throws when the file doesn't look like the S&P 500.
function constituentsFromCsv(text, asOf) {
  const table = parseCsv(text);
  if (!table.length) throw new Error("empty constituents file");
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const iSym = col("symbol", "ticker"), iName = col("security", "name", "company"), iSec = col("gics sector", "sector"), iSub = col("gics sub-industry", "sub-industry", "industry");
  if (iSym < 0 || iName < 0 || iSec < 0) throw new Error("unexpected constituents columns");
  const seen = new Set(), rows = [];
  for (const r of table.slice(1)) {
    const sym = String(r[iSym] || "").trim().toUpperCase().replace(/\./g, "-");
    if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(sym) || seen.has(sym)) continue;
    seen.add(sym);
    rows.push([sym, String(r[iName] || "").trim() || sym, String(r[iSec] || "").trim(), iSub >= 0 ? String(r[iSub] || "").trim() : ""]);
  }
  if (rows.length < MIN_ROWS || rows.length > MAX_ROWS) throw new Error(`constituents file has ${rows.length} rows; expected about 503`);
  return { asOf, source: SOURCE, rows };
}

// What changed between two lists (for the log and the "joined the S&P 500" note).
function diff(oldRows, newRows) {
  const a = new Set((oldRows || []).map((r) => r[0])), b = new Set((newRows || []).map((r) => r[0]));
  return { added: [...b].filter((s) => !a.has(s)).sort(), removed: [...a].filter((s) => !b.has(s)).sort() };
}

module.exports = { SOURCE, CSV_URL, MIN_ROWS, MAX_ROWS, parseCsv, constituentsFromCsv, diff };

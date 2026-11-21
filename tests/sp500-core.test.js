"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const SP = require("../sp500-core.js");
const bundled = require("../public/sp500.json");

// Build a realistic CSV from the bundled list (the same dataset the server downloads)
const csvOf = (rows) => "Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,Date added,CIK,Founded\n" +
  rows.map(([s, n, sec, sub]) => [s.replace("-", "."), /[,"]/.test(n) ? `"${n.replace(/"/g, '""')}"` : n, sec, `"${sub}"`, '"Somewhere, USA"', "2000-01-01", "0000000001", "1900"].join(",")).join("\r\n") + "\r\n";

test("parses quoted CSV fields, doubled quotes and commas", () => {
  assert.deepEqual(SP.parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n'), [["a", "b, c", 'say "hi"'], ["1", "2", "3"]]);
  assert.deepEqual(SP.parseCsv("﻿x,y\n\n"), [["x", "y"]]);
});

test("reads the dataset's columns and converts BRK.B to BRK-B like the rest of the site", () => {
  const out = SP.constituentsFromCsv(csvOf(bundled.rows), "2026-11-21");
  assert.equal(out.rows.length, bundled.rows.length);
  assert.deepEqual(out.rows.find((r) => r[0] === "BRK-B"), bundled.rows.find((r) => r[0] === "BRK-B"));
  assert.deepEqual(out.rows[0], bundled.rows[0]);
  assert.equal(out.asOf, "2026-11-21");
  assert.equal(out.source, SP.SOURCE);
});

test("rejects files that don't look like the S&P 500, so the last good list is kept", () => {
  assert.throws(() => SP.constituentsFromCsv("", "d"), /empty/);
  assert.throws(() => SP.constituentsFromCsv("foo,bar\n1,2\n", "d"), /columns/);
  assert.throws(() => SP.constituentsFromCsv(csvOf(bundled.rows.slice(0, 100)), "d"), /expected about 503/);
  assert.throws(() => SP.constituentsFromCsv("<html>Rate limited</html>", "d"));
});

test("reports which companies joined or left", () => {
  const d = SP.diff([["AAA"], ["BBB"]], [["BBB"], ["CCC"]]);
  assert.deepEqual(d, { added: ["CCC"], removed: ["AAA"] });
});

"use strict";
const DAY = 86_400_000;
const dayMs = (day) => /^\d{4}-\d{2}-\d{2}$/.test(day || "") ? Date.parse(day + "T00:00:00Z") : NaN;

function parseRateCsv(text, dateColumns, rateHeader, normalizeDay) {
  const rows = String(text).replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const cols = rows.shift().split(",").map((s) => s.trim().replace(/^"|"$/g, "").toUpperCase());
  const dateColumn = cols.findIndex((s) => dateColumns.includes(s));
  const rateColumn = cols.indexOf(rateHeader);
  if (dateColumn < 0 || rateColumn < 0) throw new Error(`${rateHeader} CSV headers missing`);
  const dated = new Map();
  for (const row of rows) {
    const c = row.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    const day = normalizeDay(c[dateColumn]), raw = c[rateColumn];
    const ms = dayMs(day), ratePct = Number(raw);
    if (Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day && raw !== "" &&
        Number.isFinite(ratePct) && ratePct > -100) dated.set(day, ratePct);
  }
  return [...dated].sort(([a], [b]) => a.localeCompare(b)).map(([day, ratePct]) => ({ day, ratePct }));
}

function parseDgs3moCsv(text) {
  return parseRateCsv(text, ["DATE", "OBSERVATION_DATE"], "DGS3MO", (day) => day);
}

function parseTreasuryCsv(text) {
  return parseRateCsv(text, ["DATE"], "3 MO", (date) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date || "");
    return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : date;
  });
}

function rateBefore(observations, day, { maxAgeDays = 7 } = {}) {
  const ms = dayMs(day);
  if (!Number.isFinite(ms)) return null;
  for (let i = observations.length - 1; i >= 0; i--) {
    const p = observations[i];
    if (p.day >= day) continue;
    const ageDays = (ms - dayMs(p.day)) / DAY;
    return ageDays <= maxAgeDays ? { ...p, ageDays } : null;
  }
  return null;
}

function cashBenchmark({ sessions, observations = [], recordedRates = {}, initial = 1, maxAgeDays = 7 }) {
  let value = initial, previous = null, missingIntervals = 0;
  const points = [];
  for (const day of [...new Set(sessions)].sort()) {
    if (!Number.isFinite(dayMs(day))) continue;
    const rate = Object.hasOwn(recordedRates, day) ? recordedRates[day] : rateBefore(observations, day, { maxAgeDays });
    const intervalRate = previous?.rate ?? null;
    if (previous) {
      const days = (dayMs(day) - dayMs(previous.day)) / DAY;
      if (!intervalRate || intervalRate.ageDays + days > maxAgeDays) { value = null; missingIntervals++; }
      else if (value != null) value *= (1 + intervalRate.ratePct / 100) ** (days / 365);
    }
    points.push({ day, rate, intervalRate, value });
    previous = { day, rate };
  }
  return { points, complete: missingIntervals === 0, missingIntervals };
}

module.exports = { parseDgs3moCsv, parseTreasuryCsv, rateBefore, cashBenchmark };

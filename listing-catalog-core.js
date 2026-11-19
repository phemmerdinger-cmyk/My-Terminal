"use strict";

const DIRECTORY_EXCHANGES = Object.freeze({ A: "NYSE American", N: "NYSE", P: "NYSE Arca", Z: "Cboe BZX", V: "IEX" });
const SEC_EXCHANGES = new Map([
  ["NASDAQ", "Nasdaq"], ["NYSE", "NYSE"], ["NYSE AMERICAN", "NYSE American"], ["NYSE MKT", "NYSE American"],
  ["NYSE ARCA", "NYSE Arca"], ["CBOE", "Cboe"], ["CBOE BZX", "Cboe BZX"], ["BATS", "Cboe BZX"],
  ["IEX", "IEX"], ["MEMX", "MEMX"], ["MIAX PEARL", "MIAX Pearl"], ["NYSE TEXAS", "NYSE Texas"],
]);

const clean = (value) => typeof value === "string" ? value.trim() : "";
const field = (value) => clean(value).toLowerCase();
const symbolKey = (input) => {
  const raw = clean(input).toUpperCase();
  // Match dot/dash class aliases across sources without collapsing the related classes.
  if (/^[A-Z0-9]{1,10}[.-][A-Z]{1,2}$/.test(raw)) return raw.replace("-", ".");
  return /^[A-Z0-9]{1,10}(?:[.\-^$+=][A-Z0-9]{0,4})?$/.test(raw) ? raw : null;
};
const timeOrNull = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

function secRows(payload) {
  if (!Array.isArray(payload?.fields) || !Array.isArray(payload?.data)) return [];
  const fields = payload.fields.map(field);
  const columns = ["cik", "name", "ticker", "exchange"].map((key) => fields.indexOf(key));
  if (columns.includes(-1)) return [];
  const rows = [];
  for (const data of payload.data) {
    if (!Array.isArray(data)) continue;
    const [rawCik, rawName, rawTicker, rawExchange] = columns.map((column) => data[column]);
    const cik = Number(rawCik), name = clean(rawName), ticker = clean(rawTicker).toUpperCase();
    const symbol = symbolKey(ticker), exchange = SEC_EXCHANGES.get(clean(rawExchange).toUpperCase());
    if (!name || !symbol || !exchange || !Number.isInteger(cik) || cik <= 0) continue;
    rows.push({ symbol, ticker, name, cik, exchange });
  }
  return rows;
}

function directoryRows(text, directory) {
  const other = directory === "other";
  const lines = clean(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  const head = lines[0].split("|").map(field);
  const columns = (other ? ["act symbol", "security name", "exchange", "test issue", "etf", "nasdaq symbol", "cqs symbol"] :
    ["symbol", "security name", "market category", "test issue", "etf"]).map((key) => head.indexOf(key));
  const rows = [];
  let fileCreationTime = null;
  if (columns.includes(-1)) return { rows, complete: false, fileCreationTime };
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (/^File Creation Time:/i.test(parts[0])) {
      fileCreationTime = /\b(\d{10}:?\d{2})\b/.exec(parts[0])?.[1] ?? null;
      // The provider publishes its file timestamp separately from any security history.
      break;
    }
    const [rawSymbol, rawName, rawVenue, isTest, etf, nasdaqSymbol, cqsSymbol] = columns.map((column) => clean(parts[column]));
    const symbol = symbolKey(rawSymbol), exchange = other ? DIRECTORY_EXCHANGES[rawVenue] : rawVenue ? "Nasdaq" : null;
    if (isTest !== "N" || !symbol || !rawName || !exchange) continue;
    rows.push({ symbol, securityName: rawName, exchange, directory,
      directorySymbol: rawSymbol, nasdaqSymbol: other ? nasdaqSymbol || null : rawSymbol,
      cqsSymbol: other ? cqsSymbol || null : null, isEtf: etf === "Y" ? true : etf === "N" ? false : null });
  }
  return { rows, complete: rows.length > 0 && fileCreationTime !== null, fileCreationTime };
}

function buildListingCatalog({ sec, nasdaqListed, otherListed, previous, observedAt } = {}) {
  const at = timeOrNull(observedAt);
  const secBySymbol = new Map();
  for (const row of secRows(sec)) {
    if (!secBySymbol.has(row.symbol)) secBySymbol.set(row.symbol, row);
  }

  const nasdaq = directoryRows(nasdaqListed, "nasdaq"), other = directoryRows(otherListed, "other");
  const directories = {
    nasdaq: { complete: nasdaq.complete, fileCreationTime: nasdaq.fileCreationTime, count: nasdaq.rows.length },
    other: { complete: other.complete, fileCreationTime: other.fileCreationTime, count: other.rows.length },
  };
  const directoryId = ({ directory, directorySymbol }) => directory && directorySymbol ? directory + ":" + directorySymbol : null;
  const oldEntries = Array.isArray(previous?.entries) ? previous.entries : [];
  const oldByDirectoryId = new Map(oldEntries.filter((item) => item && directoryId(item)).map((item) => [directoryId(item), item]));
  const merged = new Map();
  for (const row of [...nasdaq.rows, ...other.rows]) {
    // Rows with a canonical listing symbol duplicated across files retain the source that agrees with the SEC venue.
    const issuer = secBySymbol.get(row.symbol), existing = merged.get(row.symbol);
    if (existing && (existing.exchange === issuer?.exchange || row.exchange !== issuer?.exchange)) continue;
    const earlier = oldByDirectoryId.get(directoryId(row));
    const firstSeenAt = timeOrNull(earlier?.firstSeenAt) ?? at;
    const newlyObserved = !earlier && at !== null && directories[row.directory].complete && previous?.directories?.[row.directory]?.complete === true;
    merged.set(row.symbol, { ...row, firstSeenAt, newlyObserved,
      newlyObservedAt: newlyObserved ? at : timeOrNull(earlier?.newlyObservedAt) });
  }

  const symbols = [...new Set([...secBySymbol.keys(), ...merged.keys()])];
  const entries = symbols.map((symbol) => {
    const issuer = secBySymbol.get(symbol), listing = merged.get(symbol);
    return {
      symbol,
      providerSymbol: issuer?.ticker.replaceAll(".", "-") ?? symbol.replaceAll(".", "-"),
      name: issuer?.name ?? listing.securityName,
      cik: issuer?.cik ?? null,
      exchange: listing?.exchange ?? issuer.exchange,
      directory: listing?.directory ?? null,
      directorySymbol: listing?.directorySymbol ?? null,
      nasdaqSymbol: listing?.nasdaqSymbol ?? null,
      cqsSymbol: listing?.cqsSymbol ?? null,
      securityName: listing?.securityName ?? null,
      isEtf: listing?.isEtf ?? null,
      firstSeenAt: listing?.firstSeenAt ?? null,
      newlyObserved: listing?.newlyObserved ?? false,
      newlyObservedAt: listing?.newlyObservedAt ?? null,
      sources: [...(issuer ? ["SEC EDGAR"] : []), ...(listing ? ["Nasdaq Trader"] : [])],
    };
  });
  return { entries, directories, observedAt: at };
}

function searchableName(value) {
  return clean(value).normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}
function searchListingCatalog(catalog, query, limit = 12) {
  const ticker = clean(query).toUpperCase().replace("-", "."), name = searchableName(query);
  if (!ticker || !Array.isArray(catalog?.entries) || !Number.isInteger(limit) || limit < 1) return [];
  const matches = [];
  for (const item of catalog.entries) {
    const aliases = [item.symbol, item.providerSymbol, item.nasdaqSymbol, item.cqsSymbol]
      .filter(Boolean).map((alias) => alias.toUpperCase().replace("-", "."));
    const names = [item.name, item.securityName].map(searchableName);
    let score = -1;
    if (aliases.includes(ticker)) score = 0;
    else if (aliases.some((alias) => alias.startsWith(ticker))) score = 1;
    else if (name && names.includes(name)) score = 2;
    else if (name && names.some((alias) => alias.startsWith(name))) score = 3;
    if (score >= 0) matches.push({ item, score });
  }
  return matches.sort((a, b) => a.score - b.score || a.item.symbol.localeCompare(b.item.symbol))
    .slice(0, limit).map(({ item }) => item);
}

function recentListingCatalog(catalog, { now, days = 7, limit = 12 } = {}) {
  if (timeOrNull(now) === null || !Number.isFinite(days) || days <= 0 || !Number.isInteger(limit) || limit < 1) return [];
  const since = now - days * 86_400_000;
  return (catalog?.entries ?? []).filter((item) => item.directory && timeOrNull(item.newlyObservedAt) !== null &&
    item.newlyObservedAt >= since && item.newlyObservedAt <= now)
    .sort((a, b) => b.newlyObservedAt - a.newlyObservedAt || a.symbol.localeCompare(b.symbol)).slice(0, limit);
}

module.exports = { buildListingCatalog, searchListingCatalog, recentListingCatalog };

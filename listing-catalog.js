"use strict";

const { buildListingCatalog, searchListingCatalog, recentListingCatalog } = require("./listing-catalog-core.js");
const REFRESH_MS = 30 * 60_000;
const RETRY_MS = 5 * 60_000;
const DIRECTORIES = { nasdaq: "nasdaqListed", other: "otherListed" };
const fileOrder = (timestamp) => {
  const parts = /^(\d{2})(\d{2})(\d{4})(\d{2}):?(\d{2})$/.exec(timestamp || "");
  return parts ? parts[3] + parts[1] + parts[2] + parts[4] + parts[5] : "";
};

function unpack(checkpoint) {
  if (!Array.isArray(checkpoint?.rows)) return null;
  return {
    directories: checkpoint.directories,
    entries: checkpoint.rows.map(([directory, directorySymbol, firstSeenAt, newlyObservedAt]) =>
      ({ directory, directorySymbol, firstSeenAt, newlyObservedAt })),
  };
}

function pack(catalog, previous) {
  const directories = {};
  const rows = [];
  for (const directory of Object.keys(DIRECTORIES)) {
    const verified = catalog.directories[directory].complete;
    directories[directory] = verified ? { complete: true, fileCreationTime: catalog.directories[directory].fileCreationTime } :
      previous?.directories?.[directory] || { complete: false };
    for (const row of (verified ? catalog.entries : previous?.entries || [])) {
      if (row.directory === directory) rows.push([directory, row.directorySymbol, row.firstSeenAt, row.newlyObservedAt]);
    }
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return { directories, rows };
}

function createListingCatalog({ store, feeds, now = Date.now }) {
  let catalog, previous, saved, inFlight, nextCheck = 0;
  const inputs = {};

  function refresh() {
    if (inFlight) return inFlight;
    if (now() < nextCheck) return Promise.resolve(catalog);
    inFlight = (async () => {
      const sources = Object.entries(feeds);
      const state = previous === undefined ? store.get("baseline") : Promise.resolve(null);
      const [initial, ...results] = await Promise.allSettled([state, ...sources.map(([, get]) => get())]);
      if (previous === undefined && initial.status === "fulfilled") {
        previous = unpack(initial.value);
        saved = initial.value ? JSON.stringify(initial.value) : undefined;
      }
      const batch = Object.fromEntries(results.flatMap((result, i) =>
        result.status === "fulfilled" ? [[sources[i][0], result.value]] : []));
      const validated = buildListingCatalog(batch);
      const acceptedSec = validated.entries.some((entry) => entry.cik != null);
      if (acceptedSec) inputs.sec = batch.sec;
      let acceptedDirectories = 0;
      for (const [directory, source] of Object.entries(DIRECTORIES)) {
        const next = validated.directories[directory], old = previous?.directories?.[directory];
        if (next.complete && fileOrder(next.fileCreationTime) >= fileOrder(old?.fileCreationTime)) {
          inputs[source] = batch[source];
          acceptedDirectories++;
        }
      }
      const next = buildListingCatalog({ ...inputs, previous, observedAt: now() });
      if (next.entries.length) catalog = next;
      if (previous !== undefined && acceptedDirectories) {
        const checkpoint = pack(next, previous);
        const json = JSON.stringify(checkpoint);
        if (json !== saved) {
          await store.set("baseline", checkpoint);
          saved = json;
        }
        previous = unpack(checkpoint);
      }
      nextCheck = now() + (acceptedSec && acceptedDirectories === Object.keys(DIRECTORIES).length ? REFRESH_MS : RETRY_MS);
      return catalog;
    })().catch(() => {
      nextCheck = now() + RETRY_MS;
      return catalog;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    refresh,
    search: (query) => searchListingCatalog(catalog, query),
    recent: () => recentListingCatalog(catalog, { now: now() }),
    ready: () => !!catalog,
  };
}

module.exports = { createListingCatalog, REFRESH_MS };

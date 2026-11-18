"use strict";

const Volume = require("./day-volume-core.js");

function createDayVolume({ store }) {
  let state, loaded, updating = false, lastError = null;

  function load() {
    if (!loaded) {
      loaded = store.get("trials").then((value) => { state = value; }).catch((error) => {
        loaded = null;
        throw error;
      });
    }
    return loaded;
  }

  async function observe(input) {
    if (updating) return;
    updating = true;
    try {
      await load();
      if (state?.observedAt >= input.now) return;
      const next = Volume.advanceVolumeTrials(state, input);
      if (next !== state) await store.set("trials", next);
      state = next;
      lastError = null;
    } catch (error) {
      lastError = String(error.message || error).slice(0, 180);
    } finally {
      updating = false;
    }
  }

  async function view() {
    try { await load(); }
    catch (error) { lastError = String(error.message || error).slice(0, 180); }
    return { ...Volume.volumeSummary(state), durable: store.durable, error: lastError };
  }

  return { observe, view, symbols: () => Volume.volumeSymbols(state) };
}

module.exports = { createDayVolume };

"use strict";

const DAY_SECONDS = 86_400;
const positive = (value) => Number.isFinite(value) && value > 0;
const timestamp = (value) => Number.isInteger(value) && value > 0 && value <= 8.64e12 - DAY_SECONDS;
const empty = () => ({ preMarket: null, postMarket: null });

function period(value) {
  return timestamp(value?.start) && timestamp(value?.end) && value.start < value.end ? value : null;
}

function sessionDates(meta, regular) {
  const offset = [regular.gmtoffset, meta.gmtoffset].find((value) => Number.isInteger(value) && Math.abs(value) < DAY_SECONDS);
  if (meta.exchangeTimezoneName || offset == null) {
    try {
      const format = new Intl.DateTimeFormat("en-CA", { timeZone: meta.exchangeTimezoneName || "America/New_York" });
      return (seconds) => format.format(seconds * 1000);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  return (seconds) => new Date((seconds + (offset ?? 0)) * 1000).toISOString().slice(0, 10);
}

function priceIn(segment, timestamps, bars, asOf, requireVolume = false) {
  if (!segment) return null;
  let latest = null;
  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i], price = bars.close?.[i], volume = bars.volume?.[i];
    if (!timestamp(time) || time > asOf || time < segment.start || time >= segment.end ||
        !positive(price) || (requireVolume && !positive(volume)) || (latest && time <= latest.time)) continue;
    latest = { time, price };
  }
  return latest;
}

function asQuote(print, reference) {
  if (!print) return null;
  const change = positive(reference) ? print.price - reference : null;
  return { price: print.price, marketTime: print.time * 1000, change,
    changePct: change === null ? null : change / reference * 100 };
}

function getExtendedQuotes(meta, timestamps, bars, { debut = false, now = Date.now(), barSeconds = 300 } = {}) {
  const trading = meta?.currentTradingPeriod;
  const regular = period(trading?.regular);
  const asOf = Math.floor(now / 1000);
  if (!regular || !Array.isArray(timestamps) || !bars || !timestamp(asOf)) return empty();
  const dateOf = sessionDates(meta, regular);
  const day = dateOf(regular.start);
  if (dateOf(asOf) !== day || dateOf(regular.end - 1) !== day) return empty();

  const pre = period(trading.pre), post = period(trading.post);
  // Yahoo can supply extended prices without volume. Only regular bars used to verify an IPO trade require volume.
  const prePrint = !debut && pre && pre.end <= regular.start && dateOf(pre.start) === day
    ? priceIn(pre, timestamps, bars, asOf) : null;
  const postPrint = post && post.start >= regular.end && asOf >= post.start && dateOf(post.start) === day
    ? priceIn(post, timestamps, bars, asOf) : null;
  const previous = [meta.chartPreviousClose, meta.previousClose].find(positive);
  if (!postPrint) return { preMarket: asQuote(prePrint, previous), postMarket: null };

  const regularPrint = priceIn(regular, timestamps, bars, asOf, true);
  if (debut && !regularPrint) return empty();
  const regularMarketTime = meta.regularMarketTime;
  const quotedClose = !debut && positive(meta.regularMarketPrice) && timestamp(regularMarketTime) &&
    regularMarketTime >= regular.start && regularMarketTime <= regular.end && regularMarketTime <= asOf &&
    (regularPrint || positive(meta.regularMarketVolume)) && (!regularPrint || regularMarketTime >= regularPrint.time);
  // A lone earlier candle cannot establish the regular close.
  const baseline = quotedClose ? meta.regularMarketPrice :
    regularPrint?.time >= regular.end - barSeconds ? regularPrint.price : null;
  return { preMarket: asQuote(prePrint, previous), postMarket: asQuote(postPrint, baseline) };
}

module.exports = { getExtendedQuotes };

// Durable key-value storage for THE WEB.
// Uses the same free Upstash Redis database as device sync and the trading bots when
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set; otherwise a JSON file per key
// in the server's temp folder (which Render's free plan wipes on redeploy or sleep).
const fs = require("fs");
const path = require("path");

function createStore({ url, token, dir, prefix = "pft:web:v1:", fetchImpl = globalThis.fetch } = {}) {
  const durable = !!(url && token);
  const fileDir = dir || path.join(require("os").tmpdir(), "the-web");
  const fileOf = (k) => path.join(fileDir, k.replace(/[^a-z0-9_.-]/gi, "_") + ".json");
  let writes = 0, reads = 0, lastError = null;

  async function get(key) {
    const k = prefix + key; reads++;
    if (durable) {
      try {
        const r = await fetchImpl(`${url}/get/${encodeURIComponent(k)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
        const j = await r.json();
        if (j.result) return JSON.parse(j.result);
        if (j.result === null) return null;
      } catch (e) { lastError = String(e.message || e); }
      // fall through to the local copy if Upstash is unreachable
    }
    try { return JSON.parse(fs.readFileSync(fileOf(k), "utf8")); } catch { return null; }
  }
  async function set(key, value) {
    const k = prefix + key, body = JSON.stringify(value); writes++;
    if (body.length > 900_000) throw new Error(`THE WEB: ${key} is too large to save (${body.length} bytes)`);
    try { fs.mkdirSync(fileDir, { recursive: true }); fs.writeFileSync(fileOf(k), body); } catch (e) { lastError = String(e.message || e); }
    if (durable) {
      try {
        const r = await fetchImpl(`${url}/set/${encodeURIComponent(k)}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error("Upstash returned " + r.status);
      } catch (e) { lastError = String(e.message || e); throw e; }
    }
  }
  async function del(key) {
    const k = prefix + key;
    try { fs.unlinkSync(fileOf(k)); } catch {}
    if (durable) { try { await fetchImpl(`${url}/del/${encodeURIComponent(k)}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }); } catch {} }
  }
  return { get, set, del, durable, info: () => ({ durable, backend: durable ? "Upstash Redis" : "server temp folder", writes, reads, lastError }) };
}

module.exports = { createStore };

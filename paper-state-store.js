"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function paperStore(namespace, { url, token, dir = os.tmpdir(), fetchImpl = fetch } = {}) {
  const durable = !!(url && token);
  const file = (key) => path.join(dir, `${namespace}-${key}.json`);
  const remote = (operation, key) => `${url}/${operation}/${encodeURIComponent(`pft:${namespace}:${key}`)}`;
  const options = () => ({ headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
  async function get(key) {
    if (durable) {
      const r = await fetchImpl(remote("get", key), options());
      const body = await r.json();
      if (!r.ok || !Object.hasOwn(body, "result")) throw new Error("Paper book storage could not be read");
      return body.result == null ? null : JSON.parse(body.result);
    }
    try { return JSON.parse(fs.readFileSync(file(key), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async function set(key, value) {
    const body = JSON.stringify(value);
    if (durable) {
      const r = await fetchImpl(remote("set", key), { ...options(), method: "POST", body });
      if (!r.ok || (await r.json()).result !== "OK") throw new Error("Paper book storage did not acknowledge the write");
    } else {
      const f = file(key);
      fs.writeFileSync(f + ".tmp", body);
      fs.renameSync(f + ".tmp", f);
    }
  }
  return { durable, get, set };
}

module.exports = { paperStore };

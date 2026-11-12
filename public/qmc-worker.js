/* Monte Carlo runs here, off the main thread, so the page stays at 60 FPS while thousands of paths are simulated. */
importScripts("/qmath.js");
onmessage = (e) => {
  const t0 = Date.now();
  try { const r = QMATH.monteCarlo({ ...e.data, onProgress: (f) => postMessage({ progress: f }) }); postMessage({ done: true, result: r, ms: Date.now() - t0 }); }
  catch (err) { postMessage({ error: String(err.message || err) }); }
};

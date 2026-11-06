// Minimal service worker so the site can be installed as an app. It doesn't cache anything,
// so prices and news are always live.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',()=>{});

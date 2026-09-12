/* Prism service worker — the game must be playable with the radio off. */
const CACHE = 'prism-v3';
const SHELL = [
  './',
  './index.html',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=> c.addAll(SHELL)).then(()=> self.skipWaiting()));
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=> Promise.all(keys.filter(k=> k !== CACHE).map(k=> caches.delete(k))))
      .then(()=> self.clients.claim())
  );
});

self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Supabase is never cached: auth, leaderboard and run submission must always
     hit the network, and a stale rank is worse than no rank. */
  if(url.origin !== self.location.origin) return;
  if(url.pathname.startsWith('/auth/v1') ||
     url.pathname.startsWith('/rest/v1') ||
     url.pathname.startsWith('/functions/v1')) return;

  /* app shell: cache first, refresh in the background */
  e.respondWith(
    caches.match(req).then(hit=>{
      const live = fetch(req).then(res=>{
        if(res && res.status === 200 && res.type === 'basic'){
          const copy = res.clone();
          caches.open(CACHE).then(c=> c.put(req, copy));
        }
        return res;
      }).catch(()=> hit);
      return hit || live;
    })
  );
});

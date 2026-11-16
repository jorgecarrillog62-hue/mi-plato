// Guarda la app en el teléfono para que abra sin internet.
// Responde desde caché y actualiza en segundo plano: un cambio publicado se ve la siguiente vez que abras la app.
// Sube el número de C en cada cambio publicado. Tus registros viven en localStorage y no se tocan aquí.
const C = 'plato-v2';
const FILES = ['./', 'index.html', 'app.js', 'motor.js', 'foods.json', 'mis_alimentos.json', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

// cache: 'reload' evita que el caché HTTP de GitHub Pages entregue la versión vieja al instalar.
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // la API de Claude va directo a la red
  e.respondWith(caches.open(C).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

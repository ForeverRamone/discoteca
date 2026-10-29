// Service worker: guarda la interfaz para que la app abra rápido y funcione sin conexión
// (mostrando un aviso). Los datos (/api) nunca se guardan aquí: siempre van al servidor.
const VERSION = 'discoteca-v10';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/dom.js',
  '/js/store.js',
  '/js/components.js',
  '/js/views.js',
  '/js/sidebar.js',
  '/js/imports.js',
  '/js/reorder.js',
  '/js/backup.js',
  '/js/bandcamp.js',
  '/js/refresh.js',
  '/js/images.js',
  '/vendor/sortable.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Primero la red (para tener siempre la última versión); si no hay conexión, la copia guardada.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/index.html') : undefined))),
  );
});

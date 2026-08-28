// POS Sprint 2 — service worker kill-switch.
// No cachea ni intercepta tráfico. Su única función es reemplazar SW antiguos,
// limpiar Cache Storage y desinstalarse para evitar chunks obsoletos.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.clients.claim();
    await self.registration.unregister();
  })());
});

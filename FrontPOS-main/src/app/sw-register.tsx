'use client';

import { useEffect } from 'react';

const CLEANUP_VERSION = 'pos-sw-cleanup-v2';
const RELOAD_GUARD = 'pos-sw-cleanup-reloaded-v2';

function waitForWorker(worker: ServiceWorker | null, timeoutMs = 4000): Promise<void> {
  if (!worker || worker.state === 'activated' || worker.state === 'redundant') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, timeoutMs);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated' || worker.state === 'redundant') {
        window.clearTimeout(timeout);
        resolve();
      }
    });
  });
}

export default function SWRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const cleanLegacyServiceWorkers = async () => {
      try {
        const alreadyCleaned = localStorage.getItem(CLEANUP_VERSION) === '1';
        if (!alreadyCleaned) {
          // Fuerza a instalaciones antiguas a descargar el kill-switch actual.
          const registration = await navigator.serviceWorker.register('/sw.js', {
            scope: '/',
            updateViaCache: 'none',
          });
          await registration.update().catch(() => undefined);
          await waitForWorker(registration.installing ?? registration.waiting ?? registration.active);
        }

        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((key) => caches.delete(key)));
        }
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
        localStorage.setItem(CLEANUP_VERSION, '1');

        // unregister no libera el controller de la pestaña actual. Una sola
        // recarga garantiza que los chunks siguientes vengan directamente de red.
        if (navigator.serviceWorker.controller && sessionStorage.getItem(RELOAD_GUARD) !== '1') {
          sessionStorage.setItem(RELOAD_GUARD, '1');
          window.location.reload();
        }
      } catch (error) {
        console.warn('[PWA cleanup] No se pudo completar el saneo:', error);
      }
    };

    void cleanLegacyServiceWorkers();
  }, []);

  return null;
}

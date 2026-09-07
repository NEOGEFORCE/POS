"use client";

import { useEffect, useRef } from 'react';

import { getSessionToken } from '@/lib/session';
import { setupSyncListener, revalidateKeysForEvent } from '@/lib/revalidate';
import { syncOfflineSalesQueue } from '@/lib/offline-sync';
import { shouldSyncCatalog, syncFloorForReason } from '@/lib/catalog-sync-policy.mjs';

/**
 * SyncBackground: motor invisible de sincronización.
 *
 * Responsabilidades:
 *  1. Subir ventas offline pendientes cada 15s.
 *  2. Mantener el catálogo local (IndexedDB) razonablemente fresco para el
 *     modo offline.
 *  3. Reaccionar a eventos globales (BroadcastChannel) revalidando SWR.
 *
 * ESTRATEGIA DEL CATÁLOGO OFFLINE (justificada):
 *
 *   El catálogo local en IndexedDB SÓLO se usa para vender si el servidor
 *   cae. Las vistas normales del POS ya viven sobre SWR + SSE. Antes se
 *   re-bajaba el catálogo completo (~2168 productos) en cada `PRODUCT_UPDATE`
 *   / `STOCK_UPDATE` / `INVENTORY_UPDATE`, replicado a cada una de las 32
 *   pestañas abiertas del navegador; el botón +/- de stock disparaba
 *   descargas en cascada y saturaba red, backend e IndexedDB.
 *
 *   Ahora:
 *     - El sync completo ocurre por TIEMPO, no por evento. Un ajuste de
 *       cantidad NO dispara este proceso.
 *     - Cadencia base: `CATALOG_SYNC_INTERVAL_MS` (30 min).
 *     - Piso duro compartido entre pestañas vía `localStorage`: no se
 *       sincroniza si la última corrida fue hace menos de 10 min, aunque
 *       varias pestañas monten a la vez o se recarguen a la vez.
 *     - Excepción: al volver la red (`online`) el piso baja a 1 min, porque
 *       durante el corte se vendió contra este snapshot y es justo cuando
 *       más importa refrescarlo. El piso de 1 min evita que una red
 *       intermitente dispare una descarga por cada parpadeo.
 *     - Single-flight en memoria: dos disparos concurrentes en la misma
 *       pestaña no se solapan.
 *     - La lógica pura vive en `catalog-sync-policy.mjs` y se testea con
 *       `node --test`.
 *
 *   ¿Por qué no actualizar sólo el producto que cambió?
 *   Hoy los eventos de sincronización (`SyncEvent`) son strings sin payload
 *   (`revalidate.ts`): no incluyen el barcode. Extender el broadcast para
 *   llevar payload sería otra etapa; con lo actual, un update puntual desde
 *   otra pestaña no tendría de dónde sacar el código. Por eso conservamos
 *   el snapshot periódico como fallback correcto para el uso offline.
 */

const CATALOG_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const CATALOG_LAST_SYNC_KEY = 'pos:catalog-last-sync';
const OFFLINE_QUEUE_INTERVAL_MS = 15_000;

function readLastSyncAt(): number | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(CATALOG_LAST_SYNC_KEY);
        if (!raw) return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function writeLastSyncAt(ts: number): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(CATALOG_LAST_SYNC_KEY, String(ts));
    } catch {
        /* almacenamiento no disponible: ignoramos */
    }
}

function resolveApiBase(): string {
    const raw = process.env.NEXT_PUBLIC_API_URL;
    return raw && raw !== 'undefined' ? raw : '/api';
}

export default function SyncBackground() {
    // 1) Cola de ventas offline (barata, se queda igual).
    useEffect(() => {
        const syncInterval = setInterval(() => {
            if (!navigator.onLine) return;
            void syncOfflineSalesQueue().catch((err) => {
                console.error("[SYNC] Error critico en motor de sincronizacion:", err);
            });
        }, OFFLINE_QUEUE_INTERVAL_MS);

        return () => clearInterval(syncInterval);
    }, []);

    // 2) Sincronización del catálogo completo. Sólo por tiempo, single-flight
    //    y con piso compartido entre pestañas.
    const syncingRef = useRef(false);
    useEffect(() => {
        const runCatalogSync = async (reason: 'mount' | 'interval' | 'reconnect') => {
            if (typeof window === 'undefined') return;
            if (syncingRef.current) return;
            if (!navigator.onLine) return;

            const now = Date.now();
            const minIntervalMs = syncFloorForReason(reason);
            if (!shouldSyncCatalog({ lastSyncAt: readLastSyncAt(), now, minIntervalMs })) return;

            const token = getSessionToken();
            if (!token) return;

            syncingRef.current = true;
            // Marca optimista para bloquear cascadas entre pestañas mientras
            // la petición está en vuelo (si falla se restablece la marca vieja).
            const previousMark = readLastSyncAt();
            writeLastSyncAt(now);

            try {
                console.log(`[SYNC] Actualizando catalogo local para modo offline (${reason})`);
                const res = await fetch(`${resolveApiBase()}/products/all-products`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const products = await res.json();
                const { saveProductsToCache } = await import('@/lib/offline-db');
                await saveProductsToCache(products);
                writeLastSyncAt(Date.now());
                console.log('[SYNC] Catalogo local actualizado correctamente.');
            } catch (err) {
                // Rollback de la marca para permitir reintento en el próximo tick.
                if (previousMark !== null) writeLastSyncAt(previousMark);
                else {
                    try { window.localStorage.removeItem(CATALOG_LAST_SYNC_KEY); } catch { /* noop */ }
                }
                console.warn('[SYNC] No se pudo actualizar el catalogo local (Servidor offline)', err);
            } finally {
                syncingRef.current = false;
            }
        };

        void runCatalogSync('mount');
        const catalogInterval = setInterval(() => {
            void runCatalogSync('interval');
        }, CATALOG_SYNC_INTERVAL_MS);

        // Al volver la red tras una caída se refresca pronto (piso de 1 min en
        // vez de 10), porque durante el corte se estuvo vendiendo contra este
        // mismo snapshot y es el momento en que más importa que esté al día.
        const handleOnline = () => {
            void runCatalogSync('reconnect');
        };
        window.addEventListener('online', handleOnline);

        return () => {
            clearInterval(catalogInterval);
            window.removeEventListener('online', handleOnline);
        };
    }, []);

    // 3) Listener centralizado de eventos de sincronización. Sólo revalida SWR.
    //    NO vuelve a bajar el catálogo entero, esa era la causa principal del
    //    lag reportado.
    useEffect(() => {
        const cleanup = setupSyncListener((event) => {
            console.log(`[BROADCAST] Recibido evento: ${event}`);
            revalidateKeysForEvent(event);
        });
        return cleanup;
    }, []);

    return null; // Componente invisible
}

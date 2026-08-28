"use client";

import { useEffect } from 'react';
import { getSessionToken } from '@/lib/session';
import { setupSyncListener, revalidateKeysForEvent } from '@/lib/revalidate';
import { syncOfflineSalesQueue } from '@/lib/offline-sync';

/**
 * SyncBackground: Motor de sincronizacion silencioso (Ultra-Instinto)
 * Revisa periodicamente la cola de IndexedDB y sube las ventas pendientes.
 */
export default function SyncBackground() {
    useEffect(() => {
        const syncInterval = setInterval(() => {
            if (!navigator.onLine) return;
            void syncOfflineSalesQueue().catch((err) => {
                console.error("[SYNC] Error critico en motor de sincronizacion:", err);
            });
        }, 15000);

        return () => clearInterval(syncInterval);
    }, []);

    // Sincronizacion periodica del catalogo completo (Cada 5 minutos)
    const syncFullCatalog = async () => {
        try {
            const token = getSessionToken();
            if (!token || !navigator.onLine) return;

            console.log("[SYNC] Actualizando catalogo local para modo offline...");
            const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/products/all-products`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.ok) {
                const products = await res.json();
                const { saveProductsToCache } = await import('@/lib/offline-db');
                await saveProductsToCache(products);
                console.log("[SYNC] Catalogo local actualizado correctamente.");
            }
        } catch (e) {
            console.warn("[SYNC] No se pudo actualizar el catalogo local (Servidor offline)");
        }
    };

    useEffect(() => {
        syncFullCatalog();
        const catalogInterval = setInterval(syncFullCatalog, 5 * 60 * 1000); // Cada 5 min
        return () => clearInterval(catalogInterval);
    }, []);

    // Listener de eventos de sincronizacion global (BroadcastChannel)
    useEffect(() => {
        const cleanup = setupSyncListener((event) => {
            console.log(`[BROADCAST] Recibido evento: ${event}`);
            revalidateKeysForEvent(event);
            
            // Si hay actualizacion de productos, forzar refresco de catalogo local
            if (event === 'PRODUCT_UPDATE' || event === 'STOCK_UPDATE' || event === 'INVENTORY_UPDATE') {
                syncFullCatalog();
            }
        });
        return cleanup;
    }, []);

    return null; // Componente invisible
}


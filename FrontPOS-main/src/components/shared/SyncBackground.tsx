"use client";

import { useEffect, useRef } from 'react';
import Cookies from 'js-cookie';
import { useToast } from '@/hooks/use-toast';
import { setupSyncListener, revalidateKeysForEvent } from '@/lib/revalidate';

/**
 * SyncBackground: Motor de sincronizacion silencioso (Ultra-Instinto)
 * Revisa periodicamente la cola de IndexedDB y sube las ventas pendientes.
 */
export default function SyncBackground() {
    const { toast } = useToast();
    const isSyncingRef = useRef(false);

    useEffect(() => {
        const syncInterval = setInterval(async () => {
            if (isSyncingRef.current || !navigator.onLine) return;

            try {
                const { getSyncQueue, removeFromSyncQueue } = await import('@/lib/offline-db');
                const queue = await getSyncQueue();

                // Filtrar las que ya fallaron permanentemente o excedieron reintentos
                // Nota: En la estructura actual de sync_queue, no tenemos retryCount explicito en el payload todavia,
                // pero procesaremos la cola segun el timestamp.
                if (queue.length === 0) return;

                isSyncingRef.current = true;
                const token = Cookies.get('org-pos-token');
                if (!token) {
                    isSyncingRef.current = false;
                    return;
                }

                console.log(`[SYNC] Intentando sincronizar ${queue.length} transacciones...`);
                let successCount = 0;

                for (const item of queue) {
                    try {
                        const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/sales/register`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${token}`
                            },
                            body: JSON.stringify(item.payload)
                        });

                        if (res.ok) {
                            await removeFromSyncQueue(item.id);
                            successCount++;
                        } else {
                            console.error(`[SYNC] Fallo al subir item ${item.id}:`, res.status);
                        }
                    } catch (e) {
                        // Error de red en este fetch individual, paramos el loop por este ciclo
                        break; 
                    }
                }

                if (successCount > 0) {
                    toast({
                        title: "SINCRO EXITOSA",
                        description: `${successCount} VENTAS SUBIDAS AL SERVIDOR`,
                    });
                }
            } catch (err) {
                console.error("[SYNC] Error critico en motor de sincronizacion:", err);
            } finally {
                isSyncingRef.current = false;
            }
        }, 15000); // Revisar cada 15 segundos para mayor agilidad (V9.5)

        return () => clearInterval(syncInterval);
    }, [toast]);

    // Sincronizacion periodica del catalogo completo (Cada 5 minutos)
    const syncFullCatalog = async () => {
        try {
            const token = Cookies.get('org-pos-token');
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


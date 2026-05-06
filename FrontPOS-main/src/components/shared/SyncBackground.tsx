"use client";

import { useEffect, useRef } from 'react';
import Cookies from 'js-cookie';
import { useToast } from '@/hooks/use-toast';
import { setupSyncListener, revalidateKeysForEvent } from '@/lib/revalidate';

/**
 * SyncBackground: Motor de sincronización silencioso (Ultra-Instinto)
 * Revisa periódicamente la cola de IndexedDB y sube las ventas pendientes.
 */
export default function SyncBackground() {
    const { toast } = useToast();
    const isSyncingRef = useRef(false);

    useEffect(() => {
        const syncInterval = setInterval(async () => {
            if (isSyncingRef.current || !navigator.onLine) return;

            try {
                const { getOfflineQueue, removeFromOfflineQueue, updateOfflineSale } = await import('@/lib/offline-db');
                const queue = await getOfflineQueue();

                // Filtrar las que ya fallaron permanentemente o excedieron reintentos
                const pendingQueue = queue.filter(s => (s.status !== 'failed') && (s.retryCount || 0) < 5);

                if (pendingQueue.length === 0) return;

                isSyncingRef.current = true;
                const token = Cookies.get('org-pos-token');
                if (!token) {
                    isSyncingRef.current = false;
                    return;
                }

                console.log(`[SYNC] Intentando sincronizar ${pendingQueue.length} ventas...`);
                let successCount = 0;

                for (const sale of pendingQueue) {
                    try {
                        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/register`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${token}`
                            },
                            body: JSON.stringify(sale.saleData)
                        });

                        if (res.ok) {
                            await removeFromOfflineQueue(sale.id);
                            successCount++;
                        } else {
                            const errorText = await res.text();
                            console.error(`[SYNC] Error en venta ${sale.id}:`, errorText);
                            
                            // Si es un error de validación (4xx), es probable que no se arregle solo
                            const isValidationError = res.status >= 400 && res.status < 500;
                            
                            await updateOfflineSale({
                                ...sale,
                                retryCount: (sale.retryCount || 0) + 1,
                                lastError: errorText,
                                status: isValidationError ? 'failed' : 'pending'
                            });
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
                console.error("[SYNC] Error crítico en motor de sincronización:", err);
            } finally {
                isSyncingRef.current = false;
            }
        }, 30000); // Revisar cada 30 segundos

        return () => clearInterval(syncInterval);
    }, [toast]);

    // Listener de eventos de sincronización global (BroadcastChannel)
    useEffect(() => {
        const cleanup = setupSyncListener((event) => {
            console.log(`[BROADCAST] Recibido evento: ${event}`);
            revalidateKeysForEvent(event);
        });
        return cleanup;
    }, []);

    return null; // Componente invisible
}

'use client';

import { useEffect, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import Cookies from 'js-cookie';
import { broadcastRevalidate } from '@/lib/revalidate';

export function NetworkMonitor() {
  const { toast } = useToast();
  const [isOffline, setIsOffline] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    // Initial state
    setIsOffline(!navigator.onLine);

    const handleOffline = () => {
      setIsOffline(true);
      console.log('[NetworkMonitor] 🔴 Conexión perdida. Activando Modo Supervivencia.');
      toast({
        variant: "destructive",
        title: "MODO SUPERVIVENCIA",
        description: "Sin conexión. Las ventas se guardarán en la bóveda local.",
      });
    };

    const handleOnline = async () => {
      setIsOffline(false);
      console.log('[NetworkMonitor] 🟢 Conexión recuperada. Iniciando volcado de bóveda...');
      toast({
        variant: "success",
        title: "SISTEMA EN LÍNEA",
        description: "Conexión restaurada. Sincronizando bóveda...",
      });
      await syncOfflineVault();
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    // Si al cargar la página estamos online, revisamos si quedó algo pendiente de una sesión anterior
    if (navigator.onLine) {
      syncOfflineVault();
    }

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  const syncOfflineVault = async () => {
    if (isSyncing) return;
    setIsSyncing(true);

    try {
      const { getSyncQueue, removeFromSyncQueue } = await import('@/lib/offline-db');
      const queue = await getSyncQueue();
      
      if (queue.length === 0) {
        setIsSyncing(false);
        return;
      }

      console.log(`[NetworkMonitor] 📦 Procesando ${queue.length} transacciones en bóveda.`);

      let successCount = 0;
      const token = Cookies.get('org-pos-token');

      for (const item of queue) {
        try {
          if (item.type === 'SALE') {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/sales/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify(item.payload)
            });

            if (res.ok) {
              await removeFromSyncQueue(item.id);
              successCount++;
            } else {
              console.error('[NetworkMonitor] Fallo al sincronizar venta:', item.id, await res.text());
            }
          }
        } catch (err) {
          console.error('[NetworkMonitor] Error de red al sincronizar:', err);
          // Si falla por red, abortamos el volcado, lo intentaremos en la próxima conexión
          break;
        }
      }

      if (successCount > 0) {
        toast({
          variant: "success",
          title: "BÓVEDA VACIADA",
          description: `${successCount} transacciones sincronizadas con el servidor.`,
        });
        
        // Forzar actualización global
        broadcastRevalidate('SALE_MADE');
        broadcastRevalidate('DASHBOARD_UPDATE');
      }

    } catch (error) {
      console.error('[NetworkMonitor] Error crítico en volcado de bóveda:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  return null; // Invisible global worker
}

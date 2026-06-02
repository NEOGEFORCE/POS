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
      console.log('[NetworkMonitor] ðŸ”´ Conexion perdida. Activando Modo Supervivencia.');
      toast({
        variant: "destructive",
        title: "MODO SUPERVIVENCIA",
        description: "Sin conexion. Las ventas se guardaran en la boveda local.",
      });
    };

    const handleOnline = async () => {
      setIsOffline(false);
      console.log('[NetworkMonitor] ðŸŸ¢ Conexion recuperada. Iniciando volcado de boveda...');
      toast({
        variant: "success",
        title: "SISTEMA EN LINEA",
        description: "Conexion restaurada. Sincronizando boveda...",
      });
      await syncOfflineVault();
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    // Si al cargar la pagina estamos online, revisamos si quedo algo pendiente de una sesion anterior
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

      console.log(`[NetworkMonitor] ðŸ“¦ Procesando ${queue.length} transacciones en boveda.`);

      let successCount = 0;
      const token = Cookies.get('org-pos-token');

      for (const item of queue) {
        try {
          if (item.type === 'SALE') {
            const res = await fetch(`${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/sales/register`, {
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
          // Si falla por red, abortamos el volcado, lo intentaremos en la proxima conexion
          break;
        }
      }

      if (successCount > 0) {
        toast({
          variant: "success",
          title: "BOVEDA VACIADA",
          description: `${successCount} transacciones sincronizadas con el servidor.`,
        });
        
        // Forzar actualizacion global
        broadcastRevalidate('SALE_MADE');
        broadcastRevalidate('DASHBOARD_UPDATE');
      }

    } catch (error) {
      console.error('[NetworkMonitor] Error critico en volcado de boveda:', error);
    } finally {
      setIsSyncing(false);
    }
  };

  return null; // Invisible global worker
}



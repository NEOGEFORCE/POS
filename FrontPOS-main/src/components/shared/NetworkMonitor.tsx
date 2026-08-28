'use client';

import { useEffect } from 'react';
import { useToast } from '@/hooks/use-toast';
import { broadcastRevalidate } from '@/lib/revalidate';
import { syncOfflineSalesQueue } from '@/lib/offline-sync';

export function NetworkMonitor() {
  const { toast } = useToast();

  useEffect(() => {
    // Initial state

    const handleOffline = () => {
      console.log('[NetworkMonitor] ðŸ”´ Conexion perdida. Activando Modo Supervivencia.');
      toast({
        variant: "destructive",
        title: "MODO SUPERVIVENCIA",
        description: "Sin conexion. Las ventas se guardaran en la boveda local.",
      });
    };

    const handleOnline = async () => {
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
    try {
      const result = await syncOfflineSalesQueue();
      if (result.succeeded > 0) {
        toast({
          variant: "success",
          title: "BOVEDA VACIADA",
          description: `${result.succeeded} transacciones sincronizadas con el servidor.`,
        });
        broadcastRevalidate('SALE_MADE');
        broadcastRevalidate('DASHBOARD_UPDATE');
      }
    } catch (error) {
      console.error('[NetworkMonitor] Error critico en volcado de boveda:', error);
    }
  };

  return null; // Invisible global worker
}



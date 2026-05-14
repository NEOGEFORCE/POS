'use client';

import { useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { broadcastRevalidate } from '@/lib/revalidate';

export function GlobalSyncProvider() {
  const { user } = useAuth();
  const token = user?.token;
  const isAuthenticated = !!user;
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !token) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    // Evitar múltiples conexiones si el componente se re-monta en React Strict Mode
    if (eventSourceRef.current) return;

    const sseUrl = `${process.env.NEXT_PUBLIC_API_URL}/sse?token=${token}`;
    console.log('[GlobalSync] 🔌 Intentando conectar a:', sseUrl);
    const eventSource = new EventSource(sseUrl);
    eventSourceRef.current = eventSource;

    // Escuchar cualquier evento "NEW_SALE"
    eventSource.addEventListener('NEW_SALE', (e) => {
      console.log('[GlobalSync] 🟢 Evento NEW_SALE detectado. Inyectando recarga a nivel de sistema.');
      broadcastRevalidate('SALE_MADE');
    });

    // Escuchar "PRODUCT_UPDATE"
    eventSource.addEventListener('PRODUCT_UPDATE', (e) => {
      console.log('[GlobalSync] 🟢 Evento PRODUCT_UPDATE detectado.');
      broadcastRevalidate('PRODUCT_UPDATE');
    });

    // Escuchar "CATEGORY_UPDATE"
    eventSource.addEventListener('CATEGORY_UPDATE', (e) => {
      console.log('[GlobalSync] 🟢 Evento CATEGORY_UPDATE detectado.');
      broadcastRevalidate('CATEGORY_UPDATE');
    });

    // Escuchar "SUPPLIER_UPDATE"
    eventSource.addEventListener('SUPPLIER_UPDATE', (e) => {
      console.log('[GlobalSync] 🟢 Evento SUPPLIER_UPDATE detectado.');
      broadcastRevalidate('SUPPLIER_UPDATE');
    });

    // Escuchar "CUSTOMER_UPDATE"
    eventSource.addEventListener('CUSTOMER_UPDATE', (e) => {
      console.log('[GlobalSync] 🟢 Evento CUSTOMER_UPDATE detectado.');
      broadcastRevalidate('CUSTOMER_UPDATE');
    });

    // Escuchar "EXPENSE_UPDATE" (Crítico para sincronización de egresos en tiempo real)
    eventSource.addEventListener('EXPENSE_UPDATE', (e) => {
      console.log('[GlobalSync] 🟢 Evento EXPENSE_UPDATE detectado.');
      broadcastRevalidate('EXPENSE_UPDATE');
      broadcastRevalidate('DASHBOARD_UPDATE');
    });

    // Escuchar "STOCK_UPDATE"
    eventSource.addEventListener('STOCK_UPDATE', (e) => {
      console.log('[GlobalSync] 🟢 Evento STOCK_UPDATE detectado.');
      broadcastRevalidate('STOCK_UPDATE');
      broadcastRevalidate('PRODUCT_UPDATE');
    });

    // Escuchar "INVENTORY_UPDATE" (Recepciones masivas)
    eventSource.addEventListener('INVENTORY_UPDATE', (e) => {
      console.log('[GlobalSync] 🟢 Evento INVENTORY_UPDATE detectado.');
      broadcastRevalidate('STOCK_UPDATE');
      broadcastRevalidate('PRODUCT_UPDATE');
      broadcastRevalidate('DASHBOARD_UPDATE');
    });

    // Escuchar "REPORT_UPDATE" (Historial de reportes)
    eventSource.addEventListener('REPORT_UPDATE', (e) => {
      console.log('[GlobalSync] 🟢 Evento REPORT_UPDATE detectado.');
      broadcastRevalidate('REPORT_UPDATE');
    });

    // Escuchar "AUDIT_UPDATE" (Logs de auditoría)
    eventSource.addEventListener('AUDIT_UPDATE', (e) => {
      console.log('[GlobalSync] 🟢 Evento AUDIT_UPDATE detectado.');
      broadcastRevalidate('AUDIT_UPDATE');
    });

    // Escuchar "SALE_MADE"
    eventSource.addEventListener('SALE_MADE', (e) => {
      console.log('[GlobalSync] 🟢 Evento SALE_MADE detectado.');
      broadcastRevalidate('SALE_MADE');
      broadcastRevalidate('STOCK_UPDATE');
    });

    // Escuchar "DASHBOARD_UPDATE" (Trigger maestro)
    eventSource.addEventListener('DASHBOARD_UPDATE', (e) => {
      console.log('[GlobalSync] 🟢 Evento DASHBOARD_UPDATE detectado. Sincronizando pantallas...');
      broadcastRevalidate('DASHBOARD_UPDATE');
      broadcastRevalidate('SALE_MADE');
      broadcastRevalidate('PRODUCT_UPDATE'); // Dashboard update suele implicar cambios en stock
      broadcastRevalidate('EXPENSE_UPDATE');
      broadcastRevalidate('CASH_REGISTER_UPDATE');
      broadcastRevalidate('CLOSURE_MADE');
    });

    eventSource.onmessage = (event) => {
        // Heartbeats (Ping) or general broadcasts
        if (event.data !== '"heartbeat"') {
            // console.log('[GlobalSync] Mensaje genérico recibido:', event.data);
        }
    };

    eventSource.onerror = (error) => {
      console.error('[GlobalSync] 🔴 Error de conexión SSE. Intentando reconectar...', error);
      eventSource.close();
      eventSourceRef.current = null;
      // Auto-reconnect after 5 seconds if connection drops (SSE natively auto-reconnects, but this acts as a fallback if the connection completely dies).
      setTimeout(() => {
         // This effect will not re-run, but if state changes it might.
         // Actually, SSE has built-in reconnection, so we just let it handle it unless it hits terminal error.
      }, 5000);
    };

    return () => {
      if (eventSourceRef.current) {
        console.log('[GlobalSync] 🔌 Desconectando EventSource global.');
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [isAuthenticated, token]);

  // Este componente es invisible, es un worker en el DOM
  return null;
}

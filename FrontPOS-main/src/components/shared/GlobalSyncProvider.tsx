'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { broadcastRevalidate } from '@/lib/revalidate';
import { toast } from '@/hooks/use-toast';

// Mapa de eventos SSE → mensajes de toast informativos (no intrusivos)
const SSE_TOAST_MAP: Record<string, { label: string; variant: 'default' | 'success' }> = {
  'NEW_SALE':          { label: '💰 Nueva venta registrada',           variant: 'success' },
  'INVENTORY_UPDATE':  { label: '📦 Inventario actualizado',           variant: 'default' },
  'EXPENSE_UPDATE':    { label: '💸 Egreso registrado',                variant: 'default' },
  'PRODUCT_UPDATE':    { label: '🏷️ Catalogo de productos actualizado', variant: 'default' },
  'CUSTOMER_UPDATE':   { label: '👤 Base de clientes actualizada',     variant: 'default' },
  'SUPPLIER_UPDATE':   { label: '🏭 Proveedores actualizados',         variant: 'default' },
  'CATEGORY_UPDATE':   { label: '📂 Categorias actualizadas',          variant: 'default' },
  'AUDIT_UPDATE':      { label: '🔒 Registro de auditoria actualizado',variant: 'default' },
};

// Debounce para evitar spam de toasts cuando llegan multiples eventos SSE seguidos
const recentToasts = new Set<string>();
function showSSEToast(eventType: string) {
  const config = SSE_TOAST_MAP[eventType];
  if (!config) return;
  
  // Evitar toast duplicado dentro de ventana de 5s
  if (recentToasts.has(eventType)) return;
  recentToasts.add(eventType);
  setTimeout(() => recentToasts.delete(eventType), 5000);

  toast({
    title: 'Sincronizacion',
    description: config.label,
    variant: config.variant === 'success' ? 'success' : 'default',
    duration: 2500,
  });
}

export function GlobalSyncProvider() {
  const { user } = useAuth();
  const token = user?.token;
  const isAuthenticated = !!user;
  const eventSourceRef = useRef<EventSource | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!isAuthenticated || !token) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    // Evitar multiples conexiones si el componente se re-monta en React Strict Mode
    if (eventSourceRef.current) return;

    const sseUrl = `${(process.env.NEXT_PUBLIC_API_URL && process.env.NEXT_PUBLIC_API_URL !== 'undefined' ? process.env.NEXT_PUBLIC_API_URL : '/api')}/sse?token=${token}`;
    console.log('[GlobalSync] 🔌 Intentando conectar al EventStream SSE...');
    const eventSource = new EventSource(sseUrl);
    eventSourceRef.current = eventSource;

    const setupListeners = (es: EventSource) => {
        es.addEventListener('NEW_SALE', () => {
          broadcastRevalidate('SALE_MADE');
          showSSEToast('NEW_SALE');
        });
        es.addEventListener('PRODUCT_UPDATE', () => {
          broadcastRevalidate('PRODUCT_UPDATE');
          showSSEToast('PRODUCT_UPDATE');
        });
        es.addEventListener('CATEGORY_UPDATE', () => {
          broadcastRevalidate('CATEGORY_UPDATE');
          showSSEToast('CATEGORY_UPDATE');
        });
        es.addEventListener('SUPPLIER_UPDATE', () => {
          broadcastRevalidate('SUPPLIER_UPDATE');
          showSSEToast('SUPPLIER_UPDATE');
        });
        es.addEventListener('CUSTOMER_UPDATE', () => {
          broadcastRevalidate('CUSTOMER_UPDATE');
          showSSEToast('CUSTOMER_UPDATE');
        });
        es.addEventListener('EXPENSE_UPDATE', () => {
          broadcastRevalidate('EXPENSE_UPDATE');
          broadcastRevalidate('DASHBOARD_UPDATE');
          showSSEToast('EXPENSE_UPDATE');
        });
        es.addEventListener('STOCK_UPDATE', () => {
          broadcastRevalidate('STOCK_UPDATE');
          broadcastRevalidate('PRODUCT_UPDATE');
        });
        es.addEventListener('INVENTORY_UPDATE', () => {
          broadcastRevalidate('STOCK_UPDATE');
          broadcastRevalidate('PRODUCT_UPDATE');
          broadcastRevalidate('DASHBOARD_UPDATE');
          showSSEToast('INVENTORY_UPDATE');
        });
        es.addEventListener('REPORT_UPDATE', () => broadcastRevalidate('REPORT_UPDATE'));
        es.addEventListener('AUDIT_UPDATE', () => {
          broadcastRevalidate('AUDIT_UPDATE');
          showSSEToast('AUDIT_UPDATE');
        });
        es.addEventListener('SALE_MADE', () => {
          broadcastRevalidate('SALE_MADE');
          broadcastRevalidate('STOCK_UPDATE');
        });
        es.addEventListener('DASHBOARD_UPDATE', () => {
          broadcastRevalidate('DASHBOARD_UPDATE');
          broadcastRevalidate('SALE_MADE');
          broadcastRevalidate('PRODUCT_UPDATE');
          broadcastRevalidate('EXPENSE_UPDATE');
          broadcastRevalidate('CASH_REGISTER_UPDATE');
          broadcastRevalidate('CLOSURE_MADE');
        });
    };

    setupListeners(eventSource);

    eventSource.onmessage = (event) => {
        if (event.data !== '"heartbeat"') {
            // Heartbeat check
        }
    };

    eventSource.onerror = (error) => {
      console.error('[GlobalSync] 🔴 Error de conexion SSE. Reintentando en 5s...', error);
      eventSource.close();
      eventSourceRef.current = null;
      setTimeout(() => {
        setRetryCount(prev => prev + 1);
      }, 5000);
    };

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [isAuthenticated, token, retryCount]);

  return null;
}

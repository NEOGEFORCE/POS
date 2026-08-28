'use client';

import { useEffect } from 'react';

import { toast } from '@/hooks/use-toast';
import { API_URL } from '@/lib/constants';
import { useAuth } from '@/lib/auth';
import { computeSSERetryDelay, parseSSEBlock } from '@/lib/resilience-policy.mjs';
import { broadcastRevalidate } from '@/lib/revalidate';
import { requestSessionRecovery } from '@/lib/session-recovery';

const SSE_TOAST_MAP: Record<string, { label: string; variant: 'default' | 'success' }> = {
  NEW_SALE: { label: '💰 Nueva venta registrada', variant: 'success' },
  INVENTORY_UPDATE: { label: '📦 Inventario actualizado', variant: 'default' },
  EXPENSE_UPDATE: { label: '💸 Egreso registrado', variant: 'default' },
  PRODUCT_UPDATE: { label: '🏷️ Catalogo de productos actualizado', variant: 'default' },
  CUSTOMER_UPDATE: { label: '👤 Base de clientes actualizada', variant: 'default' },
  SUPPLIER_UPDATE: { label: '🏭 Proveedores actualizados', variant: 'default' },
  CATEGORY_UPDATE: { label: '📂 Categorias actualizadas', variant: 'default' },
  AUDIT_UPDATE: { label: '🔒 Registro de auditoria actualizado', variant: 'default' },
};

const recentToasts = new Set<string>();
function showSSEToast(eventType: string) {
  const config = SSE_TOAST_MAP[eventType];
  if (!config || recentToasts.has(eventType)) return;
  recentToasts.add(eventType);
  window.setTimeout(() => recentToasts.delete(eventType), 5000);
  toast({
    title: 'Sincronizacion',
    description: config.label,
    variant: config.variant === 'success' ? 'success' : 'default',
    duration: 2500,
  });
}

function handleSSEEvent(eventType: string) {
  switch (eventType) {
    case 'NEW_SALE':
      broadcastRevalidate('SALE_MADE');
      break;
    case 'PRODUCT_UPDATE':
    case 'CATEGORY_UPDATE':
    case 'SUPPLIER_UPDATE':
    case 'CUSTOMER_UPDATE':
      broadcastRevalidate(eventType);
      break;
    case 'EXPENSE_UPDATE':
      broadcastRevalidate('EXPENSE_UPDATE');
      broadcastRevalidate('DASHBOARD_UPDATE');
      break;
    case 'STOCK_UPDATE':
      broadcastRevalidate('STOCK_UPDATE');
      broadcastRevalidate('PRODUCT_UPDATE');
      break;
    case 'INVENTORY_UPDATE':
      broadcastRevalidate('STOCK_UPDATE');
      broadcastRevalidate('PRODUCT_UPDATE');
      broadcastRevalidate('DASHBOARD_UPDATE');
      break;
    case 'REPORT_UPDATE':
      broadcastRevalidate('REPORT_UPDATE');
      break;
    case 'AUDIT_UPDATE':
      broadcastRevalidate('AUDIT_UPDATE');
      break;
    case 'SALE_MADE':
      broadcastRevalidate('SALE_MADE');
      broadcastRevalidate('STOCK_UPDATE');
      break;
    case 'DASHBOARD_UPDATE':
      broadcastRevalidate('DASHBOARD_UPDATE');
      broadcastRevalidate('SALE_MADE');
      broadcastRevalidate('PRODUCT_UPDATE');
      broadcastRevalidate('EXPENSE_UPDATE');
      broadcastRevalidate('CASH_REGISTER_UPDATE');
      broadcastRevalidate('CLOSURE_MADE');
      break;
    default:
      return;
  }
  showSSEToast(eventType);
}

export function GlobalSyncProvider() {
  const { user } = useAuth();
  const token = user?.token;

  useEffect(() => {
    if (!user || !token) return;

    let cancelled = false;
    let retryAttempt = 0;
    let retryTimer: number | null = null;
    let controller: AbortController | null = null;

    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = computeSSERetryDelay(retryAttempt++);
      retryTimer = window.setTimeout(() => void connect(), delay);
    };

    const consumeStream = async (response: Response) => {
      if (!response.body) throw new Error('El navegador no entregó el stream SSE');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!cancelled) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = parseSSEBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (frame && !(frame.event === 'message' && frame.data === '"heartbeat"')) {
            handleSSEEvent(frame.event);
          }
          boundary = buffer.indexOf('\n\n');
        }
        if (done) break;
      }
    };

    const connect = async () => {
      controller = new AbortController();
      try {
        const response = await fetch(`${API_URL}/sse`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status === 401) {
          await requestSessionRecovery();
          return;
        }
        if (!response.ok) throw new Error(`SSE HTTP ${response.status}`);

        retryAttempt = 0;
        await consumeStream(response);
        if (!cancelled) throw new Error('El stream SSE se cerró');
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        console.warn('[GlobalSync] SSE desconectado; se programó reconexión.', error);
        scheduleReconnect();
      }
    };

    void connect();
    return () => {
      cancelled = true;
      controller?.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [token, user]);

  return null;
}

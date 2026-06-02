import { mutate } from 'swr';

const CHANNEL_NAME = 'pos-sync-channel';

type SyncEvent = 
  | 'SALE_MADE' 
  | 'PRODUCT_UPDATE' 
  | 'EXPENSE_UPDATE' 
  | 'CATEGORY_UPDATE' 
  | 'SUPPLIER_UPDATE' 
  | 'CUSTOMER_UPDATE' 
  | 'CASH_REGISTER_UPDATE'
  | 'DASHBOARD_UPDATE'
  | 'STOCK_UPDATE'
  | 'INVENTORY_UPDATE'
  | 'REPORT_UPDATE'
  | 'AUDIT_UPDATE'
  | 'CLOSURE_MADE';

let channel: BroadcastChannel | null = null;

if (typeof window !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL_NAME);
}

/**
 * Broadcasts a revalidation event to all tabs and revalidates local SWR keys.
 */
let revalidateTimer: ReturnType<typeof setTimeout> | null = null;
const pendingEvents = new Set<SyncEvent>();

export function broadcastRevalidate(event: SyncEvent) {
  // 1. Notificar a otras pestanas INMEDIATAMENTE
  if (channel) {
    channel.postMessage(event);
  }

  // 2. Acumular y revalidar con DEBOUNCE para evitar lag
  pendingEvents.add(event);
  
  if (revalidateTimer) clearTimeout(revalidateTimer);
  
  revalidateTimer = setTimeout(() => {
    pendingEvents.forEach(e => revalidateKeysForEvent(e));
    pendingEvents.clear();
    revalidateTimer = null;
  }, 1500); // 1.5s de ventana para agrupar cambios
}

/**
 * Hook to listen for sync events in a component.
 */
export function setupSyncListener(onEvent: (event: SyncEvent) => void) {
  if (!channel) return () => {};

  const handler = (e: MessageEvent) => {
    // Solo procesar si el tab esta visible o es una prioridad alta
    if (document.visibilityState === 'hidden' && !['SALE_MADE', 'STOCK_UPDATE', 'INVENTORY_UPDATE'].includes(e.data)) {
        return;
    }
    onEvent(e.data as SyncEvent);
  };

  channel.addEventListener('message', handler);
  return () => channel?.removeEventListener('message', handler);
}

/**
 * Maps events to SWR keys that should be revalidated.
 */
export function revalidateKeysForEvent(event: SyncEvent) {
  let keysToMutate: string[] = [];

  switch (event) {
    case 'SALE_MADE':
      keysToMutate = [
        '/dashboard/stats',
        '/dashboard/overview',
        '/dashboard/cashier-closure',
        '/inventory/stock',
        '/products/all-products',
        '/sales/history',
        '/reports/daily',
        '/dashboard/kpis'
      ];
      break;
    case 'PRODUCT_UPDATE':
      keysToMutate = [
        '/products/all-products',
        '/inventory/stock',
        '/dashboard/stats',
        '/dashboard/overview',
        '/products/paginated'
      ];
      break;
    case 'INVENTORY_UPDATE':
      keysToMutate = [
        '/inventory/stock',
        '/products/all-products',
        '/dashboard/stats',
        '/dashboard/overview',
        '/inventory/suggested-orders',
        '/inventory/orders'
      ];
      break;
    case 'REPORT_UPDATE':
      keysToMutate = [
        '/reports/history',
        '/reports/stats'
      ];
      break;
    case 'AUDIT_UPDATE':
      keysToMutate = [
        '/admin/audit-logs'
      ];
      break;
    case 'EXPENSE_UPDATE':
      keysToMutate = [
        '/dashboard/overview',
        '/dashboard/cashier-closure',
        '/expenses/history',
        '/dashboard/stats',
        '/expenses/all',
        '/expenses/list'
      ];
      break;
    case 'CLOSURE_MADE':
      keysToMutate = [
        '/dashboard/overview',
        '/dashboard/cashier-closure',
        '/cash-register/history',
        '/reports/closures'
      ];
      break;
    case 'CATEGORY_UPDATE':
      keysToMutate.push('/categories/all-categories', '/products/all-products');
      break;
    case 'SUPPLIER_UPDATE':
      keysToMutate.push('/suppliers/all-suppliers', '/products/all-products');
      break;
    case 'CUSTOMER_UPDATE':
      keysToMutate.push('/clients/all-clients');
      break;
    case 'CASH_REGISTER_UPDATE':
      keysToMutate.push('/cash-register/status', '/dashboard/stats');
      break;
    case 'DASHBOARD_UPDATE':
      keysToMutate.push('/dashboard/stats');
      break;
    case 'STOCK_UPDATE':
      keysToMutate = [
        '/inventory/stock',
        '/products/all-products',
        '/dashboard/stats',
        '/products/paginated'
      ];
      break;
  }

  // Ejecutar mutaciones
  keysToMutate.forEach(key => {
    mutate(key);
  });

  // Revalidacion por patron para rutas con parametros variables (como productos paginados)
  if (event === 'PRODUCT_UPDATE' || event === 'SALE_MADE' || event === 'CATEGORY_UPDATE' || event === 'SUPPLIER_UPDATE' || event === 'INVENTORY_UPDATE') {
    mutate((key: any) => {
      if (typeof key !== 'string') return false;
      return (
        key.includes('/products/paginated') || 
        key.includes('/products/all-products') ||
        key.includes('/sales/history') ||
        key.includes('/dashboard/stats') ||
        key.includes('/dashboard/cashier-closure') ||
        key.includes('/inventory/stock')
      );
    });
  }
}

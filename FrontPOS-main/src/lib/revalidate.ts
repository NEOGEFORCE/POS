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
  | 'DASHBOARD_UPDATE';

let channel: BroadcastChannel | null = null;

if (typeof window !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL_NAME);
}

/**
 * Broadcasts a revalidation event to all tabs and revalidates local SWR keys.
 */
export function broadcastRevalidate(event: SyncEvent) {
  // 1. Revalidar localmente
  revalidateKeysForEvent(event);

  // 2. Notificar a otras pestañas
  if (channel) {
    channel.postMessage(event);
  }
}

/**
 * Hook to listen for sync events in a component (like SyncBackground).
 */
export function setupSyncListener(onEvent: (event: SyncEvent) => void) {
  if (!channel) return () => {};

  const handler = (e: MessageEvent) => {
    onEvent(e.data as SyncEvent);
  };

  channel.addEventListener('message', handler);
  return () => channel?.removeEventListener('message', handler);
}

/**
 * Maps events to SWR keys that should be revalidated.
 */
export function revalidateKeysForEvent(event: SyncEvent) {
  const keysToMutate: string[] = [];

  switch (event) {
    case 'SALE_MADE':
      keysToMutate.push('/sales/all', '/dashboard/stats', '/products/all-products');
      break;
    case 'PRODUCT_UPDATE':
      keysToMutate.push('/products/all-products', '/dashboard/stats');
      break;
    case 'EXPENSE_UPDATE':
      keysToMutate.push('/expenses/all', '/dashboard/stats');
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
  }

  // Ejecutar mutaciones
  keysToMutate.forEach(key => {
    mutate(key);
    mutate(`/api${key}`);
  });

  // Revalidación por patrón para rutas con parámetros variables (como productos paginados)
  if (event === 'PRODUCT_UPDATE' || event === 'SALE_MADE' || event === 'CATEGORY_UPDATE' || event === 'SUPPLIER_UPDATE') {
    mutate((key: any) => typeof key === 'string' && (key.includes('/products/paginated') || key.includes('/products/all-products')));
  }
}

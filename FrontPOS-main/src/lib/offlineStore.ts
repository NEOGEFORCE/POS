import { openDB, DBSchema, IDBPDatabase } from 'idb';

interface POSDB extends DBSchema {
  catalog_cache: {
    key: string;
    value: { id: string; data: any };
  };
  pending_sales: {
    key: string;
    value: { id: string; payload: any; timestamp: number };
  };
}

let dbPromise: Promise<IDBPDatabase<POSDB>> | null = null;

if (typeof window !== 'undefined') {
  dbPromise = openDB<POSDB>('pos-pro-offline', 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('catalog_cache')) {
        db.createObjectStore('catalog_cache', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pending_sales')) {
        db.createObjectStore('pending_sales', { keyPath: 'id' });
      }
    },
  });
}

/**
 * CATALOG CACHE
 */

export async function saveCatalogToCache(catalogData: any) {
  if (!dbPromise) return;
  const db = await dbPromise;
  await db.put('catalog_cache', { id: 'main_catalog', data: catalogData });
}

export async function getCatalogFromCache() {
  if (!dbPromise) return null;
  const db = await dbPromise;
  const entry = await db.get('catalog_cache', 'main_catalog');
  return entry?.data || null;
}

/**
 * PENDING SALES
 */

export async function savePendingSale(payload: any) {
  if (!dbPromise) return;
  const db = await dbPromise;
  const id = `sale_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  await db.put('pending_sales', { id, payload, timestamp: Date.now() });
  return id;
}

export async function getPendingSales() {
  if (!dbPromise) return [];
  const db = await dbPromise;
  return await db.getAll('pending_sales');
}

export async function removePendingSale(id: string) {
  if (!dbPromise) return;
  const db = await dbPromise;
  await db.delete('pending_sales', id);
}

export async function clearPendingSales() {
  if (!dbPromise) return;
  const db = await dbPromise;
  await db.clear('pending_sales');
}

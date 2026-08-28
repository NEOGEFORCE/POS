import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { Product } from '@/lib/definitions';

export interface SyncQueueItem {
  id: string;
  type: 'SALE' | 'EXPENSE';
  payload: any;
  timestamp: number;
  attempts?: number;
  nextAttemptAt?: number;
  lastError?: string;
}

export interface DeadLetterItem extends SyncQueueItem {
  movedAt: number;
  failureStatus?: number;
  failureReason: string;
}

interface POSSurvivalDB extends DBSchema {
  catalog: {
    key: string;
    value: Product;
    indexes: { 'by-name': string };
  };
  sync_queue: {
    key: string;
    value: SyncQueueItem;
    indexes: { 'by-timestamp': number };
  };
  dead_letter: {
    key: string;
    value: DeadLetterItem;
    indexes: { 'by-moved-at': number };
  };
}

let dbPromise: Promise<IDBPDatabase<POSSurvivalDB>> | null = null;

export const initDB = () => {
  if (typeof window === 'undefined') return null;
  if (!dbPromise) {
    dbPromise = openDB<POSSurvivalDB>('pos-survival-db', 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('catalog')) {
          const catalogStore = db.createObjectStore('catalog', { keyPath: 'barcode' });
          catalogStore.createIndex('by-name', 'name');
        }
        if (!db.objectStoreNames.contains('sync_queue')) {
          const queueStore = db.createObjectStore('sync_queue', { keyPath: 'id' });
          queueStore.createIndex('by-timestamp', 'timestamp');
        }
        if (!db.objectStoreNames.contains('dead_letter')) {
          const deadStore = db.createObjectStore('dead_letter', { keyPath: 'id' });
          deadStore.createIndex('by-moved-at', 'movedAt');
        }
      },
    });
  }
  return dbPromise;
};

export const saveProductsToCache = async (products: Product[]) => {
  const db = await initDB();
  if (!db) return;
  const tx = db.transaction('catalog', 'readwrite');
  await tx.objectStore('catalog').clear();
  for (const product of products) await tx.store.put(product);
  await tx.done;
  console.log('[SurvivalDB] Catalogo cacheado:', products.length, 'productos.');
};

export const getCachedProducts = async (): Promise<Product[]> => {
  const db = await initDB();
  return db ? db.getAll('catalog') : [];
};

export const getCachedProductByBarcode = async (barcode: string): Promise<Product | undefined> => {
  const db = await initDB();
  return db ? db.get('catalog', barcode) : undefined;
};

export const addToSyncQueue = async (type: SyncQueueItem['type'], payload: any) => {
  const db = await initDB();
  if (!db) return;
  const localId = `offline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await db.add('sync_queue', {
    id: localId,
    type,
    payload,
    timestamp: Date.now(),
    attempts: 0,
    nextAttemptAt: 0,
  });
  console.log(`[SurvivalDB] Añadido a sincronizacion [${type}]:`, localId);
  return localId;
};

export const getSyncQueue = async (): Promise<SyncQueueItem[]> => {
  const db = await initDB();
  return db ? db.getAllFromIndex('sync_queue', 'by-timestamp') : [];
};

export const updateSyncQueueItem = async (item: SyncQueueItem) => {
  const db = await initDB();
  if (db) await db.put('sync_queue', item);
};

export const removeFromSyncQueue = async (id: string) => {
  const db = await initDB();
  if (db) await db.delete('sync_queue', id);
};

export const moveToDeadLetter = async (
  item: SyncQueueItem,
  failureReason: string,
  failureStatus?: number,
) => {
  const db = await initDB();
  if (!db) return;
  const tx = db.transaction(['sync_queue', 'dead_letter'], 'readwrite');
  await tx.objectStore('dead_letter').put({
    ...item,
    movedAt: Date.now(),
    failureReason,
    failureStatus,
  });
  await tx.objectStore('sync_queue').delete(item.id);
  await tx.done;
};

export const getDeadLetters = async (): Promise<DeadLetterItem[]> => {
  const db = await initDB();
  return db ? db.getAllFromIndex('dead_letter', 'by-moved-at') : [];
};

export const restoreDeadLetter = async (id: string) => {
  const db = await initDB();
  if (!db) return false;
  const item = await db.get('dead_letter', id);
  if (!item) return false;
  const { movedAt: _movedAt, failureReason: _reason, failureStatus: _status, ...queueItem } = item;
  const tx = db.transaction(['sync_queue', 'dead_letter'], 'readwrite');
  await tx.objectStore('sync_queue').put({
    ...queueItem,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: undefined,
  });
  await tx.objectStore('dead_letter').delete(id);
  await tx.done;
  return true;
};

export const clearDeadLetters = async () => {
  const db = await initDB();
  if (db) await db.clear('dead_letter');
};

export const clearSyncQueue = async () => {
  const db = await initDB();
  if (db) await db.clear('sync_queue');
};

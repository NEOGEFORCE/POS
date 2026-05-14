import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { Product } from '@/lib/definitions';

interface POSSurvivalDB extends DBSchema {
  catalog: {
    key: string;
    value: Product;
    indexes: { 'by-name': string };
  };
  sync_queue: {
    key: string; // uuid local
    value: {
      id: string;
      type: 'SALE' | 'EXPENSE';
      payload: any;
      timestamp: number;
    };
    indexes: { 'by-timestamp': number };
  };
}

let dbPromise: Promise<IDBPDatabase<POSSurvivalDB>> | null = null;

export const initDB = () => {
  if (typeof window === 'undefined') return null;

  if (!dbPromise) {
    dbPromise = openDB<POSSurvivalDB>('pos-survival-db', 1, {
      upgrade(db) {
        // Almacén de catálogo (para buscar productos offline)
        if (!db.objectStoreNames.contains('catalog')) {
          const catalogStore = db.createObjectStore('catalog', { keyPath: 'barcode' });
          catalogStore.createIndex('by-name', 'name');
        }

        // Almacén de ventas/gastos pendientes de enviar al servidor
        if (!db.objectStoreNames.contains('sync_queue')) {
          const queueStore = db.createObjectStore('sync_queue', { keyPath: 'id' });
          queueStore.createIndex('by-timestamp', 'timestamp');
        }
      },
    });
  }
  return dbPromise;
};

// --- CATALOG MANAGEMENT --- //

export const saveProductsToCache = async (products: Product[]) => {
  const db = await initDB();
  if (!db) return;

  const tx = db.transaction('catalog', 'readwrite');
  // Vaciamos la caché anterior para evitar basura
  await tx.objectStore('catalog').clear();
  
  // Guardamos el catálogo fresco
  for (const product of products) {
    await tx.store.put(product);
  }
  await tx.done;
  console.log('[SurvivalDB] 📦 Catálogo cacheado exitosamente:', products.length, 'productos.');
};

export const getCachedProducts = async (): Promise<Product[]> => {
  const db = await initDB();
  if (!db) return [];
  return await db.getAll('catalog');
};

export const getCachedProductByBarcode = async (barcode: string): Promise<Product | undefined> => {
    const db = await initDB();
    if (!db) return undefined;
    return await db.get('catalog', barcode);
};

// --- SYNC QUEUE MANAGEMENT --- //

export const addToSyncQueue = async (type: 'SALE' | 'EXPENSE', payload: any) => {
  const db = await initDB();
  if (!db) return;

  // Generamos un ID temporal único localmente basado en el tiempo y un sufijo aleatorio
  const localId = `offline-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
  
  await db.add('sync_queue', {
    id: localId,
    type,
    payload,
    timestamp: Date.now()
  });

  console.log(`[SurvivalDB] 📥 Añadido a la bóveda de sincronización [${type}]:`, localId);
  return localId;
};

export const getSyncQueue = async () => {
  const db = await initDB();
  if (!db) return [];
  return await db.getAllFromIndex('sync_queue', 'by-timestamp');
};

export const removeFromSyncQueue = async (id: string) => {
  const db = await initDB();
  if (!db) return;
  await db.delete('sync_queue', id);
  console.log(`[SurvivalDB] 📤 Eliminado de la bóveda de sincronización:`, id);
};

export const clearSyncQueue = async () => {
  const db = await initDB();
  if (!db) return;
  await db.clear('sync_queue');
};

import { Product, Customer, Category } from './definitions';

const DB_NAME = 'pos-ultra-db';
const DB_VERSION = 2; // Incrementado para incluir master_data y offline_queue
const STORES = {
    CARTS: 'carts',
    MASTER_DATA: 'master_data',
    OFFLINE_QUEUE: 'offline_queue'
};

export interface OfflineSale {
    id: string;
    saleData: any;
    timestamp: number;
    synced: boolean;
    retryCount: number;
}

export function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            
            // Carritos activos
            if (!db.objectStoreNames.contains(STORES.CARTS)) {
                db.createObjectStore(STORES.CARTS, { keyPath: 'id' });
            }
            
            // Datos maestros (Productos, Clientes, Categorías)
            if (!db.objectStoreNames.contains(STORES.MASTER_DATA)) {
                db.createObjectStore(STORES.MASTER_DATA, { keyPath: 'type' });
            }
            
            // Cola de ventas offline
            if (!db.objectStoreNames.contains(STORES.OFFLINE_QUEUE)) {
                db.createObjectStore(STORES.OFFLINE_QUEUE, { keyPath: 'id' });
            }
        };
    });
}

// --- MASTER DATA MANAGEMENT ---
export async function cacheMasterData(products: Product[], customers: Customer[], categories: Category[]): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORES.MASTER_DATA, 'readwrite');
    const store = tx.objectStore(STORES.MASTER_DATA);
    
    store.put({ type: 'products', data: products, updatedAt: Date.now() });
    store.put({ type: 'customers', data: customers, updatedAt: Date.now() });
    store.put({ type: 'categories', data: categories, updatedAt: Date.now() });
    
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function getCachedMasterData(): Promise<{ products: Product[], customers: Customer[], categories: Category[] } | null> {
    const db = await openDB();
    const tx = db.transaction(STORES.MASTER_DATA, 'readonly');
    const store = tx.objectStore(STORES.MASTER_DATA);
    
    const pReq = store.get('products');
    const cReq = store.get('customers');
    const catReq = store.get('categories');
    
    return new Promise((resolve) => {
        let results = { products: [], customers: [], categories: [] };
        let count = 0;
        const check = () => {
            count++;
            if (count === 3) resolve(results.products.length ? results : null);
        };
        
        pReq.onsuccess = () => { results.products = pReq.result?.data || []; check(); };
        cReq.onsuccess = () => { results.customers = cReq.result?.data || []; check(); };
        catReq.onsuccess = () => { results.categories = catReq.result?.data || []; check(); };
        
        pReq.onerror = cReq.onerror = catReq.onerror = () => check();
    });
}

// --- OFFLINE QUEUE MANAGEMENT ---
export async function queueOfflineSale(saleData: any): Promise<string> {
    const db = await openDB();
    const tx = db.transaction(STORES.OFFLINE_QUEUE, 'readwrite');
    const store = tx.objectStore(STORES.OFFLINE_QUEUE);
    
    const id = `off_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const offlineSale: OfflineSale = {
        id,
        saleData,
        timestamp: Date.now(),
        synced: false,
        retryCount: 0
    };
    
    store.add(offlineSale);
    
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(id);
        tx.onerror = () => reject(tx.error);
    });
}

export async function getOfflineQueue(): Promise<OfflineSale[]> {
    const db = await openDB();
    const tx = db.transaction(STORES.OFFLINE_QUEUE, 'readonly');
    const store = tx.objectStore(STORES.OFFLINE_QUEUE);
    const request = store.getAll();
    
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

export async function removeFromOfflineQueue(id: string): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORES.OFFLINE_QUEUE, 'readwrite');
    const store = tx.objectStore(STORES.OFFLINE_QUEUE);
    store.delete(id);
    
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

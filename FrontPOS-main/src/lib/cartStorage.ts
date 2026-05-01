const DB_NAME = 'pos-cart-db';
const DB_VERSION = 1;
const STORE_NAME = 'carts';

interface CartDB {
    carts: Record<string, any[]>;
    activeKey: string;
    customerDni: string;
    selectedItemId: string | null;
    updatedAt: number;
}

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
    });
}

export async function saveCartsToIndexedDB(carts: Record<string, any[]>, activeKey: string, customerDni: string, selectedItemId: string | null): Promise<void> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        
        const data: CartDB = {
            carts,
            activeKey,
            customerDni,
            selectedItemId,
            updatedAt: Date.now(),
        };
        
        store.put({ id: 'active', ...data });
        
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn('IndexedDB save failed, falling back to localStorage:', err);
        localStorage.setItem('pos-active-carts', JSON.stringify(carts));
        localStorage.setItem('pos-active-cart-key', activeKey);
        localStorage.setItem('pos-active-customer', customerDni);
        localStorage.setItem('pos-active-selected-id', selectedItemId || '');
    }
}

export async function loadCartsFromIndexedDB(): Promise<{ carts: Record<string, any[]>; activeKey: string; customerDni: string; selectedItemId: string | null } | null> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get('active');
        
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                const result = request.result;
                if (result) {
                    resolve({
                        carts: result.carts,
                        activeKey: result.activeKey,
                        customerDni: result.customerDni,
                        selectedItemId: result.selectedItemId || null,
                    });
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => reject(request.error);
        });
    } catch (err) {
        console.warn('IndexedDB load failed, trying localStorage fallback');
        const savedCartsRaw = localStorage.getItem('pos-active-carts');
        const savedActive = localStorage.getItem('pos-active-cart-key');
        const savedCustomer = localStorage.getItem('pos-active-customer');
        const savedSelectedId = localStorage.getItem('pos-active-selected-id');
        
        if (savedCartsRaw) {
            return {
                carts: JSON.parse(savedCartsRaw),
                activeKey: savedActive || 'Factura 1',
                customerDni: savedCustomer || '0',
                selectedItemId: savedSelectedId || null,
            };
        }
        return null;
    }
}

export async function clearCartsFromIndexedDB(): Promise<void> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete('active');
        
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn('IndexedDB clear failed:', err);
        localStorage.removeItem('pos-active-carts');
        localStorage.removeItem('pos-active-cart-key');
        localStorage.removeItem('pos-active-customer');
    }
}

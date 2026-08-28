import { cartRecordKey, cartStorageKey, normalizeUserDni } from '@/lib/resilience-policy.mjs';

const DB_NAME = 'pos-cart-db';
const DB_VERSION = 1;
const STORE_NAME = 'carts';
const LEGACY_RECORD_KEY = 'active';

const LOCAL_KEYS = {
  carts: 'pos-active-carts',
  active: 'pos-active-cart-key',
  customer: 'pos-active-customer',
  customers: 'pos-active-cart-customers',
  selected: 'pos-active-selected-id',
} as const;

interface CartDB {
  carts: Record<string, any[]>;
  activeKey: string;
  customerDni: string;
  cartCustomers: Record<string, string>;
  selectedItemId: string | null;
  updatedAt: number;
}

type StoredCartDB = CartDB & { id: string };

function openCartDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function localKey(base: string, userDni: string) {
  return cartStorageKey(base, userDni);
}

function migrateLegacyLocalStorage(userDni: string) {
  if (localStorage.getItem(localKey(LOCAL_KEYS.carts, userDni))) return;
  if (!localStorage.getItem(LOCAL_KEYS.carts)) return;
  for (const base of Object.values(LOCAL_KEYS)) {
    const value = localStorage.getItem(base);
    if (value !== null) {
      localStorage.setItem(localKey(base, userDni), value);
      localStorage.removeItem(base);
    }
  }
}

function saveLocal(data: CartDB, userDni: string) {
  localStorage.setItem(localKey(LOCAL_KEYS.carts, userDni), JSON.stringify(data.carts));
  localStorage.setItem(localKey(LOCAL_KEYS.active, userDni), data.activeKey);
  localStorage.setItem(localKey(LOCAL_KEYS.customer, userDni), data.customerDni);
  localStorage.setItem(localKey(LOCAL_KEYS.customers, userDni), JSON.stringify(data.cartCustomers));
  localStorage.setItem(localKey(LOCAL_KEYS.selected, userDni), data.selectedItemId || '');
}

function loadLocal(userDni: string): CartDB | null {
  migrateLegacyLocalStorage(userDni);
  const rawCarts = localStorage.getItem(localKey(LOCAL_KEYS.carts, userDni));
  if (!rawCarts) return null;
  const rawCustomers = localStorage.getItem(localKey(LOCAL_KEYS.customers, userDni));
  return {
    carts: JSON.parse(rawCarts),
    activeKey: localStorage.getItem(localKey(LOCAL_KEYS.active, userDni)) || 'Factura 1',
    customerDni: localStorage.getItem(localKey(LOCAL_KEYS.customer, userDni)) || '0',
    cartCustomers: rawCustomers ? JSON.parse(rawCustomers) : {},
    selectedItemId: localStorage.getItem(localKey(LOCAL_KEYS.selected, userDni)) || null,
    updatedAt: Date.now(),
  };
}

export async function saveCartsToIndexedDB(
  carts: Record<string, any[]>,
  activeKey: string,
  customerDni: string,
  cartCustomers: Record<string, string>,
  selectedItemId: string | null,
  userDni: string,
): Promise<void> {
  const normalizedDni = normalizeUserDni(userDni);
  const data: CartDB = { carts, activeKey, customerDni, cartCustomers, selectedItemId, updatedAt: Date.now() };
  try {
    const db = await openCartDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ id: cartRecordKey(normalizedDni), ...data });
    await transactionDone(tx);
  } catch (error) {
    console.warn('IndexedDB save failed, using isolated localStorage:', error);
    saveLocal(data, normalizedDni);
  }
}

export async function loadCartsFromIndexedDB(userDni: string): Promise<CartDB | null> {
  const normalizedDni = normalizeUserDni(userDni);
  try {
    const db = await openCartDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const key = cartRecordKey(normalizedDni);
    let result = await requestResult(store.get(key)) as StoredCartDB | undefined;

    if (!result) {
      const legacy = await requestResult(store.get(LEGACY_RECORD_KEY)) as StoredCartDB | undefined;
      if (legacy) {
        result = { ...legacy, id: key, updatedAt: Date.now() };
        store.put(result);
        store.delete(LEGACY_RECORD_KEY);
      }
    }
    await transactionDone(tx);
    if (result) {
      const { id: _id, ...data } = result;
      return data;
    }
    return loadLocal(normalizedDni);
  } catch (error) {
    console.warn('IndexedDB load failed, using isolated localStorage:', error);
    return loadLocal(normalizedDni);
  }
}

export async function clearCartsFromIndexedDB(userDni: string): Promise<void> {
  const normalizedDni = normalizeUserDni(userDni);
  try {
    const db = await openCartDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(cartRecordKey(normalizedDni));
    await transactionDone(tx);
  } catch (error) {
    console.warn('IndexedDB clear failed:', error);
  }
  for (const base of Object.values(LOCAL_KEYS)) {
    localStorage.removeItem(localKey(base, normalizedDni));
  }
}

// Cola persistente y pura de cambios de precio pendientes de impresión.
// No hace red ni depende de React; todos los accesos a storage son inyectables.

export const QUEUE_STORAGE_KEY = "pos_label_print_queue_v1";
export const QUEUE_BACKUP_STORAGE_KEY = `${QUEUE_STORAGE_KEY}_backup`;
export const QUEUE_STORAGE_BACKUP_KEY = QUEUE_BACKUP_STORAGE_KEY;
export const QUEUE_REASONS = Object.freeze({ PRICE_CHANGE: "PRICE_CHANGE" });

const LEGACY_PRICE_CHANGE_REASON = "price_change";

export function generateEntryId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `lpq-${Date.now().toString(36)}-${random}`;
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedBarcode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function canonicalReason(value) {
  return value === QUEUE_REASONS.PRICE_CHANGE || value === LEGACY_PRICE_CHANGE_REASON
    ? QUEUE_REASONS.PRICE_CHANGE
    : null;
}

/**
 * Sanitiza una entrada y siempre emite la forma canónica v1. Acepta los
 * aliases `barcode` y `enqueuedAt` únicamente para migrar datos legacy.
 */
export function sanitizeEntry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const productBarcode = normalizedBarcode(input.productBarcode ?? input.barcode);
  const reason = canonicalReason(input.reason);
  if (!productBarcode || !reason) return null;

  const quantityValue = finiteNumber(input.quantity, 1);
  const quantity = Math.max(1, Math.floor(quantityValue >= 1 ? quantityValue : 1));
  const newSalePrice = finiteNumber(input.newSalePrice, 0);
  const salePrice = finiteNumber(input.salePrice, newSalePrice);
  const queuedAtValue = finiteNumber(input.queuedAt ?? input.enqueuedAt, Date.now());

  return {
    id:
      typeof input.id === "string" && input.id.trim()
        ? input.id.trim()
        : generateEntryId(),
    reason,
    productBarcode,
    productName: typeof input.productName === "string" ? input.productName : "",
    oldSalePrice: finiteNumber(input.oldSalePrice, 0),
    newSalePrice,
    salePrice,
    quantity,
    receptionRef:
      typeof input.receptionRef === "string" ? input.receptionRef : "",
    queuedAt: queuedAtValue,
  };
}

function mergeDuplicate(previous, incoming) {
  return {
    ...previous,
    productName: incoming.productName || previous.productName,
    oldSalePrice:
      previous.oldSalePrice > 0 ? previous.oldSalePrice : incoming.oldSalePrice,
    newSalePrice: incoming.newSalePrice,
    salePrice: incoming.salePrice,
    quantity: previous.quantity,
    receptionRef: incoming.receptionRef || previous.receptionRef,
    queuedAt: incoming.queuedAt,
  };
}

/** Normaliza una cola y deduplica por reason+productBarcode. */
export function sanitizeQueue(value) {
  if (!Array.isArray(value)) return [];

  const result = [];
  const indexByKey = new Map();
  for (const raw of value) {
    const entry = sanitizeEntry(raw);
    if (!entry) continue;
    const key = `${entry.reason}::${entry.productBarcode}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(entry);
    } else {
      result[existingIndex] = mergeDuplicate(result[existingIndex], entry);
    }
  }
  return result;
}

export const sanitize = sanitizeEntry;
export const sanitizeAll = sanitizeQueue;

function resolveStorage(storage) {
  if (
    storage &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function"
  ) {
    return storage;
  }
  try {
    const fallback = globalThis?.localStorage;
    if (
      fallback &&
      typeof fallback.getItem === "function" &&
      typeof fallback.setItem === "function"
    ) {
      return fallback;
    }
  } catch {
    // localStorage puede lanzar SecurityError incluso al consultarlo.
  }
  return null;
}

function readValidQueue(storage, key) {
  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return { state: "error", queue: [] };
  }
  if (raw == null) return { state: "missing", queue: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { state: "corrupt", queue: [] };
    return { state: "valid", queue: sanitizeQueue(parsed) };
  } catch {
    return { state: "corrupt", queue: [] };
  }
}

/**
 * Carga primary; si está ausente/corrupto o getItem falla, recupera la última
 * copia válida. Nunca borra ni sobrescribe durante la lectura.
 */
export function load(storage) {
  const target = resolveStorage(storage);
  if (!target) return [];

  const primary = readValidQueue(target, QUEUE_STORAGE_KEY);
  if (primary.state === "valid") return primary.queue;

  const backup = readValidQueue(target, QUEUE_BACKUP_STORAGE_KEY);
  return backup.state === "valid" ? backup.queue : [];
}

/** Guarda la forma canónica tanto en backup como en la key principal. */
export function save(storage, queue) {
  const target = resolveStorage(storage);
  if (!target) return false;
  const serialized = JSON.stringify(sanitizeQueue(queue));

  let backupSaved = false;
  let primarySaved = false;
  try {
    target.setItem(QUEUE_BACKUP_STORAGE_KEY, serialized);
    backupSaved = true;
  } catch {
    // Se intenta primary igualmente.
  }
  try {
    target.setItem(QUEUE_STORAGE_KEY, serialized);
    primarySaved = true;
  } catch {
    // El backup puede seguir permitiendo recuperación.
  }
  return primarySaved && backupSaved;
}

/** Encola o actualiza por reason+productBarcode, preservando id/old/quantity. */
export function enqueue(storage, input) {
  const incoming = sanitizeEntry(input);
  const current = load(storage);
  if (!incoming) return current;

  const key = `${incoming.reason}::${incoming.productBarcode}`;
  const index = current.findIndex(
    (entry) => `${entry.reason}::${entry.productBarcode}` === key,
  );
  const next = current.slice();
  if (index >= 0) next[index] = mergeDuplicate(current[index], incoming);
  else next.push(incoming);
  save(storage, next);
  return next;
}

export function updateQuantity(storage, id, quantity) {
  const current = load(storage);
  if (typeof id !== "string" || !id) return current;
  const index = current.findIndex((entry) => entry.id === id);
  if (index < 0) return current;

  const next = current.slice();
  next[index] = {
    ...next[index],
    quantity: Math.max(1, Math.floor(finiteNumber(quantity, 1))),
  };
  save(storage, next);
  return next;
}

export function remove(storage, id) {
  const current = load(storage);
  if (typeof id !== "string" || !id) return current;
  const next = current.filter((entry) => entry.id !== id);
  if (next.length !== current.length) save(storage, next);
  return next;
}

export function clear(storage) {
  const target = resolveStorage(storage);
  if (!target) return [];
  for (const key of [QUEUE_STORAGE_KEY, QUEUE_BACKUP_STORAGE_KEY]) {
    try {
      if (typeof target.removeItem === "function") target.removeItem(key);
    } catch {
      // Nunca propagar fallos de storage.
    }
  }
  return [];
}

// Aliases descriptivos para consumidores existentes.
export const loadQueue = load;
export const saveQueue = save;
export const removeFromQueue = remove;
export const clearQueue = clear;

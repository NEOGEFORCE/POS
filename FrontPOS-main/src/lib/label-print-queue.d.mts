export const QUEUE_STORAGE_KEY: "pos_label_print_queue_v1";
export const QUEUE_BACKUP_STORAGE_KEY: "pos_label_print_queue_v1_backup";
export const QUEUE_STORAGE_BACKUP_KEY: "pos_label_print_queue_v1_backup";
export const QUEUE_REASONS: Readonly<{ readonly PRICE_CHANGE: "PRICE_CHANGE" }>;
export type LabelQueueReason = "PRICE_CHANGE";

export interface LabelQueueEntry {
  id: string;
  reason: LabelQueueReason;
  productBarcode: string;
  productName: string;
  oldSalePrice: number;
  newSalePrice: number;
  salePrice: number;
  quantity: number;
  receptionRef: string;
  queuedAt: number;
}

export interface LabelQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function generateEntryId(): string;
export function sanitizeEntry(input: unknown): LabelQueueEntry | null;
export function sanitizeQueue(input: unknown): LabelQueueEntry[];
export const sanitize: typeof sanitizeEntry;
export const sanitizeAll: typeof sanitizeQueue;
export function load(storage?: LabelQueueStorage | null): LabelQueueEntry[];
export function save(
  storage: LabelQueueStorage | null | undefined,
  queue: ReadonlyArray<Partial<LabelQueueEntry> | unknown>,
): boolean;
export function enqueue(
  storage: LabelQueueStorage | null | undefined,
  entry: Partial<LabelQueueEntry> & Record<string, unknown>,
): LabelQueueEntry[];
export function updateQuantity(
  storage: LabelQueueStorage | null | undefined,
  id: string,
  quantity: number,
): LabelQueueEntry[];
export function remove(
  storage: LabelQueueStorage | null | undefined,
  id: string,
): LabelQueueEntry[];
export function clear(storage?: LabelQueueStorage | null): LabelQueueEntry[];

export const loadQueue: typeof load;
export const saveQueue: typeof save;
export const removeFromQueue: typeof remove;
export const clearQueue: typeof clear;

export const FATAL_SYNC_STATUSES: readonly number[];
export function isFatalSyncStatus(status: number): boolean;
export function classifySyncStatus(status: number): "success" | "session-recovery" | "dead-letter" | "retry";
export function exponentialBackoff(
  attempt: number,
  options?: { baseMs?: number; maxMs?: number; jitterMs?: number; random?: () => number }
): number;
export function computeSyncRetryDelay(attempt: number, random?: () => number): number;
export function computeSSERetryDelay(attempt: number, random?: () => number): number;
export function normalizeUserDni(userDni: string | number | null | undefined): string;
export function cartRecordKey(userDni: string | number): string;
export function cartStorageKey(baseKey: string, userDni: string | number): string;
export function parseSSEBlock(block: string): { event: string; data: string } | null;

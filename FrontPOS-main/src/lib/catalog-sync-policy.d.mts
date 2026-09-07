export const DEFAULT_MIN_INTERVAL_MS: number;
export const DEFAULT_STALE_AFTER_MS: number;
export const RECONNECT_MIN_INTERVAL_MS: number;

export type CatalogSyncReason = 'mount' | 'interval' | 'reconnect';

export interface CatalogSyncDecisionInput {
  lastSyncAt: number | null | undefined;
  now: number;
  minIntervalMs?: number;
}

export interface CatalogStaleInput {
  lastSyncAt: number | null | undefined;
  now: number;
  staleAfterMs?: number;
}

export function shouldSyncCatalog(input: CatalogSyncDecisionInput): boolean;
export function isCatalogStale(input: CatalogStaleInput): boolean;
export function syncFloorForReason(reason: CatalogSyncReason): number;

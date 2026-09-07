export const HISTORICAL_MARKER_CODE: 'HISTORICAL_MARKER_RESERVED';

export interface HistoricalMarkerMetadata {
  realBarcode: string;
  markerBarcode: string;
  markerName: string;
}

export interface HistoricalMarkerMergeRequest {
  realBarcode: string;
  markerBarcode: string;
}

export function isHistoricalMarkerError(err: unknown): boolean;
export function extractHistoricalMarkerMetadata(err: unknown): HistoricalMarkerMetadata | null;
export function buildMergeRequest(
  metadata: HistoricalMarkerMetadata | null | undefined
): HistoricalMarkerMergeRequest | null;
export function stripStaleTimestamp<T>(payload: T): T;
export function isAdminRole(role: string | null | undefined): boolean;

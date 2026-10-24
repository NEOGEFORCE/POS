// Type declarations for `./internal-barcode.mjs`.
// Permiten que los consumidores en TSX accedan a los helpers con
// autocompletado y tipos estrictos sin perder la unicidad del módulo
// `.mjs` (que es la fuente real que ejecutan los tests con node --test).

export const INTERNAL_BARCODE_PREFIX: string;
export const INTERNAL_BARCODE_HEX_MIN: number;
export const INTERNAL_BARCODE_HEX_MAX: number;
export const INTERNAL_BARCODE_DEFAULT_TTL_SECONDS: number;

export const INTERNAL_BARCODE_ERROR_CODES: Readonly<{
    NOT_FOUND: "INTERNAL_RESERVATION_NOT_FOUND";
    EXPIRED: "INTERNAL_RESERVATION_EXPIRED";
    ALREADY_USED: "INTERNAL_RESERVATION_ALREADY_USED";
    REQUIRES_RESERVATION: "INTERNAL_BARCODE_REQUIRES_RESERVATION";
    FORMAT_INVALID: "INTERNAL_BARCODE_FORMAT_INVALID";
    PRODUCT_IN_USE: "INTERNAL_PRODUCT_BARCODE_IN_USE";
    NAMESPACE_FORBIDDEN: "INTERNAL_NAMESPACE_FORBIDDEN";
}>;

export const INTERNAL_BARCODE_SOURCES: Readonly<{
    PRODUCT_FORM: "product_form";
    RECEPTION: "reception";
    OTHER: "other";
}>;

/** 200 OK de POST /labels/internal-codes/reserve. */
export interface InternalBarcodeReservation {
    code: string;
    status: string;
    source: string;
    expiresAt: string | null;
    reservedAt: string;
}

export function normalizeInternalBarcode(value: unknown): string;
export function isInternalBarcode(value: unknown): boolean;
export function isValidInternalBarcode(value: unknown): boolean;
export function extractInternalErrorCode(err: unknown): string | null;
export function translateInternalErrorCode(
    code: string | null | undefined,
): string | null;
export function isInternalBarcodeError(err: unknown): boolean;
export function buildReservePayload(opts?: {
    source?: string;
    note?: string;
    hexLen?: number;
    ttlSeconds?: number;
}): { source: string; note: string; hexLen: number; ttlSeconds: number };

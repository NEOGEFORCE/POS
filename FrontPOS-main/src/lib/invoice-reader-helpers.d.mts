/**
 * Tipos para los helpers del lector de facturas. Mantén en sincronía con
 * `invoice-reader-helpers.mjs`.
 */

export const INVOICE_FILE_MAX_BYTES: number;

export interface InvoiceItemLike {
  invoiceName?: string;
  name?: string;
  barcode?: string;
  quantity?: number;
  unitPrice?: number;
  totalPrice?: number;
  costUnit?: number;
  pvpSugerido?: number;
  marginUsed?: number;
  iva_percentage?: number;
  ibua_percentage?: number;
  icui_percentage?: number;
  discount_percentage?: number;
  line_type?: string;
  bonus_quantity?: number;
  suggestions?: Array<{ barcode: string; productName: string; confidence: number }>;
  __ocrLocalId?: string;
  [key: string]: any;
}

export interface NormalizedInvoiceItem extends InvoiceItemLike {
  __ocrLocalId: string;
  iva_percentage: number;
  ibua_percentage: number;
  icui_percentage: number;
  discount_percentage: number;
  bonus_quantity: number;
}

export function clampPercentage(value: unknown): number;
export function normalizeLineType(lineType: unknown): string | undefined;
export function sanitizeBonusQuantity(value: unknown): number;
export function makeOcrLocalId(prefix?: string): string;
export function fillInvoiceItemDefaults(item: InvoiceItemLike | null | undefined): NormalizedInvoiceItem;

export interface FileValidationResult {
  ok: boolean;
  reason?: 'empty' | 'bad-type' | 'too-large';
  message?: string;
}

export function validateInvoiceFile(
  file: Pick<File, 'type' | 'size'> | null | undefined,
  options?: { maxBytes?: number },
): FileValidationResult;

export function entryTypeFromLineType(
  lineType: unknown,
): 'purchase' | 'gift' | 'return';

export function resolveCartDiscountFromOcr(input: {
  lineType?: unknown;
  discount_percentage?: unknown;
}): number;

/**
 * Tipos para los helpers del lector de facturas. Mantén en sincronía con
 * `invoice-reader-helpers.mjs`.
 */

export const INVOICE_FILE_MAX_BYTES: number;

export interface InvoiceItemLike {
  invoiceName?: string;
  name?: string;
  barcode?: string;
  productName?: string;
  quantity?: number;
  unitPrice?: number;
  totalPrice?: number;
  costUnit?: number;
  /** Costo real por paquete en facturas con empaques detectados. */
  costoReal?: number;
  pvpSugerido?: number;
  pvpActual?: number;
  marginUsed?: number;
  /** Stock actual del producto (viaja de catálogo a modal; no se divide). */
  currentStock?: number;
  /** WAC actual del producto (viaja de catálogo a modal; no se divide). */
  currentWac?: number;
  iva?: number;
  ibua?: number;
  icui?: number;
  iva_percentage?: number;
  ibua_percentage?: number;
  icui_percentage?: number;
  discount_percentage?: number;
  line_type?: string;
  lineType?: string;
  bonus_quantity?: number;
  isMatched?: boolean;
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

// ─────────────────────────────────────────────────────────────────────────
// Impuestos esperados: neutralización defensiva
// ─────────────────────────────────────────────────────────────────────────

export interface ExpectedTaxes {
  iva: boolean;
  ibua: boolean;
  icui: boolean;
}

export function neutralizeTaxFields<T extends InvoiceItemLike>(
  item: T | null | undefined,
  expectedTaxes?: ExpectedTaxes | null,
): T;

// ─────────────────────────────────────────────────────────────────────────
// Empaques: confirmación obligatoria y conversión a unidades individuales
// ─────────────────────────────────────────────────────────────────────────

export const PACK_MIN_UNITS: number;
export const PACK_MAX_UNITS: number;

export interface PackHintItemLike extends InvoiceItemLike {
  packHintUnits?: number;
  /** Variante defensiva por si el backend evoluciona a snake_case. */
  pack_hint_units?: number;
  requiresPackConfirmation?: boolean;
  /** Variante defensiva por si el backend evoluciona a snake_case. */
  requires_pack_confirmation?: boolean;
}

export function getPackHintUnits(item: PackHintItemLike | null | undefined): number;
export function itemRequiresPackConfirmation(
  item: PackHintItemLike | null | undefined,
): boolean;
export function anyItemRequiresPackConfirmation(
  items: Array<PackHintItemLike | null | undefined> | null | undefined,
): boolean;
export function isValidUnitsPerPack(value: unknown): boolean;

export interface PackConvertedItem extends InvoiceItemLike {
  /** Cantidad original en paquetes (antes de multiplicar). */
  invoicePackageQuantity?: number;
  /** N confirmado por el usuario. */
  confirmedUnitsPerPack?: number;
  /** Marca que la conversión ya corrió — evita doble multiplicación. */
  packConversionApplied?: boolean;
  /** Modo elegido por el operario (EMPAQUE o PRESENTACION). */
  packMode?: PackMode;
}

export function convertItemToIndividualUnits<T extends InvoiceItemLike>(
  item: T | null | undefined,
  unitsPerPack: number | string,
): T & PackConvertedItem;

// ─────────────────────────────────────────────────────────────────────────
// Modo de carga por item: PRESENTACION vs EMPAQUE
// ─────────────────────────────────────────────────────────────────────────

export const PACK_MODE_EMPAQUE: 'EMPAQUE';
export const PACK_MODE_PRESENTACION: 'PRESENTACION';

export type PackMode = 'EMPAQUE' | 'PRESENTACION';

export function classifyPackMode(
  item: PackHintItemLike | null | undefined,
): PackMode;

export function convertItemAsPresentation<T extends InvoiceItemLike>(
  item: T | null | undefined,
): T & PackConvertedItem;

// Declaraciones TS para src/lib/shelf-labels.mjs.
// El módulo real es puro JS para que corra en `node --test` sin bundler.

export const SHEET_WIDTH_MM: 215.9;
export const SHEET_HEIGHT_MM: 279.4;
export const LABEL_WIDTH_MM: 80;
export const LABEL_HEIGHT_MM: 40;
export const COLUMNS: 2;
export const ROWS: 6;
export const LABELS_PER_PAGE: 12;
export const PAGE_PADDING_X_MM: number;
export const PAGE_PADDING_Y_MM: number;
export const LAYOUT_META_ID: "gondola-80x40-letter-2x6";

/**
 * Item lógico de la cola de etiquetas de góndola. Representa un producto
 * (con su cantidad) antes de expandirse en N slots físicos.
 */
export interface ShelfLabelItem {
    /** Código asegurado por `POST /labels/codes`. */
    code: string;
    /** Nombre que se imprime en la etiqueta. */
    productName: string;
    /** Precio de venta en pesos colombianos. */
    salePrice: number;
    /** Cantidad de etiquetas a imprimir. Siempre >= 1 tras normalizar. */
    quantity: number;
    /** SKU alterno (si existe). Pintado en el footer izquierdo cuando se provee. */
    sku?: string;
    /** Unidad de medida (UND, KG, LT, etc.). Default `UND`. */
    unit?: string;
}

/**
 * Slot físico después de expandir la cola. Pierde `quantity`: cada slot
 * es una etiqueta individual lista para pintar.
 */
export interface ShelfLabelSlot {
    code: string;
    productName: string;
    salePrice: number;
    sku?: string;
    unit?: string;
}

/**
 * Resumen contable que alimenta la UI y el payload de auditoría.
 */
export interface ShelfLabelsSummary {
    /** Total de etiquetas físicas (ya expandidas por cantidad). */
    totalLabels: number;
    /** Páginas completas (12 etiquetas). */
    fullPages: number;
    /** Etiquetas sobrantes en la última página (0..11). */
    remainder: number;
    /** Total de páginas que la impresora producirá (fullPages + (remainder > 0 ? 1 : 0)). */
    totalPages: number;
    /** Blanks que la última página añade para completar las 12 guías. */
    blanks: number;
    /** Siempre 12, expuesto para que el consumidor no hardcodee. */
    labelsPerPage: 12;
}

export function escapeHtml(s: unknown): string;
export function formatCOP(v: number | string | null | undefined): string;
export function formatPrintDate(now?: Date | string | number | null): string;
export function truncate(value: string, max: number): string;
export function normalizeQuantity(value: unknown): number;
export function normalizeShelfLabelItem(
    item: Partial<ShelfLabelItem> | null | undefined,
): ShelfLabelItem | null;

export function expandItemsToSlots(
    items: ReadonlyArray<Partial<ShelfLabelItem>>,
): ShelfLabelSlot[];

export function paginateSlots(
    slots: ReadonlyArray<ShelfLabelSlot>,
): Array<Array<ShelfLabelSlot | null>>;

export function summarizeShelfLabels(
    items: ReadonlyArray<Partial<ShelfLabelItem>>,
): ShelfLabelsSummary;

export function buildShelfLabelsCss(): string;
export function buildSlotHtml(slot: ShelfLabelSlot | null, dateLabel: string): string;
export function buildShelfLabelsPrintHtml(
    items: ReadonlyArray<Partial<ShelfLabelItem>>,
    opts?: { now?: Date | string | number },
): string;

export function buildAuditMeta(
    extra?: Record<string, unknown>,
): { layout: typeof LAYOUT_META_ID } & Record<string, unknown>;

// Declaraciones TS para src/lib/shelf-labels.mjs.
// El módulo real es puro JS para que corra en `node --test` sin bundler.

export type GondolaFormat = "LETTER" | "LEGAL";

export const LABEL_WIDTH_MM: 80;
export const LABEL_HEIGHT_MM: 40;

export const GONDOLA_FORMATS: Readonly<Record<"LETTER" | "LEGAL", GondolaFormat>>;
export const DEFAULT_GONDOLA_FORMAT: "LETTER";

export interface GondolaFormatSpec {
    readonly id: GondolaFormat;
    readonly label: string;
    readonly sheetWidthMm: number;
    readonly sheetHeightMm: number;
    readonly columns: number;
    readonly rows: number;
    readonly labelsPerPage: number;
    readonly cssPageSize: string;
    readonly layoutMetaId: string;
    readonly sheetLabel: string;
}

export const GONDOLA_FORMAT_SPECS: Readonly<Record<GondolaFormat, GondolaFormatSpec>>;

export interface GondolaLayout {
    format: GondolaFormat;
    label: string;
    sheetWidthMm: number;
    sheetHeightMm: number;
    labelWidthMm: 80;
    labelHeightMm: 40;
    columns: number;
    rows: number;
    labelsPerPage: number;
    paddingXMm: number;
    paddingYMm: number;
    cssPageSize: string;
    layoutMetaId: string;
    sheetLabel: string;
}

export function resolveGondolaFormat(input: unknown): GondolaFormat;
export function resolveGondolaLayout(format?: unknown): GondolaLayout;

// Alias retrocompatibles basados en el formato DEFAULT (Letter landscape).
export const SHEET_WIDTH_MM: 279.4;
export const SHEET_HEIGHT_MM: 215.9;
export const COLUMNS: 3;
export const ROWS: 5;
export const LABELS_PER_PAGE: 15;
export const PAGE_PADDING_X_MM: number;
export const PAGE_PADDING_Y_MM: number;
export const LAYOUT_META_ID: "gondola-80x40-letter-landscape-3x5";

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
 * Resumen contable que alimenta la UI y el payload de auditoría. Incluye
 * el formato activo y su layout canónico para que el consumidor NO vuelva
 * a resolverlos por su cuenta.
 */
export interface ShelfLabelsSummary {
    /** Formato activo que produjo este resumen. */
    format: GondolaFormat;
    /** Total de etiquetas físicas (ya expandidas por cantidad). */
    totalLabels: number;
    /** Páginas completas (labelsPerPage etiquetas). */
    fullPages: number;
    /** Etiquetas sobrantes en la última página (0..labelsPerPage-1). */
    remainder: number;
    /** Total de páginas que la impresora producirá. */
    totalPages: number;
    /** Blanks que la última página añade para completar las guías. */
    blanks: number;
    /** Slots por página del formato activo (15 Letter / 20 Legal). */
    labelsPerPage: number;
    /** Identificador del layout canónico (ej. `gondola-80x40-letter-landscape-3x5`). */
    layout: string;
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
    format?: unknown,
): Array<Array<ShelfLabelSlot | null>>;

export function summarizeShelfLabels(
    items: ReadonlyArray<Partial<ShelfLabelItem>>,
    format?: unknown,
): ShelfLabelsSummary;

export function buildShelfLabelsCss(format?: unknown): string;
export function buildSlotHtml(slot: ShelfLabelSlot | null, dateLabel: string): string;
export function buildShelfLabelsPrintHtml(
    items: ReadonlyArray<Partial<ShelfLabelItem>>,
    opts?: { now?: Date | string | number; format?: unknown },
): string;

export interface ShelfLabelsAuditMeta {
    layout: string;
    format: GondolaFormat;
    sheet: string;
    sheetWidthMm: number;
    sheetHeightMm: number;
    labelWidthMm: 80;
    labelHeightMm: 40;
    columns: number;
    rows: number;
    labelsPerPage: number;
    [extraKey: string]: unknown;
}

export function buildAuditMeta(
    extra?: Record<string, unknown> | null,
    format?: unknown,
): ShelfLabelsAuditMeta;

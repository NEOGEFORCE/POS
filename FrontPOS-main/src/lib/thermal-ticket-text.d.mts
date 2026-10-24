// Declaraciones TS para src/lib/thermal-ticket-text.mjs.
// El módulo real es puro JS para que corra en `node --test` sin bundler.

export type TicketWidth = "58mm" | "80mm";
export type TicketCutMode = "AUTO" | "MANUAL" | "NONE";

export interface TicketLine {
    name: string;
    quantity: number;
    unitPrice: number;
    total: number;
}

export interface TicketData {
    ticketNumber: string | number;
    date: Date;
    cashier: string;
    clientName?: string;
    clientDni?: string;
    clientPhone?: string;
    lines: TicketLine[];
    subtotal: number;
    taxes?: number;
    total: number;
    paymentMethod: string;
    received?: number;
    change?: number;
    /** Nota opcional al pie (ej. saldo de fiado pendiente). */
    note?: string;
    /**
     * URL opcional de validación/verificación. Cuando
     * `options.showValidationQR` está activa Y existe URL, se añade al
     * ticket como texto plano. NUNCA se representa como QR escaneable.
     */
    validationUrl?: string;
    /**
     * URL opcional del logo del negocio (http/https o data URL). Lo embebe
     * la plantilla HTML cuando `options.showLogo` está activa. Si no hay
     * URL, el toggle se ignora para no inventar imagen.
     */
    logoUrl?: string;
}

export interface StoreHeader {
    name: string;
    nit: string;
    address: string;
    phone: string;
}

/**
 * Opciones que puede pasar el llamador para evitar que `printThermalTicket`
 * tenga que consultar LocalStorage. Todas son opcionales; `buildTicketText`
 * mantiene retrocompatibilidad cuando se llama sin este parámetro.
 */
export interface TicketPrintOptions {
    /** Columnas monoespacio. Si no se pasa, derivan del `width`. */
    columns?: number;
    /** Encabezado del negocio. Si no se pasa, se usa `STORE`. */
    store?: Partial<StoreHeader>;
    /** Tipografía personalizada en px (sólo CSS de impresión). */
    fontSizePx?: number;
    /** `false` oculta la línea `IVA / IMPUESTOS`. Default = mostrar (BC). */
    showTaxes?: boolean;
    /** Mensaje de agradecimiento al pie. Vacío/undefined cae al literal histórico. */
    thankYou?: string;
    /** Marcador textual de corte: `MANUAL` o `AUTO` aparecen al final del ticket. */
    cut?: TicketCutMode;
    /** Si `true` y hay `data.logoUrl`, la plantilla HTML embebe un `<img>`. */
    showLogo?: boolean;
    /** Si `true` y hay `data.validationUrl`, el ticket rotula la URL como texto. */
    showValidationQR?: boolean;
    /**
     * Hint para el bridge: `true` cuando este payload se dispara por una
     * venta recién confirmada Y la config tiene `drawer.openDrawerOnSale`
     * activo. Reimpresión y manual deben dejarlo `undefined` o `false`
     * para no abrir el cajón físicamente.
     */
    openDrawerOnSale?: boolean;
}

export const STORE: Readonly<StoreHeader>;

export function charsPerLine(width: TicketWidth, override?: number): number;
export function money(v: number): string;
export function pad(text: string, len: number): string;
export function padLeft(text: string, len: number): string;
export function center(text: string, width: number): string;
export function wrap(text: string, width: number): string[];
/**
 * Literal estable que `formatDateTime` devuelve cuando la entrada no es
 * un `Date` válido (undefined, string indescifrable, Invalid Date,...).
 */
export const INVALID_DATE_LABEL: string;
/**
 * Formatea una fecha a `dd/MM/yyyy hh:mm AM`. Acepta `Date`, un string
 * parseable (ISO 8601 preferido) o un número epoch. Cualquier otra cosa
 * cae en {@link INVALID_DATE_LABEL} y jamás emite `NaN`.
 */
export function formatDateTime(d: Date | string | number | null | undefined): string;
export function resolveStore(
    storeOverride?: Partial<StoreHeader> | null,
    cfgHeader?: Partial<StoreHeader> | null,
): StoreHeader;
export function escapeHtml(s: unknown): string;
export function buildTicketText(
    data: TicketData,
    width?: TicketWidth,
    options?: TicketPrintOptions,
): string;

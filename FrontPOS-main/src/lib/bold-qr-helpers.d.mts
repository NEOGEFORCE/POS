// Declaraciones TS para `src/lib/bold-qr-helpers.mjs`.
// El módulo real es puro JS para que corra en `node --test` sin bundler.

export interface BoldMerchantInfo {
    readonly businessName: string;
    readonly titular: string;
    readonly codigoComercio: string;
    readonly subheader: string;
    readonly footer: string;
}

export const BOLD_MERCHANT: BoldMerchantInfo;
export const BOLD_QR_METHOD_LABEL: string;
export const BOLD_QR_METHOD_BADGE: string;
export const BOLD_QR_IMAGE_PATH: string;
export const BOLD_QR_MIN_SIDE_PX: number;
export const BOLD_QR_ASSET_SIDE_PX: number;
export const BOLD_QR_CSS_MIN: string;
export const BOLD_QR_PREFERRED_SIDE_PX: number;

export type BoldQrStatus =
    | "PENDIENTE"
    | "APROBADO"
    | "UNMATCHED"
    | "AMBIGUOUS"
    | "EXPIRADO"
    | "CANCELADO"
    | "ERROR";

export const BOLD_QR_STATUS: Readonly<Record<BoldQrStatus, BoldQrStatus>>;

export const BOLD_QR_INTENT_TTL_MS: number;

export function isIntentExpired(
    createdAt: number | Date | string | null | undefined,
    nowMs: number,
): boolean;

export function msUntilExpiry(
    createdAt: number | Date | string | null | undefined,
    nowMs: number,
): number;

export function formatCountdown(ms: number): string;

export function extractCOPFromMessage(mensaje: unknown): number | null;
export function parseCOPToken(token: unknown): number | null;

export type StreamAction =
    | "approve"
    | "require-manual"
    | "expire"
    | "cancel"
    | "error"
    | "wait"
    | "ignore";

export interface StreamClassification {
    readonly action: StreamAction;
    readonly reason?: string;
}

export function classifyStreamEvent(
    event: { status?: unknown; reason?: unknown } | null | undefined,
): StreamClassification;

export interface IniciarPayload {
    readonly caja_id: string | number;
    readonly monto: number;
    readonly venta_temp_id: string;
    /**
     * Transaction identifier reused end-to-end between `/iniciar` and
     * `/encolar` (migración 027 — snapshot durable). Length 8..64.
     * Must match the same value sent later on `/encolar`.
     */
    readonly client_tx_id?: string;
    /** DNI del cliente (vacío si CONSUMIDOR FINAL). */
    readonly client_dni?: string;
    /** Nombre del cajero actual (bandeja global). */
    readonly cashier_name?: string;
    /**
     * Snapshot opcional del carrito que el padre pre-registra al abrir
     * el QR. Permite al backend materializar la venta canónica aun si
     * el cajero jamás pulsa "DEJAR EN ESPERA Y SEGUIR ATENDIENDO".
     */
    readonly sale_payload?: EncolarSalePayload;
}

export function buildIniciarPayload(args: {
    readonly caja_id: string | number;
    readonly monto: number;
    readonly venta_temp_id: string;
    readonly client_tx_id?: string;
    readonly client_dni?: string;
    readonly cashier_name?: string;
    readonly sale_payload?: EncolarSalePayload;
}): IniciarPayload | null;



// =============================================================================
// Flujo asíncrono QR Bold/Bre-B (migración 027)
// =============================================================================

export const BOLD_QR_TRAY_EVENT: string;

export type BoldQrTrayKind =
    | "ENQUEUED"
    | "APPROVED"
    | "AMBIGUOUS"
    | "UNMATCHED"
    | "EXPIRED"
    | "CANCELLED"
    | "ERROR";

export const BOLD_QR_TRAY_KIND: Readonly<Record<BoldQrTrayKind, BoldQrTrayKind>>;

export interface BoldQrTrayEvent {
    readonly kind: BoldQrTrayKind;
    readonly ventaTempId: string;
    readonly intentId?: number;
    readonly cajaId?: string;
    readonly amountCop?: number;
    readonly saleId?: number;
    readonly reference?: string;
    readonly approvedAt?: string;
    readonly approvedVia?: string;
    readonly reason?: string;
    readonly cashierName?: string;
    readonly occurredAt?: string;
}

export function classifyTrayEvent(raw: unknown): BoldQrTrayEvent | null;

export interface EncolarSalePayload {
    readonly details: ReadonlyArray<{
        readonly barcode: string;
        readonly quantity: number;
        readonly unitPrice: number;
        readonly costPrice?: number;
        readonly subtotal?: number;
    }>;
    readonly totalAmount?: number;
    readonly amountPaid?: number;
    readonly change?: number;
    readonly cashAmount?: number;
    readonly transferAmount?: number;
    readonly transferNequi?: number;
    readonly transferDaviplata?: number;
    readonly creditAmount?: number;
    readonly debtPending?: number;
    readonly transferSource?: string;
    readonly paymentMethod?: string;
    readonly employeeDni?: string;
    readonly clientDni?: string;
    readonly clientName?: string;
}

export interface EncolarPayload {
    readonly venta_temp_id: string;
    readonly caja_id: string;
    readonly monto: number;
    readonly client_tx_id: string;
    readonly client_dni: string;
    readonly cashier_name: string;
    readonly sale_payload: EncolarSalePayload;
}

export function buildEncolarPayload(args: {
    readonly ventaTempId: string;
    readonly cajaId: string | number;
    readonly monto: number;
    readonly clientTxId: string;
    readonly cashierName?: string;
    readonly clientDni?: string;
    readonly salePayload: EncolarSalePayload;
}): EncolarPayload | null;

export function generateQrClientTxId(): string;


// =============================================================================
// Pagos QR SIN ASIGNAR (migración 027b — bandeja de desambiguación)
// =============================================================================

export type BoldQrUnassignedStatus = "AMBIGUOUS" | "UNMATCHED";

export interface BoldQrUnassignedPayment {
    readonly eventId: number;
    readonly amountCop: number;
    readonly receivedAt: string;
    readonly status: BoldQrUnassignedStatus;
    readonly resumen: string;
}

export type BoldQrAssignErrorCode =
    | "QR_EVENT_ALREADY_ASSIGNED"
    | "QR_AMOUNT_MISMATCH"
    | "QR_INTENT_ALREADY_TERMINAL"
    | "QR_EVENT_NOT_FOUND"
    | "QR_INTENT_NOT_FOUND";

export const BOLD_QR_ASSIGN_ERROR_CODE: Readonly<Record<
    "EVENT_ALREADY_ASSIGNED" | "AMOUNT_MISMATCH" | "INTENT_ALREADY_TERMINAL" | "EVENT_NOT_FOUND" | "INTENT_NOT_FOUND",
    BoldQrAssignErrorCode
>>;

export function classifyUnassignedPayment(raw: unknown): BoldQrUnassignedPayment | null;

export function canAssignToPending(
    unassigned: { amountCop?: unknown } | null | undefined,
    pending: { amountCop?: unknown } | null | undefined,
): boolean;

export interface BoldQrAsignarPayload {
    readonly venta_temp_id: string;
    readonly event_id: number;
}

export function buildAsignarPayload(args: {
    readonly venta_temp_id?: unknown;
    readonly event_id?: unknown;
}): BoldQrAsignarPayload | null;

export function extractAssignErrorCode(err: unknown): BoldQrAssignErrorCode | null;

export function describeAssignErrorCode(code: string | null | undefined): string;



// =============================================================================
// Flujo "venta ya pagada" (defensa anti-reapertura, bug 2026-10-23)
// =============================================================================

export const BOLD_QR_ALREADY_PAID_SENTINEL: string;
export const BOLD_QR_ALREADY_PAID_ERROR_CODE: "QR_INTENT_ALREADY_PAID";
export const BOLD_QR_PAID_SESSION_PREFIX: string;

export interface BoldQrAlreadyPaidInfo {
    readonly saleId?: number;
    readonly amountCop?: number;
}

export function isAlreadyPaidResponse(res: unknown): BoldQrAlreadyPaidInfo | null;
export function extractAlreadyPaidErrorInfo(err: unknown): BoldQrAlreadyPaidInfo | null;
export function isAlreadyPaidError(err: unknown): boolean;

export function markBoldQrPaidInStorage(
    storage: Storage | null | undefined,
    ventaTempId: string,
    info?: { saleId?: number; amountCop?: number; now?: number },
): boolean;

export function isBoldQrPaidInStorage(
    storage: Storage | null | undefined,
    ventaTempId: unknown,
): boolean;

export function listBoldQrPaidKeys(storage: Storage | null | undefined): string[];

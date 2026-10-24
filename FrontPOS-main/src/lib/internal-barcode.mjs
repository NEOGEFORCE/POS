// =============================================================================
// src/lib/internal-barcode.mjs
//
// Helpers puros para el namespace de códigos internos POSINT-<hex>.
//
// Este módulo centraliza la lógica del contrato acordado con el backend
// (ver backPOS-go/internal/core/domain/models/internal_barcode_reservation.go
// y backPOS-go/internal/adapters/handlers/internal_barcode_handler.go). Vive
// como `.mjs` sin TypeScript para que:
//
//   1. Pueda ser importado desde componentes "use client" sin fricción.
//   2. Lo cubran tests con `node --test` (contrato puro, sin tooling de UI).
//   3. Nunca pueda derivar en una copia paralela con un prefijo tipeado
//      distinto. La ÚNICA fuente de verdad del namespace vive aquí.
//
// Punto clave: EL FRONTEND NO GENERA CÓDIGOS. Sólo:
//
//   - sabe reconocer un `POSINT-*` para activar la UI post-reserva, y
//   - sabe traducir las 6 claves de error del backend a mensajes humanos.
//
// La generación/colisión/consumo es responsabilidad exclusiva del backend
// (crypto/rand + unicidad por PK + SELECT FOR UPDATE). Cualquier intento
// futuro de "fabricar POSINT en cliente" rompería la invariante global de
// unicidad (dos pestañas abiertas podrían escupir el mismo valor) y por
// eso este archivo intencionalmente carece de un generador local.
// =============================================================================

/**
 * Prefijo exclusivo del namespace. ASCII puro, imprimible en CODE128.
 * COINCIDE con `models.InternalBarcodePrefix` en el backend.
 * @type {string}
 */
export const INTERNAL_BARCODE_PREFIX = "POSINT-";

/**
 * Expresión regular canónica del shape aceptado por el backend
 * (`^POSINT-[0-9A-F]{8,24}$`). La replicamos aquí sólo para rechazar
 * tempranamente códigos manipulados por el usuario antes de reintentar
 * un POST (defensa en profundidad: la BD es la última palabra).
 */
const INTERNAL_SHAPE = /^POSINT-[0-9A-F]{8,24}$/;

/**
 * Longitudes aceptadas del cuerpo hex, en nibbles. COINCIDEN con
 * `InternalBarcodeHexMin/Max` del backend.
 */
export const INTERNAL_BARCODE_HEX_MIN = 8;
export const INTERNAL_BARCODE_HEX_MAX = 24;

/**
 * TTL por defecto que usa el handler cuando el cliente no envía
 * `ttlSeconds`. 15 minutos: suficiente para completar el formulario
 * sin dejar reservas eternas si el usuario cierra la pestaña.
 */
export const INTERNAL_BARCODE_DEFAULT_TTL_SECONDS = 15 * 60;

/**
 * Códigos de error ESTABLES que emite el backend al consumir una reserva
 * o al rechazar un POST sobre /labels/internal-codes/*.
 *
 * Los nombres son parte del contrato: renombrar aquí sin coordinar con
 * `internal_barcode_reservation.go` rompe la UI de recuperación.
 */
export const INTERNAL_BARCODE_ERROR_CODES = Object.freeze({
    NOT_FOUND: "INTERNAL_RESERVATION_NOT_FOUND",
    EXPIRED: "INTERNAL_RESERVATION_EXPIRED",
    ALREADY_USED: "INTERNAL_RESERVATION_ALREADY_USED",
    REQUIRES_RESERVATION: "INTERNAL_BARCODE_REQUIRES_RESERVATION",
    FORMAT_INVALID: "INTERNAL_BARCODE_FORMAT_INVALID",
    PRODUCT_IN_USE: "INTERNAL_PRODUCT_BARCODE_IN_USE",
    NAMESPACE_FORBIDDEN: "INTERNAL_NAMESPACE_FORBIDDEN",
});

/**
 * Normalización canónica: TrimSpace + ToUpper. Debe coincidir con la
 * normalización que aplica `product_handler.Create` sobre `product.Barcode`,
 * si no la UI y el backend verían el mismo valor con casing distinto y las
 * lookups fallarían.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeInternalBarcode(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim().toUpperCase();
}

/**
 * Reconoce si un string cae dentro del namespace POSINT-. Útil para
 * decidir si mostrar el flujo de impresión post-create.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isInternalBarcode(value) {
    const normalized = normalizeInternalBarcode(value);
    return normalized.startsWith(INTERNAL_BARCODE_PREFIX);
}

/**
 * Valida el shape ESTRICTO (prefijo + 8..24 nibbles hex uppercase). Más
 * restrictivo que `isInternalBarcode`: útil para rechazar manipulaciones
 * antes de enviarlas al backend.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidInternalBarcode(value) {
    const normalized = normalizeInternalBarcode(value);
    return INTERNAL_SHAPE.test(normalized);
}

/**
 * Extrae el código de error ESTABLE de una respuesta de API.
 *
 * El backend puede responder dos shapes compatibles:
 *   1. 404 directo:              { error: "...", code: "INTERNAL_..." }
 *   2. Vía SendError (409/400):  { success: false, error: { code: "INTERNAL_...", ... } }
 *
 * `ApiError.data` del helper `apiFetch` conserva ese JSON intacto. Esta
 * función reconoce ambos layouts sin asumir instancias (acepta cualquier
 * objeto `err` con `.data` o `.response`).
 *
 * @param {unknown} err
 * @returns {string|null} código estable o null si no está presente.
 */
export function extractInternalErrorCode(err) {
    if (!err || typeof err !== "object") return null;
    const anyErr = /** @type {Record<string, any>} */ (err);
    // Shape 1 — ApiError.data con el JSON del backend.
    const payload = anyErr.data ?? anyErr.response ?? anyErr;
    if (!payload || typeof payload !== "object") return null;

    // Prioridad 1: payload.error.code  (SendError estructurado).
    const nested = payload.error;
    if (nested && typeof nested === "object" && typeof nested.code === "string") {
        if (isKnownInternalErrorCode(nested.code)) return nested.code;
    }
    // Prioridad 2: payload.code  (handler GetByCode responde este shape).
    if (typeof payload.code === "string" && isKnownInternalErrorCode(payload.code)) {
        return payload.code;
    }
    return null;
}

/**
 * Pura comprobación de pertenencia al enum.
 * @param {string} code
 * @returns {boolean}
 */
function isKnownInternalErrorCode(code) {
    for (const value of Object.values(INTERNAL_BARCODE_ERROR_CODES)) {
        if (value === code) return true;
    }
    return false;
}

/**
 * Traduce el código de error estable a un mensaje en español apto para
 * mostrar en toast/Alert. Mapea las 6+1 claves canónicas del backend.
 *
 * NO filtra texto crudo del backend: la traducción vive aquí para que
 * mensajes nuevos del servidor nunca sorprendan al usuario sin pasar por
 * revisión.
 *
 * @param {string|null|undefined} code
 * @returns {string|null}
 */
export function translateInternalErrorCode(code) {
    if (!code) return null;
    switch (code) {
        case INTERNAL_BARCODE_ERROR_CODES.NOT_FOUND:
            return "La reserva de código interno no existe o venció. Genera uno nuevo con el botón.";
        case INTERNAL_BARCODE_ERROR_CODES.EXPIRED:
            return "La reserva del código interno expiró. Genera uno nuevo con el botón.";
        case INTERNAL_BARCODE_ERROR_CODES.ALREADY_USED:
            return "Esa reserva ya se consumió para otro producto. Genera uno nuevo con el botón.";
        case INTERNAL_BARCODE_ERROR_CODES.REQUIRES_RESERVATION:
            return "Los códigos POSINT- sólo pueden crearse con el botón 'Generar código interno'.";
        case INTERNAL_BARCODE_ERROR_CODES.FORMAT_INVALID:
            return "El código interno tiene un formato inválido. Pide uno nuevo con el botón.";
        case INTERNAL_BARCODE_ERROR_CODES.PRODUCT_IN_USE:
            return "El código generado colisionó con otro producto. Pulsa 'Regenerar' para obtener uno libre.";
        case INTERNAL_BARCODE_ERROR_CODES.NAMESPACE_FORBIDDEN:
            return "El namespace POSINT- no puede usarse en códigos alternos ni paquetes.";
        default:
            return null;
    }
}

/**
 * Devuelve `true` si el error pertenece al dominio de códigos internos
 * (uno de los 6+1 códigos estables). Útil para que el modal decida si
 * presenta el estado "regenerar" o si delega al toast genérico.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isInternalBarcodeError(err) {
    return extractInternalErrorCode(err) !== null;
}

/**
 * Shape del body opcional que acepta POST /labels/internal-codes/reserve.
 * Documentado aquí para que el llamador no tenga que leer handler Go.
 *
 *   {
 *     source?:     "product_form" | "reception" | "other", // default product_form
 *     note?:       string,
 *     hexLen?:     number (8..24, default 12),
 *     ttlSeconds?: number (positivo => TTL, 0 => default, negativo => rechazo del server)
 *   }
 */
export const INTERNAL_BARCODE_SOURCES = Object.freeze({
    PRODUCT_FORM: "product_form",
    RECEPTION: "reception",
    OTHER: "other",
});

/**
 * Shape del 200 OK del endpoint de reserva. Documentado como JSDoc para
 * los consumidores en TypeScript.
 *
 * @typedef {Object} InternalBarcodeReservation
 * @property {string} code         Código reservado (POSINT-XXXX...).
 * @property {string} status       "RESERVED" tras la reserva exitosa.
 * @property {string} source       Origen operativo registrado.
 * @property {string|null} expiresAt ISO 8601, o null si sin TTL.
 * @property {string} reservedAt   ISO 8601 de la reserva.
 */

/**
 * Construye el payload del POST /labels/internal-codes/reserve con
 * defaults sanos. Centralizarlo evita que un callsite pida un `hexLen`
 * fuera de rango o se olvide del `source`.
 *
 * @param {{ source?: string; note?: string; hexLen?: number; ttlSeconds?: number }} opts
 * @returns {{ source: string; note: string; hexLen: number; ttlSeconds: number }}
 */
export function buildReservePayload(opts = {}) {
    const source = opts && typeof opts.source === "string" && opts.source.length > 0
        ? opts.source
        : INTERNAL_BARCODE_SOURCES.PRODUCT_FORM;
    const note = opts && typeof opts.note === "string" ? opts.note : "";
    let hexLen = Number(opts?.hexLen ?? 0);
    if (!Number.isFinite(hexLen) || hexLen <= 0) hexLen = 0;
    else if (hexLen < INTERNAL_BARCODE_HEX_MIN) hexLen = INTERNAL_BARCODE_HEX_MIN;
    else if (hexLen > INTERNAL_BARCODE_HEX_MAX) hexLen = INTERNAL_BARCODE_HEX_MAX;
    let ttlSeconds = Number(opts?.ttlSeconds ?? 0);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) ttlSeconds = 0;
    return { source, note, hexLen, ttlSeconds };
}

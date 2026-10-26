// =============================================================================
// src/lib/bold-qr-helpers.mjs
//
// Helpers PUROS para el flujo de cobro QR Bold/Bre-B del Supermercado
// Surtifamiliar. No tocan DOM, no abren red, no leen storage. Toda la
// lógica imperativa (fetch, EventSource/stream con auth, audio, animación)
// vive en `src/components/shared/ModalPagoBoldQR.tsx`.
//
// Esto permite probar en `node --test`:
//   - El estado de una intención (PENDIENTE / APROBADO / EXPIRADO / ...).
//   - La extracción del monto COP desde el texto crudo que emite el
//     bridge MacroDroid ("Recibiste $45.800" → 45800).
//   - El reloj de expiración (15 min).
//   - El contrato del encabezado del merchant verificado.
//
// REGLAS DEL MÓDULO
//   * Todas las funciones son deterministas y aceptan el reloj como
//     parámetro (nowMs) para que los tests no dependan de Date.now().
//   * NUNCA se inventa un monto: si el texto no trae un valor COP válido
//     la función devuelve null, nunca 0 ni NaN.
//   * NUNCA se inventa estado: una intención sin status conocido queda
//     en "DESCONOCIDO" y la UI debe forzar confirmación manual.
//   * NUNCA se almacena el token de MacroDroid ni la firma HMAC del
//     webhook — ni como constante ni como variable local. Esos valores
//     viven solo en el backend y jamás tocan el bundle del front.
// =============================================================================

// ----------------------------------------------------------------------------
// Constantes públicas del merchant verificado (Surtifamiliar).
// ----------------------------------------------------------------------------

/**
 * Datos legibles del comercio Bold/Bre-B. Son valores de PRESENTACIÓN:
 * aparecen en el modal como encabezado, subtítulo y pie, pero nunca se
 * usan como credenciales. El backend es la fuente de verdad de la
 * identidad del comercio al matar un pago.
 *
 * `codigoComercio` es el "Código de Comercio Bre-B" asignado al titular
 * verificado — es público (viaja en la factura y en el QR impreso).
 */
export const BOLD_MERCHANT = Object.freeze({
    businessName: "SUPERMERCADO SURTIFAMILIAR",
    titular: "Sebastian Sarmiento",
    codigoComercio: "",
    subheader: "Pago por QR o llave Daviplata · Titular: Sebastian Sarmiento",
    footer: "Titular: Sebastian Sarmiento · Daviplata",
});

/**
 * Cobro QR por DAVIPLATA (desde 2026-10-26; Bold se retiró por el 4×1000).
 * Los nombres `BOLD_QR_*` se conservan para no reescribir todo el flujo
 * asíncrono; el contenido visible es Daviplata.
 */
export const BOLD_QR_METHOD_LABEL = "QR / Llave Daviplata";

/** Badge auxiliar debajo del encabezado. */
export const BOLD_QR_METHOD_BADGE = "Escanea el QR o envía a la llave Daviplata desde cualquier banco (Bre-B)";

/**
 * Llave Bre-B de Daviplata que se muestra bajo el QR. Se completa con la que
 * aparece en el PDF del QR (vacía = no se muestra).
 */
export const DAVIPLATA_KEY = "";

/**
 * Imagen del QR de Daviplata en el bundle público (`public/qr-daviplata.png`).
 * Si falta, el modal muestra un error UX honesto, nunca un QR inventado.
 */
export const BOLD_QR_IMAGE_PATH = "/qr-daviplata.png";
export const BOLD_QR_MIN_SIDE_PX = 260;

/** Dimensión nativa del recorte QR-only, sin reescalado al generarlo. */
export const BOLD_QR_ASSET_SIDE_PX = 561;

/**
 * Tamaño mínimo CSS en pixeles para una lectura confiable del código.
 */
export const BOLD_QR_CSS_MIN = `${BOLD_QR_MIN_SIDE_PX}px`;

/**
 * Lado preferido del QR dentro del modal compacto. El archivo fuente mide
 * 561×561 y se reduce a un máximo de 320 px en pantalla; nunca se amplía,
 * por lo que los módulos conservan bordes definidos. El propio PNG incluye
 * una quiet zone blanca simétrica de 40 px alrededor de los módulos.
 */
export const BOLD_QR_PREFERRED_SIDE_PX = 320;

// ----------------------------------------------------------------------------
// Ciclo de vida de la intención.
// ----------------------------------------------------------------------------

/**
 * Estados aceptados para una intención PENDIENTE del lado del POS.
 *
 * Reglas clave (coherentes con el backend):
 *   - `PENDIENTE`: creada, expira a los 15 minutos.
 *   - `APROBADO`: match monto exacto (único pendiente de ese monto).
 *   - `UNMATCHED`: webhook llegó con un monto sin pendiente que coincida.
 *   - `AMBIGUOUS`: webhook llegó con monto que coincide con 2+ pendientes.
 *     El POS NO aprueba — el cajero decide manualmente.
 *   - `EXPIRADO`: pasaron 15 min sin webhook.
 *   - `CANCELADO`: el cajero canceló la intención (botón Cancelar/Cambiar).
 *   - `ERROR`: fallo transitorio del backend o del stream.
 */
export const BOLD_QR_STATUS = Object.freeze({
    PENDIENTE: "PENDIENTE",
    APROBADO: "APROBADO",
    UNMATCHED: "UNMATCHED",
    AMBIGUOUS: "AMBIGUOUS",
    EXPIRADO: "EXPIRADO",
    CANCELADO: "CANCELADO",
    ERROR: "ERROR",
});

/** Expiración por contrato de la intención (15 minutos — flujo asíncrono migración 027). */
export const BOLD_QR_INTENT_TTL_MS = 15 * 60 * 1000;

/**
 * Decide si una intención con `createdAt` ya expiró. Determinista: toma
 * el reloj como parámetro para que los tests fijen el tiempo. Entradas
 * inválidas devuelven `true` (es decir, se trata como expirada) para
 * forzar al cajero a reiniciar — nunca se asume vigencia cuando el dato
 * es basura. TTL por contrato: 15 min (ver `BOLD_QR_INTENT_TTL_MS`).
 *
 * @param {number | Date | string | null | undefined} createdAt
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isIntentExpired(createdAt, nowMs) {
    const startMs = toMillis(createdAt);
    if (startMs === null) return true;
    if (!Number.isFinite(nowMs)) return true;
    return (nowMs - startMs) >= BOLD_QR_INTENT_TTL_MS;
}

/**
 * Milisegundos restantes antes de que una intención expire. Devuelve 0
 * cuando ya expiró o cuando los datos son inválidos (nunca devuelve
 * negativo ni NaN). Útil para pintar el countdown y el barómetro.
 *
 * @param {number | Date | string | null | undefined} createdAt
 * @param {number} nowMs
 * @returns {number}
 */
export function msUntilExpiry(createdAt, nowMs) {
    const startMs = toMillis(createdAt);
    if (startMs === null || !Number.isFinite(nowMs)) return 0;
    const delta = BOLD_QR_INTENT_TTL_MS - (nowMs - startMs);
    return delta > 0 ? delta : 0;
}

/**
 * Convierte milisegundos a `MM:SS` con dos dígitos cada campo. 0 ms
 * devuelve "00:00". Valores inválidos devuelven "--:--" como señal
 * honesta de "sin reloj" (nunca "NaN:NaN").
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatCountdown(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "--:--";
    const totalSeconds = Math.floor(ms / 1000);
    const mm = Math.floor(totalSeconds / 60);
    const ss = totalSeconds % 60;
    return `${pad2(mm)}:${pad2(ss)}`;
}

// ----------------------------------------------------------------------------
// Extracción de monto COP desde texto crudo del bridge.
// ----------------------------------------------------------------------------

/**
 * Extrae el monto COP de un mensaje de notificación Bold capturado por
 * MacroDroid. El texto llega sin estructura ("Recibiste $45.800", a veces
 * "Recibiste $1.234.567,00 COP de PEPE"); la extracción:
 *
 *   1. Busca el primer bloque con `$` seguido de dígitos (opcional
 *      separador de miles `.` o `,` y opcional centavos `,00` o `.00`).
 *   2. Normaliza removiendo separadores de miles (`.` o `,` cuando van
 *      cada 3 dígitos) y descartando centavos.
 *   3. Devuelve el entero COP (int64 en el payload backend).
 *   4. Si no encuentra nada o el valor es irreal (`<=0`), devuelve `null`.
 *
 * Reglas duras:
 *   - Nunca inventa un monto si no lo encuentra.
 *   - Nunca propaga centavos: Bold expone COP enteros.
 *   - Nunca lanza: entradas no-string devuelven `null`.
 *
 * @param {unknown} mensaje
 * @returns {number | null} monto COP o null si no se pudo extraer
 */
export function extractCOPFromMessage(mensaje) {
    if (typeof mensaje !== "string") return null;
    const text = mensaje.trim();
    if (!text) return null;

    // Regex: $ opcional, bloque de dígitos con separadores de miles
    // (`,` o `.`) y centavos opcionales (`.XX` o `,XX`). Se exigen 1 a 3
    // dígitos antes del primer separador para forzar que capturemos el
    // número completo (`45.800` ↦ 45800, `1.234.567` ↦ 1234567).
    const re = /\$\s*(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/;
    const m = text.match(re);
    if (!m) return null;
    return parseCOPToken(m[1]);
}

/**
 * Parser directo del token numérico (sin `$`). Expuesto como helper
 * independiente por si el bridge envía ya el monto limpio.
 *
 * Reglas:
 *   - `45.800`  → 45800   (separador de miles `.`)
 *   - `45,800`  → 45800   (separador de miles `,`)
 *   - `1.234.567,00` → 1234567 (centavos descartados)
 *   - `1,234,567.00` → 1234567
 *   - `12`      → 12
 *   - `12,34`   → 12      (centavos con 2 decimales descartados — el COP
 *                           no tiene centavos operativos en Bold)
 *   - `-100`, `0`, `abc`, undefined → null
 *
 * @param {unknown} token
 * @returns {number | null}
 */
export function parseCOPToken(token) {
    if (typeof token !== "string") return null;
    const s = token.trim();
    if (!s) return null;

    // Descartar centavos. Si hay un separador decimal al final (`.XX` o
    // `,XX`) con 1 o 2 dígitos, lo removemos. El resto son separadores
    // de miles.
    //
    // Heurística:
    //   - Si hay un separador seguido de EXACTAMENTE 1-2 dígitos al final
    //     Y antes hay al menos otro separador o 4+ dígitos, es decimal.
    //   - Si todos los separadores dividen el número en grupos de 3
    //     dígitos consistentes, todos son de miles.
    const parts = s.split(/[.,]/);
    let integerDigits;
    if (parts.length === 1) {
        integerDigits = parts[0];
    } else {
        const last = parts[parts.length - 1];
        const everyGroupIsThree = parts.slice(1).every((p) => p.length === 3);
        if (everyGroupIsThree) {
            // Todos son miles: `1.234.567` ↦ 1234567.
            integerDigits = parts.join("");
        } else if (last.length <= 2) {
            // Último grupo es decimal (centavos). Resto son miles.
            integerDigits = parts.slice(0, -1).join("");
        } else {
            // Formato inconsistente: devolvemos null para no inventar.
            return null;
        }
    }

    if (!/^\d+$/.test(integerDigits)) return null;
    const n = parseInt(integerDigits, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

// ----------------------------------------------------------------------------
// Decisiones del lado del cliente para el flujo de UX.
// ----------------------------------------------------------------------------

/**
 * Clasifica cómo debe reaccionar la UI ante un evento del stream SSE.
 * Trabaja sobre valores ya decodificados (status + opcional detalle).
 * Nunca lanza: entradas desconocidas regresan `{ action: "ignore" }`.
 *
 *   - `APROBADO`                 → `{ action: "approve" }`
 *   - `UNMATCHED` / `AMBIGUOUS`  → `{ action: "require-manual", reason }`
 *   - `EXPIRADO`                 → `{ action: "expire" }`
 *   - `CANCELADO`                → `{ action: "cancel" }`
 *   - `ERROR`                    → `{ action: "error", reason }`
 *   - `PENDIENTE`                → `{ action: "wait" }`
 *   - cualquier otra cosa        → `{ action: "ignore" }`
 *
 * @param {{ status?: unknown; reason?: unknown } | null | undefined} event
 * @returns {{ action: "approve" | "require-manual" | "expire" | "cancel" | "error" | "wait" | "ignore"; reason?: string }}
 */
export function classifyStreamEvent(event) {
    if (!event || typeof event !== "object") return { action: "ignore" };
    const raw = /** @type {any} */ (event).status;
    const status = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    const reasonRaw = /** @type {any} */ (event).reason;
    const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;

    switch (status) {
        case BOLD_QR_STATUS.APROBADO:
            return { action: "approve" };
        case BOLD_QR_STATUS.UNMATCHED:
        case BOLD_QR_STATUS.AMBIGUOUS:
            return { action: "require-manual", reason: reason || status };
        case BOLD_QR_STATUS.EXPIRADO:
            return { action: "expire" };
        case BOLD_QR_STATUS.CANCELADO:
            return { action: "cancel" };
        case BOLD_QR_STATUS.ERROR:
            return { action: "error", reason };
        case BOLD_QR_STATUS.PENDIENTE:
            return { action: "wait" };
        default:
            return { action: "ignore" };
    }
}

/**
 * Shape que acepta `POST /api/pos/pagos-qr/iniciar`. Documentado como
 * builder puro para que el modal no se enrede en typos (`caja_id` vs
 * `cajaId`). El backend espera snake_case por contrato: lo respetamos
 * exactamente.
 *
 * `monto` SIEMPRE se castea a entero positivo y rechaza negativos / NaN
 * devolviendo `null` como contrato de "input inválido".
 *
 * **Flujo asíncrono (migración 027 — snapshot durable al abrir el QR):**
 * el padre `/sales/new/page.tsx` pre-registra el snapshot del carrito
 * ANTES de que el cajero vea el QR, para que una aprobación "silenciosa"
 * del webhook MacroDroid pueda materializar la venta aunque el cajero
 * nunca haya pulsado "DEJAR EN ESPERA Y SEGUIR ATENDIENDO". Por eso
 * `buildIniciarPayload` acepta —opcionalmente— los campos extra que ya
 * conoce `/encolar`:
 *
 *   - `client_tx_id` (string de 8..64 chars, mismo generator que
 *     `generateQrClientTxId`): identificador único de la transacción;
 *     el backend lo reutiliza entre `/iniciar` y `/encolar` para
 *     garantizar idempotencia end-to-end.
 *   - `client_dni` (string): DNI del cliente seleccionado (vacío si
 *     CONSUMIDOR FINAL). Permite al backend adjuntar el cliente a la
 *     venta canónica tras la aprobación.
 *   - `cashier_name` (string): nombre del cajero actual. Útil para la
 *     bandeja global del supervisor.
 *   - `sale_payload` (objeto): shape idéntico al `sale_payload` de
 *     `/encolar` — ver `buildEncolarPayload`. Debe traer al menos
 *     `details[]` con `barcode`, `quantity > 0` y `unitPrice >= 0`.
 *
 * **Compatibilidad hacia atrás**: la llamada ligera del modal al
 * montar (sólo `caja_id`, `monto`, `venta_temp_id`) sigue produciendo
 * un payload válido. El backend reutiliza (reused=true) la intención
 * pre-registrada por el padre sin regenerar identificadores.
 *
 * Si cualquiera de los campos opcionales viene presente pero inválido,
 * se devuelve `null` para no enviar un payload corrupto al backend
 * (contrato de "nunca inventar"). Omitirlos por completo mantiene el
 * comportamiento legacy.
 *
 * @param {{
 *   caja_id: string | number;
 *   monto: number;
 *   venta_temp_id: string;
 *   client_tx_id?: string;
 *   client_dni?: string;
 *   cashier_name?: string;
 *   sale_payload?: object;
 *   edit_sale_id?: number;
 * }} args
 * @returns {object | null}
 */
export function buildIniciarPayload({
    caja_id,
    monto,
    venta_temp_id,
    client_tx_id,
    client_dni,
    cashier_name,
    sale_payload,
    edit_sale_id,
} = {}) {
    const normalizedMonto = typeof monto === "number" && Number.isFinite(monto)
        ? Math.floor(monto)
        : NaN;
    if (!Number.isFinite(normalizedMonto) || normalizedMonto <= 0) return null;
    if (caja_id === undefined || caja_id === null || caja_id === "") return null;
    if (typeof venta_temp_id !== "string" || venta_temp_id.trim() === "") return null;

    const out = {
        caja_id,
        monto: normalizedMonto,
        venta_temp_id: venta_temp_id.trim(),
    };

    // --- Campos opcionales de snapshot durable ---
    // Reglas: si el llamador los omite completamente, el payload queda
    // ligero (back-compat para la llamada del modal al montar). Si los
    // envía parcialmente mal, devolvemos null para no corromper el
    // backend.
    if (client_tx_id !== undefined && client_tx_id !== null && client_tx_id !== "") {
        if (typeof client_tx_id !== "string") return null;
        const txId = client_tx_id.trim();
        if (txId.length < 8 || txId.length > 64) return null;
        out.client_tx_id = txId;
    }
    if (client_dni !== undefined && client_dni !== null && client_dni !== "") {
        if (typeof client_dni !== "string") return null;
        out.client_dni = client_dni.trim();
    }
    if (cashier_name !== undefined && cashier_name !== null && cashier_name !== "") {
        if (typeof cashier_name !== "string") return null;
        out.cashier_name = cashier_name.trim();
    }
    if (sale_payload !== undefined && sale_payload !== null) {
        if (typeof sale_payload !== "object" || Array.isArray(sale_payload)) return null;
        const details = /** @type {any} */ (sale_payload).details;
        if (!Array.isArray(details) || details.length === 0) return null;
        for (const d of details) {
            if (!d || typeof d !== "object") return null;
            const barcode = typeof d.barcode === "string" ? d.barcode.trim() : "";
            if (!barcode) return null;
            const qty = typeof d.quantity === "number" ? d.quantity : NaN;
            if (!Number.isFinite(qty) || qty <= 0) return null;
            const up = typeof d.unitPrice === "number" ? d.unitPrice : NaN;
            if (!Number.isFinite(up) || up < 0) return null;
        }
        out.sale_payload = sale_payload;
    }
    // edit_sale_id: entero positivo opcional. Si viene, el backend
    // interpreta este /iniciar como edición de la venta canónica
    // existente (en vez de crear una nueva). Nunca inventamos: cualquier
    // valor no entero > 0 se descarta y el payload sale sin el campo.
    if (edit_sale_id !== undefined && edit_sale_id !== null) {
        let normalizedEdit = NaN;
        if (typeof edit_sale_id === "number" && Number.isFinite(edit_sale_id) && Number.isInteger(edit_sale_id) && edit_sale_id > 0) {
            normalizedEdit = edit_sale_id;
        } else if (typeof edit_sale_id === "string" && /^[1-9]\d*$/.test(edit_sale_id.trim())) {
            const parsed = Number.parseInt(edit_sale_id.trim(), 10);
            if (Number.isFinite(parsed) && parsed > 0) normalizedEdit = parsed;
        }
        if (Number.isFinite(normalizedEdit)) {
            out.edit_sale_id = normalizedEdit;
        }
    }
    return out;
}

// ----------------------------------------------------------------------------
// Helpers privados
// ----------------------------------------------------------------------------

function pad2(n) {
    const v = String(Math.floor(n));
    return v.length >= 2 ? v : "0" + v;
}

function toMillis(value) {
    if (value instanceof Date) {
        const t = value.getTime();
        return Number.isNaN(t) ? null : t;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const t = Date.parse(trimmed);
        return Number.isNaN(t) ? null : t;
    }
    return null;
}



// =============================================================================
// Flujo asíncrono: bandeja global + encolado (migración 027)
// =============================================================================

/**
 * Nombre del evento SSE emitido por el canal /api/pos/pagos-qr/caja-stream.
 * Un cambio aquí rompe el parseo de `useBoldQrTray.ts`.
 */
export const BOLD_QR_TRAY_EVENT = "qr_tray_update";

/**
 * Enum cerrado del campo `kind` del QRTrayEvent. Deben empatar literalmente
 * con `QRTrayKind*` del backend (`models/pos_qr_payment.go`).
 */
export const BOLD_QR_TRAY_KIND = Object.freeze({
    ENQUEUED: "ENQUEUED",
    APPROVED: "APPROVED",
    AMBIGUOUS: "AMBIGUOUS",
    UNMATCHED: "UNMATCHED",
    EXPIRED: "EXPIRED",
    CANCELLED: "CANCELLED",
    ERROR: "ERROR",
});

const VALID_TRAY_KINDS = new Set(Object.values(BOLD_QR_TRAY_KIND));

/**
 * classifyTrayEvent valida y normaliza un evento recibido por la bandeja.
 * Devuelve `null` si el payload es malformado (defensa en profundidad: la
 * UI no debería renderizar un kind desconocido).
 *
 * @param {unknown} raw
 * @returns {{
 *   kind: string,
 *   ventaTempId: string,
 *   intentId?: number,
 *   cajaId?: string,
 *   amountCop?: number,
 *   saleId?: number,
 *   reference?: string,
 *   approvedAt?: string,
 *   approvedVia?: string,
 *   reason?: string,
 *   cashierName?: string,
 *   occurredAt?: string,
 * } | null}
 */
export function classifyTrayEvent(raw) {
    if (!raw || typeof raw !== "object") return null;
    const kind = typeof raw.kind === "string" ? raw.kind.trim().toUpperCase() : "";
    if (!VALID_TRAY_KINDS.has(kind)) return null;
    const ventaTempId = typeof raw.ventaTempId === "string" ? raw.ventaTempId.trim() : "";
    if (!ventaTempId) return null;
    const out = { kind, ventaTempId };
    if (typeof raw.intentId === "number" && Number.isFinite(raw.intentId)) {
        out.intentId = raw.intentId;
    } else if (typeof raw.intentId === "string" && raw.intentId.trim()) {
        const n = Number(raw.intentId);
        if (Number.isFinite(n)) out.intentId = n;
    }
    if (typeof raw.cajaId === "string" && raw.cajaId.trim()) {
        out.cajaId = raw.cajaId.trim();
    }
    if (typeof raw.amountCop === "number" && Number.isFinite(raw.amountCop) && raw.amountCop > 0) {
        out.amountCop = raw.amountCop;
    }
    if (typeof raw.saleId === "number" && Number.isFinite(raw.saleId) && raw.saleId > 0) {
        out.saleId = raw.saleId;
    } else if (typeof raw.saleId === "string" && raw.saleId.trim()) {
        const n = Number(raw.saleId);
        if (Number.isFinite(n) && n > 0) out.saleId = n;
    }
    for (const k of ["reference", "approvedAt", "approvedVia", "reason", "cashierName", "occurredAt"]) {
        if (typeof raw[k] === "string" && raw[k].trim()) {
            out[k] = raw[k].trim();
        }
    }
    return out;
}

/**
 * buildEncolarPayload construye el body del POST /api/pos/pagos-qr/encolar.
 * Devuelve `null` si cualquier validación falla (la UI muestra toast y
 * NO toca el carrito).
 *
 * Validaciones:
 *   - venta_temp_id string no vacío
 *   - caja_id presente (lo trim())
 *   - monto entero > 0
 *   - client_tx_id longitud 8..64 (empata con backend/CHECK 027)
 *   - sale_payload.details array no vacío, cada item con
 *     barcode(string), quantity(>0), unitPrice(>=0)
 *
 * @returns {object|null}
 */
export function buildEncolarPayload(input) {
    if (!input || typeof input !== "object") return null;
    const ventaTempId = typeof input.ventaTempId === "string" ? input.ventaTempId.trim() : "";
    if (ventaTempId.length < 8) return null;
    const cajaIdRaw = input.cajaId;
    const cajaId =
        typeof cajaIdRaw === "number" && Number.isFinite(cajaIdRaw)
            ? String(cajaIdRaw)
            : typeof cajaIdRaw === "string"
            ? cajaIdRaw.trim()
            : "";
    if (!cajaId) return null;
    const montoRaw = input.monto;
    const monto = typeof montoRaw === "number" ? Math.round(montoRaw) : NaN;
    if (!Number.isFinite(monto) || monto <= 0) return null;
    const clientTxId = typeof input.clientTxId === "string" ? input.clientTxId.trim() : "";
    if (clientTxId.length < 8 || clientTxId.length > 64) return null;
    const cashierName = typeof input.cashierName === "string" ? input.cashierName.trim() : "";
    const clientDni = typeof input.clientDni === "string" ? input.clientDni.trim() : "";
    const salePayload = input.salePayload;
    if (!salePayload || typeof salePayload !== "object") return null;
    const details = salePayload.details;
    if (!Array.isArray(details) || details.length === 0) return null;
    for (const d of details) {
        if (!d || typeof d !== "object") return null;
        const barcode = typeof d.barcode === "string" ? d.barcode.trim() : "";
        if (!barcode) return null;
        const qty = typeof d.quantity === "number" ? d.quantity : NaN;
        if (!Number.isFinite(qty) || qty <= 0) return null;
        const up = typeof d.unitPrice === "number" ? d.unitPrice : NaN;
        if (!Number.isFinite(up) || up < 0) return null;
    }
    const out = {
        venta_temp_id: ventaTempId,
        caja_id: cajaId,
        monto,
        client_tx_id: clientTxId,
        client_dni: clientDni,
        cashier_name: cashierName,
        sale_payload: salePayload,
    };
    // edit_sale_id opcional, mismo contrato que /iniciar.
    const editIdRaw = input.editSaleId;
    if (editIdRaw !== undefined && editIdRaw !== null) {
        let normalizedEdit = NaN;
        if (typeof editIdRaw === "number" && Number.isFinite(editIdRaw) && Number.isInteger(editIdRaw) && editIdRaw > 0) {
            normalizedEdit = editIdRaw;
        } else if (typeof editIdRaw === "string" && /^[1-9]\d*$/.test(editIdRaw.trim())) {
            const parsed = Number.parseInt(editIdRaw.trim(), 10);
            if (Number.isFinite(parsed) && parsed > 0) normalizedEdit = parsed;
        }
        if (Number.isFinite(normalizedEdit)) {
            out.edit_sale_id = normalizedEdit;
        }
    }
    return out;
}

/**
 * generateQrClientTxId construye un identificador de 24..40 chars.
 * Mismo generador que handleConfirmSale usa en useNewSale, para que
 * el backend aplique su UNIQUE partial sobre sales."clientTxId" sin
 * cambiar la forma.
 */
export function generateQrClientTxId() {
    const rand =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID().replace(/-/g, "").slice(0, 24)
            : Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    return `qrtx_${Date.now()}_${rand}`;
}


// =============================================================================
// Pagos QR SIN ASIGNAR (migración 027b — bandeja de desambiguación)
//
// Cuando MacroDroid reenvía por SMS un pago cuyo monto no empata con
// NINGÚN pendiente (`UNMATCHED`) o empata con VARIOS (`AMBIGUOUS`), el
// backend registra el pago sin aprobar y lo expone en
// `GET /api/pos/pagos-qr/pagos-sin-asignar?minutos=30`. El cajero puede
// decidir manualmente a qué intención pendiente asignarlo vía
// `POST /api/pos/pagos-qr/asignar { venta_temp_id, event_id }` siempre
// que los MONTOS COINCIDAN (defensa dura del backend, 409 QR_AMOUNT_MISMATCH).
//
// Reglas duras del módulo:
//   - `classifyUnassignedPayment` nunca inventa: entradas inválidas → null.
//   - `canAssignToPending` compara enteros tras `Math.round` para resistir
//     ventanas de redondeo (ambos amountCop vienen del backend como int64,
//     pero toleramos un paso de normalización defensivo).
//   - `extractAssignErrorCode` lee las variantes conocidas del contrato
//     (`err.code`, `err.body.code`, `err.data?.code`,
//     `err.response?.data?.code`) y, si no encuentra, cae a `null` —
//     el llamador debe entonces mostrar el mensaje genérico.
// =============================================================================

/**
 * Códigos canónicos del contrato backend al asignar un pago. Mapeos
 * documentados por el equipo backend; el frontend sólo renderiza copy.
 */
export const BOLD_QR_ASSIGN_ERROR_CODE = Object.freeze({
    EVENT_ALREADY_ASSIGNED: "QR_EVENT_ALREADY_ASSIGNED",
    AMOUNT_MISMATCH: "QR_AMOUNT_MISMATCH",
    INTENT_ALREADY_TERMINAL: "QR_INTENT_ALREADY_TERMINAL",
    EVENT_NOT_FOUND: "QR_EVENT_NOT_FOUND",
    INTENT_NOT_FOUND: "QR_INTENT_NOT_FOUND",
    // Nuevo (migración 027c — ventana de asignación 24 h):
    // El backend puede rechazar la asignación cuando el evento quedó
    // fuera de la ventana permitida para el rol del actor. En cajeros
    // se usa típicamente 60 min; admin puede llegar hasta 24 h. El UI
    // debe pedir al cajero que escale al administrador.
    EVENT_TOO_OLD: "QR_EVENT_TOO_OLD",
    FORBIDDEN_FOR_ROLE: "QR_FORBIDDEN_FOR_ROLE",
});

const VALID_UNASSIGNED_STATUSES = new Set(["AMBIGUOUS", "UNMATCHED"]);

/**
 * Normaliza un item devuelto por GET /pagos-sin-asignar. Devuelve `null`
 * si cualquier campo requerido falta o es inválido.
 *
 * Shape esperado del backend:
 *   {
 *     eventId: number,
 *     amountCop: number,
 *     receivedAt: string (ISO 8601),
 *     status: "AMBIGUOUS" | "UNMATCHED",
 *     resumen: string
 *   }
 *
 * @param {unknown} raw
 * @returns {{
 *   eventId: number,
 *   amountCop: number,
 *   receivedAt: string,
 *   status: "AMBIGUOUS" | "UNMATCHED",
 *   resumen: string,
 * } | null}
 */
export function classifyUnassignedPayment(raw) {
    if (!raw || typeof raw !== "object") return null;
    const eventIdRaw = /** @type {any} */ (raw).eventId;
    const eventId = typeof eventIdRaw === "number" && Number.isFinite(eventIdRaw) && eventIdRaw > 0
        ? Math.floor(eventIdRaw)
        : typeof eventIdRaw === "string" && /^[1-9]\d*$/.test(eventIdRaw.trim())
            ? parseInt(eventIdRaw.trim(), 10)
            : NaN;
    if (!Number.isFinite(eventId) || eventId <= 0) return null;
    const amountRaw = /** @type {any} */ (raw).amountCop;
    const amountCop = typeof amountRaw === "number" && Number.isFinite(amountRaw) && amountRaw > 0
        ? Math.round(amountRaw)
        : NaN;
    if (!Number.isFinite(amountCop) || amountCop <= 0) return null;
    const receivedAtRaw = /** @type {any} */ (raw).receivedAt;
    const receivedAt = typeof receivedAtRaw === "string" ? receivedAtRaw.trim() : "";
    if (!receivedAt) return null;
    const statusRaw = /** @type {any} */ (raw).status;
    const status = typeof statusRaw === "string" ? statusRaw.trim().toUpperCase() : "";
    if (!VALID_UNASSIGNED_STATUSES.has(status)) return null;
    const resumenRaw = /** @type {any} */ (raw).resumen;
    const resumen = typeof resumenRaw === "string" ? resumenRaw.trim() : "";
    return {
        eventId,
        amountCop,
        receivedAt,
        status: /** @type {"AMBIGUOUS" | "UNMATCHED"} */ (status),
        resumen,
    };
}

/**
 * Decide si un pago sin asignar y un pending pueden ser emparejados
 * manualmente. Compara enteros tras `Math.round` para defender contra
 * ventanas de redondeo. NUNCA inventa (si cualquiera de los dos montos
 * no es un entero positivo, devuelve false).
 *
 * El backend hace la validación final (409 QR_AMOUNT_MISMATCH); este
 * helper es sólo UX — sirve para decidir si pintar el botón "Asignar
 * a este cobro" en la bandeja.
 *
 * @param {{ amountCop?: unknown } | null | undefined} unassigned
 * @param {{ amountCop?: unknown } | null | undefined} pending
 * @returns {boolean}
 */
export function canAssignToPending(unassigned, pending) {
    if (!unassigned || !pending) return false;
    const a = /** @type {any} */ (unassigned).amountCop;
    const b = /** @type {any} */ (pending).amountCop;
    const na = typeof a === "number" && Number.isFinite(a) && a > 0 ? Math.round(a) : NaN;
    const nb = typeof b === "number" && Number.isFinite(b) && b > 0 ? Math.round(b) : NaN;
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
    return na === nb;
}

/**
 * Construye el body del POST /pos/pagos-qr/asignar. Devuelve `null` si
 * cualquier campo es inválido (defensa dura: el frontend NO llama al
 * backend con payload malformado).
 *
 * @param {{ venta_temp_id?: unknown; event_id?: unknown }} args
 * @returns {{ venta_temp_id: string; event_id: number } | null}
 */
export function buildAsignarPayload(args) {
    if (!args || typeof args !== "object") return null;
    const vt = /** @type {any} */ (args).venta_temp_id;
    const ventaTempId = typeof vt === "string" ? vt.trim() : "";
    if (!ventaTempId) return null;
    const ev = /** @type {any} */ (args).event_id;
    const eventId = typeof ev === "number" && Number.isFinite(ev) && ev > 0
        ? Math.floor(ev)
        : typeof ev === "string" && /^[1-9]\d*$/.test(ev.trim())
            ? parseInt(ev.trim(), 10)
            : NaN;
    if (!Number.isFinite(eventId) || eventId <= 0) return null;
    return { venta_temp_id: ventaTempId, event_id: eventId };
}

/**
 * Extrae el `code` canónico de un error de asignación. Lee las variantes
 * conocidas del shape que lanza `apiFetch`/`ApiError`. Si no encuentra
 * un código válido en la lista blanca, devuelve `null`.
 *
 * @param {unknown} err
 * @returns {string | null}
 */
export function extractAssignErrorCode(err) {
    if (!err || typeof err !== "object") return null;
    const candidates = [
        /** @type {any} */ (err).code,
        /** @type {any} */ (err).body?.code,
        /** @type {any} */ (err).data?.code,
        /** @type {any} */ (err).response?.data?.code,
        /** @type {any} */ (err).payload?.code,
    ];
    for (const c of candidates) {
        if (typeof c === "string" && c.trim()) {
            const normalized = c.trim();
            if (Object.values(BOLD_QR_ASSIGN_ERROR_CODE).includes(normalized)) {
                return normalized;
            }
            // Case-insensitive defensive match
            const upper = normalized.toUpperCase();
            if (Object.values(BOLD_QR_ASSIGN_ERROR_CODE).includes(upper)) {
                return upper;
            }
        }
    }
    return null;
}

/**
 * Mapea un `code` del contrato de asignación a un mensaje legible en
 * español colombiano. Devuelve un fallback honesto para codes
 * desconocidos (nunca inventa semántica).
 *
 * @param {string | null | undefined} code
 * @returns {string}
 */
export function describeAssignErrorCode(code) {
    switch (code) {
        case BOLD_QR_ASSIGN_ERROR_CODE.EVENT_ALREADY_ASSIGNED:
            return "Ese pago ya fue asignado a otra venta. Refresca la bandeja.";
        case BOLD_QR_ASSIGN_ERROR_CODE.AMOUNT_MISMATCH:
            return "El monto del pago no coincide con el cobro seleccionado.";
        case BOLD_QR_ASSIGN_ERROR_CODE.INTENT_ALREADY_TERMINAL:
            return "El cobro ya quedó cerrado por otro canal (aprobado o cancelado).";
        case BOLD_QR_ASSIGN_ERROR_CODE.EVENT_NOT_FOUND:
            return "El pago ya no existe en el servidor. Refresca la bandeja.";
        case BOLD_QR_ASSIGN_ERROR_CODE.INTENT_NOT_FOUND:
            return "El cobro pendiente ya no existe. Refresca la bandeja.";
        case BOLD_QR_ASSIGN_ERROR_CODE.EVENT_TOO_OLD:
            return "Este pago quedó fuera de la ventana permitida para tu rol. Pídele a un administrador que lo enlace.";
        case BOLD_QR_ASSIGN_ERROR_CODE.FORBIDDEN_FOR_ROLE:
            return "Tu rol no puede enlazar pagos tan antiguos. Pídele a un administrador.";
        default:
            return "No se pudo asignar el pago. Intenta nuevamente.";
    }
}



// =============================================================================
// Flujo "venta ya pagada" (defensa anti-reapertura, bug 2026-10-23)
//
// Síntoma reproducido en producción:
//   1. El cajero cobra $100 por QR Bold → el backend materializa la venta y
//      emite APROBADO (saleId > 0). La bandeja global marca el pending
//      como pagado y la pantalla cierra el modal.
//   2. El cajero abre el cobro de OTRA factura. El `UniversalPaymentModal`
//      consume el nonce `boldQrRequestId` pendiente (que seguía > 0) y
//      reabre el QR del pending anterior con el MISMO `ventaTempId`.
//   3. `/pos/pagos-qr/iniciar` responde 200 con `alreadyPaid=true` porque
//      la intención ya fue aprobada; `/pos/pagos-qr/encolar` responde 409
//      con `code=QR_INTENT_ALREADY_PAID`.
//   4. El frontend ignoraba esos marcadores y re-abría el QR, dejando una
//      nueva intención en estado PENDIENTE para la factura equivocada.
//
// Reglas del parche (fijadas por tests):
//   * El QR se abre SOLO con un click explícito en "QR Bold" o un
//     "Reabrir QR" explícito desde la bandeja; abrir el modal de pago
//     nunca abre el QR por sí solo.
//   * Si `/iniciar` devuelve `alreadyPaid=true` o describe la intención
//     como `APROBADA/APROBADO`, el frontend trata el cobro como ya
//     finalizado: cierra el UPM, limpia el reopen payload y marca el
//     ventaTempId como pagado para que la bandeja no muestre el pending.
//   * Si `/encolar` responde 409 QR_INTENT_ALREADY_PAID, se trata como
//     finalizado (NO como error ruidoso), y nunca se abre el QR.
//
// Los helpers de este bloque son puros: validan el shape, trimean los
// campos, nunca inventan. La política UX la decide el padre
// (`sales/new/page.tsx`).
// =============================================================================

/** Sentinela que el padre lanza para pedir al UPM "abortar la apertura del QR sin UX de error". */
export const BOLD_QR_ALREADY_PAID_SENTINEL = "__bold_qr_already_paid__";

/**
 * Código canónico del contrato backend cuando `/pos/pagos-qr/encolar`
 * detecta que la intención ya fue aprobada (409 Conflict). Mapeo
 * documentado por el equipo backend; el frontend sólo lo lee.
 */
export const BOLD_QR_ALREADY_PAID_ERROR_CODE = "QR_INTENT_ALREADY_PAID";

/** Prefijo de las claves de sessionStorage que marcan ventas QR pagadas. */
export const BOLD_QR_PAID_SESSION_PREFIX = "bold-qr-paid:";

const _ALREADY_PAID_STATUSES = new Set(["APROBADA", "APROBADO"]);

function _normalizePositiveInteger(raw) {
    if (typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw) && raw > 0) {
        return raw;
    }
    if (typeof raw === "string" && /^[1-9]\d*$/.test(raw.trim())) {
        const parsed = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return undefined;
}

/**
 * Analiza una respuesta 2xx de `/pos/pagos-qr/iniciar` y devuelve
 * `{saleId?, amountCop?}` cuando el backend indica que la intención ya
 * estaba pagada. Devuelve `null` cuando la respuesta sigue viva (no
 * aplica la rama "alreadyPaid").
 *
 * Reglas:
 *   - `alreadyPaid === true` fuerza la detección (prioridad).
 *   - `status` o `streamStatus` ∈ {APROBADA, APROBADO} también activa
 *     la detección (defensa: algunos backends emiten alreadyPaid en el
 *     cuerpo del status terminal sin el flag explícito).
 *   - `saleId` y `amountCop` son opcionales: pueden faltar si el backend
 *     histórico no los expone. Nunca se inventan.
 *
 * @param {unknown} res
 * @returns {{ saleId?: number; amountCop?: number } | null}
 */
export function isAlreadyPaidResponse(res) {
    if (!res || typeof res !== "object") return null;
    const bag = /** @type {any} */ (res);
    const flag = bag.alreadyPaid === true;
    const status = typeof bag.status === "string" ? bag.status.trim().toUpperCase() : "";
    const streamStatus = typeof bag.streamStatus === "string" ? bag.streamStatus.trim().toUpperCase() : "";
    const terminalStatus = _ALREADY_PAID_STATUSES.has(status) || _ALREADY_PAID_STATUSES.has(streamStatus);
    if (!flag && !terminalStatus) return null;
    const saleId = _normalizePositiveInteger(bag.saleId);
    const amountCopRaw = bag.amountCop;
    const amountCop = typeof amountCopRaw === "number" && Number.isFinite(amountCopRaw) && amountCopRaw > 0
        ? Math.round(amountCopRaw)
        : undefined;
    const out = {};
    if (saleId !== undefined) out.saleId = saleId;
    if (amountCop !== undefined) out.amountCop = amountCop;
    return out;
}

/**
 * Analiza un error (típicamente `ApiError` lanzado por `apiFetch`) y
 * devuelve `{saleId?, amountCop?}` cuando el backend respondió 409 con
 * code=QR_INTENT_ALREADY_PAID. Devuelve `null` si el error no cumple
 * ese contrato — el llamador debe propagar o traducir como error real.
 *
 * Reglas:
 *   - El status 409 es obligatorio.
 *   - El `code` se lee de las variantes documentadas del `ApiError.data`.
 *   - `saleId` y `amountCop` son opcionales.
 *
 * @param {unknown} err
 * @returns {{ saleId?: number; amountCop?: number } | null}
 */
export function extractAlreadyPaidErrorInfo(err) {
    if (!err || typeof err !== "object") return null;
    const bag = /** @type {any} */ (err);
    const status = typeof bag.status === "number" ? bag.status : undefined;
    if (status !== 409) return null;
    const candidates = [
        bag.code,
        bag.data?.code,
        bag.data?.error?.code,
        bag.body?.code,
        bag.response?.data?.code,
        bag.payload?.code,
    ];
    let matched = false;
    for (const c of candidates) {
        if (typeof c !== "string") continue;
        if (c.trim().toUpperCase() === BOLD_QR_ALREADY_PAID_ERROR_CODE) {
            matched = true;
            break;
        }
    }
    if (!matched) return null;
    const data = bag.data || {};
    const saleId = _normalizePositiveInteger(data.saleId ?? data.sale_id ?? bag.saleId);
    const amountRaw = data.amountCop ?? data.amount_cop ?? bag.amountCop;
    const amountCop = typeof amountRaw === "number" && Number.isFinite(amountRaw) && amountRaw > 0
        ? Math.round(amountRaw)
        : undefined;
    const out = {};
    if (saleId !== undefined) out.saleId = saleId;
    if (amountCop !== undefined) out.amountCop = amountCop;
    return out;
}

/**
 * `true` si el error coincide con el contrato 409 QR_INTENT_ALREADY_PAID.
 * Pensado para `catch` concisos. Equivalente a `extractAlreadyPaidErrorInfo(err) !== null`.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAlreadyPaidError(err) {
    return extractAlreadyPaidErrorInfo(err) !== null;
}

/**
 * Normaliza un ventaTempId para usarlo como key de sessionStorage.
 * Devuelve string vacío si la entrada no es válida.
 *
 * @param {unknown} ventaTempId
 * @returns {string}
 */
function _normalizeVentaTempId(ventaTempId) {
    if (typeof ventaTempId !== "string") return "";
    const trimmed = ventaTempId.trim();
    return trimmed;
}

/**
 * Marca un ventaTempId como pagado en el storage dado (sessionStorage o
 * cualquier objeto que implemente la API). Guarda `{saleId?, amountCop?, markedAt}`
 * como JSON. Idempotente: llamar dos veces con el mismo id no duplica
 * nada y conserva la primera marca.
 *
 * @param {Storage | null | undefined} storage
 * @param {string} ventaTempId
 * @param {{ saleId?: number; amountCop?: number; now?: number }} [info]
 * @returns {boolean} true si se escribió nueva marca, false si ya existía o si no se pudo guardar.
 */
export function markBoldQrPaidInStorage(storage, ventaTempId, info = {}) {
    const id = _normalizeVentaTempId(ventaTempId);
    if (!id) return false;
    if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
        return false;
    }
    const key = BOLD_QR_PAID_SESSION_PREFIX + id;
    try {
        if (storage.getItem(key)) return false;
        const payload = {
            markedAt: typeof info.now === "number" && Number.isFinite(info.now) ? info.now : Date.now(),
        };
        if (info.saleId !== undefined) {
            const sid = _normalizePositiveInteger(info.saleId);
            if (sid !== undefined) payload.saleId = sid;
        }
        if (info.amountCop !== undefined) {
            const amt = typeof info.amountCop === "number" && Number.isFinite(info.amountCop) && info.amountCop > 0
                ? Math.round(info.amountCop)
                : undefined;
            if (amt !== undefined) payload.amountCop = amt;
        }
        storage.setItem(key, JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

/**
 * `true` si el ventaTempId quedó marcado como pagado en el storage.
 * Entradas inválidas → false (nunca lanza).
 *
 * @param {Storage | null | undefined} storage
 * @param {unknown} ventaTempId
 * @returns {boolean}
 */
export function isBoldQrPaidInStorage(storage, ventaTempId) {
    const id = _normalizeVentaTempId(ventaTempId);
    if (!id) return false;
    if (!storage || typeof storage.getItem !== "function") return false;
    try {
        return !!storage.getItem(BOLD_QR_PAID_SESSION_PREFIX + id);
    } catch {
        return false;
    }
}

/**
 * Lista los ventaTempId marcados como pagados en el storage dado.
 * Para repoblar el Set en memoria al montar el hook (resistente a reloads).
 *
 * @param {Storage | null | undefined} storage
 * @returns {string[]}
 */
export function listBoldQrPaidKeys(storage) {
    if (!storage || typeof storage.getItem !== "function") return [];
    const prefix = BOLD_QR_PAID_SESSION_PREFIX;
    const out = [];
    try {
        // Preferir API de iteración si existe; fallback a `length` + `key()`.
        if (typeof storage.length === "number" && typeof storage.key === "function") {
            for (let i = 0; i < storage.length; i++) {
                const k = storage.key(i);
                if (typeof k === "string" && k.startsWith(prefix)) {
                    out.push(k.slice(prefix.length));
                }
            }
        } else if (storage && typeof storage === "object") {
            for (const k of Object.keys(storage)) {
                if (typeof k === "string" && k.startsWith(prefix)) {
                    out.push(k.slice(prefix.length));
                }
            }
        }
    } catch {
        return out;
    }
    return out;
}


// =============================================================================
// Snapshot QR + pago mixto (migración 027c)
//
// `buildQrSaleSnapshotPayload` construye el `salePayload` que viaja al
// backend como snapshot durable del carrito tanto en `/iniciar` como en
// `/encolar`. Es la pieza clave para el **pago mixto QR**: el cajero
// puede acumular efectivo/Nequi/Daviplata/fiado ANTES de abrir el QR y
// el QR cobra sólo el restante. El snapshot debe llevar TODO el
// desglose (no solo el monto del QR), para que la aprobación backend
// cierre la venta con los canales reales.
//
// Reglas duras:
//   - `totalAmount` es el total del CARRITO (suma de details), nunca el
//     monto del QR. Esto es la fuente de verdad financiera.
//   - `transferAmount` = `transferNequi + transferDaviplata + qrAmount`.
//     El backend ya desglosa Nequi y Daviplata por campo propio; la
//     porción QR se mete en el genérico (transferAmount - Nequi - Davi).
//   - `transferSource` es `"BOLD_QR"` cuando hay porción QR; cuando el
//     cajero cobró 100% por otros canales sin QR (caso imposible en
//     este snapshot, pero defensivo) devolvemos lo que el consumidor
//     pase.
//   - `paymentMethod` se compone concatenando los canales activos para
//     que la fila de ventas quede legible en el historial.
//   - `editSaleId` es opcional: cuando viene, el backend interpreta la
//     aprobación como UPDATE (actualiza la venta existente), no como
//     CREATE. Nunca inventamos: cualquier valor no entero > 0 se omite.
//
// La entrada `details` debe traer `barcode`, `quantity > 0` y
// `unitPrice >= 0` para cada línea. Si la validación falla, devolvemos
// `null` para que el llamador aborte sin tocar red.
//
// @typedef {{ barcode: string; quantity: number; unitPrice: number; costPrice?: number; subtotal?: number }} SnapshotDetail
// @typedef {{ cash?: number; nequi?: number; daviplata?: number; credit?: number; totalCart?: number }} MixedBreakdown
//
// @param {{
//   details: SnapshotDetail[];
//   qrAmount: number;
//   breakdown?: MixedBreakdown;
//   employeeDni?: string;
//   clientDni?: string;
//   clientName?: string;
//   editSaleId?: number | string;
// }} args
// @returns {object | null}
// =============================================================================
export function buildQrSaleSnapshotPayload({
    details,
    qrAmount,
    breakdown,
    employeeDni,
    clientDni,
    clientName,
    editSaleId,
} = {}) {
    if (!Array.isArray(details) || details.length === 0) return null;
    const normalizedDetails = [];
    let computedTotal = 0;
    for (const d of details) {
        if (!d || typeof d !== "object") return null;
        const barcode = typeof d.barcode === "string" ? d.barcode.trim() : "";
        if (!barcode) return null;
        const qty = typeof d.quantity === "number" ? d.quantity : NaN;
        if (!Number.isFinite(qty) || qty <= 0) return null;
        const up = typeof d.unitPrice === "number" ? d.unitPrice : NaN;
        if (!Number.isFinite(up) || up < 0) return null;
        const sub = typeof d.subtotal === "number" && Number.isFinite(d.subtotal) ? d.subtotal : qty * up;
        const cost = typeof d.costPrice === "number" && Number.isFinite(d.costPrice) ? d.costPrice : 0;
        computedTotal += sub;
        normalizedDetails.push({
            barcode,
            quantity: qty,
            unitPrice: up,
            costPrice: cost,
            subtotal: sub,
        });
    }
    const normalizedQr = typeof qrAmount === "number" && Number.isFinite(qrAmount) && qrAmount > 0
        ? Math.round(qrAmount)
        : 0;
    const cash = typeof breakdown?.cash === "number" && Number.isFinite(breakdown.cash) && breakdown.cash > 0
        ? Math.round(breakdown.cash)
        : 0;
    const nequi = typeof breakdown?.nequi === "number" && Number.isFinite(breakdown.nequi) && breakdown.nequi > 0
        ? Math.round(breakdown.nequi)
        : 0;
    const daviplata = typeof breakdown?.daviplata === "number" && Number.isFinite(breakdown.daviplata) && breakdown.daviplata > 0
        ? Math.round(breakdown.daviplata)
        : 0;
    const credit = typeof breakdown?.credit === "number" && Number.isFinite(breakdown.credit) && breakdown.credit > 0
        ? Math.round(breakdown.credit)
        : 0;
    // Total REAL del carrito. Si el llamador trae `totalCart` lo preferimos
    // (defensa: puede incluir redondeos de línea distintos a la suma cruda
    // de `qty * price`), si no, usamos la suma calculada.
    const totalCart = typeof breakdown?.totalCart === "number" && Number.isFinite(breakdown.totalCart) && breakdown.totalCart > 0
        ? Math.round(breakdown.totalCart)
        : Math.round(computedTotal);
    const amountPaid = cash + nequi + daviplata + credit + normalizedQr;
    const transferAmount = nequi + daviplata + normalizedQr;
    // paymentMethod legible para el historial. Si hay QR siempre figura;
    // los demás canales se concatenan según su presencia real.
    const parts = [];
    if (cash > 0) parts.push("EFECTIVO");
    if (nequi > 0) parts.push("NEQUI");
    if (daviplata > 0) parts.push("DAVIPLATA");
    if (normalizedQr > 0) parts.push("BOLD_QR");
    if (credit > 0) parts.push("FIADO");
    const paymentMethod = parts.length > 0 ? parts.join(" + ") : "BOLD_QR";
    const out = {
        details: normalizedDetails,
        totalAmount: totalCart,
        amountPaid,
        change: 0,
        cashAmount: cash,
        transferAmount,
        transferNequi: nequi,
        transferDaviplata: daviplata,
        creditAmount: credit,
        transferSource: "BOLD_QR",
        paymentMethod,
        employeeDni: typeof employeeDni === "string" ? employeeDni : "",
        clientDni: typeof clientDni === "string" && clientDni ? clientDni : "0",
        clientName: typeof clientName === "string" ? clientName : "",
    };
    if (editSaleId !== undefined && editSaleId !== null) {
        let normalizedEdit = NaN;
        if (typeof editSaleId === "number" && Number.isFinite(editSaleId) && Number.isInteger(editSaleId) && editSaleId > 0) {
            normalizedEdit = editSaleId;
        } else if (typeof editSaleId === "string" && /^[1-9]\d*$/.test(editSaleId.trim())) {
            const parsed = Number.parseInt(editSaleId.trim(), 10);
            if (Number.isFinite(parsed) && parsed > 0) normalizedEdit = parsed;
        }
        if (Number.isFinite(normalizedEdit)) {
            out.editSaleId = normalizedEdit;
        }
    }
    return out;
}

/**
 * Resumen legible de los canales NO-QR del snapshot. Lo consume la
 * vista QR del `UniversalPaymentModal`/`ModalPagoBoldQR` para mostrar
 * al cliente/cajero "Efectivo $X + QR $Y" sin tener que reimplementar
 * el formateo en cada componente. Devuelve `""` cuando no hay desglose
 * previo (el cliente paga 100% por QR).
 *
 * @param {{ cash?: number; nequi?: number; daviplata?: number; credit?: number }} breakdown
 * @param {number} qrAmount
 * @param {(n: number) => string} formatCurrencyFn
 * @returns {string}
 */
export function describeMixedChannelsSummary(breakdown, qrAmount, formatCurrencyFn) {
    if (!breakdown || typeof breakdown !== "object") return "";
    const parts = [];
    const cash = typeof breakdown.cash === "number" && breakdown.cash > 0 ? Math.round(breakdown.cash) : 0;
    const nequi = typeof breakdown.nequi === "number" && breakdown.nequi > 0 ? Math.round(breakdown.nequi) : 0;
    const daviplata = typeof breakdown.daviplata === "number" && breakdown.daviplata > 0 ? Math.round(breakdown.daviplata) : 0;
    const credit = typeof breakdown.credit === "number" && breakdown.credit > 0 ? Math.round(breakdown.credit) : 0;
    const qr = typeof qrAmount === "number" && qrAmount > 0 ? Math.round(qrAmount) : 0;
    const fmt = typeof formatCurrencyFn === "function" ? formatCurrencyFn : (n) => String(n);
    if (cash > 0) parts.push(`Efectivo $${fmt(cash)}`);
    if (nequi > 0) parts.push(`Nequi $${fmt(nequi)}`);
    if (daviplata > 0) parts.push(`Daviplata $${fmt(daviplata)}`);
    if (credit > 0) parts.push(`Fiado $${fmt(credit)}`);
    if (qr > 0) parts.push(`QR $${fmt(qr)}`);
    return parts.join(" + ");
}


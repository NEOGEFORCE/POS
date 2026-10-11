// =============================================================================
// printer-bridge.js
//
// Lógica PURA y testeable del backend de impresión del scale-bridge.
//
// Diseño:
//   * No abre sockets, no spawnea procesos, no toca el filesystem salvo
//     para leer bytes que vengan en el payload. Todo lo "sucio" (TCP,
//     PowerShell) vive en `print-transports.js`.
//   * El punto de entrada es `handlePrinterRequest(req, deps)` que recibe
//     el mensaje ya parseado desde el WebSocket y un objeto `deps` con
//     los transportes inyectados. Esto permite probarlo con stubs sin
//     abrir sockets reales (ver `test/printer-bridge.test.js`).
//   * Shape y errores están pensados para que el frontend muestre toasts
//     accionables sin inventar strings. Códigos tipo `TCP_TIMEOUT`,
//     `MISSING_PRINTER_NAME`, `UNSUPPORTED_INTERFACE`.
//
// Guardarraíles de seguridad:
//   * Nada que venga del navegador se interpreta como código. El único
//     caso donde aceptamos "comando" es `drawer.command`, que se decodifica
//     con `parseDrawerCommand` (parser estricto de literales `\xHH`,
//     tamaño limitado).
//   * Textos de etiquetas/recibos se transliteran a CP850 o se filtran
//     control chars antes de ir a protocolos como TSPL que embeben el
//     texto entre comillas.
//   * Límites duros en LIMITS para que una payload gigante no reviente
//     la cola de impresión ni el proceso Node.
// =============================================================================

"use strict";

// Generador modular de etiquetas (lógica pura, sin side-effects). Se mantiene
// en un módulo aparte para que el bridge no cargue toda la matemática del
// TSPL en memoria desde el principio, y para que los tests puedan importar
// `mmToDots`, `computeColumnOffsets`, etc. sin pasar por el bridge.
const labelGen = require("./label-generator");

// -----------------------------------------------------------------------------
// Límites — centralizados para que validadores/tests compartan la misma fuente.
// -----------------------------------------------------------------------------

const LIMITS = Object.freeze({
    // Tamaño máximo del mensaje JSON entrante (ws también lo recorta).
    maxMessageBytes: 256 * 1024,
    // Texto monoespacio del recibo térmico (buildTicketText del frontend).
    maxTicketTextBytes: 32 * 1024,
    // Items por lote de etiquetas (lectura normal: 20–100; dejamos holgura).
    maxLabelItems: 500,
    // Repeticiones por item (quantity).
    maxLabelQuantity: 100,
    // Texto por campo de etiqueta tras filtrado.
    maxLabelField: 120,
    // Bytes decodificados aceptados en drawer.command (ESC/POS típico: 5).
    maxDrawerBytes: 32,
    // Timeout por envío al transporte físico (ms). Configurable por el caller.
    defaultTcpTimeoutMs: 7000,
    defaultSystemTimeoutMs: 15000,
    // Puerto TCP RAW estándar.
    defaultTcpPort: 9100,
});

// -----------------------------------------------------------------------------
// Códigos de error accionables — el frontend hace match por prefijo.
// -----------------------------------------------------------------------------

const ERR = Object.freeze({
    INVALID_REQUEST: "INVALID_REQUEST",
    UNSUPPORTED_ACTION: "UNSUPPORTED_ACTION",
    UNSUPPORTED_INTERFACE: "UNSUPPORTED_INTERFACE",
    UNSUPPORTED_PROTOCOL: "UNSUPPORTED_PROTOCOL",
    UNSUPPORTED_PAYLOAD_TYPE: "UNSUPPORTED_PAYLOAD_TYPE",
    MISSING_HOST: "MISSING_HOST",
    INVALID_PORT: "INVALID_PORT",
    MISSING_PRINTER_NAME: "MISSING_PRINTER_NAME",
    MISSING_USB_DEVICE_PATH: "MISSING_USB_DEVICE_PATH",
    PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
    TOO_MANY_LABELS: "TOO_MANY_LABELS",
    DRAWER_COMMAND_EMPTY: "DRAWER_COMMAND_EMPTY",
    DRAWER_COMMAND_TOO_LARGE: "DRAWER_COMMAND_TOO_LARGE",
    DRAWER_COMMAND_INVALID: "DRAWER_COMMAND_INVALID",
    NO_LABELS: "NO_LABELS",
    TCP_TIMEOUT: "TCP_TIMEOUT",
    TCP_ERROR: "TCP_ERROR",
    SYSTEM_PRINT_FAILED: "SYSTEM_PRINT_FAILED",
    ORIGIN_FORBIDDEN: "ORIGIN_FORBIDDEN",
    // Códigos nuevos del generador modular de etiquetas (`label-generator.js`).
    // Los propagamos tal cual al frontend para que el toast sea accionable.
    LAYOUT_OUT_OF_BOUNDS: "LAYOUT_OUT_OF_BOUNDS",
    INVALID_BARCODE_EAN13: "INVALID_BARCODE_EAN13",
    UNSUPPORTED_BARCODE_SYMBOLOGY: "UNSUPPORTED_BARCODE_SYMBOLOGY",
    INVALID_LABEL_CONFIG: "INVALID_LABEL_CONFIG",
});

// -----------------------------------------------------------------------------
// Eventos de cajón — reflejan `DRAWER_EVENTS` del frontend
// (`printing-config.mjs`). El bridge sólo abre cajón automático en los dos
// eventos no-MANUAL cuando el payload además lleva `openDrawerOnSale=true`.
// Reimpresión y acciones de administración NUNCA pasan ese flag.
// -----------------------------------------------------------------------------

const DRAWER_EVENTS = Object.freeze({
    BEFORE_PRINT: "BEFORE_PRINT",
    AFTER_PRINT: "AFTER_PRINT",
    MANUAL: "MANUAL",
});

// -----------------------------------------------------------------------------
// ESC/POS — bytes fundamentales
// -----------------------------------------------------------------------------

const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;
const NUL = 0x00;

const ESCPOS = Object.freeze({
    INIT: Buffer.from([ESC, 0x40]),
    // ESC t n: selecciona code table. n=2 → CP850 (Multilingüe Latin 1).
    CHARSET_CP850: Buffer.from([ESC, 0x74, 0x02]),
    // ESC d n: feed n lines
    feed: (n) => Buffer.from([ESC, 0x64, Math.max(0, Math.min(16, n | 0))]),
    // GS V 0 full cut, GS V 1 partial cut.
    CUT_FULL: Buffer.from([GS, 0x56, 0x00]),
    CUT_PARTIAL: Buffer.from([GS, 0x56, 0x01]),
    // Alineación: ESC a n (0=left, 1=center, 2=right)
    align: (n) => Buffer.from([ESC, 0x61, Math.max(0, Math.min(2, n | 0))]),
    // Emphasize ON/OFF
    BOLD_ON: Buffer.from([ESC, 0x45, 0x01]),
    BOLD_OFF: Buffer.from([ESC, 0x45, 0x00]),
    // GS h n: altura de código de barras en puntos (1..255)
    bcHeight: (n) => Buffer.from([GS, 0x68, Math.max(1, Math.min(255, n | 0))]),
    // GS w n: ancho del módulo del código de barras (2..6 típico)
    bcWidth: (n) => Buffer.from([GS, 0x77, Math.max(2, Math.min(6, n | 0))]),
    // GS H n: posición HRI (0=none, 2=below)
    bcHriPos: (n) => Buffer.from([GS, 0x48, Math.max(0, Math.min(3, n | 0))]),
});

// -----------------------------------------------------------------------------
// CP850 — mapa de códigos para texto español.
//
// Node no incluye encoder nativo para CP850, así que tenemos un lookup de
// los caracteres que aparecen en recibos/etiquetas en español. Todo lo que
// no esté en la tabla se transliterará (acentos → sin acento) ANTES de
// mandar al encoder: el encoder nunca inserta "?" porque eso se vería feo
// en la impresora. ASCII imprimible (0x20..0x7E) y controles (TAB, LF, CR)
// se dejan pasar tal cual.
// -----------------------------------------------------------------------------

const CP850_MAP = Object.freeze({
    "Ç": 0x80, "ü": 0x81, "é": 0x82, "â": 0x83, "ä": 0x84, "à": 0x85, "å": 0x86,
    "ç": 0x87, "ê": 0x88, "ë": 0x89, "è": 0x8A, "ï": 0x8B, "î": 0x8C, "ì": 0x8D,
    "Ä": 0x8E, "Å": 0x8F,
    "É": 0x90, "æ": 0x91, "Æ": 0x92, "ô": 0x93, "ö": 0x94, "ò": 0x95, "û": 0x96,
    "ù": 0x97, "ÿ": 0x98, "Ö": 0x99, "Ü": 0x9A, "ø": 0x9B, "£": 0x9C, "Ø": 0x9D,
    "×": 0x9E, "ƒ": 0x9F,
    "á": 0xA0, "í": 0xA1, "ó": 0xA2, "ú": 0xA3, "ñ": 0xA4, "Ñ": 0xA5, "ª": 0xA6,
    "º": 0xA7, "¿": 0xA8, "®": 0xA9, "¬": 0xAA, "½": 0xAB, "¼": 0xAC, "¡": 0xAD,
    "«": 0xAE, "»": 0xAF,
    "Á": 0xB5, "Â": 0xB6, "À": 0xB7, "©": 0xB8,
    "ã": 0xC6, "Ã": 0xC7, "¤": 0xCF,
    "ð": 0xD0, "Ð": 0xD1, "Ê": 0xD2, "Ë": 0xD3, "È": 0xD4, "ı": 0xD5, "Í": 0xD6,
    "Î": 0xD7, "Ï": 0xD8, "¦": 0xDD, "Ì": 0xDE,
    "Ó": 0xE0, "ß": 0xE1, "Ô": 0xE2, "Ò": 0xE3, "õ": 0xE4, "Õ": 0xE5, "µ": 0xE6,
    "þ": 0xE7, "Þ": 0xE8, "Ú": 0xE9, "Û": 0xEA, "Ù": 0xEB, "ý": 0xEC, "Ý": 0xED,
    "¯": 0xEE, "´": 0xEF,
    "±": 0xF1, "‗": 0xF2, "¾": 0xF3, "¶": 0xF4, "§": 0xF5, "÷": 0xF6, "¸": 0xF7,
    "°": 0xF8, "¨": 0xF9, "·": 0xFA, "¹": 0xFB, "³": 0xFC, "²": 0xFD, "■": 0xFE,
    "€": 0xD5, // ESC/POS varias impresoras usan 0xD5 para €; fallback aceptable.
});

// Tabla de transliteración para caracteres fuera de CP850 que QUEREMOS
// representar en ASCII puro antes del encoder (típicamente comillas tipográficas,
// guiones largos, etc.). Documentada en README adjunto de code review.
const TRANSLIT_MAP = Object.freeze({
    "“": '"', "”": '"', "„": '"', "«": "<<", "»": ">>",
    "‘": "'", "’": "'", "‚": "'",
    "–": "-", "—": "-", "−": "-", "‒": "-",
    "…": "...",
    "•": "*", "·": ".",
    "\u00A0": " ",  // nbsp → espacio
    "\u2007": " ", "\u2009": " ", "\u200B": "",  // espacios finos / zero-width
    "\u2122": "TM",
    "₂": "2", "₃": "3", "₁": "1", "₀": "0",
});

/**
 * Transliteración ASCII-safe para cuando CP850 no alcance o el canal
 * (TSPL por ejemplo) sea más restrictivo. Es idempotente.
 *
 * @param {string} input
 * @returns {string}
 */
function transliterate(input) {
    if (input === null || input === undefined) return "";
    const raw = typeof input === "string" ? input : String(input);
    // 1) Normalizamos NFD para poder quitar diacríticos sueltos.
    let out = raw.normalize("NFKD").replace(/[\u0300-\u036F]/g, "");
    // 2) Reemplazamos símbolos tipográficos conocidos.
    let acc = "";
    for (const ch of out) {
        acc += TRANSLIT_MAP[ch] ?? ch;
    }
    return acc;
}

/**
 * Codifica una cadena a Buffer CP850. Caracteres no mapeados pasan por
 * `transliterate` (que quita acentos, por ejemplo) y luego, si siguen sin
 * tener encoding, se reemplazan por `?`. ASCII imprimible y control chars
 * básicos (TAB=0x09, LF=0x0A, CR=0x0D) se preservan.
 *
 * Esta función NO añade `ESC t 2`. Eso lo hace el builder del recibo —
 * así podemos codificar también para transportes que ya seleccionaron
 * el charset ellos mismos.
 *
 * @param {string} input
 * @returns {Buffer}
 */
function encodeCP850(input) {
    if (input === null || input === undefined) return Buffer.alloc(0);
    const str = typeof input === "string" ? input : String(input);
    const out = Buffer.alloc(str.length * 2); // worst-case: cada char podría ser 2 bytes tras translit
    let pos = 0;
    for (const ch of str) {
        const code = ch.codePointAt(0);
        if (code === undefined) continue;
        // ASCII imprimible + control chars seguros pasan tal cual.
        if ((code >= 0x20 && code <= 0x7E) || code === 0x09 || code === 0x0A || code === 0x0D) {
            out[pos++] = code;
            continue;
        }
        // Mapa directo CP850.
        const direct = CP850_MAP[ch];
        if (direct !== undefined) {
            out[pos++] = direct;
            continue;
        }
        // Fallback: transliteración y reintento char-a-char.
        const fallback = transliterate(ch);
        if (fallback.length === 0) continue; // zero-width eliminado
        for (const sub of fallback) {
            const sc = sub.codePointAt(0);
            if (sc === undefined) continue;
            if ((sc >= 0x20 && sc <= 0x7E) || sc === 0x09 || sc === 0x0A || sc === 0x0D) {
                out[pos++] = sc;
            } else if (CP850_MAP[sub] !== undefined) {
                out[pos++] = CP850_MAP[sub];
            } else {
                out[pos++] = 0x3F; // '?'
            }
        }
    }
    return out.subarray(0, pos);
}

// -----------------------------------------------------------------------------
// Utilidades puras
// -----------------------------------------------------------------------------

function clampInt(v, min, max, fb) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return fb;
    const r = Math.round(n);
    if (r < min) return min;
    if (r > max) return max;
    return r;
}

function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Filtra control chars y recorta un string a `maxLen`. Se usa para campos
 * que terminan embebidos en texto plano (etiquetas, encabezados).
 */
function cleanField(value, maxLen) {
    if (value === null || value === undefined) return "";
    const raw = typeof value === "string" ? value : String(value);
    // Permitimos saltos de línea? No: estos son campos lineales.
    const stripped = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
    const limit = Number.isFinite(maxLen) ? maxLen : LIMITS.maxLabelField;
    return stripped.length > limit ? stripped.slice(0, limit) : stripped;
}

/**
 * Para TSPL embebemos el texto entre comillas dobles. Un `"` o `\` sin
 * escapar rompería la línea TSPL completa; además nunca permitimos LF/CR
 * dentro del campo. Solo caracteres imprimibles ASCII tras transliteración.
 */
function escapeForTspl(value, maxLen) {
    const trans = transliterate(cleanField(value, maxLen));
    // ASCII imprimible, nunca " ni \
    const safe = trans.replace(/[^\x20-\x7E]/g, "").replace(/["\\]/g, "");
    const limit = Number.isFinite(maxLen) ? maxLen : LIMITS.maxLabelField;
    return safe.length > limit ? safe.slice(0, limit) : safe;
}

// -----------------------------------------------------------------------------
// Parser del comando del cajón (drawer.command).
//
// El frontend guarda el comando como string literal: `\x1B\x70\x00\x19\xFA`.
// Aquí lo convertimos a bytes. ÚNICOS tokens aceptados:
//   - `\xHH` con dos hex. Case-insensitive.
//   - `\\` → literal `\`
//   - `\n` `\r` `\t` → bytes de control canónicos.
//   - Cualquier otro carácter ASCII imprimible (0x20..0x7E) pasa como byte.
// Cualquier otra secuencia `\?` o chars fuera de ASCII imprimible devuelve
// DRAWER_COMMAND_INVALID. Esto bloquea comandos arbitrarios con bytes raros
// desde el navegador sin perder la flexibilidad "literal ESC/POS".
// -----------------------------------------------------------------------------

function parseDrawerCommand(input) {
    if (input === null || input === undefined || input === "") {
        const err = new Error("drawer command empty");
        err.code = ERR.DRAWER_COMMAND_EMPTY;
        throw err;
    }
    const str = typeof input === "string" ? input : String(input);
    if (str.length > LIMITS.maxDrawerBytes * 8) {
        // Un `\xHH` ocupa 4 chars → maxBytes*4 bastaría, usamos *8 por holgura.
        const err = new Error("drawer command too large");
        err.code = ERR.DRAWER_COMMAND_TOO_LARGE;
        throw err;
    }
    const out = [];
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === "\\") {
            const next = str[i + 1];
            if (next === undefined) {
                const err = new Error("dangling backslash");
                err.code = ERR.DRAWER_COMMAND_INVALID;
                throw err;
            }
            if (next === "x" || next === "X") {
                const h1 = str[i + 2];
                const h2 = str[i + 3];
                if (h1 === undefined || h2 === undefined || !/[0-9a-fA-F]/.test(h1) || !/[0-9a-fA-F]/.test(h2)) {
                    const err = new Error("invalid \\xHH escape");
                    err.code = ERR.DRAWER_COMMAND_INVALID;
                    throw err;
                }
                out.push(parseInt(h1 + h2, 16));
                i += 3;
                continue;
            }
            if (next === "\\") { out.push(0x5C); i += 1; continue; }
            if (next === "n") { out.push(0x0A); i += 1; continue; }
            if (next === "r") { out.push(0x0D); i += 1; continue; }
            if (next === "t") { out.push(0x09); i += 1; continue; }
            const err = new Error(`unsupported escape \\${next}`);
            err.code = ERR.DRAWER_COMMAND_INVALID;
            throw err;
        }
        const code = ch.codePointAt(0);
        // Char plano: ASCII imprimible. Nada de UTF-8 multibyte en el comando.
        if (code === undefined || code < 0x20 || code > 0x7E) {
            const err = new Error("unprintable byte in drawer command");
            err.code = ERR.DRAWER_COMMAND_INVALID;
            throw err;
        }
        out.push(code);
    }
    if (out.length === 0) {
        const err = new Error("drawer command empty");
        err.code = ERR.DRAWER_COMMAND_EMPTY;
        throw err;
    }
    if (out.length > LIMITS.maxDrawerBytes) {
        const err = new Error("drawer command too large");
        err.code = ERR.DRAWER_COMMAND_TOO_LARGE;
        throw err;
    }
    return Buffer.from(out);
}

// -----------------------------------------------------------------------------
// Validaciones de alto nivel
// -----------------------------------------------------------------------------

/**
 * Valida la rama `connection` para asegurar que podemos derivar un
 * transporte. Devuelve `{ok:true}` o `{ok:false, code, message}`.
 */
function validateConnectionForPrint(connection) {
    if (!isPlainObject(connection)) {
        return { ok: false, code: ERR.INVALID_REQUEST, message: "connection ausente" };
    }
    const iface = String(connection.interface || "").toUpperCase();
    if (iface === "NETWORK") {
        const host = String(connection.network?.host || "").trim();
        if (!host) return { ok: false, code: ERR.MISSING_HOST, message: "connection.network.host requerido" };
        const rawPort = connection.network?.port;
        const port = typeof rawPort === "number" ? rawPort : Number(rawPort);
        if (!Number.isFinite(port) || !Number.isInteger(port) || port < 1 || port > 65535) {
            return { ok: false, code: ERR.INVALID_PORT, message: "connection.network.port fuera de rango" };
        }
        return { ok: true };
    }
    if (iface === "SYSTEM") {
        const name = String(connection.system?.printerName || "").trim();
        if (!name) return { ok: false, code: ERR.MISSING_PRINTER_NAME, message: "connection.system.printerName requerido" };
        return { ok: true };
    }
    if (iface === "USB") {
        // Compatibilidad: devicePath actúa como nombre de cola Windows.
        const path = String(connection.usb?.devicePath || "").trim();
        if (!path) {
            return {
                ok: false,
                code: ERR.MISSING_USB_DEVICE_PATH,
                message:
                    "USB no se accede directamente desde el bridge. Instala el driver fabricante y pasa el nombre de la cola Windows en connection.usb.devicePath (o cambia a SYSTEM con connection.system.printerName).",
            };
        }
        return { ok: true };
    }
    return { ok: false, code: ERR.UNSUPPORTED_INTERFACE, message: `interface no soportada: ${iface}` };
}

/**
 * Decide el transporte lógico a partir de connection (sin ejecutar nada).
 * - NETWORK → `{kind:"tcp", host, port}`
 * - SYSTEM → `{kind:"system", printerName}`
 * - USB con devicePath → `{kind:"system", printerName}` (fallback documentado)
 */
function pickTransport(connection) {
    const iface = String(connection.interface || "").toUpperCase();
    if (iface === "NETWORK") {
        return {
            kind: "tcp",
            host: String(connection.network.host).trim(),
            port: clampInt(connection.network.port, 1, 65535, LIMITS.defaultTcpPort),
        };
    }
    if (iface === "SYSTEM") {
        return { kind: "system", printerName: String(connection.system.printerName).trim() };
    }
    if (iface === "USB") {
        return { kind: "system", printerName: String(connection.usb.devicePath).trim() };
    }
    return { kind: "unsupported", interface: iface };
}

// -----------------------------------------------------------------------------
// Builder de recibos térmicos
// -----------------------------------------------------------------------------

/**
 * Arma el stream ESC/POS para un recibo térmico "texto puro".
 *
 * Reglas:
 *   - Siempre `ESC @` (init) + `ESC t 2` (CP850).
 *   - Texto codificado CP850 (acentos preservados).
 *   - Feed final de 3 líneas para que el cutter no muerda la última línea.
 *   - `cut = "AUTO"` → GS V 0 (corte completo). MANUAL/NONE no cortan.
 *   - Drawer BEFORE/AFTER embebido: SOPORTE DISPONIBLE pero NO USADO por
 *     el flujo UI actual. Cuando un llamador explícito manda `drawer` +
 *     `openDrawerOnSale: true` + `event ∈ {BEFORE_PRINT, AFTER_PRINT}`,
 *     embebemos los bytes del cajón antes o después del cuerpo del recibo.
 *     El flujo UniversalPaymentModal del POS NO toma esta ruta: usa
 *     `dispatchKickDrawer` audit-first (una única ruta física por venta,
 *     para evitar el doble pulso que había antes de printing-v2 defects).
 *     Esta capacidad se preserva para callers futuros (p.ej. flujos
 *     ESC/POS-only sin WebSocket bridge para el cajón). Reimpresiones y
 *     MANUAL siguen sin disparar automático. Ver `resolveAutoDrawerBytes`.
 *
 * @param {object} opts
 * @param {string} opts.ticketText           Texto compuesto por el frontend.
 * @param {"AUTO"|"MANUAL"|"NONE"} [opts.cut]
 * @param {number} [opts.feedLines]
 * @param {object} [opts.drawer]             `{enabled, command, event}` del admin.
 * @param {boolean} [opts.openDrawerOnSale]  Flag explícito del payload.
 * @param {string}  [opts.event]             Evento actual (default "AFTER_PRINT"
 *                                           cuando el payload no lo especifica).
 * @returns {Buffer}
 */
function buildReceiptBytes({ ticketText, cut, feedLines, drawer, openDrawerOnSale, event }) {
    const drawerBytes = resolveAutoDrawerBytes({ drawer, openDrawerOnSale, event });
    const emitBefore = drawerBytes && drawerBytes.event === DRAWER_EVENTS.BEFORE_PRINT;
    const emitAfter = drawerBytes && drawerBytes.event === DRAWER_EVENTS.AFTER_PRINT;

    const parts = [];
    if (emitBefore) {
        // El pulso del cajón va ANTES del init porque algunas impresoras
        // reinician su estado al recibir `ESC @` y pierden comandos
        // pendientes. Esta regla es coherente con los emuladores ESC/POS
        // más usados en Colombia.
        parts.push(drawerBytes.buf);
    }
    parts.push(ESCPOS.INIT, ESCPOS.CHARSET_CP850);
    const text = typeof ticketText === "string" ? ticketText : "";
    parts.push(encodeCP850(text));
    // Normalizamos salida de línea para asegurar LF al final del cuerpo.
    if (!text.endsWith("\n")) parts.push(Buffer.from([LF]));
    const feed = clampInt(feedLines, 0, 10, 3);
    if (feed > 0) parts.push(ESCPOS.feed(feed));
    const cutMode = String(cut || "").toUpperCase();
    if (cutMode === "AUTO") {
        parts.push(ESCPOS.CUT_FULL);
    }
    // AFTER_PRINT va DESPUÉS del corte: el cajero oye el cutter antes de
    // sentir el pulso del cajón abriéndose, orden operativo esperado.
    if (emitAfter) {
        parts.push(drawerBytes.buf);
    }
    return Buffer.concat(parts);
}

/**
 * Decide si corresponde emitir bytes de cajón automáticamente en este
 * recibo. Devuelve `{buf, event}` cuando sí, o `null` cuando no.
 *
 * Condiciones conjuntivas (todas deben cumplirse):
 *   1. El payload trae `openDrawerOnSale === true`. El frontend lo setea
 *      exclusivamente al CERRAR UNA VENTA. Las reimpresiones omiten el
 *      flag (equivale a `false`) y nunca abren cajón, por diseño.
 *   2. `drawer.enabled === true`.
 *   3. `drawer.event` ∈ {BEFORE_PRINT, AFTER_PRINT}. MANUAL explícitamente
 *      descarta cualquier automatismo — se abre sólo con `kickDrawer`.
 *   4. Si el payload trae `event`, debe coincidir con `drawer.event`.
 *      Esto permite que en el futuro se agreguen eventos específicos
 *      (ON_SALE_COMPLETE, etc.) sin filtrarlos accidentalmente al recibo.
 *   5. El `drawer.command` se parsea correctamente a bytes (literal `\xHH`).
 *      Si falla el parse, no inventamos: devolvemos `null` y el recibo
 *      sale sin cajón, pero sin lanzar — el admin debe arreglar el preset.
 */
function resolveAutoDrawerBytes({ drawer, openDrawerOnSale, event }) {
    if (openDrawerOnSale !== true) return null;
    if (!isPlainObject(drawer)) return null;
    if (drawer.enabled !== true) return null;
    const configuredEvent = typeof drawer.event === "string" ? drawer.event.toUpperCase() : "";
    if (configuredEvent !== DRAWER_EVENTS.BEFORE_PRINT && configuredEvent !== DRAWER_EVENTS.AFTER_PRINT) {
        return null;
    }
    // El payload puede opcionalmente venir con un `event` para contextualizar
    // (ej. "ON_SALE_COMPLETE" en el futuro). Si no viene, asumimos que el
    // frontend ya validó que corresponde abrir. Si viene, exigimos coincidencia
    // con lo configurado por el admin.
    if (typeof event === "string" && event.length > 0) {
        const payloadEvent = event.toUpperCase();
        // "ON_SALE_COMPLETE" se interpreta como "este es un cierre de venta",
        // y en ese caso cualquiera de BEFORE_PRINT/AFTER_PRINT configurado
        // dispara. Un `event` distinto a los conocidos no dispara.
        const salesContext = ["BEFORE_PRINT", "AFTER_PRINT", "ON_SALE_COMPLETE", "SALE_COMPLETE"];
        if (!salesContext.includes(payloadEvent)) return null;
    }
    try {
        const buf = parseDrawerCommand(drawer.command);
        return { buf, event: configuredEvent };
    } catch (_) {
        // Comando mal formado: no filtramos bytes raros al recibo.
        return null;
    }
}

// -----------------------------------------------------------------------------
// Test-page builders — recibo y etiqueta de prueba.
// -----------------------------------------------------------------------------

function buildTestPageReceipt(sanitizedConfig) {
    const columns = clampInt(sanitizedConfig?.receipt?.columns, 20, 80, 32);
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const biz = cleanField(sanitizedConfig?.receipt?.header?.businessName, 80) || "scale-bridge";
    const sep = "-".repeat(columns);
    const lines = [
        center("PAGINA DE PRUEBA", columns),
        center(biz, columns),
        sep,
        `Fecha : ${now}`,
        `Ancho : ${sanitizedConfig?.receipt?.widthMm ?? "?"} mm`,
        `Cols  : ${columns}`,
        `Corte : ${sanitizedConfig?.receipt?.cut || "AUTO"}`,
        sep,
        "Acentos: ñ Ñ á é í ó ú ¿ ¡",
        sep,
        center("OK", columns),
        "",
    ];
    return buildReceiptBytes({
        ticketText: lines.join("\n"),
        cut: sanitizedConfig?.receipt?.cut || "AUTO",
        feedLines: 2,
    });
}

function buildTestPageLabel(sanitizedConfig) {
    const protocol = String(sanitizedConfig?.connection?.protocol || "escpos").toLowerCase();
    const labelsCfg = sanitizedConfig?.labels || {};
    const preset = pickTestPagePreset(labelsCfg);
    // El preset reconocido alimenta defaults a `labels` cuando el admin no
    // los personalizó: 2 columnas en `30x20-2col`, `horizontalGapMm`, etc.
    const effectiveLabels = applyPresetDefaults(labelsCfg, preset);
    if (protocol === "tspl") {
        return labelGen.buildTsplTestPage({
            labels: effectiveLabels,
            preset,
            escapeFn: escapeForTspl,
            formatMoney,
        });
    }
    // Fallback ESC/POS: dos items si el preset activo es de 2 columnas,
    // uno si es de 1 columna. Mantiene la paridad "la página de prueba
    // exhibe el layout real" para que el admin vea si las columnas caben.
    const useTwo = Number(effectiveLabels.columns) === 2;
    const items = useTwo
        ? [
            { code: "TEST-L", productName: "ETIQUETA IZQ", salePrice: 1000, quantity: 1 },
            { code: "TEST-R", productName: "ETIQUETA DER", salePrice: 2000, quantity: 1 },
        ]
        : [
            { code: "TESTBRIDGE", productName: "ETIQUETA DE PRUEBA", salePrice: 0, quantity: 1 },
        ];
    return buildLabelBytes({ protocol, items, labels: effectiveLabels });
}

/**
 * Devuelve una clave de `LABEL_PRESETS` compatible con el `labels.sizePreset`
 * del frontend, o `null` cuando el preset no es reconocido (CUSTOM, etc.).
 * Se usa SÓLO como fuente de defaults para completar valores faltantes
 * en el payload; nunca sobreescribe lo que el admin personalizó.
 */
function pickTestPagePreset(labelsCfg) {
    const raw = labelsCfg?.sizePreset;
    if (typeof raw !== "string" || !raw) return null;
    const normalized = raw.toLowerCase();
    if (labelGen.LABEL_PRESETS[normalized]) return normalized;
    return null;
}

/**
 * Aplica defaults del preset SÓLO a campos ausentes del `labelsCfg`.
 * El admin manda si él puso valores concretos — por ejemplo si eligió
 * 1 columna en un preset que por default es de 2.
 */
function applyPresetDefaults(labelsCfg, presetKey) {
    const base = labelGen.LABEL_PRESETS[presetKey] || null;
    if (!base) return labelsCfg || {};
    const out = { ...(labelsCfg || {}) };
    if (out.widthMm == null) out.widthMm = base.widthMm;
    if (out.heightMm == null) out.heightMm = base.heightMm;
    if (out.columns == null) out.columns = base.columns;
    if (out.horizontalGapMm == null) out.horizontalGapMm = base.horizontalGapMm;
    if (out.marginLeftMm == null) out.marginLeftMm = base.marginLeftMm;
    const sensor = isPlainObject(out.sensor) ? { ...out.sensor } : {};
    if (sensor.gapMm == null) sensor.gapMm = base.verticalGapMm;
    out.sensor = sensor;
    return out;
}

// -----------------------------------------------------------------------------
// Builder de etiquetas
// -----------------------------------------------------------------------------

/**
 * Normaliza la entrada de etiquetas: aceptamos
 *   - `payload.labelItems = [{code, productName, salePrice, quantity}]`
 *     como fuente enriquecida preferida del frontend.
 *   - `payload.items = [{code, productName?, salePrice?, quantity?}]`
 *     para compatibilidad y para callers que ya mandan el detalle completo.
 *   - `payload = {code, productName?, salePrice?, quantity?}` (unitario).
 *
 * `labelItems` debe ganar sobre `items`: `/labels` mantiene deliberadamente
 * `items` reducido a `{code, quantity}` para auditar `/labels/print-jobs`, y
 * adjunta nombre/precio sólo en el trabajo local. Si leyéramos `items`
 * primero, la etiqueta física perdería ambos campos.
 *
 * Devuelve un array `items` normalizado y filtrado. Lanza con códigos
 * accionables si hay violaciones de límites.
 */
function normalizeLabelItems(payload) {
    if (!isPlainObject(payload)) {
        const err = new Error("payload de etiquetas inválido");
        err.code = ERR.INVALID_REQUEST;
        throw err;
    }
    let raw;
    if (Array.isArray(payload.labelItems)) {
        raw = payload.labelItems;
    } else if (Array.isArray(payload.items)) {
        raw = payload.items;
    } else if (typeof payload.code === "string") {
        raw = [{
            code: payload.code,
            productName: payload.productName,
            salePrice: payload.salePrice,
            quantity: payload.quantity,
        }];
    } else {
        const err = new Error("se esperaba items[] o code/productName/quantity");
        err.code = ERR.INVALID_REQUEST;
        throw err;
    }
    if (raw.length === 0) {
        const err = new Error("sin etiquetas");
        err.code = ERR.NO_LABELS;
        throw err;
    }
    if (raw.length > LIMITS.maxLabelItems) {
        const err = new Error(`demasiadas etiquetas (${raw.length} > ${LIMITS.maxLabelItems})`);
        err.code = ERR.TOO_MANY_LABELS;
        throw err;
    }
    const items = [];
    let total = 0;
    for (const row of raw) {
        if (!isPlainObject(row)) continue;
        const code = cleanField(row.code, 60);
        if (!code) continue;
        const productName = cleanField(row.productName, LIMITS.maxLabelField);
        const salePrice = Number.isFinite(Number(row.salePrice)) ? Number(row.salePrice) : 0;
        const quantity = clampInt(row.quantity, 1, LIMITS.maxLabelQuantity, 1);
        total += quantity;
        if (total > LIMITS.maxLabelItems * LIMITS.maxLabelQuantity) {
            const err = new Error("volumen total excede el máximo");
            err.code = ERR.TOO_MANY_LABELS;
            throw err;
        }
        items.push({ code, productName, salePrice, quantity });
    }
    if (items.length === 0) {
        const err = new Error("sin etiquetas válidas tras saneado");
        err.code = ERR.NO_LABELS;
        throw err;
    }
    return items;
}

/**
 * Construye bytes para N etiquetas, soportando dos protocolos:
 *   - "tspl" → batch con `SIZE`/`GAP`/`CLS`/`PRINT 1,qty`
 *   - cualquier otro (escpos/zpl-fallback) → texto plano con barras ESC/POS
 *
 * Las etiquetas ZPL quedarían para un sprint futuro: hoy se usa el camino
 * ESC/POS como mejor esfuerzo, con un comentario claro.
 */
function buildLabelBytes({ protocol, items, labels }) {
    const normalized = Array.isArray(items) ? items : [];
    const proto = String(protocol || "escpos").toLowerCase();
    if (normalized.length === 0) {
        const err = new Error("sin etiquetas para imprimir");
        err.code = ERR.NO_LABELS;
        throw err;
    }
    if (proto === "tspl") {
        return buildTsplBatch(normalized, labels || {});
    }
    if (proto === "zpl") {
        // Fallback intencional: emitimos ESC/POS porque ZPL requiere su propio
        // dialecto que el sprint acotó explícitamente a ESC/POS + TSPL.
        // Documentado para el revisor: no se agrega binario raro.
        return buildEscposBatch(normalized, labels || {});
    }
    // ESC/POS "continuo" (sin GAP) — rollo térmico tipo tickets de góndola.
    return buildEscposBatch(normalized, labels || {});
}

function buildEscposBatch(items, labels) {
    const parts = [ESCPOS.INIT, ESCPOS.CHARSET_CP850];
    const columns = Math.max(16, Math.min(80, 32));
    const bcHeight = clampInt(labels?.barcode?.heightMm ? labels.barcode.heightMm * 8 : 80, 20, 200, 80);
    const symbology = String(labels?.barcode?.symbology || "CODE128").toUpperCase();
    for (const item of items) {
        for (let i = 0; i < item.quantity; i++) {
            parts.push(ESCPOS.align(1)); // center
            if (item.productName) {
                parts.push(encodeCP850(fitLine(item.productName, columns)));
                parts.push(Buffer.from([LF]));
            }
            if (item.salePrice && item.salePrice > 0) {
                parts.push(ESCPOS.BOLD_ON);
                parts.push(encodeCP850(`$ ${formatMoney(item.salePrice)}`));
                parts.push(ESCPOS.BOLD_OFF);
                parts.push(Buffer.from([LF]));
            }
            if (symbology === "EAN13") {
                parts.push(encodeBarcodeEAN13(item.code, bcHeight));
            } else {
                parts.push(encodeBarcode128(item.code, bcHeight));
            }
            parts.push(ESCPOS.align(0));
            parts.push(ESCPOS.feed(2));
        }
    }
    parts.push(ESCPOS.feed(2));
    return Buffer.concat(parts);
}

/**
 * Genera código de barras CODE128 con HRI debajo.
 * Formato: GS k 73 n d1..dn (long-form).
 */
function encodeBarcode128(code, heightDots) {
    // En ESC/POS, CODE128 (m=73) exige que los datos comiencen con el
    // selector de conjunto `{A`, `{B` o `{C`. Usamos `{B` porque acepta
    // el catálogo alfanumérico del POS. Un `{` literal se duplica (`{{`)
    // según el escape definido por ESC/POS.
    const sanitized = String(code).replace(/[^\x20-\x7E]/g, "");
    let safe = "";
    for (const ch of sanitized) {
        const encoded = ch === "{" ? "{{" : ch;
        // 46 bytes de datos + 2 bytes de selector `{B` = n máximo 48.
        // Cortamos por token, nunca sobre el segundo byte de un escape `{{`.
        if (safe.length + encoded.length > 46) break;
        safe += encoded;
    }
    if (safe.length === 0) return Buffer.alloc(0);
    const data = Buffer.from(`{B${safe}`, "ascii");
    const parts = [
        ESCPOS.bcHriPos(2),          // HRI debajo
        ESCPOS.bcHeight(heightDots),
        ESCPOS.bcWidth(2),
        Buffer.from([GS, 0x6B, 73, data.length]),
        data,
    ];
    return Buffer.concat(parts);
}

/**
 * Genera código de barras EAN13 (ESC/POS long-form, m=67). Datos válidos:
 *   - 12 dígitos (el firmware calcula el check).
 *   - 13 dígitos cuyo último dígito sea el check correcto.
 * Cualquier otro input devuelve un buffer vacío (el llamador debe
 * validar antes si quiere error accionable).
 */
function encodeBarcodeEAN13(code, heightDots) {
    const digits = labelGen.sanitizeEan13(code);
    if (!digits) return Buffer.alloc(0);
    const data = Buffer.from(digits, "ascii");
    return Buffer.concat([
        ESCPOS.bcHriPos(2),
        ESCPOS.bcHeight(heightDots),
        ESCPOS.bcWidth(3),
        Buffer.from([GS, 0x6B, 67, data.length]),
        data,
    ]);
}

/**
 * Delega a `label-generator.buildTsplDocument`: emite SIZE con el ancho
 * TOTAL del medio (incluyendo gap horizontal + margen cuando columns=2),
 * CLS por fila con PRINT 1,1, y respeta `labels.layout` cuando viene.
 */
function buildTsplBatch(items, labels) {
    return labelGen.buildTsplDocument({
        labels,
        items,
        escapeFn: escapeForTspl,
        formatMoney,
    });
}

// -----------------------------------------------------------------------------
// Helpers de formato
// -----------------------------------------------------------------------------

function center(text, columns) {
    const str = String(text || "");
    if (str.length >= columns) return str.slice(0, columns);
    const pad = Math.max(0, Math.floor((columns - str.length) / 2));
    return " ".repeat(pad) + str;
}

function fitLine(text, columns) {
    const str = String(text || "");
    if (str.length <= columns) return str;
    return str.slice(0, columns);
}

function formatMoney(n) {
    const num = Number(n) || 0;
    const rounded = Math.round(num);
    // Formato "1.234.567" al estilo colombiano, sin dependencias.
    const str = String(Math.abs(rounded));
    const parts = [];
    for (let i = str.length; i > 0; i -= 3) {
        parts.unshift(str.slice(Math.max(0, i - 3), i));
    }
    const sign = rounded < 0 ? "-" : "";
    return sign + parts.join(".");
}

// -----------------------------------------------------------------------------
// Validación del request de WebSocket
// -----------------------------------------------------------------------------

/**
 * Comprueba la forma mínima del mensaje `printer.request` del frontend.
 * Devuelve `{ok:true, request}` o `{ok:false, code, message}`.
 */
function validatePrinterRequest(raw) {
    if (!isPlainObject(raw)) {
        return { ok: false, code: ERR.INVALID_REQUEST, message: "mensaje no es objeto" };
    }
    if (raw.type !== "printer.request") {
        return { ok: false, code: ERR.INVALID_REQUEST, message: "type !== printer.request" };
    }
    const requestId = typeof raw.requestId === "string" || typeof raw.requestId === "number"
        ? String(raw.requestId).slice(0, 80)
        : "";
    if (!requestId) {
        return { ok: false, code: ERR.INVALID_REQUEST, message: "requestId requerido" };
    }
    const action = String(raw.action || "").trim();
    if (!["print", "printTestPage", "kickDrawer"].includes(action)) {
        return { ok: false, code: ERR.UNSUPPORTED_ACTION, message: `acción no soportada: ${action}` };
    }
    const payload = isPlainObject(raw.payload) ? raw.payload : {};
    return { ok: true, request: { requestId, action, payload } };
}

// -----------------------------------------------------------------------------
// Validación de origen WebSocket
// -----------------------------------------------------------------------------

/**
 * Acepta orígenes locales/privados:
 *   - sin Origin (apps nativas o sin ventana)
 *   - localhost / 127.0.0.1 / ::1
 *   - IPs privadas RFC1918 (10.x, 172.16-31.x, 192.168.x)
 *   - file://  → algunos lanzadores locales
 *
 * Rechaza orígenes públicos para evitar que una página en internet lance
 * impresiones a un bridge expuesto accidentalmente.
 */
function isLocalOrigin(origin) {
    if (!origin || origin === "null") return true; // sin origen → aceptamos
    let parsed;
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }
    const proto = parsed.protocol;
    if (proto === "file:") return true;
    if (proto !== "http:" && proto !== "https:" && proto !== "ws:" && proto !== "wss:") {
        return false;
    }
    const host = parsed.hostname;
    if (!host) return false;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
    // IPv4 privado
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (a === 10) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true; // link-local
        return false;
    }
    // IPv6 privado típico (fc00::/7)
    if (/^fc[0-9a-f]{2}:/i.test(host) || /^fd[0-9a-f]{2}:/i.test(host)) return true;
    return false;
}

// -----------------------------------------------------------------------------
// Handler principal — ya con transportes inyectados.
// -----------------------------------------------------------------------------

/**
 * @param {object} request    `{requestId, action, payload}` ya validado
 * @param {object} deps       `{ sendTcp(host, port, buf, opts), sendSystem(printerName, buf, opts), logger? }`
 * @returns {Promise<{ok:boolean, result?:any, error?:string, errorCode?:string}>}
 */
async function handlePrinterRequest(request, deps) {
    const { action, payload } = request;
    try {
        if (action === "print") {
            return await dispatchPrint(payload, deps);
        }
        if (action === "printTestPage") {
            return await dispatchTestPage(payload, deps);
        }
        if (action === "kickDrawer") {
            return await dispatchKickDrawer(payload, deps);
        }
        return actionableError(ERR.UNSUPPORTED_ACTION, `acción ${action} no soportada`);
    } catch (err) {
        return errFromThrow(err);
    }
}

async function dispatchPrint(payload, deps) {
    // test-page puede entrar vía action="print" o action="printTestPage";
    // en ese caso la conexión viaja dentro de `payload.config.connection`,
    // así que redirigimos antes de validar `payload.connection`.
    const type = String(payload?.type || "").toLowerCase();
    if (type === "test-page") {
        return dispatchTestPage(payload, deps);
    }

    const connection = payload?.connection;
    const connCheck = validateConnectionForPrint(connection);
    if (!connCheck.ok) return actionableError(connCheck.code, connCheck.message);

    let bytes;
    let kind;

    if (type === "thermal-receipt") {
        const ticketText = String(payload.ticketText || "");
        if (Buffer.byteLength(ticketText, "utf8") > LIMITS.maxTicketTextBytes) {
            return actionableError(ERR.PAYLOAD_TOO_LARGE, "ticketText excede el límite");
        }
        const cut = payload?.cut || payload?.receipt?.cut || "AUTO";
        bytes = buildReceiptBytes({
            ticketText,
            cut,
            // Drawer BEFORE/AFTER: sólo cuando el payload explicita
            // `openDrawerOnSale=true`. Reimpresión no lo setea; MANUAL
            // nunca dispara automático. Ver `resolveAutoDrawerBytes`.
            drawer: payload.drawer,
            openDrawerOnSale: payload.openDrawerOnSale === true,
            event: payload.event,
        });
        kind = "receipt";
    } else if (Array.isArray(payload?.items) || Array.isArray(payload?.labelItems) || typeof payload?.code === "string") {
        // Lote de etiquetas (o unitario). El protocolo lo trae connection.
        const protocol = String(connection.protocol || "escpos").toLowerCase();
        const items = normalizeLabelItems(payload);
        bytes = buildLabelBytes({ protocol, items, labels: payload.labels });
        kind = "labels";
    } else {
        return actionableError(ERR.UNSUPPORTED_PAYLOAD_TYPE, `payload desconocido: ${type || "(sin type)"}`);
    }

    return sendBytes(connection, bytes, deps, { kind });
}

async function dispatchTestPage(payload, deps) {
    const config = payload?.config || {};
    const connection = config?.connection || payload?.connection;
    const connCheck = validateConnectionForPrint(connection);
    if (!connCheck.ok) return actionableError(connCheck.code, connCheck.message);
    const target = String(payload?.target || "").toLowerCase();
    const bytes = target === "label"
        ? buildTestPageLabel(config)
        : buildTestPageReceipt(config);
    return sendBytes(connection, bytes, deps, { kind: `test-${target || "receipt"}` });
}

async function dispatchKickDrawer(payload, deps) {
    const connection = payload?.connection;
    const connCheck = validateConnectionForPrint(connection);
    if (!connCheck.ok) return actionableError(connCheck.code, connCheck.message);
    // Cuando el llamador marca `openDrawerOnSale === true`, aplicamos las
    // mismas condiciones de `resolveAutoDrawerBytes` (drawer.enabled,
    // event ∈ {BEFORE_PRINT, AFTER_PRINT}, nunca MANUAL, command parseable).
    // Si cualquiera falla, respondemos OK sin enviar bytes: el kick "no
    // procede" no es un error — es la decisión del admin filtrando por
    // evento (BEFORE/AFTER/MANUAL) o deshabilitando el cajón. El frontend
    // ya hace el filtro, esto es defensa en profundidad.
    //
    // Si NO viene `openDrawerOnSale` (p.ej. botón admin "Probar cajón" en
    // /labels/config), seguimos el camino directo: parsear y enviar bytes
    // sin pedir contexto, porque el admin es la autoridad del test.
    const isAutoSale = payload?.openDrawerOnSale === true;
    if (isAutoSale) {
        const auto = resolveAutoDrawerBytes({
            drawer: payload.drawer,
            openDrawerOnSale: true,
            event: payload.event,
        });
        if (!auto) {
            return {
                ok: true,
                result: {
                    transport: "noop",
                    skipped: true,
                    reason: "drawer.event=MANUAL o drawer.enabled=false o comando inválido",
                    kind: "drawer",
                },
            };
        }
        return sendBytes(connection, auto.buf, deps, { kind: "drawer" });
    }
    const bytes = parseDrawerCommand(payload?.command || payload?.drawer?.command);
    return sendBytes(connection, bytes, deps, { kind: "drawer" });
}

async function sendBytes(connection, bytes, deps, info) {
    const transport = pickTransport(connection);
    if (transport.kind === "tcp") {
        try {
            const result = await deps.sendTcp(transport.host, transport.port, bytes, {
                timeoutMs: LIMITS.defaultTcpTimeoutMs,
            });
            return { ok: true, result: { transport: "tcp", bytes: bytes.length, ...info, ...result } };
        } catch (err) {
            return errFromThrow(err, ERR.TCP_ERROR);
        }
    }
    if (transport.kind === "system") {
        try {
            const result = await deps.sendSystem(transport.printerName, bytes, {
                timeoutMs: LIMITS.defaultSystemTimeoutMs,
            });
            return { ok: true, result: { transport: "system", bytes: bytes.length, ...info, ...result } };
        } catch (err) {
            return errFromThrow(err, ERR.SYSTEM_PRINT_FAILED);
        }
    }
    return actionableError(ERR.UNSUPPORTED_INTERFACE, `interface no soportada: ${transport.interface}`);
}

function actionableError(code, message) {
    return { ok: false, errorCode: code, error: message };
}

function errFromThrow(err, defaultCode) {
    const code = err && err.code && typeof err.code === "string" ? err.code : (defaultCode || ERR.INVALID_REQUEST);
    const message = err && err.message ? err.message : String(err);
    return { ok: false, errorCode: code, error: message };
}

// -----------------------------------------------------------------------------
// Exports
// -----------------------------------------------------------------------------

module.exports = {
    LIMITS,
    ERR,
    ESCPOS,
    CP850_MAP,
    DRAWER_EVENTS,
    encodeCP850,
    transliterate,
    parseDrawerCommand,
    cleanField,
    escapeForTspl,
    validateConnectionForPrint,
    pickTransport,
    buildReceiptBytes,
    buildTestPageReceipt,
    buildTestPageLabel,
    normalizeLabelItems,
    buildLabelBytes,
    buildEscposBatch,
    buildTsplBatch,
    encodeBarcode128,
    encodeBarcodeEAN13,
    resolveAutoDrawerBytes,
    validatePrinterRequest,
    isLocalOrigin,
    handlePrinterRequest,
    // Re-export del generador modular para que el frontend y los tests
    // puedan importar `mmToDots`, `computeColumnOffsets`, presets, etc.
    // desde un único punto estable.
    mmToDots: labelGen.mmToDots,
    computeColumnOffsets: labelGen.computeColumnOffsets,
    flattenLabelItems: labelGen.flattenLabelItems,
    buildRows: labelGen.buildRows,
    LABEL_PRESETS: labelGen.LABEL_PRESETS,
    DPI_203: labelGen.DPI_203,
    PHYSICAL_MAX_MM: labelGen.PHYSICAL_MAX_MM,
    sanitizeEan13: labelGen.sanitizeEan13,
    computeEan13CheckDigit: labelGen.computeEan13CheckDigit,
    // Expuestos para tests y para loguear números limpios en index.js
    _internals: { formatMoney, fitLine, center, clampInt },
};

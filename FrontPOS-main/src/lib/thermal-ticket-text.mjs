// =============================================================================
// src/lib/thermal-ticket-text.mjs
//
// Lógica pura y determinística para construir el TEXTO monoespaciado del
// ticket térmico. No lee LocalStorage, no toca DOM, no abre red: todo lo
// imperativo vive en `thermal-ticket.ts` (iframe de impresión, Canvas, etc.).
//
// Esta capa es importable por tests `node --test` sin ningún mock. El
// contrato que respeta `buildTicketText`:
//
//   - Sin `options`, la salida es BYTE A BYTE idéntica al comportamiento
//     histórico. Nadie puede cambiar ese contrato sin romper los
//     consumidores que todavía llaman `buildTicketText(data, width)` sin
//     opciones.
//   - Con `options`, honramos cada toggle (`showTaxes`, `thankYou`, `cut`,
//     `showValidationQR`) representando la realidad: nunca falseamos un
//     QR, nunca inventamos un logo si el llamador no mandó URL.
// =============================================================================

/** Encabezado por defecto del negocio. Puede ser pisado por `options.store`. */
export const STORE = Object.freeze({
    name: "SUPERMERCADO SURTIFAMILIAR",
    nit: "NIT 1.121.876.543-1",
    address: "Villavicencio, Meta",
    phone: "Tel. 320 000 0000",
});

/**
 * Caracteres por línea. 58 mm = 32 columnas; 80 mm = 48 columnas.
 * `override` permite valores custom (20..80) para rollos no estándar.
 */
export function charsPerLine(width, override) {
    if (typeof override === "number" && Number.isFinite(override) && override >= 20 && override <= 80) {
        return Math.round(override);
    }
    return width === "58mm" ? 32 : 48;
}

/** Formato colombiano simplificado: `$1.234` con punto como separador de miles. */
export function money(v) {
    const neg = Number(v) < 0;
    const digits = Math.round(Math.abs(Number(v) || 0)).toString();
    let out = "";
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
        out += digits[i];
    }
    return `${neg ? "-" : ""}$${out}`;
}

/** Rellena a la derecha con espacios (o trunca). */
export function pad(text, len) {
    const s = String(text);
    return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

/** Rellena a la izquierda con espacios (o trunca por la izquierda). */
export function padLeft(text, len) {
    const s = String(text);
    return s.length >= len ? s.slice(-len) : " ".repeat(len - s.length) + s;
}

/** Centra un texto en una franja de ancho `width`. */
export function center(text, width) {
    const s = String(text);
    if (s.length >= width) return s.slice(0, width);
    const left = Math.floor((width - s.length) / 2);
    return " ".repeat(left) + s;
}

/** Parte un texto largo en líneas de ancho `width` sin cortar palabras. */
export function wrap(text, width) {
    const words = String(text == null ? "" : text).split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";
    for (const w of words) {
        if (current === "") current = w;
        else if ((current + " " + w).length <= width) current += " " + w;
        else {
            lines.push(current);
            current = w;
        }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [""];
}

/**
 * Literal estable que `formatDateTime` emite cuando la entrada no se
 * puede interpretar como un `Date` válido. Es un contrato público:
 * consumidores que necesiten detectar "fecha ausente" pueden comparar
 * contra este símbolo en lugar de parsear la salida.
 */
export const INVALID_DATE_LABEL = "FECHA NO DISPONIBLE";

/**
 * Fecha legible en estilo `dd/MM/yyyy hh:mm AM`.
 *
 * Defensa pura contra fechas inválidas: cualquier entrada que no
 * resulte en un `Date` válido (undefined, null, string indescifrable,
 * `Invalid Date`, `NaN` numérico, objeto arbitrario...) devuelve el
 * literal estable {@link INVALID_DATE_LABEL}. Antes la función hacía
 * `d.getHours()` directo y acababa imprimiendo `NaN/NaN/NaN NaN:NaN NaN`
 * en una tirilla térmica real cuando `useNewSale.ts` guardaba
 * `new Date().toLocaleString()` (dependiente del locale del SO) y
 * `saleToTicket` lo reparseaba con `new Date(string)`.
 *
 * Acepta `Date`, string parseable (preferentemente ISO 8601) o un
 * número (epoch ms). El resto cae al literal — nunca se imprime `NaN`.
 */
export function formatDateTime(d) {
    const parsed = d instanceof Date
        ? d
        : (typeof d === "string" || typeof d === "number")
            ? new Date(d)
            : null;
    if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) {
        return INVALID_DATE_LABEL;
    }
    const p = (n) => String(n).padStart(2, "0");
    let h = parsed.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${p(parsed.getDate())}/${p(parsed.getMonth() + 1)}/${parsed.getFullYear()} ${p(h)}:${p(parsed.getMinutes())} ${ampm}`;
}

/**
 * Compone el encabezado real a imprimir fusionando el override del llamador
 * con el header configurado en /labels/config y los defaults del negocio.
 */
export function resolveStore(storeOverride, cfgHeader) {
    const so = storeOverride || null;
    const cg = cfgHeader || null;
    return {
        name: (so && so.name) || (cg && cg.name) || STORE.name,
        nit: (so && so.nit) || (cg && cg.nit) || STORE.nit,
        address: (so && so.address) || (cg && cg.address) || STORE.address,
        phone: (so && so.phone) || (cg && cg.phone) || STORE.phone,
    };
}

/**
 * Escapa un string para que sea seguro dentro de HTML (contenido y atributos).
 * Cubre `& < > " '`. NO valida esquemas de URL — para `src`/`href` el
 * llamador debe aplicar su propia whitelist si se necesita.
 */
export function escapeHtml(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Normaliza la opción `thankYou`: devuelve el string listo para pintar o
 * `null` cuando debe caerse al fallback histórico. El trim evita que un
 * "  " aparente ser contenido real.
 */
function normalizedThankYou(options) {
    if (!options || typeof options.thankYou !== "string") return null;
    const t = options.thankYou.trim();
    return t ? t : null;
}

/**
 * buildTicketText arma el ticket como TEXTO monoespaciado.
 *
 * Contrato de retrocompatibilidad: sin `options` la salida es idéntica a
 * la versión anterior. Esto es parte del contrato público — romperlo
 * cambia los PNGs que ya se compartieron por WhatsApp.
 */
export function buildTicketText(data, width = "58mm", options) {
    const W = charsPerLine(width, options && options.columns);
    const store = resolveStore(options && options.store);
    const sep = "-".repeat(W);
    const dotted = ".".repeat(W);
    const out = [];

    // --- Encabezado del negocio ---
    out.push(center(store.name, W));
    out.push(center(store.nit, W));
    out.push(center(store.address, W));
    out.push(center(store.phone, W));
    out.push(sep);

    // --- Datos de la transacción ---
    out.push(`TICKET #${data.ticketNumber}`);
    out.push(formatDateTime(data.date));
    out.push(`Cajero: ${(data.cashier || "N/D").toString().toUpperCase()}`);
    const client = (data.clientName || "CONSUMIDOR FINAL").toString().toUpperCase();
    out.push(`Cliente: ${client}`);
    if (data.clientDni) out.push(`CC/NIT: ${data.clientDni}`);
    if (data.clientPhone) out.push(`Tel: ${data.clientPhone}`);
    out.push(sep);

    // --- Detalle de productos ---
    // Columnas monetarias V.UNIT y TOTAL. Se recortan 1 columna cada una
    // cuando el ancho total `W` cae a 30 o menos: el TSPL 58 mm (48 mm
    // imprimibles) queda saneado a 26 columnas (punto medio font8 14x25
    // scaleY1) y los dos campos monetarios dejan al menos 9 chars al
    // nombre del producto. Para W >= 31 (defaults 32 y 48 — rollo 58/80
    // mm ESC/POS, 80/76 TSPL, 82/76 JAL_838L) se preservan BYTE A BYTE
    // los anchos históricos 9/10, que es lo que fija el contrato BC de
    // `buildTicketText(data, width)` sin options.
    const narrow = W <= 30;
    const priceCols = narrow ? 8 : 9;
    const totalCols = narrow ? 9 : 10;
    const nameCols = W - priceCols - totalCols;

    out.push(pad("CANT/PRODUCTO", nameCols) + padLeft("V.UNIT", priceCols) + padLeft("TOTAL", totalCols));
    out.push(sep);

    for (const l of data.lines) {
        const qty = Number.isInteger(l.quantity) ? String(l.quantity) : Number(l.quantity).toFixed(3);
        const nameLines = wrap(`${qty} x ${String(l.name || "").toUpperCase()}`, nameCols - 1);
        out.push(
            pad(nameLines[0], nameCols) +
            padLeft(money(l.unitPrice), priceCols) +
            padLeft(money(l.total), totalCols),
        );
        for (let i = 1; i < nameLines.length; i++) out.push("  " + nameLines[i]);
    }

    out.push(sep);

    // --- Resumen financiero ---
    const labelCols = W - totalCols;
    const row = (label, value) => pad(label, labelCols) + padLeft(value, totalCols);

    out.push(row("SUBTOTAL", money(data.subtotal)));

    // showTaxes: default (undefined) → mantiene BC (muestra la línea). Solo
    // `false` explícito la oculta. Esto hace que `buildTicketText(data)`
    // siga emitiendo IVA / IMPUESTOS como siempre.
    if (!options || options.showTaxes !== false) {
        out.push(row("IVA / IMPUESTOS", money(data.taxes || 0)));
    }

    out.push(sep);
    out.push(row("TOTAL A PAGAR", money(data.total)));
    out.push(sep);
    out.push(row("PAGO", (data.paymentMethod || "EFECTIVO").toString().toUpperCase()));
    if (data.received !== undefined) out.push(row("RECIBIDO", money(data.received)));
    if (data.change !== undefined) out.push(row("CAMBIO", money(data.change)));
    if (data.note) {
        out.push(sep);
        for (const l of wrap(data.note, W)) out.push(l);
    }

    // --- Pie de agradecimiento ---
    out.push(dotted);
    const thanks = normalizedThankYou(options);
    if (thanks) {
        for (const l of wrap(thanks, W)) {
            out.push(center(l, W));
        }
    } else {
        // Fallback histórico: dos líneas hardcoded. Mantiene BC exacto cuando
        // el llamador no pasa thankYou.
        out.push(center("Gracias por su compra en", W));
        out.push(center("SURTIFAMILIAR!", W));
    }
    out.push(dotted);

    // --- Enlace de validación en texto plano ---
    // Honramos showValidationQR SOLO cuando el llamador aporta una URL real.
    // Nunca fabricamos un QR escaneable: el texto térmico no puede
    // representarlo con honestidad y añadir una dependencia nueva está
    // fuera de alcance.
    if (options && options.showValidationQR && data && typeof data.validationUrl === "string") {
        const url = data.validationUrl.trim();
        if (url) {
            out.push(center("Validar en:", W));
            for (const l of wrap(url, W)) {
                out.push(center(l, W));
            }
            out.push(dotted);
        }
    }

    // --- Marcador de corte ---
    // El marcador es puramente textual: deja constancia para el cajero y la
    // auditoría de quién ejecuta el corte físico. Un valor `NONE` o
    // ausente deja el ticket limpio (BC).
    if (options && options.cut === "MANUAL") {
        out.push(center("-- CORTE MANUAL --", W));
    } else if (options && options.cut === "AUTO") {
        out.push(center("-- CORTE AUTOMATICO --", W));
    }

    return out.join("\n");
}

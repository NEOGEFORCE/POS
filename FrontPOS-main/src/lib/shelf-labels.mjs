// =============================================================================
// src/lib/shelf-labels.mjs
//
// Lógica pura para armar hojas de etiquetas de góndola (NO térmicas) en papel
// Letter con un grid fijo de 2 columnas x 6 filas (12 etiquetas por página).
//
// Contrato físico (inquebrantable):
//
//   - Etiqueta: 80mm x 40mm.
//   - Hoja: Letter portrait = 215.9mm x 279.4mm.
//   - Grid: 2 columnas x 6 filas, 12 slots por página, SIN gap entre slots.
//   - Padding físico de la hoja:
//       horizontal = (215.9mm - 2 * 80mm) / 2  = 27.95mm por lado
//       vertical   = (279.4mm - 6 * 40mm) / 2  = 19.7mm arriba/abajo
//   - La última página se rellena con slots `null` (etiquetas en blanco)
//     para mantener las guías del troquel/cuchilla; nunca se cambia la
//     cantidad de slots por página.
//
// Separación con etiquetas térmicas:
//
//   - El CSS térmico vive en `globals.css` dentro de `@media print` con
//     `@page { size: 80mm auto }`. Si imprimiéramos la hoja de góndola
//     con el mismo documento, esa regla ganaría y el navegador cortaría
//     la hoja al ancho térmico.
//   - Por eso `buildShelfLabelsPrintHtml` entrega un documento completo
//     (`<!DOCTYPE html> ... </html>`) con su propio `@page Letter margin 0`
//     que se inyecta en un iframe aislado — fuera del DOM principal — y
//     NO comparte estilos con la app.
//
// Seguridad:
//
//   - Todas las interpolaciones de texto en el HTML pasan por `escapeHtml`.
//     Nadie puede meter un `</style><script>...</script>` por el nombre
//     de un producto.
//
// Lo que NO hace este helper:
//
//   - No lee `localStorage`, no toca `document`, no abre red. Todo lo
//     imperativo (crear el iframe, invocar `print()`, limpiar la cola)
//     vive en `labels/page.tsx`.
//   - No valida que el `barcode` sea EAN13: la pantalla ya se encarga
//     de generar/asegurar el code vía `POST /labels/codes`.
// =============================================================================

/** Dimensiones físicas inmutables del formato góndola. */
export const SHEET_WIDTH_MM = 215.9;    // Letter portrait
export const SHEET_HEIGHT_MM = 279.4;   // Letter portrait
export const LABEL_WIDTH_MM = 80;       // ancho de cada etiqueta
export const LABEL_HEIGHT_MM = 40;      // alto de cada etiqueta
export const COLUMNS = 2;               // columnas por hoja
export const ROWS = 6;                  // filas por hoja
export const LABELS_PER_PAGE = COLUMNS * ROWS; // 12
export const PAGE_PADDING_X_MM = (SHEET_WIDTH_MM - COLUMNS * LABEL_WIDTH_MM) / 2;  // 27.95
export const PAGE_PADDING_Y_MM = (SHEET_HEIGHT_MM - ROWS * LABEL_HEIGHT_MM) / 2;   // 19.7

/** Identificador del layout en la metadata de auditoría /labels/print-jobs. */
export const LAYOUT_META_ID = "gondola-80x40-letter-2x6";

/**
 * Escapa un string para que sea seguro dentro de HTML (contenido y atributos).
 * Cubre `& < > " '`. Nunca debe inyectarse texto crudo en el HTML del iframe.
 *
 * @param {unknown} s
 * @returns {string}
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
 * Formatea un número como pesos colombianos con punto como separador
 * de miles, sin decimales, con prefijo `$`. Determinístico, sin
 * depender de `Intl` (que no está uniformemente disponible en Node).
 *
 * @param {number | string | null | undefined} v
 * @returns {string}
 */
export function formatCOP(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "$0";
    const neg = n < 0;
    const digits = Math.round(Math.abs(n)).toString();
    let out = "";
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
        out += digits[i];
    }
    return `${neg ? "-" : ""}$${out}`;
}

/**
 * Fecha en formato `dd/MM/yyyy` para el footer. Se pasa `now` explícita
 * para que los tests sean deterministas.
 *
 * @param {Date | string | number | undefined | null} now
 * @returns {string}
 */
export function formatPrintDate(now) {
    let d;
    if (now instanceof Date) d = now;
    else if (now != null) d = new Date(now);
    else d = new Date();
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * Trunca `value` a `max` caracteres con elipsis unicode. Devuelve el valor
 * original cuando ya cabe. Mantiene el string vacío intacto.
 *
 * @param {string} value
 * @param {number} max
 */
export function truncate(value, max) {
    const s = String(value == null ? "" : value);
    if (!Number.isFinite(max) || max <= 0) return s;
    if (s.length <= max) return s;
    return s.slice(0, Math.max(1, max - 1)) + "\u2026";
}

/**
 * Normaliza la cantidad: entero positivo >= 1. Cualquier otra cosa (NaN,
 * negativo, cero, decimal, string vacío) colapsa a 1.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeQuantity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    const i = Math.floor(n);
    return i >= 1 ? i : 1;
}

/**
 * Normaliza un ShelfLabelItem a la forma estricta que consumen el preview
 * y el print HTML.
 *
 * @param {Partial<import('./shelf-labels.d.mts').ShelfLabelItem> | null | undefined} item
 * @returns {import('./shelf-labels.d.mts').ShelfLabelItem | null}
 */
export function normalizeShelfLabelItem(item) {
    if (!item || typeof item !== "object") return null;
    const code = typeof item.code === "string" ? item.code.trim() : "";
    const productName = typeof item.productName === "string"
        ? item.productName.trim()
        : "";
    if (!productName && !code) return null;
    const salePrice = Number(item.salePrice);
    const normalized = {
        code: code || "",
        productName: productName || "ETIQUETA",
        salePrice: Number.isFinite(salePrice) ? salePrice : 0,
        quantity: normalizeQuantity(item.quantity),
    };
    if (typeof item.sku === "string" && item.sku.trim()) normalized.sku = item.sku.trim();
    if (typeof item.unit === "string" && item.unit.trim()) normalized.unit = item.unit.trim();
    return normalized;
}

/**
 * Expande una lista de items con `quantity` en una secuencia plana de
 * slots (uno por etiqueta física). Items inválidos se descartan sin
 * romper el resto. Items con `quantity: 0` deberían haber sido filtrados
 * aguas arriba, pero por si acaso también se descartan.
 *
 * @param {ReadonlyArray<Partial<import('./shelf-labels.d.mts').ShelfLabelItem>>} items
 * @returns {Array<import('./shelf-labels.d.mts').ShelfLabelSlot>}
 */
export function expandItemsToSlots(items) {
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const raw of items) {
        const n = normalizeShelfLabelItem(raw);
        if (!n) continue;
        for (let i = 0; i < n.quantity; i++) {
            out.push({
                code: n.code,
                productName: n.productName,
                salePrice: n.salePrice,
                sku: n.sku,
                unit: n.unit,
            });
        }
    }
    return out;
}

/**
 * Pagina una secuencia plana de slots en páginas de 12. La última página
 * se rellena con `null` para mantener la grilla y las guías del troquel.
 *
 * @param {ReadonlyArray<import('./shelf-labels.d.mts').ShelfLabelSlot>} slots
 * @returns {Array<Array<import('./shelf-labels.d.mts').ShelfLabelSlot | null>>}
 */
export function paginateSlots(slots) {
    if (!Array.isArray(slots) || slots.length === 0) return [];
    const pages = [];
    for (let i = 0; i < slots.length; i += LABELS_PER_PAGE) {
        const chunk = slots.slice(i, i + LABELS_PER_PAGE);
        while (chunk.length < LABELS_PER_PAGE) chunk.push(null);
        pages.push(chunk);
    }
    return pages;
}

/**
 * Resumen contable del lote: ideal para la cadena de UI
 * `X etiquetas en cola (Y páginas completas + Z sobrantes)`.
 *
 * @param {ReadonlyArray<Partial<import('./shelf-labels.d.mts').ShelfLabelItem>>} items
 * @returns {import('./shelf-labels.d.mts').ShelfLabelsSummary}
 */
export function summarizeShelfLabels(items) {
    const slots = expandItemsToSlots(items);
    const totalLabels = slots.length;
    const fullPages = Math.floor(totalLabels / LABELS_PER_PAGE);
    const remainder = totalLabels % LABELS_PER_PAGE;
    const totalPages = Math.ceil(totalLabels / LABELS_PER_PAGE);
    const blanks = totalLabels === 0 ? 0 : (LABELS_PER_PAGE - remainder) % LABELS_PER_PAGE;
    return {
        totalLabels,
        fullPages,
        remainder,
        totalPages,
        blanks,
        labelsPerPage: LABELS_PER_PAGE,
    };
}

// -----------------------------------------------------------------------------
// Composición del HTML del documento aislado para impresión.
// -----------------------------------------------------------------------------

/**
 * CSS del documento de impresión. Las dimensiones (grid 2x6, 80x40mm,
 * padding físico, borde dashed) viven aquí para que ningún guardián de
 * UI pueda hacerlas drift silencioso: cualquier cambio aparece como diff
 * y los tests estáticos lo congelan.
 *
 * `@page Letter margin 0` neutraliza los márgenes del navegador que, por
 * defecto, meten ~10mm y arruinan el troquel.
 *
 * @returns {string}
 */
export function buildShelfLabelsCss() {
    return `
        @page {
            size: Letter portrait;
            margin: 0;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
            width: ${SHEET_WIDTH_MM}mm;
            background: #ffffff;
            color: #000000;
            font-family: 'Helvetica Neue', Arial, Helvetica, sans-serif;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }
        .shelf-page {
            width: ${SHEET_WIDTH_MM}mm;
            height: ${SHEET_HEIGHT_MM}mm;
            padding: ${PAGE_PADDING_Y_MM}mm ${PAGE_PADDING_X_MM}mm;
            display: grid;
            grid-template-columns: repeat(${COLUMNS}, ${LABEL_WIDTH_MM}mm);
            grid-template-rows: repeat(${ROWS}, ${LABEL_HEIGHT_MM}mm);
            gap: 0;
            page-break-after: always;
            break-after: page;
        }
        .shelf-page:last-child {
            page-break-after: auto;
            break-after: auto;
        }
        .shelf-slot {
            width: ${LABEL_WIDTH_MM}mm;
            height: ${LABEL_HEIGHT_MM}mm;
            border: 0.2mm dashed #c4c4c4;
            padding: 2.5mm 3mm;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            overflow: hidden;
        }
        .shelf-slot.is-blank {
            /* Blanks mantienen el borde discreto para que el usuario vea las
               guías de corte en la última página. */
        }
        .shelf-name {
            font-size: 11pt;
            font-weight: 700;
            line-height: 1.1;
            color: #000;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
            text-overflow: ellipsis;
            word-break: break-word;
            max-height: 2.6em;
        }
        .shelf-price {
            font-size: 26pt;
            font-weight: 900;
            color: #000;
            text-align: center;
            line-height: 1;
            letter-spacing: -0.5px;
        }
        .shelf-footer {
            font-size: 7.5pt;
            font-weight: 600;
            color: #000;
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            gap: 2mm;
        }
        .shelf-footer-left,
        .shelf-footer-right {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }
        .shelf-footer-right { text-align: right; }
        @media screen {
            body { padding: 10mm; background: #e5e5e5; }
            .shelf-page {
                box-shadow: 0 2px 12px rgba(0,0,0,0.15);
                margin: 0 auto 10mm auto;
                background: #ffffff;
            }
        }
    `.trim();
}

/**
 * Construye el HTML de un slot (etiqueta no vacía) o un blank (slot `null`).
 * TODO el contenido dinámico pasa por `escapeHtml`.
 *
 * @param {import('./shelf-labels.d.mts').ShelfLabelSlot | null} slot
 * @param {string} dateLabel
 * @returns {string}
 */
export function buildSlotHtml(slot, dateLabel) {
    if (!slot) {
        return `<div class="shelf-slot is-blank" aria-hidden="true"></div>`;
    }
    const name = escapeHtml(truncate(slot.productName, 64));
    const price = escapeHtml(formatCOP(slot.salePrice));
    const codeOrSku = slot.sku ? slot.sku : slot.code;
    const footerLeft = escapeHtml(truncate(codeOrSku || "", 20));
    const unit = slot.unit ? slot.unit : "UND";
    const footerRight = escapeHtml(`${truncate(unit, 10)} · ${dateLabel}`);
    return [
        `<div class="shelf-slot">`,
        `<div class="shelf-name">${name}</div>`,
        `<div class="shelf-price">${price}</div>`,
        `<div class="shelf-footer">`,
        `<span class="shelf-footer-left">${footerLeft}</span>`,
        `<span class="shelf-footer-right">${footerRight}</span>`,
        `</div>`,
        `</div>`,
    ].join("");
}

/**
 * Construye el HTML completo del documento aislado que irá al iframe.
 * Incluye `@page Letter margin 0` propio para que el `@media print`
 * térmico de `globals.css` no interfiera.
 *
 * @param {ReadonlyArray<Partial<import('./shelf-labels.d.mts').ShelfLabelItem>>} items
 * @param {{ now?: Date | string | number }} [opts]
 * @returns {string}
 */
export function buildShelfLabelsPrintHtml(items, opts = {}) {
    const slots = expandItemsToSlots(items);
    const pages = paginateSlots(slots);
    const dateLabel = formatPrintDate(opts.now);
    const css = buildShelfLabelsCss();

    const pagesHtml = pages.length === 0
        ? ""
        : pages
            .map((page) => {
                const slotsHtml = page.map((slot) => buildSlotHtml(slot, dateLabel)).join("");
                return `<section class="shelf-page" role="group" aria-label="Hoja de etiquetas de góndola">${slotsHtml}</section>`;
            })
            .join("");

    return [
        `<!DOCTYPE html>`,
        `<html lang="es">`,
        `<head>`,
        `<meta charset="utf-8" />`,
        `<meta name="viewport" content="width=device-width, initial-scale=1" />`,
        `<title>Etiquetas de góndola</title>`,
        `<style>${css}</style>`,
        `</head>`,
        `<body>${pagesHtml}</body>`,
        `</html>`,
    ].join("");
}

/**
 * Mete en el formulario de impresión de auditoría la metadata obligatoria
 * del layout. El page.tsx la concatena al `payload.meta` que viaja al
 * endpoint `POST /labels/print-jobs`.
 *
 * @param {Record<string, unknown>} [extra]
 * @returns {{ layout: string } & Record<string, unknown>}
 */
export function buildAuditMeta(extra) {
    const base = { layout: LAYOUT_META_ID };
    if (extra && typeof extra === "object") {
        return { ...extra, ...base };
    }
    return base;
}

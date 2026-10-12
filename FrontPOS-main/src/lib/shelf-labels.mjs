// =============================================================================
// src/lib/shelf-labels.mjs
//
// Lógica pura para armar hojas de etiquetas de góndola (NO térmicas) con
// impresora normal mediante el diálogo del navegador. Cada etiqueta mide
// 80x40 mm. La hoja se maquieta en orientación LANDSCAPE para maximizar
// la cantidad de etiquetas por hoja:
//
//   * LETTER landscape (default) → 279.4 × 215.9 mm, grid 3 × 5 = 15.
//     Padding X = (279.4 - 3*80)/2 = 19.7 mm por lado.
//     Padding Y = (215.9 - 5*40)/2 =  7.95 mm por lado.
//   * LEGAL / OFICIO landscape    → 355.6 × 215.9 mm, grid 4 × 5 = 20.
//     Padding X = (355.6 - 4*80)/2 = 17.8 mm por lado.
//     Padding Y = (215.9 - 5*40)/2 =  7.95 mm por lado.
//
// El formato activo lo decide el consumidor (hoy, la rama `gondola.format`
// de `printing-config.mjs`). Toda la geometría se deriva de ese formato con
// `resolveGondolaLayout(format)` para no duplicar números físicos: ni
// buildShelfLabelsCss, ni paginateSlots, ni summarizeShelfLabels, ni
// buildAuditMeta, ni buildShelfLabelsPrintHtml duplican dimensiones ni
// cantidad de slots por página.
//
// Separación con etiquetas térmicas:
//
//   - El CSS térmico vive en `globals.css` dentro de `@media print` con
//     `@page { size: 80mm auto }`. Si imprimiéramos la hoja de góndola
//     con el mismo documento, esa regla ganaría y el navegador cortaría
//     la hoja al ancho térmico.
//   - Por eso `buildShelfLabelsPrintHtml` entrega un documento completo
//     (`<!DOCTYPE html> ... </html>`) con su propio
//     `@page { size: Letter landscape; margin: 0; }` o
//     `@page { size: Legal landscape; margin: 0; }` que se inyecta en un
//     iframe aislado — fuera del DOM principal — y NO comparte estilos
//     con la app. La impresión usa el diálogo normal del navegador vía
//     `iframe.contentWindow.print()`, nunca el bridge térmico.
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
//     vive en `labels/components/LabelsWorkspace.tsx`.
//   - No valida que el `barcode` sea EAN13: la pantalla ya se encarga
//     de generar/asegurar el code vía `POST /labels/codes`.
// =============================================================================

/** Dimensiones físicas inmutables de la etiqueta individual (todas las hojas). */
export const LABEL_WIDTH_MM = 80;
export const LABEL_HEIGHT_MM = 40;

/**
 * Formatos de hoja soportados para precios de góndola. El default es
 * `LETTER` (Carta) y es el único que se instala sin opt-in del admin.
 */
export const GONDOLA_FORMATS = Object.freeze({
    LETTER: "LETTER",
    LEGAL: "LEGAL",
});

export const DEFAULT_GONDOLA_FORMAT = GONDOLA_FORMATS.LETTER;

/**
 * Especificaciones físicas por formato. Son la única fuente de verdad:
 * `resolveGondolaLayout` deriva el padding, meta id, columnas/filas y
 * cantidad de slots por página desde este mapa.
 *
 * `cssPageSize` corresponde al valor del `size:` de la regla `@page` que
 * entrega al navegador. Usamos los nombres canónicos de CSS Paged Media
 * (`Letter`, `Legal`) junto con `landscape` para que Chromium/Firefox/
 * Edge reconozcan la orientación nativa (si el nombre falla por falta de
 * soporte, el navegador cae a dimensiones literales del contenedor).
 */
export const GONDOLA_FORMAT_SPECS = Object.freeze({
    LETTER: Object.freeze({
        id: "LETTER",
        label: "Carta",
        sheetWidthMm: 279.4,
        sheetHeightMm: 215.9,
        columns: 3,
        rows: 5,
        labelsPerPage: 15,
        cssPageSize: "Letter landscape",
        layoutMetaId: "gondola-80x40-letter-landscape-3x5",
        sheetLabel: "letter-landscape",
    }),
    LEGAL: Object.freeze({
        id: "LEGAL",
        label: "Oficio / Legal",
        sheetWidthMm: 355.6,
        sheetHeightMm: 215.9,
        columns: 4,
        rows: 5,
        labelsPerPage: 20,
        cssPageSize: "Legal landscape",
        layoutMetaId: "gondola-80x40-legal-landscape-4x5",
        sheetLabel: "legal-landscape",
    }),
});

/**
 * Normaliza un input (string arbitrario, undefined, null, un objeto con
 * `.format`) a uno de los formatos canónicos. Cualquier cosa desconocida
 * cae al default seguro `LETTER`.
 *
 * @param {unknown} input
 * @returns {"LETTER"|"LEGAL"}
 */
export function resolveGondolaFormat(input) {
    if (!input) return DEFAULT_GONDOLA_FORMAT;
    const raw = typeof input === "string"
        ? input
        : typeof input === "object" && typeof (/** @type {any} */ (input).format) === "string"
            ? /** @type {any} */ (input).format
            : "";
    const normalized = String(raw).trim().toUpperCase();
    if (normalized === "LETTER" || normalized === "CARTA") return GONDOLA_FORMATS.LETTER;
    if (normalized === "LEGAL" || normalized === "OFICIO") return GONDOLA_FORMATS.LEGAL;
    return DEFAULT_GONDOLA_FORMAT;
}

/**
 * Devuelve la geometría completa (dimensiones, padding, meta id, etc.)
 * calculada a partir del formato indicado. Todas las funciones que
 * necesitan dimensiones físicas DEBEN pasar por acá para no duplicar
 * números.
 *
 * @param {unknown} format
 */
export function resolveGondolaLayout(format) {
    const key = resolveGondolaFormat(format);
    const spec = GONDOLA_FORMAT_SPECS[key];
    const paddingXMm = (spec.sheetWidthMm - spec.columns * LABEL_WIDTH_MM) / 2;
    const paddingYMm = (spec.sheetHeightMm - spec.rows * LABEL_HEIGHT_MM) / 2;
    return {
        format: spec.id,
        label: spec.label,
        sheetWidthMm: spec.sheetWidthMm,
        sheetHeightMm: spec.sheetHeightMm,
        labelWidthMm: LABEL_WIDTH_MM,
        labelHeightMm: LABEL_HEIGHT_MM,
        columns: spec.columns,
        rows: spec.rows,
        labelsPerPage: spec.labelsPerPage,
        paddingXMm,
        paddingYMm,
        cssPageSize: spec.cssPageSize,
        layoutMetaId: spec.layoutMetaId,
        sheetLabel: spec.sheetLabel,
    };
}

// -----------------------------------------------------------------------------
// Alias retrocompatibles basados en el formato DEFAULT (Letter landscape).
// -----------------------------------------------------------------------------
// Mantener estos exports evita romper tests y previews que consultan la
// geometría canónica del default. Para formatos distintos usar
// `resolveGondolaLayout(format)`.

const DEFAULT_LAYOUT = resolveGondolaLayout(DEFAULT_GONDOLA_FORMAT);

export const SHEET_WIDTH_MM = DEFAULT_LAYOUT.sheetWidthMm;
export const SHEET_HEIGHT_MM = DEFAULT_LAYOUT.sheetHeightMm;
export const COLUMNS = DEFAULT_LAYOUT.columns;
export const ROWS = DEFAULT_LAYOUT.rows;
export const LABELS_PER_PAGE = DEFAULT_LAYOUT.labelsPerPage;
export const PAGE_PADDING_X_MM = DEFAULT_LAYOUT.paddingXMm;
export const PAGE_PADDING_Y_MM = DEFAULT_LAYOUT.paddingYMm;
export const LAYOUT_META_ID = DEFAULT_LAYOUT.layoutMetaId;

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
 * Pagina una secuencia plana de slots en páginas del tamaño dictado por
 * el formato (`labelsPerPage`). La última página se rellena con `null`
 * para mantener la grilla y las guías del troquel.
 *
 * @param {ReadonlyArray<import('./shelf-labels.d.mts').ShelfLabelSlot>} slots
 * @param {unknown} [format]
 * @returns {Array<Array<import('./shelf-labels.d.mts').ShelfLabelSlot | null>>}
 */
export function paginateSlots(slots, format) {
    const layout = resolveGondolaLayout(format);
    if (!Array.isArray(slots) || slots.length === 0) return [];
    const pages = [];
    for (let i = 0; i < slots.length; i += layout.labelsPerPage) {
        const chunk = slots.slice(i, i + layout.labelsPerPage);
        while (chunk.length < layout.labelsPerPage) chunk.push(null);
        pages.push(chunk);
    }
    return pages;
}

/**
 * Resumen contable del lote: ideal para la cadena de UI
 * `X etiquetas en cola (Y páginas completas + Z sobrantes)`. La cantidad
 * de slots por página y la metadata del formato quedan incluidas para
 * que el consumidor NO vuelva a resolverlas por su cuenta.
 *
 * @param {ReadonlyArray<Partial<import('./shelf-labels.d.mts').ShelfLabelItem>>} items
 * @param {unknown} [format]
 * @returns {import('./shelf-labels.d.mts').ShelfLabelsSummary}
 */
export function summarizeShelfLabels(items, format) {
    const layout = resolveGondolaLayout(format);
    const slots = expandItemsToSlots(items);
    const totalLabels = slots.length;
    const perPage = layout.labelsPerPage;
    const fullPages = Math.floor(totalLabels / perPage);
    const remainder = totalLabels % perPage;
    const totalPages = Math.ceil(totalLabels / perPage);
    const blanks = totalLabels === 0 ? 0 : (perPage - remainder) % perPage;
    return {
        format: layout.format,
        totalLabels,
        fullPages,
        remainder,
        totalPages,
        blanks,
        labelsPerPage: perPage,
        layout: layout.layoutMetaId,
    };
}

// -----------------------------------------------------------------------------
// Composición del HTML del documento aislado para impresión.
// -----------------------------------------------------------------------------

/**
 * CSS del documento de impresión. Las dimensiones (grid dinámico, 80x40mm,
 * padding físico, borde dashed) viven aquí para que ningún guardián de
 * UI pueda hacerlas drift silencioso: cualquier cambio aparece como diff
 * y los tests estáticos lo congelan.
 *
 * `@page { size: Letter|Legal landscape; margin: 0 }` neutraliza los
 * márgenes del navegador que, por defecto, meten ~10mm y arruinan el
 * troquel.
 *
 * @param {unknown} [format]
 * @returns {string}
 */
export function buildShelfLabelsCss(format) {
    const layout = resolveGondolaLayout(format);
    // `paddingXMm` / `paddingYMm` provienen de una resta en punto flotante
    // ((279.4 - 3*80)/2 = 19.7 teórico pero 19.700000000000003 en IEEE 754).
    // Redondeamos a 2 decimales para que el CSS exponga números legibles
    // y los tests estáticos puedan verificar valores canónicos sin tolerancia.
    const mm = (value) => `${Math.round(value * 100) / 100}mm`;
    return `
        @page {
            size: ${layout.cssPageSize};
            margin: 0;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
            width: ${mm(layout.sheetWidthMm)};
            background: #ffffff;
            color: #000000;
            font-family: 'Helvetica Neue', Arial, Helvetica, sans-serif;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }
        .shelf-page {
            width: ${mm(layout.sheetWidthMm)};
            height: ${mm(layout.sheetHeightMm)};
            padding: ${mm(layout.paddingYMm)} ${mm(layout.paddingXMm)};
            display: grid;
            grid-template-columns: repeat(${layout.columns}, ${layout.labelWidthMm}mm);
            grid-template-rows: repeat(${layout.rows}, ${layout.labelHeightMm}mm);
            gap: 0;
            page-break-after: always;
            break-after: page;
        }
        .shelf-page:last-child {
            page-break-after: auto;
            break-after: auto;
        }
        .shelf-slot {
            width: ${layout.labelWidthMm}mm;
            height: ${layout.labelHeightMm}mm;
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
 * Incluye `@page { size: Letter|Legal landscape; margin: 0 }` propio para
 * que el `@media print` térmico de `globals.css` no interfiera.
 *
 * Opciones:
 *   - `now`    : fecha a estampar en el footer (deterministic en tests).
 *   - `format` : "LETTER" | "LEGAL". Default `LETTER`.
 *
 * @param {ReadonlyArray<Partial<import('./shelf-labels.d.mts').ShelfLabelItem>>} items
 * @param {{ now?: Date | string | number, format?: unknown }} [opts]
 * @returns {string}
 */
export function buildShelfLabelsPrintHtml(items, opts = {}) {
    const layout = resolveGondolaLayout(opts.format);
    const slots = expandItemsToSlots(items);
    const pages = paginateSlots(slots, layout.format);
    const dateLabel = formatPrintDate(opts.now);
    const css = buildShelfLabelsCss(layout.format);

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
        `<html lang="es" data-gondola-format="${escapeHtml(layout.format)}" data-gondola-layout="${escapeHtml(layout.layoutMetaId)}">`,
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
 * del layout. El consumidor la concatena al `payload.meta` que viaja al
 * endpoint `POST /labels/print-jobs`. El layout canónico y las dimensiones
 * NO pueden ser pisadas por el caller: el helper las impone siempre al
 * final del merge.
 *
 * @param {Record<string, unknown> | null | undefined} [extra]
 * @param {unknown} [format]
 */
export function buildAuditMeta(extra, format) {
    const layout = resolveGondolaLayout(format);
    const canonical = {
        layout: layout.layoutMetaId,
        format: layout.format,
        sheet: layout.sheetLabel,
        sheetWidthMm: layout.sheetWidthMm,
        sheetHeightMm: layout.sheetHeightMm,
        labelWidthMm: layout.labelWidthMm,
        labelHeightMm: layout.labelHeightMm,
        columns: layout.columns,
        rows: layout.rows,
        labelsPerPage: layout.labelsPerPage,
    };
    if (extra && typeof extra === "object") {
        return { ...extra, ...canonical };
    }
    return canonical;
}

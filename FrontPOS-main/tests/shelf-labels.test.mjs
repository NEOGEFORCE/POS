// =============================================================================
// tests/shelf-labels.test.mjs
//
// Pruebas exhaustivas del helper puro `src/lib/shelf-labels.mjs`.
//
// Cubre:
//   - Normalización y expansión de cantidades (0/1/12/13/25).
//   - Paginación en bloques de 12 con blanks null al final.
//   - Resumen contable (fullPages, remainder, totalPages, blanks).
//   - Escape HTML sobre nombre, SKU, unidad y código.
//   - Dimensiones físicas inmutables (CSS en mm).
//   - CSS incluye @page Letter con margin 0, grid 2x6 sin gap.
//   - Page breaks (page-break-after: always, break-after: page).
//   - formatCOP determinístico.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
    COLUMNS,
    LABELS_PER_PAGE,
    LABEL_HEIGHT_MM,
    LABEL_WIDTH_MM,
    LAYOUT_META_ID,
    PAGE_PADDING_X_MM,
    PAGE_PADDING_Y_MM,
    ROWS,
    SHEET_HEIGHT_MM,
    SHEET_WIDTH_MM,
    buildAuditMeta,
    buildShelfLabelsCss,
    buildShelfLabelsPrintHtml,
    buildSlotHtml,
    escapeHtml,
    expandItemsToSlots,
    formatCOP,
    formatPrintDate,
    normalizeQuantity,
    normalizeShelfLabelItem,
    paginateSlots,
    summarizeShelfLabels,
    truncate,
} from "../src/lib/shelf-labels.mjs";

// -----------------------------------------------------------------------------
// Constantes físicas: congeladas por el requisito del operador.
// -----------------------------------------------------------------------------
test("constantes físicas: Letter portrait + 2x6 + 80x40", () => {
    assert.equal(SHEET_WIDTH_MM, 215.9, "ancho de hoja Letter en mm");
    assert.equal(SHEET_HEIGHT_MM, 279.4, "alto de hoja Letter en mm");
    assert.equal(LABEL_WIDTH_MM, 80, "ancho de etiqueta en mm");
    assert.equal(LABEL_HEIGHT_MM, 40, "alto de etiqueta en mm");
    assert.equal(COLUMNS, 2, "columnas por hoja");
    assert.equal(ROWS, 6, "filas por hoja");
    assert.equal(LABELS_PER_PAGE, 12, "12 slots por hoja");
    // Padding calculado explícitamente para que un cambio accidental grite.
    assert.ok(Math.abs(PAGE_PADDING_X_MM - 27.95) < 1e-9,
        `padding horizontal debe ser 27.95mm, encontrado ${PAGE_PADDING_X_MM}`);
    assert.ok(Math.abs(PAGE_PADDING_Y_MM - 19.7) < 1e-9,
        `padding vertical debe ser 19.7mm, encontrado ${PAGE_PADDING_Y_MM}`);
    assert.equal(LAYOUT_META_ID, "gondola-80x40-letter-2x6",
        "el id de layout va a /labels/print-jobs y no puede derivar");
});

// -----------------------------------------------------------------------------
// Normalización
// -----------------------------------------------------------------------------
test("normalizeQuantity: entero positivo >= 1 o fallback 1", () => {
    assert.equal(normalizeQuantity(1), 1);
    assert.equal(normalizeQuantity(5), 5);
    assert.equal(normalizeQuantity(0), 1, "0 colapsa a 1");
    assert.equal(normalizeQuantity(-3), 1, "negativo colapsa a 1");
    assert.equal(normalizeQuantity(2.7), 2, "decimal se trunca con floor");
    assert.equal(normalizeQuantity(NaN), 1);
    assert.equal(normalizeQuantity(undefined), 1);
    assert.equal(normalizeQuantity(null), 1);
    assert.equal(normalizeQuantity(""), 1);
    assert.equal(normalizeQuantity("4"), 4);
});

test("normalizeShelfLabelItem: descarta items inválidos y aplica defaults", () => {
    assert.equal(normalizeShelfLabelItem(null), null);
    assert.equal(normalizeShelfLabelItem(undefined), null);
    assert.equal(normalizeShelfLabelItem({}), null, "sin code ni productName se descarta");

    const item = normalizeShelfLabelItem({
        code: " LBL-001 ",
        productName: " ARROZ DIANA ",
        salePrice: "3500",
        quantity: 3,
        unit: "KG",
        sku: "SKU-X",
    });
    assert.equal(item.code, "LBL-001", "trim del code");
    assert.equal(item.productName, "ARROZ DIANA", "trim del nombre");
    assert.equal(item.salePrice, 3500, "salePrice castea desde string");
    assert.equal(item.quantity, 3);
    assert.equal(item.unit, "KG");
    assert.equal(item.sku, "SKU-X");

    const sinSalePrice = normalizeShelfLabelItem({ code: "LBL-2", productName: "X", salePrice: "no-num" });
    assert.equal(sinSalePrice.salePrice, 0, "salePrice inválido cae a 0");
    assert.equal(sinSalePrice.quantity, 1, "quantity default es 1");
});

// -----------------------------------------------------------------------------
// Expansión y paginación: casos 0, 1, 12, 13, 25
// -----------------------------------------------------------------------------
function it(code, qty) {
    return { code, productName: `P-${code}`, salePrice: 1000 + qty, quantity: qty };
}

test("expandItemsToSlots: cola vacía produce 0 slots", () => {
    assert.deepEqual(expandItemsToSlots([]), [], "lista vacía");
    assert.deepEqual(expandItemsToSlots(null), [], "null no rompe");
    assert.deepEqual(expandItemsToSlots(undefined), [], "undefined no rompe");
    assert.deepEqual(expandItemsToSlots("not an array"), [], "no array no rompe");
});

test("expandItemsToSlots: 1 item con cantidad N produce N slots clonados", () => {
    const slots = expandItemsToSlots([it("A", 5)]);
    assert.equal(slots.length, 5);
    for (const s of slots) {
        assert.equal(s.code, "A");
        assert.equal(s.productName, "P-A");
    }
});

test("expandItemsToSlots: items inválidos se descartan sin romper el resto", () => {
    const slots = expandItemsToSlots([
        it("A", 2),
        null,
        { nope: true },
        it("B", 1),
    ]);
    assert.equal(slots.length, 3);
    assert.equal(slots[0].code, "A");
    assert.equal(slots[1].code, "A");
    assert.equal(slots[2].code, "B");
});

test("paginateSlots: 0 slots → 0 páginas", () => {
    assert.deepEqual(paginateSlots([]), []);
    assert.deepEqual(paginateSlots(null), []);
});

test("paginateSlots: 1 slot → 1 página con 11 blanks", () => {
    const slots = expandItemsToSlots([it("A", 1)]);
    const pages = paginateSlots(slots);
    assert.equal(pages.length, 1, "una página");
    assert.equal(pages[0].length, LABELS_PER_PAGE, "siempre 12 celdas");
    assert.equal(pages[0][0].code, "A");
    for (let i = 1; i < LABELS_PER_PAGE; i++) {
        assert.equal(pages[0][i], null, `celda ${i} debe ser blank null`);
    }
});

test("paginateSlots: 12 slots → 1 página, 0 blanks", () => {
    const slots = expandItemsToSlots([it("A", 12)]);
    const pages = paginateSlots(slots);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].length, 12);
    assert.equal(pages[0].filter(s => s === null).length, 0, "no blanks cuando cabe exacto");
});

test("paginateSlots: 13 slots → 2 páginas, segunda con 11 blanks", () => {
    const slots = expandItemsToSlots([it("A", 13)]);
    const pages = paginateSlots(slots);
    assert.equal(pages.length, 2, "dos páginas");
    assert.equal(pages[0].length, 12);
    assert.equal(pages[1].length, 12);
    assert.equal(pages[0].filter(s => s === null).length, 0, "primera página llena");
    assert.equal(pages[1].filter(s => s === null).length, 11, "segunda tiene 11 blanks");
    assert.equal(pages[1][0].code, "A", "primer slot de la segunda página es real");
    for (let i = 1; i < 12; i++) {
        assert.equal(pages[1][i], null, `celda ${i} es blank`);
    }
});

test("paginateSlots: 25 slots → 3 páginas, última con 11 blanks", () => {
    const slots = expandItemsToSlots([it("A", 10), it("B", 10), it("C", 5)]);
    assert.equal(slots.length, 25);
    const pages = paginateSlots(slots);
    assert.equal(pages.length, 3);
    assert.equal(pages[0].filter(s => s === null).length, 0);
    assert.equal(pages[1].filter(s => s === null).length, 0);
    assert.equal(pages[2].filter(s => s === null).length, 11,
        "25 slots dejan 1 real y 11 blanks en la tercera página");
    assert.equal(pages[2].filter(s => s !== null).length, 1, "sólo 1 slot real en la tercera");
    assert.equal(pages[2][0].code, "C");
});

// -----------------------------------------------------------------------------
// summarizeShelfLabels: alimentador del contador de la UI
// -----------------------------------------------------------------------------
test("summarizeShelfLabels: 0 ítems → todo cero", () => {
    const s = summarizeShelfLabels([]);
    assert.deepEqual(s, {
        totalLabels: 0,
        fullPages: 0,
        remainder: 0,
        totalPages: 0,
        blanks: 0,
        labelsPerPage: 12,
    });
});

test("summarizeShelfLabels: 1 → 0 páginas completas + 1 sobrante + 1 total", () => {
    const s = summarizeShelfLabels([it("A", 1)]);
    assert.equal(s.totalLabels, 1);
    assert.equal(s.fullPages, 0);
    assert.equal(s.remainder, 1);
    assert.equal(s.totalPages, 1);
    assert.equal(s.blanks, 11);
});

test("summarizeShelfLabels: 12 → 1 completa + 0 sobrantes + 0 blanks", () => {
    const s = summarizeShelfLabels([it("A", 12)]);
    assert.equal(s.totalLabels, 12);
    assert.equal(s.fullPages, 1);
    assert.equal(s.remainder, 0);
    assert.equal(s.totalPages, 1);
    assert.equal(s.blanks, 0);
});

test("summarizeShelfLabels: 13 → 1 completa + 1 sobrante + 2 totales + 11 blanks", () => {
    const s = summarizeShelfLabels([it("A", 13)]);
    assert.equal(s.totalLabels, 13);
    assert.equal(s.fullPages, 1);
    assert.equal(s.remainder, 1);
    assert.equal(s.totalPages, 2);
    assert.equal(s.blanks, 11);
});

test("summarizeShelfLabels: 25 → 2 completas + 1 sobrante + 3 totales + 11 blanks", () => {
    const s = summarizeShelfLabels([it("A", 10), it("B", 10), it("C", 5)]);
    assert.equal(s.totalLabels, 25);
    assert.equal(s.fullPages, 2);
    assert.equal(s.remainder, 1);
    assert.equal(s.totalPages, 3);
    assert.equal(s.blanks, 11);
});

// -----------------------------------------------------------------------------
// Formateo auxiliar
// -----------------------------------------------------------------------------
test("formatCOP: formato colombiano determinístico", () => {
    assert.equal(formatCOP(0), "$0");
    assert.equal(formatCOP(100), "$100");
    assert.equal(formatCOP(1000), "$1.000");
    assert.equal(formatCOP(12345), "$12.345");
    assert.equal(formatCOP(1234567), "$1.234.567");
    assert.equal(formatCOP(1500.6), "$1.501", "redondea");
    assert.equal(formatCOP(-5000), "-$5.000", "negativo lleva signo delante");
    assert.equal(formatCOP(NaN), "$0", "NaN cae a $0");
    assert.equal(formatCOP(null), "$0");
    assert.equal(formatCOP("3500"), "$3.500", "acepta string numérico");
});

test("truncate: respeta longitud y usa elipsis unicode", () => {
    assert.equal(truncate("hola", 10), "hola");
    assert.equal(truncate("hola mundo", 5), "hola\u2026");
    assert.equal(truncate("", 10), "");
    assert.equal(truncate(null, 10), "");
    assert.equal(truncate("x", 0), "x", "max<=0 devuelve tal cual");
});

test("formatPrintDate: dd/MM/yyyy con padding", () => {
    const d = new Date(2026, 0, 3); // 3 ene 2026 — mes 0-indexado
    assert.equal(formatPrintDate(d), "03/01/2026");
    const d2 = new Date(2025, 11, 15); // 15 dic 2025
    assert.equal(formatPrintDate(d2), "15/12/2025");
});

// -----------------------------------------------------------------------------
// Escape HTML
// -----------------------------------------------------------------------------
test("escapeHtml: cubre & < > \" '", () => {
    assert.equal(
        escapeHtml(`<script>alert("x")</script>`),
        "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    assert.equal(escapeHtml("A & B"), "A &amp; B");
    assert.equal(escapeHtml("O'Brien"), "O&#39;Brien");
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
    assert.equal(escapeHtml(123), "123");
});

test("buildSlotHtml: nombre, SKU, unidad y código se escapan contra inyección", () => {
    const html = buildSlotHtml({
        code: `C<&>"'C`,
        productName: `<img onerror="x">`,
        salePrice: 1500,
        sku: `S<K&U>'`,
        unit: `U<N&T>`,
    }, "01/01/2026");
    assert.ok(!html.includes("<img onerror"), "nombre no se inyecta como HTML");
    assert.ok(!html.includes(`"'C`), "comilla cruda no debe aparecer");
    assert.ok(html.includes("&lt;img"), "nombre escapado");
    assert.ok(html.includes("&amp;"), "ampersand escapado");
    assert.ok(html.includes("&quot;"), "comilla doble escapada");
    assert.ok(html.includes("&#39;"), "comilla simple escapada");
});

test("buildSlotHtml: blank (null) genera slot vacío con la misma clase", () => {
    const html = buildSlotHtml(null, "01/01/2026");
    assert.ok(/class="shelf-slot is-blank"/.test(html), "clase .is-blank en blanks");
    assert.ok(/aria-hidden="true"/.test(html), "blanks son aria-hidden");
});

// -----------------------------------------------------------------------------
// CSS del documento aislado: dimensiones y @page Letter
// -----------------------------------------------------------------------------
test("buildShelfLabelsCss: contiene @page Letter portrait + margin 0", () => {
    const css = buildShelfLabelsCss();
    assert.match(css, /@page\s*{[^}]*size:\s*Letter\s+portrait/,
        "debe fijar @page con tamaño Letter portrait");
    assert.match(css, /@page\s*{[^}]*margin:\s*0/,
        "debe fijar @page con margin: 0 para neutralizar márgenes del navegador");
});

test("buildShelfLabelsCss: medidas físicas en mm, no px", () => {
    const css = buildShelfLabelsCss();
    assert.ok(css.includes(`${SHEET_WIDTH_MM}mm`), "SHEET_WIDTH_MM aparece en mm");
    assert.ok(css.includes(`${SHEET_HEIGHT_MM}mm`), "SHEET_HEIGHT_MM aparece en mm");
    assert.ok(css.includes(`${LABEL_WIDTH_MM}mm`), "LABEL_WIDTH_MM aparece en mm");
    assert.ok(css.includes(`${LABEL_HEIGHT_MM}mm`), "LABEL_HEIGHT_MM aparece en mm");
    assert.ok(css.includes(`${PAGE_PADDING_Y_MM}mm`), "padding vertical en mm");
    assert.ok(css.includes(`${PAGE_PADDING_X_MM}mm`), "padding horizontal en mm");
});

test("buildShelfLabelsCss: grid 2x6 sin gap", () => {
    const css = buildShelfLabelsCss();
    assert.match(
        css,
        new RegExp(`grid-template-columns:\\s*repeat\\(${COLUMNS},\\s*${LABEL_WIDTH_MM}mm\\)`),
        "2 columnas de 80mm");
    assert.match(
        css,
        new RegExp(`grid-template-rows:\\s*repeat\\(${ROWS},\\s*${LABEL_HEIGHT_MM}mm\\)`),
        "6 filas de 40mm");
    assert.match(css, /gap:\s*0/, "sin gap entre slots");
});

test("buildShelfLabelsCss: borde dashed gris tenue muy fino", () => {
    const css = buildShelfLabelsCss();
    assert.match(css, /border:\s*0\.2mm\s+dashed\s+#c4c4c4/i,
        "borde debe ser 0.2mm dashed en gris muy tenue");
});

test("buildShelfLabelsCss: nombre bold con max 2 líneas", () => {
    const css = buildShelfLabelsCss();
    assert.match(css, /\.shelf-name[^}]*font-weight:\s*700/i, "nombre bold");
    assert.match(css, /-webkit-line-clamp:\s*2/, "máx 2 líneas con line-clamp");
});

test("buildShelfLabelsCss: precio B/N dominante y centrado", () => {
    const css = buildShelfLabelsCss();
    // Precio font-size grande.
    assert.match(css, /\.shelf-price[^}]*font-size:\s*26pt/, "precio en 26pt dominante");
    assert.match(css, /\.shelf-price[^}]*font-weight:\s*900/i, "precio en 900 (black)");
    assert.match(css, /\.shelf-price[^}]*color:\s*#000/, "precio en negro puro");
});

test("buildShelfLabelsCss: footer con izquierda (SKU/código) y derecha (unidad/fecha)", () => {
    const css = buildShelfLabelsCss();
    assert.match(css, /\.shelf-footer-left/i);
    assert.match(css, /\.shelf-footer-right/i);
    assert.match(css, /\.shelf-footer[^}]*justify-content:\s*space-between/i,
        "footer debe tener justify-content: space-between");
});

test("buildShelfLabelsCss: incluye page-break-after/break-after para forzar saltos", () => {
    const css = buildShelfLabelsCss();
    assert.match(css, /\.shelf-page[^{]*{[^}]*page-break-after:\s*always/i,
        "cada hoja debe forzar page-break-after: always");
    assert.match(css, /\.shelf-page[^{]*{[^}]*break-after:\s*page/i,
        "equivalente moderno break-after: page");
    assert.match(css, /\.shelf-page:last-child[^}]*page-break-after:\s*auto/i,
        "última hoja no debe forzar salto adicional");
});

// -----------------------------------------------------------------------------
// buildShelfLabelsPrintHtml: documento completo aislado
// -----------------------------------------------------------------------------
test("buildShelfLabelsPrintHtml: lista vacía produce documento sin páginas", () => {
    const html = buildShelfLabelsPrintHtml([]);
    assert.ok(html.startsWith("<!DOCTYPE html>"), "arranca con DOCTYPE");
    assert.ok(html.includes("<html lang=\"es\">"));
    assert.ok(html.includes("<body></body>"), "cuerpo vacío sin páginas");
});

test("buildShelfLabelsPrintHtml: con items genera página(s) y encapsula el CSS", () => {
    const html = buildShelfLabelsPrintHtml([it("A", 2)]);
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("<style>"), "CSS inline en <style>");
    assert.ok(html.includes("@page"), "@page viaja dentro del documento");
    assert.ok(html.includes("Letter portrait"));
    assert.ok(html.includes("shelf-page"), "contiene al menos una sección shelf-page");
});

test("buildShelfLabelsPrintHtml: 13 items → 2 secciones .shelf-page", () => {
    const html = buildShelfLabelsPrintHtml([it("A", 13)]);
    const matches = html.match(/<section\s+class="shelf-page"/g) || [];
    assert.equal(matches.length, 2, "deben renderizarse exactamente 2 páginas");
});

test("buildShelfLabelsPrintHtml: inyecta blanks null como <div.is-blank>", () => {
    const html = buildShelfLabelsPrintHtml([it("A", 1)]);
    const blanks = html.match(/class="shelf-slot is-blank"/g) || [];
    assert.equal(blanks.length, 11, "11 blanks visibles en la hoja parcial");
});

test("buildShelfLabelsPrintHtml: TODO contenido dinámico pasa por escapeHtml", () => {
    const html = buildShelfLabelsPrintHtml([{
        code: "<x>",
        productName: `<script>alert(1)</script>`,
        salePrice: 2000,
        quantity: 1,
    }]);
    assert.ok(!html.includes("<script>alert"), "no debe aparecer <script> crudo");
    assert.ok(html.includes("&lt;script&gt;"), "está escapado");
    assert.ok(html.includes("&lt;x&gt;"), "code escapado");
});

// -----------------------------------------------------------------------------
// buildAuditMeta: metadata obligatoria para /labels/print-jobs
// -----------------------------------------------------------------------------
test("buildAuditMeta: siempre fija layout=gondola-80x40-letter-2x6", () => {
    assert.deepEqual(buildAuditMeta(), { layout: LAYOUT_META_ID });
    const extra = buildAuditMeta({ foo: "bar", printedBy: "jaime" });
    assert.equal(extra.layout, LAYOUT_META_ID,
        "layout no puede ser pisado por el caller — el helper lo impone");
    assert.equal(extra.foo, "bar");
    assert.equal(extra.printedBy, "jaime");
});

test("buildAuditMeta: layout NO puede ser pisado por un `extra` malicioso", () => {
    const extra = buildAuditMeta({ layout: "pirata-99x99" });
    assert.equal(extra.layout, LAYOUT_META_ID,
        "si el caller pasa layout, el helper lo sobrescribe");
});

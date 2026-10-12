// =============================================================================
// tests/shelf-labels.test.mjs
//
// Pruebas exhaustivas del helper puro `src/lib/shelf-labels.mjs`.
//
// Cubre:
//   - Resolución dinámica de formato (LETTER / LEGAL / fallbacks).
//   - Geometrías físicas inmutables por formato (80×40 mm · landscape).
//   - Grids: Letter 3×5=15, Legal 4×5=20.
//   - Padding físico calculado desde las dimensiones de hoja.
//   - Normalización y expansión de cantidades.
//   - Paginación por formato (blanks null al final).
//   - Resumen contable (fullPages, remainder, totalPages, blanks).
//   - Escape HTML sobre nombre, SKU, unidad y código.
//   - CSS incluye @page con tamaño landscape y margin 0.
//   - buildAuditMeta impone el layout canónico del formato.
//   - formatCOP determinístico.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
    COLUMNS,
    DEFAULT_GONDOLA_FORMAT,
    GONDOLA_FORMAT_SPECS,
    GONDOLA_FORMATS,
    LABEL_HEIGHT_MM,
    LABEL_WIDTH_MM,
    LABELS_PER_PAGE,
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
    resolveGondolaFormat,
    resolveGondolaLayout,
    summarizeShelfLabels,
    truncate,
} from "../src/lib/shelf-labels.mjs";

// -----------------------------------------------------------------------------
// Constantes físicas de la etiqueta — compartidas por todos los formatos.
// -----------------------------------------------------------------------------
test("etiqueta: siempre mide 80 × 40 mm, invariante del contrato", () => {
    assert.equal(LABEL_WIDTH_MM, 80, "ancho de etiqueta en mm");
    assert.equal(LABEL_HEIGHT_MM, 40, "alto de etiqueta en mm");
});

// -----------------------------------------------------------------------------
// Formatos soportados: LETTER (default) y LEGAL.
// -----------------------------------------------------------------------------
test("GONDOLA_FORMATS: expone LETTER y LEGAL con default LETTER", () => {
    assert.equal(GONDOLA_FORMATS.LETTER, "LETTER");
    assert.equal(GONDOLA_FORMATS.LEGAL, "LEGAL");
    assert.equal(DEFAULT_GONDOLA_FORMAT, "LETTER", "default debe ser Carta");
});

test("GONDOLA_FORMAT_SPECS.LETTER: landscape 279.4×215.9, grid 3×5=15", () => {
    const spec = GONDOLA_FORMAT_SPECS.LETTER;
    assert.equal(spec.sheetWidthMm, 279.4);
    assert.equal(spec.sheetHeightMm, 215.9);
    assert.equal(spec.columns, 3);
    assert.equal(spec.rows, 5);
    assert.equal(spec.labelsPerPage, 15);
    assert.equal(spec.cssPageSize, "Letter landscape");
    assert.equal(spec.layoutMetaId, "gondola-80x40-letter-landscape-3x5");
    assert.equal(spec.sheetLabel, "letter-landscape");
});

test("GONDOLA_FORMAT_SPECS.LEGAL: landscape 355.6×215.9, grid 4×5=20", () => {
    const spec = GONDOLA_FORMAT_SPECS.LEGAL;
    assert.equal(spec.sheetWidthMm, 355.6);
    assert.equal(spec.sheetHeightMm, 215.9);
    assert.equal(spec.columns, 4);
    assert.equal(spec.rows, 5);
    assert.equal(spec.labelsPerPage, 20);
    assert.equal(spec.cssPageSize, "Legal landscape");
    assert.equal(spec.layoutMetaId, "gondola-80x40-legal-landscape-4x5");
    assert.equal(spec.sheetLabel, "legal-landscape");
});

test("resolveGondolaFormat: acepta sinónimos y rechaza basura al default", () => {
    assert.equal(resolveGondolaFormat("LETTER"), "LETTER");
    assert.equal(resolveGondolaFormat("letter"), "LETTER");
    assert.equal(resolveGondolaFormat("carta"), "LETTER", "alias español");
    assert.equal(resolveGondolaFormat("LEGAL"), "LEGAL");
    assert.equal(resolveGondolaFormat("legal"), "LEGAL");
    assert.equal(resolveGondolaFormat("oficio"), "LEGAL", "alias español");
    assert.equal(resolveGondolaFormat(null), "LETTER");
    assert.equal(resolveGondolaFormat(undefined), "LETTER");
    assert.equal(resolveGondolaFormat(""), "LETTER");
    assert.equal(resolveGondolaFormat(123), "LETTER");
    assert.equal(resolveGondolaFormat("A4"), "LETTER", "formato no soportado cae al default");
    assert.equal(resolveGondolaFormat({ format: "LEGAL" }), "LEGAL",
        "objeto con .format debe extraer el valor");
});

test("resolveGondolaLayout: Letter calcula padding exacto desde la geometría", () => {
    const l = resolveGondolaLayout("LETTER");
    assert.equal(l.format, "LETTER");
    assert.equal(l.sheetWidthMm, 279.4);
    assert.equal(l.sheetHeightMm, 215.9);
    assert.equal(l.columns, 3);
    assert.equal(l.rows, 5);
    assert.equal(l.labelsPerPage, 15);
    assert.equal(l.labelWidthMm, 80);
    assert.equal(l.labelHeightMm, 40);
    // Padding X = (279.4 - 3*80)/2 = 19.7 mm
    assert.ok(Math.abs(l.paddingXMm - 19.7) < 1e-9,
        `padding horizontal Letter debe ser 19.7mm, encontrado ${l.paddingXMm}`);
    // Padding Y = (215.9 - 5*40)/2 = 7.95 mm
    assert.ok(Math.abs(l.paddingYMm - 7.95) < 1e-9,
        `padding vertical Letter debe ser 7.95mm, encontrado ${l.paddingYMm}`);
});

test("resolveGondolaLayout: Legal calcula padding exacto desde la geometría", () => {
    const l = resolveGondolaLayout("LEGAL");
    assert.equal(l.format, "LEGAL");
    assert.equal(l.sheetWidthMm, 355.6);
    assert.equal(l.sheetHeightMm, 215.9);
    assert.equal(l.columns, 4);
    assert.equal(l.rows, 5);
    assert.equal(l.labelsPerPage, 20);
    // Padding X = (355.6 - 4*80)/2 = 17.8 mm
    assert.ok(Math.abs(l.paddingXMm - 17.8) < 1e-9,
        `padding horizontal Legal debe ser 17.8mm, encontrado ${l.paddingXMm}`);
    // Padding Y = (215.9 - 5*40)/2 = 7.95 mm
    assert.ok(Math.abs(l.paddingYMm - 7.95) < 1e-9,
        `padding vertical Legal debe ser 7.95mm, encontrado ${l.paddingYMm}`);
});

test("alias retrocompatibles reflejan el formato DEFAULT (Letter landscape)", () => {
    assert.equal(SHEET_WIDTH_MM, 279.4);
    assert.equal(SHEET_HEIGHT_MM, 215.9);
    assert.equal(COLUMNS, 3);
    assert.equal(ROWS, 5);
    assert.equal(LABELS_PER_PAGE, 15);
    assert.ok(Math.abs(PAGE_PADDING_X_MM - 19.7) < 1e-9);
    assert.ok(Math.abs(PAGE_PADDING_Y_MM - 7.95) < 1e-9);
    assert.equal(LAYOUT_META_ID, "gondola-80x40-letter-landscape-3x5",
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
// Expansión y paginación
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

test("paginateSlots: 0 slots → 0 páginas (ambos formatos)", () => {
    assert.deepEqual(paginateSlots([], "LETTER"), []);
    assert.deepEqual(paginateSlots([], "LEGAL"), []);
    assert.deepEqual(paginateSlots(null), []);
});

test("paginateSlots Letter: 1 slot → 1 página con 14 blanks", () => {
    const slots = expandItemsToSlots([it("A", 1)]);
    const pages = paginateSlots(slots, "LETTER");
    assert.equal(pages.length, 1, "una página");
    assert.equal(pages[0].length, 15, "siempre 15 celdas en Letter");
    assert.equal(pages[0][0].code, "A");
    for (let i = 1; i < 15; i++) {
        assert.equal(pages[0][i], null, `celda ${i} debe ser blank null`);
    }
});

test("paginateSlots Letter: 15 slots → 1 página, 0 blanks", () => {
    const slots = expandItemsToSlots([it("A", 15)]);
    const pages = paginateSlots(slots, "LETTER");
    assert.equal(pages.length, 1);
    assert.equal(pages[0].length, 15);
    assert.equal(pages[0].filter((s) => s === null).length, 0,
        "no blanks cuando cabe exacto");
});

test("paginateSlots Letter: 16 slots → 2 páginas, segunda con 14 blanks", () => {
    const slots = expandItemsToSlots([it("A", 16)]);
    const pages = paginateSlots(slots, "LETTER");
    assert.equal(pages.length, 2, "dos páginas");
    assert.equal(pages[0].length, 15);
    assert.equal(pages[1].length, 15);
    assert.equal(pages[0].filter((s) => s === null).length, 0, "primera página llena");
    assert.equal(pages[1].filter((s) => s === null).length, 14, "segunda tiene 14 blanks");
    assert.equal(pages[1][0].code, "A", "primer slot de la segunda página es real");
});

test("paginateSlots Legal: 20 slots → 1 página, 0 blanks", () => {
    const slots = expandItemsToSlots([it("A", 20)]);
    const pages = paginateSlots(slots, "LEGAL");
    assert.equal(pages.length, 1);
    assert.equal(pages[0].length, 20);
    assert.equal(pages[0].filter((s) => s === null).length, 0);
});

test("paginateSlots Legal: 21 slots → 2 páginas, segunda con 19 blanks", () => {
    const slots = expandItemsToSlots([it("A", 21)]);
    const pages = paginateSlots(slots, "LEGAL");
    assert.equal(pages.length, 2);
    assert.equal(pages[0].length, 20);
    assert.equal(pages[1].length, 20);
    assert.equal(pages[0].filter((s) => s === null).length, 0);
    assert.equal(pages[1].filter((s) => s === null).length, 19);
    assert.equal(pages[1][0].code, "A");
});

test("paginateSlots: sin format → cae al default LETTER (15 por página)", () => {
    const slots = expandItemsToSlots([it("A", 15)]);
    const pages = paginateSlots(slots);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].length, 15);
});

// -----------------------------------------------------------------------------
// summarizeShelfLabels: alimentador del contador de la UI
// -----------------------------------------------------------------------------
test("summarizeShelfLabels: 0 ítems → todo cero, layout canónico presente", () => {
    const s = summarizeShelfLabels([], "LETTER");
    assert.equal(s.totalLabels, 0);
    assert.equal(s.fullPages, 0);
    assert.equal(s.remainder, 0);
    assert.equal(s.totalPages, 0);
    assert.equal(s.blanks, 0);
    assert.equal(s.labelsPerPage, 15);
    assert.equal(s.format, "LETTER");
    assert.equal(s.layout, "gondola-80x40-letter-landscape-3x5");
});

test("summarizeShelfLabels Letter: 15 → 1 completa + 0 sobrantes", () => {
    const s = summarizeShelfLabels([it("A", 15)], "LETTER");
    assert.equal(s.totalLabels, 15);
    assert.equal(s.fullPages, 1);
    assert.equal(s.remainder, 0);
    assert.equal(s.totalPages, 1);
    assert.equal(s.blanks, 0);
    assert.equal(s.labelsPerPage, 15);
});

test("summarizeShelfLabels Letter: 16 → 1 completa + 1 sobrante + 2 totales", () => {
    const s = summarizeShelfLabels([it("A", 16)], "LETTER");
    assert.equal(s.totalLabels, 16);
    assert.equal(s.fullPages, 1);
    assert.equal(s.remainder, 1);
    assert.equal(s.totalPages, 2);
    assert.equal(s.blanks, 14);
    assert.equal(s.labelsPerPage, 15);
});

test("summarizeShelfLabels Legal: 20 → 1 completa, 40 → 2, 41 → 2+1 sobrante", () => {
    const s20 = summarizeShelfLabels([it("A", 20)], "LEGAL");
    assert.equal(s20.totalLabels, 20);
    assert.equal(s20.fullPages, 1);
    assert.equal(s20.remainder, 0);
    assert.equal(s20.totalPages, 1);
    assert.equal(s20.blanks, 0);
    assert.equal(s20.labelsPerPage, 20);
    assert.equal(s20.format, "LEGAL");
    assert.equal(s20.layout, "gondola-80x40-legal-landscape-4x5");

    const s40 = summarizeShelfLabels([it("A", 40)], "LEGAL");
    assert.equal(s40.totalPages, 2);
    assert.equal(s40.fullPages, 2);
    assert.equal(s40.remainder, 0);

    const s41 = summarizeShelfLabels([it("A", 41)], "LEGAL");
    assert.equal(s41.totalLabels, 41);
    assert.equal(s41.fullPages, 2);
    assert.equal(s41.remainder, 1);
    assert.equal(s41.totalPages, 3);
    assert.equal(s41.blanks, 19);
});

test("summarizeShelfLabels: formato desconocido/undefined cae a LETTER", () => {
    const s = summarizeShelfLabels([it("A", 10)]);
    assert.equal(s.format, "LETTER");
    assert.equal(s.labelsPerPage, 15);
    const s2 = summarizeShelfLabels([it("A", 10)], "A4");
    assert.equal(s2.format, "LETTER");
    assert.equal(s2.labelsPerPage, 15);
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
// CSS del documento aislado: dimensiones y @page landscape
// -----------------------------------------------------------------------------
test("buildShelfLabelsCss Letter: @page Letter landscape + margin 0 + grid 3x5", () => {
    const css = buildShelfLabelsCss("LETTER");
    assert.match(css, /@page\s*\{[^}]*size:\s*Letter\s+landscape/,
        "debe fijar @page con tamaño Letter landscape");
    assert.match(css, /@page\s*\{[^}]*margin:\s*0/,
        "debe fijar @page con margin: 0 para neutralizar márgenes del navegador");
    assert.match(css, /grid-template-columns:\s*repeat\(3,\s*80mm\)/);
    assert.match(css, /grid-template-rows:\s*repeat\(5,\s*40mm\)/);
    assert.match(css, /gap:\s*0/);
    assert.ok(css.includes("279.4mm"));
    assert.ok(css.includes("215.9mm"));
    assert.ok(css.includes("19.7mm"), "padding horizontal");
    assert.ok(css.includes("7.95mm"), "padding vertical");
});

test("buildShelfLabelsCss Legal: @page Legal landscape + margin 0 + grid 4x5", () => {
    const css = buildShelfLabelsCss("LEGAL");
    assert.match(css, /@page\s*\{[^}]*size:\s*Legal\s+landscape/);
    assert.match(css, /@page\s*\{[^}]*margin:\s*0/);
    assert.match(css, /grid-template-columns:\s*repeat\(4,\s*80mm\)/);
    assert.match(css, /grid-template-rows:\s*repeat\(5,\s*40mm\)/);
    assert.ok(css.includes("355.6mm"));
    assert.ok(css.includes("215.9mm"));
    assert.ok(css.includes("17.8mm"), "padding horizontal Legal");
    assert.ok(css.includes("7.95mm"), "padding vertical compartido");
});

test("buildShelfLabelsCss: sin format cae al default Letter", () => {
    const def = buildShelfLabelsCss();
    const letter = buildShelfLabelsCss("LETTER");
    assert.equal(def, letter);
});

test("buildShelfLabelsCss: borde dashed gris tenue muy fino", () => {
    const css = buildShelfLabelsCss("LETTER");
    assert.match(css, /border:\s*0\.2mm\s+dashed\s+#c4c4c4/i,
        "borde debe ser 0.2mm dashed en gris muy tenue");
});

test("buildShelfLabelsCss: nombre bold con max 2 líneas", () => {
    const css = buildShelfLabelsCss("LETTER");
    assert.match(css, /\.shelf-name[^}]*font-weight:\s*700/i, "nombre bold");
    assert.match(css, /-webkit-line-clamp:\s*2/, "máx 2 líneas con line-clamp");
});

test("buildShelfLabelsCss: precio B/N dominante y centrado", () => {
    const css = buildShelfLabelsCss("LETTER");
    assert.match(css, /\.shelf-price[^}]*font-size:\s*26pt/);
    assert.match(css, /\.shelf-price[^}]*font-weight:\s*900/i);
    assert.match(css, /\.shelf-price[^}]*color:\s*#000/);
});

test("buildShelfLabelsCss: footer con izquierda (SKU/código) y derecha (unidad/fecha)", () => {
    const css = buildShelfLabelsCss("LETTER");
    assert.match(css, /\.shelf-footer-left/i);
    assert.match(css, /\.shelf-footer-right/i);
    assert.match(css, /\.shelf-footer[^}]*justify-content:\s*space-between/i);
});

test("buildShelfLabelsCss: incluye page-break-after/break-after para forzar saltos", () => {
    const css = buildShelfLabelsCss("LETTER");
    assert.match(css, /\.shelf-page[^{]*\{[^}]*page-break-after:\s*always/i);
    assert.match(css, /\.shelf-page[^{]*\{[^}]*break-after:\s*page/i);
    assert.match(css, /\.shelf-page:last-child[^}]*page-break-after:\s*auto/i);
});

// -----------------------------------------------------------------------------
// buildShelfLabelsPrintHtml: documento completo aislado
// -----------------------------------------------------------------------------
test("buildShelfLabelsPrintHtml: lista vacía produce documento sin páginas", () => {
    const html = buildShelfLabelsPrintHtml([]);
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("<body></body>"), "cuerpo vacío sin páginas");
});

test("buildShelfLabelsPrintHtml: default Letter incluye @page Letter landscape", () => {
    const html = buildShelfLabelsPrintHtml([it("A", 2)]);
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes("<style>"), "CSS inline en <style>");
    assert.ok(html.includes("@page"), "@page viaja dentro del documento");
    assert.ok(html.includes("Letter landscape"));
    assert.ok(html.includes("shelf-page"));
    assert.match(html, /data-gondola-format="LETTER"/);
    assert.match(html, /data-gondola-layout="gondola-80x40-letter-landscape-3x5"/);
});

test("buildShelfLabelsPrintHtml Letter: 16 items → 2 secciones .shelf-page", () => {
    const html = buildShelfLabelsPrintHtml([it("A", 16)], { format: "LETTER" });
    const matches = html.match(/<section\s+class="shelf-page"/g) || [];
    assert.equal(matches.length, 2, "deben renderizarse exactamente 2 páginas");
});

test("buildShelfLabelsPrintHtml Legal: 20 items → 1 sección y 25 → 2 secciones", () => {
    const html1 = buildShelfLabelsPrintHtml([it("A", 20)], { format: "LEGAL" });
    const m1 = html1.match(/<section\s+class="shelf-page"/g) || [];
    assert.equal(m1.length, 1);
    assert.match(html1, /size:\s*Legal\s+landscape/);
    assert.match(html1, /data-gondola-format="LEGAL"/);
    assert.match(html1, /data-gondola-layout="gondola-80x40-legal-landscape-4x5"/);

    const html2 = buildShelfLabelsPrintHtml([it("A", 25)], { format: "LEGAL" });
    const m2 = html2.match(/<section\s+class="shelf-page"/g) || [];
    assert.equal(m2.length, 2);
});

test("buildShelfLabelsPrintHtml Letter: 1 item inyecta 14 blanks null", () => {
    const html = buildShelfLabelsPrintHtml([it("A", 1)], { format: "LETTER" });
    const blanks = html.match(/class="shelf-slot is-blank"/g) || [];
    assert.equal(blanks.length, 14, "14 blanks visibles en la hoja parcial de 15");
});

test("buildShelfLabelsPrintHtml Legal: 1 item inyecta 19 blanks null", () => {
    const html = buildShelfLabelsPrintHtml([it("A", 1)], { format: "LEGAL" });
    const blanks = html.match(/class="shelf-slot is-blank"/g) || [];
    assert.equal(blanks.length, 19, "19 blanks visibles en la hoja parcial de 20");
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
// buildAuditMeta: metadata canónica obligatoria del formato activo.
// -----------------------------------------------------------------------------
test("buildAuditMeta Letter: fija layout + format + dimensiones correctas", () => {
    const meta = buildAuditMeta(undefined, "LETTER");
    assert.equal(meta.layout, "gondola-80x40-letter-landscape-3x5");
    assert.equal(meta.format, "LETTER");
    assert.equal(meta.sheet, "letter-landscape");
    assert.equal(meta.sheetWidthMm, 279.4);
    assert.equal(meta.sheetHeightMm, 215.9);
    assert.equal(meta.labelWidthMm, 80);
    assert.equal(meta.labelHeightMm, 40);
    assert.equal(meta.columns, 3);
    assert.equal(meta.rows, 5);
    assert.equal(meta.labelsPerPage, 15);
});

test("buildAuditMeta Legal: fija layout + format + dimensiones correctas", () => {
    const meta = buildAuditMeta(undefined, "LEGAL");
    assert.equal(meta.layout, "gondola-80x40-legal-landscape-4x5");
    assert.equal(meta.format, "LEGAL");
    assert.equal(meta.sheet, "legal-landscape");
    assert.equal(meta.sheetWidthMm, 355.6);
    assert.equal(meta.sheetHeightMm, 215.9);
    assert.equal(meta.columns, 4);
    assert.equal(meta.rows, 5);
    assert.equal(meta.labelsPerPage, 20);
});

test("buildAuditMeta: layout/dimensions NUNCA pueden ser pisadas por `extra`", () => {
    const meta = buildAuditMeta({
        layout: "pirata-99x99",
        format: "A5",
        sheetWidthMm: 999,
        rows: 99,
        printedBy: "jaime",
    }, "LETTER");
    // El caller no puede corromper el canonical:
    assert.equal(meta.layout, "gondola-80x40-letter-landscape-3x5");
    assert.equal(meta.format, "LETTER");
    assert.equal(meta.sheetWidthMm, 279.4);
    assert.equal(meta.rows, 5);
    // Pero sí puede agregar campos arbitrarios:
    assert.equal(meta.printedBy, "jaime");
});

test("buildAuditMeta: sin format cae al default Letter", () => {
    const meta = buildAuditMeta();
    assert.equal(meta.format, "LETTER");
    assert.equal(meta.layout, "gondola-80x40-letter-landscape-3x5");
});

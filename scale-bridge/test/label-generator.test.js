// =============================================================================
// test/label-generator.test.js
//
// Suite `node --test` para la lógica pura del generador modular de etiquetas
// (`label-generator.js`). Comprueba las piezas por separado para que las
// regresiones sean localizadas y rápidas de diagnosticar:
//
//   * `mmToDots` con DPI 203 estándar + overrides.
//   * `computeColumnOffsets` para 1 y 2 columnas, con y sin `printableWidthMm`.
//   * `flattenLabelItems` + `buildRows` (aplanado + distribución).
//   * `normalizeLabelsConfig` (shape "research" vs shape histórico del
//     frontend) y defaults de preset.
//   * `sanitizeEan13` / `computeEan13CheckDigit`.
//   * `buildTsplDocument` emitiendo SIZE del medio total, CLS por fila,
//     PRINT 1,1, offsets correctos de 2 columnas, EAN13/CODE128.
//   * `buildTsplTestPage` con cada preset.
//
// Correrlo: `npm test` (incluido por el glob `test/**/*.test.js`).
// =============================================================================

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    DPI_203,
    DOTS_PER_MM_203,
    PHYSICAL_MAX_MM,
    LABEL_ERR,
    LABEL_PRESETS,
    mmToDots,
    computeColumnOffsets,
    flattenLabelItems,
    buildRows,
    normalizeLabelsConfig,
    sanitizeEan13,
    computeEan13CheckDigit,
    buildTsplDocument,
    buildTsplTestPage,
} = require("../label-generator");

// Escapador compartido con `printer-bridge.js` para no duplicar reglas.
const { escapeForTspl, _internals } = require("../printer-bridge");
const formatMoney = _internals.formatMoney;

// -----------------------------------------------------------------------------
// Constantes
// -----------------------------------------------------------------------------

test("DPI_203 y constantes derivadas", () => {
    assert.equal(DPI_203, 203);
    // 203/25.4 ≈ 7.992
    assert.ok(Math.abs(DOTS_PER_MM_203 - 7.9921259842) < 1e-6);
    assert.equal(PHYSICAL_MAX_MM, 82);
});

// -----------------------------------------------------------------------------
// mmToDots: valores clave
// -----------------------------------------------------------------------------

test("mmToDots: 203 dpi devuelve 8 dots por mm (redondeado)", () => {
    assert.equal(mmToDots(0), 0);
    assert.equal(mmToDots(1), 8);
    assert.equal(mmToDots(10), 80);
    assert.equal(mmToDots(30), 240);
    assert.equal(mmToDots(50), 400);
    // 76 * 203 / 25.4 = 607.40 → 607 (ancho imprimible JAL-838L).
    assert.equal(mmToDots(76), 607);
    // 82 * 203 / 25.4 = 655.35 → 655 (ancho físico JAL-838L).
    assert.equal(mmToDots(82), 655);
});

test("mmToDots: 25.4mm exactos devuelven la cuenta exacta de DPI", () => {
    assert.equal(mmToDots(25.4, 203), 203);
    assert.equal(mmToDots(25.4, 300), 300);
    assert.equal(mmToDots(25.4, 600), 600);
});

test("mmToDots: fracciones redondean correctamente", () => {
    // 1.5mm a 203 dpi = 11.988 → 12
    assert.equal(mmToDots(1.5), 12);
    // 0.5mm → 4 dots
    assert.equal(mmToDots(0.5), 4);
});

test("mmToDots: entradas inválidas devuelven 0 (BC con configs rotas)", () => {
    assert.equal(mmToDots(undefined), 0);
    assert.equal(mmToDots(null), 0);
    assert.equal(mmToDots(NaN), 0);
    assert.equal(mmToDots("foo"), 0);
});

// -----------------------------------------------------------------------------
// Presets
// -----------------------------------------------------------------------------

test("LABEL_PRESETS: tiene las 6 variantes requeridas por el sprint", () => {
    const expected = ["50x30", "40x30", "30x20", "30x20-2col", "58x40", "76x50"];
    for (const name of expected) {
        assert.ok(LABEL_PRESETS[name], `preset ${name} faltante`);
    }
});

test("LABEL_PRESETS: cada preset tiene columns 1 ó 2", () => {
    for (const [name, p] of Object.entries(LABEL_PRESETS)) {
        assert.ok(p.columns === 1 || p.columns === 2, `preset ${name} con columns inválido`);
    }
});

test("LABEL_PRESETS: 30x20-2col define columns=2 y horizontalGap>0", () => {
    assert.equal(LABEL_PRESETS["30x20-2col"].columns, 2);
    assert.ok(LABEL_PRESETS["30x20-2col"].horizontalGapMm > 0);
});

test("LABEL_PRESETS: todos los presets caben en 82mm (margen incluido)", () => {
    for (const [name, p] of Object.entries(LABEL_PRESETS)) {
        const total = p.marginLeftMm + p.columns * p.widthMm + (p.columns - 1) * p.horizontalGapMm;
        assert.ok(total <= PHYSICAL_MAX_MM + 0.5,
            `preset ${name}: ${total}mm no cabe en ${PHYSICAL_MAX_MM}mm`);
    }
});

// -----------------------------------------------------------------------------
// computeColumnOffsets
// -----------------------------------------------------------------------------

test("computeColumnOffsets: 1 col sin margen → offset [0]", () => {
    const r = computeColumnOffsets({ marginLeftMm: 0, labelWidthMm: 50, columns: 1 });
    assert.deepEqual(r.offsets, [0]);
    assert.equal(r.totalMm, 50);
    assert.equal(r.limitMm, PHYSICAL_MAX_MM);
    assert.ok(r.fits);
});

test("computeColumnOffsets: 2 col aplica fórmula marginDots + i*(wDots+gapDots)", () => {
    const r = computeColumnOffsets({
        marginLeftMm: 2,
        labelWidthMm: 30,
        horizontalGapMm: 2,
        columns: 2,
    });
    assert.deepEqual(r.offsets, [16, 272]);
    assert.equal(r.totalMm, 64);
    assert.equal(r.dots.marginDots, 16);
    assert.equal(r.dots.widthDots, 240);
    assert.equal(r.dots.gapDots, 16);
});

test("computeColumnOffsets: gap=0 pega las columnas", () => {
    const r = computeColumnOffsets({
        marginLeftMm: 0,
        labelWidthMm: 30,
        horizontalGapMm: 0,
        columns: 2,
    });
    assert.deepEqual(r.offsets, [0, 240]);
    assert.equal(r.totalMm, 60);
});

test("computeColumnOffsets: columns=2 pero gap undefined cae a 0", () => {
    const r = computeColumnOffsets({ marginLeftMm: 0, labelWidthMm: 30, columns: 2 });
    assert.equal(r.dots.gapDots, 0);
    assert.deepEqual(r.offsets, [0, 240]);
});

test("computeColumnOffsets: respeta printableWidthMm explícito como tope", () => {
    const r = computeColumnOffsets({
        marginLeftMm: 2, labelWidthMm: 30, horizontalGapMm: 2, columns: 2,
        printableWidthMm: 60,
    });
    assert.equal(r.limitMm, 60);
    assert.equal(r.totalMm, 64);
    assert.equal(r.fits, false, "64mm > 60mm");
});

test("computeColumnOffsets: sin printableWidthMm el tope es 82mm (JAL-838L)", () => {
    const r = computeColumnOffsets({
        marginLeftMm: 0, labelWidthMm: 40, horizontalGapMm: 5, columns: 2,
    });
    assert.equal(r.limitMm, PHYSICAL_MAX_MM);
    // 40+5+40 = 85 > 82 → no cabe.
    assert.equal(r.totalMm, 85);
    assert.equal(r.fits, false);
});

test("computeColumnOffsets: default columns=1 cuando columns != 2", () => {
    const r1 = computeColumnOffsets({ marginLeftMm: 0, labelWidthMm: 50, columns: 1 });
    const r3 = computeColumnOffsets({ marginLeftMm: 0, labelWidthMm: 50, columns: 3 });
    const rU = computeColumnOffsets({ marginLeftMm: 0, labelWidthMm: 50 });
    assert.equal(r1.columns, 1);
    // 3 se clampa a 2.
    assert.equal(r3.columns, 2);
    // Undefined → fallback 1.
    assert.equal(rU.columns, 1);
});

// -----------------------------------------------------------------------------
// flattenLabelItems + buildRows
// -----------------------------------------------------------------------------

test("flattenLabelItems: aplana qty manteniendo campos auxiliares", () => {
    const flat = flattenLabelItems([
        { code: "A", productName: "Prod A", salePrice: 100, quantity: 2 },
        { code: "B", productName: "Prod B", quantity: 1 },
    ]);
    assert.equal(flat.length, 3);
    assert.equal(flat[0].productName, "Prod A");
    assert.equal(flat[2].productName, "Prod B");
    for (const it of flat) assert.equal(it.quantity, 1);
});

test("flattenLabelItems: ignora quantities 0, negativos y basura", () => {
    const flat = flattenLabelItems([
        { code: "A", quantity: 0 },
        { code: "B", quantity: -3 },
        { code: "C", quantity: "foo" },
        { code: "D", quantity: 2 },
    ]);
    // 0 y -3 se clampan a 1 (fallback mínimo). "foo" también → 1.
    // Total = 1 + 1 + 1 + 2 = 5.
    assert.equal(flat.length, 5);
});

test("buildRows: 1 col emite una fila por item", () => {
    const rows = buildRows([{ code: "A" }, { code: "B" }, { code: "C" }], 1);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].length, 1);
});

test("buildRows: 2 col agrupa de a 2", () => {
    const rows = buildRows([
        { code: "A" }, { code: "B" }, { code: "C" }, { code: "D" }, { code: "E" },
    ], 2);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].length, 2);
    assert.equal(rows[1].length, 2);
    assert.equal(rows[2].length, 1);
});

// -----------------------------------------------------------------------------
// normalizeLabelsConfig
// -----------------------------------------------------------------------------

test("normalizeLabelsConfig: usa sensor.gapMm como gap vertical", () => {
    const cfg = normalizeLabelsConfig({
        widthMm: 50, heightMm: 30, columns: 1,
        sensor: { gapMm: 5 },
    });
    assert.equal(cfg.verticalGapMm, 5);
});

test("normalizeLabelsConfig: fallback a `verticalGapMm` directo si sensor ausente", () => {
    const cfg = normalizeLabelsConfig({
        widthMm: 50, heightMm: 30, columns: 1,
        verticalGapMm: 7,
    });
    assert.equal(cfg.verticalGapMm, 7);
});

test("normalizeLabelsConfig: preset completa defaults faltantes", () => {
    const cfg = normalizeLabelsConfig({}, "30x20-2col");
    assert.equal(cfg.widthMm, 30);
    assert.equal(cfg.heightMm, 20);
    assert.equal(cfg.columns, 2);
    assert.equal(cfg.horizontalGapMm, 2);
    assert.equal(cfg.marginLeftMm, 2);
});

test("normalizeLabelsConfig: labels del admin ganan sobre preset", () => {
    const cfg = normalizeLabelsConfig({ widthMm: 60, columns: 1 }, "30x20-2col");
    assert.equal(cfg.widthMm, 60);
    assert.equal(cfg.columns, 1);
});

test("normalizeLabelsConfig: mediumWidthMm = margen + cols*w + (cols-1)*gap", () => {
    const cfg = normalizeLabelsConfig({
        widthMm: 30, heightMm: 20, columns: 2, horizontalGapMm: 2, marginLeftMm: 2,
    });
    assert.equal(cfg.mediumWidthMm, 2 + 30 + 2 + 30);
});

test("normalizeLabelsConfig: layout del shape \"research\" override los defaults", () => {
    const cfg = normalizeLabelsConfig({
        widthMm: 50, heightMm: 30, columns: 1,
        layout: {
            productName: { xMm: 3, yMm: 2, font: "2", scaleX: 2, scaleY: 2 },
            barcode: { symbology: "EAN13", heightMm: 12 },
        },
    });
    assert.equal(cfg.layout.productName.xMm, 3);
    assert.equal(cfg.layout.productName.font, "2");
    assert.equal(cfg.layout.productName.scaleX, 2);
    assert.equal(cfg.layout.barcode.symbology, "EAN13");
    assert.equal(cfg.layout.barcode.heightMm, 12);
});

test("normalizeLabelsConfig: labels.barcode.heightMm sobre layout.barcode.heightMm si barcode.heightMm existe", () => {
    const cfg = normalizeLabelsConfig({
        widthMm: 50, heightMm: 30, columns: 1,
        barcode: { symbology: "CODE128", heightMm: 15 },
    });
    assert.equal(cfg.layout.barcode.heightMm, 15);
});

// -----------------------------------------------------------------------------
// EAN13
// -----------------------------------------------------------------------------

test("computeEan13CheckDigit: ejemplo canónico", () => {
    // Para '590123412345' el check es 7 (ejemplo típico de Wikipedia).
    assert.equal(computeEan13CheckDigit("590123412345"), 7);
    // Para '750100067320' el check es 9 (producto real colombiano).
    assert.equal(computeEan13CheckDigit("750100067320"), 9);
});

test("sanitizeEan13: valida 12 y 13 dígitos; limpia separadores", () => {
    assert.equal(sanitizeEan13("590123412345"), "590123412345");
    assert.equal(sanitizeEan13("5901234123457"), "5901234123457");
    assert.equal(sanitizeEan13("590 123 412 345 7"), "5901234123457");
    assert.equal(sanitizeEan13("5901234123450"), null, "check incorrecto");
    assert.equal(sanitizeEan13("12345"), null);
});

// -----------------------------------------------------------------------------
// buildTsplDocument — contrato principal
// -----------------------------------------------------------------------------

function docText(opts) {
    return buildTsplDocument({ ...opts, escapeFn: escapeForTspl, formatMoney }).toString("ascii");
}

test("buildTsplDocument: header SIZE/GAP/DIRECTION/REFERENCE/DENSITY en ese orden", () => {
    const text = docText({
        labels: { widthMm: 50, heightMm: 30, columns: 1, sensor: { gapMm: 3 } },
        items: [{ code: "A", productName: "X", quantity: 1 }],
    });
    const headerIdx = text.indexOf("DENSITY 8");
    const sizeIdx = text.indexOf("SIZE ");
    const gapIdx = text.indexOf("GAP ");
    const dirIdx = text.indexOf("DIRECTION");
    const refIdx = text.indexOf("REFERENCE");
    assert.ok(sizeIdx < gapIdx);
    assert.ok(gapIdx < dirIdx);
    assert.ok(dirIdx < refIdx);
    assert.ok(refIdx < headerIdx);
});

test("buildTsplDocument: 2 col duplica dibujos y respeta offsets correctos", () => {
    const text = docText({
        labels: {
            widthMm: 30, heightMm: 20, columns: 2, horizontalGapMm: 2, marginLeftMm: 2,
            sensor: { gapMm: 2 },
            barcode: { symbology: "CODE128", heightMm: 8 },
        },
        items: [
            { code: "A", productName: "LECHE", salePrice: 3500, quantity: 1 },
            { code: "B", productName: "PAN", salePrice: 2000, quantity: 1 },
        ],
    });
    // Dos BARCODE con offsets de columna correctos (16 y 272 dots respectivamente).
    assert.match(text, /BARCODE 24,\d+,"128",\d+,1,0,\d+,\d+,"A"/);
    assert.match(text, /BARCODE 280,\d+,"128",\d+,1,0,\d+,\d+,"B"/);
});

test("buildTsplDocument: 1 fila con 2 items emite 1 CLS + 1 PRINT 1,1", () => {
    const text = docText({
        labels: {
            widthMm: 30, heightMm: 20, columns: 2, horizontalGapMm: 2, marginLeftMm: 2,
            sensor: { gapMm: 2 },
            barcode: { symbology: "CODE128", heightMm: 8 },
        },
        items: [
            { code: "A", productName: "LECHE", quantity: 1 },
            { code: "B", productName: "PAN", quantity: 1 },
        ],
    });
    assert.equal((text.match(/CLS/g) || []).length, 1);
    assert.equal((text.match(/PRINT 1,1/g) || []).length, 1);
});

test("buildTsplDocument: aplana cantidades y distribuye en 2 columnas", () => {
    const text = docText({
        labels: {
            widthMm: 30, heightMm: 20, columns: 2, horizontalGapMm: 2, marginLeftMm: 2,
            sensor: { gapMm: 2 },
            barcode: { symbology: "CODE128", heightMm: 8 },
        },
        items: [{ code: "A", productName: "LECHE", quantity: 3 }],
    });
    // 3 copias en 2 col = 2 filas (fila 1 [A,A], fila 2 [A]).
    assert.equal((text.match(/CLS/g) || []).length, 2);
    assert.equal((text.match(/PRINT 1,1/g) || []).length, 2);
});

test("buildTsplDocument: lanza LAYOUT_OUT_OF_BOUNDS si no cabe en 82mm", () => {
    assert.throws(
        () => buildTsplDocument({
            labels: {
                widthMm: 50, heightMm: 30, columns: 2, horizontalGapMm: 5, marginLeftMm: 0,
                sensor: { gapMm: 3 },
                barcode: { symbology: "CODE128", heightMm: 10 },
            },
            items: [{ code: "A", quantity: 1 }, { code: "B", quantity: 1 }],
            escapeFn: escapeForTspl,
            formatMoney,
        }),
        (err) => err.code === LABEL_ERR.LAYOUT_OUT_OF_BOUNDS,
    );
});

test("buildTsplDocument: EAN13 válido se emite tal cual", () => {
    const text = docText({
        labels: {
            widthMm: 50, heightMm: 30, columns: 1, marginLeftMm: 2,
            sensor: { gapMm: 3 },
            barcode: { symbology: "EAN13", heightMm: 10 },
        },
        items: [{ code: "7501000673209", productName: "COLA", quantity: 1 }],
    });
    assert.match(text, /BARCODE \d+,\d+,"EAN13",80,1,0,2,2,"7501000673209"/);
});

test("buildTsplDocument: EAN13 inválido lanza INVALID_BARCODE_EAN13", () => {
    assert.throws(
        () => buildTsplDocument({
            labels: {
                widthMm: 50, heightMm: 30, columns: 1,
                barcode: { symbology: "EAN13", heightMm: 10 },
            },
            items: [{ code: "NO_DIGITS", quantity: 1 }],
            escapeFn: escapeForTspl,
            formatMoney,
        }),
        (err) => err.code === LABEL_ERR.INVALID_BARCODE_EAN13,
    );
});

test("buildTsplDocument: simbología desconocida lanza UNSUPPORTED_BARCODE_SYMBOLOGY", () => {
    assert.throws(
        () => buildTsplDocument({
            labels: {
                widthMm: 50, heightMm: 30, columns: 1,
                barcode: { symbology: "QRCODE", heightMm: 10 },
            },
            items: [{ code: "ABC", quantity: 1 }],
            escapeFn: escapeForTspl,
            formatMoney,
        }),
        (err) => err.code === LABEL_ERR.UNSUPPORTED_BARCODE_SYMBOLOGY,
    );
});

test("buildTsplDocument: escapeFn requerido explícitamente", () => {
    assert.throws(
        () => buildTsplDocument({
            labels: { widthMm: 50, heightMm: 30, columns: 1 },
            items: [{ code: "A", quantity: 1 }],
        }),
        (err) => err.code === LABEL_ERR.INVALID_LABEL_CONFIG,
    );
});

test("buildTsplDocument: items vacío lanza INVALID_LABEL_CONFIG", () => {
    assert.throws(
        () => buildTsplDocument({
            labels: { widthMm: 50, heightMm: 30, columns: 1 },
            items: [],
            escapeFn: escapeForTspl,
            formatMoney,
        }),
        (err) => err.code === LABEL_ERR.INVALID_LABEL_CONFIG,
    );
});

// -----------------------------------------------------------------------------
// buildTsplTestPage por preset
// -----------------------------------------------------------------------------

test("buildTsplTestPage: cada preset genera un documento TSPL válido", () => {
    for (const presetName of Object.keys(LABEL_PRESETS)) {
        const buf = buildTsplTestPage({
            labels: {},
            preset: presetName,
            escapeFn: escapeForTspl,
            formatMoney,
        });
        const text = buf.toString("ascii");
        assert.match(text, /^SIZE /);
        assert.match(text, /PRINT 1,1/);
        // Si el preset tiene 2 columnas, emite 2 items distintos.
        if (LABEL_PRESETS[presetName].columns === 2) {
            assert.ok(text.includes("TEST-L"), `${presetName} debe incluir TEST-L`);
            assert.ok(text.includes("TEST-R"), `${presetName} debe incluir TEST-R`);
        } else {
            assert.ok(text.includes("TESTBRIDGE"), `${presetName} debe incluir TESTBRIDGE`);
        }
    }
});

test("buildTsplTestPage: SIZE del preset 76x50 es 79mm = margen 3 + ancho 76", () => {
    const buf = buildTsplTestPage({
        labels: {},
        preset: "76x50",
        escapeFn: escapeForTspl,
        formatMoney,
    });
    assert.match(buf.toString("ascii"), /SIZE 79 mm, 50 mm/);
});

test("buildTsplTestPage: preset 30x20-2col emite SIZE 64mm (ancho total del medio)", () => {
    const buf = buildTsplTestPage({
        labels: {},
        preset: "30x20-2col",
        escapeFn: escapeForTspl,
        formatMoney,
    });
    const text = buf.toString("ascii");
    // margen 2 + 30 + gap 2 + 30 = 64 mm.
    assert.match(text, /SIZE 64 mm, 20 mm/);
    // Un solo PRINT 1,1 (los 2 items van en la misma fila).
    assert.equal((text.match(/PRINT 1,1/g) || []).length, 1);
});

test("buildTsplTestPage: formato mm compacto quita ceros colgantes (62.00 → 62)", () => {
    const buf = buildTsplTestPage({
        labels: { widthMm: 62, heightMm: 20, columns: 1, marginLeftMm: 0, sensor: { gapMm: 2 } },
        preset: null,
        escapeFn: escapeForTspl,
        formatMoney,
    });
    assert.match(buf.toString("ascii"), /SIZE 62 mm, 20 mm/);
});



// -----------------------------------------------------------------------------
// Wire canónico frontend + compatibilidad legacy (defectos revisión 2026-10)
// -----------------------------------------------------------------------------

test("normalizeLabelsConfig: layout.name/price canónicos ganan sobre aliases legacy", () => {
    const cfg = normalizeLabelsConfig({
        widthMm: 50,
        heightMm: 30,
        layout: {
            name: { xMm: 3, yMm: 4, font: "8", fontScale: 1.5 },
            productName: { xMm: 1, yMm: 1, font: "2", scaleX: 1, scaleY: 1 },
            price: { xMm: 6, yMm: 10, font: "7", fontScale: 3 },
            salePrice: { xMm: 2, yMm: 2, font: "3", scaleX: 1, scaleY: 1 },
        },
    });
    assert.deepEqual(
        { xMm: cfg.layout.productName.xMm, yMm: cfg.layout.productName.yMm, font: cfg.layout.productName.font, scaleX: cfg.layout.productName.scaleX, scaleY: cfg.layout.productName.scaleY },
        { xMm: 3, yMm: 4, font: "8", scaleX: 2, scaleY: 2 },
    );
    assert.deepEqual(
        { xMm: cfg.layout.salePrice.xMm, yMm: cfg.layout.salePrice.yMm, font: cfg.layout.salePrice.font, scaleX: cfg.layout.salePrice.scaleX, scaleY: cfg.layout.salePrice.scaleY },
        { xMm: 6, yMm: 10, font: "7", scaleX: 3, scaleY: 3 },
    );
});

test("normalizeLabelsConfig: fuente fuera de 1..8 cae a defaults seguros", () => {
    const cfg = normalizeLabelsConfig({
        layout: {
            name: { font: "99" },
            price: { font: "ARIAL" },
        },
    });
    assert.equal(cfg.layout.productName.font, "3");
    assert.equal(cfg.layout.salePrice.font, "4");
});

test("buildTsplDocument: BARCODE exacto honra HRI, rotation, narrow y wide no-default", () => {
    const text = docText({
        labels: {
            widthMm: 50,
            heightMm: 30,
            columns: 1,
            marginLeftMm: 0,
            sensor: { gapMm: 3 },
            productName: { visible: true, maxChars: 32 },
            price: { visible: true, emphasized: false },
            barcode: {
                symbology: "CODE128",
                heightMm: 7,
                humanReadable: false,
                rotation: 90,
                narrow: 3,
                wide: 5,
            },
            layout: {
                name: { xMm: 3, yMm: 4, font: "5", fontScale: 1.5 },
                price: { xMm: 6, yMm: 10, font: "7", fontScale: 3 },
                barcode: { xMm: 2.5, yMm: 17 },
            },
        },
        items: [{ code: "ABC123", productName: "PRD", salePrice: 1234, quantity: 1 }],
    });
    assert.equal(text, [
        "SIZE 50 mm, 30 mm",
        "GAP 3 mm, 0 mm",
        "DIRECTION 1",
        "REFERENCE 0,0",
        "DENSITY 8",
        "CLS",
        'TEXT 24,32,"5",0,2,2,"PRD"',
        'TEXT 48,80,"7",0,3,3,"$ 1.234"',
        'BARCODE 20,136,"128",56,0,90,3,5,"ABC123"',
        "PRINT 1,1",
        "",
    ].join("\r\n"));
});

test("computeColumnOffsets: techo físico es estricto (82 cabe, 82.01 no)", () => {
    assert.equal(computeColumnOffsets({ marginLeftMm: 0, labelWidthMm: 40, horizontalGapMm: 2, columns: 2 }).fits, true);
    assert.equal(computeColumnOffsets({ marginLeftMm: 0.01, labelWidthMm: 40, horizontalGapMm: 2, columns: 2 }).fits, false);
});

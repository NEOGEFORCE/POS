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



// =============================================================================
// buildTsplShelfLabelsDocument — hoja térmica de góndola (bridge-printing-v3)
//
// Suite independiente del renderer de etiquetas de producto porque el
// contrato es distinto (precio GRANDE centrado, nombre con wrap 2 líneas,
// footer con código/fecha, GAP configurable, cero barcode, cero drawer).
// =============================================================================

const {
    SHELF_THERMAL_DEFAULTS,
    normalizeShelfThermalConfig,
    buildTsplShelfLabelsDocument,
    formatShelfDate,
    wrapNameTwoLines,
    TSPL_FONT_METRICS,
} = require("../label-generator");

// --- Defaults y normalización ----------------------------------------------

test("SHELF_THERMAL_DEFAULTS: espeja los defaults canónicos del SSOT (80x40, GAP 0)", () => {
    assert.equal(SHELF_THERMAL_DEFAULTS.widthMm, 80);
    assert.equal(SHELF_THERMAL_DEFAULTS.printableWidthMm, 76);
    assert.equal(SHELF_THERMAL_DEFAULTS.heightMm, 40);
    assert.equal(SHELF_THERMAL_DEFAULTS.gapMm, 0);
    assert.equal(SHELF_THERMAL_DEFAULTS.direction, 0);
    assert.equal(SHELF_THERMAL_DEFAULTS.density, 8);
    assert.equal(SHELF_THERMAL_DEFAULTS.nameFont, "3");
    assert.equal(SHELF_THERMAL_DEFAULTS.priceFont, "4");
    assert.equal(SHELF_THERMAL_DEFAULTS.footerFont, "1");
    assert.equal(SHELF_THERMAL_DEFAULTS.showCode, true);
    assert.equal(SHELF_THERMAL_DEFAULTS.showDate, true);
    // Nuevos defaults del rediseño "estante grande" (bridge-printing-v3.1):
    assert.equal(SHELF_THERMAL_DEFAULTS.showBarcode, true,
        "barcode CODE128 activo por default");
    assert.equal(SHELF_THERMAL_DEFAULTS.barcodeHeightMm, 10);
    assert.equal(SHELF_THERMAL_DEFAULTS.barcodeNarrow, 2);
    assert.equal(SHELF_THERMAL_DEFAULTS.barcodeWide, 2);
    assert.equal(SHELF_THERMAL_DEFAULTS.showUnitLabel, true,
        "literal 'PRECIO UND' activo por default");
    assert.equal(SHELF_THERMAL_DEFAULTS.unitLabel, "PRECIO UND");
    assert.equal(SHELF_THERMAL_DEFAULTS.unitLabelFont, "2");
    assert.equal(SHELF_THERMAL_DEFAULTS.showSeparator, true,
        "separador BAR fino activo por default");
    assert.equal(SHELF_THERMAL_DEFAULTS.separatorThicknessDots, 2);
});

test("normalizeShelfThermalConfig: aplica defaults cuando thermal es undefined", () => {
    const cfg = normalizeShelfThermalConfig(undefined);
    assert.equal(cfg.widthMm, 80);
    assert.equal(cfg.printableWidthMm, 76);
    assert.equal(cfg.heightMm, 40);
    assert.equal(cfg.gapMm, 0);
    assert.equal(cfg.nameFont, "3");
    assert.equal(cfg.priceFont, "4");
});

test("normalizeShelfThermalConfig: respeta valores válidos del admin", () => {
    const cfg = normalizeShelfThermalConfig({
        widthMm: 60, printableWidthMm: 55, heightMm: 30, gapMm: 2,
        density: 10, direction: 1, mirror: 1,
        nameFont: "2", priceFont: "5", footerFont: "3",
        showCode: false, showDate: true,
    });
    assert.equal(cfg.widthMm, 60);
    assert.equal(cfg.printableWidthMm, 55);
    assert.equal(cfg.heightMm, 30);
    assert.equal(cfg.gapMm, 2);
    assert.equal(cfg.density, 10);
    assert.equal(cfg.direction, 1);
    assert.equal(cfg.mirror, 1);
    assert.equal(cfg.nameFont, "2");
    assert.equal(cfg.priceFont, "5");
    assert.equal(cfg.footerFont, "3");
    assert.equal(cfg.showCode, false);
    assert.equal(cfg.showDate, true);
});

test("normalizeShelfThermalConfig: fuentes fuera de 1..8 caen a defaults seguros", () => {
    const cfg = normalizeShelfThermalConfig({
        nameFont: "99", priceFont: "FOO", footerFont: "bar",
    });
    assert.equal(cfg.nameFont, "3");
    assert.equal(cfg.priceFont, "4");
    assert.equal(cfg.footerFont, "1");
});

test("normalizeShelfThermalConfig: density/escalas clampadas a sus rangos duros", () => {
    const cfg = normalizeShelfThermalConfig({
        density: 999, nameScaleX: -4, priceScaleY: 50,
        nameMaxChars: 1000,
    });
    assert.equal(cfg.density, 15);           // 0..15
    assert.equal(cfg.nameScaleX, 1);         // 1..10, -4 → 1
    assert.equal(cfg.priceScaleY, 10);       // 1..10
    assert.equal(cfg.nameMaxChars, 60);      // 1..60
});

test("normalizeShelfThermalConfig: direction/mirror sólo aceptan exactamente 0 ó 1", () => {
    const cfg = normalizeShelfThermalConfig({ direction: 2, mirror: "yes" });
    assert.equal(cfg.direction, 0);
    assert.equal(cfg.mirror, 0);
});

// --- wrapNameTwoLines -------------------------------------------------------

test("wrapNameTwoLines: cadenas vacías producen array vacío", () => {
    assert.deepEqual(wrapNameTwoLines("", 20), []);
    assert.deepEqual(wrapNameTwoLines(null, 20), []);
    assert.deepEqual(wrapNameTwoLines("   ", 20), []);
});

test("wrapNameTwoLines: una línea cuando cabe entera", () => {
    assert.deepEqual(wrapNameTwoLines("ARROZ 1KG", 24), ["ARROZ 1KG"]);
});

test("wrapNameTwoLines: parte en 2 líneas por palabra cuando excede maxChars", () => {
    const [l1, l2] = wrapNameTwoLines("ARROZ EXTRA PREMIUM MARCA MOLINO", 16);
    assert.ok(l1.length <= 16);
    assert.ok(l2.length <= 16);
    // Line 1 debe terminar en una palabra completa (no en espacio).
    assert.ok(!l1.endsWith(" "));
    // "MARCA" debe aparecer en alguna de las dos líneas (el wrap no la pierde).
    assert.ok(l1.includes("MARCA") || l2.includes("MARCA"),
        `MARCA debe aparecer en alguna línea; got l1="${l1}" l2="${l2}"`);
});

test("wrapNameTwoLines: primera palabra más larga que maxChars → corte duro de ≤ maxChars", () => {
    const [l1, l2] = wrapNameTwoLines("ANTEDILUVIANAMENTE PRODUCTO", 10);
    assert.equal(l1.length, 10);
    assert.ok(l2.length <= 10);
});

test("wrapNameTwoLines: descarta el exceso después de la segunda línea", () => {
    const result = wrapNameTwoLines("AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH", 10);
    assert.ok(result.length <= 2, "nunca debe emitir más de 2 líneas");
});

// --- formatShelfDate --------------------------------------------------------

test("formatShelfDate: formato YYYY-MM-DD HH:MM para Date explícito", () => {
    const d = new Date("2026-10-19T14:16:00");
    const str = formatShelfDate(d);
    // Comprobamos sólo que arranca con el año y tiene el shape correcto.
    assert.match(str, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("formatShelfDate: acepta ISO 8601 string y timestamp numérico", () => {
    const iso = "2026-10-19T14:16:41.000-05:00";
    assert.match(formatShelfDate(iso), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.match(formatShelfDate(Date.now()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test("formatShelfDate: input inválido devuelve string vacío (sin crashear)", () => {
    assert.equal(formatShelfDate("fecha-no-valida"), "");
});

// --- buildTsplShelfLabelsDocument: cabecera canónica -----------------------

function shelfText(opts) {
    return buildTsplShelfLabelsDocument({
        ...opts,
        escapeFn: escapeForTspl,
        formatMoney,
    }).toString("ascii");
}

test("buildTsplShelfLabelsDocument: SIZE 80 mm, 40 mm por default", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
        now: "2026-10-19T14:16:00",
    });
    assert.match(text, /SIZE 80 mm, 40 mm/);
});

test("buildTsplShelfLabelsDocument: SIZE dinámico respeta widthMm/heightMm del thermal", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, widthMm: 60, heightMm: 30, printableWidthMm: 55 },
    });
    assert.match(text, /SIZE 60 mm, 30 mm/);
});

test("buildTsplShelfLabelsDocument: GAP 0 mm, 0 mm por default (papel continuo)", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.match(text, /GAP 0 mm, 0 mm/);
});

test("buildTsplShelfLabelsDocument: GAP configurable cuando thermal.gapMm > 0", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, gapMm: 2 },
    });
    assert.match(text, /GAP 2 mm, 0 mm/);
});

test("buildTsplShelfLabelsDocument: DIRECTION 0,0 por default", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.match(text, /DIRECTION 0,0/);
});

test("buildTsplShelfLabelsDocument: respeta direction/mirror override del admin", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, direction: 1, mirror: 1 },
    });
    assert.match(text, /DIRECTION 1,1/);
});

test("buildTsplShelfLabelsDocument: DENSITY del admin se refleja (default 8)", () => {
    const text8 = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.match(text8, /DENSITY 8/);
    const text12 = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, density: 12 },
    });
    assert.match(text12, /DENSITY 12/);
});

test("buildTsplShelfLabelsDocument: REFERENCE 0,0 siempre", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.match(text, /REFERENCE 0,0/);
});

// --- Cuerpo por item: CLS + TEXT + PRINT 1,1 -------------------------------

test("buildTsplShelfLabelsDocument: una etiqueta genera un CLS y un PRINT 1,1", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.equal((text.match(/CLS/g) || []).length, 1);
    assert.equal((text.match(/PRINT 1,1/g) || []).length, 1);
});

test("buildTsplShelfLabelsDocument: aplana quantity (3 copias = 3 CLS + 3 PRINT 1,1)", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 3 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.equal((text.match(/CLS/g) || []).length, 3);
    assert.equal((text.match(/PRINT 1,1/g) || []).length, 3);
});

test("buildTsplShelfLabelsDocument: múltiples items distintos (uno por producto)", () => {
    const text = shelfText({
        items: [
            { code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 },
            { code: "C2", productName: "PAN", salePrice: 1200, quantity: 2 },
        ],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    // 1 + 2 = 3 copias totales.
    assert.equal((text.match(/CLS/g) || []).length, 3);
    assert.ok(text.includes("LECHE"));
    assert.ok(text.includes("PAN"));
});

// --- Escape obligatorio ----------------------------------------------------

test("buildTsplShelfLabelsDocument: nombre con comillas/backslash se escapan (nunca entran al TSPL)", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: 'A"B\\C"D', salePrice: 1000, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.ok(!text.includes('A"B'), "comillas filtradas");
    assert.ok(!text.includes("A\\B"), "backslash filtrado");
    assert.ok(text.includes("ABCD"), "chars seguros preservados");
});

test("buildTsplShelfLabelsDocument: non-ASCII en nombre se translitera a chars seguros", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "ñandú áéíóú", salePrice: 2000, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    // Después del escape, sólo ASCII imprimible queda en el embed.
    const textLines = text.split(/\r?\n/);
    for (const ln of textLines) {
        const m = ln.match(/TEXT \d+,\d+,"\d","?0,\d+,\d+,"([^"]*)"/);
        if (m) {
            for (const ch of m[1]) {
                const code = ch.charCodeAt(0);
                assert.ok(code >= 0x20 && code <= 0x7E, `char no ASCII en TEXT: ${ch}`);
            }
        }
    }
});

test("buildTsplShelfLabelsDocument: nombre > nameMaxChars se trunca/parte en 2 líneas", () => {
    const longName = "ARROZ EXTRA PREMIUM MARCA MOLINO DE ORO MUY LARGO QUE NO CABE";
    const text = shelfText({
        items: [{ code: "C1", productName: longName, salePrice: 1500, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, nameMaxChars: 16 },
    });
    // No puede haber un TEXT con el nombre completo.
    assert.ok(!text.includes(longName));
    // Y debe haber a lo más 2 TEXT que corresponden a líneas de nombre.
    // Nombre usa font "3" por default. El resto (precio font "4", footer font "1").
    const nameLines = text.match(/TEXT \d+,\d+,"3",0,\d+,\d+,"[^"]*"/g) || [];
    assert.ok(nameLines.length <= 2, `máx 2 líneas de nombre, hay ${nameLines.length}`);
});

// --- Precio centrado por métricas ------------------------------------------

test("buildTsplShelfLabelsDocument: precio centrado por métricas (x calculado)", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    // Precio usa font "4" default (24x32 dots) con scale 2x2 = ancho 48 dots/char.
    // "$ 3.500" = 7 chars → 7*48 = 336 dots.
    // printable 76 mm → 607 dots (76*8). margin left 2mm → 16 dots.
    // Centrado: priceX = 16 + floor((607 - 336)/2) = 16 + 135 = 151.
    assert.match(text, /TEXT 151,\d+,"4",0,2,2,"\$ 3\.500"/);
});

test("buildTsplShelfLabelsDocument: precio no se emite si salePrice <= 0", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "SOLO NOMBRE", salePrice: 0, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    // No debería emitir TEXT con la fuente del precio ("4").
    const priceLines = text.match(/TEXT \d+,\d+,"4",0,\d+,\d+,"\$ /g) || [];
    assert.equal(priceLines.length, 0);
});

test("buildTsplShelfLabelsDocument: precio formateado al estilo colombiano", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "L", salePrice: 1234567, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.ok(text.includes('"$ 1.234.567"'));
});

// --- Footer: código + fecha ------------------------------------------------

test("buildTsplShelfLabelsDocument: footer con código a la izq. y fecha a la derecha cuando ambos activos", () => {
    const text = shelfText({
        items: [{ code: "LBL-001", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
        now: "2026-10-19T14:16:00",
    });
    // Código (texto plano, no barcode) y fecha deben aparecer. Fuente footer "1".
    const footerLines = text.match(/TEXT \d+,\d+,"1",0,\d+,\d+,"[^"]*"/g) || [];
    assert.ok(footerLines.length >= 2, `esperaba ≥2 TEXTs del footer, hubo ${footerLines.length}`);
    assert.ok(text.includes('"LBL-001"'), "código presente");
    assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});

test("buildTsplShelfLabelsDocument: showCode=false omite el PLU como texto", () => {
    const text = shelfText({
        items: [{ code: "LBL-001", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, showCode: false },
    });
    // El PLU como TEXT se omite — el barcode puede seguir emitiéndose si
    // showBarcode=true (default), pero no debe haber un comando TEXT
    // conteniendo el código.
    const pluTextLines = text.match(/TEXT \d+,\d+,"1",0,\d+,\d+,"LBL-001"/g) || [];
    assert.equal(pluTextLines.length, 0, "ningún TEXT con el PLU debe emitirse");
});

test("buildTsplShelfLabelsDocument: showCode=false + showBarcode=false suprime cualquier aparición del código", () => {
    const text = shelfText({
        items: [{ code: "LBL-001", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, showCode: false, showBarcode: false },
    });
    assert.ok(!text.includes("LBL-001"),
        "con ambos toggles desactivados el código no aparece ni como barcode ni como texto");
});

test("buildTsplShelfLabelsDocument: showDate=false omite la fecha", () => {
    const text = shelfText({
        items: [{ code: "LBL-001", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, showDate: false },
        now: "2026-10-19T14:16:00",
    });
    assert.ok(!/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text));
});

test("buildTsplShelfLabelsDocument: fecha alineada a la derecha por métricas", () => {
    const text = shelfText({
        items: [{ code: "LBL-001", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
        now: "2026-10-19T14:16:00",
    });
    // Footer font "1" (8x12 dots). Fecha "YYYY-MM-DD HH:MM" = 16 chars → 128 dots.
    // marginLeft 2mm = 16 dots, printable 76mm = 607 dots.
    // rightEdge = 16 + 607 = 623. dateX = 623 - 128 = 495.
    const dateMatch = text.match(/TEXT (\d+),\d+,"1",0,1,1,"\d{4}-\d{2}-\d{2}/);
    assert.ok(dateMatch, "fecha emitida");
    const dateX = Number(dateMatch[1]);
    assert.ok(dateX > 16, `fecha debe estar a la derecha del margen izq., no en x=${dateX}`);
});

// --- Validaciones duras -----------------------------------------------------

test("buildTsplShelfLabelsDocument: widthMm > 82 → LAYOUT_OUT_OF_BOUNDS", () => {
    assert.throws(
        () => buildTsplShelfLabelsDocument({
            items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
            thermal: { ...SHELF_THERMAL_DEFAULTS, widthMm: 100 },
            escapeFn: escapeForTspl, formatMoney,
        }),
        (err) => err.code === LABEL_ERR.LAYOUT_OUT_OF_BOUNDS,
    );
});

test("buildTsplShelfLabelsDocument: widthMm < 20 → INVALID_SHELF_CONFIG", () => {
    assert.throws(
        () => buildTsplShelfLabelsDocument({
            items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
            thermal: { ...SHELF_THERMAL_DEFAULTS, widthMm: 15 },
            escapeFn: escapeForTspl, formatMoney,
        }),
        (err) => err.code === LABEL_ERR.INVALID_SHELF_CONFIG,
    );
});

test("buildTsplShelfLabelsDocument: marginLeft + printable > width → LAYOUT_OUT_OF_BOUNDS", () => {
    assert.throws(
        () => buildTsplShelfLabelsDocument({
            items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
            thermal: { ...SHELF_THERMAL_DEFAULTS, widthMm: 60, printableWidthMm: 55, marginLeftMm: 10 },
            escapeFn: escapeForTspl, formatMoney,
        }),
        (err) => err.code === LABEL_ERR.LAYOUT_OUT_OF_BOUNDS,
    );
});

test("buildTsplShelfLabelsDocument: heightMm fuera de 20..200 → INVALID_SHELF_CONFIG", () => {
    assert.throws(
        () => buildTsplShelfLabelsDocument({
            items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
            thermal: { ...SHELF_THERMAL_DEFAULTS, heightMm: 500 },
            escapeFn: escapeForTspl, formatMoney,
        }),
        (err) => err.code === LABEL_ERR.INVALID_SHELF_CONFIG,
    );
    assert.throws(
        () => buildTsplShelfLabelsDocument({
            items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
            thermal: { ...SHELF_THERMAL_DEFAULTS, heightMm: 5 },
            escapeFn: escapeForTspl, formatMoney,
        }),
        (err) => err.code === LABEL_ERR.INVALID_SHELF_CONFIG,
    );
});

test("buildTsplShelfLabelsDocument: items vacío → NO_LABELS", () => {
    assert.throws(
        () => buildTsplShelfLabelsDocument({
            items: [],
            thermal: SHELF_THERMAL_DEFAULTS,
            escapeFn: escapeForTspl, formatMoney,
        }),
        (err) => err.code === LABEL_ERR.NO_LABELS,
    );
});

test("buildTsplShelfLabelsDocument: escapeFn no función → INVALID_SHELF_CONFIG", () => {
    assert.throws(
        () => buildTsplShelfLabelsDocument({
            items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
            thermal: SHELF_THERMAL_DEFAULTS,
            // escapeFn omitido.
            formatMoney,
        }),
        (err) => err.code === LABEL_ERR.INVALID_SHELF_CONFIG,
    );
});

test("buildTsplShelfLabelsDocument: widthMm exactamente 82 cabe (frontera superior)", () => {
    const buf = buildTsplShelfLabelsDocument({
        items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, widthMm: 82, printableWidthMm: 80 },
        escapeFn: escapeForTspl, formatMoney,
    });
    assert.match(buf.toString("ascii"), /SIZE 82 mm/);
});

test("buildTsplShelfLabelsDocument: thermal ausente infla defaults y produce documento válido", () => {
    const buf = buildTsplShelfLabelsDocument({
        items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
        // thermal omitido.
        escapeFn: escapeForTspl, formatMoney,
    });
    const text = buf.toString("ascii");
    assert.match(text, /SIZE 80 mm, 40 mm/);
    assert.match(text, /PRINT 1,1/);
});

// --- Garantía dura: barcode y cero bytes de cajón -------------------------

test("buildTsplShelfLabelsDocument: emite BARCODE 128 por default con código ASCII seguro", () => {
    const text = shelfText({
        items: [{ code: "LBL-001", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    // El barcode default usa narrow=2 wide=2 según SHELF_THERMAL_DEFAULTS,
    // HRI=0 (porque PLU ya va como texto), rotation=0, data=LBL-001.
    assert.match(text, /BARCODE \d+,\d+,"128",\d+,0,0,2,2,"LBL-001"/);
});

test("buildTsplShelfLabelsDocument: showBarcode=false omite el BARCODE pero conserva PLU", () => {
    const text = shelfText({
        items: [{ code: "LBL-001", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, showBarcode: false },
    });
    assert.ok(!/BARCODE /.test(text),
        "ningún BARCODE emitido cuando showBarcode=false");
    // El PLU como texto sigue presente (showCode=true default).
    const pluTextLines = text.match(/TEXT \d+,\d+,"1",0,\d+,\d+,"LBL-001"/g) || [];
    assert.equal(pluTextLines.length, 1,
        "el PLU como texto se conserva aunque el barcode esté deshabilitado");
});

test("buildTsplShelfLabelsDocument: código con non-ASCII omite BARCODE pero conserva PLU escapado", () => {
    const text = shelfText({
        items: [{ code: "LBL-ñ-001", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.ok(!/BARCODE /.test(text),
        "código no CODE128-safe no debe emitir BARCODE");
    // El PLU debe aparecer transliterado por `escapeForTspl` (ñ → n).
    assert.ok(text.includes("LBL-n-001") || text.includes("LBL--001"),
        "PLU se preserva transliterado aunque el barcode se haya omitido");
});

test("buildTsplShelfLabelsDocument: código con comillas no es CODE128-safe → sin BARCODE", () => {
    const text = shelfText({
        items: [{ code: 'LBL"001', productName: "L", salePrice: 100, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.ok(!/BARCODE /.test(text),
        "comillas en el código rompen TSPL — barcode omitido");
});

test("buildTsplShelfLabelsDocument: código con backslash no es CODE128-safe → sin BARCODE", () => {
    const text = shelfText({
        items: [{ code: "LBL\\001", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    assert.ok(!/BARCODE /.test(text),
        "backslash en el código rompe TSPL — barcode omitido");
});

test("buildTsplShelfLabelsDocument: BARCODE siempre tiene HRI=0 (PLU ya es texto)", () => {
    const text = shelfText({
        items: [{ code: "PLU12345", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    const bcMatch = text.match(/BARCODE \d+,\d+,"128",\d+,(\d),(\d),\d+,\d+,/);
    assert.ok(bcMatch, "BARCODE emitido");
    assert.equal(bcMatch[1], "0", "HRI debe ser 0 (PLU duplicado como texto)");
    assert.equal(bcMatch[2], "0", "rotation debe ser 0 (horizontal)");
});

test("buildTsplShelfLabelsDocument: ancho del BARCODE no excede printableWidthMm", () => {
    // Código largo (24 chars) con narrow=2 → (11*24 + 55)*2 = 638 dots.
    // printable 76mm = 607 dots → no cabe con narrow=2, debe bajar a
    // narrow=1 (319 dots) para que entre.
    const text = shelfText({
        items: [{ code: "A".repeat(24), productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, barcodeMaxChars: 48 },
    });
    const bcMatch = text.match(/BARCODE (\d+),(\d+),"128",(\d+),0,0,(\d+),(\d+),"([^"]+)"/);
    assert.ok(bcMatch, "BARCODE emitido");
    const xDots = Number(bcMatch[1]);
    const narrow = Number(bcMatch[4]);
    const codeData = bcMatch[6];
    const estWidth = (11 * codeData.length + 55) * narrow;
    const printableDots = 76 * 203 / 25.4; // ~ 607
    assert.ok(xDots + estWidth <= printableDots + 16, // +marginLeft
        `barcode debe caber en printable: x=${xDots} + est=${estWidth} ≤ ${printableDots}`);
});

test("buildTsplShelfLabelsDocument: código extremo + narrow=1 que aún no cabe → omite BARCODE pero conserva PLU", () => {
    // 60 chars × 11 + 55 = 715 modules; narrow=1 = 715 dots. Printable 76mm=607.
    // No cabe ni con narrow=1 → barcode omitido, PLU preservado.
    const extreme = "X".repeat(48); // dentro de barcodeMaxChars=48 default
    const text = shelfText({
        items: [{ code: extreme, productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, barcodeMaxChars: 48, barcodeNarrow: 2 },
    });
    assert.ok(!/BARCODE /.test(text), "barcode demasiado ancho → omitido");
    const pluMatch = text.match(/TEXT \d+,\d+,"1",0,\d+,\d+,"X+"/);
    assert.ok(pluMatch, "PLU como texto se preserva aunque barcode se omita");
});

test("buildTsplShelfLabelsDocument: barcodeHeightMm clampado a 2..60", () => {
    const low = shelfText({
        items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, barcodeHeightMm: 0.1 },
    });
    // barcodeHeight 2mm = 16 dots a 203 dpi.
    const matchLow = low.match(/BARCODE \d+,\d+,"128",(\d+),/);
    assert.ok(matchLow, "BARCODE emitido");
    assert.equal(Number(matchLow[1]), 16, "barcodeHeightMm clampado a 2mm (16 dots)");

    const high = shelfText({
        items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, barcodeHeightMm: 999, heightMm: 200, printableWidthMm: 76 },
    });
    const matchHigh = high.match(/BARCODE \d+,\d+,"128",(\d+),/);
    assert.ok(matchHigh, "BARCODE emitido con altura alta");
    // 60mm = 480 dots.
    assert.equal(Number(matchHigh[1]), 480, "barcodeHeightMm clampado a 60mm (480 dots)");
});

test("buildTsplShelfLabelsDocument: separador fino BAR emitido por default", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE ENTERA", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    // BAR X,Y,width,height — printable 76mm = 607 dots, thickness 2 dots.
    assert.match(text, /BAR 16,\d+,607,2/);
});

test("buildTsplShelfLabelsDocument: showSeparator=false omite el BAR", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "LECHE", salePrice: 3500, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, showSeparator: false },
    });
    assert.ok(!/BAR \d+,/.test(text), "sin showSeparator no debe haber BAR");
});

test("buildTsplShelfLabelsDocument: separador se omite cuando no hay nombre", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    // Sin nombre no tiene sentido el separador (no delimita nada).
    assert.ok(!/BAR \d+,/.test(text),
        "separador requiere al menos una línea de nombre");
});

test("buildTsplShelfLabelsDocument: unidad 'PRECIO UND' emitida por default debajo del precio", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "L", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    // Font unitLabel="2", scale 1x1, texto "PRECIO UND" (10 chars).
    assert.match(text, /TEXT \d+,\d+,"2",0,1,1,"PRECIO UND"/);
});

test("buildTsplShelfLabelsDocument: showUnitLabel=false omite la unidad", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "L", salePrice: 3500, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, showUnitLabel: false },
    });
    assert.ok(!text.includes("PRECIO UND"),
        "showUnitLabel=false suprime la etiqueta de unidad");
});

test("buildTsplShelfLabelsDocument: unitLabel custom (p.ej. 'POR KG') se emite literal", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "L", salePrice: 3500, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, unitLabel: "POR KG" },
    });
    assert.match(text, /TEXT \d+,\d+,"2",0,1,1,"POR KG"/);
});

test("buildTsplShelfLabelsDocument: unidad centrada horizontalmente por métricas", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "L", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
    });
    // "PRECIO UND" = 10 chars × 12 dots (font 2 width) × 1 scale = 120 dots.
    // Centrado en 607 dots: 16 + floor((607-120)/2) = 16 + 243 = 259.
    const match = text.match(/TEXT (\d+),\d+,"2",0,1,1,"PRECIO UND"/);
    assert.ok(match, "unidad emitida");
    assert.equal(Number(match[1]), 259, "unidad centrada por métricas");
});

test("buildTsplShelfLabelsDocument: layout no se solapa en 80x40 a 203dpi (Y crecientes)", () => {
    const text = shelfText({
        items: [{ code: "LBL-001", productName: "LECHE ENTERA LARGA MARCA PREMIUM", salePrice: 3500, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
        now: "2026-10-19T14:16:00",
    });
    // Captura cada TEXT con (y, font) y BARCODE (y, height) y BAR (y, height).
    const emissions = [];
    for (const m of text.matchAll(/TEXT \d+,(\d+),"(\d)"/g)) {
        emissions.push({ kind: "TEXT", font: m[2], y: Number(m[1]) });
    }
    for (const m of text.matchAll(/BAR \d+,(\d+),\d+,(\d+)/g)) {
        emissions.push({ kind: "BAR", y: Number(m[1]), height: Number(m[2]) });
    }
    for (const m of text.matchAll(/BARCODE \d+,(\d+),"128",(\d+)/g)) {
        emissions.push({ kind: "BARCODE", y: Number(m[1]), height: Number(m[2]) });
    }
    // Dentro del área útil [marginTop, heightDots - marginBottom] = [16, 304].
    const heightDots = Math.round(40 * 203 / 25.4); // 320
    const marginTop = 16;
    const marginBottom = 16;
    for (const em of emissions) {
        assert.ok(em.y >= 0, `${em.kind} y=${em.y} negativo`);
        const endY = em.y + (em.height || 0);
        assert.ok(endY <= heightDots,
            `${em.kind} termina en y=${endY} > alto ${heightDots}`);
    }
    // Comprobamos orden top-down del flujo canónico:
    //   nombre(font 3) → separador(BAR) → precio(font 4) → unidad(font 2) → pie(font 1 + BARCODE)
    const nameYs = emissions.filter((e) => e.font === "3").map((e) => e.y);
    const sepYs = emissions.filter((e) => e.kind === "BAR").map((e) => e.y);
    const priceYs = emissions.filter((e) => e.font === "4").map((e) => e.y);
    const unitYs = emissions.filter((e) => e.font === "2").map((e) => e.y);
    const footerYs = emissions.filter((e) => e.font === "1").map((e) => e.y);
    const barcodeYs = emissions.filter((e) => e.kind === "BARCODE").map((e) => e.y);
    assert.ok(nameYs.length > 0, "nombre presente");
    assert.ok(sepYs.length > 0, "separador presente");
    assert.ok(priceYs.length > 0, "precio presente");
    assert.ok(unitYs.length > 0, "unidad presente");
    assert.ok(footerYs.length > 0, "pie (PLU/fecha) presente");
    assert.ok(barcodeYs.length > 0, "barcode presente");
    const maxName = Math.max(...nameYs);
    const minSep = Math.min(...sepYs);
    const minPrice = Math.min(...priceYs);
    const minUnit = Math.min(...unitYs);
    const minFooter = Math.min(...footerYs);
    const minBarcode = Math.min(...barcodeYs);
    assert.ok(maxName < minSep, `nombre debe terminar antes del separador: ${maxName} vs ${minSep}`);
    assert.ok(minSep < minPrice, `separador debe quedar antes del precio: ${minSep} vs ${minPrice}`);
    assert.ok(minPrice < minUnit, `precio antes que unidad: ${minPrice} vs ${minUnit}`);
    assert.ok(minUnit < minFooter, `unidad antes que pie: ${minUnit} vs ${minFooter}`);
    assert.ok(minBarcode <= minFooter,
        `barcode arranca igual o antes que el pie (comparten banda): bc=${minBarcode} pie=${minFooter}`);
});

test("buildTsplShelfLabelsDocument: BARCODE emitido con narrow/wide del thermal", () => {
    const text = shelfText({
        items: [{ code: "C1", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, barcodeNarrow: 3, barcodeWide: 3 },
    });
    assert.match(text, /BARCODE \d+,\d+,"128",\d+,0,0,3,3,"C1"/);
});

test("buildTsplShelfLabelsDocument: normalizeShelfThermalConfig clampa barcodeHeightMm a 2..60", () => {
    const low = normalizeShelfThermalConfig({ barcodeHeightMm: 0 });
    assert.equal(low.barcodeHeightMm, 2);
    const high = normalizeShelfThermalConfig({ barcodeHeightMm: 999 });
    assert.equal(high.barcodeHeightMm, 60);
    const ok = normalizeShelfThermalConfig({ barcodeHeightMm: 12 });
    assert.equal(ok.barcodeHeightMm, 12);
});

test("buildTsplShelfLabelsDocument: normalizeShelfThermalConfig aplica defaults a nuevos campos", () => {
    const cfg = normalizeShelfThermalConfig(undefined);
    assert.equal(cfg.showBarcode, true);
    assert.equal(cfg.barcodeHeightMm, 10);
    assert.equal(cfg.barcodeNarrow, 2);
    assert.equal(cfg.barcodeWide, 2);
    assert.equal(cfg.barcodeMaxChars, 24);
    assert.equal(cfg.showUnitLabel, true);
    assert.equal(cfg.unitLabel, "PRECIO UND");
    assert.equal(cfg.unitLabelFont, "2");
    assert.equal(cfg.showSeparator, true);
    assert.equal(cfg.separatorThicknessDots, 2);
    assert.equal(cfg.separatorGapDots, 3);
});

test("buildTsplShelfLabelsDocument: respeta overrides del admin para los campos nuevos", () => {
    const cfg = normalizeShelfThermalConfig({
        showBarcode: false,
        barcodeHeightMm: 7,
        barcodeNarrow: 4,
        barcodeWide: 4,
        barcodeMaxChars: 30,
        showUnitLabel: false,
        unitLabel: "KG",
        unitLabelFont: "3",
        unitLabelScaleX: 2,
        unitLabelScaleY: 2,
        showSeparator: false,
        separatorThicknessDots: 5,
        separatorGapDots: 7,
    });
    assert.equal(cfg.showBarcode, false);
    assert.equal(cfg.barcodeHeightMm, 7);
    assert.equal(cfg.barcodeNarrow, 4);
    assert.equal(cfg.barcodeWide, 4);
    assert.equal(cfg.barcodeMaxChars, 30);
    assert.equal(cfg.showUnitLabel, false);
    assert.equal(cfg.unitLabel, "KG");
    assert.equal(cfg.unitLabelFont, "3");
    assert.equal(cfg.unitLabelScaleX, 2);
    assert.equal(cfg.unitLabelScaleY, 2);
    assert.equal(cfg.showSeparator, false);
    assert.equal(cfg.separatorThicknessDots, 5);
    assert.equal(cfg.separatorGapDots, 7);
});

test("isCode128SafeAscii: ASCII imprimible válido, non-ASCII rechazado", () => {
    const { isCode128SafeAscii } = require("../label-generator");
    assert.equal(isCode128SafeAscii("LBL-001"), true);
    assert.equal(isCode128SafeAscii("ABCDE12345"), true);
    assert.equal(isCode128SafeAscii("PLU#123"), true);
    assert.equal(isCode128SafeAscii(""), false, "vacío → false");
    assert.equal(isCode128SafeAscii(null), false, "null → false");
    assert.equal(isCode128SafeAscii("ñandu"), false, "non-ASCII → false");
    assert.equal(isCode128SafeAscii('ABC"DEF'), false, "comillas rompen TSPL");
    assert.equal(isCode128SafeAscii("ABC\\DEF"), false, "backslash rompe TSPL");
    assert.equal(isCode128SafeAscii("ABC\u0007DEF"), false, "control chars rechazados");
    assert.equal(isCode128SafeAscii("ABC\u007FDEF"), false, "DEL rechazado");
});

test("isCode128SafeAscii: respeta el límite de longitud", () => {
    const { isCode128SafeAscii } = require("../label-generator");
    assert.equal(isCode128SafeAscii("A".repeat(24), 24), true);
    assert.equal(isCode128SafeAscii("A".repeat(25), 24), false);
    assert.equal(isCode128SafeAscii("A".repeat(48)), true, "default max 48");
    assert.equal(isCode128SafeAscii("A".repeat(49)), false);
});

test("code128SymbolWidthDots: ancho estimado monotónicamente creciente en n y narrow", () => {
    const { code128SymbolWidthDots } = require("../label-generator");
    const w1 = code128SymbolWidthDots(5, 2);
    const w2 = code128SymbolWidthDots(10, 2);
    const w3 = code128SymbolWidthDots(5, 4);
    assert.ok(w2 > w1, "más chars → más ancho");
    assert.ok(w3 > w1, "narrow más grande → más ancho");
    // 5 chars narrow=2 → (55+55)*2 = 220 dots.
    assert.equal(w1, 220);
});

test("buildTsplShelfLabelsDocument: NUNCA emite BARCODE cuando showBarcode=false aunque código sea válido", () => {
    const text = shelfText({
        items: [{ code: "PERFECTCODE", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: { ...SHELF_THERMAL_DEFAULTS, showBarcode: false },
    });
    assert.ok(!/BARCODE /.test(text), "showBarcode=false → sin BARCODE");
});

test("buildTsplShelfLabelsDocument: no incluye bytes de cajón (ESC p 0 ... = 1B 70 00)", () => {
    const buf = buildTsplShelfLabelsDocument({
        items: [{ code: "LBL-001", productName: "L", salePrice: 100, quantity: 1 }],
        thermal: SHELF_THERMAL_DEFAULTS,
        escapeFn: escapeForTspl, formatMoney,
    });
    const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.ok(!hex.includes("1b7000"),
        "ningún pulso de cajón ESC p 0 debe aparecer en el output TSPL");
});

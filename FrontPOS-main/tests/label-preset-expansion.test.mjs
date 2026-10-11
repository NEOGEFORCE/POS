import test from "node:test";
import assert from "node:assert/strict";

import {
    ACTIVE_MODES,
    BARCODE_ROTATIONS,
    BOUNDS,
    DEFAULT_DPI,
    LABEL_SIZE_50X30_GAPS,
    LABEL_SIZE_DIMENSIONS,
    LABEL_SIZE_PRESETS,
    LABEL_SIZE_PRESET_DEFAULTS,
    applyLabelSizePreset,
    buildBridgeConfigPayload,
    createDefaultPrintingConfig,
    mmToDots,
    sanitizePrintingConfig,
    setActiveMode,
} from "../src/lib/printing-config.mjs";

// ============================================================================
// Presets de etiqueta — set canónico tras `frontend-printing-v2`.
// ============================================================================

test("LABEL_SIZE_PRESETS incluye los 7 presets canónicos + CUSTOM", () => {
    const expected = new Set(["50x30", "40x30", "30x20", "30x20-2col", "58x40", "76x50", "CUSTOM"]);
    assert.deepEqual(new Set(Object.values(LABEL_SIZE_PRESETS)), expected);
});

test("LABEL_SIZE_DIMENSIONS: todos los presets físicos existen con medidas correctas", () => {
    assert.deepEqual(LABEL_SIZE_DIMENSIONS["50x30"], { widthMm: 50, heightMm: 30 });
    assert.deepEqual(LABEL_SIZE_DIMENSIONS["40x30"], { widthMm: 40, heightMm: 30 });
    assert.deepEqual(LABEL_SIZE_DIMENSIONS["30x20"], { widthMm: 30, heightMm: 20 });
    assert.deepEqual(LABEL_SIZE_DIMENSIONS["30x20-2col"], { widthMm: 30, heightMm: 20 });
    assert.deepEqual(LABEL_SIZE_DIMENSIONS["58x40"], { widthMm: 58, heightMm: 40 });
    assert.deepEqual(LABEL_SIZE_DIMENSIONS["76x50"], { widthMm: 76, heightMm: 50 });
});

test("LABEL_SIZE_PRESET_DEFAULTS: columns y gaps canónicos", () => {
    assert.deepEqual(LABEL_SIZE_PRESET_DEFAULTS["50x30"],
        { columns: 1, horizontalGapMm: 3, verticalGapMm: 0 });
    assert.deepEqual(LABEL_SIZE_PRESET_DEFAULTS["40x30"],
        { columns: 1, horizontalGapMm: 2, verticalGapMm: 0 });
    assert.deepEqual(LABEL_SIZE_PRESET_DEFAULTS["30x20"],
        { columns: 1, horizontalGapMm: 2, verticalGapMm: 0 });
    assert.deepEqual(LABEL_SIZE_PRESET_DEFAULTS["30x20-2col"],
        { columns: 2, horizontalGapMm: 2, verticalGapMm: 2 });
    assert.deepEqual(LABEL_SIZE_PRESET_DEFAULTS["58x40"],
        { columns: 1, horizontalGapMm: 2, verticalGapMm: 0 });
    assert.deepEqual(LABEL_SIZE_PRESET_DEFAULTS["76x50"],
        { columns: 1, horizontalGapMm: 3, verticalGapMm: 0 });
});

test("LABEL_SIZE_50X30_GAPS: sólo 2 o 3 son valores aceptados por el troquel", () => {
    assert.deepEqual(LABEL_SIZE_50X30_GAPS, [2, 3]);
});

// ============================================================================
// applyLabelSizePreset: fija dimensiones + columns + gaps canónicos
// ============================================================================

test("applyLabelSizePreset('30x20-2col'): fija 30×20, 2 columnas y vertical gap 2mm", () => {
    const c = applyLabelSizePreset(createDefaultPrintingConfig(), LABEL_SIZE_PRESETS["30X20_2COL"]);
    assert.equal(c.labels.sizePreset, "30x20-2col");
    assert.equal(c.labels.widthMm, 30);
    assert.equal(c.labels.heightMm, 20);
    assert.equal(c.labels.columns, 2);
    assert.equal(c.labels.horizontalGapMm, 2);
    assert.equal(c.labels.verticalGapMm, 2);
});

test("applyLabelSizePreset('58x40'): fija 58×40, 1 columna y gap 2mm", () => {
    const c = applyLabelSizePreset(createDefaultPrintingConfig(), LABEL_SIZE_PRESETS["58X40"]);
    assert.equal(c.labels.widthMm, 58);
    assert.equal(c.labels.heightMm, 40);
    assert.equal(c.labels.columns, 1);
    assert.equal(c.labels.horizontalGapMm, 2);
});

test("applyLabelSizePreset('76x50'): fija 76×50, 1 columna y gap 3mm", () => {
    const c = applyLabelSizePreset(createDefaultPrintingConfig(), LABEL_SIZE_PRESETS["76X50"]);
    assert.equal(c.labels.widthMm, 76);
    assert.equal(c.labels.heightMm, 50);
    assert.equal(c.labels.columns, 1);
    assert.equal(c.labels.horizontalGapMm, 3);
});

test("applyLabelSizePreset: aplicar el mismo preset dos veces es idempotente", () => {
    const once = applyLabelSizePreset(createDefaultPrintingConfig(), LABEL_SIZE_PRESETS["30X20_2COL"]);
    const twice = applyLabelSizePreset(once, LABEL_SIZE_PRESETS["30X20_2COL"]);
    const strip = (c) => {
        const copy = JSON.parse(JSON.stringify(c));
        copy.updatedAt = null;
        copy.source = "default";
        return copy;
    };
    assert.deepEqual(strip(twice), strip(once));
});

// ============================================================================
// Campos nuevos: verticalGapMm, marginLeftMm, dpi, barcode, layout
// ============================================================================

test("PrintingLabels: default expone verticalGapMm/marginLeftMm/dpi con valores canónicos", () => {
    const def = createDefaultPrintingConfig();
    assert.equal(typeof def.labels.verticalGapMm, "number");
    assert.equal(typeof def.labels.marginLeftMm, "number");
    assert.equal(def.labels.marginLeftMm, 0);
    assert.equal(def.labels.dpi, DEFAULT_DPI);
    assert.equal(DEFAULT_DPI, 203);
});

test("PrintingLabels: default expone barcode humanReadable/narrow/wide/rotation", () => {
    const def = createDefaultPrintingConfig();
    assert.equal(typeof def.labels.barcode.humanReadable, "boolean");
    assert.equal(def.labels.barcode.humanReadable, true);
    assert.equal(typeof def.labels.barcode.narrow, "number");
    assert.equal(typeof def.labels.barcode.wide, "number");
    assert.equal(def.labels.barcode.rotation, 0);
});

test("PrintingLabels: default expone layout tipado con posiciones en mm", () => {
    const def = createDefaultPrintingConfig();
    for (const block of ["name", "price", "barcode"]) {
        const b = def.labels.layout[block];
        assert.equal(typeof b.xMm, "number", `${block}.xMm debe ser número`);
        assert.equal(typeof b.yMm, "number", `${block}.yMm debe ser número`);
        assert.equal(typeof b.fontScale, "number", `${block}.fontScale debe ser número`);
    }
});

test("BARCODE_ROTATIONS: expone exactamente [0, 90, 180, 270]", () => {
    assert.deepEqual([...BARCODE_ROTATIONS], [0, 90, 180, 270]);
});

test("BOUNDS incluye verticalGapMm, marginLeftMm, dpi y barcodeModule", () => {
    assert.ok(BOUNDS.verticalGapMm);
    assert.ok(BOUNDS.marginLeftMm);
    assert.ok(BOUNDS.dpi);
    assert.ok(BOUNDS.barcodeModule);
    assert.ok(BOUNDS.layoutPosMm);
    assert.ok(BOUNDS.layoutFontScale);
});

test("sanitize: verticalGapMm fuera de rango se clampea", () => {
    const high = sanitizePrintingConfig({
        labels: { sizePreset: "CUSTOM", widthMm: 50, heightMm: 30, verticalGapMm: 999 },
    });
    assert.equal(high.labels.verticalGapMm, BOUNDS.verticalGapMm.max);
    const low = sanitizePrintingConfig({
        labels: { sizePreset: "CUSTOM", widthMm: 50, heightMm: 30, verticalGapMm: -10 },
    });
    assert.equal(low.labels.verticalGapMm, BOUNDS.verticalGapMm.min);
});

test("sanitize: marginLeftMm fuera de rango se clampea", () => {
    const over = sanitizePrintingConfig({ labels: { sizePreset: "CUSTOM", marginLeftMm: 999 } });
    assert.equal(over.labels.marginLeftMm, BOUNDS.marginLeftMm.max);
});

test("sanitize: dpi rotación aceptada; valores inválidos caen al default", () => {
    const custom300 = sanitizePrintingConfig({ labels: { sizePreset: "CUSTOM", dpi: 300 } });
    assert.equal(custom300.labels.dpi, 300);
    const invalid = sanitizePrintingConfig({ labels: { sizePreset: "CUSTOM", dpi: 9999 } });
    assert.equal(invalid.labels.dpi, BOUNDS.dpi.max);
});

test("sanitize: barcode.rotation sólo acepta 0/90/180/270", () => {
    for (const r of [0, 90, 180, 270]) {
        const c = sanitizePrintingConfig({ labels: { barcode: { rotation: r } } });
        assert.equal(c.labels.barcode.rotation, r);
    }
    const bad = sanitizePrintingConfig({ labels: { barcode: { rotation: 45 } } });
    assert.equal(bad.labels.barcode.rotation, 0, "rotación inválida cae al default 0°");
});

test("sanitize: barcode.narrow/wide se clampean dentro de BOUNDS.barcodeModule", () => {
    const high = sanitizePrintingConfig({ labels: { barcode: { narrow: 99, wide: 99 } } });
    assert.equal(high.labels.barcode.narrow, BOUNDS.barcodeModule.max);
    assert.equal(high.labels.barcode.wide, BOUNDS.barcodeModule.max);
});

test("sanitize: layout.xMm/yMm/fontScale se clampean contra el tamaño físico", () => {
    const c = sanitizePrintingConfig({
        labels: {
            sizePreset: "CUSTOM",
            widthMm: 40,
            heightMm: 30,
            layout: {
                name: { xMm: 999, yMm: 999, fontScale: 99 },
                price: { xMm: -10, yMm: -10, fontScale: -5 },
                barcode: { xMm: 5, yMm: 5, fontScale: 1.5 },
            },
        },
    });
    assert.ok(c.labels.layout.name.xMm <= 40);
    assert.ok(c.labels.layout.name.yMm <= 30);
    assert.ok(c.labels.layout.name.fontScale <= BOUNDS.layoutFontScale.max);
    assert.ok(c.labels.layout.price.xMm >= 0);
    assert.ok(c.labels.layout.price.yMm >= 0);
    assert.ok(c.labels.layout.price.fontScale >= BOUNDS.layoutFontScale.min);
    assert.equal(c.labels.layout.barcode.xMm, 5);
    assert.equal(c.labels.layout.barcode.yMm, 5);
    assert.equal(c.labels.layout.barcode.fontScale, 1.5);
});

test("sanitize: configs legacy sin los nuevos campos reciben defaults razonables (BC)", () => {
    const legacy = sanitizePrintingConfig({
        labels: {
            sizePreset: "50x30",
            widthMm: 50,
            heightMm: 30,
            columns: 1,
            horizontalGapMm: 2,
            // Sin verticalGapMm, marginLeftMm, dpi, layout, barcode.humanReadable...
        },
    });
    assert.equal(typeof legacy.labels.verticalGapMm, "number");
    assert.equal(typeof legacy.labels.marginLeftMm, "number");
    assert.equal(typeof legacy.labels.dpi, "number");
    assert.ok(legacy.labels.layout);
    assert.ok(legacy.labels.barcode.humanReadable !== undefined);
});

test("sanitize es idempotente con todos los campos nuevos", () => {
    const once = sanitizePrintingConfig({
        labels: {
            sizePreset: "76x50",
            marginLeftMm: 5,
            dpi: 300,
            layout: {
                name: { xMm: 3, yMm: 3, fontScale: 1.2 },
                price: { xMm: 3, yMm: 15, fontScale: 2.5 },
                barcode: { xMm: 3, yMm: 30, fontScale: 1 },
            },
            barcode: { narrow: 3, wide: 3, rotation: 90, humanReadable: false },
        },
    });
    const twice = sanitizePrintingConfig(once);
    assert.deepEqual(twice, once);
});

// ============================================================================
// activeMode + helpers nuevos
// ============================================================================

test("ACTIVE_MODES: expone RECEIPT y LABEL con valores canónicos", () => {
    assert.equal(ACTIVE_MODES.RECEIPT, "RECEIPT");
    assert.equal(ACTIVE_MODES.LABEL, "LABEL");
});

test("createDefaultPrintingConfig: activeMode default es RECEIPT (POS arranca como caja)", () => {
    const def = createDefaultPrintingConfig();
    assert.equal(def.activeMode, "RECEIPT");
});

test("setActiveMode: cambia activeMode preservando otros campos", () => {
    const base = createDefaultPrintingConfig();
    const asLabel = setActiveMode(base, "LABEL");
    assert.equal(asLabel.activeMode, "LABEL");
    // Otros campos preservados
    assert.equal(asLabel.receipt.paper, base.receipt.paper);
    assert.equal(asLabel.labels.sizePreset, base.labels.sizePreset);
});

test("setActiveMode: valor inválido cae al activeMode previo", () => {
    const base = sanitizePrintingConfig({ activeMode: "LABEL" });
    assert.equal(base.activeMode, "LABEL");
    const invalid = setActiveMode(base, "INVALID");
    assert.equal(invalid.activeMode, "LABEL",
        "Valor inválido no debe cambiar el modo activo.");
});

test("setActiveMode es idempotente", () => {
    const base = createDefaultPrintingConfig();
    const once = setActiveMode(base, "LABEL");
    const twice = setActiveMode(once, "LABEL");
    const strip = (c) => {
        const copy = JSON.parse(JSON.stringify(c));
        copy.updatedAt = null;
        copy.source = "default";
        return copy;
    };
    assert.deepEqual(strip(twice), strip(once));
});

test("sanitize: activeMode inválido cae al default RECEIPT", () => {
    const bad = sanitizePrintingConfig({ activeMode: "INVALID" });
    assert.equal(bad.activeMode, "RECEIPT");
});

// ============================================================================
// drawer.openDrawerOnSale
// ============================================================================

test("PrintingDrawer: default expone openDrawerOnSale=false", () => {
    const def = createDefaultPrintingConfig();
    assert.equal(def.drawer.openDrawerOnSale, false);
});

test("sanitize: drawer.openDrawerOnSale acepta true/false y preserva", () => {
    const yes = sanitizePrintingConfig({ drawer: { openDrawerOnSale: true } });
    assert.equal(yes.drawer.openDrawerOnSale, true);
    const no = sanitizePrintingConfig({ drawer: { openDrawerOnSale: false } });
    assert.equal(no.drawer.openDrawerOnSale, false);
});

// ============================================================================
// mmToDots
// ============================================================================

test("mmToDots: 25.4mm a 203dpi = 203 dots (una pulgada)", () => {
    assert.equal(mmToDots(25.4), 203);
});

test("mmToDots: 10mm a 203dpi = 80 dots (redondeado)", () => {
    assert.equal(mmToDots(10), 80);
});

test("mmToDots: default DPI es 203", () => {
    assert.equal(mmToDots(1), mmToDots(1, 203));
});

test("mmToDots: 300dpi produce más dots que 203dpi para el mismo mm", () => {
    assert.ok(mmToDots(10, 300) > mmToDots(10, 203));
});

test("mmToDots: valores inválidos devuelven 0", () => {
    assert.equal(mmToDots(0), 0);
    assert.equal(mmToDots(-1), 0);
    assert.equal(mmToDots(Number.NaN), 0);
    assert.equal(mmToDots("x"), 0);
});

// ============================================================================
// buildBridgeConfigPayload — payload tipado para el bridge
// ============================================================================

test("buildBridgeConfigPayload: expone activeMode + connection + receipt + labels + drawer", () => {
    const payload = buildBridgeConfigPayload(createDefaultPrintingConfig());
    assert.equal(typeof payload.activeMode, "string");
    assert.ok(payload.connection);
    assert.ok(payload.receipt);
    assert.ok(payload.labels);
    assert.ok(payload.drawer);
    assert.equal(typeof payload.openDrawerOnSale, "boolean");
});

test("buildBridgeConfigPayload: override openDrawerOnSale manda sobre config", () => {
    const base = sanitizePrintingConfig({ drawer: { openDrawerOnSale: false } });
    const forced = buildBridgeConfigPayload(base, { openDrawerOnSale: true });
    assert.equal(forced.openDrawerOnSale, true);
});

test("buildBridgeConfigPayload: sin override honra drawer.openDrawerOnSale de la config", () => {
    const yes = sanitizePrintingConfig({ drawer: { openDrawerOnSale: true } });
    assert.equal(buildBridgeConfigPayload(yes).openDrawerOnSale, true);
    const no = sanitizePrintingConfig({ drawer: { openDrawerOnSale: false } });
    assert.equal(buildBridgeConfigPayload(no).openDrawerOnSale, false);
});

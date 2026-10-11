// =============================================================================
// tests/frontend-bridge-wire-contract.test.mjs
//
// Tests CRUZADOS entre `src/lib/printing-config.mjs` (frontend) y
// `scale-bridge/{printer-bridge,label-generator}.js` (bridge). Garantizan
// que lo que la UI serializa coincide EXACTAMENTE con lo que el bridge
// consume, sin asumir que las dos capas evolucionan en paralelo.
//
// Cubre:
//   - 30x20-2col: SIZE del medio = 62 mm, GAP vertical = 2 mm (sensor del
//     troquel), X1=0 dots / X2=256 dots a 203 dpi, items aplanados por fila
//     con `PRINT 1,1`.
//   - Receipt 80mm / 58mm / JAL_838L: widthMm, printableWidthMm y columnas
//     reflejan lo que el bridge espera (frontend sanitize + bridge receipt
//     builder sin pedir campos extra).
//   - `labelItems` enriquecido GANA sobre `items` auditado al llegar al
//     bridge: la etiqueta física nunca pierde productName/salePrice por
//     seguir el shape minimal del POST /labels/print-jobs.
//   - `openDrawerOnSale` + `drawer.event` matrix: sólo venta exitosa + flag
//     explícito + evento BEFORE/AFTER dispara bytes del cajón. Reimpresión,
//     drawer MANUAL, drawer disabled nunca abren.
//   - `buildBridgeConfigPayload` expone exactamente las claves que el
//     bridge usa: activeMode, connection, receipt, labels, drawer,
//     openDrawerOnSale.
//
// Si el bridge cambia su interfaz (p.ej. renombra `labelItems` a `rows`),
// este archivo falla y señala la deriva antes de que llegue a producción.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ACTIVE_MODES,
    DRAWER_EVENTS,
    JALTECH_JAL_838L_SPEC,
    LABEL_SIZE_PRESETS,
    PAPER_PRESETS,
    applyLabelSizePreset,
    applyReceiptPaperPreset,
    buildBridgeConfigPayload,
    createDefaultPrintingConfig,
    mmToDots as frontendMmToDots,
    sanitizePrintingConfig,
} from "../src/lib/printing-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, "..", "..", "scale-bridge", "printer-bridge.js");
const labelGenPath = join(here, "..", "..", "scale-bridge", "label-generator.js");

const require = createRequire(import.meta.url);
const bridge = require(bridgePath);
const labelGen = require(labelGenPath);

// -----------------------------------------------------------------------------
// 1. mmToDots: frontend y bridge comparten la fórmula canónica.
// -----------------------------------------------------------------------------

test("mmToDots: 25.4 mm → 203 dots en ambos lados (fuente única de verdad)", () => {
    assert.equal(frontendMmToDots(25.4), 203);
    assert.equal(bridge.mmToDots(25.4), 203);
    assert.equal(labelGen.mmToDots(25.4), 203);
});

test("mmToDots: valores clave coinciden (30mm, 50mm, 76mm, 82mm)", () => {
    for (const mm of [10, 30, 50, 76, 82]) {
        assert.equal(frontendMmToDots(mm), labelGen.mmToDots(mm),
            `mmToDots(${mm}) debe coincidir frontend ↔ bridge`);
    }
});

// -----------------------------------------------------------------------------
// 2. 30x20-2col: sensor.gapMm se sincroniza con el troquel y TSPL emite
//    `GAP 2 mm, 0 mm` + offsets correctos en dots.
// -----------------------------------------------------------------------------

test("30x20-2col: applyLabelSizePreset sincroniza sensor.gapMm con el gap físico del troquel (2 mm)", () => {
    const base = createDefaultPrintingConfig();
    assert.equal(base.labels.sensor.gapMm, 3, "default sensor.gapMm es 3 mm");
    const c = applyLabelSizePreset(base, LABEL_SIZE_PRESETS["30X20_2COL"]);
    assert.equal(c.labels.verticalGapMm, 2);
    assert.equal(c.labels.sensor.gapMm, 2,
        "El preset 30x20-2col debe sincronizar sensor.gapMm con verticalGapMm (ambos 2 mm)");
});

test("30x20-2col: 1col presets NO tocan sensor.gapMm (queda en default 3 mm)", () => {
    const base = createDefaultPrintingConfig();
    for (const preset of [
        LABEL_SIZE_PRESETS["50X30"],
        LABEL_SIZE_PRESETS["40X30"],
        LABEL_SIZE_PRESETS["30X20"],
        LABEL_SIZE_PRESETS["58X40"],
        LABEL_SIZE_PRESETS["76X50"],
    ]) {
        const c = applyLabelSizePreset(base, preset);
        assert.equal(c.labels.sensor.gapMm, 3,
            `preset 1col ${preset} debe preservar sensor.gapMm=3 (no es parte de la especificación del preset)`);
    }
});

test("30x20-2col: bridge normalizeLabelsConfig devuelve verticalGapMm = 2 (coherente con el troquel)", () => {
    const c = applyLabelSizePreset(createDefaultPrintingConfig(), LABEL_SIZE_PRESETS["30X20_2COL"]);
    const normalized = labelGen.normalizeLabelsConfig(c.labels);
    assert.equal(normalized.verticalGapMm, 2,
        "El bridge debe recibir 2 mm (sensor del troquel 2 col), no 3 mm");
    assert.equal(normalized.columns, 2);
    assert.equal(normalized.widthMm, 30);
    assert.equal(normalized.horizontalGapMm, 2);
    assert.equal(normalized.marginLeftMm, 0);
    // mediumWidthMm = marginLeft + columns * widthMm + (columns-1) * horizontalGapMm
    assert.equal(normalized.mediumWidthMm, 0 + 2 * 30 + 1 * 2);
    assert.equal(normalized.mediumWidthMm, 62);
});

test("30x20-2col: computeColumnOffsets devuelve X1=0 y X2=256 dots a 203 dpi", () => {
    const c = applyLabelSizePreset(createDefaultPrintingConfig(), LABEL_SIZE_PRESETS["30X20_2COL"]);
    const normalized = labelGen.normalizeLabelsConfig(c.labels);
    const offsets = labelGen.computeColumnOffsets({
        marginLeftMm: normalized.marginLeftMm,
        labelWidthMm: normalized.widthMm,
        horizontalGapMm: normalized.horizontalGapMm,
        columns: normalized.columns,
        dpi: normalized.dpi,
    });
    // 30 mm = 240 dots, 2 mm = 16 dots → X2 = 0 + (240+16) = 256 dots.
    assert.deepEqual(offsets.offsets, [0, 256],
        "X1 = margen (0) y X2 = margen + widthDots + gapDots = 256");
    assert.equal(offsets.totalMm, 62);
    assert.ok(offsets.fits, "El medio de 62 mm cabe en el límite PHYSICAL_MAX_MM = 82 mm");
});

test("30x20-2col: TSPL emitido incluye SIZE 62 mm, GAP 2 mm y offsets correctos para ambas columnas", () => {
    const c = applyLabelSizePreset(createDefaultPrintingConfig(), LABEL_SIZE_PRESETS["30X20_2COL"]);
    const items = [
        { code: "A1", productName: "LECHE", salePrice: 3500, quantity: 1 },
        { code: "B2", productName: "PAN", salePrice: 2000, quantity: 1 },
    ];
    const tspl = bridge.buildTsplBatch(items, c.labels).toString("ascii");
    assert.match(tspl, /^SIZE 62 mm, 20 mm/, "SIZE del medio = ancho TOTAL (62 mm), no sólo etiqueta");
    assert.match(tspl, /GAP 2 mm, 0 mm/, "GAP vertical debe reflejar el sensor del troquel 2 col (2 mm)");
    // El frontend canónico persiste layout.name.xMm=2: 16 dots dentro de
    // cada etiqueta. Bases de columnas: 0 y 256 dots.
    assert.match(tspl, /TEXT 16,\d+,"3",0,1,1,"LECHE"/, "Columna 0: TEXT en layout.name.xMm=2");
    assert.match(tspl, /TEXT 272,\d+,"3",0,1,1,"PAN"/, "Columna 1: base 256 + x=16 dots");
    assert.match(tspl, /PRINT 1,1\r\n$/, "PRINT 1,1 cierra la fila (cantidades aplanadas)");
});

// -----------------------------------------------------------------------------
// 3. Recibos: 80/76/48 — 58/48/32 — JAL_838L/82/76/48/MANUAL.
// -----------------------------------------------------------------------------

test("Receipt 80mm: wire tiene widthMm=80, printableWidthMm=76, columns=48", () => {
    const c = applyReceiptPaperPreset(createDefaultPrintingConfig(), PAPER_PRESETS.WIDTH_80);
    const payload = buildBridgeConfigPayload(c);
    assert.equal(payload.receipt.widthMm, 80);
    assert.equal(payload.receipt.printableWidthMm, 76);
    assert.equal(payload.receipt.columns, 48);
});

test("Receipt 58mm: wire tiene widthMm=58, printableWidthMm=48, columns=32", () => {
    const c = applyReceiptPaperPreset(createDefaultPrintingConfig(), PAPER_PRESETS.WIDTH_58);
    const payload = buildBridgeConfigPayload(c);
    assert.equal(payload.receipt.widthMm, 58);
    assert.equal(payload.receipt.printableWidthMm, 48);
    assert.equal(payload.receipt.columns, 32);
});

test("Receipt JAL_838L: wire tiene widthMm=82, printableWidthMm=76, columns=48, cut=MANUAL", () => {
    const c = applyReceiptPaperPreset(createDefaultPrintingConfig(), PAPER_PRESETS.JAL_838L);
    const payload = buildBridgeConfigPayload(c);
    assert.equal(payload.receipt.widthMm, 82);
    assert.equal(payload.receipt.widthMm, JALTECH_JAL_838L_SPEC.physicalWidthMm);
    assert.equal(payload.receipt.printableWidthMm, 76);
    assert.equal(payload.receipt.printableWidthMm, JALTECH_JAL_838L_SPEC.printableWidthMm);
    assert.equal(payload.receipt.columns, 48);
    assert.equal(payload.receipt.cut, "MANUAL");
});

test("Receipt widthMm nunca supera 82 mm (Jaltech físico): un input de 999 cae a BOUNDS.receiptWidthMm.max", () => {
    // El bridge rechaza anchos > 82 mm en etiquetas (PHYSICAL_MAX_MM) con
    // LAYOUT_OUT_OF_BOUNDS; para recibos, el sanitize del frontend es la
    // frontera visible al usuario. Verificamos que un input absurdo se
    // clampa dentro de BOUNDS en vez de llegar al bridge con basura.
    const c = sanitizePrintingConfig({ receipt: { paper: "CUSTOM", widthMm: 999 } });
    assert.equal(c.receipt.widthMm, 82, `widthMm debe topar en 82, obtuvo ${c.receipt.widthMm}`);
    assert.ok(c.receipt.widthMm >= 20);
});

// -----------------------------------------------------------------------------
// 4. labelItems enriquecido GANA sobre items auditado.
// -----------------------------------------------------------------------------

test("Bridge normalizeLabelItems: labelItems (enriquecido) GANA sobre items (auditado)", () => {
    const normalized = bridge.normalizeLabelItems({
        // El payload /labels/print-jobs sólo lleva {code, quantity} (auditoría).
        items: [{ code: "AUDIT_ONLY", quantity: 1 }],
        // El bridge payload añade productName y salePrice en labelItems.
        labelItems: [{
            code: "ENRICHED",
            productName: "Nombre completo",
            salePrice: 1234,
            quantity: 2,
        }],
    });
    assert.equal(normalized.length, 1,
        "El bridge debe preferir labelItems (1 item) sobre items (1 item), nunca mezclar los dos");
    assert.equal(normalized[0].code, "ENRICHED",
        "La etiqueta física debe venir del labelItems (código enriquecido)");
    assert.equal(normalized[0].productName, "Nombre completo",
        "La etiqueta física debe conservar el productName del labelItems");
    assert.equal(normalized[0].salePrice, 1234,
        "La etiqueta física debe conservar el salePrice del labelItems");
    assert.equal(normalized[0].quantity, 2);
});

test("Bridge normalizeLabelItems: cae a `items` cuando no viene `labelItems` (BC con callers viejos)", () => {
    const normalized = bridge.normalizeLabelItems({
        items: [{ code: "FALLBACK_ONLY", quantity: 3 }],
    });
    assert.equal(normalized[0].code, "FALLBACK_ONLY");
    assert.equal(normalized[0].productName, "", "sin productName el bridge imprime etiqueta mínima");
    assert.equal(normalized[0].salePrice, 0);
    assert.equal(normalized[0].quantity, 3);
});

// -----------------------------------------------------------------------------
// 5. Drawer matrix: openDrawerOnSale + drawer.event + venta vs reimpresión.
// -----------------------------------------------------------------------------

test("Drawer wire: BEFORE_PRINT + openDrawerOnSale=true + venta exitosa → emite bytes antes del init", () => {
    const result = bridge.resolveAutoDrawerBytes({
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: DRAWER_EVENTS.BEFORE_PRINT },
        openDrawerOnSale: true,
        event: DRAWER_EVENTS.BEFORE_PRINT,
    });
    assert.ok(result, "debe devolver bytes del cajón");
    assert.equal(result.event, "BEFORE_PRINT");
    assert.ok(Buffer.isBuffer(result.buf));
    assert.ok(result.buf.length > 0);
});

test("Drawer wire: AFTER_PRINT + openDrawerOnSale=true + venta exitosa → emite bytes después del corte", () => {
    const result = bridge.resolveAutoDrawerBytes({
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: DRAWER_EVENTS.AFTER_PRINT },
        openDrawerOnSale: true,
        event: DRAWER_EVENTS.AFTER_PRINT,
    });
    assert.ok(result);
    assert.equal(result.event, "AFTER_PRINT");
});

test("Drawer wire: drawer.event=MANUAL NUNCA abre automático (ni con flag)", () => {
    const result = bridge.resolveAutoDrawerBytes({
        drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: DRAWER_EVENTS.MANUAL },
        openDrawerOnSale: true,
        event: DRAWER_EVENTS.MANUAL,
    });
    assert.equal(result, null,
        "MANUAL exige botón explícito; nunca se dispara por venta exitosa");
});

test("Drawer wire: reimpresión (openDrawerOnSale ausente / false) NUNCA abre", () => {
    for (const flag of [false, undefined, null, 0, "true"]) {
        const result = bridge.resolveAutoDrawerBytes({
            drawer: { enabled: true, command: "\\x1B\\x70\\x00\\x19\\xFA", event: DRAWER_EVENTS.AFTER_PRINT },
            openDrawerOnSale: flag,
            event: DRAWER_EVENTS.AFTER_PRINT,
        });
        assert.equal(result, null,
            `openDrawerOnSale=${JSON.stringify(flag)} jamás debe disparar (sólo === true)`);
    }
});

test("Drawer wire: drawer.enabled=false NUNCA abre (aunque todo lo demás esté bien)", () => {
    const result = bridge.resolveAutoDrawerBytes({
        drawer: { enabled: false, command: "\\x1B\\x70\\x00\\x19\\xFA", event: DRAWER_EVENTS.AFTER_PRINT },
        openDrawerOnSale: true,
        event: DRAWER_EVENTS.AFTER_PRINT,
    });
    assert.equal(result, null,
        "Cajón deshabilitado por el admin cancela cualquier flujo automático");
});

test("Drawer wire: drawer.command inválido se traga silencioso (recibo sale sin cajón)", () => {
    const result = bridge.resolveAutoDrawerBytes({
        drawer: { enabled: true, command: "basura inválida {}{} not escapes", event: DRAWER_EVENTS.AFTER_PRINT },
        openDrawerOnSale: true,
        event: DRAWER_EVENTS.AFTER_PRINT,
    });
    assert.equal(result, null,
        "comando malformado no debe filtrar bytes raros al recibo; el admin arregla el preset");
});

// -----------------------------------------------------------------------------
// 6. buildBridgeConfigPayload shape: expone sólo lo que el bridge necesita.
// -----------------------------------------------------------------------------

test("buildBridgeConfigPayload: shape expone activeMode + connection + receipt + labels + drawer + openDrawerOnSale", () => {
    const payload = buildBridgeConfigPayload(createDefaultPrintingConfig());
    assert.deepEqual(
        Object.keys(payload).sort(),
        ["activeMode", "connection", "drawer", "labels", "openDrawerOnSale", "receipt"].sort(),
    );
});

test("buildBridgeConfigPayload: openDrawerOnSale override gana sobre drawer.openDrawerOnSale persistido", () => {
    const persisted = sanitizePrintingConfig({ drawer: { openDrawerOnSale: false } });
    const payload = buildBridgeConfigPayload(persisted, { openDrawerOnSale: true });
    assert.equal(payload.openDrawerOnSale, true,
        "El consumidor (ej. UniversalPaymentModal) manda el flag según el contexto, no la config persistida");
    assert.equal(payload.drawer.openDrawerOnSale, false,
        "El drawer sub-objeto preserva la config persistida — el override es una capa superior");
});

test("buildBridgeConfigPayload: con activeMode LABEL propaga el hint al bridge", () => {
    const c = sanitizePrintingConfig({ activeMode: ACTIVE_MODES.LABEL });
    const payload = buildBridgeConfigPayload(c);
    assert.equal(payload.activeMode, "LABEL");
});

// -----------------------------------------------------------------------------
// 7. ActiveMode y bridgeConfig honran el modo elegido.
// -----------------------------------------------------------------------------

test("Cross: cambiar activeMode no afecta a la lógica física del bridge (es un hint, no una restricción)", () => {
    const c = sanitizePrintingConfig({ activeMode: ACTIVE_MODES.LABEL });
    const items = [{ code: "X", productName: "ETIQUETA", salePrice: 1000, quantity: 1 }];
    // Aunque activeMode sea LABEL, podemos imprimir recibos sin bloqueos: el
    // bridge nunca rechaza un payload por `activeMode` — es sólo un hint
    // para priorizar impresoras.
    const tspl = bridge.buildTsplBatch(items, c.labels);
    assert.ok(tspl.length > 0);
});

// -----------------------------------------------------------------------------
// 8. Items quantity: la cantidad se aplana en el bridge → PRINT 1,1 por fila.
// -----------------------------------------------------------------------------

test("Cross: qty=4 en 1 col produce 4 filas (PRINT 1,1), nunca TSPL `PRINT 1,4`", () => {
    const c = applyLabelSizePreset(createDefaultPrintingConfig(), LABEL_SIZE_PRESETS["50X30"]);
    const items = [{ code: "RICE", productName: "ARROZ", salePrice: 2000, quantity: 4 }];
    const tspl = bridge.buildTsplBatch(items, c.labels).toString("ascii");
    // Debe haber 4 bloques "CLS ... PRINT 1,1" (uno por copia).
    const prints = (tspl.match(/PRINT 1,1/g) || []).length;
    assert.equal(prints, 4, `qty=4 en 1 col debe producir 4 PRINT 1,1, obtuvo ${prints}`);
    const cls = (tspl.match(/CLS/g) || []).length;
    assert.equal(cls, 4, `qty=4 en 1 col debe producir 4 CLS (uno por fila)`);
});

test("Cross: qty=4 en 2 col produce 2 filas (PRINT 1,1 x2), cada una con 2 items", () => {
    const c = applyLabelSizePreset(createDefaultPrintingConfig(), LABEL_SIZE_PRESETS["30X20_2COL"]);
    const items = [{ code: "SODA", productName: "GASEOSA", salePrice: 2500, quantity: 4 }];
    const tspl = bridge.buildTsplBatch(items, c.labels).toString("ascii");
    const prints = (tspl.match(/PRINT 1,1/g) || []).length;
    assert.equal(prints, 2, `qty=4 en 2 col debe producir 2 PRINT 1,1 (4/2 = 2 filas), obtuvo ${prints}`);
});

// -----------------------------------------------------------------------------
// 9. Marco físico: el frontend NUNCA produce un medio que exceda PHYSICAL_MAX_MM.
// -----------------------------------------------------------------------------

test("Cross: todos los presets canónicos del frontend caben en PHYSICAL_MAX_MM (82mm)", () => {
    for (const preset of [
        LABEL_SIZE_PRESETS["50X30"],
        LABEL_SIZE_PRESETS["40X30"],
        LABEL_SIZE_PRESETS["30X20"],
        LABEL_SIZE_PRESETS["30X20_2COL"],
        LABEL_SIZE_PRESETS["58X40"],
        LABEL_SIZE_PRESETS["76X50"],
    ]) {
        const c = applyLabelSizePreset(createDefaultPrintingConfig(), preset);
        const normalized = labelGen.normalizeLabelsConfig(c.labels);
        const offsets = labelGen.computeColumnOffsets({
            marginLeftMm: normalized.marginLeftMm,
            labelWidthMm: normalized.widthMm,
            horizontalGapMm: normalized.horizontalGapMm,
            columns: normalized.columns,
            dpi: normalized.dpi,
        });
        assert.ok(offsets.fits,
            `preset ${preset}: medio=${offsets.totalMm}mm no cabe en PHYSICAL_MAX_MM=${labelGen.PHYSICAL_MAX_MM}mm`);
    }
});

// -----------------------------------------------------------------------------
// 10. Idempotencia: aplicar el preset dos veces no desincroniza sensor.gapMm.
// -----------------------------------------------------------------------------

test("30x20-2col: aplicar el preset dos veces mantiene sensor.gapMm=2 (idempotente)", () => {
    const once = applyLabelSizePreset(createDefaultPrintingConfig(), LABEL_SIZE_PRESETS["30X20_2COL"]);
    const twice = applyLabelSizePreset(once, LABEL_SIZE_PRESETS["30X20_2COL"]);
    assert.equal(twice.labels.sensor.gapMm, 2);
    assert.equal(twice.labels.verticalGapMm, 2);
});



// -----------------------------------------------------------------------------
// 11. Contrato layout canónico + aliases legacy + TSPL exacto.
// -----------------------------------------------------------------------------

test("Cross: shape frontend layout.name/price/barcode produce TSPL exacto con opciones no-default", () => {
    const config = sanitizePrintingConfig({
        labels: {
            sizePreset: "CUSTOM",
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
                barcode: { xMm: 2.5, yMm: 17, fontScale: 1 },
            },
        },
    });

    const actual = bridge.buildTsplBatch([
        { code: "ABC123", productName: "PRD", salePrice: 1234, quantity: 1 },
    ], config.labels).toString("ascii");

    const expected = [
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
    ].join("\r\n");
    assert.equal(actual, expected);
});

test("Cross: aliases legacy siguen aceptados pero layout canónico gana cuando ambos vienen", () => {
    const normalized = labelGen.normalizeLabelsConfig({
        widthMm: 50,
        heightMm: 30,
        layout: {
            name: { xMm: 4, yMm: 5, font: "6", fontScale: 2 },
            productName: { xMm: 1, yMm: 1, font: "2", scaleX: 1, scaleY: 1 },
            price: { xMm: 7, yMm: 11, font: "8", fontScale: 3 },
            salePrice: { xMm: 2, yMm: 2, font: "3", scaleX: 1, scaleY: 1 },
        },
    });
    assert.deepEqual(
        { xMm: normalized.layout.productName.xMm, yMm: normalized.layout.productName.yMm, font: normalized.layout.productName.font, scaleX: normalized.layout.productName.scaleX },
        { xMm: 4, yMm: 5, font: "6", scaleX: 2 },
    );
    assert.deepEqual(
        { xMm: normalized.layout.salePrice.xMm, yMm: normalized.layout.salePrice.yMm, font: normalized.layout.salePrice.font, scaleX: normalized.layout.salePrice.scaleX },
        { xMm: 7, yMm: 11, font: "8", scaleX: 3 },
    );
});

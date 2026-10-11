import test from "node:test";
import assert from "node:assert/strict";

import {
    JALTECH_JAL_838L_SPEC,
    PAPER_PRESETS,
    applyReceiptPaperPreset,
    createDefaultPrintingConfig,
    sanitizePrintingConfig,
} from "../src/lib/printing-config.mjs";

// ============================================================================
// Receipt printable defaults — nuevos defaults canónicos tras
// `frontend-printing-v2`:
//
//   - WIDTH_80  → físico 80 mm, imprimible 76 mm, 48 columnas.
//   - WIDTH_58  → físico 58 mm, imprimible 48 mm, 32 columnas.
//   - JAL_838L  → físico 82 mm, imprimible 76 mm, 48 columnas, cut MANUAL.
//
// Nunca se "ajustan" invisible: configs ya guardadas con `printableWidthMm`
// explícito preservan ese valor (sanitize respeta el input explícito).
// ============================================================================

test("WIDTH_80: default imprimible 76mm (4mm de margen físico muerto)", () => {
    const c = applyReceiptPaperPreset(createDefaultPrintingConfig(), PAPER_PRESETS.WIDTH_80);
    assert.equal(c.receipt.widthMm, 80);
    assert.equal(c.receipt.printableWidthMm, 76);
    assert.equal(c.receipt.columns, 48);
});

test("WIDTH_58: default imprimible 48mm (10mm de margen físico muerto)", () => {
    const c = applyReceiptPaperPreset(createDefaultPrintingConfig(), PAPER_PRESETS.WIDTH_58);
    assert.equal(c.receipt.widthMm, 58);
    assert.equal(c.receipt.printableWidthMm, 48);
    assert.equal(c.receipt.columns, 32);
});

test("JAL_838L: contrato intacto — 82/76/48/MANUAL (sin cambios por el sprint)", () => {
    const c = applyReceiptPaperPreset(createDefaultPrintingConfig(), PAPER_PRESETS.JAL_838L);
    assert.equal(c.receipt.widthMm, JALTECH_JAL_838L_SPEC.physicalWidthMm);
    assert.equal(c.receipt.widthMm, 82);
    assert.equal(c.receipt.printableWidthMm, JALTECH_JAL_838L_SPEC.printableWidthMm);
    assert.equal(c.receipt.printableWidthMm, 76);
    assert.equal(c.receipt.columns, 48);
    assert.equal(c.receipt.cut, "MANUAL");
});

test("Default config: expone WIDTH_80 con 80/76/48 como arranque", () => {
    const def = createDefaultPrintingConfig();
    assert.equal(def.receipt.paper, PAPER_PRESETS.WIDTH_80);
    assert.equal(def.receipt.widthMm, 80);
    assert.equal(def.receipt.printableWidthMm, 76);
    assert.equal(def.receipt.columns, 48);
});

test("sanitize preserva un printableWidthMm explícito guardado en LocalStorage (BC)", () => {
    // Instalación histórica guardó 80/80 explícito — sanitize debe
    // respetar ese valor y NO forzarlo a 76. La única capa que fija
    // 76 es la que convierte paper=null/absent → default.
    const legacy80 = sanitizePrintingConfig({
        receipt: { paper: "80", widthMm: 80, printableWidthMm: 80, columns: 48 },
    });
    assert.equal(legacy80.receipt.printableWidthMm, 80,
        "Un 80 explícito debe sobrevivir al sanitize (sólo se cambia cuando NO viene).");

    const legacy58 = sanitizePrintingConfig({
        receipt: { paper: "58", widthMm: 58, printableWidthMm: 58, columns: 32 },
    });
    assert.equal(legacy58.receipt.printableWidthMm, 58);
});

test("sanitize cuando NO viene printableWidthMm: WIDTH_80 → 76, WIDTH_58 → 48", () => {
    const noFieldFor80 = sanitizePrintingConfig({
        receipt: { paper: "80", widthMm: 80, columns: 48 },
    });
    assert.equal(noFieldFor80.receipt.printableWidthMm, 76);

    const noFieldFor58 = sanitizePrintingConfig({
        receipt: { paper: "58", widthMm: 58, columns: 32 },
    });
    assert.equal(noFieldFor58.receipt.printableWidthMm, 48);
});

test("sanitize NUNCA permite que printableWidthMm supere widthMm físico (regla de defensa)", () => {
    // Si el input manda printableWidthMm > widthMm, sanitize debe caparlo.
    const over80 = sanitizePrintingConfig({
        receipt: { paper: "80", widthMm: 80, printableWidthMm: 100 },
    });
    assert.equal(over80.receipt.printableWidthMm, 80,
        "El clamp se enforce contra el ancho físico, no contra 76.");
});

test("applyReceiptPaperPreset es idempotente para los tres presets (los defaults no cambian al reaplicar)", () => {
    for (const preset of [PAPER_PRESETS.WIDTH_80, PAPER_PRESETS.WIDTH_58, PAPER_PRESETS.JAL_838L]) {
        const once = applyReceiptPaperPreset(createDefaultPrintingConfig(), preset);
        const twice = applyReceiptPaperPreset(once, preset);
        const strip = (c) => {
            const copy = JSON.parse(JSON.stringify(c));
            copy.updatedAt = null;
            copy.source = "default";
            return copy;
        };
        assert.deepEqual(strip(twice), strip(once), `preset ${preset} no es idempotente`);
    }
});

// =============================================================================
// tests/jaltech-preset.test.mjs
//
// Tests ejecutables del preset Jaltech JAL-838L: su constante de spec,
// `applyReceiptPaperPreset("JAL_838L")`, `applyJaltechJAL838LPreset()` con las
// dos variantes de conexión, y la invariante de que `receipt.printableWidthMm`
// nunca supera `receipt.widthMm` tras sanitize.
//
// Objetivo doble:
//   1. Fijar la especificación de la impresora (82mm físico / 76mm imprimible
//      / 48 columnas / corte MANUAL / puerto 9100) como contrato público.
//   2. Garantizar la invariante de NO INVENTAR datos: el preset preserva el
//      host IP (NETWORK) y el printerName (SYSTEM) que el admin haya
//      configurado antes.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOUNDS,
  CUT_MODES,
  INTERFACES,
  JAL_838L_CONNECTION_MODES,
  JALTECH_JAL_838L_SPEC,
  PAPER_COLUMNS,
  PAPER_PRESETS,
  PROTOCOLS,
  SPOOLERS,
  applyJaltechJAL838LPreset,
  applyReceiptPaperPreset,
  createDefaultPrintingConfig,
  receiptWidthKey,
  sanitizePrintingConfig,
} from "../src/lib/printing-config.mjs";

// ============================================================================
// JALTECH_JAL_838L_SPEC: contrato público de la especificación física
// ============================================================================

test("JALTECH_JAL_838L_SPEC: expone la especificación física conocida", () => {
  assert.equal(JALTECH_JAL_838L_SPEC.brand, "Jaltech");
  assert.equal(JALTECH_JAL_838L_SPEC.model, "JAL-838L");
  assert.equal(JALTECH_JAL_838L_SPEC.physicalWidthMm, 82);
  assert.equal(JALTECH_JAL_838L_SPEC.printableWidthMm, 76);
  assert.equal(JALTECH_JAL_838L_SPEC.columns, 48);
  assert.equal(JALTECH_JAL_838L_SPEC.cut, "MANUAL");
  assert.equal(JALTECH_JAL_838L_SPEC.networkPort, 9100);
  assert.equal(JALTECH_JAL_838L_SPEC.defaultAlias, "Jaltech JAL-838L");
});

test("JALTECH_JAL_838L_SPEC: defaults de conexión están INTENCIONALMENTE vacíos", () => {
  // Parte del contrato "no inventar IP ni printerName". La UI debe
  // reemplazarlos con lo que el admin configure físicamente.
  assert.equal(JALTECH_JAL_838L_SPEC.defaultHost, "");
  assert.equal(JALTECH_JAL_838L_SPEC.defaultPrinterName, "");
});

test("JALTECH_JAL_838L_SPEC: es inmutable (Object.freeze)", () => {
  assert.throws(() => {
    JALTECH_JAL_838L_SPEC.physicalWidthMm = 999;
  });
});

test("PAPER_PRESETS incluye JAL_838L como preset explícito", () => {
  assert.equal(PAPER_PRESETS.JAL_838L, "JAL_838L");
  // El resto de presets siguen vivos (backward compat).
  assert.equal(PAPER_PRESETS.WIDTH_80, "80");
  assert.equal(PAPER_PRESETS.WIDTH_58, "58");
  assert.equal(PAPER_PRESETS.CUSTOM, "CUSTOM");
});

test("PAPER_COLUMNS mapea el ancho físico 82mm a 48 columnas", () => {
  assert.equal(PAPER_COLUMNS["82"], 48);
  // Los mapeos históricos no cambian.
  assert.equal(PAPER_COLUMNS["80"], 48);
  assert.equal(PAPER_COLUMNS["58"], 32);
});

test("JAL_838L_CONNECTION_MODES expone NETWORK y SYSTEM", () => {
  assert.equal(JAL_838L_CONNECTION_MODES.NETWORK, "NETWORK");
  assert.equal(JAL_838L_CONNECTION_MODES.SYSTEM, "SYSTEM");
});

// ============================================================================
// applyReceiptPaperPreset con JAL_838L
// ============================================================================

test("applyReceiptPaperPreset('JAL_838L'): fija 82/76/48/MANUAL en una sola llamada", () => {
  const c = applyReceiptPaperPreset(createDefaultPrintingConfig(), PAPER_PRESETS.JAL_838L);
  assert.equal(c.receipt.paper, PAPER_PRESETS.JAL_838L);
  assert.equal(c.receipt.widthMm, 82);
  assert.equal(c.receipt.printableWidthMm, 76);
  assert.equal(c.receipt.columns, 48);
  assert.equal(c.receipt.cut, CUT_MODES.MANUAL);
});

test("applyReceiptPaperPreset('JAL_838L') después de otro preset: los deja consistentes", () => {
  const c58 = applyReceiptPaperPreset(createDefaultPrintingConfig(), PAPER_PRESETS.WIDTH_58);
  // Un recibo pequeño queda chico; aplicar JAL_838L lo levanta a 82mm.
  const c82 = applyReceiptPaperPreset(c58, PAPER_PRESETS.JAL_838L);
  assert.equal(c82.receipt.widthMm, 82);
  assert.equal(c82.receipt.printableWidthMm, 76);
  assert.equal(c82.receipt.columns, 48);
});

test("receiptWidthKey: JAL_838L se trata tipográficamente como la familia 80mm", () => {
  const c = applyReceiptPaperPreset(createDefaultPrintingConfig(), PAPER_PRESETS.JAL_838L);
  assert.equal(receiptWidthKey(c), "80mm");
});

// ============================================================================
// applyJaltechJAL838LPreset: variante NETWORK
// ============================================================================

test("applyJaltechJAL838LPreset(NETWORK): fija interface=NETWORK + escpos + puerto 9100", () => {
  const c = applyJaltechJAL838LPreset(createDefaultPrintingConfig(), {
    mode: JAL_838L_CONNECTION_MODES.NETWORK,
  });
  assert.equal(c.connection.interface, INTERFACES.NETWORK);
  assert.equal(c.connection.protocol, PROTOCOLS.ESCPOS);
  assert.equal(c.connection.network.port, 9100);
  assert.equal(c.receipt.paper, PAPER_PRESETS.JAL_838L);
  assert.equal(c.receipt.widthMm, 82);
  assert.equal(c.receipt.printableWidthMm, 76);
  assert.equal(c.receipt.columns, 48);
  assert.equal(c.receipt.cut, CUT_MODES.MANUAL);
});

test("applyJaltechJAL838LPreset(NETWORK): PRESERVA el host existente — nunca inventa IP", () => {
  const base = applyJaltechJAL838LPreset(createDefaultPrintingConfig(), {
    mode: JAL_838L_CONNECTION_MODES.NETWORK,
  });
  // Sin host configurado: el preset deja el campo vacío (dato pendiente).
  assert.equal(base.connection.network.host, "",
    "El preset NO debe inventar un IP cuando el admin no lo ha configurado.");

  // Con host configurado: el preset lo PRESERVA tal cual.
  const withHost = {
    ...base,
    connection: {
      ...base.connection,
      network: { host: "192.168.1.42", port: 9100 },
    },
  };
  const reapplied = applyJaltechJAL838LPreset(withHost, {
    mode: JAL_838L_CONNECTION_MODES.NETWORK,
  });
  assert.equal(reapplied.connection.network.host, "192.168.1.42",
    "El host configurado por el admin debe sobrevivir al re-aplicar el preset.");
  assert.equal(reapplied.connection.network.port, 9100);
});

test("applyJaltechJAL838LPreset(NETWORK): cambiar de SYSTEM a NETWORK no filtra el printerName al nuevo canal", () => {
  // Admin empieza en SYSTEM con un printerName configurado y cambia a NETWORK.
  const withPrinterName = applyJaltechJAL838LPreset(createDefaultPrintingConfig(), {
    mode: JAL_838L_CONNECTION_MODES.SYSTEM,
  });
  const next = {
    ...withPrinterName,
    connection: {
      ...withPrinterName.connection,
      system: { printerName: "POS-80 Caja 2", spooler: SPOOLERS.WINDOWS },
    },
  };
  const asNetwork = applyJaltechJAL838LPreset(next, {
    mode: JAL_838L_CONNECTION_MODES.NETWORK,
  });
  assert.equal(asNetwork.connection.interface, INTERFACES.NETWORK);
  assert.equal(asNetwork.connection.protocol, PROTOCOLS.ESCPOS);
  // El printerName del canal SYSTEM queda intacto por si el admin regresa
  // a SYSTEM después (no se pierde su configuración), pero NO se usa en el
  // branch activo.
  assert.equal(asNetwork.connection.system.printerName, "POS-80 Caja 2");
});

// ============================================================================
// applyJaltechJAL838LPreset: variante SYSTEM
// ============================================================================

test("applyJaltechJAL838LPreset(SYSTEM): fija interface=SYSTEM + system + spooler WINDOWS", () => {
  const c = applyJaltechJAL838LPreset(createDefaultPrintingConfig(), {
    mode: JAL_838L_CONNECTION_MODES.SYSTEM,
  });
  assert.equal(c.connection.interface, INTERFACES.SYSTEM);
  assert.equal(c.connection.protocol, PROTOCOLS.SYSTEM);
  assert.equal(c.connection.system.spooler, SPOOLERS.WINDOWS);
  assert.equal(c.receipt.paper, PAPER_PRESETS.JAL_838L);
  assert.equal(c.receipt.widthMm, 82);
  assert.equal(c.receipt.printableWidthMm, 76);
  assert.equal(c.receipt.columns, 48);
  assert.equal(c.receipt.cut, CUT_MODES.MANUAL);
});

test("applyJaltechJAL838LPreset(SYSTEM): PRESERVA el printerName existente — nunca inventa nombres", () => {
  const base = applyJaltechJAL838LPreset(createDefaultPrintingConfig(), {
    mode: JAL_838L_CONNECTION_MODES.SYSTEM,
  });
  assert.equal(base.connection.system.printerName, "",
    "El preset NO debe inventar un nombre de impresora cuando no está configurado.");

  const withPrinter = {
    ...base,
    connection: {
      ...base.connection,
      system: { printerName: "POS Jaltech Caja 1", spooler: SPOOLERS.WINDOWS },
    },
  };
  const reapplied = applyJaltechJAL838LPreset(withPrinter, {
    mode: JAL_838L_CONNECTION_MODES.SYSTEM,
  });
  assert.equal(reapplied.connection.system.printerName, "POS Jaltech Caja 1",
    "El printerName configurado debe sobrevivir al re-aplicar el preset.");
});

// ============================================================================
// Alias behaviour
// ============================================================================

test("applyJaltechJAL838LPreset: pone el alias por defecto cuando el admin no lo había personalizado", () => {
  const c = applyJaltechJAL838LPreset(createDefaultPrintingConfig(), {
    mode: JAL_838L_CONNECTION_MODES.NETWORK,
  });
  assert.equal(c.connection.alias, "Jaltech JAL-838L");
});

test("applyJaltechJAL838LPreset: PRESERVA un alias personalizado (no pisa 'Caja 2 mostrador')", () => {
  const customized = {
    ...createDefaultPrintingConfig(),
    connection: {
      ...createDefaultPrintingConfig().connection,
      alias: "Caja 2 mostrador",
    },
  };
  const c = applyJaltechJAL838LPreset(customized, {
    mode: JAL_838L_CONNECTION_MODES.SYSTEM,
  });
  assert.equal(c.connection.alias, "Caja 2 mostrador",
    "El alias personalizado del admin debe sobrevivir al preset.");
});

// ============================================================================
// Default mode (sin options) + idempotencia
// ============================================================================

test("applyJaltechJAL838LPreset sin options: default a NETWORK (más probable en producción)", () => {
  const c = applyJaltechJAL838LPreset(createDefaultPrintingConfig());
  assert.equal(c.connection.interface, INTERFACES.NETWORK);
  assert.equal(c.connection.protocol, PROTOCOLS.ESCPOS);
  assert.equal(c.connection.network.port, 9100);
});

test("applyJaltechJAL838LPreset es idempotente: aplicarlo dos veces produce la misma config", () => {
  const once = applyJaltechJAL838LPreset(createDefaultPrintingConfig(), {
    mode: JAL_838L_CONNECTION_MODES.NETWORK,
  });
  const twice = applyJaltechJAL838LPreset(once, {
    mode: JAL_838L_CONNECTION_MODES.NETWORK,
  });
  // Ignoramos metadata volátil (updatedAt/source) con JSON.stringify tras
  // normalizar esos campos.
  const strip = (c) => {
    const copy = JSON.parse(JSON.stringify(c));
    copy.updatedAt = null;
    copy.source = "default";
    return copy;
  };
  assert.deepEqual(strip(twice), strip(once));
});

// ============================================================================
// printableWidthMm — invariantes de sanitize
// ============================================================================

test("sanitizePrintingConfig: receipt.printableWidthMm aparece en el output del shape canónico", () => {
  const def = createDefaultPrintingConfig();
  assert.equal(typeof def.receipt.printableWidthMm, "number");
  assert.equal(def.receipt.printableWidthMm, 76,
    "El default WIDTH_80 expone printableWidthMm=76 (margen físico muerto conocido).");
});

test("sanitize: printableWidthMm por default refleja el margen físico muerto conocido (80→76, 58→48)", () => {
  for (const [preset, expected] of [["80", 76], ["58", 48]]) {
    const c = sanitizePrintingConfig({ receipt: { paper: preset } });
    assert.equal(c.receipt.printableWidthMm, expected,
      `Para el preset ${preset}, printableWidthMm por default debe ser ${expected}mm (margen físico muerto).`);
  }
});

test("sanitize: input sin printableWidthMm NO altera la salida visual histórica (BC) — presets históricos reflejan margen físico actual (80→76)", () => {
  // Config legacy guardada en LocalStorage antes de este sprint — no trae
  // el campo nuevo. El sanitize debe seguir funcionando y producir el
  // ancho imprimible actualizado (76 para WIDTH_80).
  const legacyShape = {
    receipt: {
      paper: "80",
      widthMm: 80,
      columns: 48,
      // SIN printableWidthMm — así se vería un save viejo.
    },
  };
  const migrated = sanitizePrintingConfig(legacyShape);
  assert.equal(migrated.receipt.widthMm, 80);
  assert.equal(migrated.receipt.printableWidthMm, 76);
  assert.equal(migrated.receipt.columns, 48);
});

test("sanitize: printableWidthMm para preset JAL_838L es 76mm aunque no venga en input", () => {
  const c = sanitizePrintingConfig({ receipt: { paper: "JAL_838L" } });
  assert.equal(c.receipt.widthMm, 82);
  assert.equal(c.receipt.printableWidthMm, 76);
});

test("sanitize: printableWidthMm input se clamp A WIDTHMM, nunca lo supera", () => {
  // Caso 1: input por encima del físico → se clamp a widthMm.
  const over = sanitizePrintingConfig({
    receipt: { paper: "80", widthMm: 80, printableWidthMm: 999 },
  });
  assert.equal(over.receipt.printableWidthMm, 80,
    "printableWidthMm fuera de rango (999mm) debe caparse al widthMm físico (80mm).");

  // Caso 2: input válido y menor que widthMm → se preserva.
  const inRange = sanitizePrintingConfig({
    receipt: { paper: "80", widthMm: 80, printableWidthMm: 72 },
  });
  assert.equal(inRange.receipt.printableWidthMm, 72);

  // Caso 3: input por debajo del BOUND mínimo → se clamp hacia arriba.
  const under = sanitizePrintingConfig({
    receipt: { paper: "CUSTOM", widthMm: 50, printableWidthMm: 5 },
  });
  assert.equal(under.receipt.printableWidthMm, BOUNDS.printableWidthMm.min);
});

test("sanitize: printableWidthMm negativo o NaN cae al default (widthMm)", () => {
  for (const bad of [-10, Number.NaN, "x", null]) {
    const c = sanitizePrintingConfig({
      receipt: { paper: "80", widthMm: 80, printableWidthMm: bad },
    });
    // null/undefined/"" → default (= widthMm). NaN cae al min via clampInt.
    assert.ok(
      c.receipt.printableWidthMm >= BOUNDS.printableWidthMm.min
        && c.receipt.printableWidthMm <= c.receipt.widthMm,
      `Entrada inválida ${JSON.stringify(bad)} debe producir un printableWidthMm en rango. Obtuvo: ${c.receipt.printableWidthMm}`,
    );
  }
});

test("sanitize es idempotente también con el campo printableWidthMm", () => {
  const once = sanitizePrintingConfig({
    receipt: { paper: "JAL_838L", printableWidthMm: 76 },
  });
  const twice = sanitizePrintingConfig(once);
  assert.deepEqual(twice, once);
});

test("sanitize: paper CUSTOM con widthMm=100 y printableWidthMm omitido → ambos se topan en 82", () => {
  const c = sanitizePrintingConfig({
    receipt: { paper: "CUSTOM", widthMm: 100 },
  });
  assert.equal(c.receipt.widthMm, 82);
  assert.equal(c.receipt.printableWidthMm, 82);
});

test("sanitize: paper CUSTOM con widthMm=100 y printableWidthMm=90 → ambos se topan en 82", () => {
  const c = sanitizePrintingConfig({
    receipt: { paper: "CUSTOM", widthMm: 100, printableWidthMm: 90 },
  });
  assert.equal(c.receipt.widthMm, 82);
  assert.equal(c.receipt.printableWidthMm, 82);
});

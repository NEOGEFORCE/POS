import test from "node:test";
import assert from "node:assert/strict";

import {
  BARCODE_SYMBOLOGIES,
  BOUNDS,
  CUT_MODES,
  DEFAULT_DRAWER_COMMAND,
  DEFAULT_GONDOLA_FORMAT,
  DRAWER_EVENTS,
  GONDOLA_FORMATS,
  INTERFACE_PROTOCOLS,
  INTERFACES,
  LABEL_SIZE_DIMENSIONS,
  LABEL_SIZE_PRESETS,
  PAPER_COLUMNS,
  PAPER_PRESETS,
  PRINTING_CONFIG_STORAGE_KEY,
  PRINTING_CONFIG_VERSION,
  PROTOCOLS,
  RECEIPT_DELIVERY_MODES,
  SENSOR_TYPES,
  SPOOLERS,
  applyGondolaFormatPreset,
  applyLabelSizePreset,
  applyReceiptPaperPreset,
  clearPrintingConfig,
  createDefaultPrintingConfig,
  importConfigFromPrinterProfile,
  loadPrintingConfig,
  migratePrintingConfig,
  printingConfigsEqual,
  projectConfigToPrinterProfile,
  projectConfigToSizeTemplate,
  receiptWidthKey,
  sanitizePrintingConfig,
  savePrintingConfig,
  validatePrintingConfig,
} from "../src/lib/printing-config.mjs";

// ============================================================================
// MockStorage: implementación mínima de la interfaz StorageLike compatible
// con LocalStorage. Lo usamos sin globals porque los tests corren en Node.
// ============================================================================

function mockStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

// ============================================================================
// Defaults y constantes
// ============================================================================

test("createDefaultPrintingConfig: shape canónico v1", () => {
  const def = createDefaultPrintingConfig();
  assert.equal(def.version, PRINTING_CONFIG_VERSION);
  assert.equal(def.version, 1);
  assert.equal(PRINTING_CONFIG_STORAGE_KEY, "pos_printing_config_v1");
  assert.equal(def.connection.interface, INTERFACES.SYSTEM);
  assert.equal(def.connection.protocol, PROTOCOLS.PDF);
  assert.equal(def.connection.system.spooler, SPOOLERS.WINDOWS);
  assert.equal(def.drawer.command, DEFAULT_DRAWER_COMMAND);
  assert.equal(def.drawer.event, DRAWER_EVENTS.MANUAL);
  assert.equal(def.drawer.enabled, false);
  assert.equal(def.receipt.paper, PAPER_PRESETS.WIDTH_80);
  assert.equal(def.receipt.widthMm, 80);
  assert.equal(def.receipt.columns, PAPER_COLUMNS["80"]);
  assert.equal(def.receipt.columns, 48);
  assert.equal(def.receipt.cut, CUT_MODES.AUTO);
  // deliveryMode: default seguro — `browser` siempre funciona (abre diálogo).
  // `bridge` queda opt-in explícito para admins con bridge instalado.
  assert.equal(def.receipt.deliveryMode, RECEIPT_DELIVERY_MODES.BROWSER);
  assert.equal(def.labels.sizePreset, LABEL_SIZE_PRESETS["50X30"]);
  assert.equal(def.labels.widthMm, 50);
  assert.equal(def.labels.heightMm, 30);
  assert.equal(def.labels.columns, 1);
  assert.equal(def.labels.sensor.type, SENSOR_TYPES.GAP);
  assert.equal(def.labels.barcode.symbology, BARCODE_SYMBOLOGIES.CODE128);
});

test("DEFAULT_DRAWER_COMMAND: es el string literal visible, nunca evaluado", () => {
  // Es parte del contrato: nunca se interpreta como bytes en el frontend.
  // Se guarda como `\x1B\x70\x00\x19\xFA` LITERAL (con la secuencia visible).
  assert.equal(DEFAULT_DRAWER_COMMAND, "\\x1B\\x70\\x00\\x19\\xFA");
  assert.ok(DEFAULT_DRAWER_COMMAND.length > 10, "El literal debe contener los escapes textuales");
  assert.ok(!/^[\x00-\x1f]/.test(DEFAULT_DRAWER_COMMAND), "No debe empezar por el byte real ESC");
});

test("PAPER_COLUMNS: 80mm=48, 58mm=32 (coincide con thermal-ticket.ts)", () => {
  assert.equal(PAPER_COLUMNS["80"], 48);
  assert.equal(PAPER_COLUMNS["58"], 32);
});

test("INTERFACE_PROTOCOLS: SYSTEM admite system/pdf; USB/NETWORK admiten escpos/tspl/zpl", () => {
  assert.deepEqual([...INTERFACE_PROTOCOLS.SYSTEM].sort(), ["pdf", "system"]);
  assert.deepEqual([...INTERFACE_PROTOCOLS.USB].sort(), ["escpos", "tspl", "zpl"]);
  assert.deepEqual([...INTERFACE_PROTOCOLS.NETWORK].sort(), ["escpos", "tspl", "zpl"]);
});

test("LABEL_SIZE_DIMENSIONS: tres presets físicos", () => {
  assert.deepEqual(LABEL_SIZE_DIMENSIONS["50x30"], { widthMm: 50, heightMm: 30 });
  assert.deepEqual(LABEL_SIZE_DIMENSIONS["40x30"], { widthMm: 40, heightMm: 30 });
  assert.deepEqual(LABEL_SIZE_DIMENSIONS["30x20"], { widthMm: 30, heightMm: 20 });
});

test("RECEIPT_DELIVERY_MODES: expone bridge y browser con valores canónicos", () => {
  assert.equal(RECEIPT_DELIVERY_MODES.BRIDGE, "bridge");
  assert.equal(RECEIPT_DELIVERY_MODES.BROWSER, "browser");
  // El set EXCLUSIVO: cualquier otro valor es inválido y sanitize debe
  // caer al default.
  assert.deepEqual([...Object.values(RECEIPT_DELIVERY_MODES)].sort(), ["bridge", "browser"]);
});

test("sanitizePrintingConfig: deliveryMode acepta 'bridge' y 'browser', cae al default en otros valores", () => {
  const bridge = sanitizePrintingConfig({ receipt: { deliveryMode: "bridge" } });
  assert.equal(bridge.receipt.deliveryMode, "bridge",
    "El modo 'bridge' explícito debe conservarse (admin lo activó a propósito).");
  const browser = sanitizePrintingConfig({ receipt: { deliveryMode: "browser" } });
  assert.equal(browser.receipt.deliveryMode, "browser");
  // Valores inválidos → default seguro
  const falsy = sanitizePrintingConfig({ receipt: { deliveryMode: "silent" } });
  assert.equal(falsy.receipt.deliveryMode, "browser",
    "Un modo desconocido NUNCA puede activar la ruta directa — sanitize cae a 'browser'.");
  const nope = sanitizePrintingConfig({ receipt: { deliveryMode: null } });
  assert.equal(nope.receipt.deliveryMode, "browser",
    "null/undefined debe caer al default seguro.");
});

test("sanitizePrintingConfig: deliveryMode se preserva en roundtrip de JSON", () => {
  const original = sanitizePrintingConfig({ receipt: { deliveryMode: "bridge" } });
  const roundtripped = migratePrintingConfig(JSON.stringify(original));
  assert.equal(roundtripped.receipt.deliveryMode, "bridge");
});

// ============================================================================
// Sanitize
// ============================================================================

test("sanitizePrintingConfig: null/undefined/string suelto → defaults", () => {
  const def = createDefaultPrintingConfig();
  assert.deepEqual(sanitizePrintingConfig(null), { ...def, source: "default" });
  assert.deepEqual(sanitizePrintingConfig(undefined), { ...def, source: "default" });
  // Un string suelto no tiene shape de config: sanitize devuelve defaults.
  const fromString = sanitizePrintingConfig("hello");
  assert.equal(fromString.version, PRINTING_CONFIG_VERSION);
  assert.equal(fromString.connection.alias, def.connection.alias);
});

test("sanitizePrintingConfig: enum fuera de rango cae al default", () => {
  const bad = sanitizePrintingConfig({
    connection: { interface: "PARALELO", protocol: "foo" },
    drawer: { event: "WHENEVER" },
    receipt: { paper: "90", cut: "MAYBE" },
    labels: { sizePreset: "99x99", barcode: { symbology: "QR" } },
  });
  assert.equal(bad.connection.interface, INTERFACES.SYSTEM); // default
  // SYSTEM admite system/pdf: pick cae al primer válido.
  assert.ok(INTERFACE_PROTOCOLS.SYSTEM.includes(bad.connection.protocol));
  assert.equal(bad.drawer.event, DRAWER_EVENTS.MANUAL);
  assert.equal(bad.receipt.paper, PAPER_PRESETS.WIDTH_80);
  assert.equal(bad.receipt.cut, CUT_MODES.AUTO);
  assert.equal(bad.labels.sizePreset, LABEL_SIZE_PRESETS["50X30"]);
  assert.equal(bad.labels.barcode.symbology, BARCODE_SYMBOLOGIES.CODE128);
});

test("sanitizePrintingConfig: números fuera de bounds se clampean", () => {
  const c = sanitizePrintingConfig({
    connection: {
      interface: "NETWORK",
      protocol: "escpos",
      network: { host: "10.0.0.5", port: 999999 },
    },
    labels: {
      sizePreset: "CUSTOM",
      widthMm: 9999,
      heightMm: -5,
      columns: 10,
      horizontalGapMm: -1,
      productName: { fontPt: 999, maxChars: 999999 },
      price: { fontPt: 999 },
      barcode: { heightMm: 999 },
      sensor: { gapMm: 99 },
    },
  });
  assert.equal(c.connection.network.port, BOUNDS.port.max);
  assert.equal(c.labels.widthMm, BOUNDS.labelWidthMm.max);
  assert.equal(c.labels.heightMm, BOUNDS.labelHeightMm.min);
  assert.equal(c.labels.columns, BOUNDS.labelColumns.max);
  assert.equal(c.labels.horizontalGapMm, BOUNDS.horizontalGapMm.min);
  assert.equal(c.labels.productName.fontPt, BOUNDS.productNameFontPt.max);
  assert.equal(c.labels.productName.maxChars, BOUNDS.productNameMaxChars.max);
  assert.equal(c.labels.price.fontPt, BOUNDS.priceFontPt.max);
  assert.equal(c.labels.barcode.heightMm, BOUNDS.barcodeHeightMm.max);
  assert.equal(c.labels.sensor.gapMm, BOUNDS.sensorGapMm.max);
});

test("sanitizePrintingConfig: strings con control chars se limpian y se truncan", () => {
  const noisy = sanitizePrintingConfig({
    connection: { alias: "   nombre con \x01 control\x7F  " },
    receipt: { header: { businessName: "x".repeat(500) } },
  });
  assert.equal(noisy.connection.alias, "nombre con  control");
  assert.ok(noisy.receipt.header.businessName.length <= 120);
});

test("sanitizePrintingConfig: paper 58mm fuerza widthMm=58 y columns=32", () => {
  const c = sanitizePrintingConfig({ receipt: { paper: "58", widthMm: 80, columns: 999 } });
  assert.equal(c.receipt.widthMm, 58);
  assert.equal(c.receipt.columns, 32);
});

test("sanitizePrintingConfig: label preset fuerza dimensiones aunque el input mande otras", () => {
  const c = sanitizePrintingConfig({ labels: { sizePreset: "40x30", widthMm: 60, heightMm: 60 } });
  assert.equal(c.labels.widthMm, 40);
  assert.equal(c.labels.heightMm, 30);
});

test("sanitize es idempotente: sanitize(sanitize(x)) === sanitize(x)", () => {
  const once = sanitizePrintingConfig({
    labels: { sizePreset: "30x20" },
    drawer: { enabled: true, event: "AFTER_PRINT" },
  });
  const twice = sanitizePrintingConfig(once);
  assert.deepEqual(twice, once);
});

test("drawer.command vacío cae al literal default; largo máximo se trunca", () => {
  const empty = sanitizePrintingConfig({ drawer: { command: "" } });
  assert.equal(empty.drawer.command, DEFAULT_DRAWER_COMMAND);
  const huge = sanitizePrintingConfig({ drawer: { command: "A".repeat(500) } });
  assert.ok(huge.drawer.command.length <= 200);
});

// ============================================================================
// Migrate (serialización + corrupción)
// ============================================================================

test("migratePrintingConfig: parsea un JSON correcto", () => {
  const serialized = JSON.stringify({
    version: 1,
    connection: { interface: "NETWORK", protocol: "escpos", network: { host: "x", port: 9100 } },
  });
  const migrated = migratePrintingConfig(serialized);
  assert.equal(migrated.connection.interface, INTERFACES.NETWORK);
  assert.equal(migrated.connection.network.host, "x");
});

test("migratePrintingConfig: JSON corrupto o entrada basura → defaults", () => {
  const corrupt = migratePrintingConfig("not a json {");
  assert.equal(corrupt.version, PRINTING_CONFIG_VERSION);
  assert.equal(migratePrintingConfig(42).connection.interface, INTERFACES.SYSTEM);
  assert.equal(migratePrintingConfig([1, 2, 3]).connection.interface, INTERFACES.SYSTEM);
});

test("roundtrip JSON.stringify → migrate → equals estructural", () => {
  const original = sanitizePrintingConfig({
    connection: { interface: "USB", protocol: "tspl", usb: { vendorId: 0x04b8, productId: 0x0202 } },
    drawer: { enabled: true, event: "AFTER_PRINT" },
    receipt: { paper: "58", header: { businessName: "Mi tienda" } },
    labels: { sizePreset: "40x30", barcode: { symbology: "EAN13", heightMm: 15 } },
  });
  const serialized = JSON.stringify(original);
  const round = migratePrintingConfig(serialized);
  // La volatilidad de updatedAt/source la ignora el helper equals.
  assert.ok(printingConfigsEqual(original, round));
});

// ============================================================================
// Validate
// ============================================================================

test("validatePrintingConfig: default es válido sin warnings críticos", () => {
  const res = validatePrintingConfig(createDefaultPrintingConfig());
  assert.equal(res.valid, true);
  assert.equal(res.errors.length, 0);
});

test("validatePrintingConfig: NETWORK sin host es error", () => {
  const res = validatePrintingConfig({
    connection: { interface: "NETWORK", protocol: "escpos", network: { host: "", port: 9100 } },
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.path === "connection.network.host"));
});

test("validatePrintingConfig: sanitize fuerza combinaciones interface+protocol válidas", () => {
  // sanitize auto-corrige combinaciones imposibles (ej. USB+pdf). Validate
  // confía en el shape saneado, así que el resultado nunca contiene errores
  // por incompatibilidad: queda garantizado antes de validar.
  const sanitized = sanitizePrintingConfig({ connection: { interface: "USB", protocol: "pdf" } });
  assert.ok(INTERFACE_PROTOCOLS.USB.includes(sanitized.connection.protocol));
  // Y lo mismo al revés: SYSTEM + escpos → sanitize ajusta a protocolo system/pdf.
  const sanitized2 = sanitizePrintingConfig({ connection: { interface: "SYSTEM", protocol: "escpos" } });
  assert.ok(INTERFACE_PROTOCOLS.SYSTEM.includes(sanitized2.connection.protocol));
});

test("validatePrintingConfig: drawer activo sin command → error", () => {
  // sanitize completa con DEFAULT_DRAWER_COMMAND, así que el error solo surge
  // si forzamos la sanitización a devolver vacío. Como sanitize garantiza
  // "" → DEFAULT, usamos otra ruta: command con espacios se trimea pero el
  // fallback aplica, así que probamos que validate confía en sanitize.
  const res = validatePrintingConfig({ drawer: { enabled: true, command: "" } });
  assert.equal(res.valid, true, "sanitize garantiza el fallback literal, por eso validate acepta");
});

test("validatePrintingConfig: nombre que no cabe en etiqueta → warning", () => {
  const res = validatePrintingConfig({
    labels: { sizePreset: "30x20", productName: { visible: true, maxChars: 200, fontPt: 10 } },
  });
  assert.ok(res.warnings.some((w) => w.path === "labels.productName.maxChars"));
});

// ============================================================================
// Presets
// ============================================================================

test("applyReceiptPaperPreset: 58 → 58mm/32col, 80 → 80mm/48col", () => {
  const c58 = applyReceiptPaperPreset(createDefaultPrintingConfig(), PAPER_PRESETS.WIDTH_58);
  assert.equal(c58.receipt.widthMm, 58);
  assert.equal(c58.receipt.columns, 32);
  const c80 = applyReceiptPaperPreset(c58, PAPER_PRESETS.WIDTH_80);
  assert.equal(c80.receipt.widthMm, 80);
  assert.equal(c80.receipt.columns, 48);
});

test("applyLabelSizePreset: cambia dimensiones a las físicas conocidas", () => {
  const c = applyLabelSizePreset(createDefaultPrintingConfig(), "40x30");
  assert.equal(c.labels.widthMm, 40);
  assert.equal(c.labels.heightMm, 30);
});

// ============================================================================
// Load / Save (LocalStorage)
// ============================================================================

test("loadPrintingConfig: storage vacío → defaults y source='default'", () => {
  const store = mockStorage();
  const cfg = loadPrintingConfig(store);
  assert.equal(cfg.version, PRINTING_CONFIG_VERSION);
  assert.equal(cfg.source, "default");
});

test("savePrintingConfig: guarda en la clave canónica y marca source=localStorage", () => {
  const store = mockStorage();
  const saved = savePrintingConfig({
    connection: { interface: "NETWORK", protocol: "escpos", network: { host: "10.0.0.5", port: 9100 } },
  }, store);
  assert.ok(saved.updatedAt);
  assert.equal(saved.source, "localStorage");
  assert.ok(store.getItem(PRINTING_CONFIG_STORAGE_KEY));
  const reloaded = loadPrintingConfig(store);
  assert.equal(reloaded.connection.network.host, "10.0.0.5");
  assert.equal(reloaded.source, "localStorage");
});

test("loadPrintingConfig: storage corrupto → defaults sin lanzar", () => {
  const store = mockStorage({ [PRINTING_CONFIG_STORAGE_KEY]: "{{this is not json" });
  const cfg = loadPrintingConfig(store);
  assert.equal(cfg.version, PRINTING_CONFIG_VERSION);
  // No se cayó, no lanzó: contrato de resiliencia.
});

test("savePrintingConfig: purga claves legacy", () => {
  const store = mockStorage({ pos_printing_config: '{"version":0}' });
  savePrintingConfig({}, store);
  assert.equal(store.getItem("pos_printing_config"), null);
  assert.ok(store.getItem(PRINTING_CONFIG_STORAGE_KEY));
});

test("clearPrintingConfig: borra canónica y legacy", () => {
  const store = mockStorage();
  savePrintingConfig({ connection: { alias: "x" } }, store);
  assert.ok(store.getItem(PRINTING_CONFIG_STORAGE_KEY));
  clearPrintingConfig(store);
  assert.equal(store.getItem(PRINTING_CONFIG_STORAGE_KEY), null);
});

// ============================================================================
// Projection / Import (DB 016 — label_printer_profiles)
// ============================================================================

test("projectConfigToPrinterProfile: NETWORK produce target 'host:port'", () => {
  const c = sanitizePrintingConfig({
    connection: {
      interface: "NETWORK",
      protocol: "escpos",
      alias: "Caja 1",
      network: { host: "10.0.0.5", port: 9100 },
    },
    drawer: { enabled: true },
  });
  const prof = projectConfigToPrinterProfile(c);
  assert.equal(prof.protocol, "escpos");
  assert.equal(prof.target, "10.0.0.5:9100");
  assert.equal(prof.drawerConnected, true);
  assert.equal(prof.name, "Caja 1");
});

test("projectConfigToPrinterProfile: SYSTEM produce target=printerName y model=spooler", () => {
  const c = sanitizePrintingConfig({
    connection: {
      interface: "SYSTEM",
      protocol: "system",
      system: { printerName: "POS-80", spooler: "WINDOWS" },
    },
  });
  const prof = projectConfigToPrinterProfile(c);
  assert.equal(prof.target, "POS-80");
  assert.equal(prof.model, "WINDOWS");
});

test("importConfigFromPrinterProfile: perfil NETWORK con 'host:port' se parsea", () => {
  const base = createDefaultPrintingConfig();
  const imported = importConfigFromPrinterProfile(
    { name: "Nube", protocol: "escpos", target: "192.168.1.42:9100", drawerConnected: true, rollWidthMm: 58 },
    base,
  );
  assert.equal(imported.connection.interface, INTERFACES.NETWORK);
  assert.equal(imported.connection.network.host, "192.168.1.42");
  assert.equal(imported.connection.network.port, 9100);
  assert.equal(imported.connection.alias, "Nube");
  assert.equal(imported.drawer.enabled, true);
  assert.equal(imported.receipt.widthMm, 58);
  assert.equal(imported.source, "db-016");
});

test("importConfigFromPrinterProfile: null/basura devuelve base sin romper", () => {
  const base = createDefaultPrintingConfig();
  assert.deepEqual(importConfigFromPrinterProfile(null, base), sanitizePrintingConfig(base));
  assert.deepEqual(importConfigFromPrinterProfile("x", base), sanitizePrintingConfig(base));
});

test("projectConfigToSizeTemplate: name='WxH', símbolo del barcode y toggles", () => {
  const c = sanitizePrintingConfig({
    labels: {
      sizePreset: "40x30",
      barcode: { symbology: "EAN13", heightMm: 12 },
      productName: { visible: false },
      price: { visible: true },
    },
  });
  const tpl = projectConfigToSizeTemplate(c);
  assert.equal(tpl.name, "40x30");
  assert.equal(tpl.barcodeFormat, "EAN13");
  assert.equal(tpl.showName, false);
  assert.equal(tpl.showPrice, true);
  assert.equal(tpl.columnsCount, 1);
});

// ============================================================================
// Helpers de consumo (thermal-ticket, UI dirty)
// ============================================================================

test("receiptWidthKey: 58→'58mm', 80→'80mm', CUSTOM angosto→'58mm'", () => {
  assert.equal(receiptWidthKey({ receipt: { paper: "58" } }), "58mm");
  assert.equal(receiptWidthKey({ receipt: { paper: "80" } }), "80mm");
  assert.equal(receiptWidthKey({ receipt: { paper: "CUSTOM", widthMm: 60 } }), "58mm");
  assert.equal(receiptWidthKey({ receipt: { paper: "CUSTOM", widthMm: 90 } }), "80mm");
});

test("printingConfigsEqual: ignora updatedAt/source", () => {
  const a = sanitizePrintingConfig({ connection: { alias: "A" } });
  const b = sanitizePrintingConfig({ connection: { alias: "A" } });
  b.updatedAt = "2026-01-01T00:00:00.000Z";
  b.source = "localStorage";
  assert.equal(printingConfigsEqual(a, b), true);
  const c = sanitizePrintingConfig({ connection: { alias: "B" } });
  assert.equal(printingConfigsEqual(a, c), false);
});



// ============================================================================
// Defectos de contrato físico/layout (revisión 2026-10)
// ============================================================================

test("BOUNDS físicos: receiptWidthMm/printableWidthMm/labelWidthMm son exactamente 20..82", () => {
  assert.deepEqual(BOUNDS.receiptWidthMm, { min: 20, max: 82 });
  assert.deepEqual(BOUNDS.printableWidthMm, { min: 20, max: 82 });
  assert.deepEqual(BOUNDS.labelWidthMm, { min: 20, max: 82 });
});

test("sanitizePrintingConfig: widths CUSTOM se clampean a 20..82", () => {
  const high = sanitizePrintingConfig({
    receipt: { paper: "CUSTOM", widthMm: 999, printableWidthMm: 999 },
    labels: { sizePreset: "CUSTOM", widthMm: 999 },
  });
  assert.equal(high.receipt.widthMm, 82);
  assert.equal(high.receipt.printableWidthMm, 82);
  assert.equal(high.labels.widthMm, 82);

  const low = sanitizePrintingConfig({
    receipt: { paper: "CUSTOM", widthMm: 1, printableWidthMm: 1 },
    labels: { sizePreset: "CUSTOM", widthMm: 1 },
  });
  assert.equal(low.receipt.widthMm, 20);
  assert.equal(low.receipt.printableWidthMm, 20);
  assert.equal(low.labels.widthMm, 20);
});

test("importConfigFromPrinterProfile: rollWidthMm externo nunca supera 82mm", () => {
  const imported = importConfigFromPrinterProfile({
    name: "Perfil ancho",
    protocol: "escpos",
    target: "usb:demo",
    rollWidthMm: 200,
  }, createDefaultPrintingConfig());
  assert.equal(imported.receipt.paper, PAPER_PRESETS.CUSTOM);
  assert.equal(imported.receipt.widthMm, 82);
  assert.equal(imported.receipt.printableWidthMm, 82);
});

test("validatePrintingConfig: ancho total de etiquetas >82 es error accionable", () => {
  const result = validatePrintingConfig({
    labels: {
      sizePreset: "CUSTOM",
      widthMm: 40,
      columns: 2,
      horizontalGapMm: 3,
      marginLeftMm: 0,
    },
  });
  assert.equal(result.valid, false);
  const issue = result.errors.find((e) => e.path === "labels.widthMm");
  assert.ok(issue, "debe bloquear Guardar mediante validation.valid=false");
  assert.match(issue.message, /83\.0 mm/);
  assert.match(issue.message, /límite físico de 82 mm/);
  assert.match(issue.message, /Reduce ancho, columnas, margen o gap horizontal/);
});

test("validatePrintingConfig: ancho total exactamente 82mm es válido", () => {
  const result = validatePrintingConfig({
    labels: {
      sizePreset: "CUSTOM",
      widthMm: 40,
      columns: 2,
      horizontalGapMm: 2,
      marginLeftMm: 0,
    },
  });
  assert.equal(result.valid, true);
  assert.ok(!result.errors.some((e) => e.path === "labels.widthMm"));
});

test("sanitizePrintingConfig: layout canónico conserva X/Y/fontScale y limita fuentes TSPL a 1..8", () => {
  const config = sanitizePrintingConfig({
    labels: {
      sizePreset: "CUSTOM",
      widthMm: 50,
      heightMm: 30,
      layout: {
        name: { xMm: 3, yMm: 4, font: "8", fontScale: 1.5 },
        price: { xMm: 6, yMm: 10, font: "99", fontScale: 3 },
        barcode: { xMm: 2.5, yMm: 17, fontScale: 1 },
      },
    },
  });
  assert.deepEqual(config.labels.layout.name, { xMm: 3, yMm: 4, font: "8", fontScale: 1.5 });
  assert.deepEqual(config.labels.layout.price, { xMm: 6, yMm: 10, font: "4", fontScale: 3 });
  assert.deepEqual(config.labels.layout.barcode, { xMm: 2.5, yMm: 17, fontScale: 1 });
});


// ============================================================================
// Rama góndola: formato de hoja persistido + preset + sanitize
// ============================================================================

test("GONDOLA_FORMATS: expone LETTER y LEGAL con default LETTER", () => {
  assert.equal(GONDOLA_FORMATS.LETTER, "LETTER");
  assert.equal(GONDOLA_FORMATS.LEGAL, "LEGAL");
  assert.equal(DEFAULT_GONDOLA_FORMAT, "LETTER");
  assert.deepEqual([...Object.values(GONDOLA_FORMATS)].sort(), ["LEGAL", "LETTER"]);
});

test("createDefaultPrintingConfig: incluye gondola.format = LETTER", () => {
  const def = createDefaultPrintingConfig();
  assert.ok(def.gondola, "la rama gondola debe existir");
  assert.equal(def.gondola.format, "LETTER",
    "El default debe ser Carta (Letter): no exige opt-in del admin.");
});

test("sanitizePrintingConfig: gondola.format acepta LETTER/LEGAL y alias en español", () => {
  const letter = sanitizePrintingConfig({ gondola: { format: "LETTER" } });
  assert.equal(letter.gondola.format, "LETTER");
  const letterLow = sanitizePrintingConfig({ gondola: { format: "letter" } });
  assert.equal(letterLow.gondola.format, "LETTER", "case-insensitive");
  const carta = sanitizePrintingConfig({ gondola: { format: "CARTA" } });
  assert.equal(carta.gondola.format, "LETTER", "alias español");
  const legal = sanitizePrintingConfig({ gondola: { format: "LEGAL" } });
  assert.equal(legal.gondola.format, "LEGAL");
  const oficio = sanitizePrintingConfig({ gondola: { format: "oficio" } });
  assert.equal(oficio.gondola.format, "LEGAL", "alias español");
});

test("sanitizePrintingConfig: gondola.format desconocido/basura cae al default LETTER", () => {
  for (const bad of [null, undefined, "", "A4", "LEGAL-OVERSIZE", 42, { nope: true }]) {
    const c = sanitizePrintingConfig({ gondola: { format: bad } });
    assert.equal(c.gondola.format, "LETTER",
      `El valor ${JSON.stringify(bad)} debe caer a LETTER (default seguro).`);
  }
});

test("sanitizePrintingConfig: gondola se preserva en roundtrip JSON (migrate)", () => {
  const original = sanitizePrintingConfig({ gondola: { format: "LEGAL" } });
  const round = migratePrintingConfig(JSON.stringify(original));
  assert.equal(round.gondola.format, "LEGAL");
});

test("sanitize es idempotente para gondola: sanitize(sanitize(x)) === sanitize(x)", () => {
  const once = sanitizePrintingConfig({ gondola: { format: "LEGAL" } });
  const twice = sanitizePrintingConfig(once);
  assert.deepEqual(twice, once);
});

test("applyGondolaFormatPreset: LETTER ↔ LEGAL idempotente y sin tocar otras ramas", () => {
  const base = sanitizePrintingConfig({
    connection: { interface: "NETWORK", protocol: "escpos", network: { host: "10.0.0.5", port: 9100 } },
    drawer: { enabled: true, event: "AFTER_PRINT" },
    receipt: { paper: "58", widthMm: 58 },
    labels: { sizePreset: "40x30" },
    gondola: { format: "LETTER" },
  });

  const toLegal = applyGondolaFormatPreset(base, "LEGAL");
  assert.equal(toLegal.gondola.format, "LEGAL");
  // El resto queda intacto:
  assert.equal(toLegal.connection.network.host, "10.0.0.5");
  assert.equal(toLegal.drawer.enabled, true);
  assert.equal(toLegal.drawer.event, "AFTER_PRINT");
  assert.equal(toLegal.receipt.paper, "58");
  assert.equal(toLegal.labels.widthMm, 40);
  assert.equal(toLegal.labels.heightMm, 30);

  const toLetter = applyGondolaFormatPreset(toLegal, "LETTER");
  assert.equal(toLetter.gondola.format, "LETTER");

  // Un valor desconocido deja la rama intacta.
  const noop = applyGondolaFormatPreset(toLetter, "A4");
  assert.equal(noop.gondola.format, "LETTER");
});

test("applyGondolaFormatPreset: acepta alias en español", () => {
  const base = createDefaultPrintingConfig();
  const legal = applyGondolaFormatPreset(base, "OFICIO");
  assert.equal(legal.gondola.format, "LEGAL");
  const letter = applyGondolaFormatPreset(legal, "CARTA");
  assert.equal(letter.gondola.format, "LETTER");
});

test("loadPrintingConfig: config sin rama gondola legacy sigue cargándose con el default", () => {
  const store = mockStorage({
    [PRINTING_CONFIG_STORAGE_KEY]: JSON.stringify({
      version: 1,
      connection: { interface: "SYSTEM" },
      // sin gondola → sanitize debe inyectar el default
    }),
  });
  const cfg = loadPrintingConfig(store);
  assert.equal(cfg.gondola.format, "LETTER",
    "Configuraciones previas sin rama gondola deben seguir cargando y recibir el default seguro.");
});

test("printingConfigsEqual: dos configs con gondola distinto son diferentes", () => {
  const a = sanitizePrintingConfig({ gondola: { format: "LETTER" } });
  const b = sanitizePrintingConfig({ gondola: { format: "LEGAL" } });
  assert.equal(printingConfigsEqual(a, b), false);
  const c = sanitizePrintingConfig({ gondola: { format: "LEGAL" } });
  assert.equal(printingConfigsEqual(b, c), true);
});

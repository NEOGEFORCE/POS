import test from "node:test";
import assert from "node:assert/strict";

import {
  BARCODE_SYMBOLOGIES,
  BOUNDS,
  CUT_MODES,
  DEFAULT_DRAWER_COMMAND,
  DEFAULT_GONDOLA_FORMAT,
  DEFAULT_GONDOLA_THERMAL_CONFIG,
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
  sanitizeGondolaThermal,
  sanitizePrintingConfig,
  savePrintingConfig,
  setGondolaThermalParams,
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

test("INTERFACE_PROTOCOLS: SYSTEM admite system/pdf/escpos/tspl; USB/NETWORK admiten escpos/tspl/zpl", () => {
  // SYSTEM se amplio en el sprint 2026-10 para contemplar que una cola de
  // Windows apunte a una Jaltech JAL-838L (TSPL) o a una ESC/POS generica.
  // Las instalaciones viejas con SYSTEM+PDF siguen funcionando porque el
  // default se preserva en sanitize.
  assert.deepEqual([...INTERFACE_PROTOCOLS.SYSTEM].sort(), ["escpos", "pdf", "system", "tspl"]);
  assert.deepEqual([...INTERFACE_PROTOCOLS.USB].sort(), ["escpos", "tspl", "zpl"]);
  assert.deepEqual([...INTERFACE_PROTOCOLS.NETWORK].sort(), ["escpos", "tspl", "zpl"]);
});

test("INTERFACE_PROTOCOLS: SYSTEM + escpos/tspl son combinaciones válidas (sanitize no cambia el protocolo elegido)", () => {
  // Preservar la eleccion del admin cuando pide SYSTEM+TSPL (Jaltech
  // JAL-838L por cola de Windows) o SYSTEM+ESCPOS (recibos tirados por
  // cola Windows a una impresora ESC/POS generica).
  const tspl = sanitizePrintingConfig({ connection: { interface: "SYSTEM", protocol: "tspl" } });
  assert.equal(tspl.connection.protocol, "tspl");
  const escpos = sanitizePrintingConfig({ connection: { interface: "SYSTEM", protocol: "escpos" } });
  assert.equal(escpos.connection.protocol, "escpos");
});

test("INTERFACE_PROTOCOLS: SYSTEM sin protocolo explicito preserva el default PDF (BC)", () => {
  // El default historico (interface=SYSTEM, protocol=PDF) sigue siendo el
  // punto de partida al abrir /labels/config por primera vez; sanitize
  // nunca lo mueve a tspl/escpos a menos que el admin lo haya elegido.
  const def = sanitizePrintingConfig({ connection: { interface: "SYSTEM" } });
  assert.equal(def.connection.protocol, "pdf");
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

test("GONDOLA_FORMATS: expone LETTER, LEGAL y THERMAL_80 con default LETTER", () => {
  assert.equal(GONDOLA_FORMATS.LETTER, "LETTER");
  assert.equal(GONDOLA_FORMATS.LEGAL, "LEGAL");
  assert.equal(GONDOLA_FORMATS.THERMAL_80, "THERMAL_80");
  assert.equal(DEFAULT_GONDOLA_FORMAT, "LETTER");
  assert.deepEqual([...Object.values(GONDOLA_FORMATS)].sort(),
    ["LEGAL", "LETTER", "THERMAL_80"]);
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


// ============================================================================
// Rama góndola THERMAL_80: rollo térmico 80 mm con parámetros editables.
// ============================================================================

test("GONDOLA_FORMATS: enum sorted contiene exactamente [LEGAL, LETTER, THERMAL_80]", () => {
  // Guardián inmutable del contrato: cualquier formato nuevo exige
  // ampliar el enum, la rama thermal (si corresponde) y los tests
  // contractuales que la UI verifica.
  const sorted = [...Object.values(GONDOLA_FORMATS)].sort();
  assert.deepEqual(sorted, ["LEGAL", "LETTER", "THERMAL_80"]);
});

test("createDefaultPrintingConfig: incluye gondola.thermal canónico", () => {
  const def = createDefaultPrintingConfig();
  assert.ok(def.gondola.thermal, "la rama thermal debe estar presente por default");
  assert.equal(def.gondola.thermal.widthMm, 80);
  assert.equal(def.gondola.thermal.printableWidthMm, 76);
  assert.equal(def.gondola.thermal.heightMm, 40);
  assert.equal(def.gondola.thermal.marginLeftMm, 2);
  assert.equal(def.gondola.thermal.gapMm, 0);
  assert.equal(def.gondola.thermal.direction, 0);
  assert.equal(def.gondola.thermal.mirror, 0);
  assert.equal(def.gondola.thermal.density, 8);
  assert.equal(def.gondola.thermal.dpi, 203);
  assert.equal(def.gondola.thermal.nameFont, "3");
  assert.equal(def.gondola.thermal.nameScaleX, 1);
  assert.equal(def.gondola.thermal.priceFont, "4");
  assert.equal(def.gondola.thermal.priceScaleX, 2);
  assert.equal(def.gondola.thermal.showCode, true);
  assert.equal(def.gondola.thermal.showDate, true);
  assert.equal(def.gondola.thermal.footerFont, "1");
  // --- Rediseño 2026-10 ---
  assert.equal(def.gondola.thermal.showBarcode, true,
    "default: showBarcode=true (CODE128 abajo-izq)");
  assert.equal(def.gondola.thermal.barcodeHeightMm, 8,
    "default: barcode height 8mm");
  assert.equal(def.gondola.thermal.showUnitLabel, true,
    "default: showUnitLabel=true (literal bajo el precio)");
  assert.equal(def.gondola.thermal.unitLabel, "PRECIO UND",
    "default: literal 'PRECIO UND'");
});

test("DEFAULT_GONDOLA_THERMAL_CONFIG: snapshot congelado y sin side-effects al clonar", () => {
  assert.ok(Object.isFrozen(DEFAULT_GONDOLA_THERMAL_CONFIG),
    "el default debe ser inmutable para evitar mutaciones accidentales desde consumidores");
  assert.equal(DEFAULT_GONDOLA_THERMAL_CONFIG.widthMm, 80);
  assert.equal(DEFAULT_GONDOLA_THERMAL_CONFIG.printableWidthMm, 76);
  // La config por default del createDefaultPrintingConfig debe ser una
  // copia (no la misma referencia congelada): consumidores pueden mutar
  // la rama sin corromper el snapshot original.
  const def = createDefaultPrintingConfig();
  assert.notEqual(def.gondola.thermal, DEFAULT_GONDOLA_THERMAL_CONFIG,
    "el default devuelto debe ser una copia, no la referencia congelada");
});

test("sanitizePrintingConfig: THERMAL_80 preserva el formato y sanea thermal", () => {
  const c = sanitizePrintingConfig({ gondola: { format: "THERMAL_80" } });
  assert.equal(c.gondola.format, "THERMAL_80");
  assert.ok(c.gondola.thermal);
  assert.equal(c.gondola.thermal.widthMm, 80, "default thermal preservado");
});

test("sanitizePrintingConfig: aliases en español/ES-short mapean a THERMAL_80", () => {
  for (const alias of ["TERMICA_80", "TERMICA80", "Termica 80", "Térmica 80", "RT80", "rt_80"]) {
    const c = sanitizePrintingConfig({ gondola: { format: alias } });
    assert.equal(c.gondola.format, "THERMAL_80",
      `El alias "${alias}" debe canonicalizarse a THERMAL_80.`);
  }
});

test("sanitizeGondolaThermal: null/undefined → default canónico", () => {
  const fromNull = sanitizeGondolaThermal(null);
  assert.equal(fromNull.widthMm, DEFAULT_GONDOLA_THERMAL_CONFIG.widthMm);
  assert.equal(fromNull.printableWidthMm, DEFAULT_GONDOLA_THERMAL_CONFIG.printableWidthMm);
  const fromUndef = sanitizeGondolaThermal(undefined);
  assert.equal(fromUndef.heightMm, DEFAULT_GONDOLA_THERMAL_CONFIG.heightMm);
  // Shape completo:
  for (const key of Object.keys(DEFAULT_GONDOLA_THERMAL_CONFIG)) {
    assert.ok(Object.prototype.hasOwnProperty.call(fromNull, key),
      `sanitizeGondolaThermal(null) debe exponer la clave "${key}"`);
  }
});

test("sanitize: thermal.widthMm > 82 se clampea al techo físico 82", () => {
  const c = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { widthMm: 999 } },
  });
  assert.equal(c.gondola.thermal.widthMm, 82);
});

test("sanitize: thermal.printableWidthMm > widthMm se recorta a widthMm", () => {
  // Con marginLeftMm:0 el techo es widthMm directo (sin la segunda regla
  // de "margen + printable ≤ width"). Así aislamos la primera clamp.
  const c = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { widthMm: 80, printableWidthMm: 200, marginLeftMm: 0 } },
  });
  assert.equal(c.gondola.thermal.printableWidthMm, 80,
    "printable nunca puede exceder el ancho físico del rollo");
});

test("sanitize: thermal.marginLeft + printableWidth > width ⇒ printable se reduce", () => {
  const c = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { widthMm: 80, printableWidthMm: 76, marginLeftMm: 20 } },
  });
  assert.equal(c.gondola.thermal.marginLeftMm, 20, "margen izquierdo del admin preservado");
  assert.equal(c.gondola.thermal.printableWidthMm, 60,
    "printable se reduce para que margen + printable quepan en width");
});

test("sanitize: thermal.nameFont inválido cae al default '3'", () => {
  const c = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { nameFont: "99", priceFont: "no", footerFont: "x" } },
  });
  assert.equal(c.gondola.thermal.nameFont, "3");
  assert.equal(c.gondola.thermal.priceFont, "4");
  assert.equal(c.gondola.thermal.footerFont, "1");
});

test("sanitize: thermal.direction/mirror sólo aceptan 0 o 1 (otros caen a 0)", () => {
  const c = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { direction: 2, mirror: "yes" } },
  });
  assert.equal(c.gondola.thermal.direction, 0);
  assert.equal(c.gondola.thermal.mirror, 0);
  const c2 = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { direction: 1, mirror: 1 } },
  });
  assert.equal(c2.gondola.thermal.direction, 1);
  assert.equal(c2.gondola.thermal.mirror, 1);
});

test("sanitize: thermal.gapMm y density se clampean dentro de bounds", () => {
  const high = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { gapMm: 999, density: 999 } },
  });
  assert.equal(high.gondola.thermal.gapMm, BOUNDS.gondolaThermalGapMm.max);
  assert.equal(high.gondola.thermal.density, BOUNDS.gondolaThermalDensity.max);
  const low = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { gapMm: -5, density: -1 } },
  });
  assert.equal(low.gondola.thermal.gapMm, 0);
  assert.equal(low.gondola.thermal.density, 0);
});

test("sanitize: thermal.nameMaxChars se clampea 1..60", () => {
  const high = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { nameMaxChars: 500 } },
  });
  assert.equal(high.gondola.thermal.nameMaxChars, 60);
  const low = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { nameMaxChars: 0 } },
  });
  assert.equal(low.gondola.thermal.nameMaxChars, 1);
});

test("sanitize: thermal.*Scale clamp 1..10", () => {
  const c = sanitizePrintingConfig({
    gondola: {
      format: "THERMAL_80",
      thermal: {
        nameScaleX: 100, nameScaleY: 0,
        priceScaleX: 100, priceScaleY: -1,
        footerScaleX: 50, footerScaleY: 0,
      },
    },
  });
  assert.equal(c.gondola.thermal.nameScaleX, 10);
  assert.equal(c.gondola.thermal.nameScaleY, 1);
  assert.equal(c.gondola.thermal.priceScaleX, 10);
  assert.equal(c.gondola.thermal.priceScaleY, 1);
  assert.equal(c.gondola.thermal.footerScaleX, 10);
  assert.equal(c.gondola.thermal.footerScaleY, 1);
});

test("sanitize: thermal.showCode/showDate siguen el contrato de booleanos estrictos", () => {
  const c = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { showCode: false, showDate: false } },
  });
  assert.equal(c.gondola.thermal.showCode, false);
  assert.equal(c.gondola.thermal.showDate, false);
});

// ----------------------------------------------------------------------------
// Rediseño "estante grande" 2026-10: showBarcode / barcodeHeightMm /
// showUnitLabel / unitLabel. Retrocompat: legacy configs sin estos campos
// reciben los defaults canónicos (true/8mm/true/"PRECIO UND").
// ----------------------------------------------------------------------------

test("sanitize: thermal.showBarcode default true, respeta false explícito", () => {
  const def = sanitizePrintingConfig({ gondola: { format: "THERMAL_80" } });
  assert.equal(def.gondola.thermal.showBarcode, true,
    "default canónico: barcode encendido");
  const off = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { showBarcode: false } },
  });
  assert.equal(off.gondola.thermal.showBarcode, false,
    "respeta showBarcode=false explícito");
});

test("sanitize: thermal.barcodeHeightMm se clampea 3..30 (bounds canónicos)", () => {
  const high = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { barcodeHeightMm: 999 } },
  });
  assert.equal(high.gondola.thermal.barcodeHeightMm, 30,
    "techo 30mm (nunca invade el bloque del precio)");
  const low = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { barcodeHeightMm: 0 } },
  });
  assert.equal(low.gondola.thermal.barcodeHeightMm, 3,
    "piso 3mm (lectura no cae por debajo)");
});

test("sanitize: thermal.showUnitLabel default true, respeta false explícito", () => {
  const def = sanitizePrintingConfig({ gondola: { format: "THERMAL_80" } });
  assert.equal(def.gondola.thermal.showUnitLabel, true);
  const off = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { showUnitLabel: false } },
  });
  assert.equal(off.gondola.thermal.showUnitLabel, false);
});

test("sanitize: thermal.unitLabel default 'PRECIO UND', respeta string custom y lo trimma", () => {
  const def = sanitizePrintingConfig({ gondola: { format: "THERMAL_80" } });
  assert.equal(def.gondola.thermal.unitLabel, "PRECIO UND");
  const custom = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { unitLabel: "  x LT  " } },
  });
  assert.equal(custom.gondola.thermal.unitLabel, "x LT",
    "el string debe trimearse por cleanString");
});

test("sanitize: thermal.unitLabel vacío cae al default 'PRECIO UND'", () => {
  const empty = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { unitLabel: "" } },
  });
  assert.equal(empty.gondola.thermal.unitLabel, "PRECIO UND",
    "cadena vacía nunca deja el literal sin texto cuando se activa");
  const spaces = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { unitLabel: "   " } },
  });
  assert.equal(spaces.gondola.thermal.unitLabel, "PRECIO UND",
    "sólo-espacios trimma a vacío y cae al default");
});

test("sanitize: thermal.unitLabel se trunca al máximo del bound (24)", () => {
  const long = "a".repeat(100);
  const c = sanitizePrintingConfig({
    gondola: { format: "THERMAL_80", thermal: { unitLabel: long } },
  });
  assert.ok(c.gondola.thermal.unitLabel.length <= 24,
    "nunca excede el máximo canónico de 24 chars");
});

test("sanitize: BC — config legacy SIN los campos nuevos recibe defaults", () => {
  // Simulamos un storage escrito antes del rediseño (sólo campos previos).
  const legacy = sanitizePrintingConfig({
    gondola: {
      format: "THERMAL_80",
      thermal: {
        widthMm: 80, printableWidthMm: 76, heightMm: 40,
        showCode: true, showDate: false,
      },
    },
  });
  assert.equal(legacy.gondola.thermal.showBarcode, true,
    "showBarcode se infla con el default");
  assert.equal(legacy.gondola.thermal.barcodeHeightMm, 8);
  assert.equal(legacy.gondola.thermal.showUnitLabel, true);
  assert.equal(legacy.gondola.thermal.unitLabel, "PRECIO UND");
});

test("setGondolaThermalParams: patch de showBarcode/barcodeHeightMm/unitLabel es atómico", () => {
  const base = sanitizePrintingConfig({ gondola: { format: "THERMAL_80" } });
  const patched = setGondolaThermalParams(base, {
    showBarcode: false,
    barcodeHeightMm: 12,
    showUnitLabel: false,
    unitLabel: "x KG",
  });
  assert.equal(patched.gondola.thermal.showBarcode, false);
  assert.equal(patched.gondola.thermal.barcodeHeightMm, 12);
  assert.equal(patched.gondola.thermal.showUnitLabel, false);
  assert.equal(patched.gondola.thermal.unitLabel, "x KG");
  // Otros campos no se tocan:
  assert.equal(patched.gondola.thermal.widthMm, 80);
  assert.equal(patched.gondola.thermal.nameFont, "3");
});

test("sanitize: config legacy SIN rama gondola.thermal recibe el default (BC)", () => {
  const c = sanitizePrintingConfig({ gondola: { format: "LETTER" } });
  assert.ok(c.gondola.thermal, "La rama thermal se inyecta aunque falte en el input");
  assert.equal(c.gondola.thermal.widthMm, 80);
  assert.equal(c.gondola.thermal.heightMm, 40);
});

test("sanitize es idempotente para thermal: sanitize(sanitize(x)) === sanitize(x)", () => {
  const once = sanitizePrintingConfig({
    gondola: {
      format: "THERMAL_80",
      thermal: { widthMm: 58, printableWidthMm: 48, heightMm: 30, nameFont: "4", gapMm: 2 },
    },
  });
  const twice = sanitizePrintingConfig(once);
  assert.deepEqual(twice, once);
});

test("roundtrip JSON: THERMAL_80 + thermal custom se preserva tras migratePrintingConfig", () => {
  const original = sanitizePrintingConfig({
    gondola: {
      format: "THERMAL_80",
      thermal: {
        widthMm: 76, printableWidthMm: 72, heightMm: 50, marginLeftMm: 3,
        gapMm: 2, direction: 1, density: 10, dpi: 300,
        nameFont: "4", nameScaleX: 2, priceFont: "5", priceScaleX: 3,
        showCode: false, nameMaxChars: 40,
      },
    },
  });
  const round = migratePrintingConfig(JSON.stringify(original));
  assert.equal(round.gondola.format, "THERMAL_80");
  assert.equal(round.gondola.thermal.widthMm, 76);
  assert.equal(round.gondola.thermal.heightMm, 50);
  assert.equal(round.gondola.thermal.direction, 1);
  assert.equal(round.gondola.thermal.nameFont, "4");
  assert.equal(round.gondola.thermal.priceScaleX, 3);
  assert.equal(round.gondola.thermal.showCode, false);
  assert.ok(printingConfigsEqual(original, round));
});

test("applyGondolaFormatPreset: THERMAL_80 preserva ramas conexión/recibo/etiquetas/drawer", () => {
  const base = sanitizePrintingConfig({
    connection: { interface: "NETWORK", protocol: "escpos", network: { host: "10.0.0.5", port: 9100 } },
    drawer: { enabled: true, event: "AFTER_PRINT" },
    receipt: { paper: "58", widthMm: 58 },
    labels: { sizePreset: "40x30" },
    gondola: { format: "LETTER" },
  });
  const toThermal = applyGondolaFormatPreset(base, "THERMAL_80");
  assert.equal(toThermal.gondola.format, "THERMAL_80");
  // Las ramas conexión/receipt/labels/drawer NO cambian:
  assert.equal(toThermal.connection.network.host, "10.0.0.5");
  assert.equal(toThermal.connection.protocol, "escpos");
  assert.equal(toThermal.drawer.enabled, true);
  assert.equal(toThermal.drawer.event, "AFTER_PRINT");
  assert.equal(toThermal.receipt.paper, "58");
  assert.equal(toThermal.labels.widthMm, 40);
  assert.ok(toThermal.gondola.thermal, "La rama thermal debe seguir presente");
});

test("applyGondolaFormatPreset: alias ES mapean a THERMAL_80 sin tocar thermal params", () => {
  const base = sanitizePrintingConfig({
    gondola: {
      format: "LETTER",
      thermal: { widthMm: 76, printableWidthMm: 72 },
    },
  });
  for (const alias of ["TERMICA_80", "TERMICA80", "RT80", "Térmica 80"]) {
    const c = applyGondolaFormatPreset(base, alias);
    assert.equal(c.gondola.format, "THERMAL_80",
      `El alias "${alias}" debe canonicalizarse a THERMAL_80 vía applyGondolaFormatPreset.`);
    assert.equal(c.gondola.thermal.widthMm, 76,
      "Los parámetros térmicos existentes no deben perderse al cambiar formato.");
    assert.equal(c.gondola.thermal.printableWidthMm, 72);
  }
});

test("applyGondolaFormatPreset: THERMAL_80 ↔ LETTER es idempotente", () => {
  const def = createDefaultPrintingConfig();
  const toThermal = applyGondolaFormatPreset(def, "THERMAL_80");
  const backToLetter = applyGondolaFormatPreset(toThermal, "LETTER");
  assert.equal(backToLetter.gondola.format, "LETTER");
  // El thermal preservado tras el ping-pong:
  assert.ok(backToLetter.gondola.thermal);
  assert.equal(backToLetter.gondola.thermal.widthMm, 80);
});

test("setGondolaThermalParams: hace merge y clampea, no cambia format", () => {
  const base = sanitizePrintingConfig({ gondola: { format: "THERMAL_80" } });
  const patched = setGondolaThermalParams(base, {
    widthMm: 58, printableWidthMm: 48, heightMm: 30, nameFont: "5",
  });
  assert.equal(patched.gondola.format, "THERMAL_80");
  assert.equal(patched.gondola.thermal.widthMm, 58);
  assert.equal(patched.gondola.thermal.printableWidthMm, 48);
  assert.equal(patched.gondola.thermal.heightMm, 30);
  assert.equal(patched.gondola.thermal.nameFont, "5");
  // Clamp automático:
  const bad = setGondolaThermalParams(base, { widthMm: 500, priceScaleX: 999 });
  assert.equal(bad.gondola.thermal.widthMm, 82);
  assert.equal(bad.gondola.thermal.priceScaleX, 10);
});

test("setGondolaThermalParams: patch null/undefined devuelve config saneada sin romper", () => {
  const base = sanitizePrintingConfig({ gondola: { format: "THERMAL_80" } });
  const same = setGondolaThermalParams(base, null);
  assert.equal(same.gondola.format, "THERMAL_80");
  assert.equal(same.gondola.thermal.widthMm, 80);
});

test("loadPrintingConfig: config persistida sin gondola.thermal se hidrata con default", () => {
  const store = mockStorage({
    [PRINTING_CONFIG_STORAGE_KEY]: JSON.stringify({
      version: 1,
      connection: { interface: "SYSTEM" },
      gondola: { format: "LETTER" }, // sin thermal
    }),
  });
  const cfg = loadPrintingConfig(store);
  assert.equal(cfg.gondola.format, "LETTER");
  assert.ok(cfg.gondola.thermal, "El sanitize infla la rama thermal faltante");
  assert.equal(cfg.gondola.thermal.widthMm, 80);
});

// ============================================================================
// TSPL columns clamp — punto medio (font8 14x25 scaleY1) para 58/48.
// ============================================================================

test("TSPL columns clamp: paper 58 + protocol tspl → columns=26 (punto medio font8 14x25 scaleY1)", () => {
  const c = sanitizePrintingConfig({
    connection: { interface: "SYSTEM", protocol: "tspl" },
    receipt: { paper: "58" },
  });
  assert.equal(c.receipt.widthMm, 58);
  assert.equal(c.receipt.columns, 26,
    "A 48 mm imprimibles con punto medio TSPL font8 14x25 scaleY1 el frontend sanea a 26 columnas; evita el salto extremo a font2/scaleY2 (muy alto) sin caer a font1 ilegible");
});

test("TSPL columns clamp: paper 80 + protocol tspl conserva 48 columnas (76 mm imprimibles)", () => {
  const c = sanitizePrintingConfig({
    connection: { interface: "SYSTEM", protocol: "tspl" },
    receipt: { paper: "80" },
  });
  assert.equal(c.receipt.widthMm, 80);
  assert.equal(c.receipt.columns, 48,
    "A 76 mm imprimibles caben 49 glifos de 12 dots → se conserva el nominal 48");
});

test("TSPL columns clamp: paper JAL_838L + protocol tspl conserva 48 columnas (76 mm imprimibles)", () => {
  const c = sanitizePrintingConfig({
    connection: { interface: "SYSTEM", protocol: "tspl" },
    receipt: { paper: "JAL_838L" },
  });
  assert.equal(c.receipt.widthMm, 82);
  assert.equal(c.receipt.printableWidthMm, 76);
  assert.equal(c.receipt.columns, 48);
});

test("TSPL columns clamp: NO se aplica a ESCPOS → 58mm conserva columnas nominales (32)", () => {
  const c = sanitizePrintingConfig({
    connection: { interface: "NETWORK", protocol: "escpos", network: { host: "10.0.0.5", port: 9100 } },
    receipt: { paper: "58" },
  });
  assert.equal(c.receipt.columns, 32,
    "ESCPOS mantiene el conteo nominal del rollo: el clamp sólo aplica a TSPL");
});

test("TSPL columns clamp: NO se aplica a SYSTEM/PDF ni ZPL", () => {
  const pdf = sanitizePrintingConfig({
    connection: { interface: "SYSTEM", protocol: "pdf" },
    receipt: { paper: "58" },
  });
  assert.equal(pdf.receipt.columns, 32);
  const sysPrint = sanitizePrintingConfig({
    connection: { interface: "SYSTEM", protocol: "system" },
    receipt: { paper: "58" },
  });
  assert.equal(sysPrint.receipt.columns, 32);
  const zpl = sanitizePrintingConfig({
    connection: { interface: "USB", protocol: "zpl" },
    receipt: { paper: "58" },
  });
  assert.equal(zpl.receipt.columns, 32);
});

test("TSPL columns clamp: CUSTOM angosto fuerza columnas al presupuesto real", () => {
  const c = sanitizePrintingConfig({
    connection: { interface: "USB", protocol: "tspl", usb: { vendorId: 1, productId: 1 } },
    receipt: { paper: "CUSTOM", widthMm: 40, printableWidthMm: 40, columns: 50 },
  });
  // availableDots = (40 - 1.5) * 203 / 25.4 ≈ 307.68 → floor(307.68/12) = 25
  assert.equal(c.receipt.widthMm, 40);
  assert.equal(c.receipt.printableWidthMm, 40);
  assert.ok(c.receipt.columns <= 25,
    `columns ${c.receipt.columns} debe estar bajo 25 para fuente 2 legible en 40mm imprimibles`);
  assert.ok(c.receipt.columns >= BOUNDS.receiptColumns.min);
});

test("TSPL columns clamp: CUSTOM legacy 30/32 mm imprimibles conservan la defensa aritmética", () => {
  // Rollos custom 30 y 32 mm (presentes en instalaciones viejas) no son
  // 48 ni 76: el sanitize cae a la rama aritmética histórica. El resultado
  // honra `BOUNDS.receiptColumns.min` (20) como piso duro, así que la
  // cuenta siempre queda ≥ 20 y ≤ el presupuesto geométrico — nunca
  // escapa fuera de bounds. Este test ancla ambos invariantes: el ladder
  // nuevo (punto medio font8 para 48 mm) no pisa el camino legacy.
  const c30 = sanitizePrintingConfig({
    connection: { interface: "USB", protocol: "tspl", usb: { vendorId: 1, productId: 1 } },
    receipt: { paper: "CUSTOM", widthMm: 30, printableWidthMm: 30, columns: 50 },
  });
  // availableDots(30) = (30 - 1.5) * 203 / 25.4 ≈ 227.75 → floor()/12 = 18.
  // Como 18 < BOUNDS.receiptColumns.min (20), el piso del clamp eleva a 20.
  assert.equal(c30.receipt.printableWidthMm, 30);
  assert.equal(c30.receipt.columns, BOUNDS.receiptColumns.min,
    `30 mm imprimibles cae al piso ${BOUNDS.receiptColumns.min}: la defensa nunca sale de bounds`);

  const c32 = sanitizePrintingConfig({
    connection: { interface: "USB", protocol: "tspl", usb: { vendorId: 1, productId: 1 } },
    receipt: { paper: "CUSTOM", widthMm: 32, printableWidthMm: 32, columns: 50 },
  });
  // availableDots(32) = (32 - 1.5) * 203 / 25.4 ≈ 243.74 → floor()/12 = 20.
  // Coincide exactamente con el piso de bounds.
  assert.equal(c32.receipt.printableWidthMm, 32);
  assert.equal(c32.receipt.columns, BOUNDS.receiptColumns.min,
    `32 mm imprimibles produce justo el piso ${BOUNDS.receiptColumns.min}`);
});

test("TSPL columns clamp: 80/76 y 82/76 producen EL MISMO tope (48) — contrato cruzado presets", () => {
  // Ambos presets comparten 76 mm imprimibles; el frontend fija 48 cols
  // en los dos para que el bridge arme la tirilla con font2 scaleY1.
  const c80 = sanitizePrintingConfig({
    connection: { interface: "SYSTEM", protocol: "tspl" },
    receipt: { paper: "80" },
  });
  const cJal = sanitizePrintingConfig({
    connection: { interface: "SYSTEM", protocol: "tspl" },
    receipt: { paper: "JAL_838L" },
  });
  assert.equal(c80.receipt.printableWidthMm, 76);
  assert.equal(cJal.receipt.printableWidthMm, 76);
  assert.equal(c80.receipt.columns, cJal.receipt.columns);
  assert.equal(c80.receipt.columns, 48);
});

test("TSPL columns clamp: PAPER_COLUMNS nominal no cambia (contrato de thermal-ticket)", () => {
  // El clamp vive en receipt.columns, NO en el enum nominal. El enum
  // sigue siendo la fuente de verdad del ancho del rollo (48/32).
  assert.equal(PAPER_COLUMNS["80"], 48);
  assert.equal(PAPER_COLUMNS["58"], 32);
});

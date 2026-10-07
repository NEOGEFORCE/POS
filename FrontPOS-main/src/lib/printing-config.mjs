// =============================================================================
// src/lib/printing-config.mjs
//
// Fuente única de verdad del estado "Configuración de Impresora y Formatos".
//
// Decisiones clave:
//
//  * Es un módulo PURO JS (.mjs) sin dependencias. Vive aquí porque:
//    - Se usa desde código "use client" de Next.js (page, modals, previews).
//    - Se usa desde `thermal-ticket.ts` para leer la preferencia persistida.
//    - Se usa desde tests `node --test` que corren sin bundler.
//
//  * Hay UNA sola clave canónica de LocalStorage versionada:
//        pos_printing_config_v1
//    El sufijo `_v1` es parte de la clave. Si en el futuro cambia el shape,
//    se migra copiando desde la vieja a la nueva y la vieja se purga.
//
//  * TODO lo que entra desde LocalStorage, de la red, o del usuario pasa
//    SIEMPRE por `sanitizePrintingConfig()`. No confiamos en que el storage
//    tenga el shape correcto: alguien puede haber manipulado la clave en
//    DevTools, o puede quedar basura de un build anterior.
//
//  * El comando del cajón se guarda como STRING LITERAL (ej. `\x1B\x70...`).
//    NUNCA se evalúa con `eval` ni `Function()`. El bridge local es el único
//    que lo interpreta como bytes al enviarlo a la impresora. En el frontend
//    el comando es solo un dato opaco que se muestra para auditoría.
//
//  * Hay proyección BEST-EFFORT hacia `PrinterProfile` (DB 016 /labels/printers).
//    Si el backend no tiene la migración, el frontend sigue funcionando con
//    LocalStorage; la proyección falla silenciosa.
//
// Mantén este archivo pequeño, puro y sin side-effects (excepto `load/save`).
// =============================================================================

// -----------------------------------------------------------------------------
// Constantes públicas
// -----------------------------------------------------------------------------

export const PRINTING_CONFIG_VERSION = 1;
export const PRINTING_CONFIG_STORAGE_KEY = "pos_printing_config_v1";

/**
 * Prefijos antiguos que podríamos querer migrar. Hoy no hay nada,
 * se deja listo para futuras versiones.
 */
export const LEGACY_STORAGE_KEYS = Object.freeze([
  "pos_printing_config",
]);

export const INTERFACES = Object.freeze({
  USB: "USB",
  NETWORK: "NETWORK",
  SYSTEM: "SYSTEM",
});

export const PROTOCOLS = Object.freeze({
  ESCPOS: "escpos",
  TSPL: "tspl",
  ZPL: "zpl",
  SYSTEM: "system",
  PDF: "pdf",
});

/** Protocolos aceptados por INTERFACE para evitar combinaciones imposibles. */
export const INTERFACE_PROTOCOLS = Object.freeze({
  USB: ["escpos", "tspl", "zpl"],
  NETWORK: ["escpos", "tspl", "zpl"],
  SYSTEM: ["system", "pdf"],
});

export const SPOOLERS = Object.freeze({
  WINDOWS: "WINDOWS",
  CUPS: "CUPS",
});

export const DRAWER_EVENTS = Object.freeze({
  BEFORE_PRINT: "BEFORE_PRINT",
  AFTER_PRINT: "AFTER_PRINT",
  MANUAL: "MANUAL",
});

/**
 * Comando ESC/POS literal estándar para abrir el cajón conectado
 * ("ESC p 0 25 250"). Es texto visible por diseño: el bridge local lo
 * interpretará, el frontend NO lo evalúa jamás.
 */
export const DEFAULT_DRAWER_COMMAND = "\\x1B\\x70\\x00\\x19\\xFA";

export const CUT_MODES = Object.freeze({
  AUTO: "AUTO",
  MANUAL: "MANUAL",
  NONE: "NONE",
});

export const PAPER_PRESETS = Object.freeze({
  WIDTH_80: "80",
  WIDTH_58: "58",
  CUSTOM: "CUSTOM",
});

/** Columnas por rollo (coinciden con `thermal-ticket.ts`). */
export const PAPER_COLUMNS = Object.freeze({
  "80": 48,
  "58": 32,
});

export const LABEL_SIZE_PRESETS = Object.freeze({
  "50X30": "50x30",
  "40X30": "40x30",
  "30X20": "30x20",
  CUSTOM: "CUSTOM",
});

/** Mapa preset → medidas físicas en mm. */
export const LABEL_SIZE_DIMENSIONS = Object.freeze({
  "50x30": { widthMm: 50, heightMm: 30 },
  "40x30": { widthMm: 40, heightMm: 30 },
  "30x20": { widthMm: 30, heightMm: 20 },
});

export const SENSOR_TYPES = Object.freeze({
  GAP: "GAP",
  BLACK_MARK: "BLACK_MARK",
});

export const BARCODE_SYMBOLOGIES = Object.freeze({
  EAN13: "EAN13",
  CODE128: "CODE128",
  CODE39: "CODE39",
});

// -----------------------------------------------------------------------------
// Rangos / bounds (centralizados para que la UI y la validación coincidan).
// -----------------------------------------------------------------------------

export const BOUNDS = Object.freeze({
  port: { min: 1, max: 65535 },
  receiptWidthMm: { min: 20, max: 120 },
  receiptColumns: { min: 20, max: 80 },
  labelWidthMm: { min: 10, max: 200 },
  labelHeightMm: { min: 5, max: 200 },
  labelColumns: { min: 1, max: 2 },
  horizontalGapMm: { min: 0, max: 30 },
  sensorGapMm: { min: 0, max: 20 },
  productNameFontPt: { min: 5, max: 24 },
  productNameMaxChars: { min: 1, max: 200 },
  priceFontPt: { min: 5, max: 48 },
  barcodeHeightMm: { min: 2, max: 60 },
  maxStringLength: 200,
});

// -----------------------------------------------------------------------------
// Utilidades internas de normalización
// -----------------------------------------------------------------------------

function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function clampInt(value, min, max, fallback) {
  const n = clampNumber(value, min, max, fallback);
  return Math.round(n);
}

function cleanString(value, maxLen) {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  const trimmed = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  const limit = Number.isFinite(maxLen) ? maxLen : BOUNDS.maxStringLength;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function pickEnum(value, allowed, fallback) {
  if (typeof value !== "string") return fallback;
  return allowed.includes(value) ? value : fallback;
}

function pickBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function ensureObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

export function createDefaultPrintingConfig() {
  return {
    version: PRINTING_CONFIG_VERSION,
    updatedAt: null,
    source: "default",
    connection: {
      alias: "Impresora POS",
      interface: INTERFACES.SYSTEM,
      protocol: PROTOCOLS.PDF,
      usb: {
        vendorId: 0,
        productId: 0,
        devicePath: "",
      },
      network: {
        host: "",
        port: 9100,
      },
      system: {
        printerName: "",
        spooler: SPOOLERS.WINDOWS,
      },
    },
    drawer: {
      enabled: false,
      command: DEFAULT_DRAWER_COMMAND,
      event: DRAWER_EVENTS.MANUAL,
    },
    receipt: {
      paper: PAPER_PRESETS.WIDTH_80,
      widthMm: 80,
      columns: PAPER_COLUMNS["80"],
      header: {
        businessName: "",
        nit: "",
        address: "",
        phone: "",
        resolution: "",
      },
      footer: {
        thankYou: "¡Gracias por su compra!",
      },
      content: {
        showLogo: false,
        showTaxes: true,
        showValidationQR: false,
      },
      cut: CUT_MODES.AUTO,
    },
    labels: {
      sizePreset: LABEL_SIZE_PRESETS["50X30"],
      widthMm: 50,
      heightMm: 30,
      columns: 1,
      horizontalGapMm: 2,
      sensor: {
        type: SENSOR_TYPES.GAP,
        gapMm: 3,
      },
      productName: {
        visible: true,
        fontPt: 8,
        maxChars: 32,
      },
      price: {
        visible: true,
        emphasized: true,
        fontPt: 12,
      },
      barcode: {
        symbology: BARCODE_SYMBOLOGIES.CODE128,
        heightMm: 10,
      },
      extras: {
        showDate: false,
        showInternalCode: false,
        showCategory: false,
      },
    },
  };
}

// -----------------------------------------------------------------------------
// Sanitize (idempotente, nunca lanza)
// -----------------------------------------------------------------------------

export function sanitizePrintingConfig(input) {
  const defaults = createDefaultPrintingConfig();
  const src = ensureObject(input);

  const conn = ensureObject(src.connection);
  const connInterface = pickEnum(conn.interface, Object.values(INTERFACES), defaults.connection.interface);
  const allowedProtocols = INTERFACE_PROTOCOLS[connInterface] || Object.values(PROTOCOLS);
  // Preferimos el protocolo por defecto del connInterface actual si está en
  // allowed; sino el primer protocolo compatible. Esto evita que un reset
  // sobre SYSTEM caiga a "system" cuando el default de la app es "pdf".
  const defaultProtocolForIface = connInterface === defaults.connection.interface
    ? defaults.connection.protocol
    : allowedProtocols[0];
  const protocolFallback = allowedProtocols.includes(defaultProtocolForIface)
    ? defaultProtocolForIface
    : allowedProtocols[0];
  const connProtocol = pickEnum(conn.protocol, allowedProtocols, protocolFallback);

  const usb = ensureObject(conn.usb);
  const network = ensureObject(conn.network);
  const system = ensureObject(conn.system);

  const drawer = ensureObject(src.drawer);
  const receipt = ensureObject(src.receipt);
  const header = ensureObject(receipt.header);
  const footer = ensureObject(receipt.footer);
  const content = ensureObject(receipt.content);

  const labels = ensureObject(src.labels);
  const sensor = ensureObject(labels.sensor);
  const productName = ensureObject(labels.productName);
  const price = ensureObject(labels.price);
  const barcode = ensureObject(labels.barcode);
  const extras = ensureObject(labels.extras);

  const paper = pickEnum(receipt.paper, Object.values(PAPER_PRESETS), defaults.receipt.paper);
  const receiptWidthMm = paper === PAPER_PRESETS.WIDTH_80
    ? 80
    : paper === PAPER_PRESETS.WIDTH_58
      ? 58
      : clampInt(receipt.widthMm, BOUNDS.receiptWidthMm.min, BOUNDS.receiptWidthMm.max, defaults.receipt.widthMm);

  // Para 58/80 el conteo de columnas es fijo (coincide con thermal-ticket.ts).
  // Solo CUSTOM admite un valor libre dentro de los bounds.
  const defaultColumns = PAPER_COLUMNS[String(receiptWidthMm)]
    || (paper === PAPER_PRESETS.WIDTH_58 ? 32 : 48);
  const receiptColumns = paper === PAPER_PRESETS.WIDTH_80
    ? PAPER_COLUMNS["80"]
    : paper === PAPER_PRESETS.WIDTH_58
      ? PAPER_COLUMNS["58"]
      : clampInt(receipt.columns, BOUNDS.receiptColumns.min, BOUNDS.receiptColumns.max, defaultColumns);

  const sizePreset = pickEnum(labels.sizePreset, Object.values(LABEL_SIZE_PRESETS), defaults.labels.sizePreset);
  const presetDims = LABEL_SIZE_DIMENSIONS[sizePreset];
  const labelWidthMm = presetDims
    ? presetDims.widthMm
    : clampInt(labels.widthMm, BOUNDS.labelWidthMm.min, BOUNDS.labelWidthMm.max, defaults.labels.widthMm);
  const labelHeightMm = presetDims
    ? presetDims.heightMm
    : clampInt(labels.heightMm, BOUNDS.labelHeightMm.min, BOUNDS.labelHeightMm.max, defaults.labels.heightMm);

  const version = typeof src.version === "number" && Number.isFinite(src.version)
    ? src.version
    : PRINTING_CONFIG_VERSION;

  const sanitized = {
    version: PRINTING_CONFIG_VERSION, // forzamos siempre a la versión actual
    updatedAt: cleanString(src.updatedAt, 40) || null,
    source: cleanString(src.source, 40) || "default",
    _ingestedVersion: version,
    connection: {
      alias: cleanString(conn.alias, 80) || defaults.connection.alias,
      interface: connInterface,
      protocol: connProtocol,
      usb: {
        vendorId: clampInt(usb.vendorId, 0, 0xFFFF, 0),
        productId: clampInt(usb.productId, 0, 0xFFFF, 0),
        devicePath: cleanString(usb.devicePath, 200),
      },
      network: {
        host: cleanString(network.host, 120),
        port: clampInt(network.port, BOUNDS.port.min, BOUNDS.port.max, defaults.connection.network.port),
      },
      system: {
        printerName: cleanString(system.printerName, 160),
        spooler: pickEnum(system.spooler, Object.values(SPOOLERS), defaults.connection.system.spooler),
      },
    },
    drawer: {
      enabled: pickBool(drawer.enabled, defaults.drawer.enabled),
      // NUNCA se evalúa. Se guarda como string crudo. Vacío → default literal.
      command: cleanString(drawer.command, 200) || DEFAULT_DRAWER_COMMAND,
      event: pickEnum(drawer.event, Object.values(DRAWER_EVENTS), defaults.drawer.event),
    },
    receipt: {
      paper,
      widthMm: receiptWidthMm,
      columns: receiptColumns,
      header: {
        businessName: cleanString(header.businessName, 120),
        nit: cleanString(header.nit, 60),
        address: cleanString(header.address, 160),
        phone: cleanString(header.phone, 40),
        resolution: cleanString(header.resolution, 200),
      },
      footer: {
        thankYou: cleanString(footer.thankYou, 160) || defaults.receipt.footer.thankYou,
      },
      content: {
        showLogo: pickBool(content.showLogo, defaults.receipt.content.showLogo),
        showTaxes: pickBool(content.showTaxes, defaults.receipt.content.showTaxes),
        showValidationQR: pickBool(content.showValidationQR, defaults.receipt.content.showValidationQR),
      },
      cut: pickEnum(receipt.cut, Object.values(CUT_MODES), defaults.receipt.cut),
    },
    labels: {
      sizePreset,
      widthMm: labelWidthMm,
      heightMm: labelHeightMm,
      columns: clampInt(labels.columns, BOUNDS.labelColumns.min, BOUNDS.labelColumns.max, defaults.labels.columns),
      horizontalGapMm: clampInt(labels.horizontalGapMm, BOUNDS.horizontalGapMm.min, BOUNDS.horizontalGapMm.max, defaults.labels.horizontalGapMm),
      sensor: {
        type: pickEnum(sensor.type, Object.values(SENSOR_TYPES), defaults.labels.sensor.type),
        gapMm: clampInt(sensor.gapMm, BOUNDS.sensorGapMm.min, BOUNDS.sensorGapMm.max, defaults.labels.sensor.gapMm),
      },
      productName: {
        visible: pickBool(productName.visible, defaults.labels.productName.visible),
        fontPt: clampInt(productName.fontPt, BOUNDS.productNameFontPt.min, BOUNDS.productNameFontPt.max, defaults.labels.productName.fontPt),
        maxChars: clampInt(productName.maxChars, BOUNDS.productNameMaxChars.min, BOUNDS.productNameMaxChars.max, defaults.labels.productName.maxChars),
      },
      price: {
        visible: pickBool(price.visible, defaults.labels.price.visible),
        emphasized: pickBool(price.emphasized, defaults.labels.price.emphasized),
        fontPt: clampInt(price.fontPt, BOUNDS.priceFontPt.min, BOUNDS.priceFontPt.max, defaults.labels.price.fontPt),
      },
      barcode: {
        symbology: pickEnum(barcode.symbology, Object.values(BARCODE_SYMBOLOGIES), defaults.labels.barcode.symbology),
        heightMm: clampInt(barcode.heightMm, BOUNDS.barcodeHeightMm.min, BOUNDS.barcodeHeightMm.max, defaults.labels.barcode.heightMm),
      },
      extras: {
        showDate: pickBool(extras.showDate, defaults.labels.extras.showDate),
        showInternalCode: pickBool(extras.showInternalCode, defaults.labels.extras.showInternalCode),
        showCategory: pickBool(extras.showCategory, defaults.labels.extras.showCategory),
      },
    },
  };

  // Normalización final: internamente no exponemos _ingestedVersion al JSON canónico.
  delete sanitized._ingestedVersion;
  return sanitized;
}

// -----------------------------------------------------------------------------
// Migrate
// -----------------------------------------------------------------------------

/**
 * `migratePrintingConfig` acepta cualquier input (incluso `null` o strings
 * sueltos) y devuelve siempre un objeto sanitizado a la versión actual.
 *
 * Hoy solo existe la versión 1, pero el shape queda preparado para
 * incorporar versiones posteriores (switch sobre `source.version`).
 */
export function migratePrintingConfig(input) {
  if (input === null || input === undefined) return createDefaultPrintingConfig();

  let candidate = input;
  if (typeof input === "string") {
    try {
      candidate = JSON.parse(input);
    } catch {
      return createDefaultPrintingConfig();
    }
  }

  if (!candidate || typeof candidate !== "object") return createDefaultPrintingConfig();

  // Si en el futuro aparece una versión 2+, aquí iría la cadena de migración.
  // Por ahora solo sanitizamos.
  return sanitizePrintingConfig(candidate);
}

// -----------------------------------------------------------------------------
// Validate
// -----------------------------------------------------------------------------

/**
 * Devuelve `{ valid, errors, warnings }` sin lanzar. Se usa para habilitar
 * botones (Save, Imprimir prueba) y para pintar banderas en la UI.
 */
export function validatePrintingConfig(config) {
  const errors = [];
  const warnings = [];
  const c = sanitizePrintingConfig(config);

  // Conexión
  if (c.connection.interface === INTERFACES.NETWORK) {
    if (!c.connection.network.host) {
      errors.push({ path: "connection.network.host", message: "Host requerido para conexión de red." });
    }
    if (c.connection.network.port < BOUNDS.port.min || c.connection.network.port > BOUNDS.port.max) {
      errors.push({ path: "connection.network.port", message: "Puerto fuera de rango (1..65535)." });
    }
  }
  if (c.connection.interface === INTERFACES.SYSTEM) {
    if (!c.connection.system.printerName && c.connection.protocol !== PROTOCOLS.PDF) {
      warnings.push({ path: "connection.system.printerName", message: "Sin nombre de impresora el spooler puede usar la impresora por defecto del SO." });
    }
  }
  if (c.connection.interface === INTERFACES.USB) {
    if (!c.connection.usb.devicePath && !c.connection.usb.vendorId) {
      warnings.push({ path: "connection.usb", message: "Sin VID ni devicePath el bridge local tendrá que descubrir la impresora automáticamente." });
    }
  }

  // Combinación interface + protocol
  const allowed = INTERFACE_PROTOCOLS[c.connection.interface] || [];
  if (!allowed.includes(c.connection.protocol)) {
    errors.push({
      path: "connection.protocol",
      message: `Protocolo "${c.connection.protocol}" no compatible con interfaz ${c.connection.interface}.`,
    });
  }

  // Cajón
  if (c.drawer.enabled && !c.drawer.command) {
    errors.push({ path: "drawer.command", message: "Comando del cajón requerido cuando está habilitado." });
  }

  // Etiquetas: ancho * columnas debe caber (regla sana — advertencia, no error).
  const nameRoom = Math.max(1, Math.floor(c.labels.widthMm * 2.0));
  if (c.labels.productName.maxChars > nameRoom) {
    warnings.push({
      path: "labels.productName.maxChars",
      message: `El nombre podría cortarse: ${c.labels.productName.maxChars} chars no caben en ${c.labels.widthMm}mm.`,
    });
  }
  if (c.labels.barcode.heightMm >= c.labels.heightMm) {
    warnings.push({
      path: "labels.barcode.heightMm",
      message: "La altura del código de barras supera la etiqueta — se recortará.",
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

// -----------------------------------------------------------------------------
// Presets helpers
// -----------------------------------------------------------------------------

export function applyReceiptPaperPreset(config, preset) {
  const base = sanitizePrintingConfig(config);
  if (preset === PAPER_PRESETS.WIDTH_80) {
    base.receipt.paper = PAPER_PRESETS.WIDTH_80;
    base.receipt.widthMm = 80;
    base.receipt.columns = PAPER_COLUMNS["80"];
  } else if (preset === PAPER_PRESETS.WIDTH_58) {
    base.receipt.paper = PAPER_PRESETS.WIDTH_58;
    base.receipt.widthMm = 58;
    base.receipt.columns = PAPER_COLUMNS["58"];
  } else if (preset === PAPER_PRESETS.CUSTOM) {
    base.receipt.paper = PAPER_PRESETS.CUSTOM;
  }
  return base;
}

export function applyLabelSizePreset(config, preset) {
  const base = sanitizePrintingConfig(config);
  if (LABEL_SIZE_DIMENSIONS[preset]) {
    base.labels.sizePreset = preset;
    base.labels.widthMm = LABEL_SIZE_DIMENSIONS[preset].widthMm;
    base.labels.heightMm = LABEL_SIZE_DIMENSIONS[preset].heightMm;
  } else if (preset === LABEL_SIZE_PRESETS.CUSTOM) {
    base.labels.sizePreset = LABEL_SIZE_PRESETS.CUSTOM;
  }
  return base;
}

// -----------------------------------------------------------------------------
// Load / Save (LocalStorage)
// -----------------------------------------------------------------------------

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof globalThis !== "undefined" && globalThis.localStorage) return globalThis.localStorage;
  return null;
}

export function loadPrintingConfig(storage) {
  const store = resolveStorage(storage);
  if (!store) return createDefaultPrintingConfig();

  // 1. Clave canónica
  try {
    const raw = store.getItem(PRINTING_CONFIG_STORAGE_KEY);
    if (raw) {
      const parsed = migratePrintingConfig(raw);
      parsed.source = parsed.source && parsed.source !== "default" ? parsed.source : "localStorage";
      return parsed;
    }
  } catch {
    // Storage corrupto o bloqueado — caemos a legacy.
  }

  // 2. Claves legacy (si en el futuro se renombra la clave canónica).
  for (const legacyKey of LEGACY_STORAGE_KEYS) {
    try {
      const raw = store.getItem(legacyKey);
      if (!raw) continue;
      const parsed = migratePrintingConfig(raw);
      parsed.source = "legacy";
      return parsed;
    } catch {
      // continuar
    }
  }

  return createDefaultPrintingConfig();
}

export function savePrintingConfig(config, storage) {
  const store = resolveStorage(storage);
  const sanitized = sanitizePrintingConfig(config);
  sanitized.updatedAt = new Date().toISOString();
  sanitized.source = sanitized.source && sanitized.source !== "default"
    ? sanitized.source
    : "localStorage";
  if (!store) return sanitized;
  try {
    store.setItem(PRINTING_CONFIG_STORAGE_KEY, JSON.stringify(sanitized));
    // Purga de claves legacy — para no revivir valores viejos tras rotación.
    for (const legacyKey of LEGACY_STORAGE_KEYS) {
      try { store.removeItem(legacyKey); } catch { /* storage lleno */ }
    }
  } catch {
    // storage lleno o modo privado — devolvemos el valor sanitizado igual.
  }
  return sanitized;
}

export function clearPrintingConfig(storage) {
  const store = resolveStorage(storage);
  if (!store) return;
  try { store.removeItem(PRINTING_CONFIG_STORAGE_KEY); } catch { /* ignore */ }
  for (const legacyKey of LEGACY_STORAGE_KEYS) {
    try { store.removeItem(legacyKey); } catch { /* ignore */ }
  }
}

// -----------------------------------------------------------------------------
// Projection / Import (DB 016 — label_printer_profiles)
// -----------------------------------------------------------------------------

/**
 * Convierte la configuración actual a un payload compatible con la tabla
 * `label_printer_profiles` (POST /labels/printers). Se usa como paso
 * best-effort: si el backend no tiene la migración, el POST falla y
 * LocalStorage sigue siendo la verdad.
 *
 * @param {object} config
 * @returns {{
 *   name: string;
 *   protocol: string;
 *   target: string;
 *   model?: string;
 *   drawerConnected: boolean;
 *   isDefault: boolean;
 *   rollWidthMm?: number;
 * }}
 */
export function projectConfigToPrinterProfile(config) {
  const c = sanitizePrintingConfig(config);
  let target = "default";
  let model = "";
  switch (c.connection.interface) {
    case INTERFACES.NETWORK:
      target = c.connection.network.host
        ? `${c.connection.network.host}:${c.connection.network.port}`
        : "default";
      break;
    case INTERFACES.USB:
      target = c.connection.usb.devicePath
        || (c.connection.usb.vendorId
          ? `usb:${c.connection.usb.vendorId.toString(16)}/${c.connection.usb.productId.toString(16)}`
          : "default");
      break;
    case INTERFACES.SYSTEM:
      target = c.connection.system.printerName || "default";
      model = c.connection.system.spooler;
      break;
    default:
      target = "default";
  }

  return {
    name: c.connection.alias,
    protocol: c.connection.protocol,
    target,
    model,
    drawerConnected: !!c.drawer.enabled,
    isDefault: true,
    rollWidthMm: Math.round(c.receipt.widthMm),
  };
}

/**
 * Hidrata la rama `connection` desde un PrinterProfile (DB 016). Es best-effort:
 * no toca `receipt` ni `labels`.
 *
 * @param {object} profile
 * @param {object} [baseConfig]
 */
export function importConfigFromPrinterProfile(profile, baseConfig) {
  const base = sanitizePrintingConfig(baseConfig);
  if (!profile || typeof profile !== "object") return base;

  const protocolRaw = typeof profile.protocol === "string" ? profile.protocol.toLowerCase() : "";
  const protocol = Object.values(PROTOCOLS).includes(protocolRaw) ? protocolRaw : base.connection.protocol;

  // Deducir interface del protocolo (si el perfil no la trae).
  let iface = base.connection.interface;
  if (protocol === PROTOCOLS.SYSTEM || protocol === PROTOCOLS.PDF) {
    iface = INTERFACES.SYSTEM;
  } else {
    // escpos/tspl/zpl son normalmente USB o NETWORK: distinguimos por el shape del target.
    const target = typeof profile.target === "string" ? profile.target : "";
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(target) || /^[a-zA-Z0-9.-]+:\d+$/.test(target)) {
      iface = INTERFACES.NETWORK;
    } else if (target.startsWith("usb:") || target.includes("/dev/")) {
      iface = INTERFACES.USB;
    } else {
      iface = INTERFACES.USB;
    }
  }

  base.connection.alias = cleanString(profile.name, 80) || base.connection.alias;
  base.connection.protocol = protocol;
  base.connection.interface = iface;
  base.drawer.enabled = pickBool(profile.drawerConnected, base.drawer.enabled);

  if (iface === INTERFACES.NETWORK) {
    const target = typeof profile.target === "string" ? profile.target : "";
    const [host, portStr] = target.split(":");
    base.connection.network.host = cleanString(host, 120);
    const parsedPort = Number(portStr);
    base.connection.network.port = Number.isFinite(parsedPort) && parsedPort > 0
      ? clampInt(parsedPort, BOUNDS.port.min, BOUNDS.port.max, 9100)
      : base.connection.network.port;
  } else if (iface === INTERFACES.USB) {
    base.connection.usb.devicePath = cleanString(profile.target, 200);
  } else if (iface === INTERFACES.SYSTEM) {
    base.connection.system.printerName = cleanString(profile.target, 160);
    if (typeof profile.model === "string") {
      const modelUpper = profile.model.toUpperCase();
      if (modelUpper === SPOOLERS.CUPS || modelUpper === SPOOLERS.WINDOWS) {
        base.connection.system.spooler = modelUpper;
      }
    }
  }

  const roll = Number(profile.rollWidthMm);
  if (Number.isFinite(roll) && roll > 0) {
    if (Math.round(roll) === 58) {
      base.receipt.paper = PAPER_PRESETS.WIDTH_58;
      base.receipt.widthMm = 58;
      base.receipt.columns = PAPER_COLUMNS["58"];
    } else if (Math.round(roll) === 80) {
      base.receipt.paper = PAPER_PRESETS.WIDTH_80;
      base.receipt.widthMm = 80;
      base.receipt.columns = PAPER_COLUMNS["80"];
    } else {
      base.receipt.paper = PAPER_PRESETS.CUSTOM;
      base.receipt.widthMm = clampInt(roll, BOUNDS.receiptWidthMm.min, BOUNDS.receiptWidthMm.max, base.receipt.widthMm);
    }
  }

  base.source = "db-016";
  return base;
}

/**
 * Convierte la rama `labels` a un payload de `label_size_templates` (DB 016).
 * Útil para publicar como default global desde /labels/config.
 */
export function projectConfigToSizeTemplate(config) {
  const c = sanitizePrintingConfig(config);
  return {
    name: `${c.labels.widthMm}x${c.labels.heightMm}`,
    widthMm: c.labels.widthMm,
    heightMm: c.labels.heightMm,
    marginMm: 1,
    columnsCount: c.labels.columns,
    dpi: 203,
    barcodeFormat: c.labels.barcode.symbology,
    showName: !!c.labels.productName.visible,
    showPrice: !!c.labels.price.visible,
    isDefault: true,
  };
}

// -----------------------------------------------------------------------------
// Receipt-view helpers (consumo por thermal-ticket.ts)
// -----------------------------------------------------------------------------

/**
 * Devuelve el ancho tipográfico ("58mm" | "80mm") que debe usar la impresión
 * térmica cuando el llamador no pasa `width` explícito. Si el receipt es
 * CUSTOM pero muy angosto (<=65mm), caemos a 58mm; cualquier otra cosa a 80mm.
 */
export function receiptWidthKey(config) {
  const c = sanitizePrintingConfig(config);
  if (c.receipt.paper === PAPER_PRESETS.WIDTH_58) return "58mm";
  if (c.receipt.paper === PAPER_PRESETS.WIDTH_80) return "80mm";
  return c.receipt.widthMm <= 65 ? "58mm" : "80mm";
}

/** Diff estructural usado por la UI para marcar `isDirty`. */
export function printingConfigsEqual(a, b) {
  const sa = sanitizePrintingConfig(a);
  const sb = sanitizePrintingConfig(b);
  // Ignoramos metadata volátil (updatedAt/source) a la hora de comparar.
  const strip = (c) => {
    const copy = JSON.parse(JSON.stringify(c));
    copy.updatedAt = null;
    copy.source = "default";
    return copy;
  };
  return JSON.stringify(strip(sa)) === JSON.stringify(strip(sb));
}

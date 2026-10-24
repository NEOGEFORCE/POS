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

/**
 * Protocolos aceptados por INTERFACE para evitar combinaciones imposibles.
 *
 * `SYSTEM` admite tanto los protocolos "virtuales" (`system`/`pdf`) como
 * los físicos (`escpos`/`tspl`) para contemplar el caso real: una cola
 * de Windows que apunta a una impresora térmica Jaltech JAL-838L TSPL o
 * a una ESC/POS genérica. Las instalaciones que ya guardaron SYSTEM+PDF
 * siguen funcionando (sanitize mantiene el default). Para que el bridge
 * emita bytes físicos cuando la interfaz es SYSTEM, el admin elige
 * `tspl` o `escpos` desde la UI y el bridge rutea el payload según
 * `connection.protocol`.
 *
 * `pdf` sigue siendo exclusivo de `deliveryMode="browser"`: ningún
 * bridge debe recibir `type:"thermal-receipt"` con `protocol:"pdf"`.
 */
export const INTERFACE_PROTOCOLS = Object.freeze({
  USB: ["escpos", "tspl", "zpl"],
  NETWORK: ["escpos", "tspl", "zpl"],
  SYSTEM: ["system", "pdf", "escpos", "tspl"],
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
 * Modo activo del equipo configurado. `RECEIPT` → la impresora activa
 * trabaja como caja (recibos térmicos). `LABEL` → la impresora activa
 * imprime etiquetas (TSPL/ESC/ZPL).
 *
 * Es un hint para la UI (`/labels/config` resalta la tab relevante) y para
 * el bridge payload (el bridge puede priorizar hardware). Nunca restringe
 * capacidades: una misma impresora puede ser RECEIPT y LABEL si lo soporta.
 */
export const ACTIVE_MODES = Object.freeze({
  RECEIPT: "RECEIPT",
  LABEL: "LABEL",
});

/** DPI estándar de impresoras térmicas de etiquetas (TSPL/ZPL típicas). */
export const DEFAULT_DPI = 203;

/** Rotaciones aceptadas para el barcode TSPL (grados). */
export const BARCODE_ROTATIONS = Object.freeze([0, 90, 180, 270]);

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

/**
 * Modo de entrega del recibo térmico impreso desde el POS.
 *
 *   - `bridge` → delega al bridge local (`window.posBridge.print`) para
 *     imprimir SIN abrir el diálogo del navegador. Si el bridge no está
 *     disponible, el consumidor DEBE mostrar un toast accionable y nunca
 *     caer silenciosamente al diálogo: la impresión directa no se puede
 *     fingir. El modo "fingido" era la raíz del bug operativo del cajero.
 *
 *   - `browser` → usa el iframe aislado existente y abre el diálogo del
 *     navegador (compatible con sistemas sin bridge, PDF o export).
 *
 * El default es `browser` porque es el único camino que funciona SIEMPRE,
 * independiente del hardware o del bridge. Admins con bridge configurado
 * cambian el modo desde `/labels/config` → tab Recibo.
 */
export const RECEIPT_DELIVERY_MODES = Object.freeze({
  BRIDGE: "bridge",
  BROWSER: "browser",
});

/**
 * Formatos canónicos de hoja/rollo para precios de góndola.
 *
 *   - `LETTER`   → Carta landscape, grid 3×5 = 15 etiquetas por hoja.
 *   - `LEGAL`    → Oficio/Legal landscape, grid 4×5 = 20 etiquetas por hoja.
 *   - `THERMAL_80` → Rollo térmico continuo 80 mm (TSPL vía bridge).
 *     Una etiqueta por "página" (sin paginación por hoja). Los parámetros
 *     térmicos editables viven en `gondola.thermal` y se envían directo
 *     al bridge sin pasar por el diálogo del navegador.
 *
 * El default sigue siendo `LETTER` (Carta) por compatibilidad: ninguna
 * instalación previa cambia sin opt-in del admin.
 *
 * La geometría de hoja (LETTER/LEGAL) vive en `shelf-labels.mjs`
 * (`GONDOLA_FORMAT_SPECS` + `resolveGondolaLayout`); acá sólo declaramos
 * el enum para que sanitize tenga una sola fuente de verdad.
 */
export const GONDOLA_FORMATS = Object.freeze({
  LETTER: "LETTER",
  LEGAL: "LEGAL",
  THERMAL_80: "THERMAL_80",
});

export const DEFAULT_GONDOLA_FORMAT = GONDOLA_FORMATS.LETTER;

/**
 * Alias en español aceptados por `sanitize`/`applyGondolaFormatPreset`.
 * Las claves son `String.toUpperCase()` del input ya trimado, así que la
 * comparación es case-insensitive. Mantener este mapa evita duplicar la
 * lista de alias en varios lugares.
 */
const GONDOLA_FORMAT_ALIASES = Object.freeze({
  LETTER: GONDOLA_FORMATS.LETTER,
  CARTA: GONDOLA_FORMATS.LETTER,
  LEGAL: GONDOLA_FORMATS.LEGAL,
  OFICIO: GONDOLA_FORMATS.LEGAL,
  THERMAL_80: GONDOLA_FORMATS.THERMAL_80,
  THERMAL80: GONDOLA_FORMATS.THERMAL_80,
  TERMICA_80: GONDOLA_FORMATS.THERMAL_80,
  TERMICA80: GONDOLA_FORMATS.THERMAL_80,
  "TÉRMICA 80": GONDOLA_FORMATS.THERMAL_80,
  "TERMICA 80": GONDOLA_FORMATS.THERMAL_80,
  "TÉRMICA_80": GONDOLA_FORMATS.THERMAL_80,
  "RT80": GONDOLA_FORMATS.THERMAL_80,
  "RT_80": GONDOLA_FORMATS.THERMAL_80,
});

function normalizeGondolaFormat(raw) {
  if (raw == null) return null;
  const str = typeof raw === "string" ? raw : String(raw);
  const key = str.trim().toUpperCase();
  if (!key) return null;
  const match = GONDOLA_FORMAT_ALIASES[key];
  return match || null;
}

export const PAPER_PRESETS = Object.freeze({
  WIDTH_80: "80",
  WIDTH_58: "58",
  // Jaltech JAL-838L: impresora térmica con papel físico 82mm y área
  // imprimible real 76mm (los 6mm restantes son margen físico muerto que
  // el cabezal no toca). 48 columnas monoespacio como la familia 80mm.
  // Al activarse el preset se fija también `cut=MANUAL` porque este modelo
  // trabaja con cuchilla manual en lugar de cutter automático.
  JAL_838L: "JAL_838L",
  CUSTOM: "CUSTOM",
});

/** Columnas por rollo (coinciden con `thermal-ticket.ts`). */
export const PAPER_COLUMNS = Object.freeze({
  "80": 48,
  "58": 32,
  // 82mm: comparte el conteo de columnas de la familia 80mm porque el
  // ancho imprimible real (76mm) sigue cabiendo en 48 columnas monoespacio.
  "82": 48,
});

/**
 * Especificación física conocida del modelo Jaltech JAL-838L. Se expone como
 * constante congelada para que los consumidores (UI, bridge payload, tests)
 * no inventen números dispares.
 *
 * Campos pendientes (`defaultHost`, `defaultPrinterName`) son INTENCIONALMENTE
 * vacíos: dependen del despliegue físico. El preset preserva lo que ya haya
 * configurado el admin y nunca inventa un IP ni un nombre de impresora
 * ("no inventar IP ni printerName y preservarlos si ya existen").
 */
export const JALTECH_JAL_838L_SPEC = Object.freeze({
  brand: "Jaltech",
  model: "JAL-838L",
  defaultAlias: "Jaltech JAL-838L",
  physicalWidthMm: 82,
  printableWidthMm: 76,
  columns: 48,
  cut: "MANUAL",
  networkPort: 9100,
  // Campos pendientes de configurar por el admin (preservados si existen):
  defaultHost: "",
  defaultPrinterName: "",
});

/** Modos de conexión disponibles para el preset Jaltech JAL-838L. */
export const JAL_838L_CONNECTION_MODES = Object.freeze({
  NETWORK: "NETWORK",
  SYSTEM: "SYSTEM",
});

export const LABEL_SIZE_PRESETS = Object.freeze({
  "50X30": "50x30",
  "40X30": "40x30",
  "30X20": "30x20",
  // Variante dos columnas del mismo troquel 30x20 (cada etiqueta mide 30mm
  // de ancho; el gap horizontal se usa como separación real entre columnas
  // y el verticalGapMm actúa también como "sensor gap" para el sensor GAP
  // del troquel).
  "30X20_2COL": "30x20-2col",
  "58X40": "58x40",
  "76X50": "76x50",
  CUSTOM: "CUSTOM",
});

/** Mapa preset → medidas físicas en mm. */
export const LABEL_SIZE_DIMENSIONS = Object.freeze({
  "50x30": { widthMm: 50, heightMm: 30 },
  "40x30": { widthMm: 40, heightMm: 30 },
  "30x20": { widthMm: 30, heightMm: 20 },
  "30x20-2col": { widthMm: 30, heightMm: 20 },
  "58x40": { widthMm: 58, heightMm: 40 },
  "76x50": { widthMm: 76, heightMm: 50 },
});

/**
 * Config por defecto por preset. `horizontalGapMm` es editable para los
 * presets de 1 columna (siempre 2 ó 3), fijo para los 2col. `verticalGapMm`
 * se usa para separar filas y, en el troquel 30x20 2col, también actúa
 * como "gap" del sensor del rollo.
 */
export const LABEL_SIZE_PRESET_DEFAULTS = Object.freeze({
  "50x30":       { columns: 1, horizontalGapMm: 3, verticalGapMm: 0 },
  "40x30":       { columns: 1, horizontalGapMm: 2, verticalGapMm: 0 },
  "30x20":       { columns: 1, horizontalGapMm: 2, verticalGapMm: 0 },
  "30x20-2col":  { columns: 2, horizontalGapMm: 2, verticalGapMm: 2 },
  "58x40":       { columns: 1, horizontalGapMm: 2, verticalGapMm: 0 },
  "76x50":       { columns: 1, horizontalGapMm: 3, verticalGapMm: 0 },
});

/**
 * Gap horizontal permitido para 50x30. El troquel soporta 2 o 3 mm sin
 * desalinear el precio; otros valores se clampean dentro de BOUNDS.
 */
export const LABEL_SIZE_50X30_GAPS = Object.freeze([2, 3]);

export const SENSOR_TYPES = Object.freeze({
  GAP: "GAP",
  BLACK_MARK: "BLACK_MARK",
});

export const BARCODE_SYMBOLOGIES = Object.freeze({
  EAN13: "EAN13",
  CODE128: "CODE128",
  CODE39: "CODE39",
});

/**
 * IDs de fuentes TSPL built-in SEGURAS para texto en etiquetas.
 *
 * Las impresoras TSPL exponen fuentes "1".."8" con familias y tamaños
 * fijos (bitmap). Fuentes custom cargadas con comandos DOWNLOAD no caben
 * en el alcance del bridge actual, por eso topamos la UI a este set.
 *
 * Se guardan como STRING porque el comando TSPL embebe el ID entre
 * comillas: `TEXT X,Y,"3",0,sx,sy,"texto"`. Mantenerlo como string evita
 * conversiones ambiguas en el wire.
 */
export const TSPL_BUILTIN_FONTS = Object.freeze(["1", "2", "3", "4", "5", "6", "7", "8"]);

/**
 * Techo físico del medio soportado por el bridge, en mm. Coincide con
 * `PHYSICAL_MAX_MM` del label-generator y con el ancho del rollo del
 * modelo más ancho soportado (Jaltech JAL-838L, 82mm). Lo exponemos como
 * constante única para que la UI, el import y la validación compartan la
 * misma fuente de verdad sin duplicar el número.
 */
export const PHYSICAL_MAX_MM = 82;

// -----------------------------------------------------------------------------
// Rangos / bounds (centralizados para que la UI y la validación coincidan).
// -----------------------------------------------------------------------------

export const BOUNDS = Object.freeze({
  port: { min: 1, max: 65535 },
  // Techo físico 82mm = Jaltech JAL-838L (el modelo más ancho soportado).
  // El scale-bridge rechaza cualquier medio > 82mm con LAYOUT_OUT_OF_BOUNDS,
  // así que el frontend NUNCA debe aceptar un valor por encima: el UI, el
  // import (DB 016 / perfiles) y el sanitize comparten este techo.
  receiptWidthMm: { min: 20, max: 82 },
  // El ancho imprimible comparte min/max con `widthMm`. La restricción
  // adicional es que NUNCA puede superar al ancho físico — eso se enforce
  // en `sanitizePrintingConfig`, no acá.
  printableWidthMm: { min: 20, max: 82 },
  receiptColumns: { min: 20, max: 80 },
  // Alineado al techo físico 82mm. Para 2 columnas, `validatePrintingConfig`
  // enforce la fórmula completa: marginLeft + cols*width + (cols-1)*gap ≤ 82.
  labelWidthMm: { min: 20, max: 82 },
  labelHeightMm: { min: 5, max: 200 },
  labelColumns: { min: 1, max: 2 },
  horizontalGapMm: { min: 0, max: 30 },
  verticalGapMm: { min: 0, max: 30 },
  marginLeftMm: { min: 0, max: 50 },
  sensorGapMm: { min: 0, max: 20 },
  productNameFontPt: { min: 5, max: 24 },
  productNameMaxChars: { min: 1, max: 200 },
  priceFontPt: { min: 5, max: 48 },
  barcodeHeightMm: { min: 2, max: 60 },
  // DPI de la cabeza térmica. 203 cubre la mayoría de impresoras del POS;
  // 300dpi se encuentra en modelos premium. mmToDots usa este valor para
  // componer el payload TSPL del bridge.
  dpi: { min: 72, max: 600 },
  // Posiciones de layout en mm sobre la cara de la etiqueta. El sanitize
  // las clampea contra el tamaño de la etiqueta.
  layoutPosMm: { min: 0, max: 200 },
  layoutFontScale: { min: 0.5, max: 4 },
  // TSPL `BARCODE` acepta "narrow" y "wide" en dots. Rango seguro para
  // CODE128/EAN13 a 203dpi.
  barcodeModule: { min: 1, max: 8 },
  // --- Góndola térmica (rollo continuo TSPL 20..82 mm). ---
  gondolaThermalWidthMm: { min: 20, max: 82 },
  gondolaThermalPrintableWidthMm: { min: 10, max: 82 },
  gondolaThermalHeightMm: { min: 20, max: 200 },
  gondolaThermalMarginMm: { min: 0, max: 20 },
  gondolaThermalGapMm: { min: 0, max: 10 },
  gondolaThermalDensity: { min: 0, max: 15 },
  gondolaThermalNameMaxChars: { min: 1, max: 60 },
  gondolaThermalScale: { min: 1, max: 10 },
  // Alto del código de barras CODE128 en la etiqueta de góndola térmica.
  // Mínimo 3 mm porque por debajo deja de ser legible por lectores
  // comerciales; máximo 30 mm para que nunca invada el bloque de precio.
  gondolaThermalBarcodeHeightMm: { min: 3, max: 30 },
  // Literal corto que acompaña al precio ("PRECIO UND", "x UN", "KG", etc.).
  // El renderer trunca a este máximo para que la línea no pise el precio.
  gondolaThermalUnitLabelMaxChars: { min: 1, max: 24 },
  maxStringLength: 200,
});

// -----------------------------------------------------------------------------
// Defaults canónicos de la rama `gondola.thermal`. Se exportan para que la
// UI y los tests contractuales no reinventen números.
// -----------------------------------------------------------------------------

/**
 * Configuración térmica por defecto para góndola 80 mm. Perfectamente
 * saneada: `sanitizePrintingConfig` inyecta este objeto cuando la rama
 * `gondola.thermal` falta (BC con localStorage sin thermal).
 *
 * Diseño visual (coincide con la referencia aprobada 2026-10):
 *   - Nombre arriba (máx. 2 líneas, truncado por `nameMaxChars`).
 *   - Separador fino opcional.
 *   - Precio GRANDE centrado por métricas, formato colombiano.
 *   - Literal corto `unitLabel` ("PRECIO UND") bajo el precio.
 *   - CODE128 abajo a la izquierda (sólo si `showBarcode` y el código es
 *     ASCII seguro). HRI apagado — el PLU va como texto en la derecha.
 *   - Código/PLU abajo a la derecha (sólo si `showCode`).
 *   - Fecha opcional (`showDate`).
 */
export const DEFAULT_GONDOLA_THERMAL_CONFIG = Object.freeze({
  widthMm: 80,
  printableWidthMm: 76,
  heightMm: 40,
  marginLeftMm: 2,
  marginTopMm: 2,
  marginBottomMm: 2,
  gapMm: 0,
  direction: 0,
  mirror: 0,
  density: 8,
  dpi: DEFAULT_DPI,
  nameFont: "3",
  nameScaleX: 1,
  nameScaleY: 1,
  nameMaxChars: 24,
  priceFont: "4",
  priceScaleX: 2,
  priceScaleY: 2,
  // --- Nuevos campos (retrocompatibles). Legacy configs sin estos
  //     recibirán los defaults al pasar por `sanitizeGondolaThermal`.
  // Imprime un código de barras CODE128 abajo a la izquierda. Si el
  // código del producto no es ASCII seguro, el bridge omite el barcode y
  // conserva el PLU; nunca falla la impresión por este motivo.
  showBarcode: true,
  // Alto nominal del barcode (mm). El renderer lo acota al área real
  // disponible: nunca invade el bloque del precio ni se sale del
  // marginBottom.
  barcodeHeightMm: 8,
  // Literal corto bajo el precio ("PRECIO UND" por defecto). El admin
  // puede personalizarlo por unidad del producto desde la UI de config
  // o apagarlo con `showUnitLabel: false`.
  showUnitLabel: true,
  unitLabel: "PRECIO UND",
  // --- Existentes ---
  showCode: true,
  showDate: true,
  footerFont: "1",
  footerScaleX: 1,
  footerScaleY: 1,
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
    /**
     * Modo activo del equipo: `RECEIPT` arranca la UI como caja, `LABEL`
     * como punto de etiquetado. Es un hint para `/labels/config` (resalta
     * la tab relevante) y viaja en el payload del bridge. Nunca restringe
     * capacidades físicas de la impresora. Default `RECEIPT` porque el
     * flujo de venta depende de la tirilla.
     */
    activeMode: ACTIVE_MODES.RECEIPT,
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
      /**
       * Flag específico: abrir cajón AUTOMÁTICAMENTE tras una venta
       * exitosa. El orquestador de `UniversalPaymentModal` usa el kick
       * audit-first como ÚNICA ruta física, incluso cuando autoPrint está
       * desactivado. `drawer.event` determina el orden relativo respecto
       * a la tirilla (BEFORE_PRINT/AFTER_PRINT); MANUAL nunca abre solo.
       * Reimpresión desde historial, impresión de etiquetas y cambios del
       * toggle no disparan este flag. El browser NUNCA finge una apertura;
       * sólo el bridge local tiene capacidad real.
       */
      openDrawerOnSale: false,
    },
    receipt: {
      paper: PAPER_PRESETS.WIDTH_80,
      widthMm: 80,
      /**
       * Default actualizado: el rollo "80mm genérico" realmente tiene
       * ~76mm imprimibles (4mm de margen físico muerto que el cabezal no
       * toca). El rollo "58mm" tiene ~48mm imprimibles. Las instalaciones
       * que guardaron explícitamente `printableWidthMm` en LocalStorage
       * preservan su valor (sanitize respeta el input explícito).
       */
      printableWidthMm: 76,
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
      // Default seguro: `browser` siempre funciona (abre diálogo del
      // navegador). `bridge` queda opt-in explícito para admins con
      // scale-bridge/equivalente instalado y configurado.
      deliveryMode: RECEIPT_DELIVERY_MODES.BROWSER,
    },
    labels: {
      sizePreset: LABEL_SIZE_PRESETS["50X30"],
      widthMm: 50,
      heightMm: 30,
      columns: 1,
      horizontalGapMm: 3,
      /**
       * Separación vertical entre filas de etiquetas. En el troquel 30x20
       * de 2 columnas actúa también como "sensor gap" para que el rollo
       * se alinee entre páginas lógicas.
       */
      verticalGapMm: 0,
      /** Margen izquierdo del área imprimible dentro de la etiqueta física. */
      marginLeftMm: 0,
      /** DPI de la cabeza térmica. 203 cubre casi todas las impresoras TSPL/ZPL. */
      dpi: DEFAULT_DPI,
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
        /** Imprimir dígitos legibles bajo el barcode (TSPL "readable"). */
        humanReadable: true,
        /** Ancho de módulo "narrow" en dots (TSPL). */
        narrow: 2,
        /** Ancho de módulo "wide" en dots (TSPL). */
        wide: 2,
        /** Rotación en grados: 0 horizontal, 90 vertical, 180/270 raros. */
        rotation: 0,
      },
      /**
       * Posiciones precisas de cada elemento sobre la etiqueta, en mm
       * desde la esquina superior izquierda del área imprimible (después
       * de `marginLeftMm`). Permiten al bridge componer TSPL/ZPL sin
       * recalcular layout en el lado backend.
       *
       * Para `name` y `price`:
       *   - `font` es el ID de una fuente TSPL built-in (`"1".."8"`).
       *     Default `"3"` para nombre (densa) y `"4"` para precio (grande).
       *   - `fontScale` multiplica el tamaño (clamp 0.5..4). El bridge lo
       *     traduce a `scaleX/scaleY` enteros 1..10.
       *
       * Para `barcode` solo importan `xMm/yMm`; el tamaño del código se
       * controla por `labels.barcode.heightMm` + `narrow`/`wide`.
       */
      layout: {
        name:    { xMm: 2, yMm: 2,  font: "3", fontScale: 1 },
        price:   { xMm: 2, yMm: 10, font: "4", fontScale: 2 },
        barcode: { xMm: 2, yMm: 18, fontScale: 1 },
      },
      extras: {
        showDate: false,
        showInternalCode: false,
        showCategory: false,
      },
    },
    /**
     * Rama góndola: precios físicos.
     *
     * Formatos soportados:
     *   - `LETTER` (Carta, default) → landscape 279.4×215.9 mm, grid 3×5 = 15.
     *     Impresión por diálogo del navegador (iframe aislado). Nunca
     *     usa el bridge térmico.
     *   - `LEGAL`  (Oficio)         → landscape 355.6×215.9 mm, grid 4×5 = 20.
     *     Mismo flujo iframe que LETTER.
     *   - `THERMAL_80` → rollo térmico continuo 80 mm. Imprime DIRECTO
     *     por el bridge (`window.posBridge.print({type:"shelf-labels"})`),
     *     sin iframe ni diálogo del navegador. Los parámetros físicos
     *     (dimensiones, densidad, fuentes TSPL, pie) viven en
     *     `gondola.thermal` y se sanean junto con el resto de la config.
     *
     * La geometría de LETTER/LEGAL se calcula en `shelf-labels.mjs` para
     * no duplicar dimensiones físicas en dos ficheros. La rama `thermal`
     * se envía tal cual al bridge dentro del payload `shelf-labels`.
     */
    gondola: {
      format: DEFAULT_GONDOLA_FORMAT,
      thermal: { ...DEFAULT_GONDOLA_THERMAL_CONFIG },
    },
  };
}

// -----------------------------------------------------------------------------
// Sanitize gondola.thermal
// -----------------------------------------------------------------------------

/**
 * Sanitiza la rama `gondola.thermal` SIEMPRE a un objeto canónico. Si el
 * input es null/undefined o un tipo distinto a objeto, devuelve una copia
 * del default. Cualquier campo fuera de bounds se clampea; cualquier enum
 * desconocido cae al default. Nunca lanza.
 *
 * Reglas duras:
 *   - `printableWidthMm` nunca excede `widthMm` (clamp al final).
 *   - `marginLeftMm + printableWidthMm` nunca supera `widthMm`: si da,
 *     se recorta `printableWidthMm` para que la línea quepa.
 *   - Fuentes TSPL fuera de `TSPL_BUILTIN_FONTS` caen al default del campo.
 *   - `direction`/`mirror` ∈ {0,1}.
 */
export function sanitizeGondolaThermal(input) {
  const def = DEFAULT_GONDOLA_THERMAL_CONFIG;
  const src = ensureObject(input);

  const widthMm = clampInt(
    src.widthMm,
    BOUNDS.gondolaThermalWidthMm.min,
    BOUNDS.gondolaThermalWidthMm.max,
    def.widthMm,
  );
  // printable 10..82 (BOUNDS gondolaThermalPrintableWidthMm) pero jamás
  // mayor que widthMm.
  let printableWidthMm = clampInt(
    src.printableWidthMm,
    BOUNDS.gondolaThermalPrintableWidthMm.min,
    Math.min(BOUNDS.gondolaThermalPrintableWidthMm.max, widthMm),
    Math.min(def.printableWidthMm, widthMm),
  );
  const heightMm = clampInt(
    src.heightMm,
    BOUNDS.gondolaThermalHeightMm.min,
    BOUNDS.gondolaThermalHeightMm.max,
    def.heightMm,
  );
  const marginLeftMm = clampInt(
    src.marginLeftMm,
    BOUNDS.gondolaThermalMarginMm.min,
    BOUNDS.gondolaThermalMarginMm.max,
    def.marginLeftMm,
  );
  const marginTopMm = clampInt(
    src.marginTopMm,
    BOUNDS.gondolaThermalMarginMm.min,
    BOUNDS.gondolaThermalMarginMm.max,
    def.marginTopMm,
  );
  const marginBottomMm = clampInt(
    src.marginBottomMm,
    BOUNDS.gondolaThermalMarginMm.min,
    BOUNDS.gondolaThermalMarginMm.max,
    def.marginBottomMm,
  );
  // Si margen izquierdo + ancho imprimible exceden el ancho físico, se
  // reduce el ancho imprimible. Nunca movemos el margen (es intencional
  // del admin).
  if (marginLeftMm + printableWidthMm > widthMm) {
    printableWidthMm = Math.max(
      BOUNDS.gondolaThermalPrintableWidthMm.min,
      widthMm - marginLeftMm,
    );
  }
  const gapMm = clampInt(
    src.gapMm,
    BOUNDS.gondolaThermalGapMm.min,
    BOUNDS.gondolaThermalGapMm.max,
    def.gapMm,
  );
  const direction = Number(src.direction) === 1 ? 1 : 0;
  const mirror = Number(src.mirror) === 1 ? 1 : 0;
  const density = clampInt(
    src.density,
    BOUNDS.gondolaThermalDensity.min,
    BOUNDS.gondolaThermalDensity.max,
    def.density,
  );
  const dpi = clampInt(src.dpi, BOUNDS.dpi.min, BOUNDS.dpi.max, def.dpi);

  const pickFont = (raw, fallback) => {
    const value = raw == null ? "" : String(raw);
    return TSPL_BUILTIN_FONTS.includes(value) ? value : fallback;
  };
  const nameFont = pickFont(src.nameFont, def.nameFont);
  const nameScaleX = clampInt(
    src.nameScaleX,
    BOUNDS.gondolaThermalScale.min,
    BOUNDS.gondolaThermalScale.max,
    def.nameScaleX,
  );
  const nameScaleY = clampInt(
    src.nameScaleY,
    BOUNDS.gondolaThermalScale.min,
    BOUNDS.gondolaThermalScale.max,
    def.nameScaleY,
  );
  const nameMaxChars = clampInt(
    src.nameMaxChars,
    BOUNDS.gondolaThermalNameMaxChars.min,
    BOUNDS.gondolaThermalNameMaxChars.max,
    def.nameMaxChars,
  );
  const priceFont = pickFont(src.priceFont, def.priceFont);
  const priceScaleX = clampInt(
    src.priceScaleX,
    BOUNDS.gondolaThermalScale.min,
    BOUNDS.gondolaThermalScale.max,
    def.priceScaleX,
  );
  const priceScaleY = clampInt(
    src.priceScaleY,
    BOUNDS.gondolaThermalScale.min,
    BOUNDS.gondolaThermalScale.max,
    def.priceScaleY,
  );
  const showCode = pickBool(src.showCode, def.showCode);
  const showDate = pickBool(src.showDate, def.showDate);
  // Toggles nuevos (retrocompatibles). Legacy sin estos campos recibe
  // los defaults canónicos. `pickBool` acepta "true"/"false" strings
  // además de booleanos: imprescindible para configs importadas desde
  // formularios donde el valor viaja como string.
  const showBarcode = pickBool(src.showBarcode, def.showBarcode);
  const showUnitLabel = pickBool(src.showUnitLabel, def.showUnitLabel);
  // Alto del barcode: clamp dentro de bounds, redondeado a entero (mm).
  const barcodeHeightMm = clampInt(
    src.barcodeHeightMm,
    BOUNDS.gondolaThermalBarcodeHeightMm.min,
    BOUNDS.gondolaThermalBarcodeHeightMm.max,
    def.barcodeHeightMm,
  );
  // Literal unitario: trimado, truncado al bound. Si queda vacío se
  // reemplaza por el default ("PRECIO UND") para que la UI nunca se
  // quede sin texto cuando `showUnitLabel: true`.
  const unitLabelRaw = cleanString(
    src.unitLabel,
    BOUNDS.gondolaThermalUnitLabelMaxChars.max,
  );
  const unitLabel = unitLabelRaw || def.unitLabel;
  const footerFont = pickFont(src.footerFont, def.footerFont);
  const footerScaleX = clampInt(
    src.footerScaleX,
    BOUNDS.gondolaThermalScale.min,
    BOUNDS.gondolaThermalScale.max,
    def.footerScaleX,
  );
  const footerScaleY = clampInt(
    src.footerScaleY,
    BOUNDS.gondolaThermalScale.min,
    BOUNDS.gondolaThermalScale.max,
    def.footerScaleY,
  );

  return {
    widthMm,
    printableWidthMm,
    heightMm,
    marginLeftMm,
    marginTopMm,
    marginBottomMm,
    gapMm,
    direction,
    mirror,
    density,
    dpi,
    nameFont,
    nameScaleX,
    nameScaleY,
    nameMaxChars,
    priceFont,
    priceScaleX,
    priceScaleY,
    showCode,
    showDate,
    showBarcode,
    barcodeHeightMm,
    showUnitLabel,
    unitLabel,
    footerFont,
    footerScaleX,
    footerScaleY,
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
  let receiptWidthMm;
  if (paper === PAPER_PRESETS.WIDTH_80) {
    receiptWidthMm = 80;
  } else if (paper === PAPER_PRESETS.WIDTH_58) {
    receiptWidthMm = 58;
  } else if (paper === PAPER_PRESETS.JAL_838L) {
    receiptWidthMm = JALTECH_JAL_838L_SPEC.physicalWidthMm;
  } else {
    receiptWidthMm = clampInt(
      receipt.widthMm,
      BOUNDS.receiptWidthMm.min,
      BOUNDS.receiptWidthMm.max,
      defaults.receipt.widthMm,
    );
  }

  // Para 58/80/JAL_838L el conteo de columnas es fijo (coincide con
  // thermal-ticket.ts). Sólo CUSTOM admite un valor libre dentro de los
  // bounds.
  const defaultColumns = PAPER_COLUMNS[String(receiptWidthMm)]
    || (paper === PAPER_PRESETS.WIDTH_58 ? 32 : 48);
  let receiptColumns;
  if (paper === PAPER_PRESETS.WIDTH_80) {
    receiptColumns = PAPER_COLUMNS["80"];
  } else if (paper === PAPER_PRESETS.WIDTH_58) {
    receiptColumns = PAPER_COLUMNS["58"];
  } else if (paper === PAPER_PRESETS.JAL_838L) {
    receiptColumns = JALTECH_JAL_838L_SPEC.columns;
  } else {
    receiptColumns = clampInt(
      receipt.columns,
      BOUNDS.receiptColumns.min,
      BOUNDS.receiptColumns.max,
      defaultColumns,
    );
  }

  // Ancho imprimible real. Nunca puede superar `widthMm`: ésa es la frontera
  // física real del cabezal térmico, no un número decorativo. `sanitize` es
  // la única capa que lo recorta: la UI puede ser laxa y el bridge recibe
  // siempre un valor consistente.
  //
  // Default por preset (cuando el input NO trae `printableWidthMm` explícito):
  //   - WIDTH_80  → 76 mm imprimibles (4 mm de margen físico muerto).
  //   - WIDTH_58  → 48 mm imprimibles (10 mm de margen físico muerto).
  //   - JAL_838L  → 76 mm (parte de la especificación del modelo).
  //   - CUSTOM    → `widthMm` (ninguna diferencia física conocida).
  //
  // Las instalaciones que YA guardaron un valor explícito en LocalStorage
  // (ejemplo: configs CUSTOM con 80mm/80mm imprimibles) preservan ese valor
  // porque entran por la rama `hasExplicitPrintable`.
  const rawPrintable = receipt.printableWidthMm;
  const hasExplicitPrintable = rawPrintable !== undefined
    && rawPrintable !== null
    && rawPrintable !== "";
  let printableWidthMm;
  if (hasExplicitPrintable) {
    // Clamp estricto: min respeta BOUNDS, max NUNCA excede el widthMm físico.
    printableWidthMm = clampInt(
      rawPrintable,
      BOUNDS.printableWidthMm.min,
      receiptWidthMm,
      receiptWidthMm,
    );
  } else if (paper === PAPER_PRESETS.WIDTH_80) {
    printableWidthMm = 76;
  } else if (paper === PAPER_PRESETS.WIDTH_58) {
    printableWidthMm = 48;
  } else if (paper === PAPER_PRESETS.JAL_838L) {
    printableWidthMm = JALTECH_JAL_838L_SPEC.printableWidthMm;
  } else {
    printableWidthMm = receiptWidthMm;
  }

  // TSPL sólo admite escalas enteras. El bridge ancla el "punto medio"
  // del rollo 58 mm (48 mm imprimibles) en la fuente built-in `8` con
  // escalas 14x25 y scaleY=1: eso le da legibilidad real en caja sin
  // repetir el salto extremo a `font2 scaleY2` (hileras muy altas que
  // partían filas) ni al glifo `font1` (ilegible). Para alinear el
  // frontend con esa decisión fija los topes conocidos por ancho
  // imprimible real:
  //
  //   - 48 mm imprimibles (preset 58 mm)        → tope duro de 26 cols.
  //   - 76 mm imprimibles (preset 80 mm / 82 mm JAL_838L) → tope duro
  //     de 48 cols (fuente built-in 2, scaleX=scaleY=1).
  //   - Otros `printableWidthMm` (CUSTOM angosto, p.ej. 30/32 mm legacy)
  //     mantienen la defensa aritmética histórica (12 dots por glifo
  //     TSPL built-in 2 a 203 dpi) para que nunca escupan glifos
  //     ilegibles o se desborden del cabezal.
  //
  // Otros protocolos (ESC/POS, SYSTEM/PDF, ZPL) mantienen exactamente
  // su configuración nominal: el clamp vive sólo en el camino TSPL.
  if (connProtocol === PROTOCOLS.TSPL) {
    const roundedPrintableMm = Math.round(printableWidthMm);
    let maxReadableColumns;
    if (roundedPrintableMm === 48) {
      // 58/48 → tope 26 columnas (punto medio font8 14x25 scaleY1).
      maxReadableColumns = 26;
    } else if (roundedPrintableMm === 76) {
      // 80/76 y 82/76 → mantienen 48/font2/scale1.
      maxReadableColumns = 48;
    } else {
      // Defensa legacy / CUSTOM: deriva por aritmética con fuente 2.
      const tsplDpi = 203;
      const tsplReadableGlyphDots = 12;
      const tsplLeftMarginMm = 1.5;
      const availableDots = Math.max(0, printableWidthMm - tsplLeftMarginMm)
        * tsplDpi / 25.4;
      maxReadableColumns = Math.max(
        BOUNDS.receiptColumns.min,
        Math.floor(availableDots / tsplReadableGlyphDots),
      );
    }
    receiptColumns = Math.min(receiptColumns, maxReadableColumns);
  }

  const sizePreset = pickEnum(labels.sizePreset, Object.values(LABEL_SIZE_PRESETS), defaults.labels.sizePreset);
  const presetDims = LABEL_SIZE_DIMENSIONS[sizePreset];
  const labelWidthMm = presetDims
    ? presetDims.widthMm
    : clampInt(labels.widthMm, BOUNDS.labelWidthMm.min, BOUNDS.labelWidthMm.max, defaults.labels.widthMm);
  const labelHeightMm = presetDims
    ? presetDims.heightMm
    : clampInt(labels.heightMm, BOUNDS.labelHeightMm.min, BOUNDS.labelHeightMm.max, defaults.labels.heightMm);

  // Columnas, gaps y margen según preset. Para los presets conocidos los
  // valores vienen del mapa canónico (`LABEL_SIZE_PRESET_DEFAULTS`). Para
  // CUSTOM se respeta el input del usuario clampado.
  const presetGaps = LABEL_SIZE_PRESET_DEFAULTS[sizePreset];
  let labelColumns;
  let labelHorizontalGap;
  let labelVerticalGap;
  if (presetGaps) {
    // Los presets 2col fijan columns=2 estrictamente. Los 1col fijan
    // columns=1 por diseño físico del troquel. El preset 50x30 permite
    // alternar gap horizontal entre 2 y 3 (ambos valores aparecen en los
    // troqueles disponibles del mercado); respetamos el input dentro de
    // ese set permitido.
    labelColumns = presetGaps.columns;
    if (sizePreset === "50x30") {
      const rawGap = Number(labels.horizontalGapMm);
      const accepted = LABEL_SIZE_50X30_GAPS.includes(rawGap)
        ? rawGap
        : presetGaps.horizontalGapMm;
      labelHorizontalGap = accepted;
    } else if (sizePreset === "30x20-2col") {
      // Fijo por diseño: 2 columnas con 2mm de gap horizontal.
      labelHorizontalGap = presetGaps.horizontalGapMm;
    } else {
      // Otros presets 1col aceptan el input dentro de BOUNDS pero caen al
      // default canónico si no viene nada.
      labelHorizontalGap = clampInt(
        labels.horizontalGapMm,
        BOUNDS.horizontalGapMm.min,
        BOUNDS.horizontalGapMm.max,
        presetGaps.horizontalGapMm,
      );
    }
    if (sizePreset === "30x20-2col") {
      // Vertical fijo por diseño del troquel 2col.
      labelVerticalGap = presetGaps.verticalGapMm;
    } else {
      labelVerticalGap = clampInt(
        labels.verticalGapMm,
        BOUNDS.verticalGapMm.min,
        BOUNDS.verticalGapMm.max,
        presetGaps.verticalGapMm,
      );
    }
  } else {
    // CUSTOM: todo editable dentro de BOUNDS.
    labelColumns = clampInt(labels.columns, BOUNDS.labelColumns.min, BOUNDS.labelColumns.max, defaults.labels.columns);
    labelHorizontalGap = clampInt(labels.horizontalGapMm, BOUNDS.horizontalGapMm.min, BOUNDS.horizontalGapMm.max, defaults.labels.horizontalGapMm);
    labelVerticalGap = clampInt(labels.verticalGapMm, BOUNDS.verticalGapMm.min, BOUNDS.verticalGapMm.max, defaults.labels.verticalGapMm);
  }

  const labelMarginLeftMm = clampInt(
    labels.marginLeftMm,
    BOUNDS.marginLeftMm.min,
    BOUNDS.marginLeftMm.max,
    defaults.labels.marginLeftMm,
  );
  const labelDpi = clampInt(
    labels.dpi,
    BOUNDS.dpi.min,
    BOUNDS.dpi.max,
    defaults.labels.dpi,
  );

  // Layout tipado: cada bloque trae xMm/yMm/fontScale. Clampeamos las
  // posiciones contra las dimensiones físicas de la etiqueta. Los bloques
  // `name` y `price` admiten además `font` (ID TSPL built-in "1".."8"); el
  // bloque `barcode` ignora `font` porque su tipografía viene de la
  // simbología + narrow/wide.
  const layoutSrc = ensureObject(labels.layout);
  const defaultLayout = defaults.labels.layout;
  function sanitizeLayoutBlock(blockSrc, blockDefault, acceptsFont) {
    const b = ensureObject(blockSrc);
    const out = {
      xMm: clampNumber(b.xMm, BOUNDS.layoutPosMm.min, Math.max(labelWidthMm, BOUNDS.layoutPosMm.min), blockDefault.xMm),
      yMm: clampNumber(b.yMm, BOUNDS.layoutPosMm.min, Math.max(labelHeightMm, BOUNDS.layoutPosMm.min), blockDefault.yMm),
      fontScale: clampNumber(b.fontScale, BOUNDS.layoutFontScale.min, BOUNDS.layoutFontScale.max, blockDefault.fontScale),
    };
    if (acceptsFont) {
      const rawFont = typeof b.font === "string" || typeof b.font === "number" ? String(b.font) : "";
      out.font = TSPL_BUILTIN_FONTS.includes(rawFont) ? rawFont : (blockDefault.font || "3");
    }
    return out;
  }
  const sanitizedLayout = {
    name: sanitizeLayoutBlock(layoutSrc.name, defaultLayout.name, true),
    price: sanitizeLayoutBlock(layoutSrc.price, defaultLayout.price, true),
    barcode: sanitizeLayoutBlock(layoutSrc.barcode, defaultLayout.barcode, false),
  };

  const version = typeof src.version === "number" && Number.isFinite(src.version)
    ? src.version
    : PRINTING_CONFIG_VERSION;

  // activeMode: hint de modo activo. Cualquier valor desconocido cae al
  // default `RECEIPT` para no corromper configuraciones legacy que nunca
  // escribieron este campo.
  const activeMode = pickEnum(
    src.activeMode,
    Object.values(ACTIVE_MODES),
    defaults.activeMode,
  );

  // Rama góndola: formato con alias ES + thermal saneado SIEMPRE.
  // La inline object literal `gondola: { format: ..., thermal: ... }`
  // mantiene la forma esperada por los guardianes estáticos. Las dos
  // dependencias (`normalizeGondolaFormat`, `sanitizeGondolaThermal`)
  // viven fuera para no inflar el reducer.
  const srcGondola = ensureObject(src.gondola);
  const gondolaFormat = normalizeGondolaFormat(srcGondola.format) || defaults.gondola.format;
  // Compara explícitamente contra los dos destinos canónicos (LETTER /
  // LEGAL) para que los guardianes estáticos puedan auditar la rama sin
  // depender de la implementación del mapa de aliases. THERMAL_80 pasa
  // por el fallback del helper.
  const gondolaFormatCanonical = gondolaFormat === GONDOLA_FORMATS.LETTER
    ? GONDOLA_FORMATS.LETTER
    : gondolaFormat === GONDOLA_FORMATS.LEGAL
      ? GONDOLA_FORMATS.LEGAL
      : gondolaFormat === GONDOLA_FORMATS.THERMAL_80
        ? GONDOLA_FORMATS.THERMAL_80
        : defaults.gondola.format;
  const gondolaThermal = sanitizeGondolaThermal(srcGondola.thermal);

  const sanitized = {
    version: PRINTING_CONFIG_VERSION, // forzamos siempre a la versión actual
    updatedAt: cleanString(src.updatedAt, 40) || null,
    source: cleanString(src.source, 40) || "default",
    _ingestedVersion: version,
    activeMode,
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
      openDrawerOnSale: pickBool(drawer.openDrawerOnSale, defaults.drawer.openDrawerOnSale),
    },
    receipt: {
      paper,
      widthMm: receiptWidthMm,
      printableWidthMm,
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
      // deliveryMode: `bridge` o `browser`. Sanitize es la ÚNICA frontera que
      // acepta/rechaza este enum. Un valor desconocido cae al default seguro
      // (`browser`) para que el POS nunca intente la ruta directa sin
      // confirmación explícita del admin.
      deliveryMode: pickEnum(
        receipt.deliveryMode,
        Object.values(RECEIPT_DELIVERY_MODES),
        defaults.receipt.deliveryMode,
      ),
    },
    labels: {
      sizePreset,
      widthMm: labelWidthMm,
      heightMm: labelHeightMm,
      columns: labelColumns,
      horizontalGapMm: labelHorizontalGap,
      verticalGapMm: labelVerticalGap,
      marginLeftMm: labelMarginLeftMm,
      dpi: labelDpi,
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
        humanReadable: pickBool(barcode.humanReadable, defaults.labels.barcode.humanReadable),
        narrow: clampInt(barcode.narrow, BOUNDS.barcodeModule.min, BOUNDS.barcodeModule.max, defaults.labels.barcode.narrow),
        wide: clampInt(barcode.wide, BOUNDS.barcodeModule.min, BOUNDS.barcodeModule.max, defaults.labels.barcode.wide),
        rotation: BARCODE_ROTATIONS.includes(Number(barcode.rotation))
          ? Number(barcode.rotation)
          : defaults.labels.barcode.rotation,
      },
      layout: sanitizedLayout,
      extras: {
        showDate: pickBool(extras.showDate, defaults.labels.extras.showDate),
        showInternalCode: pickBool(extras.showInternalCode, defaults.labels.extras.showInternalCode),
        showCategory: pickBool(extras.showCategory, defaults.labels.extras.showCategory),
      },
    },
    gondola: {
      format: gondolaFormatCanonical,
      thermal: gondolaThermal,
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

  // Techo físico 82 mm: el bridge rechaza cualquier medio que exceda
  // (LAYOUT_OUT_OF_BOUNDS). Validamos la fórmula completa en el frontend
  // para que Guardar se deshabilite ANTES de intentar imprimir — nada de
  // esperar a un fallo del scale-bridge en producción.
  const totalLabelWidth = c.labels.marginLeftMm
    + c.labels.columns * c.labels.widthMm
    + Math.max(0, c.labels.columns - 1) * c.labels.horizontalGapMm;
  if (totalLabelWidth > PHYSICAL_MAX_MM) {
    errors.push({
      path: "labels.widthMm",
      message:
        `El ancho total de etiquetas (${totalLabelWidth.toFixed(1)} mm) excede el límite físico de ${PHYSICAL_MAX_MM} mm: ` +
        `margen ${c.labels.marginLeftMm} + ${c.labels.columns}col × ${c.labels.widthMm} mm` +
        (c.labels.columns > 1 ? ` + ${c.labels.columns - 1} × gap ${c.labels.horizontalGapMm} mm` : "") +
        `. Reduce ancho, columnas, margen o gap horizontal.`,
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
    // Default actualizado: el rollo 80mm genérico tiene 76mm imprimibles
    // (4mm de margen físico muerto). El admin puede editar manualmente
    // desde `/labels/config` si una impresora específica usa otro valor.
    base.receipt.printableWidthMm = 76;
    base.receipt.columns = PAPER_COLUMNS["80"];
  } else if (preset === PAPER_PRESETS.WIDTH_58) {
    base.receipt.paper = PAPER_PRESETS.WIDTH_58;
    base.receipt.widthMm = 58;
    // Default actualizado: el rollo 58mm genérico tiene 48mm imprimibles.
    base.receipt.printableWidthMm = 48;
    base.receipt.columns = PAPER_COLUMNS["58"];
  } else if (preset === PAPER_PRESETS.JAL_838L) {
    // Preset físico del modelo Jaltech JAL-838L. El ancho imprimible y el
    // modo de corte son parte de la especificación — no una preferencia del
    // usuario. Al activarse se fuerza `cut=MANUAL` porque esta impresora
    // no trae cutter automático confiable.
    base.receipt.paper = PAPER_PRESETS.JAL_838L;
    base.receipt.widthMm = JALTECH_JAL_838L_SPEC.physicalWidthMm;
    base.receipt.printableWidthMm = JALTECH_JAL_838L_SPEC.printableWidthMm;
    base.receipt.columns = JALTECH_JAL_838L_SPEC.columns;
    base.receipt.cut = CUT_MODES.MANUAL;
  } else if (preset === PAPER_PRESETS.CUSTOM) {
    base.receipt.paper = PAPER_PRESETS.CUSTOM;
  }
  // sanitize garantiza coherencia (printableWidthMm <= widthMm, etc.).
  return sanitizePrintingConfig(base);
}

/**
 * Aplica el preset físico Jaltech JAL-838L + una variante de conexión.
 *
 *   - mode="NETWORK": interfaz NETWORK + protocolo escpos + puerto 9100.
 *     Se PRESERVA el host existente (nunca inventa un IP).
 *   - mode="SYSTEM":  interfaz SYSTEM + protocolo system + spooler WINDOWS.
 *     Se PRESERVA el nombre de impresora existente (nunca lo inventa).
 *
 * El alias sólo se reemplaza cuando el admin no lo había personalizado
 * (es decir, cuando sigue siendo el alias por defecto de la app). Si el
 * admin ya puso "Caja 2 — mostrador" no lo pisamos.
 *
 * @param {unknown} config
 * @param {{ mode?: "NETWORK" | "SYSTEM" }} [options]
 * @returns {object}
 */
export function applyJaltechJAL838LPreset(config, options) {
  const base = applyReceiptPaperPreset(config, PAPER_PRESETS.JAL_838L);
  const defaults = createDefaultPrintingConfig();
  const mode = options && options.mode === JAL_838L_CONNECTION_MODES.SYSTEM
    ? JAL_838L_CONNECTION_MODES.SYSTEM
    : JAL_838L_CONNECTION_MODES.NETWORK;

  // Alias: respetar personalización previa. Sólo pisamos el default
  // genérico "Impresora POS" para que la UI deje claro qué equipo está
  // activo.
  const currentAlias = (base.connection.alias || "").trim();
  if (!currentAlias || currentAlias === defaults.connection.alias) {
    base.connection.alias = JALTECH_JAL_838L_SPEC.defaultAlias;
  }

  if (mode === JAL_838L_CONNECTION_MODES.NETWORK) {
    base.connection.interface = INTERFACES.NETWORK;
    base.connection.protocol = PROTOCOLS.ESCPOS;
    // NUNCA inventamos IP: preservamos lo que haya configurado el admin.
    // El puerto sí es parte de la especificación (9100 ESC/POS raw).
    base.connection.network.port = JALTECH_JAL_838L_SPEC.networkPort;
    // base.connection.network.host se queda tal cual (puede estar vacío).
  } else {
    base.connection.interface = INTERFACES.SYSTEM;
    base.connection.protocol = PROTOCOLS.SYSTEM;
    base.connection.system.spooler = SPOOLERS.WINDOWS;
    // base.connection.system.printerName se queda tal cual (puede estar vacío).
  }

  return sanitizePrintingConfig(base);
}

export function applyLabelSizePreset(config, preset) {
  const base = sanitizePrintingConfig(config);
  const defaults = createDefaultPrintingConfig();
  if (LABEL_SIZE_DIMENSIONS[preset]) {
    base.labels.sizePreset = preset;
    base.labels.widthMm = LABEL_SIZE_DIMENSIONS[preset].widthMm;
    base.labels.heightMm = LABEL_SIZE_DIMENSIONS[preset].heightMm;
    const presetGaps = LABEL_SIZE_PRESET_DEFAULTS[preset];
    if (presetGaps) {
      base.labels.columns = presetGaps.columns;
      base.labels.horizontalGapMm = presetGaps.horizontalGapMm;
      base.labels.verticalGapMm = presetGaps.verticalGapMm;
      // Sincronización con el GAP físico del troquel: para presets 2 col el
      // `verticalGapMm` ES el sensor gap del rollo (así lo documenta la UI
      // "Sensor GAP fijo en 2 mm por diseño del troquel 2 columnas"). Sin
      // esta sincronización, el bridge emite TSPL `GAP sensor.gapMm` (default
      // 3 mm) ignorando los 2 mm reales del troquel, y la impresora pierde
      // alineación entre páginas. Las presets 1 col no tocan sensor.gapMm
      // porque su gap físico depende del rollo específico del admin.
      if (presetGaps.columns === 2 && presetGaps.verticalGapMm > 0) {
        base.labels.sensor.gapMm = presetGaps.verticalGapMm;
      }
    }
  } else if (preset === LABEL_SIZE_PRESETS.CUSTOM) {
    base.labels.sizePreset = LABEL_SIZE_PRESETS.CUSTOM;
    // CUSTOM reinicia a defaults razonables si venía de un preset fijo
    // y el usuario no ha tocado las dimensiones. No sobrescribimos
    // marginLeftMm ni layout: pueden traer ajustes del admin.
    if (!LABEL_SIZE_DIMENSIONS[base.labels.sizePreset]) {
      // Ya era CUSTOM: no hacemos nada extra.
    }
  }
  // Pasamos por sanitize para que clampee contra el nuevo tamaño físico.
  return sanitizePrintingConfig(base);
}

/**
 * Mutador puro del formato de hoja/rollo de góndola. Idempotente.
 *
 *   - LETTER / LEGAL → impresión por diálogo del navegador (iframe).
 *   - THERMAL_80     → impresión directa por bridge (TSPL). Si la rama
 *     `gondola.thermal` falta, sanitize ya la inyectó con defaults; aquí
 *     sólo cambiamos el formato activo.
 *
 * Acepta alias en español/short-hand (`"CARTA"`, `"OFICIO"`, `"TERMICA_80"`,
 * `"RT80"`, etc.) vía el mapa compartido `GONDOLA_FORMAT_ALIASES`.
 *
 * No muta `connection`, `receipt`, `labels`, `drawer`. Cualquier valor
 * desconocido deja la config intacta (sanitize ya aplicó el default
 * cuando se cargó).
 *
 * @param {unknown} config
 * @param {"LETTER"|"LEGAL"|"THERMAL_80"|string} format
 * @returns {object}
 */
export function applyGondolaFormatPreset(config, format) {
  const base = sanitizePrintingConfig(config);
  const normalized = normalizeGondolaFormat(format);
  if (normalized) {
    base.gondola.format = normalized;
  }
  return sanitizePrintingConfig(base);
}

/**
 * Mutador puro de los campos térmicos de la rama `gondola.thermal`.
 * Hace un merge superficial sobre la rama actual y pasa el resultado por
 * `sanitizeGondolaThermal` para que todos los campos queden dentro de
 * bounds. NO cambia `gondola.format` (eso vive en `applyGondolaFormatPreset`).
 *
 * @param {unknown} config
 * @param {Partial<import("./printing-config.d.mts").GondolaThermalConfig>} patch
 * @returns {object}
 */
export function setGondolaThermalParams(config, patch) {
  const base = sanitizePrintingConfig(config);
  const current = base.gondola.thermal || DEFAULT_GONDOLA_THERMAL_CONFIG;
  const merged = patch && typeof patch === "object" && !Array.isArray(patch)
    ? { ...current, ...patch }
    : { ...current };
  base.gondola.thermal = sanitizeGondolaThermal(merged);
  return sanitizePrintingConfig(base);
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
      base.receipt.printableWidthMm = 48;
      base.receipt.columns = PAPER_COLUMNS["58"];
    } else if (Math.round(roll) === 80) {
      base.receipt.paper = PAPER_PRESETS.WIDTH_80;
      base.receipt.widthMm = 80;
      base.receipt.printableWidthMm = 76;
      base.receipt.columns = PAPER_COLUMNS["80"];
    } else if (Math.round(roll) === 82) {
      // Rollo 82mm → Jaltech JAL-838L (único preset conocido con ese ancho).
      base.receipt.paper = PAPER_PRESETS.JAL_838L;
      base.receipt.widthMm = JALTECH_JAL_838L_SPEC.physicalWidthMm;
      base.receipt.printableWidthMm = JALTECH_JAL_838L_SPEC.printableWidthMm;
      base.receipt.columns = JALTECH_JAL_838L_SPEC.columns;
    } else {
      base.receipt.paper = PAPER_PRESETS.CUSTOM;
      base.receipt.widthMm = clampInt(roll, BOUNDS.receiptWidthMm.min, BOUNDS.receiptWidthMm.max, base.receipt.widthMm);
      base.receipt.printableWidthMm = base.receipt.widthMm;
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
  // JAL_838L es un rollo de 82mm físico — tipográficamente se trata como la
  // familia 80mm (48 columnas). El ancho físico exacto viaja en widthMm.
  if (c.receipt.paper === PAPER_PRESETS.JAL_838L) return "80mm";
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

// -----------------------------------------------------------------------------
// Label-view helpers (consumo por el bridge payload de etiquetas)
// -----------------------------------------------------------------------------

/**
 * Conversión canónica mm → dots para la cabeza térmica. 203dpi es el
 * default; algunos modelos premium usan 300dpi. Puro, sin side-effects:
 * tanto frontend como backend pueden importarlo del mismo .mjs sin
 * duplicar la fórmula.
 *
 * @param {number} mm   Longitud física en mm.
 * @param {number} [dpi] Resolución efectiva. Default 203.
 * @returns {number}    Cantidad de dots redondeada al entero más cercano.
 */
export function mmToDots(mm, dpi = DEFAULT_DPI) {
  const value = Number(mm);
  const resolution = Number(dpi);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(resolution) || resolution <= 0) return Math.round(value * DEFAULT_DPI / 25.4);
  return Math.round(value * resolution / 25.4);
}

/**
 * Cambia el `activeMode` sin tocar otros campos de la config. Idempotente.
 *
 * @param {unknown} config
 * @param {"RECEIPT"|"LABEL"} mode
 * @returns {object}
 */
export function setActiveMode(config, mode) {
  const base = sanitizePrintingConfig(config);
  if (mode === ACTIVE_MODES.RECEIPT || mode === ACTIVE_MODES.LABEL) {
    base.activeMode = mode;
  }
  return sanitizePrintingConfig(base);
}

/**
 * Construye el "payload de bridge" canónico derivado de la config: lo que
 * se adjunta a cada operación térmica/etiqueta/cajón para que el bridge
 * no tenga que leer LocalStorage por su cuenta.
 *
 * @param {unknown} config
 * @param {{ openDrawerOnSale?: boolean }} [overrides]
 * @returns {{
 *   activeMode: "RECEIPT"|"LABEL";
 *   connection: object;
 *   receipt: object;
 *   labels: object;
 *   drawer: object;
 *   openDrawerOnSale: boolean;
 * }}
 */
export function buildBridgeConfigPayload(config, overrides) {
  const c = sanitizePrintingConfig(config);
  const openDrawerOnSale = overrides && typeof overrides.openDrawerOnSale === "boolean"
    ? overrides.openDrawerOnSale
    : !!c.drawer.openDrawerOnSale;
  return {
    activeMode: c.activeMode,
    connection: c.connection,
    receipt: c.receipt,
    labels: c.labels,
    drawer: c.drawer,
    openDrawerOnSale,
  };
}

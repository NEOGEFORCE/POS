// Declaraciones TS para src/lib/printing-config.mjs.
// El módulo real es puro JS para que pueda correrse con `node --test`.

export const PRINTING_CONFIG_VERSION: 1;
export const PRINTING_CONFIG_STORAGE_KEY: "pos_printing_config_v1";
export const LEGACY_STORAGE_KEYS: readonly string[];
export const DEFAULT_DRAWER_COMMAND: string;
export const DEFAULT_DPI: 203;

export type PrinterInterface = "USB" | "NETWORK" | "SYSTEM";
export type PrinterProtocol = "escpos" | "tspl" | "zpl" | "system" | "pdf";
export type PrinterSpooler = "WINDOWS" | "CUPS";
export type DrawerEvent = "BEFORE_PRINT" | "AFTER_PRINT" | "MANUAL";
export type CutMode = "AUTO" | "MANUAL" | "NONE";
export type ReceiptDeliveryMode = "bridge" | "browser";
export type PaperPreset = "80" | "58" | "JAL_838L" | "CUSTOM";
export type ActiveMode = "RECEIPT" | "LABEL";
export type GondolaFormat = "LETTER" | "LEGAL" | "THERMAL_80";
export type LabelSizePreset =
  | "50x30"
  | "40x30"
  | "30x20"
  | "30x20-2col"
  | "58x40"
  | "76x50"
  | "CUSTOM";
export type SensorType = "GAP" | "BLACK_MARK";
export type BarcodeSymbology = "EAN13" | "CODE128" | "CODE39";
export type JaltechJAL838LConnectionMode = "NETWORK" | "SYSTEM";
export type BarcodeRotation = 0 | 90 | 180 | 270;

export const INTERFACES: Readonly<Record<"USB" | "NETWORK" | "SYSTEM", PrinterInterface>>;
export const PROTOCOLS: Readonly<Record<"ESCPOS" | "TSPL" | "ZPL" | "SYSTEM" | "PDF", PrinterProtocol>>;
export const INTERFACE_PROTOCOLS: Readonly<Record<PrinterInterface, readonly PrinterProtocol[]>>;
export const SPOOLERS: Readonly<Record<"WINDOWS" | "CUPS", PrinterSpooler>>;
export const DRAWER_EVENTS: Readonly<Record<"BEFORE_PRINT" | "AFTER_PRINT" | "MANUAL", DrawerEvent>>;
export const CUT_MODES: Readonly<Record<"AUTO" | "MANUAL" | "NONE", CutMode>>;
export const RECEIPT_DELIVERY_MODES: Readonly<Record<"BRIDGE" | "BROWSER", ReceiptDeliveryMode>>;
export const GONDOLA_FORMATS: Readonly<Record<"LETTER" | "LEGAL" | "THERMAL_80", GondolaFormat>>;
export const DEFAULT_GONDOLA_FORMAT: "LETTER";
export const PAPER_PRESETS: Readonly<{ WIDTH_80: "80"; WIDTH_58: "58"; JAL_838L: "JAL_838L"; CUSTOM: "CUSTOM" }>;
export const PAPER_COLUMNS: Readonly<Record<"80" | "58" | "82", number>>;
export const ACTIVE_MODES: Readonly<Record<"RECEIPT" | "LABEL", ActiveMode>>;
export const LABEL_SIZE_PRESETS: Readonly<{
  "50X30": "50x30";
  "40X30": "40x30";
  "30X20": "30x20";
  "30X20_2COL": "30x20-2col";
  "58X40": "58x40";
  "76X50": "76x50";
  CUSTOM: "CUSTOM";
}>;
export const LABEL_SIZE_DIMENSIONS: Readonly<Record<
  "50x30" | "40x30" | "30x20" | "30x20-2col" | "58x40" | "76x50",
  { widthMm: number; heightMm: number }
>>;
export const LABEL_SIZE_PRESET_DEFAULTS: Readonly<Record<
  "50x30" | "40x30" | "30x20" | "30x20-2col" | "58x40" | "76x50",
  { columns: number; horizontalGapMm: number; verticalGapMm: number }
>>;
export const LABEL_SIZE_50X30_GAPS: readonly [2, 3];
export const SENSOR_TYPES: Readonly<Record<"GAP" | "BLACK_MARK", SensorType>>;
export const BARCODE_SYMBOLOGIES: Readonly<Record<"EAN13" | "CODE128" | "CODE39", BarcodeSymbology>>;
export const BARCODE_ROTATIONS: readonly [0, 90, 180, 270];
export const TSPL_BUILTIN_FONTS: readonly ["1", "2", "3", "4", "5", "6", "7", "8"];
export const PHYSICAL_MAX_MM: 82;
export const JAL_838L_CONNECTION_MODES: Readonly<Record<"NETWORK" | "SYSTEM", JaltechJAL838LConnectionMode>>;

export interface JaltechJAL838LSpec {
  readonly brand: "Jaltech";
  readonly model: "JAL-838L";
  readonly defaultAlias: string;
  readonly physicalWidthMm: 82;
  readonly printableWidthMm: 76;
  readonly columns: 48;
  readonly cut: "MANUAL";
  readonly networkPort: 9100;
  readonly defaultHost: "";
  readonly defaultPrinterName: "";
}
export const JALTECH_JAL_838L_SPEC: Readonly<JaltechJAL838LSpec>;

export interface Bounds {
  port: { min: number; max: number };
  receiptWidthMm: { min: number; max: number };
  printableWidthMm: { min: number; max: number };
  receiptColumns: { min: number; max: number };
  labelWidthMm: { min: number; max: number };
  labelHeightMm: { min: number; max: number };
  labelColumns: { min: number; max: number };
  horizontalGapMm: { min: number; max: number };
  verticalGapMm: { min: number; max: number };
  marginLeftMm: { min: number; max: number };
  sensorGapMm: { min: number; max: number };
  productNameFontPt: { min: number; max: number };
  productNameMaxChars: { min: number; max: number };
  priceFontPt: { min: number; max: number };
  barcodeHeightMm: { min: number; max: number };
  dpi: { min: number; max: number };
  layoutPosMm: { min: number; max: number };
  layoutFontScale: { min: number; max: number };
  barcodeModule: { min: number; max: number };
  gondolaThermalWidthMm: { min: number; max: number };
  gondolaThermalPrintableWidthMm: { min: number; max: number };
  gondolaThermalHeightMm: { min: number; max: number };
  gondolaThermalMarginMm: { min: number; max: number };
  gondolaThermalGapMm: { min: number; max: number };
  gondolaThermalDensity: { min: number; max: number };
  gondolaThermalNameMaxChars: { min: number; max: number };
  gondolaThermalScale: { min: number; max: number };
  gondolaThermalBarcodeHeightMm: { min: number; max: number };
  gondolaThermalUnitLabelMaxChars: { min: number; max: number };
  maxStringLength: number;
}
export const BOUNDS: Readonly<Bounds>;

export interface PrintingConnectionUSB {
  vendorId: number;
  productId: number;
  devicePath: string;
}

export interface PrintingConnectionNetwork {
  host: string;
  port: number;
}

export interface PrintingConnectionSystem {
  printerName: string;
  spooler: PrinterSpooler;
}

export interface PrintingConnection {
  alias: string;
  interface: PrinterInterface;
  protocol: PrinterProtocol;
  usb: PrintingConnectionUSB;
  network: PrintingConnectionNetwork;
  system: PrintingConnectionSystem;
}

export interface PrintingDrawer {
  enabled: boolean;
  command: string;
  event: DrawerEvent;
  /**
   * Flag específico: abrir cajón automáticamente tras una venta exitosa.
   * El flujo UI usa un kick audit-first separado como única ruta física,
   * incluso sin autoimpresión. `event` ordena BEFORE/AFTER y MANUAL excluye
   * cualquier automatismo. Reimpresión, etiquetas y toggle no lo disparan.
   */
  openDrawerOnSale: boolean;
}

export interface PrintingReceiptHeader {
  businessName: string;
  nit: string;
  address: string;
  phone: string;
  resolution: string;
}

export interface PrintingReceiptFooter {
  thankYou: string;
}

export interface PrintingReceiptContent {
  showLogo: boolean;
  showTaxes: boolean;
  showValidationQR: boolean;
}

export interface PrintingReceipt {
  paper: PaperPreset;
  widthMm: number;
  /**
   * Ancho imprimible real en mm. SIEMPRE menor o igual al `widthMm` físico.
   * Defaults por preset (actualizados 2026-10):
   *   - WIDTH_80  → 76 mm imprimibles (4 mm de margen físico muerto).
   *   - WIDTH_58  → 48 mm imprimibles (10 mm de margen físico muerto).
   *   - JAL_838L  → 76 mm (parte de la especificación del modelo).
   *   - CUSTOM    → `widthMm` por defecto.
   * Instalaciones que ya guardaron `printableWidthMm` explícito en
   * LocalStorage preservan su valor.
   */
  printableWidthMm: number;
  columns: number;
  header: PrintingReceiptHeader;
  footer: PrintingReceiptFooter;
  content: PrintingReceiptContent;
  cut: CutMode;
  deliveryMode: ReceiptDeliveryMode;
}

export interface PrintingLabelSensor {
  type: SensorType;
  gapMm: number;
}

export interface PrintingLabelProductName {
  visible: boolean;
  fontPt: number;
  maxChars: number;
}

export interface PrintingLabelPrice {
  visible: boolean;
  emphasized: boolean;
  fontPt: number;
}

export interface PrintingLabelBarcode {
  symbology: BarcodeSymbology;
  heightMm: number;
  humanReadable: boolean;
  narrow: number;
  wide: number;
  rotation: BarcodeRotation;
}

export type TsplBuiltinFontId = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";

export interface PrintingLabelLayoutBlock {
  xMm: number;
  yMm: number;
  fontScale: number;
  /**
   * Fuente TSPL built-in para el bloque. Sólo aplica a `name` y `price`;
   * el bloque `barcode` lo omite porque su tipografía viene de la
   * simbología + narrow/wide del propio código.
   */
  font?: TsplBuiltinFontId;
}

export interface PrintingLabelLayout {
  name: PrintingLabelLayoutBlock;
  price: PrintingLabelLayoutBlock;
  barcode: PrintingLabelLayoutBlock;
}

export interface PrintingLabelExtras {
  showDate: boolean;
  showInternalCode: boolean;
  showCategory: boolean;
}

export interface PrintingLabels {
  sizePreset: LabelSizePreset;
  widthMm: number;
  heightMm: number;
  columns: number;
  horizontalGapMm: number;
  verticalGapMm: number;
  marginLeftMm: number;
  dpi: number;
  sensor: PrintingLabelSensor;
  productName: PrintingLabelProductName;
  price: PrintingLabelPrice;
  barcode: PrintingLabelBarcode;
  layout: PrintingLabelLayout;
  extras: PrintingLabelExtras;
}

/**
 * Configuración térmica de la rama góndola. Se aplica cuando
 * `gondola.format === "THERMAL_80"`. Los campos están saneados: todos
 * los numéricos están dentro de `BOUNDS.gondolaThermal*`, las fuentes
 * pertenecen a `TSPL_BUILTIN_FONTS` y los booleanos son estrictos.
 *
 * Semántica física (unidades en mm donde aplica):
 *   - `widthMm`           Ancho físico del rollo (20..82).
 *   - `printableWidthMm`  Ancho útil ≤ `widthMm` (10..82).
 *   - `heightMm`          Alto de cada etiqueta (20..200).
 *   - `marginLeftMm/top/bottom` Márgenes seguros (0..20).
 *   - `gapMm`             Separación entre etiquetas (0..10). 0 =
 *     continuo. El bridge emite `GAP {gapMm} mm, 0 mm`.
 *   - `direction`/`mirror` Comando `DIRECTION x,y` de TSPL. 0 = por
 *     defecto; 1 = invertido/espejado.
 *   - `density`           Comando `DENSITY` (0..15).
 *   - `dpi`               Resolución de la cabeza (72..600). Default 203.
 *   - `nameFont`/`priceFont`/`footerFont` IDs TSPL `"1".."8"`.
 *   - `*ScaleX`/`*ScaleY` Escala de la fuente (1..10).
 *   - `nameMaxChars`      Trunca el nombre antes de medir (1..60).
 *   - `showBarcode`       Imprime CODE128 abajo a la izquierda cuando el
 *                         código es ASCII seguro. Default `true`.
 *   - `barcodeHeightMm`   Alto nominal del barcode (3..30). El renderer
 *                         lo acota al área libre.
 *   - `showUnitLabel`     Pinta el literal corto bajo el precio.
 *   - `unitLabel`         Texto del literal (ej. "PRECIO UND", "x LT").
 *                         Máx. 24 chars. Default "PRECIO UND".
 *   - `showCode`/`showDate` Toggles del pie (PLU + fecha).
 */
export interface GondolaThermalConfig {
  widthMm: number;
  printableWidthMm: number;
  heightMm: number;
  marginLeftMm: number;
  marginTopMm: number;
  marginBottomMm: number;
  gapMm: number;
  direction: 0 | 1;
  mirror: 0 | 1;
  density: number;
  dpi: number;
  nameFont: TsplBuiltinFontId;
  nameScaleX: number;
  nameScaleY: number;
  nameMaxChars: number;
  priceFont: TsplBuiltinFontId;
  priceScaleX: number;
  priceScaleY: number;
  showCode: boolean;
  showDate: boolean;
  /** Imprime CODE128 cuando el código del producto es ASCII seguro. */
  showBarcode: boolean;
  /** Alto nominal del barcode en mm (3..30). */
  barcodeHeightMm: number;
  /** Pinta el literal corto `unitLabel` bajo el precio. */
  showUnitLabel: boolean;
  /** Texto del literal unitario ("PRECIO UND" por defecto). */
  unitLabel: string;
  footerFont: TsplBuiltinFontId;
  footerScaleX: number;
  footerScaleY: number;
}

export const DEFAULT_GONDOLA_THERMAL_CONFIG: Readonly<GondolaThermalConfig>;

/**
 * Rama góndola: configuración persistida para precios de góndola.
 *
 * Formatos soportados:
 *   - LETTER / LEGAL  → impresión por diálogo del navegador (iframe).
 *     La geometría exacta (hoja, grid, padding) vive en `shelf-labels.mjs`
 *     para no duplicar números físicos aquí.
 *   - THERMAL_80      → impresión directa por bridge TSPL. Los parámetros
 *     térmicos editables viven en `thermal`.
 *
 * `thermal` está presente en todas las instalaciones tras sanitize (BC
 * con localStorage legacy sin la rama). Si el formato activo es LETTER
 * o LEGAL, el campo se conserva pero no se consume.
 */
export interface PrintingGondola {
  format: GondolaFormat;
  thermal: GondolaThermalConfig;
}

export interface PrintingConfig {
  version: 1;
  updatedAt: string | null;
  source: string;
  activeMode: ActiveMode;
  connection: PrintingConnection;
  drawer: PrintingDrawer;
  receipt: PrintingReceipt;
  labels: PrintingLabels;
  gondola: PrintingGondola;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function createDefaultPrintingConfig(): PrintingConfig;
export function sanitizePrintingConfig(input: unknown): PrintingConfig;
export function migratePrintingConfig(input: unknown): PrintingConfig;
export function validatePrintingConfig(config: unknown): ValidationResult;
export function applyReceiptPaperPreset(config: unknown, preset: PaperPreset): PrintingConfig;
export function applyLabelSizePreset(config: unknown, preset: LabelSizePreset): PrintingConfig;

/**
 * Aplica el preset físico Jaltech JAL-838L + una variante de conexión.
 *
 *   - mode="NETWORK": interfaz NETWORK + protocolo escpos + puerto 9100.
 *     PRESERVA el `host` existente (nunca inventa un IP).
 *   - mode="SYSTEM":  interfaz SYSTEM + protocolo system + spooler WINDOWS.
 *     PRESERVA el `printerName` existente (nunca inventa un nombre).
 *
 * Siempre fija `receipt.widthMm=82`, `receipt.printableWidthMm=76`,
 * `receipt.columns=48` y `receipt.cut="MANUAL"` como parte de la
 * especificación del modelo. El alias sólo cambia si el admin no lo había
 * personalizado antes.
 */
export function applyJaltechJAL838LPreset(
  config: unknown,
  options?: { mode?: JaltechJAL838LConnectionMode },
): PrintingConfig;

/**
 * Mutador puro del formato de hoja/rollo de góndola. Idempotente.
 *
 *   - LETTER / LEGAL → impresión por diálogo del navegador (iframe).
 *   - THERMAL_80     → impresión directa por bridge TSPL (sin iframe).
 *
 * Acepta alias en español/short-hand: "CARTA", "OFICIO", "TERMICA_80",
 * "TÉRMICA 80", "RT80", etc. Un valor desconocido deja la rama intacta
 * (sanitize ya aplicó el default cuando se cargó).
 */
export function applyGondolaFormatPreset(
  config: unknown,
  format: GondolaFormat | string,
): PrintingConfig;

/**
 * Mutador puro de los campos térmicos de la rama `gondola.thermal`.
 * Hace merge superficial sobre la rama actual y pasa el resultado por
 * `sanitizeGondolaThermal` (clamp dentro de bounds). NO cambia
 * `gondola.format`. Idempotente.
 */
export function setGondolaThermalParams(
  config: unknown,
  patch: Partial<GondolaThermalConfig>,
): PrintingConfig;

/**
 * Sanea un objeto parcial para que respete `GondolaThermalConfig`. Nunca
 * lanza; cualquier campo fuera de bounds se clampea; fuentes desconocidas
 * caen al default.
 */
export function sanitizeGondolaThermal(input: unknown): GondolaThermalConfig;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadPrintingConfig(storage?: StorageLike | null): PrintingConfig;
export function savePrintingConfig(config: unknown, storage?: StorageLike | null): PrintingConfig;
export function clearPrintingConfig(storage?: StorageLike | null): void;

export interface PrinterProfilePayload {
  name: string;
  protocol: string;
  target: string;
  model?: string;
  drawerConnected: boolean;
  isDefault: boolean;
  rollWidthMm?: number;
}

export function projectConfigToPrinterProfile(config: unknown): PrinterProfilePayload;
export function importConfigFromPrinterProfile(profile: unknown, baseConfig?: unknown): PrintingConfig;

export interface SizeTemplatePayload {
  name: string;
  widthMm: number;
  heightMm: number;
  marginMm: number;
  columnsCount: number;
  dpi: number;
  barcodeFormat: BarcodeSymbology;
  showName: boolean;
  showPrice: boolean;
  isDefault: boolean;
}
export function projectConfigToSizeTemplate(config: unknown): SizeTemplatePayload;

export function receiptWidthKey(config: unknown): "58mm" | "80mm";
export function printingConfigsEqual(a: unknown, b: unknown): boolean;

/**
 * Conversión canónica mm → dots. Pure, sin side-effects.
 */
export function mmToDots(mm: number, dpi?: number): number;

/**
 * Mutador puro del `activeMode`. Idempotente.
 */
export function setActiveMode(config: unknown, mode: ActiveMode): PrintingConfig;

/**
 * Payload estructurado para el bridge, derivado íntegro de la config
 * sanitizada. Incluye activeMode + drawer + openDrawerOnSale para que el
 * bridge nunca tenga que leer LocalStorage.
 */
export interface BridgeConfigPayload {
  activeMode: ActiveMode;
  connection: PrintingConnection;
  receipt: PrintingReceipt;
  labels: PrintingLabels;
  drawer: PrintingDrawer;
  openDrawerOnSale: boolean;
}
export function buildBridgeConfigPayload(
  config: unknown,
  overrides?: { openDrawerOnSale?: boolean },
): BridgeConfigPayload;

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

export interface PrintingConfig {
  version: 1;
  updatedAt: string | null;
  source: string;
  activeMode: ActiveMode;
  connection: PrintingConnection;
  drawer: PrintingDrawer;
  receipt: PrintingReceipt;
  labels: PrintingLabels;
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

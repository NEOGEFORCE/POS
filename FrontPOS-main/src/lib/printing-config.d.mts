// Declaraciones TS para src/lib/printing-config.mjs.
// El módulo real es puro JS para que pueda correrse con `node --test`.

export const PRINTING_CONFIG_VERSION: 1;
export const PRINTING_CONFIG_STORAGE_KEY: "pos_printing_config_v1";
export const LEGACY_STORAGE_KEYS: readonly string[];
export const DEFAULT_DRAWER_COMMAND: string;

export type PrinterInterface = "USB" | "NETWORK" | "SYSTEM";
export type PrinterProtocol = "escpos" | "tspl" | "zpl" | "system" | "pdf";
export type PrinterSpooler = "WINDOWS" | "CUPS";
export type DrawerEvent = "BEFORE_PRINT" | "AFTER_PRINT" | "MANUAL";
export type CutMode = "AUTO" | "MANUAL" | "NONE";
export type PaperPreset = "80" | "58" | "CUSTOM";
export type LabelSizePreset = "50x30" | "40x30" | "30x20" | "CUSTOM";
export type SensorType = "GAP" | "BLACK_MARK";
export type BarcodeSymbology = "EAN13" | "CODE128" | "CODE39";

export const INTERFACES: Readonly<Record<"USB" | "NETWORK" | "SYSTEM", PrinterInterface>>;
export const PROTOCOLS: Readonly<Record<"ESCPOS" | "TSPL" | "ZPL" | "SYSTEM" | "PDF", PrinterProtocol>>;
export const INTERFACE_PROTOCOLS: Readonly<Record<PrinterInterface, readonly PrinterProtocol[]>>;
export const SPOOLERS: Readonly<Record<"WINDOWS" | "CUPS", PrinterSpooler>>;
export const DRAWER_EVENTS: Readonly<Record<"BEFORE_PRINT" | "AFTER_PRINT" | "MANUAL", DrawerEvent>>;
export const CUT_MODES: Readonly<Record<"AUTO" | "MANUAL" | "NONE", CutMode>>;
export const PAPER_PRESETS: Readonly<{ WIDTH_80: "80"; WIDTH_58: "58"; CUSTOM: "CUSTOM" }>;
export const PAPER_COLUMNS: Readonly<Record<"80" | "58", number>>;
export const LABEL_SIZE_PRESETS: Readonly<{ "50X30": "50x30"; "40X30": "40x30"; "30X20": "30x20"; CUSTOM: "CUSTOM" }>;
export const LABEL_SIZE_DIMENSIONS: Readonly<Record<"50x30" | "40x30" | "30x20", { widthMm: number; heightMm: number }>>;
export const SENSOR_TYPES: Readonly<Record<"GAP" | "BLACK_MARK", SensorType>>;
export const BARCODE_SYMBOLOGIES: Readonly<Record<"EAN13" | "CODE128" | "CODE39", BarcodeSymbology>>;

export interface Bounds {
  port: { min: number; max: number };
  receiptWidthMm: { min: number; max: number };
  receiptColumns: { min: number; max: number };
  labelWidthMm: { min: number; max: number };
  labelHeightMm: { min: number; max: number };
  labelColumns: { min: number; max: number };
  horizontalGapMm: { min: number; max: number };
  sensorGapMm: { min: number; max: number };
  productNameFontPt: { min: number; max: number };
  productNameMaxChars: { min: number; max: number };
  priceFontPt: { min: number; max: number };
  barcodeHeightMm: { min: number; max: number };
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
  columns: number;
  header: PrintingReceiptHeader;
  footer: PrintingReceiptFooter;
  content: PrintingReceiptContent;
  cut: CutMode;
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
  sensor: PrintingLabelSensor;
  productName: PrintingLabelProductName;
  price: PrintingLabelPrice;
  barcode: PrintingLabelBarcode;
  extras: PrintingLabelExtras;
}

export interface PrintingConfig {
  version: 1;
  updatedAt: string | null;
  source: string;
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

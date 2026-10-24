// Declaraciones TS para src/lib/pos-bridge-printers.mjs.
// El modulo real es puro JS para que pueda correrse con `node --test`.

export type DetectedPrinterStatus =
  | "online"
  | "offline"
  | "paper-out"
  | "error"
  | "paused"
  | "unknown";

export interface DetectedPrinter {
  readonly name: string;
  readonly driver?: string;
  readonly port?: string;
  readonly status?: DetectedPrinterStatus;
  readonly online?: boolean;
  readonly isDefault?: boolean;
  readonly shared?: boolean;
  readonly jobs?: number;
  readonly attributes?: readonly string[];
}

export interface DetectedPrintersResult {
  readonly kind: "printer-list";
  readonly platform?: "win32" | "posix";
  readonly defaultName?: string;
  readonly printers: readonly DetectedPrinter[];
}

export const DETECTED_PRINTER_STATUSES: readonly DetectedPrinterStatus[];

export function parseDetectedPrintersResult(input: unknown): DetectedPrintersResult | null;

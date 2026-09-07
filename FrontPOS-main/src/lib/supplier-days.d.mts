export const WEEKDAYS_CANONICAL: readonly [
  'Lunes',
  'Martes',
  'Miercoles',
  'Jueves',
  'Viernes',
  'Sabado',
  'Domingo',
];

export type CanonicalWeekday =
  | 'Lunes'
  | 'Martes'
  | 'Miercoles'
  | 'Jueves'
  | 'Viernes'
  | 'Sabado'
  | 'Domingo';

export const WEEKDAY_DISPLAY: Readonly<Record<CanonicalWeekday, string>>;
export const WEEKDAY_SHORT: Readonly<Record<CanonicalWeekday, string>>;

export function normalizeDayName(raw: unknown): CanonicalWeekday | '';
export function isValidDayName(raw: unknown): boolean;

export type SupplierDaysInput =
  | { days?: unknown; csv?: unknown }
  | Array<unknown>
  | string
  | null
  | undefined;

export function parseSupplierDays(input: SupplierDaysInput): CanonicalWeekday[];
export function sanitizeDayList(days: unknown): CanonicalWeekday[];
export function toDisplayDays(days: readonly string[]): string[];
export function toShortDays(days: readonly string[]): string[];
export function toStorageCsv(days: readonly string[]): string;
export function toDisplayLabel(days: readonly string[]): string;
export function isSameDaySet(left: readonly string[], right: readonly string[]): boolean;

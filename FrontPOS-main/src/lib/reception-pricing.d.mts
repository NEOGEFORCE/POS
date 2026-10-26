export function sumTaxRate(
  ivaPct: number | string | null | undefined,
  icuiPct: number | string | null | undefined,
  ibuaPct: number | string | null | undefined,
): number;

export function grossToBasePrice(
  gross: number | string | null | undefined,
  ivaPct: number | string | null | undefined,
  icuiPct: number | string | null | undefined,
  ibuaPct: number | string | null | undefined,
): number;

export function calculateGrossCost(
  basePrice: number | string | null | undefined,
  ivaPct: number | string | null | undefined,
  icuiPct: number | string | null | undefined,
  ibuaPct: number | string | null | undefined,
): number;

export function calculateNetCost(
  basePrice: number | string | null | undefined,
  ivaPct: number | string | null | undefined,
  icuiPct: number | string | null | undefined,
  ibuaPct: number | string | null | undefined,
  discountPct: number | string | null | undefined,
): number;

export function calculateRawPVP(
  basePrice: number | string | null | undefined,
  ivaPct: number | string | null | undefined,
  icuiPct: number | string | null | undefined,
  ibuaPct: number | string | null | undefined,
  marginPct: number | string | null | undefined,
  discountPct?: number | string | null | undefined,
): number;

export function calculatePVP(
  basePrice: number | string | null | undefined,
  ivaPct: number | string | null | undefined,
  icuiPct: number | string | null | undefined,
  ibuaPct: number | string | null | undefined,
  marginPct: number | string | null | undefined,
  discountPct?: number | string | null | undefined,
): number;

export function resolveEffectivePercentage(
  preferredValue: number | string | null | undefined,
  productValue: number | string | null | undefined,
): number;

export function resolveBasePrice(
  baseValue: number | string | null | undefined,
  grossFallback: number | string | null | undefined,
  ivaPct: number | string | null | undefined,
  icuiPct: number | string | null | undefined,
  ibuaPct: number | string | null | undefined,
): number;

export function calculateMarginFromGross(
  grossPrice: number | string | null | undefined,
  salePrice: number | string | null | undefined,
  fallbackMargin?: number | string | null | undefined,
): number;

export function calculateProjectedWacGross(
  oldGrossPrice: number | string | null | undefined,
  oldStock: number | string | null | undefined,
  newBasePrice: number | string | null | undefined,
  effectiveQty: number | string | null | undefined,
  ivaPct: number | string | null | undefined,
  icuiPct: number | string | null | undefined,
  ibuaPct: number | string | null | undefined,
): number;

export function calculateProjectedPVP(
  oldGrossPrice: number | string | null | undefined,
  oldStock: number | string | null | undefined,
  newBasePrice: number | string | null | undefined,
  effectiveQty: number | string | null | undefined,
  ivaPct: number | string | null | undefined,
  icuiPct: number | string | null | undefined,
  ibuaPct: number | string | null | undefined,
  marginPct: number | string | null | undefined,
  discountPct?: number | string | null | undefined,
): number;

export interface SubtotalEditResult {
  isValid: boolean;
  basePrice: number;
  subtotal: number;
}

export function parseSubtotalEdit(
  text: string | null | undefined,
  effectiveQty: number | string | null | undefined,
): SubtotalEditResult;

export function unitMultiplier(unit: string | null | undefined): number;


export function resolveOrderBasePrice(
  orderCost: unknown,
  productGross: unknown,
  ivaPct: unknown,
  icuiPct: unknown,
  ibuaPct: unknown,
): number;

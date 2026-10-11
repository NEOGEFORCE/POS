export type ThermalWidth = "58mm" | "80mm";

export const CSS_PX_PER_INCH: 96;
export const MM_PER_INCH: 25.4;
export const MIN_THERMAL_PAGE_HEIGHT_MM: 40;
export const MAX_THERMAL_PAGE_HEIGHT_MM: 2000;
export const THERMAL_PAGE_SAFETY_MM: 2;

export function resolveThermalWidthMm(
    width: ThermalWidth,
    customWidthMm?: number,
): number;

export function cssPixelsToMm(px: number): number;

export function resolveThermalPageHeightMm(
    renderedHeightPx: number,
    safetyMm?: number,
): number;

export function buildThermalPageRule(widthMm: number, heightMm: number): string;

// Pure helpers for physical thermal-paper page sizing.
//
// CSS Paged Media does not accept a reliable one-dimensional declaration such
// as `size: 80mm auto`. Chromium ignores it and falls back to the destination's
// default (usually Letter), even though the ticket body itself remains 80 mm
// wide. A valid custom page needs TWO physical lengths: width and height.

export const CSS_PX_PER_INCH = 96;
export const MM_PER_INCH = 25.4;
export const MIN_THERMAL_PAGE_HEIGHT_MM = 40;
export const MAX_THERMAL_PAGE_HEIGHT_MM = 2000;
export const THERMAL_PAGE_SAFETY_MM = 2;

function finitePositive(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function roundMm(value, decimals = 2) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

/** Resolve the exact physical width selected in printing configuration. */
export function resolveThermalWidthMm(width, customWidthMm) {
    const custom = finitePositive(customWidthMm);
    if (custom != null) return roundMm(custom);
    return width === "80mm" ? 80 : 58;
}

/** Convert rendered CSS pixels to millimetres (CSS standard: 96 px/in). */
export function cssPixelsToMm(px) {
    const value = finitePositive(px);
    if (value == null) return 0;
    return value * MM_PER_INCH / CSS_PX_PER_INCH;
}

/**
 * Turn measured document height into a valid physical page height. A small
 * safety tail prevents the cutter/driver from clipping the last baseline.
 */
export function resolveThermalPageHeightMm(renderedHeightPx, safetyMm = THERMAL_PAGE_SAFETY_MM) {
    const measuredMm = cssPixelsToMm(renderedHeightPx);
    const safeTail = finitePositive(safetyMm) ?? 0;
    const bounded = Math.max(
        MIN_THERMAL_PAGE_HEIGHT_MM,
        Math.min(MAX_THERMAL_PAGE_HEIGHT_MM, measuredMm + safeTail),
    );
    // Round UP to 0.1 mm: never round content below its measured height.
    return Math.ceil(bounded * 10) / 10;
}

/** Build a standards-valid @page rule with two physical dimensions. */
export function buildThermalPageRule(widthMm, heightMm) {
    const width = finitePositive(widthMm) ?? 58;
    const height = finitePositive(heightMm) ?? MIN_THERMAL_PAGE_HEIGHT_MM;
    return `@page { size: ${roundMm(width)}mm ${roundMm(height, 1)}mm; margin: 0; }`;
}

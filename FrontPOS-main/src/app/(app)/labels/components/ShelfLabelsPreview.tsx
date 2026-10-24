"use client";

// =============================================================================
// src/app/(app)/labels/components/ShelfLabelsPreview.tsx
//
// Preview paginado en pantalla (NO impresión). Replica la grilla con las
// mismas dimensiones físicas y bordes dashed que el documento aislado, pero
// renderizando dentro del árbol React para que el admin pueda verificar antes
// de imprimir. Reutiliza los helpers puros de `@/lib/shelf-labels.mjs` para
// evitar que la métrica (mm) se duplique y se desvíe.
//
// La impresión real NUNCA pasa por este componente: el iframe aislado usa
// `buildShelfLabelsPrintHtml` directamente para no heredar nada del DOM.
//
// Formatos soportados:
//   - LETTER / LEGAL  → hoja landscape con grid NxM. Padding + bordes dashed.
//   - THERMAL_80      → rollo continuo. Pinta UNA sola etiqueta por slot
//     con el DISEÑO NUEVO (2026-10, referencia visual aprobada):
//         ┌────────────────────────────┐
//         │  NOMBRE PRODUCTO (máx 2L)  │   ← font bold, truncado por chars
//         ├────────────────────────────┤   ← separador fino
//         │                            │
//         │       $ XX.XXX             │   ← precio GRANDE centrado
//         │        PRECIO UND          │   ← literal corto (showUnitLabel)
//         │                            │
//         ├────────────────────────────┤   ← separador fino
//         │ |||||||||       PLU 12345  │   ← CODE128 izq + PLU derecha
//         └────────────────────────────┘
//     Honra los toggles `showBarcode`, `showUnitLabel`, `showCode`,
//     `showDate` de la rama `gondola.thermal`.
//
// `resolveGondolaLayout` entrega toda la geometría (dimensiones, grid,
// padding, cantidad de slots por página). Si viene vacío, cae a `LETTER`.
// =============================================================================

import { useMemo } from "react";

import {
    expandItemsToSlots,
    formatCOP,
    formatPrintDate,
    paginateSlots,
    resolveGondolaLayout,
    truncate,
} from "@/lib/shelf-labels.mjs";
import type { ShelfLabelItem, ShelfLabelSlot } from "@/lib/shelf-labels.d.mts";
import type {
    GondolaFormat,
    GondolaThermalConfig,
} from "@/lib/printing-config.d.mts";
import { DEFAULT_GONDOLA_THERMAL_CONFIG } from "@/lib/printing-config.mjs";

interface ShelfLabelsPreviewProps {
    items: ReadonlyArray<Partial<ShelfLabelItem>>;
    /** Escala visual. 0.5 = 50% del tamaño real; útil para pantallas chicas. */
    scale?: number;
    /** Fecha a pintar en el footer (por defecto, "ahora"). */
    now?: Date | string | number;
    /** Clase extra para el contenedor exterior. */
    className?: string;
    /** Formato de hoja activo. Default `LETTER` cuando no se provee. */
    format?: GondolaFormat;
    /**
     * Configuración térmica. Sólo se consume cuando `format === "THERMAL_80"`.
     * Si viene undefined se usa `DEFAULT_GONDOLA_THERMAL_CONFIG` para que el
     * preview siga pintando algo sensato (p.ej. desde el workspace, que no
     * necesita exponer todos los flags del admin).
     */
    thermal?: GondolaThermalConfig;
}

/**
 * Devuelve un objeto estilo con las propiedades mm → px escaladas. Mantiene
 * la unidad `mm` para que el navegador respete la proporción cuando se
 * imprime desde "Vista preliminar" directamente (aunque la impresión real
 * va por el iframe aislado).
 */
function mm(value: number, scale: number): string {
    return `${(value * scale).toFixed(3)}mm`;
}

export function ShelfLabelsPreview({
    items,
    scale = 0.5,
    now,
    className,
    format,
    thermal,
}: ShelfLabelsPreviewProps) {
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 0.5;

    const layout = useMemo(() => resolveGondolaLayout(format), [format]);
    // Thermal effectivo. Caer al default en vez de "undefined-safe property
    // access" por todo el render; mantiene el preview determinista.
    const effectiveThermal = thermal ?? DEFAULT_GONDOLA_THERMAL_CONFIG;

    const pages = useMemo(() => {
        const slots = expandItemsToSlots(items);
        return paginateSlots(slots, layout.format);
    }, [items, layout.format]);

    const dateLabel = useMemo(() => formatPrintDate(now), [now]);

    if (pages.length === 0) {
        return (
            <div
                className={className}
                role="status"
                aria-live="polite"
                data-gondola-format={layout.format}
            >
                <p className="text-[10px] uppercase tracking-widest text-zinc-500">
                    Agrega productos para ver la vista previa de la hoja.
                </p>
            </div>
        );
    }

    // THERMAL_80: una sola etiqueta 80×40 por slot. Sin hoja, sin grid, sin
    // padding físico. El preview es una lista vertical de cards: cada card
    // representa una etiqueta que viajaría al rollo. Mantener la métrica
    // mm × scale para que el admin pueda estimar el tamaño impreso.
    if (layout.format === "THERMAL_80") {
        const slots = pages.flat();
        // Para el preview respetamos las medidas CONFIGURADAS por el admin
        // (`thermal.widthMm`, `thermal.heightMm`), no las nominales 80×40
        // del formato — si el admin cambió el tamaño del rollo el preview
        // debe reflejarlo.
        const widthMm = effectiveThermal.widthMm;
        const heightMm = effectiveThermal.heightMm;
        return (
            <div
                className={className}
                role="group"
                aria-label={`Vista previa de ${slots.length} etiqueta(s) térmicas de góndola ${widthMm} × ${heightMm} mm. Rollo continuo.`}
                data-gondola-format={layout.format}
                data-gondola-layout={layout.layoutMetaId}
                data-testid="labels-shelf-preview-thermal"
            >
                <ul
                    className="flex flex-col gap-2"
                    style={{ listStyle: "none", padding: 0, margin: 0 }}
                >
                    {slots.map((slot, idx) => (
                        <li
                            key={idx}
                            className="mx-auto shadow-md ring-1 ring-zinc-200 dark:ring-white/10 bg-white"
                            style={{
                                boxSizing: "border-box",
                                borderRadius: 2,
                            }}
                            aria-label={`Etiqueta ${idx + 1} de ${slots.length}`}
                        >
                            <ThermalShelfSlotPreview
                                slot={slot}
                                dateLabel={dateLabel}
                                scale={safeScale}
                                thermal={effectiveThermal}
                                widthMm={widthMm}
                                heightMm={heightMm}
                            />
                        </li>
                    ))}
                </ul>
            </div>
        );
    }

    return (
        <div
            className={className}
            role="group"
            aria-label={`Vista previa de ${pages.length} hoja(s) de etiquetas de góndola en formato ${layout.label}, ${layout.labelsPerPage} etiquetas por hoja.`}
            data-gondola-format={layout.format}
            data-gondola-layout={layout.layoutMetaId}
        >
            {pages.map((page, pageIdx) => (
                <article
                    key={pageIdx}
                    className="mx-auto mb-4 shadow-md ring-1 ring-zinc-200 dark:ring-white/10 bg-white"
                    style={{
                        width: mm(layout.sheetWidthMm, safeScale),
                        height: mm(layout.sheetHeightMm, safeScale),
                        padding: `${mm(layout.paddingYMm, safeScale)} ${mm(layout.paddingXMm, safeScale)}`,
                        display: "grid",
                        gridTemplateColumns: `repeat(${layout.columns}, ${mm(layout.labelWidthMm, safeScale)})`,
                        gridTemplateRows: `repeat(${layout.rows}, ${mm(layout.labelHeightMm, safeScale)})`,
                        gap: 0,
                        boxSizing: "border-box",
                    }}
                    aria-label={`Hoja ${pageIdx + 1} de ${pages.length}`}
                >
                    {page.map((slot, slotIdx) => (
                        <SlotPreview
                            key={slotIdx}
                            slot={slot}
                            dateLabel={dateLabel}
                            scale={safeScale}
                            labelWidthMm={layout.labelWidthMm}
                            labelHeightMm={layout.labelHeightMm}
                        />
                    ))}
                </article>
            ))}
        </div>
    );
}

interface SlotPreviewProps {
    slot: ShelfLabelSlot | null;
    dateLabel: string;
    scale: number;
    labelWidthMm: number;
    labelHeightMm: number;
}

// -----------------------------------------------------------------------------
// Preview específico para THERMAL_80 — refleja el nuevo diseño 2026-10.
//
// Honra los toggles de la rama `gondola.thermal`:
//   - `showBarcode`     → simula CODE128 abajo a la izquierda.
//   - `showUnitLabel`   → literal corto bajo el precio.
//   - `unitLabel`       → texto del literal (ej. "PRECIO UND", "x LT").
//   - `showCode`        → PLU abajo a la derecha.
//   - `showDate`        → fecha de impresión alineada con PLU.
//   - `nameMaxChars`    → trunca el nombre antes del display.
//   - `barcodeHeightMm` → alto del barcode simulado en mm (escalado).
// -----------------------------------------------------------------------------
interface ThermalShelfSlotPreviewProps {
    slot: ShelfLabelSlot | null;
    dateLabel: string;
    scale: number;
    thermal: GondolaThermalConfig;
    widthMm: number;
    heightMm: number;
}

function ThermalShelfSlotPreview({
    slot,
    dateLabel,
    scale,
    thermal,
    widthMm,
    heightMm,
}: ThermalShelfSlotPreviewProps) {
    const width = `${(widthMm * scale).toFixed(3)}mm`;
    const height = `${(heightMm * scale).toFixed(3)}mm`;
    const paddingH = `${(thermal.marginLeftMm * scale).toFixed(3)}mm`;
    const paddingV = `${(thermal.marginTopMm * scale).toFixed(3)}mm`;
    const paddingBottom = `${(thermal.marginBottomMm * scale).toFixed(3)}mm`;
    const barcodeHeight = `${(thermal.barcodeHeightMm * scale).toFixed(3)}mm`;

    const containerStyle: React.CSSProperties = {
        width,
        height,
        paddingTop: paddingV,
        paddingBottom,
        paddingLeft: paddingH,
        paddingRight: paddingH,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-start",
        overflow: "hidden",
        color: "#000",
        boxSizing: "border-box",
        fontFamily: "'Helvetica Neue', Arial, Helvetica, sans-serif",
    };

    if (!slot) {
        return <div style={containerStyle} aria-hidden="true" />;
    }

    // Preview truncado por `nameMaxChars` del admin — refleja el truncado
    // que hace el renderer TSPL antes de medir glifos.
    const nameText = truncate(slot.productName, Math.max(1, thermal.nameMaxChars));
    const price = formatCOP(slot.salePrice);
    const unitLabel = (thermal.unitLabel || "PRECIO UND").toUpperCase();
    const code = slot.code || "";
    const dateVisible = thermal.showDate && dateLabel.length > 0;

    // Escalas tipográficas en pt. La relación es coherente con la referencia
    // visual: nombre 10pt, precio 24pt (dominante), unit 7pt, PLU 7.5pt.
    const nameFontSize = `${(10 * scale).toFixed(2)}pt`;
    const priceFontSize = `${(24 * scale).toFixed(2)}pt`;
    const unitFontSize = `${(7 * scale).toFixed(2)}pt`;
    const pluFontSize = `${(7.5 * scale).toFixed(2)}pt`;

    return (
        <div
            style={containerStyle}
            data-testid="labels-shelf-preview-thermal-slot"
            data-shelf-show-barcode={thermal.showBarcode ? "true" : "false"}
            data-shelf-show-unit={thermal.showUnitLabel ? "true" : "false"}
            data-shelf-show-code={thermal.showCode ? "true" : "false"}
            data-shelf-show-date={thermal.showDate ? "true" : "false"}
        >
            {/* NOMBRE (máx 2 líneas) */}
            <div
                style={{
                    fontSize: nameFontSize,
                    fontWeight: 700,
                    lineHeight: 1.1,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    wordBreak: "break-word",
                    maxHeight: "2.4em",
                    textAlign: "center",
                    textTransform: "uppercase",
                }}
            >
                {nameText}
            </div>

            {/* SEPARADOR fino */}
            <div
                aria-hidden="true"
                style={{
                    marginTop: `${(0.8 * scale).toFixed(3)}mm`,
                    marginBottom: `${(0.8 * scale).toFixed(3)}mm`,
                    height: Math.max(1, Math.round(0.4 * scale * 10) / 10),
                    background: "#000",
                    opacity: 0.6,
                }}
            />

            {/* PRECIO GRANDE centrado */}
            <div
                style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    alignItems: "center",
                    gap: `${(0.4 * scale).toFixed(3)}mm`,
                }}
            >
                <div
                    style={{
                        fontSize: priceFontSize,
                        fontWeight: 900,
                        letterSpacing: "-0.5px",
                        lineHeight: 1,
                        textAlign: "center",
                    }}
                >
                    {price}
                </div>
                {thermal.showUnitLabel && unitLabel.length > 0 && (
                    <div
                        style={{
                            fontSize: unitFontSize,
                            fontWeight: 700,
                            letterSpacing: "0.15em",
                            textTransform: "uppercase",
                            opacity: 0.75,
                        }}
                    >
                        {truncate(unitLabel, 24)}
                    </div>
                )}
            </div>

            {/* PIE: barcode izq. + PLU/fecha der. */}
            {(thermal.showBarcode || thermal.showCode || dateVisible) && (
                <div
                    aria-hidden="true"
                    style={{
                        marginTop: `${(0.5 * scale).toFixed(3)}mm`,
                        marginBottom: `${(0.4 * scale).toFixed(3)}mm`,
                        height: Math.max(1, Math.round(0.3 * scale * 10) / 10),
                        background: "#000",
                        opacity: 0.4,
                    }}
                />
            )}
            {(thermal.showBarcode || thermal.showCode || dateVisible) && (
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-end",
                        gap: `${(1.5 * scale).toFixed(3)}mm`,
                        minWidth: 0,
                    }}
                >
                    {thermal.showBarcode && code ? (
                        <BarcodeStripe height={barcodeHeight} />
                    ) : (
                        <span style={{ width: 0 }} />
                    )}
                    <div
                        style={{
                            fontSize: pluFontSize,
                            fontWeight: 700,
                            textAlign: "right",
                            lineHeight: 1.1,
                            fontFamily: "'Courier New', Consolas, monospace",
                            minWidth: 0,
                        }}
                    >
                        {thermal.showCode && code && (
                            <div
                                style={{
                                    overflow: "hidden",
                                    whiteSpace: "nowrap",
                                    textOverflow: "ellipsis",
                                    maxWidth: `${(widthMm * 0.5 * scale).toFixed(3)}mm`,
                                }}
                            >
                                {truncate(code, 18)}
                            </div>
                        )}
                        {dateVisible && (
                            <div
                                style={{
                                    opacity: 0.65,
                                    fontSize: `${(6.5 * scale).toFixed(2)}pt`,
                                }}
                            >
                                {dateLabel}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Franja de barras simuladas (no un barcode real). Es puramente visual:
 * la impresión real emite `BARCODE "128",...` desde el bridge, con el
 * código ASCII seguro ya validado. Acá sólo transmitimos la IDEA de
 * "aquí va un CODE128 abajo a la izquierda".
 */
function BarcodeStripe({ height }: { height: string }) {
    const bars = [1, 2, 1, 1, 2, 1, 3, 1, 2, 1, 1, 2, 1, 3, 1, 1, 2, 1, 2, 1];
    return (
        <div
            style={{
                display: "flex",
                alignItems: "stretch",
                gap: 0,
                height,
                minWidth: 0,
            }}
            aria-label="Representación visual del barcode CODE128"
        >
            {bars.map((w, i) => (
                <span
                    key={i}
                    style={{
                        width: `${w}px`,
                        background: i % 2 === 0 ? "#000" : "transparent",
                    }}
                />
            ))}
        </div>
    );
}

function SlotPreview({
    slot,
    dateLabel,
    scale,
    labelWidthMm,
    labelHeightMm,
}: SlotPreviewProps) {
    const style: React.CSSProperties = {
        width: `${(labelWidthMm * scale).toFixed(3)}mm`,
        height: `${(labelHeightMm * scale).toFixed(3)}mm`,
        border: `${Math.max(0.5, 0.2 * scale)}px dashed #c4c4c4`,
        padding: `${(2.5 * scale).toFixed(3)}mm ${(3 * scale).toFixed(3)}mm`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        overflow: "hidden",
        color: "#000",
        boxSizing: "border-box",
        fontFamily: "'Helvetica Neue', Arial, Helvetica, sans-serif",
    };

    if (!slot) {
        return <div style={style} aria-hidden="true" />;
    }

    const price = formatCOP(slot.salePrice);
    const footerLeft = truncate(slot.sku ? slot.sku : slot.code || "", 20);
    const footerRight = `${truncate(slot.unit || "UND", 10)} · ${dateLabel}`;
    const nameFontSize = `${(11 * scale).toFixed(2)}pt`;
    const priceFontSize = `${(26 * scale).toFixed(2)}pt`;
    const footerFontSize = `${(7.5 * scale).toFixed(2)}pt`;

    return (
        <div style={style}>
            <div
                style={{
                    fontSize: nameFontSize,
                    fontWeight: 700,
                    lineHeight: 1.1,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    wordBreak: "break-word",
                    maxHeight: "2.6em",
                }}
            >
                {truncate(slot.productName, 64)}
            </div>
            <div
                style={{
                    fontSize: priceFontSize,
                    fontWeight: 900,
                    textAlign: "center",
                    lineHeight: 1,
                    letterSpacing: "-0.5px",
                }}
            >
                {price}
            </div>
            <div
                style={{
                    fontSize: footerFontSize,
                    fontWeight: 600,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: `${(2 * scale).toFixed(3)}mm`,
                }}
            >
                <span style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", minWidth: 0 }}>
                    {footerLeft}
                </span>
                <span style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", minWidth: 0, textAlign: "right" }}>
                    {footerRight}
                </span>
            </div>
        </div>
    );
}

export default ShelfLabelsPreview;

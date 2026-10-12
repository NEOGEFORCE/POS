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
// El formato (Carta / Oficio) se recibe como prop; si viene vacío, cae al
// default (`LETTER`). `resolveGondolaLayout` entrega toda la geometría
// (dimensiones de hoja, grid, padding, cantidad de slots por página).
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
import type { GondolaFormat } from "@/lib/printing-config.d.mts";

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
}: ShelfLabelsPreviewProps) {
    const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 0.5;

    const layout = useMemo(() => resolveGondolaLayout(format), [format]);

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

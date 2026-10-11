"use client";

// =============================================================================
// /labels/shelf — Precios de góndola (hoja Letter 2×6).
//
// Impresión de etiquetas de góndola 80 × 40 mm en papel Letter portrait
// con grid 2 columnas × 6 filas (12 etiquetas por hoja). La geometría
// (SHEET_* / LABEL_* / PAGE_PADDING_*) es inmutable y vive en
// `@/lib/shelf-labels.mjs`.
//
// Toda la lógica de catálogo, cola, scanner y auditoría se comparte con
// `/labels` (térmica) a través del componente `LabelsWorkspace`. Este
// archivo sólo escoge el modo `shelf`, que:
//   - Activa el botón "Hoja góndola" (handlePrintShelfSheet).
//   - Oculta el botón "Térmica" (handlePrint).
//   - Pinta el checkbox "Limpiar cola al cerrar impresión", el contador
//     "X etiquetas en cola (Y páginas completas + Z sobrantes)" y la
//     vista previa paginada.
//   - Audita el lote en `/labels/print-jobs` con `sizeTemplateId: null`
//     y `meta.layout: gondola-80x40-letter-2x6`.
//
// Entradas de menú relacionadas (sidebar):
//   - "Etiquetas térmicas"   → /labels          (térmicas por rollo)
//   - "Precios góndola"      → /labels/shelf    (esta pantalla)
//   - "Configurar impresora" → /labels/config   (admin)
// =============================================================================

import { LabelsWorkspace } from "@/app/(app)/labels/components/LabelsWorkspace";

export default function LabelsShelfPage() {
    return <LabelsWorkspace mode="shelf" />;
}

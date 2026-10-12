"use client";

// =============================================================================
// /labels/shelf — Precios de góndola (impresora normal, hoja Carta u Oficio).
//
// Impresión de etiquetas de góndola 80 × 40 mm en papel landscape,
// EXCLUSIVAMENTE con el diálogo del navegador (iframe aislado) — nunca con
// impresora térmica ni bridge. El formato activo se persiste en
// `pos_printing_config_v1 → gondola.format` y se edita desde
// `/labels/config` (tab Góndola):
//
//   * Carta  (Letter) → landscape 279.4 × 215.9 mm · grid 3 × 5 = 15.
//   * Oficio (Legal)  → landscape 355.6 × 215.9 mm · grid 4 × 5 = 20.
//
// La geometría exacta vive en `shelf-labels.mjs` (resolveGondolaLayout).
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
//     y `meta.layout` canónico del formato (ej.
//     `gondola-80x40-letter-landscape-3x5` o
//     `gondola-80x40-legal-landscape-4x5`).
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

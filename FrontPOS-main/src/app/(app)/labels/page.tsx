"use client";

// =============================================================================
// /labels — Etiquetas térmicas.
//
// Pantalla dedicada a la impresión de etiquetas en impresora térmica
// (TSPL/ESC/ZPL vía bridge local, o fallback window.print()). La lógica
// de catálogo, cola, scanner, auditoría /labels/codes y bridge payload
// vive en el componente compartido `LabelsWorkspace` para no duplicarla
// con `/labels/shelf` (precios de góndola). Esta ruta pasa `mode="thermal"`
// para activar únicamente el botón de impresión térmica.
//
// Entradas de menú relacionadas (sidebar):
//   - "Etiquetas térmicas"  → /labels           (esta pantalla)
//   - "Precios góndola"     → /labels/shelf     (hoja Letter 2×6)
//   - "Configurar impresora"→ /labels/config    (admin)
// =============================================================================

import { LabelsWorkspace } from "@/app/(app)/labels/components/LabelsWorkspace";

export default function LabelsPage() {
    return <LabelsWorkspace mode="thermal" />;
}

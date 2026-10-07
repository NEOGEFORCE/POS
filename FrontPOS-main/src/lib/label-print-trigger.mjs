// =============================================================================
// src/lib/label-print-trigger.mjs
//
// Deriva el `triggerSource` de un LOTE de etiquetas que /labels envía a
// `POST /labels/print-jobs`. La semántica individual la define
// `LabelPrintSheet` (una etiqueta por producto):
//
//     ensure.created ? "new" : "reprint"
//
// Al colapsar varios items en un único payload de auditoría, el batch
// hereda la peor etiqueta:
//
//   - 100% items recién creados en esta sesión  → "new"
//   - Al menos uno reusa un code existente       → "reprint"
//
// El criterio es conservador: si el lote mezcla codes viejos y nuevos,
// se marca como `reprint` para que la auditoría vea claramente que hay
// reimpresiones aunque haya codes frescos en la misma impresión.
//
// Caso borde: lote vacío → "new" (contrato defensivo). En la práctica el
// page no debería invocar la impresión sin items; devolvemos el default
// histórico igual.
// =============================================================================

/**
 * @param {ReadonlyArray<boolean> | null | undefined} createdFlags
 *   Flags `created` provenientes del response de `POST /labels/codes`,
 *   uno por item del lote (mismo orden del `items[]` del payload).
 * @returns {"new" | "reprint"}
 */
export function labelBatchTriggerSource(createdFlags) {
    if (!Array.isArray(createdFlags) || createdFlags.length === 0) {
        return "new";
    }
    for (const flag of createdFlags) {
        if (flag !== true) return "reprint";
    }
    return "new";
}

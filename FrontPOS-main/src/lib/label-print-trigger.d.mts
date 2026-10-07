// Declaraciones TS para src/lib/label-print-trigger.mjs.

/**
 * Deriva `triggerSource` de un lote de etiquetas desde los flags `created`
 * devueltos por `POST /labels/codes` por item. Ver `.mjs` para la
 * semántica completa.
 */
export function labelBatchTriggerSource(
    createdFlags: ReadonlyArray<boolean> | null | undefined,
): "new" | "reprint";

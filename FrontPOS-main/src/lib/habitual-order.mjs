// ============================================================================
// APRENDIZAJE DE CANTIDAD HABITUAL DE RECEPCIÓN + PUNTO DE REPOSICIÓN (20 %)
// ============================================================================
//
// Nuevo contrato backend (Pedidos Inteligentes, 2026-10):
//
//   habitualOrderQty         float64  Cantidad habitual que el proveedor
//                                     entrega en cada visita, aprendida de
//                                     las últimas recepciones reales. Ej: 12.
//   habitualReorderThreshold float64  Umbral calculado al 20 % de esa
//                                     cantidad habitual (redondeo configurado
//                                     por el backend). Al llegar a este nivel
//                                     el motor sugiere volver a pedir la
//                                     cantidad habitual. Ej: 3 (≈ 25 % de 12).
//   suggestedOrderQty        float64  Cantidad accionable del momento, YA
//                                     calculada con la regla final del motor
//                                     (incluye target, demanda, piso, etc).
//
// EL FRONT NO CALCULA LA REGLA.
// ----------------------------------------------------------------------------
// Lo único que hacemos acá es:
//
//   1. Normalizar los campos (aceptamos number o string numérico, descartamos
//      NaN/Infinity, redondeamos a enteros porque son cantidades físicas).
//   2. Exponer un describe compacto para la UI: una frase corta tipo
//      "Habitual: 12 · reorden ≈ 3". NUNCA presentamos esto como accionable;
//      la cantidad a pedir sigue siendo `suggestedOrderQty`, pintada en el
//      botón grande de "Sugerencia IA" existente.
//   3. Si la metadata no llega (contrato viejo), todo degrada a null y la UI
//      no pinta nada. La regla del dueño es: "degrada limpio si faltan".
//
// Vive como `.mjs` para poder cubrirlo con `node --test` sin loader de TS.
// Tests: `tests/habitual-order.test.mjs`.
//
// NO INCLUIR: no calcular aquí ni el 20 %, ni el threshold por nuestra cuenta,
// ni variantes del número. El backend es la autoridad; cualquier intento de
// derivar valores en el front vuelve a abrir el agujero por el que entraron
// las dos clasificaciones del semáforo (frontend 25/60 vs backend 25/75) y
// termina mostrándole al dueño números que no cuadran con la decisión real
// del motor.

/**
 * Lee un campo numérico con tolerancia a cadenas y undefined.
 * - Devuelve null si no es un número finito.
 * - Redondea a entero porque la cantidad habitual es física.
 * @param {unknown} value
 * @returns {number | null}
 */
function readPositiveIntegerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0) return null;
  return Math.round(parsed);
}

/**
 * Extrae metadata habitual de una sugerencia del backend.
 *
 * Devuelve null si NINGUNA de las dos piezas vino. Si solo vino una,
 * exponemos la que hay y la otra queda en null; la UI puede decidir si
 * pinta la mitad o no.
 *
 * @param {object | null | undefined} item sugerencia del backend
 * @returns {{
 *   habitualOrderQty: number | null,
 *   habitualReorderThreshold: number | null,
 * } | null}
 */
export function getHabitualOrderMetadata(item) {
  if (!item || typeof item !== "object") return null;
  const habitualOrderQty = readPositiveIntegerOrNull(item.habitualOrderQty);
  const habitualReorderThreshold = readPositiveIntegerOrNull(item.habitualReorderThreshold);
  if (habitualOrderQty === null && habitualReorderThreshold === null) return null;
  return { habitualOrderQty, habitualReorderThreshold };
}

/**
 * Puente de conveniencia para la UI: ¿este item tiene algo que mostrar
 * del aprendizaje habitual?
 * @param {object | null | undefined} item
 * @returns {boolean}
 */
export function hasHabitualOrderMetadata(item) {
  return getHabitualOrderMetadata(item) !== null;
}

/**
 * Explicación compacta de la cantidad habitual y el punto de reposición.
 *
 * REGLA DE PRESENTACIÓN:
 *   - Esta frase NUNCA debe confundirse con la sugerencia accionable
 *     (`suggestedOrderQty`). La UI la pinta como etiqueta informativa
 *     ("Aprendizaje de recepciones"), lejos del botón de Sugerencia IA.
 *   - Si solo hay cantidad habitual: "Habitual: 12".
 *   - Si solo hay umbral: "Reorden ≈ 3".
 *   - Si hay ambos: "Habitual: 12 · reorden ≈ 3".
 *   - Si no hay nada → null; la UI no pinta la etiqueta.
 *
 * El `≈` es intencional: el umbral viene del 20 % redondeado por el
 * backend, así que no es un número "exacto" sino una pista operativa.
 *
 * @param {object | null | undefined} item
 * @returns {string | null}
 */
export function describeHabitualOrder(item) {
  const metadata = getHabitualOrderMetadata(item);
  if (!metadata) return null;
  const { habitualOrderQty, habitualReorderThreshold } = metadata;
  const pieces = [];
  if (habitualOrderQty !== null) pieces.push(`Habitual: ${habitualOrderQty}`);
  if (habitualReorderThreshold !== null) {
    pieces.push(
      habitualOrderQty !== null
        ? `reorden ≈ ${habitualReorderThreshold}`
        : `Reorden ≈ ${habitualReorderThreshold}`,
    );
  }
  return pieces.join(" · ");
}

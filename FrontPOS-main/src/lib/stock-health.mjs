/**
 * Salud de stock frente al mínimo configurado en cada producto.
 *
 * Regla NUEVA dictada por el dueño (reemplaza la anterior 20/50/100 del
 * backend). El frontend es la fuente de verdad de esta versión hasta que
 * el backend se alinee. Con `ratio = existencia / mínimo`:
 *
 *   CRITICO     existencia <= 0, o ratio < 0.25
 *   ADVERTENCIA 0.25 <= ratio < 0.75
 *   OPTIMO      ratio >= 0.75
 *
 * El nivel "BAJO" (75 % – 100 %) desaparece: por decisión del dueño ese
 * rango pasa a ser óptimo, así el semáforo no llora con productos que
 * ya están casi al mínimo.
 *
 * Cuando el producto NO tiene mínimo configurado (mínimo <= 0) no hay
 * criterio contra el cual juzgar:
 *
 *   - existencia <= 0 → CRITICO (agotado siempre es rojo, aunque no se
 *                       haya definido mínimo).
 *   - existencia  > 0 → SIN_MINIMO (no se pinta rojo ni amarillo; se le
 *                       muestra al operador "sin mínimo definido" para
 *                       que decida configurarlo).
 */

export const STOCK_HEALTH = {
  CRITICAL: "CRITICO",
  WARNING: "ADVERTENCIA",
  OPTIMAL: "OPTIMO",
  UNSET: "SIN_MINIMO",
};

/**
 * Cortes contra el mínimo configurado. `ratio < CRITICAL_MAX` es rojo,
 * `ratio < WARNING_MAX` es amarillo, el resto verde.
 */
export const STOCK_HEALTH_THRESHOLDS = Object.freeze({
  CRITICAL_MAX: 0.25,
  WARNING_MAX: 0.75,
});

/**
 * @param {number} stock existencia actual
 * @param {number} minStock mínimo configurado en el producto
 * @returns {{ level: string, label: string, ratio: number | null }}
 */
export function getStockHealth(stock, minStock) {
  const existencia = Number.isFinite(Number(stock)) ? Number(stock) : 0;
  const minimo = Number.isFinite(Number(minStock)) ? Number(minStock) : 0;

  // Sin mínimo configurado: solo se puede juzgar el caso "agotado".
  if (minimo <= 0) {
    if (existencia <= 0) {
      return { level: STOCK_HEALTH.CRITICAL, label: "Agotado", ratio: null };
    }
    return { level: STOCK_HEALTH.UNSET, label: "Sin mínimo definido", ratio: null };
  }

  // Agotado con mínimo configurado: siempre rojo, ratio 0.
  if (existencia <= 0) {
    return { level: STOCK_HEALTH.CRITICAL, label: "Agotado", ratio: 0 };
  }

  const ratio = existencia / minimo;

  // Cortes < (no <=): ratio 0.25 exacto es amarillo, ratio 0.75 exacto es verde.
  if (ratio < STOCK_HEALTH_THRESHOLDS.CRITICAL_MAX) {
    return { level: STOCK_HEALTH.CRITICAL, label: "Crítico", ratio };
  }
  if (ratio < STOCK_HEALTH_THRESHOLDS.WARNING_MAX) {
    return { level: STOCK_HEALTH.WARNING, label: "Advertencia", ratio };
  }
  return { level: STOCK_HEALTH.OPTIMAL, label: "Óptimo", ratio };
}

/**
 * Días de cobertura que quedan al ritmo de venta real.
 * Devuelve null cuando el producto no tiene rotación medible.
 * @param {number} stock
 * @param {number} avgDailySales
 * @returns {number | null}
 */
export function getCoverageDays(stock, avgDailySales) {
  const demanda = Number(avgDailySales);
  if (!Number.isFinite(demanda) || demanda <= 0) return null;
  const existencia = Number.isFinite(Number(stock)) ? Number(stock) : 0;
  return Math.floor(Math.max(0, existencia) / demanda);
}

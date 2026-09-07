// ============================================================================
// ORDEN VISUAL DE LAS SUGERENCIAS DE PEDIDO
// ============================================================================
//
// Regla del dueno (Fase 1): la lista de "Pedidos Inteligentes" DEBE mostrarse
// siempre ordenada por gravedad, incluso si el backend ya devuelve un orden.
// El objetivo es que el operador vea de un vistazo lo que hay que atacar y
// nunca lo optimo compita por el mismo espacio visual que lo critico.
//
//   1. CRITICO (rojo)      -> primero
//   2. ADVERTENCIA (amarillo)
//   3. OPTIMO (verde)
//   4. SIN_MINIMO / desconocido -> ultimo
//
// Dentro de cada banda:
//   a. Con sugerencia (suggestedOrderQty > 0) antes que sin sugerencia.
//   b. Menor cobertura (dias) primero. `null` (sin rotacion) va al final.
//   c. Mayor avgDailySales primero (empuja lo que mas vende).
//   d. Nombre alfabetico (desempate estable).
//
// Vive en .mjs para poder probarlo con `node --test`. El backend puede tener
// su propio orden, pero este helper es la fuente de verdad de la UI.

import { STOCK_HEALTH, getCoverageDays, getStockHealth } from "./stock-health.mjs";

// Peso por banda. Numeros pequenos = arriba en la lista.
const BAND_WEIGHT = Object.freeze({
  [STOCK_HEALTH.CRITICAL]: 0,
  [STOCK_HEALTH.WARNING]: 1,
  [STOCK_HEALTH.OPTIMAL]: 2,
  [STOCK_HEALTH.UNSET]: 3,
});

const BAND_ALIASES = Object.freeze({
  // Contrato con el backend: acepta tanto los nombres del semaforo
  // (STOCK_HEALTH.*) como los colores en ingles que pueden llegar por el
  // campo `stockBand` de la respuesta de /restock/suggestions-v2.
  CRITICO: STOCK_HEALTH.CRITICAL,
  CRITICAL: STOCK_HEALTH.CRITICAL,
  RED: STOCK_HEALTH.CRITICAL,
  ADVERTENCIA: STOCK_HEALTH.WARNING,
  WARNING: STOCK_HEALTH.WARNING,
  YELLOW: STOCK_HEALTH.WARNING,
  OPTIMO: STOCK_HEALTH.OPTIMAL,
  OPTIMAL: STOCK_HEALTH.OPTIMAL,
  GREEN: STOCK_HEALTH.OPTIMAL,
  SIN_MINIMO: STOCK_HEALTH.UNSET,
  UNSET: STOCK_HEALTH.UNSET,
  UNKNOWN: STOCK_HEALTH.UNSET,
  NONE: STOCK_HEALTH.UNSET,
});

/**
 * Normaliza un string de banda (venga del backend o del helper local) a las
 * constantes de STOCK_HEALTH. Devuelve null si el valor no aporta info.
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeBand(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const upper = raw.trim().toUpperCase();
  return BAND_ALIASES[upper] ?? null;
}

/**
 * Deduce la banda de salud del item. Se prefiere el `stockBand` que puede
 * mandar el backend en la respuesta v2; si no llega, se calcula localmente
 * con getStockHealth para cubrir contratos viejos.
 *
 * @param {object} item sugerencia
 * @returns {string} una de las constantes STOCK_HEALTH
 */
export function resolveBand(item) {
  if (!item || typeof item !== "object") return STOCK_HEALTH.UNSET;
  const fromBackend = normalizeBand(item.stockBand);
  if (fromBackend) return fromBackend;
  const stock = typeof item.liveStock === "number" ? item.liveStock : item.currentStock;
  const health = getStockHealth(stock, item.minStock ?? 0);
  return health.level;
}

/**
 * Cobertura en dias para el desempate. Devuelve Infinity cuando no hay
 * rotacion (nadie vende y por tanto la cobertura es "infinita"): asi cae al
 * final de la banda.
 * @param {object} item
 * @returns {number}
 */
function coverageKey(item) {
  const stock = typeof item.liveStock === "number" ? item.liveStock : item.currentStock;
  const dailyRaw = Number(item?.avgDailySales);
  const daily = Number.isFinite(dailyRaw) && dailyRaw > 0 ? dailyRaw : 0;
  const days = getCoverageDays(stock, daily);
  return typeof days === "number" ? days : Number.POSITIVE_INFINITY;
}

function suggestionKey(item) {
  const raw = Number(item?.suggestedOrderQty);
  return Number.isFinite(raw) && raw > 0 ? 0 : 1;
}

function dailySalesKey(item) {
  const raw = Number(item?.avgDailySales);
  // Se invierte el signo: al ordenar ascendente, los mayores caen primero.
  return Number.isFinite(raw) ? -raw : 0;
}

function nameKey(item) {
  const value = typeof item?.productName === "string" ? item.productName : "";
  return value.toLocaleLowerCase("es");
}

/**
 * Compara dos sugerencias segun las reglas de la Fase 1.
 * @param {object} left
 * @param {object} right
 * @returns {number}
 */
export function compareSuggestions(left, right) {
  const bandDelta = BAND_WEIGHT[resolveBand(left)] - BAND_WEIGHT[resolveBand(right)];
  if (bandDelta !== 0) return bandDelta;

  const suggestionDelta = suggestionKey(left) - suggestionKey(right);
  if (suggestionDelta !== 0) return suggestionDelta;

  const leftCoverage = coverageKey(left);
  const rightCoverage = coverageKey(right);
  // Infinity - Infinity da NaN, que rompe el ordenamiento y hace explotar el
  // guardian de simetria. Tratamos "sin cobertura" en ambos lados como igual.
  const coverageDelta =
    leftCoverage === rightCoverage ? 0 : leftCoverage - rightCoverage;
  if (coverageDelta !== 0) return coverageDelta;

  const dailyDelta = dailySalesKey(left) - dailySalesKey(right);
  if (dailyDelta !== 0) return dailyDelta;

  return nameKey(left).localeCompare(nameKey(right), "es");
}

/**
 * Ordena una lista de sugerencias sin mutar la original.
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function orderSuggestions(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.slice().sort(compareSuggestions);
}

/**
 * Pesos exportados para hacer aserciones directas en tests.
 */
export const SUGGESTION_BAND_WEIGHT = BAND_WEIGHT;

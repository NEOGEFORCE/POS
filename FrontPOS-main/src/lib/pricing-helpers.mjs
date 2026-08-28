// Reglas de precio del POS.
//
// La regla automática de la tienda sigue siendo la misma: un precio se empuja a
// la centena siguiente cuando su terminación es 20 o mayor. La única excepción
// son los precios que el operador fija deliberadamente en una terminación de 50
// (por ejemplo el huevo a 550): esos se respetan tal cual, tanto al guardar el
// producto como al cobrar la venta.

const HUNDRED = 100;
const FIFTY = 50;

function toPesos(value) {
  const parsed = Math.round(Number(value) || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Regla automática histórica: terminación >= 20 sube a la centena siguiente. */
export function applyStoreRounding(value) {
  const pesos = toPesos(value);
  const remainder = ((pesos % HUNDRED) + HUNDRED) % HUNDRED;
  const base = pesos - remainder;
  return remainder >= 20 ? base + HUNDRED : base;
}

/** Precio fijado a propósito en una terminación de 50 (550, 1.250, 15.250...). */
export function isHalfHundredPrice(value) {
  const pesos = toPesos(value);
  return pesos > 0 && ((pesos % HUNDRED) + HUNDRED) % HUNDRED === FIFTY;
}

/** Ajuste manual al múltiplo de 50 más cercano (redondeo simétrico). */
export function roundToNearestFifty(value) {
  const pesos = toPesos(value);
  return Math.round(pesos / FIFTY) * FIFTY;
}

/**
 * Normaliza el precio de venta que escribe el operador: respeta las
 * terminaciones de 50 y para todo lo demás conserva la regla automática.
 */
export function normalizeSalePrice(value) {
  const pesos = toPesos(value);
  return isHalfHundredPrice(pesos) ? pesos : applyStoreRounding(pesos);
}

/**
 * Subtotal de una línea de venta. Los precios en centenas mantienen el
 * comportamiento previo; los precios terminados en 50 se cobran respetando
 * múltiplos de 50 para que el precio fijado no se infle.
 */
export function roundSaleLineSubtotal(unitPrice, quantity) {
  const price = toPesos(unitPrice);
  const qty = Number(quantity) || 0;
  const raw = price * qty;
  if (isHalfHundredPrice(price)) {
    return Math.round(raw / FIFTY) * FIFTY;
  }
  return applyStoreRounding(raw);
}

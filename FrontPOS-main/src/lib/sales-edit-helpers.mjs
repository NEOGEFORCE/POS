// Helpers puros para edición contable de ventas desde el historial.
//
// La edición vive en /sales/new cuando el carrito activo tiene la clave
// `Factura EDIT-<id>`. Cada item del carrito tiene:
//   - `isPreexisting`: si venía en la factura original.
//   - `originalQuantity`: la cantidad al abrir el carrito de edición.
//   - `cartQuantity`: la cantidad que el cajero decidió dejar ahora.
//
// El delta firmado por línea es `cartQuantity - originalQuantity`:
//   - Un producto nuevo tiene originalQuantity=0 y delta > 0.
//   - Bajar la cantidad de un producto preexistente produce delta < 0.
//   - No tocar un preexistente produce delta = 0 y NO se envía al backend.
//
// El total firmado del cambio (`editDeltaTotal`) es la suma de
// `delta * salePrice` línea a línea. Cuando es positivo la caja cobra
// (COBRO ADICIONAL), cuando es negativo la caja devuelve
// (DEVOLUCIÓN/AJUSTE), y cuando es 0 pero existen deltas es un ajuste
// puro de mezcla (NEUTRAL: se sustituyen productos por el mismo valor).
//
// El endpoint /sales/add-items/:id acepta items con cantidades firmadas.
// Los montos de pago (cashAmount, transferAmount, transferNequi,
// transferDaviplata, creditAmount) viajan SIEMPRE como MAGNITUDES
// POSITIVAS. El backend rechaza magnitudes negativas y determina el
// signo aplicado según el signo del delta monetario neto derivado de
// los items: delta>0 suma al canal, delta<0 lo resta, delta=0 exige
// pagos en cero. En modo 'neutral' o 'no-changes' los canales viajan
// explícitamente en cero para no violar la validación del servicio.

import { roundSaleLineSubtotal } from './pricing-helpers.mjs';

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Elimina el `-0` que aparece al multiplicar por 0 con signo negativo,
// para que serialización y comparaciones sean deterministas.
function normalizeZero(value) {
  return value === 0 ? 0 : value;
}

function isPreexistingFlag(item) {
  if (!item || typeof item !== 'object') return false;
  return item.isPreexisting === true;
}

/**
 * Delta firmado de una línea. Un producto preexistente sin cambio da 0.
 * Un producto nuevo tiene originalQuantity implícita = 0.
 */
export function computeItemDelta(item) {
  if (!item) return 0;
  const current = numeric(item.cartQuantity);
  const original = isPreexistingFlag(item) ? numeric(item.originalQuantity) : 0;
  return current - original;
}

/**
 * Subtotal firmado de la línea (en pesos redondeados con la regla de la
 * tienda). Se calcula sobre abs(delta) usando roundSaleLineSubtotal y
 * luego se restaura el signo, para respetar terminaciones en 50 tanto en
 * cobros como en devoluciones.
 */
export function computeItemDeltaSubtotal(item) {
  const delta = computeItemDelta(item);
  if (delta === 0) return 0;
  const unit = numeric(item?.salePrice);
  const signed = delta < 0 ? -roundSaleLineSubtotal(unit, Math.abs(delta)) : roundSaleLineSubtotal(unit, delta);
  return signed;
}

/**
 * Total monetario firmado del cambio para el carrito completo. Positivo
 * cuando el cliente debe pagar extra, negativo cuando se le debe
 * reembolsar, cero cuando el ajuste es de mezcla (mismo valor).
 */
export function computeEditDeltaTotal(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((acc, item) => acc + computeItemDeltaSubtotal(item), 0);
}

/**
 * True cuando alguna línea tiene delta distinto de cero. Es la señal
 * necesaria (junto con el total monetario) para decidir si se puede
 * enviar la edición: sin deltas mostramos "SIN CAMBIOS".
 */
export function hasEditChanges(items) {
  if (!Array.isArray(items)) return false;
  return items.some((item) => computeItemDelta(item) !== 0);
}

/**
 * Modo semántico del cambio, útil para decidir el copy del modal.
 *   - 'no-changes': no hay ningún delta. La UI debe evitar abrir el modal.
 *   - 'charge': delta total > 0. Cobro adicional al cliente.
 *   - 'refund': delta total < 0. Devolución / ajuste a favor del cliente.
 *   - 'neutral': deltas presentes pero suma = 0 (mezcla al mismo valor).
 */
export function getEditMode(items) {
  if (!hasEditChanges(items)) return 'no-changes';
  const total = computeEditDeltaTotal(items);
  if (total > 0) return 'charge';
  if (total < 0) return 'refund';
  return 'neutral';
}

/**
 * Payload de items para POST /sales/add-items/:id. Cantidades FIRMADAS.
 * Solo incluye líneas cuyo delta sea distinto de cero: no tiene sentido
 * viajar por la red para decirle al backend "no cambies nada aquí".
 */
export function buildEditItemsPayload(items) {
  if (!Array.isArray(items)) return [];
  const payload = [];
  for (const item of items) {
    const delta = computeItemDelta(item);
    if (delta === 0) continue;
    const barcode = item?.barcode ?? '';
    if (!barcode) continue;
    payload.push({
      barcode,
      quantity: delta,
      unitPrice: numeric(item?.salePrice),
      costPrice: numeric(item?.purchasePrice),
      subtotal: computeItemDeltaSubtotal(item),
    });
  }
  return payload;
}

/**
 * Distribución de deducciones de stock local firmadas por barcode. Un
 * valor positivo indica que debe restarse del stock (venta neta), un
 * valor negativo indica que debe sumarse (devolución neta al inventario).
 */
export function buildStockAdjustmentMap(items) {
  const map = new Map();
  if (!Array.isArray(items)) return map;
  for (const item of items) {
    const delta = computeItemDelta(item);
    if (delta === 0) continue;
    const barcode = item?.barcode ?? '';
    if (!barcode) continue;
    map.set(barcode, (map.get(barcode) || 0) + delta);
  }
  return map;
}

function normalizePayment(payment) {
  const raw = payment || {};
  return {
    cash: numeric(raw.cash),
    transfer: numeric(raw.transfer),
    transferNequi: numeric(raw.transferNequi),
    transferDaviplata: numeric(raw.transferDaviplata),
    credit: numeric(raw.credit),
    transferSource: typeof raw.transferSource === 'string' ? raw.transferSource : '',
    change: numeric(raw.change),
    totalPaid: numeric(raw.totalPaid),
  };
}

/**
 * Payload completo para POST /sales/add-items/:id.
 *
 * Los canales de pago viajan SIEMPRE como magnitudes positivas: es el
 * backend quien determina el signo aplicado en base al delta monetario
 * derivado de los items firmados. En modo 'refund' el backend restará
 * las magnitudes del canal correspondiente; en modo 'charge' las sumará.
 * En modo 'neutral' o 'no-changes' se fuerzan a cero para satisfacer la
 * validación "delta neto cero exige pagos en cero" (aunque el modal
 * accidentalmente traiga valores residuales).
 *
 * `items` viaja siempre con cantidades firmadas (positivo agrega,
 * negativo quita, cero se omite).
 */
export function buildEditSalePayload({ items, payment, mode }) {
  const resolvedMode = mode || getEditMode(items);
  const p = normalizePayment(payment);
  const zeroChannels = resolvedMode === 'neutral' || resolvedMode === 'no-changes';

  // Magnitudes siempre positivas (o cero). Cualquier valor negativo del
  // modal se sanitiza a 0 para no romper la validación del backend.
  const clamp = (n) => (n > 0 ? n : 0);
  const cashAmount = zeroChannels ? 0 : clamp(p.cash);
  const transferNequi = zeroChannels ? 0 : clamp(p.transferNequi);
  const transferDaviplata = zeroChannels ? 0 : clamp(p.transferDaviplata);
  // TransferAmount es el TOTAL de la transferencia (backend convention:
  // generic + Nequi + Daviplata). Si el modal trae desglose usamos su
  // suma; si sólo trae un total plano (pagos legacy sin split) usamos
  // ese. Nunca se resta ni negativiza.
  const transferBreakdown = transferNequi + transferDaviplata;
  const transferAmount = zeroChannels
    ? 0
    : transferBreakdown > 0
      ? transferBreakdown
      : clamp(p.transfer);
  const creditAmount = zeroChannels ? 0 : clamp(p.credit);

  return {
    items: buildEditItemsPayload(items),
    cashAmount: normalizeZero(cashAmount),
    transferAmount: normalizeZero(transferAmount),
    transferNequi: normalizeZero(transferNequi),
    transferDaviplata: normalizeZero(transferDaviplata),
    transferSource: p.transferSource,
    creditAmount: normalizeZero(creditAmount),
    mode: resolvedMode,
    deltaTotal: computeEditDeltaTotal(items),
  };
}

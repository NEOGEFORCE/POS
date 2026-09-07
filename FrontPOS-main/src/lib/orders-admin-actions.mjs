import { sanitizeDayList } from './supplier-days.mjs';

/** Construye el body estricto del PATCH de vinculación. */
export function buildProductSupplierLinkPayload(rawSupplierId) {
  const supplierId = Number(rawSupplierId);
  if (!Number.isInteger(supplierId) || supplierId <= 0) {
    throw new TypeError('supplierId debe ser un entero positivo');
  }
  return { supplierId };
}

/**
 * Construye exclusivamente los campos manuales admitidos por el endpoint de
 * agenda. Nunca propaga learned*, name, phone ni el resto de la ficha.
 */
export function buildSupplierSchedulePayload(input = {}) {
  const payload = {};

  if (Object.prototype.hasOwnProperty.call(input, 'visitDays')) {
    payload.visitDays = sanitizeDayList(input.visitDays);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'deliveryDays')) {
    payload.deliveryDays = sanitizeDayList(input.deliveryDays);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'leadTimeDays')) {
    const numeric = Number(input.leadTimeDays);
    payload.leadTimeDays = Number.isFinite(numeric)
      ? Math.min(60, Math.max(0, Math.trunc(numeric)))
      : 0;
  }

  return payload;
}

export type EditCartItem = {
  barcode?: string;
  cartQuantity?: number | string;
  originalQuantity?: number | string;
  salePrice?: number | string;
  purchasePrice?: number | string;
  isPreexisting?: boolean;
};

export type EditMode = 'no-changes' | 'charge' | 'refund' | 'neutral';

export type EditPayment = {
  cash?: number;
  transfer?: number;
  transferNequi?: number;
  transferDaviplata?: number;
  credit?: number;
  transferSource?: string;
  change?: number;
  totalPaid?: number;
};

export type EditItemPayload = {
  barcode: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  subtotal: number;
};

/**
 * Payload de POST /sales/add-items/:id.
 *
 * CONTRATO CON EL BACKEND (Go): `items[].quantity` es FIRMADA (positivo
 * agrega, negativo quita), pero TODOS los montos de pago son MAGNITUDES
 * POSITIVAS. El backend rechaza magnitudes negativas con HTTP 400 y
 * decide el signo aplicado a cada canal según el delta monetario neto
 * derivado de los items.
 *
 * `transferAmount` es el TOTAL de transferencias (genérico + Nequi +
 * Daviplata), la misma convención que `models.Sale.TransferAmount`. El
 * backend deriva la porción genérica restando el desglose.
 */
export type EditSalePayload = {
  items: EditItemPayload[];
  /** Magnitud positiva. */
  cashAmount: number;
  /** Magnitud positiva. TOTAL: genérico + Nequi + Daviplata. */
  transferAmount: number;
  /** Magnitud positiva. */
  transferNequi: number;
  /** Magnitud positiva. */
  transferDaviplata: number;
  transferSource: string;
  /** Magnitud positiva. */
  creditAmount: number;
  mode: EditMode;
  /** Delta monetario FIRMADO del cambio (informativo, no se envía como pago). */
  deltaTotal: number;
};

export function computeItemDelta(item: EditCartItem | null | undefined): number;
export function computeItemDeltaSubtotal(item: EditCartItem | null | undefined): number;
export function computeEditDeltaTotal(items: EditCartItem[] | null | undefined): number;
export function hasEditChanges(items: EditCartItem[] | null | undefined): boolean;
export function getEditMode(items: EditCartItem[] | null | undefined): EditMode;
export function buildEditItemsPayload(items: EditCartItem[] | null | undefined): EditItemPayload[];
export function buildStockAdjustmentMap(items: EditCartItem[] | null | undefined): Map<string, number>;
export function buildEditSalePayload(input: {
  items: EditCartItem[];
  payment: EditPayment;
  mode?: EditMode;
}): EditSalePayload;

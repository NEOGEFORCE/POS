export interface SupplierScheduleInput {
  visitDays?: unknown;
  deliveryDays?: unknown;
  leadTimeDays?: unknown;
}

export interface SupplierSchedulePayload {
  visitDays?: string[];
  deliveryDays?: string[];
  leadTimeDays?: number;
}

export function buildProductSupplierLinkPayload(rawSupplierId: unknown): { supplierId: number };
export function buildSupplierSchedulePayload(input?: SupplierScheduleInput): SupplierSchedulePayload;

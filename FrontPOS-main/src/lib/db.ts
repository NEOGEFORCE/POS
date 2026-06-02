import Dexie, { Table } from 'dexie';

export interface LocalProduct {
  barcode: string;
  productName: string;
  salePrice: number;
  quantity: number;
  isPack?: boolean;
  packMultiplier?: number;
  iva?: number;
  icui?: number;
  ibua?: number;
  // Agrega otros campos necesarios segun tu modelo
}

export interface PendingSale {
  id?: number;
  cart: any[];
  total: number;
  paymentMethod: string;
  customerDni?: string;
  customerName?: string;
  timestamp: number;
}

export class PosDatabase extends Dexie {
  productos!: Table<LocalProduct, string>;
  ventas_pendientes!: Table<PendingSale, number>;

  constructor() {
    super('PosDatabase');
    this.version(1).stores({
      productos: 'barcode, productName', // Primary key and indexed props
      ventas_pendientes: '++id, timestamp' // Auto-increment primary key
    });
  }
}

export const db = new PosDatabase();

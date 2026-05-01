
export type User = {
  id?: string;
  dni: string;
  name: string;
  email: string;
  role: 'superadmin' | 'admin' | 'administrador' | 'empleado' | 'employee' | string;
  is_active?: boolean;
  last_login?: string;
  lastLogin?: string;
  avatar?: string;
  password?: string;
  token?: string;
  // Compatibilidad con datos antiguos/backend inconsistente
  Role?: string;
  Name?: string;
  Email?: string;
};

export type Customer = {
  id: string;
  dni: string;
  name: string;
  phone: string;
  address: string;
  totalPurchases: number;
  totalSpent: number;
  lastPurchaseDate: string;
  creditLimit: number;
  currentCredit: number;
};

export type Category = {
  id: string;
  name: string;
  productCount: number;
};

export type Product = {
  id?: string;
  barcode: string;
  productName: string;
  quantity: number;
  isWeighted?: boolean;
  purchasePrice: number;
  marginPercentage: number;
  salePrice: number;
  categoryId: number;
  supplierId?: number;
  imageUrl?: string;
  minStock?: number;
  iva?: number;
  icui?: number;
  ibua?: number;
  isActive?: boolean;
  netProfit?: number;
  
  // Lógica de Empaques
  isPack?: boolean;
  baseProductBarcode?: string;
  packMultiplier?: number;
  baseProduct?: Product;
  Category?: Category;
  category?: Category;
  suppliers?: Supplier[];
};


export type ExpenseCategory = 'Proveedores' | 'Servicios Públicos' | 'Daños y Arreglos' | 'Otros';

export type Expense = {
  id: string;
  description: string;
  category: ExpenseCategory;
  amount: number;
  date: string;
  paymentSource?: string;
  supplierId?: string | number;
  lenderName?: string;
  status?: 'PAID' | 'PENDING';
  creator?: User; // El usuario que registró el gasto
};

export type Sale = {
  id: string;
  date: string;
  total: number;
  paymentMethod: string;
  amountPaid: number;
  cashAmount: number;
  transferAmount: number;
  transferSource?: string;
  creditAmount: number;
  change: number;
  client?: Customer;
  details: SaleDetail[];
};

export type SaleDetail = {
  id: number;
  barcode: string;
  quantity: number;
  returnedQty?: number;
  unitPrice: number;
  subtotal: number;
  product?: Product;
};

export type OrderMethodType = 'ROUTE' | 'APP';

export interface OrderMethod {
  id?: number;
  type: OrderMethodType;
  platformName: string;
  visitDays: number[];
  leadTimeDays: number;
  isActive: boolean;
}

export type Supplier = {
  id: string | number;
  name: string;
  phone?: string;
  address?: string;
  vendorName?: string;
  status?: 'Activo' | 'Inactivo';
  imageUrl?: string;
  // Campos legacy (compatibilidad)
  visitDay?: string;
  deliveryDay?: string;
  // Nuevos campos multi-días
  visitDays?: string[];
  deliveryDays?: string[];
  restockMethod?: string;
  orderMethods?: OrderMethod[];
};

export type CreditPayment = {
  id: number;
  clientDni: string;
  paymentDate: string;
  amountCash: number;
  amountTransfer: number;
  transferSource: string;
  totalPaid: number;
  client?: Customer;
};

export interface CashierClosure {
  id: number;
  date: string;
  startDate: string;
  endDate: string;
  salesCount: number;
  totalSales: number;
  totalCash: number;
  totalTransfer: number;
  totalCard: number;
  totalNequi: number;
  totalDaviplata: number;
  totalBancolombia: number;
  totalOtherTransfer: number;
  totalExpenses: number;
  totalReturns: number;
  returnsCount?: number;
  totalCreditIssued: number;
  totalCreditCollected: number;
  openingCash: number;
  netBalance: number;
  physicalCash?: number;
  difference?: number;
  salariesDetail?: string;
  expenses?: Expense[];
  expensesDetail?: string;
  creditPayments?: CreditPayment[];
  creditsIssued?: Sale[];
  closedByDni?: string;
  closedByName?: string;
}

export type AuditLog = {
  id: number;
  employee_dni: string;
  employee_name?: string;
  action: string;
  module: string;
  details: string;
  human_readable?: string;
  changes?: string; // JSON string
  is_critical?: boolean;
  ip_address: string;
  device?: string;
  created_at: string;
};

export type ProductSupplierPrice = {
  productBarcode: string;
  supplierId: number;
  purchasePrice: number;
  updatedAt: string;
  Supplier?: Supplier;
};

export type SavingsOpportunity = {
  barcode: string;
  productName: string;
  currentPrice: number;
  bestPrice: number;
  bestSupplier: string;
  potentialSave: number;
  stock: number;
};

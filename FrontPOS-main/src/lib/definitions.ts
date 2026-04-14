

export type User = {
  id: string;
  dni: string;
  name: string;
  email: string;
  role: 'administrador' | 'empleado' | string;
  status: 'Activo' | 'Inactivo';
  lastLogin: string;
  avatar?: string;
  password?: string;
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
  categoryId: string;
  supplierId?: number;
  imageUrl?: string;
  minStock?: number;
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

export type Supplier = {
  id: string | number;
  name: string;
  phone?: string;
  address?: string;
  status?: 'Activo' | 'Inactivo';
  imageUrl?: string;
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
  totalNequi: number;
  totalDaviplata: number;
  totalOtherTransfer: number;
  totalExpenses: number;
  totalReturns: number;
  totalCreditIssued: number;
  totalCreditCollected: number;
  openingCash: number;
  netBalance: number;
  physicalCash?: number;
  difference?: number;
  salariesDetail?: string;
  expenses?: Expense[];
  expensesDetail?: string;
  closedByDni?: string;
  closedByName?: string;
}

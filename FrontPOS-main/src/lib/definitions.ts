

export type User = {
  id: string;
  dni: string;
  name: string;
  email: string;
  role: 'administrador' | 'empleado';
  status: 'Activo' | 'Inactivo';
  lastLogin: string;
  avatar?: string; // made optional
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
};


export type Expense = {
  id: string;
  description: string;
  category?: string;
  amount: number;
  date: string;
  paymentSource?: string;
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
  totalBancolombia: number;
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

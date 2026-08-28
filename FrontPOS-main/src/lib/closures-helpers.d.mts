export interface ClosureLike {
  physicalCashReal?: number;
  cashBills?: number;
  cashBreakdown?: string;
  coins1000?: number;
  coins500?: number;
  coins200?: number;
  coins100?: number;
  physicalCash?: number;
  egresosTotales?: number;
  egresosCaja?: number;
  egresosFondo?: number;
  egresosDigital?: number;
  expensesDetail?: string;
  ventasCajero?: number;
  totalNequi?: number;
  totalDaviplata?: number;
  totalCard?: number;
  totalBancolombia?: number;
  totalOtherTransfer?: number;
  totalReturns?: number;
}

export interface ClosureExpensesSummary {
  cashExpenses: number;
  totalExpenses: number;
  fondoExpenses: number;
  digitalExpenses: number;
}

export function getRealPhysicalCash(closure: ClosureLike): number;
export function getClosureExpensesSummary(closure: ClosureLike): ClosureExpensesSummary;
export function getVentasCajero(closure: ClosureLike): number;

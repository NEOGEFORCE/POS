import type { Expense } from "./definitions";

export interface PayablesGroup {
  creditor: string;
  debts: Expense[];
  total: number;
}

export function isLoanSource(expense: Partial<Expense> | null | undefined): boolean;
export function isLiveDebt(expense: Partial<Expense> | null | undefined): boolean;
export function liveDebtPrincipal(expense: Partial<Expense> | null | undefined): number;
export function liveDebtTotal(expense: Partial<Expense> | null | undefined): number;
export function selectLiveDebts(expenses: Expense[] | null | undefined): Expense[];
export function sumPayables(expenses: Expense[] | null | undefined): number;
export function groupPayablesByCreditor(expenses: Expense[] | null | undefined): PayablesGroup[];

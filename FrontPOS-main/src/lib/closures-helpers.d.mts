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

export interface ClosureSubmissionInput {
  /** Texto del campo de efectivo contado. Vacio = no se declaro nada. */
  actualCashInput: string;
  /** Efectivo que el sistema espera encontrar en la caja. */
  expectedCash: number;
  /** true al corregir un cierre historico desde reportes. */
  isEditMode?: boolean;
  /** true si el operador ya confirmo que no hay efectivo. */
  confirmedNoCash?: boolean;
}

export interface ClosureSubmissionDecision {
  canSubmit: boolean;
  /** true = hay que preguntarle al operador antes de cerrar. */
  needsCashDeclaration: boolean;
  reason:
    | 'edit_mode'
    | 'declarado'
    | 'sin_efectivo_esperado'
    | 'confirmado_sin_efectivo'
    | 'falta_declarar_efectivo';
}

export function evaluateClosureSubmission(
  input: ClosureSubmissionInput,
): ClosureSubmissionDecision;

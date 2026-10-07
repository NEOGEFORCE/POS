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
  egresosAlcancia?: number;
  egresosCoins?: number;
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
  /** Egresos pagados con monedas de la alcancía (canal independiente). */
  coinsExpenses: number;
}

export interface ExpenseChannels {
  cash: number;
  nequi: number;
  daviplata: number;
  fondo: number;
  coins: number;
}

export function getRealPhysicalCash(closure: ClosureLike): number;
export function getClosureExpensesSummary(closure: ClosureLike): ClosureExpensesSummary;
export function getVentasCajero(closure: ClosureLike): number;
export function expenseChannels(expense: Record<string, unknown>): ExpenseChannels;

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

export interface CashBreakdownInput {
  bills?: Record<string, unknown>;
  coins?: Record<string, unknown>;
}

export interface CashBreakdownNormalized {
  bills: Record<string, number>;
  coins: Record<string, number>;
}

/**
 * Convierte strings vacios/nulos a 0 en las denominaciones del desglose. El
 * backend `applyCashBreakdown` revienta con "cantidad invalida" si recibe "".
 */
export function sanitizeCashBreakdown(
  raw: CashBreakdownInput | null | undefined,
): CashBreakdownNormalized;

/**
 * Serializa el breakdown a JSON ya saneado. Equivalente a
 * `JSON.stringify(sanitizeCashBreakdown(raw))`.
 */
export function serializeCashBreakdown(
  raw: CashBreakdownInput | null | undefined,
): string;

export const CLOSURE_TX_STORAGE_KEY: 'pos_closure_tx_id';

/**
 * Genera un UUID v4 para identificar un intento de cierre. Usa
 * crypto.randomUUID cuando esta disponible.
 */
export function generateClientClosureId(): string;

/**
 * Obtiene (o crea) el clientTxId persistente del intento actual.
 * Usar localStorage por defecto; permite inyectar un store para tests.
 */
export function getOrCreateClientClosureId(storage?: Storage | null): string;

/**
 * Limpia el clientTxId persistente. Llamar solo tras exito confirmado.
 */
export function clearClientClosureId(storage?: Storage | null): void;

/** Lista exacta de las claves de localStorage que el flujo de cierre usa. */
export function listClosureStorageKeys(): string[];

/** Borra todas las claves locales del cierre. */
export function clearClosureStorage(storage?: Storage | null): void;

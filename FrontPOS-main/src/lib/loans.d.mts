// Declaraciones TS para src/lib/loans.mjs.
// El módulo real es puro JS para poder correrse con `node --test`.

// Modos de interés aceptados por el contrato (backend Go CHECK migración 021).
// FRENCH es nuevo y coexiste con NONE/SIMPLE sin reinterpretarlos.
export type LoanInterestMode = "NONE" | "SIMPLE" | "FRENCH";
export type LoanPaymentFrequency = "WEEKLY" | "BIWEEKLY" | "MONTHLY";
export type LoanStatus = "ACTIVE" | "PAID" | "DEFAULTED" | "CANCELLED";
export type InstallmentStatus = "PENDING" | "PARTIAL" | "PAID" | "LATE";
export type InstallmentClass = "paid" | "partial" | "overdue" | "pending";

export type LoanErrorCode =
  | "LOAN_NOT_FOUND"
  | "LOAN_INSTALLMENT_NOT_FOUND"
  | "LOAN_INSTALLMENT_ALREADY_PAID"
  | "LOAN_PRINCIPAL_EXCEEDED"
  | "LOAN_INVALID_SCHEDULE"
  | "LOAN_INVALID_INPUT"
  | "LOAN_HAS_PAYMENTS"
  | "LOAN_HAS_PAID_INSTALLMENTS"
  | "LOAN_PRINCIPAL_BELOW_USAGE";

// Catálogo de tipos de préstamo que acepta el backend (migración 023 en
// diseño). "OTRO" es el default seguro para créditos legacy.
export type LoanType =
  | "CONSUMO"
  | "HIPOTECARIO"
  | "LIBRANZA"
  | "COMERCIAL"
  | "VEHICULO"
  | "OTRO";

// Tipo de interés según la banca formal: FIJO (default) o VARIABLE.
export type LoanRateType = "FIJO" | "VARIABLE";

// Monedas aceptadas. El default es COP. USD se contempla pero el motor
// numérico sigue en pesos (no convierte).
export type LoanCurrency = "COP" | "USD";

export interface ScheduleInput {
  principal: number;
  /**
   * Porcentaje total flat (0 para sin interés). Aplica a NONE/SIMPLE.
   * Reemplaza al anterior `annualRatePct`; el nombre viejo sigue aceptándose
   * por compatibilidad pero semánticamente carga la misma cifra:
   * `principal * rate / 100`.
   */
  interestRatePct?: number;
  /** @deprecated usar `interestRatePct` — se conserva como alias. */
  annualRatePct?: number;
  /**
   * Tasa EFECTIVA ANUAL en porcentaje. Aplica solo a FRENCH; el motor hace
   * la conversión i_m = (1 + EA/100)^(1/12) − 1 y calcula la cuota francesa.
   */
  annualEffectiveRatePct?: number;
  /**
   * Valor MENSUAL FIJO del seguro bancario (COP). Default 0. Aplica solo a
   * FRENCH; en NONE/SIMPLE se ignora.
   */
  monthlyInsurance?: number;
  /**
   * Costo TOTAL del FGA (COP). Se difiere en `termCount` meses iguales con
   * residuo en la última cuota. Default 0. Aplica solo a FRENCH.
   */
  fgaTotal?: number;
  mode: LoanInterestMode | string;
  termCount: number;
  frequency: LoanPaymentFrequency | string;
  firstPaymentDate?: string | Date | null;
}

export interface ScheduleInstallment {
  number: number;
  dueDate: string | null;
  principalDue: number;
  interestDue: number;
  /** Seguro bancario de la cuota (FRENCH). 0 en NONE/SIMPLE. */
  insuranceDue: number;
  /** Cuota de FGA diferida (FRENCH). 0 en NONE/SIMPLE. */
  fgaDue: number;
  totalDue: number;
  /** Saldo de capital después de la cuota (FRENCH). Ausente en NONE/SIMPLE. */
  balance?: number;
}

export interface ScheduleTotals {
  principal: number;
  interest: number;
  totalPayable: number;
  // Extras exclusivos de FRENCH; en NONE/SIMPLE vienen undefined.
  monthlyRate?: number;
  monthlyRatePct?: number;
  baseInstallment?: number;
  monthlyInsurance?: number;
  monthlyFga?: number;
  totalInsurance?: number;
  totalFga?: number;
  monthlyTotal?: number;
}

export interface ScheduleResult {
  installments: ScheduleInstallment[];
  totals: ScheduleTotals;
  error?: "LOAN_INVALID_SCHEDULE";
}

export interface LoanInstallmentRecord extends ScheduleInstallment {
  id?: number | string;
  paidAmount?: number;
  paidAt?: string | null;
  status?: InstallmentStatus | string;
  settlementExpenseId?: number | null;
}

export interface LoanExpenseRecord {
  id?: number | string;
  loanId?: number | string;
  expenseId?: number | string | null;
  amountUsed?: number;
  amount_used?: number;
  purpose?: string | null;
  createdByDni?: string;
  createdAt?: string;
  sourceExpenseId?: number | string | null;
  reversedAt?: string | null;
  orphanedPayment?: boolean;
}

/**
 * Estadísticos agregados que acompañan al LoanWithStatsRow del backend.
 * El normalizador los eleva al LoanRecord resultante y conserva una copia
 * bajo `stats`.
 */
export interface LoanStats {
  totalPayable: number;
  remainingBalance: number;
  totalDue: number;
  totalPaid: number;
  outstandingDue: number;
  nextDueDate: string | null;
  nextDueAmount: number;
  installmentsPaid: number;
  installmentsTotal: number;
  principalUsed: number;
}

export interface LoanRecord {
  id?: number | string;
  lenderName?: string;
  lenderDni?: string | null;
  supplierId?: number | null;
  principalAmount?: number;
  interestRatePct?: number;
  /** Tasa EFECTIVA ANUAL en porcentaje (solo FRENCH). Backend 021. */
  annualEffectiveRatePct?: number;
  /** Pago mensual fijo del seguro bancario (FRENCH). */
  monthlyInsurance?: number;
  /** Costo total del FGA, diferido en termCount meses (FRENCH). */
  fgaTotal?: number;
  /** Cuota de FGA por mes (`fgaTotal / termCount` redondeada). Backend 021. */
  monthlyFga?: number;
  /** Cuota base fija de amortización en FRENCH (sin extras). Backend 021. */
  baseInstallmentAmount?: number;
  interestMode?: LoanInterestMode | string;
  termCount?: number;
  paymentFrequency?: LoanPaymentFrequency | string;
  startDate?: string | null;
  firstPaymentDate?: string | null;
  disbursementChannel?: string | null;
  status?: LoanStatus | string;
  note?: string | null;
  createdByDni?: string;
  createdAt?: string;
  updatedAt?: string;
  totalPayable?: number;
  remainingBalance?: number;
  totalPaid?: number;
  nextDueDate?: string | null;
  nextDueAmount?: number;
  principalUsed?: number;
  installmentsPaid?: number;
  installmentsTotal?: number;
  installments?: LoanInstallmentRecord[];
  expenses?: LoanExpenseRecord[];
  /** Copia cruda de los stats del backend, útil para pantallas que los
   *  necesiten exactos sin recalcular. */
  stats?: LoanStats;

  // ───────────────────── Metadata bancaria (migración 023 en diseño) ─────
  // Todos opcionales: préstamos legacy (NONE/SIMPLE) seguirán funcionando
  // sin estos campos. El normalizador tolera su ausencia.

  /** Número de crédito según la entidad financiera (ej. "0013-0021-96-..."). */
  creditNumber?: string | null;
  /** Clasificación de la línea del banco (CONSUMO, HIPOTECARIO...). */
  loanType?: LoanType | string | null;
  /** Nombre del titular/deudor del crédito. Distinto a lenderName (banco). */
  holderName?: string | null;
  /** Cédula/NIT del titular, cuando aplica. */
  holderDni?: string | null;
  /** Moneda en la que se registró el préstamo. Default COP. */
  currency?: LoanCurrency | string | null;
  /** Interés FIJO o VARIABLE. Default FIJO. */
  rateType?: LoanRateType | string | null;
  /** Pago automático (débito automático) activo en la cuenta origen. */
  autoDebit?: boolean | null;
  /** Fecha final de vencimiento del crédito (distinta de firstPaymentDate). */
  maturityDate?: string | null;
  /** Tasa de mora EA en porcentaje. 0 si no aplica. */
  lateAnnualEffectiveRatePct?: number | null;
  /** Dinero efectivamente recibido en la cuenta (antes del FGA/IVA/GMF). */
  netDisbursementAmount?: number | null;
  /** IVA del FGA (parte del valor financiado). */
  fgaIvaAmount?: number | null;
  /** GMF (4x1000) descontado del desembolso. */
  fgaGmfAmount?: number | null;

  // ───────────────────── Snapshot bancario (NO contable) ─────────────────
  // Son datos que el usuario captura leyendo el extracto/portal del banco.
  // NUNCA mutan `remainingBalance` ni ninguna fila de `loan_installments`;
  // la UI los muestra junto al saldo contable para que el delta sea visible.

  /** Saldo que reporta el banco al momento de la última consulta. */
  bankBalanceAmount?: number | null;
  /** Momento en que se consultó el snapshot (ISO con zona). */
  bankBalanceAsOf?: string | null;
  /** Suma que el banco reporta como pagada hasta la fecha. */
  bankPaidAmount?: number | null;
  /** Próxima cuota que el banco pasará al cobro (dato autoritativo). */
  officialNextInstallmentAmount?: number | null;
  /** Fecha de corte oficial de la próxima cuota (YYYY-MM-DD). */
  officialNextInstallmentDate?: string | null;
}

/** Fila cruda del listado del backend: `{ loan, totalPayable, ... }`. */
export interface LoanWithStatsRow extends LoanStats {
  loan: LoanRecord;
}

export interface LoansListEnvelope {
  loans: LoanWithStatsRow[] | LoanRecord[];
  total?: number;
}

export interface LoanDetailEnvelope {
  loan: LoanRecord;
}

export interface LoanPreviewEnvelope {
  preview: ScheduleResult;
}

export interface LoansSummary {
  activeCount: number;
  overdueCount: number;
  overdueAmount: number;
  totalPrincipal: number;
  totalOutstanding: number;
  totalPaid: number;
  upcoming30d: Array<LoanInstallmentRecord & { loanId: number | string; lenderName?: string }>;
}

export const INTEREST_MODES: Readonly<Record<"NONE" | "SIMPLE" | "FRENCH", LoanInterestMode>>;
export const PAYMENT_FREQUENCIES: Readonly<Record<"WEEKLY" | "BIWEEKLY" | "MONTHLY", LoanPaymentFrequency>>;
export const LOAN_STATUSES: Readonly<Record<"ACTIVE" | "PAID" | "DEFAULTED" | "CANCELLED", LoanStatus>>;
export const INSTALLMENT_STATUSES: Readonly<Record<"PENDING" | "PARTIAL" | "PAID" | "LATE", InstallmentStatus>>;
export const LOAN_ERROR_CODES: Readonly<Record<LoanErrorCode, LoanErrorCode>>;

/** Catálogo de tipos de préstamo aceptados por el backend (migración 023). */
export const LOAN_TYPES: Readonly<Record<LoanType, LoanType>>;
/** Catálogo FIJO/VARIABLE. */
export const RATE_TYPES: Readonly<Record<LoanRateType, LoanRateType>>;
/** Catálogo de monedas. */
export const LOAN_CURRENCIES: Readonly<Record<LoanCurrency, LoanCurrency>>;

export function toISODate(input: string | Date | null | undefined): string | null;
export function addPeriod(date: string | Date, frequency: string, n: number): Date;
export function parseLoanAmount(value: string | number | null | undefined): number;
export function buildSchedule(input: ScheduleInput): ScheduleResult;

// Los normalizadores aceptan `unknown` a propósito: su trabajo es blindar la
// UI contra respuestas con shape inesperado. Validan y producen el tipo
// canónico aguas adentro.
export function normalizeLoanListResponse(
  response: unknown,
): { loans: LoanRecord[]; total: number };
export function normalizeLoanDetailResponse(
  response: unknown,
): LoanRecord | null;
export function normalizeLoanPreviewResponse(
  response: unknown,
): ScheduleResult | null;

export interface FrenchDisplayTotals {
  baseInstallment: number;
  monthlyCharges: number;
  finalMonthly: number;
  totalToPay: number;
}
export function frenchDisplayTotals(
  totals: Partial<ScheduleTotals> | null | undefined,
  termCount: number,
): FrenchDisplayTotals | null;

export interface LoanPayExpenseEnvelope {
  expense: Record<string, unknown> | null;
  loanExpense: Record<string, unknown> | null;
  totalUsed: number;
  available: number;
}

export function normalizeLoanPayExpenseResponse(
  response: unknown,
): LoanPayExpenseEnvelope | null;

export function liveLoanOutstanding(loan: LoanRecord | null | undefined): number;
export function totalPaidOfLoan(loan: LoanRecord | null | undefined): number;
export function loanProgress(loan: LoanRecord | null | undefined): number;
export function liveLoanAvailable(loan: LoanRecord | null | undefined): number;
export function sumLoans(loans: LoanRecord[] | null | undefined): number;
export function sumActivePrincipal(loans: LoanRecord[] | null | undefined): number;
export function groupInstallmentsByStatus(
  loan: LoanRecord | null | undefined,
  todayIso?: string | null,
): { paid: LoanInstallmentRecord[]; overdue: LoanInstallmentRecord[]; pending: LoanInstallmentRecord[] };
export function upcomingInstallments(
  loans: LoanRecord[] | null | undefined,
  days?: number,
  today?: Date,
): Array<LoanInstallmentRecord & { loanId: number | string; lenderName?: string }>;
export function summarizeLoans(loans: LoanRecord[] | null | undefined, today?: Date): LoansSummary;
export function classifyInstallment(
  it: LoanInstallmentRecord | null | undefined,
  todayIso?: string | null,
): InstallmentClass;
export function installmentProgress(it: LoanInstallmentRecord | null | undefined): number;
export function formatLoanMoney(value: number | string | null | undefined): string;

/**
 * Delta entre la cuota "oficial" reportada por el banco y la próxima cuota
 * pendiente del cronograma estimado del POS.
 *
 * - `officialAmount` / `officialDate` → `loan.officialNextInstallment{Amount,Date}`.
 * - `estimatedAmount` / `estimatedDate` → de la primera cuota no pagada.
 * - `amountDelta` = official − estimated (positivo si el banco pide MÁS).
 * - `dateDelta`   = diferencia en días (positivo si la fecha oficial va DESPUÉS).
 * - `hasOfficial` false cuando no hay datos del banco cargados.
 *
 * Devuelve `null` si falta el loan.
 */
export interface LoanNextInstallmentDelta {
  hasOfficial: boolean;
  officialAmount: number | null;
  officialDate: string | null;
  estimatedAmount: number | null;
  estimatedDate: string | null;
  amountDelta: number | null;
  dateDelta: number | null;
}
export function nextInstallmentDelta(
  loan: LoanRecord | null | undefined,
): LoanNextInstallmentDelta | null;

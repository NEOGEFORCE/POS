package ports

import (
	"context"
	"errors"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// ErrLoanNotFound es el sentinel usado por el repositorio cuando un
// loan no existe (o está soft-deleted).
var ErrLoanNotFound = errors.New("préstamo no encontrado")

// ErrInstallmentNotFound idem para una cuota. Se mapea al código
// frontend `LOAN_INSTALLMENT_NOT_FOUND`.
var ErrInstallmentNotFound = errors.New("cuota no encontrada")

// ErrInstallmentAlreadyPaid se devuelve si se intenta pagar una cuota
// que ya está PAID. El servicio lo mapea a 409 con código
// `LOAN_INSTALLMENT_ALREADY_PAID`. Es la respuesta IDEMPOTENTE del
// endpoint de pago: no se crea un Expense duplicado, no se mutan filas.
var ErrInstallmentAlreadyPaid = errors.New("la cuota ya está completamente pagada")

// ErrPrincipalExceeded se devuelve cuando SUM(loan_expenses.amount_used)
// supera el principal del préstamo. El servicio lo mapea a 400 con
// código `LOAN_PRINCIPAL_EXCEEDED`.
var ErrPrincipalExceeded = errors.New("el gasto excede el principal disponible del préstamo")

// ErrLoanNotActive se devuelve cuando se intenta pagar un egreso con un
// préstamo cuyo status no es ACTIVE ni DEFAULTED (ej. ya está PAID,
// CANCELLED o soft-deleted). El servicio lo mapea a 409 con código
// `LOAN_NOT_ACTIVE`.
var ErrLoanNotActive = errors.New("el préstamo no está activo (status no permite nuevos usos)")

// ErrExpenseNotFound se devuelve cuando el endpoint de pago-con-préstamo
// recibe un expenseId que no existe o fue soft-deleted. Lo mapeamos a 404.
var ErrExpenseNotFound = errors.New("egreso no encontrado")

// ErrExpenseNotPayable se devuelve cuando el expenseId existe pero ya está
// completamente saldado (status PAID o SETTLED sin ser una deuda viva de
// préstamo pendiente). Lo mapeamos a 409.
var ErrExpenseNotPayable = errors.New("el egreso ya está completamente pagado")

// ErrLoanUsageNotOrphan indica que el uso no corresponde a un payment
// expense ya eliminado; debe borrarse por el flujo normal de egresos.
var ErrLoanUsageNotOrphan = errors.New("el uso del préstamo no es un pago eliminado huérfano")

// ErrLoanOrphanDebtAmbiguous evita adivinar qué deuda restaurar cuando no
// existe la traza pre-022 y hay cero o más de una candidata exacta.
var ErrLoanOrphanDebtAmbiguous = errors.New("no se encontró una única deuda original para restaurar")

// ErrLoanHasPaidInstallments protege la edición del cronograma: si ya se
// pagó al menos una cuota (paid_amount > 0), recalcular el cronograma
// borraría las filas con settlement_expense_id y rompería la auditoría
// contra los Expenses asociados. El servicio lo mapea a 409 con código
// `LOAN_HAS_PAID_INSTALLMENTS`. Los pagos deben revertirse antes de
// renegociar el crédito.
var ErrLoanHasPaidInstallments = errors.New("no se puede recalcular: hay cuotas con pagos registrados")

// ErrLoanPrincipalBelowUsage protege la invariante
//
//	principal_amount >= SUM(loan_expenses.amount_used WHERE reversed_at IS NULL)
//
// cuando el admin edita el principal del préstamo. Si el nuevo principal
// quedaría por debajo del uso activo, el servicio aborta y lo mapea a 400
// con código `LOAN_PRINCIPAL_BELOW_USAGE`. Para bajar el principal más
// allá del uso activo, primero se reversan los usos.
var ErrLoanPrincipalBelowUsage = errors.New("el principal nuevo es menor que el uso activo del préstamo")

// ErrLoanStartDateAfterInstallments evita que un admin empuje start_date
// más allá de la primera cuota del cronograma: la BD rechazaría por
// CHECK (first_payment_date >= start_date), pero prefiero devolver un
// error de dominio con mensaje claro.
var ErrLoanStartDateAfterInstallments = errors.New("la nueva fecha de inicio es posterior a cuotas ya programadas")

// ErrLoanMaturityBeforeStart se valida dentro de la misma transacción que
// bloquea el préstamo, usando el start_date efectivo (nuevo o persistido).
// Evita depender únicamente del CHECK de PostgreSQL y permite devolver 400
// sin filtrar detalles técnicos del driver.
var ErrLoanMaturityBeforeStart = errors.New("la fecha de vencimiento no puede ser anterior a la fecha de inicio")

type ReverseOrphanedLoanExpenseOutcome struct {
	LoanExpenseID     uint    `json:"loanExpenseId"`
	RestoredDebtID    uint    `json:"restoredDebtId"`
	RestoredAmount    float64 `json:"restoredAmount"`
	ReleasedPrincipal float64 `json:"releasedPrincipal"`
}

// UpdateLoanAtomicInput es TODO lo que el servicio pasa al repo para
// editar un préstamo. El servicio ya validó enums, strings y rangos; aquí
// el repo sólo aplica la transacción con locks y, si corresponde, recrea
// el cronograma.
//
// SEMÁNTICA DE DOS RAMAS:
//
//   - Metadata (siempre se aplica): los campos bancarios editables y el
//     snapshot/cuota oficial del banco. No tocan el cálculo contable.
//   - Cronograma (sólo si Recalculate == true): regenera loan_installments
//     con NewSchedule. El repo exige CERO cuotas con paid_amount > 0 y
//     valida que NewPrincipalAmount >= SUM(amount_used activo).
//
// Los campos "financieros" (principal, plazo, tasas, frecuencia, fechas
// del cronograma, extras FRENCH) sólo viajan cuando Recalculate == true;
// el servicio los construyó y validó con BuildLoanSchedule.
type UpdateLoanAtomicInput struct {
	// --- Metadata siempre editable --------------------------------------
	LenderName          string
	LenderDNI           string
	SupplierID          *uint
	DisbursementChannel string
	Note                string

	CreditNumber               *string
	LoanType                   string
	HolderName                 *string
	HolderDNI                  *string
	Currency                   string
	RateType                   string
	AutoDebit                  bool
	MaturityDate               *time.Time
	LateAnnualEffectiveRatePct float64
	NetDisbursementAmount      *float64
	FgaIvaAmount               float64
	FgaGmfAmount               float64

	// Snapshot bancario (trío atado) y cuota oficial (par atado). El
	// servicio ya validó la coherencia (ambos o ninguno) para que la BD
	// no rechace por CHECK.
	BankBalanceAmount             *float64
	BankBalanceAsOf               *time.Time
	BankPaidAmount                *float64
	OfficialNextInstallmentAmount *float64
	OfficialNextInstallmentDate   *time.Time

	// --- start_date editable con cuidado --------------------------------
	// Si se provee, el repo valida que no sea posterior a la primera cuota
	// del cronograma (MIN(due_date)). En la rama de recálculo, start_date
	// y el cronograma nuevo ya son coherentes por construcción.
	StartDate *time.Time

	// --- Rama de recálculo del cronograma -------------------------------
	Recalculate bool
	// Campos financieros nuevos; sólo relevantes cuando Recalculate == true.
	NewPrincipalAmount        float64
	NewInterestRatePct        float64 // flat total (SIMPLE) o 0 (FRENCH)
	NewAnnualEffectiveRatePct float64 // EA (FRENCH), 0 en NONE/SIMPLE
	NewInterestMode           string
	NewTermCount              int
	NewPaymentFrequency       string
	NewFirstPaymentDate       time.Time
	NewMonthlyInsurance       float64
	NewFgaTotal               float64
	NewMonthlyFga             float64
	NewBaseInstallment        float64
	NewTotalPayable           float64
	// NewSchedule es el cronograma ya construido por el servicio con
	// BuildLoanSchedule. El repo lo persiste tras borrar las cuotas viejas.
	NewSchedule []models.LoanInstallment

	ActorDNI string
}

// UpdateLoanAtomicOutcome resume el resultado para que el servicio arme la
// respuesta sin volver a tocar la BD de inmediato (el servicio recarga con
// GetByIDWithRelations para el envelope final).
type UpdateLoanAtomicOutcome struct {
	Loan         *models.Loan
	Recalculated bool
	LoanStatus   string
}

// LoanListFilter acota la consulta de /loans a los casos de uso de la UI:
// panel por estado, filtro por acreedor y paginación. Mantenerlo
// explícito evita que la capa de persistencia reciba structs libres.
type LoanListFilter struct {
	Status     string // "", "ACTIVE", "PAID", "DEFAULTED", "CANCELLED"
	LenderName string // match parcial case-insensitive
	LenderDNI  string // match exacto
	SupplierID *uint  // match exacto si se provee
	Limit      int    // máx 500
	Offset     int    // >=0
}

// LoanWithStatsRow es la proyección usada por el dashboard: un préstamo
// más los agregados que la UI pinta sin recargar las cuotas en memoria.
// `TotalPayable` y `RemainingBalance` provienen directo de las columnas
// de `loans`; `TotalDue`/`TotalPaid` se calculan desde `loan_installments`
// como control cruzado para la UI (deben coincidir con las columnas).
type LoanWithStatsRow struct {
	Loan              models.Loan `json:"loan"`
	TotalPayable      float64     `json:"totalPayable"`
	RemainingBalance  float64     `json:"remainingBalance"`
	TotalDue          float64     `json:"totalDue"`
	TotalPaid         float64     `json:"totalPaid"`
	OutstandingDue    float64     `json:"outstandingDue"`
	NextDueDate       *string     `json:"nextDueDate,omitempty"`
	NextDueAmount     float64     `json:"nextDueAmount"`
	InstallmentsPaid  int         `json:"installmentsPaid"`
	InstallmentsTotal int         `json:"installmentsTotal"`
	PrincipalUsed     float64     `json:"principalUsed"`
	// Available es `principalAmount - principalUsed` clampado a 0, para
	// que el frontend no repita la resta en cada tarjeta. `liveLoanAvailable`
	// en el front ya consume `principalUsed`; `Available` es azúcar para la
	// pantalla y para el endpoint de pay-expense cuando confirma el pago.
	Available float64 `json:"available"`
}

// PayInstallmentAtomicInput es TODA la información que el servicio pasa
// al repo para registrar un pago. El repositorio hace Expense + cuota +
// loan en una SOLA transacción con locks pesimistas. El servicio ya
// validó montos, canal, breakdown, actor y strings.
type PayInstallmentAtomicInput struct {
	// Identificación lógica de la cuota (NO es su PK autoincremental).
	Number int

	// Monto financiero del pago (ya redondeado a 2 decimales).
	Amount float64

	// Desglose por canal. La suma debe empatar con Amount (±1 centavo);
	// el servicio ya lo validó.
	CashAmount      float64
	NequiAmount     float64
	DaviplataAmount float64
	FondoAmount     float64
	CoinsAmount     float64

	// Metadatos para el Expense que se crea dentro de la transacción.
	PaymentSource string    // canal "primario" (EFECTIVO, NEQUI, ...)
	Description   string    // texto para el Expense
	Category      string    // normalmente "Préstamos"
	PaidAt        time.Time // momento del pago (zona Bogotá)
	ActorDNI      string    // dueño del movimiento
	ClientTxID    string    // opcional; se registra en el log de auditoría del servicio
}

// PayInstallmentAtomicOutcome es lo que devuelve el repo al servicio
// tras un pago exitoso.
type PayInstallmentAtomicOutcome struct {
	Installment      *models.LoanInstallment
	ExpenseID        uint
	LoanStatus       string
	RemainingBalance float64 // tras aplicar el pago, clamp 0
	AppliedAmount    float64 // monto efectivamente aplicado a la cuota
}

// PayExpenseAtomicInput es el payload del endpoint "pagar un egreso con la
// plata del préstamo" (POST /api/loans/:id/pay-expense). Combina dos
// variantes:
//
//   - Con `ExpenseID != nil`: abona/salda una deuda existente. El repo
//     bloquea la fila original, descuenta `remaining_amount`, cambia a
//     SETTLED si el saldo llega a 0 y crea un expense "ABONO A DEUDA".
//   - Con `ExpenseID == nil`: crea un gasto nuevo pagado con la plata del
//     préstamo. `Description` es obligatorio; `Category` cae a "Otros
//     Gastos" si viene vacío.
//
// Independiente de la variante, el Expense resultante queda SIEMPRE con:
//   - `Status = "PAID"`
//   - `PaymentSource = "PRESTAMO"`
//   - `CashAmount/NequiAmount/DaviplataAmount/FondoAmount/CoinsAmount = 0`
//   - `PaidAmount = Amount`, `RemainingAmount = 0`
//   - `Date = PaidAt`, `CreatedByDNI = ActorDNI`.
//
// El repo también valida contra el disponible del préstamo
// (`principal - SUM(amount_used)`) e inserta la fila `loan_expenses` en la
// MISMA transacción.
type PayExpenseAtomicInput struct {
	ExpenseID   *uint   // nil = crear expense nuevo; valor = abonar/saldar deuda existente
	Amount      float64 // monto en pesos (ya redondeado a 2 decimales)
	Description string  // obligatorio cuando ExpenseID == nil
	Category    string  // default "Otros Gastos" cuando viene vacío
	SupplierID  *uint   // opcional; solo se usa cuando ExpenseID == nil
	Purpose     string  // texto para loan_expenses.purpose; si vacío, cae a Description
	PaidAt      time.Time
	ActorDNI    string
}

// PayExpenseAtomicOutcome resume el resultado para que el handler arme la
// respuesta 201 sin volver a tocar la BD.
type PayExpenseAtomicOutcome struct {
	Expense        *models.Expense     // egreso creado (abono o nuevo)
	UpdatedDebt    *models.Expense     // deuda original tras el abono (nil cuando no aplica)
	LoanExpense    *models.LoanExpense // fila de bitácora `loan_expenses`
	AppliedAmount  float64             // monto efectivamente aplicado (recortado al remaining si es abono)
	TotalUsedAfter float64             // SUM(amount_used) tras el commit
	Available      float64             // principal - TotalUsedAfter, clamp 0
}

// LoanRepository agrupa toda la persistencia del módulo. Las operaciones
// financieras usan transacciones + locks dentro del propio repositorio
// para que el servicio pueda invocarlas sin conocer GORM.
type LoanRepository interface {
	// CreateLoanWithSchedule inserta el loan + todas sus cuotas en una
	// única transacción. El servicio ya construyó el cronograma, fijó
	// `TotalPayable` y `RemainingBalance` en el modelo y lo pasa aquí
	// para persistirlo.
	CreateLoanWithSchedule(ctx context.Context, loan *models.Loan, schedule []models.LoanInstallment) error

	// GetByID devuelve el préstamo (sin cuotas ni expenses). Si no
	// existe o está soft-deleted retorna ErrLoanNotFound.
	GetByID(ctx context.Context, id uint) (*models.Loan, error)

	// GetByIDWithRelations carga también las cuotas (ordenadas por
	// number ASC) y los loan_expenses (ordenados por created_at DESC).
	GetByIDWithRelations(ctx context.Context, id uint) (*models.Loan, error)

	// ListWithStats devuelve filas enriquecidas para el dashboard.
	ListWithStats(ctx context.Context, filter LoanListFilter) ([]LoanWithStatsRow, int64, error)

	// PayInstallmentAtomic es el camino financiero crítico:
	//
	//   1. BEGIN
	//   2. SELECT ... FOR UPDATE sobre `loans` (lock del préstamo).
	//   3. SELECT ... FOR UPDATE sobre `loan_installments` por
	//      (loan_id, number) — bloquea pagos concurrentes de la MISMA
	//      cuota.
	//   4. Si la cuota ya está PAID → ROLLBACK con ErrInstallmentAlreadyPaid.
	//      Es la respuesta idempotente: NUNCA se crea un Expense si la
	//      cuota ya estaba liquidada.
	//   5. INSERT en `expenses` con status='PAID' y canal real (no
	//      'PRESTAMO'). El repo lo crea DENTRO de la transacción.
	//   6. UPDATE `loan_installments`: paid_amount, paid_at,
	//      settlement_expense_id, status='PAID'.
	//   7. UPDATE `loans.remaining_balance` restando el aplicado
	//      (clamp 0) y status='PAID' si todas las cuotas quedaron
	//      liquidadas (preservando CANCELLED/DEFAULTED).
	//   8. COMMIT.
	//
	// Si CUALQUIER paso falla, la transacción se revierte entera y
	// ningún Expense queda huérfano.
	PayInstallmentAtomic(ctx context.Context, loanID uint, input PayInstallmentAtomicInput) (*PayInstallmentAtomicOutcome, error)

	// RegisterLoanExpense inserta la fila loan_expenses dentro de una
	// transacción con SELECT ... FOR UPDATE sobre el loan y verifica
	// que SUM(amount_used) + nuevo <= principal_amount. Si no cuadra
	// retorna ErrPrincipalExceeded. Devuelve el total usado tras el
	// INSERT (para la UI).
	RegisterLoanExpense(ctx context.Context, exp *models.LoanExpense) (totalUsedAfter float64, err error)

	// PayExpenseAtomic implementa el endpoint
	//   POST /api/loans/:id/pay-expense
	// en una ÚNICA transacción con locks pesimistas:
	//
	//   1. BEGIN.
	//   2. SELECT ... FOR UPDATE sobre `loans`. ErrLoanNotFound si no
	//      existe/soft-deleted. ErrLoanNotActive si status ∉
	//      {ACTIVE, DEFAULTED}.
	//   3. SUM(amount_used) actual. Si `applied > principal - SUM` retorna
	//      ErrPrincipalExceeded (con tolerancia 1 centavo).
	//   4. Si `in.ExpenseID != nil`: SELECT ... FOR UPDATE sobre el
	//      expense; valida que sea "pagable" (PENDING o PRESTAMO/PREST.
	//      no SETTLED). Calcula `applied = min(Amount, remaining)` y
	//      actualiza la deuda original (paid_amount, remaining_amount,
	//      status=SETTLED si remaining llega a 0). Inserta un expense
	//      nuevo "ABONO A DEUDA: {desc original}" con PaymentSource
	//      PRESTAMO, status PAID y canales en 0.
	//   5. Si `in.ExpenseID == nil`: inserta un expense nuevo con la
	//      descripción indicada, categoría por defecto "Otros Gastos" y
	//      los campos del contrato.
	//   6. INSERT INTO loan_expenses con expense_id = id del egreso
	//      creado y amount_used = applied.
	//   7. COMMIT.
	//
	// Si CUALQUIER paso falla, ROLLBACK total: ni egreso creado, ni abono
	// de deuda, ni fila en loan_expenses. El Expense PRESTAMO queda
	// EXPLÍCITAMENTE fuera de cualquier arqueo/cuadre (ver reglas en
	// `models.IsLoanFundedExpense`).
	PayExpenseAtomic(ctx context.Context, loanID uint, input PayExpenseAtomicInput) (*PayExpenseAtomicOutcome, error)

	// RecalculateStatus consulta las cuotas y recalcula loan.status.
	// Útil para un job diario o reparar tras una edición manual.
	RecalculateStatus(ctx context.Context, loanID uint) (string, error)

	// UpdateLoanAtomic edita un préstamo en UNA transacción con locks
	// pesimistas:
	//
	//   1. BEGIN.
	//   2. SELECT ... FOR UPDATE sobre `loans`. ErrLoanNotFound si no
	//      existe/soft-deleted.
	//   3. Aplica SIEMPRE la metadata editable y el snapshot/cuota oficial.
	//   4. Si in.StartDate != nil, valida contra MIN(due_date) del
	//      cronograma (ErrLoanStartDateAfterInstallments si quedaría
	//      después de una cuota ya programada).
	//   5. Si in.Recalculate:
	//        a. COUNT cuotas con paid_amount > 0 (FOR UPDATE). Si > 0 →
	//           ErrLoanHasPaidInstallments (ROLLBACK; no se toca nada).
	//        b. SUM(amount_used activo) con FOR UPDATE sobre loan_expenses.
	//           Si NewPrincipalAmount < SUM → ErrLoanPrincipalBelowUsage.
	//        c. DELETE FROM loan_installments WHERE loan_id = ? e inserta
	//           NewSchedule. loan_expenses queda INTACTO (no tiene FK a
	//           cuotas): nunca se pierde el uso del principal.
	//        d. UPDATE loans con los campos financieros nuevos +
	//           remaining_balance = total_payable (no había pagos).
	//   6. RecalculateStatus dentro de la misma tx (preserva CANCELLED).
	//   7. COMMIT.
	//
	// Si CUALQUIER paso falla, ROLLBACK total: ni metadata, ni cronograma.
	UpdateLoanAtomic(ctx context.Context, loanID uint, input UpdateLoanAtomicInput) (*UpdateLoanAtomicOutcome, error)

	// SoftDelete anula lógicamente el préstamo. El repo valida que no
	// haya pagos registrados; si los hay, aborta.
	SoftDelete(ctx context.Context, loanID uint) error
}

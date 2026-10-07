// Package models — tipos del módulo avanzado de Préstamos.
//
// IMPORTANTE: estos modelos NO forman parte de schemaModels() en
// migrations/catalog.go. Las tablas físicas las crea exclusivamente la
// migración `019_loans_module.sql`. Mantenerlos fuera de schemaModels
// protege el checksum de la migración 002 (model_schema) y respeta la
// política del runner: la BD la mutan sólo migraciones explícitas
// durante una ventana aprobada. Mismo patrón que labels.go (016) y
// package_barcode_alias.go (017).
//
// Mapping snake_case ↔ Go sigue la convención GORM: las columnas tienen
// `column:` explícito para que un refactor de nombres de campo no mueva
// la columna por accidente.
//
// POR QUÉ ESTOS MODELOS SON NUEVOS Y NO EXTENDEMOS Expense
// =========================================================================
// El POS confunde "deuda" en dos sentidos: fiado del cliente (sales.debtPending)
// y deuda del negocio (expenses con status='PENDING' o paymentSource='PRESTAMO').
// Esa convención en expenses no permite cronograma, interés ni control de uso
// del principal. El módulo nuevo entra como esquema propio con constraints a
// nivel BD. La convivencia con los expenses legacy la detalla la migración 019
// en su cabecera.
package models

import (
	"encoding/json"
	"math"
	"time"

	"gorm.io/gorm"
)

// Enum values. Mantenerlos como constantes exportadas facilita las
// comparaciones en handlers/servicios y evita literales sueltos.
//
// MODOS DE INTERÉS SOPORTADOS EN EL CONTRATO ACTUAL
// =========================================================================
// NONE, SIMPLE y FRENCH. La columna interest_rate_pct conserva su
// semántica histórica: en SIMPLE representa el porcentaje FLAT TOTAL;
// en FRENCH la tasa que se usa para amortizar vive en
// annual_effective_rate_pct (EA, Efectiva Anual). FRENCH se agregó en
// el sprint 14 con la migración 021 y NO reinterpreta los préstamos
// NONE/SIMPLE ya creados.
const (
	// InterestModeNone — préstamo sin interés. La tasa debe ser 0.
	// total_payable = principal, remaining_balance = principal al crear.
	InterestModeNone = "NONE"
	// InterestModeSimple — interés simple FLAT TOTAL aplicado una vez
	// sobre el principal (no es tasa nominal anual):
	//     total_payable = principal * (1 + interestRatePct / 100)
	// Las cuotas son iguales (el residuo lo absorbe la última).
	InterestModeSimple = "SIMPLE"
	// InterestModeFrench — Sistema Francés sobre tasa Efectiva Anual
	// (EA, almacenada en loans.annual_effective_rate_pct). La conversión
	// a tasa mensual es
	//     i_m = (1 + annual_effective_rate_pct/100)^(1/12) - 1
	// y la cuota base es
	//     base = P * i_m * (1+i_m)^n / ((1+i_m)^n - 1)
	// Para el caso de referencia P=25.000.000, n=60, EA=21.3% (i_m≈1.62%)
	// la base ≈ 655.300. FRENCH fuerza frecuencia MONTHLY y acepta dos
	// extras (loans.monthly_insurance_amount fijo por cuota y
	// loans.fga_total_amount diferido entre todas las cuotas) que viven
	// en loan_installments.insurance_due y loan_installments.fga_due.
	InterestModeFrench = "FRENCH"

	// PaymentFrequencyWeekly, Biweekly, Monthly — periodicidad entre
	// cuotas. El servicio Go calcula due_date usando America/Bogota para
	// evitar off-by-one de zona horaria.
	PaymentFrequencyWeekly   = "WEEKLY"
	PaymentFrequencyBiweekly = "BIWEEKLY"
	PaymentFrequencyMonthly  = "MONTHLY"

	// LoanStatusActive — con saldo pendiente, cuotas por pagar.
	LoanStatusActive = "ACTIVE"
	// LoanStatusPaid — todas las cuotas liquidadas.
	LoanStatusPaid = "PAID"
	// LoanStatusDefaulted — en mora reconocida por admin.
	LoanStatusDefaulted = "DEFAULTED"
	// LoanStatusCancelled — anulado administrativamente.
	LoanStatusCancelled = "CANCELLED"

	// InstallmentStatusPending — sin pago.
	InstallmentStatusPending = "PENDING"
	// InstallmentStatusPartial — pago parcial. Se mantiene como estado
	// posible en el schema por si en el futuro se admite abono parcial;
	// el contrato actual del servicio Go sólo acepta pago completo de
	// la cuota (tolerancia 1 centavo).
	InstallmentStatusPartial = "PARTIAL"
	// InstallmentStatusPaid — cuota saldada.
	InstallmentStatusPaid = "PAID"
	// InstallmentStatusLate — vencida sin saldar.
	InstallmentStatusLate = "LATE"
)

// Loan representa un préstamo recibido por el negocio.
//
// Las columnas monetarias son NUMERIC(14,2) en Postgres y se mapean a
// float64 porque el resto del POS maneja dinero así (expenses,
// sales…). El servicio hace redondeo explícito a 2 decimales en
// cada frontera: la aritmética de cuotas corre en centavos (int64)
// dentro de BuildLoanSchedule.
//
// `TotalPayable` y `RemainingBalance` existen a nivel columna (NUMERIC)
// desde la migración 019. El servicio los persiste al crear el préstamo
// con el `preview.TotalPayable`, y los actualiza en la MISMA transacción
// que registra cada pago para que el dashboard pueda leer "cuentas por
// pagar" en una sola fila sin agregar sobre loan_installments.
type Loan struct {
	ID                  uint      `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	LenderName          string    `gorm:"column:lender_name;type:varchar(120);not null" json:"lenderName"`
	LenderDNI           string    `gorm:"column:lender_dni;type:varchar(32)" json:"lenderDni,omitempty"`
	SupplierID          *uint     `gorm:"column:supplier_id" json:"supplierId,omitempty"`
	Supplier            *Supplier `gorm:"foreignKey:SupplierID;references:ID" json:"supplier,omitempty"`
	PrincipalAmount     float64   `gorm:"column:principal_amount;type:numeric(14,2);not null" json:"principalAmount"`
	InterestRatePct     float64   `gorm:"column:interest_rate_pct;type:numeric(7,3);not null;default:0" json:"interestRatePct"`
	InterestMode        string    `gorm:"column:interest_mode;type:varchar(16);not null;default:'SIMPLE'" json:"interestMode"`
	TermCount           int       `gorm:"column:term_count;not null" json:"termCount"`
	PaymentFrequency    string    `gorm:"column:payment_frequency;type:varchar(16);not null;default:'MONTHLY'" json:"paymentFrequency"`
	StartDate           time.Time `gorm:"column:start_date;type:date;not null" json:"startDate"`
	FirstPaymentDate    time.Time `gorm:"column:first_payment_date;type:date;not null" json:"firstPaymentDate"`
	DisbursementChannel string    `gorm:"column:disbursement_channel;type:varchar(32);not null;default:'EFECTIVO'" json:"disbursementChannel"`
	Status              string    `gorm:"column:status;type:varchar(16);not null;default:'ACTIVE'" json:"status"`
	TotalPayable        float64   `gorm:"column:total_payable;type:numeric(14,2);not null;default:0" json:"totalPayable"`
	RemainingBalance    float64   `gorm:"column:remaining_balance;type:numeric(14,2);not null;default:0" json:"remainingBalance"`
	// Campos del modo FRENCH (migración 021). En NONE/SIMPLE quedan en 0
	// por el DEFAULT de la BD, así que el JSON expuesto es consistente
	// para los tres modos sin romper clientes existentes.
	//
	// AnnualEffectiveRatePct — tasa Efectiva Anual porcentual que se
	//    usa SÓLO en FRENCH para derivar la tasa mensual
	//    `i_m = (1 + annual_effective_rate_pct/100)^(1/12) - 1`.
	//    En NONE/SIMPLE queda en 0; la tasa flat vive en InterestRatePct.
	// MonthlyInsuranceAmount — seguro MENSUAL fijo cobrado por la
	//    entidad. Se replica igual en cada cuota (no se difiere).
	// FgaTotalAmount — FGA (Fondo de Garantías) TOTAL cobrado al
	//    desembolso. El servicio lo DIFIERE entre todas las cuotas.
	// MonthlyFgaAmount — FGA mensual = FgaTotalAmount / TermCount
	//    (redondeado a 2 decimales; el residuo lo absorbe la última
	//    cuota en loan_installments.fga_due).
	// BaseInstallmentAmount — cuota base del Sistema Francés
	//    P * i_m * (1+i_m)^n / ((1+i_m)^n - 1), redondeada a centavos.
	AnnualEffectiveRatePct float64 `gorm:"column:annual_effective_rate_pct;type:numeric(9,6);not null;default:0" json:"annualEffectiveRatePct"`
	MonthlyInsuranceAmount float64 `gorm:"column:monthly_insurance_amount;type:numeric(14,2);not null;default:0" json:"monthlyInsurance"`
	FgaTotalAmount         float64 `gorm:"column:fga_total_amount;type:numeric(14,2);not null;default:0" json:"fgaTotal"`
	MonthlyFgaAmount       float64 `gorm:"column:monthly_fga_amount;type:numeric(14,2);not null;default:0" json:"monthlyFga"`
	BaseInstallmentAmount  float64 `gorm:"column:base_installment_amount;type:numeric(14,2);not null;default:0" json:"baseInstallment"`

	// Metadata bancaria editable (migración 023). NO alimenta el cálculo
	// contable interno; se persiste para que el PUT /api/loans/:id la
	// pueda rellenar y la UI reproduzca el extracto del banco.
	//
	// Campos nullable usan punteros para que el JSON serialice `null`
	// cuando el admin no haya editado todavía el préstamo heredado.
	CreditNumber               *string    `gorm:"column:credit_number;type:varchar(64)" json:"creditNumber,omitempty"`
	LoanType                   string     `gorm:"column:loan_type;type:varchar(16);not null;default:'OTRO'" json:"loanType"`
	HolderName                 *string    `gorm:"column:holder_name;type:varchar(160)" json:"holderName,omitempty"`
	HolderDNI                  *string    `gorm:"column:holder_dni;type:varchar(32)" json:"holderDni,omitempty"`
	Currency                   string     `gorm:"column:currency;type:varchar(8);not null;default:'COP'" json:"currency"`
	RateType                   string     `gorm:"column:rate_type;type:varchar(16);not null;default:'FIJO'" json:"rateType"`
	AutoDebit                  bool       `gorm:"column:auto_debit;not null;default:false" json:"autoDebit"`
	MaturityDate               *time.Time `gorm:"column:maturity_date;type:date" json:"maturityDate,omitempty"`
	LateAnnualEffectiveRatePct float64    `gorm:"column:late_annual_effective_rate_pct;type:numeric(9,6);not null;default:0" json:"lateAnnualEffectiveRatePct"`
	NetDisbursementAmount      *float64   `gorm:"column:net_disbursement_amount;type:numeric(14,2)" json:"netDisbursementAmount,omitempty"`
	FgaIvaAmount               float64    `gorm:"column:fga_iva_amount;type:numeric(14,2);not null;default:0" json:"fgaIvaAmount"`
	FgaGmfAmount               float64    `gorm:"column:fga_gmf_amount;type:numeric(14,2);not null;default:0" json:"fgaGmfAmount"`

	// Snapshot del banco (trío atado por CHECK ck_loans_bank_snapshot_coherent).
	// NUNCA se reconcilia automáticamente contra RemainingBalance.
	BankBalanceAmount *float64   `gorm:"column:bank_balance_amount;type:numeric(14,2)" json:"bankBalanceAmount,omitempty"`
	BankBalanceAsOf   *time.Time `gorm:"column:bank_balance_as_of" json:"bankBalanceAsOf,omitempty"`
	BankPaidAmount    *float64   `gorm:"column:bank_paid_amount;type:numeric(14,2)" json:"bankPaidAmount,omitempty"`

	// Próxima cuota oficial reportada por el banco (par atado). Dato
	// autoritativo que la UI muestra encima del cronograma estimado.
	OfficialNextInstallmentAmount *float64   `gorm:"column:official_next_installment_amount;type:numeric(14,2)" json:"officialNextInstallmentAmount,omitempty"`
	OfficialNextInstallmentDate   *time.Time `gorm:"column:official_next_installment_date;type:date" json:"officialNextInstallmentDate,omitempty"`

	Note         string         `gorm:"column:note;type:text" json:"note,omitempty"`
	CreatedByDNI string         `gorm:"column:created_by_dni;type:varchar(32);not null" json:"createdByDni"`
	CreatedAt    time.Time      `gorm:"column:created_at;not null;default:now()" json:"createdAt"`
	UpdatedAt    time.Time      `gorm:"column:updated_at;not null;default:now()" json:"updatedAt"`
	DeletedAt    gorm.DeletedAt `gorm:"column:deleted_at;index" json:"-"`

	// Relaciones opcionales — se cargan con Preload cuando el consumidor
	// las pide. No participan en INSERT/UPDATE del préstamo.
	Installments []LoanInstallment `gorm:"foreignKey:LoanID;references:ID" json:"installments,omitempty"`
	Expenses     []LoanExpense     `gorm:"foreignKey:LoanID;references:ID" json:"expenses,omitempty"`
}

// TableName fija la tabla física creada por la migración 019.
func (Loan) TableName() string { return "loans" }

// LoanInstallment representa una cuota del cronograma.
//
// `PrincipalDue + InterestDue + InsuranceDue + FgaDue` es el total
// esperado por cuota. En SIMPLE y NONE los dos últimos quedan en 0 por
// el DEFAULT de la BD, así que la fórmula se reduce a la histórica
// (principal + interés). En FRENCH el seguro mensual y el FGA diferido
// se persisten explícitamente por cuota para que los reportes offline y
// los recálculos nocturnos no diverjan de lo que ve el usuario.
//
// `PaidAmount` es acumulador. El contrato de servicio actual exige pago
// completo de la cuota (tolerancia 1 centavo) y por lo tanto, en la
// práctica, `PaidAmount` sólo pasa de 0 a `TotalDue` de golpe. Se mantiene
// como acumulador por compatibilidad con el schema y para no cerrar la
// puerta a abonos parciales en un futuro contrato.
type LoanInstallment struct {
	ID           uint      `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	LoanID       uint      `gorm:"column:loan_id;not null;index" json:"loanId"`
	Number       int       `gorm:"column:number;not null" json:"number"`
	DueDate      time.Time `gorm:"column:due_date;type:date;not null" json:"dueDate"`
	PrincipalDue float64   `gorm:"column:principal_due;type:numeric(14,2);not null" json:"principalDue"`
	InterestDue  float64   `gorm:"column:interest_due;type:numeric(14,2);not null;default:0" json:"interestDue"`
	// InsuranceDue — seguro mensual que corresponde a la cuota. En
	// NONE/SIMPLE queda en 0 (DEFAULT en BD); en FRENCH es igual a
	// loans.monthly_insurance_amount en todas las cuotas.
	InsuranceDue float64 `gorm:"column:insurance_due;type:numeric(14,2);not null;default:0" json:"insuranceDue"`
	// FgaDue — FGA diferido que corresponde a la cuota. En NONE/SIMPLE
	// queda en 0 (DEFAULT en BD); en FRENCH es ≈ loans.monthly_fga_amount
	// salvo la última cuota, que absorbe el residuo de redondeo para que
	// SUM(fga_due) = loans.fga_total_amount al centavo.
	FgaDue float64 `gorm:"column:fga_due;type:numeric(14,2);not null;default:0" json:"fgaDue"`
	// Balance — saldo de capital DESPUÉS de esta cuota. Sólo lo llena el
	// cronograma FRENCH en memoria (preview/creación); NO se persiste
	// (gorm:"-") y se omite del JSON cuando es nil (filas leídas de BD).
	Balance             *float64   `gorm:"-" json:"balance,omitempty"`
	PaidAmount          float64    `gorm:"column:paid_amount;type:numeric(14,2);not null;default:0" json:"paidAmount"`
	PaidAt              *time.Time `gorm:"column:paid_at" json:"paidAt,omitempty"`
	SettlementExpenseID *uint      `gorm:"column:settlement_expense_id" json:"settlementExpenseId,omitempty"`
	Status              string     `gorm:"column:status;type:varchar(16);not null;default:'PENDING'" json:"status"`
	CreatedAt           time.Time  `gorm:"column:created_at;not null;default:now()" json:"createdAt"`
	UpdatedAt           time.Time  `gorm:"column:updated_at;not null;default:now()" json:"updatedAt"`
}

// TableName fija la tabla física creada por la migración 019.
func (LoanInstallment) TableName() string { return "loan_installments" }

// TotalDue es la cuota total esperada (principal + interés + seguro +
// FGA). Se expone por conveniencia del frontend; no se persiste porque
// la migración 019 no usa columnas generadas por consistencia estilística
// con el resto del catálogo.
func (li LoanInstallment) TotalDue() float64 {
	return li.PrincipalDue + li.InterestDue + li.InsuranceDue + li.FgaDue
}

// RemainingDue indica cuánto falta por pagar en la cuota (nunca negativo).
func (li LoanInstallment) RemainingDue() float64 {
	rem := li.TotalDue() - li.PaidAmount
	if rem < 0 {
		return 0
	}
	return rem
}

// MarshalJSON agrega `totalDue` (principal + interés + seguro + FGA,
// redondeado a centavos) al JSON de la cuota. El detalle del frontend lo
// usa para el saldo de cada cuota y para el monto exacto a pagar; sin él
// la UI mostraba $0. Aditivo: los demás campos no cambian.
func (li LoanInstallment) MarshalJSON() ([]byte, error) {
	type installmentAlias LoanInstallment
	return json.Marshal(struct {
		installmentAlias
		TotalDue float64 `json:"totalDue"`
	}{
		installmentAlias: installmentAlias(li),
		TotalDue:         math.Round(li.TotalDue()*100) / 100,
	})
}

// LoanExpense registra un uso del principal del préstamo. Lo asocia a un
// expense físico (soft FK) cuando aplica, con el monto consumido del
// principal (puede diferir de expenses.amount si una parte se cubrió con
// otra fuente).
//
// La invariante `SUM(amount_used) <= loans.principal_amount` la impone el
// servicio Go con `SELECT ... FOR UPDATE` sobre el loan dentro de la
// transacción del INSERT. Los CHECKs de Postgres no soportan subconsultas,
// por eso vive en el servicio.
type LoanExpense struct {
	ID           uint      `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	LoanID       uint      `gorm:"column:loan_id;not null;index" json:"loanId"`
	ExpenseID    *uint     `gorm:"column:expense_id" json:"expenseId,omitempty"`
	AmountUsed   float64   `gorm:"column:amount_used;type:numeric(14,2);not null" json:"amountUsed"`
	Purpose      string    `gorm:"column:purpose;type:varchar(255)" json:"purpose,omitempty"`
	CreatedByDNI string    `gorm:"column:created_by_dni;type:varchar(32);not null" json:"createdByDni"`
	CreatedAt    time.Time `gorm:"column:created_at;not null;default:now()" json:"createdAt"`

	// Traza de pago de una deuda existente (migración 022). SourceExpenseID
	// es nil cuando el préstamo financia un egreso nuevo. Los snapshots
	// permiten auditar el estado anterior; la reversión usa el delta para no
	// borrar abonos posteriores hechos a la misma deuda.
	SourceExpenseID       *uint      `gorm:"column:source_expense_id" json:"sourceExpenseId,omitempty"`
	SourceStatusBefore    *string    `gorm:"column:source_status_before;type:varchar(20)" json:"sourceStatusBefore,omitempty"`
	SourcePaidBefore      *float64   `gorm:"column:source_paid_before;type:numeric(14,2)" json:"sourcePaidBefore,omitempty"`
	SourceRemainingBefore *float64   `gorm:"column:source_remaining_before;type:numeric(14,2)" json:"sourceRemainingBefore,omitempty"`
	ReversedAt            *time.Time `gorm:"column:reversed_at" json:"reversedAt,omitempty"`
	ReversedByDNI         string     `gorm:"column:reversed_by_dni;type:varchar(32)" json:"reversedByDni,omitempty"`
	// OrphanedPayment se calcula al cargar el detalle: true cuando el
	// expense de pago fue soft-deleted antes de existir la reversión 022.
	OrphanedPayment bool `gorm:"-" json:"orphanedPayment,omitempty"`
}

// TableName fija la tabla física creada por la migración 019.
func (LoanExpense) TableName() string { return "loan_expenses" }

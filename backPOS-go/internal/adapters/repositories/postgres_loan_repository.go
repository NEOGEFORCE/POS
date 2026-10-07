// Repositorio PostgreSQL del módulo de Préstamos (migración 019).
//
// RESPONSABILIDAD DE ESTA CAPA:
//
//   - Persistir Loan + LoanInstallment en una transacción.
//   - PayInstallmentAtomic: BEGIN, lock de fila sobre el loan y la
//     cuota (loan_id, number), crear Expense (status='PAID'), actualizar
//     cuota + loans.remaining_balance + loans.status en la MISMA
//     transacción. Si cualquier paso falla, ROLLBACK total: jamás queda
//     un Expense huérfano.
//   - RegisterLoanExpense: SELECT ... FOR UPDATE sobre el loan +
//     SUM(amount_used) + INSERT en la misma transacción. Si la nueva
//     suma supera el principal, abortar con ErrPrincipalExceeded.
//   - ListWithStats: una sola consulta con subselects agregados por
//     préstamo para que el dashboard no haga N+1.
//
// NUNCA hace: emitir eventos SSE, invalidar cache o llamar auditoría.
// Esas responsabilidades viven en el servicio.
package repositories

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// PostgresLoanRepository implementa ports.LoanRepository.
type PostgresLoanRepository struct {
	db *gorm.DB
}

// NewPostgresLoanRepository crea el repo. La conexión se inyecta para
// facilitar las pruebas con un driver fake.
func NewPostgresLoanRepository(db *gorm.DB) *PostgresLoanRepository {
	return &PostgresLoanRepository{db: db}
}

// Verificar en compile time que satisface el port.
var _ ports.LoanRepository = (*PostgresLoanRepository)(nil)

// =========================================================================
// CreateLoanWithSchedule
// =========================================================================

// CreateLoanWithSchedule inserta el loan y todas sus cuotas en una
// transacción. El servicio ya pobló `TotalPayable` y `RemainingBalance`
// con `preview.TotalPayable`; aquí sólo persistimos.
func (r *PostgresLoanRepository) CreateLoanWithSchedule(ctx context.Context, loan *models.Loan, schedule []models.LoanInstallment) error {
	if loan == nil {
		return errors.New("loan nulo")
	}
	if len(schedule) == 0 {
		return errors.New("cronograma vacío")
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1) El préstamo.
		if err := tx.Create(loan).Error; err != nil {
			return fmt.Errorf("insert loan: %w", err)
		}
		// 2) Las cuotas con loan_id poblado. Insert en batch de 100 para
		//    préstamos con cronogramas grandes (hasta 600 cuotas).
		for i := range schedule {
			schedule[i].LoanID = loan.ID
		}
		if err := tx.CreateInBatches(schedule, 100).Error; err != nil {
			return fmt.Errorf("insert installments: %w", err)
		}
		return nil
	})
}

// =========================================================================
// GetByID / GetByIDWithRelations
// =========================================================================

// GetByID retorna el préstamo sin relaciones. ErrLoanNotFound si no existe
// o está soft-deleted.
func (r *PostgresLoanRepository) GetByID(ctx context.Context, id uint) (*models.Loan, error) {
	var loan models.Loan
	err := r.db.WithContext(ctx).Where("id = ?", id).First(&loan).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ports.ErrLoanNotFound
	}
	if err != nil {
		return nil, err
	}
	return &loan, nil
}

// GetByIDWithRelations carga el préstamo, sus cuotas (ordenadas) y sus
// usos del principal (ordenados).
func (r *PostgresLoanRepository) GetByIDWithRelations(ctx context.Context, id uint) (*models.Loan, error) {
	var loan models.Loan
	err := r.db.WithContext(ctx).
		Preload("Installments", func(tx *gorm.DB) *gorm.DB { return tx.Order("number ASC") }).
		Preload("Expenses", func(tx *gorm.DB) *gorm.DB {
			return tx.Where("reversed_at IS NULL").Order("created_at DESC")
		}).
		Preload("Supplier").
		Where("id = ?", id).First(&loan).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ports.ErrLoanNotFound
	}
	if err != nil {
		return nil, err
	}

	// Detectar en una sola consulta usos cuyo expense de pago ya fue
	// eliminado. Son pagos pre-022: siguen consumiendo principal y requieren
	// la acción admin "Reparar pago eliminado".
	expenseIDs := make([]uint, 0, len(loan.Expenses))
	for i := range loan.Expenses {
		if loan.Expenses[i].ExpenseID != nil {
			expenseIDs = append(expenseIDs, *loan.Expenses[i].ExpenseID)
		}
	}
	if len(expenseIDs) > 0 {
		var activeIDs []uint
		if err := r.db.WithContext(ctx).Model(&models.Expense{}).
			Where("id IN ?", expenseIDs).Pluck("id", &activeIDs).Error; err != nil {
			return nil, err
		}
		active := make(map[uint]struct{}, len(activeIDs))
		for _, expenseID := range activeIDs {
			active[expenseID] = struct{}{}
		}
		for i := range loan.Expenses {
			if loan.Expenses[i].ExpenseID == nil {
				continue
			}
			_, exists := active[*loan.Expenses[i].ExpenseID]
			loan.Expenses[i].OrphanedPayment = !exists
		}
	}
	return &loan, nil
}

// =========================================================================
// ListWithStats
// =========================================================================

// listWithStatsSQL hace una sola consulta con subselects agregados por
// préstamo. Evita N+1. La parte "next due" calcula la próxima cuota
// pendiente (status<>'PAID') ordenada por number ASC.
//
// Decisión: `total_payable` y `remaining_balance` vienen directo de las
// columnas del préstamo. Los campos agregados (TotalDue/TotalPaid) se
// calculan de `loan_installments` como control cruzado para la UI
// (deben coincidir con las columnas; si no, la UI puede detectar drift).
//
// Para préstamos FRENCH la cuota real incluye seguro + FGA, así que los
// SUM que alimentan TotalDue y NextDueAmount también los suman. Para
// NONE/SIMPLE con DEFAULT 0 esas columnas no mueven el resultado.
const listWithStatsSQL = `
SELECT
    l.id                                                                  AS id,
    l.lender_name                                                         AS lender_name,
    l.lender_dni                                                          AS lender_dni,
    l.supplier_id                                                         AS supplier_id,
    l.principal_amount                                                    AS principal_amount,
    l.interest_rate_pct                                                   AS interest_rate_pct,
    l.interest_mode                                                       AS interest_mode,
    l.term_count                                                          AS term_count,
    l.payment_frequency                                                   AS payment_frequency,
    l.start_date                                                          AS start_date,
    l.first_payment_date                                                  AS first_payment_date,
    l.disbursement_channel                                                AS disbursement_channel,
    l.status                                                              AS status,
    l.total_payable                                                       AS total_payable,
    l.remaining_balance                                                   AS remaining_balance,
    l.annual_effective_rate_pct                                           AS annual_effective_rate_pct,
    l.monthly_insurance_amount                                            AS monthly_insurance_amount,
    l.fga_total_amount                                                    AS fga_total_amount,
    l.monthly_fga_amount                                                  AS monthly_fga_amount,
    l.base_installment_amount                                             AS base_installment_amount,
    l.credit_number                                                       AS credit_number,
    l.loan_type                                                           AS loan_type,
    l.holder_name                                                         AS holder_name,
    l.holder_dni                                                          AS holder_dni,
    l.currency                                                            AS currency,
    l.rate_type                                                           AS rate_type,
    l.auto_debit                                                          AS auto_debit,
    l.maturity_date                                                       AS maturity_date,
    l.late_annual_effective_rate_pct                                      AS late_annual_effective_rate_pct,
    l.net_disbursement_amount                                             AS net_disbursement_amount,
    l.fga_iva_amount                                                      AS fga_iva_amount,
    l.fga_gmf_amount                                                      AS fga_gmf_amount,
    l.bank_balance_amount                                                 AS bank_balance_amount,
    l.bank_balance_as_of                                                  AS bank_balance_as_of,
    l.bank_paid_amount                                                    AS bank_paid_amount,
    l.official_next_installment_amount                                    AS official_next_installment_amount,
    l.official_next_installment_date                                      AS official_next_installment_date,
    l.note                                                                AS note,
    l.created_by_dni                                                      AS created_by_dni,
    l.created_at                                                          AS created_at,
    l.updated_at                                                          AS updated_at,
    COALESCE((SELECT SUM(principal_due + interest_due + insurance_due + fga_due)
                FROM loan_installments li WHERE li.loan_id = l.id), 0)    AS total_due,
    COALESCE((SELECT SUM(paid_amount)
                FROM loan_installments li WHERE li.loan_id = l.id), 0)    AS total_paid,
    COALESCE((SELECT COUNT(*) FROM loan_installments li
                WHERE li.loan_id = l.id AND li.status = 'PAID'), 0)       AS installments_paid,
    COALESCE((SELECT COUNT(*) FROM loan_installments li
                WHERE li.loan_id = l.id), 0)                              AS installments_total,
    (SELECT TO_CHAR(li.due_date, 'YYYY-MM-DD') FROM loan_installments li
       WHERE li.loan_id = l.id AND li.status <> 'PAID'
       ORDER BY li.number ASC LIMIT 1)                                    AS next_due_date,
    COALESCE((SELECT (li.principal_due + li.interest_due + li.insurance_due + li.fga_due - li.paid_amount)
                FROM loan_installments li
               WHERE li.loan_id = l.id AND li.status <> 'PAID'
               ORDER BY li.number ASC LIMIT 1), 0)                        AS next_due_amount,
    COALESCE((SELECT SUM(amount_used) FROM loan_expenses le
                WHERE le.loan_id = l.id AND le.reversed_at IS NULL), 0)   AS principal_used
  FROM loans l
 WHERE l.deleted_at IS NULL
`

type listWithStatsRow struct {
	ID                            uint
	LenderName                    string
	LenderDNI                     string
	SupplierID                    *uint
	PrincipalAmount               float64
	InterestRatePct               float64
	InterestMode                  string
	TermCount                     int
	PaymentFrequency              string
	StartDate                     time.Time
	FirstPaymentDate              time.Time
	DisbursementChannel           string
	Status                        string
	TotalPayable                  float64
	RemainingBalance              float64
	AnnualEffectiveRatePct        float64
	MonthlyInsuranceAmount        float64
	FgaTotalAmount                float64
	MonthlyFgaAmount              float64
	BaseInstallmentAmount         float64
	CreditNumber                  *string
	LoanType                      string
	HolderName                    *string
	HolderDNI                     *string
	Currency                      string
	RateType                      string
	AutoDebit                     bool
	MaturityDate                  *time.Time
	LateAnnualEffectiveRatePct    float64
	NetDisbursementAmount         *float64
	FgaIvaAmount                  float64
	FgaGmfAmount                  float64
	BankBalanceAmount             *float64
	BankBalanceAsOf               *time.Time
	BankPaidAmount                *float64
	OfficialNextInstallmentAmount *float64
	OfficialNextInstallmentDate   *time.Time
	Note                          string
	CreatedByDNI                  string
	CreatedAt                     time.Time
	UpdatedAt                     time.Time
	TotalDue                      float64
	TotalPaid                     float64
	InstallmentsPaid              int
	InstallmentsTotal             int
	NextDueDate                   *string
	NextDueAmount                 float64
	PrincipalUsed                 float64
}

// ListWithStats devuelve la lista enriquecida. Soporta filtros simples
// y paginación. El total `count` reporta la cantidad sin paginar.
func (r *PostgresLoanRepository) ListWithStats(ctx context.Context, filter ports.LoanListFilter) ([]ports.LoanWithStatsRow, int64, error) {
	// Construir WHERE y argumentos de forma parametrizada.
	sql := listWithStatsSQL
	args := []interface{}{}

	if s := strings.TrimSpace(filter.Status); s != "" {
		sql += " AND l.status = ?"
		args = append(args, strings.ToUpper(s))
	}
	if s := strings.TrimSpace(filter.LenderName); s != "" {
		sql += " AND l.lender_name ILIKE ?"
		args = append(args, "%"+s+"%")
	}
	if s := strings.TrimSpace(filter.LenderDNI); s != "" {
		sql += " AND l.lender_dni = ?"
		args = append(args, s)
	}
	if filter.SupplierID != nil {
		sql += " AND l.supplier_id = ?"
		args = append(args, *filter.SupplierID)
	}

	// Total sin paginar: envolver.
	countSQL := "SELECT COUNT(*) FROM (" + sql + ") AS inner_q"
	var total int64
	if err := r.db.WithContext(ctx).Raw(countSQL, args...).Scan(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("count loans: %w", err)
	}

	// Query real con orden y paginación.
	sql += " ORDER BY l.created_at DESC LIMIT ? OFFSET ?"
	args = append(args, filter.Limit, filter.Offset)

	var rows []listWithStatsRow
	if err := r.db.WithContext(ctx).Raw(sql, args...).Scan(&rows).Error; err != nil {
		return nil, 0, fmt.Errorf("list loans: %w", err)
	}

	out := make([]ports.LoanWithStatsRow, 0, len(rows))
	for _, row := range rows {
		loan := models.Loan{
			ID:                            row.ID,
			LenderName:                    row.LenderName,
			LenderDNI:                     row.LenderDNI,
			SupplierID:                    row.SupplierID,
			PrincipalAmount:               row.PrincipalAmount,
			InterestRatePct:               row.InterestRatePct,
			InterestMode:                  row.InterestMode,
			TermCount:                     row.TermCount,
			PaymentFrequency:              row.PaymentFrequency,
			StartDate:                     row.StartDate,
			FirstPaymentDate:              row.FirstPaymentDate,
			DisbursementChannel:           row.DisbursementChannel,
			Status:                        row.Status,
			TotalPayable:                  row.TotalPayable,
			RemainingBalance:              row.RemainingBalance,
			AnnualEffectiveRatePct:        row.AnnualEffectiveRatePct,
			MonthlyInsuranceAmount:        row.MonthlyInsuranceAmount,
			FgaTotalAmount:                row.FgaTotalAmount,
			MonthlyFgaAmount:              row.MonthlyFgaAmount,
			BaseInstallmentAmount:         row.BaseInstallmentAmount,
			CreditNumber:                  row.CreditNumber,
			LoanType:                      row.LoanType,
			HolderName:                    row.HolderName,
			HolderDNI:                     row.HolderDNI,
			Currency:                      row.Currency,
			RateType:                      row.RateType,
			AutoDebit:                     row.AutoDebit,
			MaturityDate:                  row.MaturityDate,
			LateAnnualEffectiveRatePct:    row.LateAnnualEffectiveRatePct,
			NetDisbursementAmount:         row.NetDisbursementAmount,
			FgaIvaAmount:                  row.FgaIvaAmount,
			FgaGmfAmount:                  row.FgaGmfAmount,
			BankBalanceAmount:             row.BankBalanceAmount,
			BankBalanceAsOf:               row.BankBalanceAsOf,
			BankPaidAmount:                row.BankPaidAmount,
			OfficialNextInstallmentAmount: row.OfficialNextInstallmentAmount,
			OfficialNextInstallmentDate:   row.OfficialNextInstallmentDate,
			Note:                          row.Note,
			CreatedByDNI:                  row.CreatedByDNI,
			CreatedAt:                     row.CreatedAt,
			UpdatedAt:                     row.UpdatedAt,
		}
		outstanding := row.TotalDue - row.TotalPaid
		if outstanding < 0 {
			outstanding = 0
		}
		// Available = principal - principal_used, clampado a 0 por si un
		// drift de redondeo lo deja mínimamente negativo.
		available := row.PrincipalAmount - row.PrincipalUsed
		if available < 0 {
			available = 0
		}
		out = append(out, ports.LoanWithStatsRow{
			Loan:              loan,
			TotalPayable:      row.TotalPayable,
			RemainingBalance:  row.RemainingBalance,
			TotalDue:          row.TotalDue,
			TotalPaid:         row.TotalPaid,
			OutstandingDue:    outstanding,
			NextDueDate:       row.NextDueDate,
			NextDueAmount:     row.NextDueAmount,
			InstallmentsPaid:  row.InstallmentsPaid,
			InstallmentsTotal: row.InstallmentsTotal,
			PrincipalUsed:     row.PrincipalUsed,
			Available:         available,
		})
	}
	return out, total, nil
}

// =========================================================================
// PayInstallmentAtomic
// =========================================================================

// PayInstallmentAtomic aplica el pago con locks pesimistas y crea el
// Expense DENTRO de la misma transacción. Es el único punto del módulo
// donde se persiste un Expense; el servicio nunca llama a expenseRepo.Save
// aparte, para evitar el riesgo de dejar un Expense sin su cuota si falla
// el UPDATE posterior.
//
// Flujo:
//
//  1. BEGIN
//  2. SELECT ... FOR UPDATE sobre loans por id.
//  3. SELECT ... FOR UPDATE sobre loan_installments por (loan_id, number).
//  4. Si la cuota ya está PAID → ROLLBACK con ErrInstallmentAlreadyPaid.
//     Es la respuesta idempotente: NO se crea Expense.
//  5. Validar que applied == remaining_due (±1 centavo). El servicio ya
//     redondeó y validó; aquí se vuelve a comparar para que un bug no
//     deje saldo fantasma.
//  6. INSERT INTO expenses (status='PAID', canal real).
//  7. UPDATE loan_installments: paid_amount, paid_at,
//     settlement_expense_id, status='PAID'.
//  8. UPDATE loans.remaining_balance = max(0, prev - applied).
//     Si no quedan cuotas pendientes → status='PAID' (preservando
//     CANCELLED / DEFAULTED).
//  9. COMMIT.
func (r *PostgresLoanRepository) PayInstallmentAtomic(ctx context.Context, loanID uint, in ports.PayInstallmentAtomicInput) (*ports.PayInstallmentAtomicOutcome, error) {
	if loanID == 0 {
		return nil, errors.New("loanID requerido")
	}
	if in.Number <= 0 {
		return nil, errors.New("installment number inválido")
	}
	if in.Amount <= 0 || math.IsNaN(in.Amount) || math.IsInf(in.Amount, 0) {
		return nil, errors.New("amount debe ser mayor a cero y finito")
	}

	var outcome ports.PayInstallmentAtomicOutcome

	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1) Lock loan.
		var loan models.Loan
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", loanID).First(&loan).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ports.ErrLoanNotFound
			}
			return err
		}

		// 2) Lock installment por (loan_id, number).
		var inst models.LoanInstallment
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("loan_id = ? AND number = ?", loanID, in.Number).
			First(&inst).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ports.ErrInstallmentNotFound
		}
		if err != nil {
			return err
		}
		// 3) Idempotencia: ya pagada → sentinel sin crear expense.
		if inst.Status == models.InstallmentStatusPaid {
			return ports.ErrInstallmentAlreadyPaid
		}

		// 4) Validar que applied == remaining_due (±1 centavo). La cuota
		//    FRENCH suma además seguro+FGA; en NONE/SIMPLE esas columnas
		//    quedan en 0 por el DEFAULT, así que la fórmula se reduce a
		//    principal+interés y el pago histórico no cambia.
		dueTotalCents := toCents2(inst.PrincipalDue+inst.InterestDue) + toCents2(inst.InsuranceDue+inst.FgaDue)
		paidCents := toCents2(inst.PaidAmount)
		remainingCents := dueTotalCents - paidCents
		if remainingCents < 0 {
			remainingCents = 0
		}
		if remainingCents == 0 {
			// Aseguramos idempotencia aún si status quedó mal (defensa).
			return ports.ErrInstallmentAlreadyPaid
		}
		appliedCents := toCents2(in.Amount)
		// Pago COMPLETO exacto con tolerancia de 1 centavo.
		if abs64(appliedCents-remainingCents) > 1 {
			return fmt.Errorf("el pago debe cubrir exactamente el saldo pendiente de la cuota (esperado %.2f, recibido %.2f)",
				float64(remainingCents)/100.0, float64(appliedCents)/100.0)
		}
		// Tomamos SIEMPRE el remaining como aplicado para evitar quedar
		// con un centavo fantasma por tolerancia.
		applied := float64(remainingCents) / 100.0

		// 5) Crear Expense dentro de la tx.
		paidAt := in.PaidAt
		if paidAt.IsZero() {
			paidAt = time.Now()
		}
		description := strings.TrimSpace(in.Description)
		if description == "" {
			description = fmt.Sprintf("PAGO CUOTA PRÉSTAMO #%d - %s (cuota %d)", loan.ID, loan.LenderName, in.Number)
		}
		category := strings.TrimSpace(in.Category)
		if category == "" {
			category = "Préstamos"
		}
		expense := &models.Expense{
			Description:     description,
			Amount:          applied,
			Date:            paidAt,
			PaymentSource:   strings.ToUpper(strings.TrimSpace(in.PaymentSource)),
			Category:        category,
			Status:          "PAID",
			PaidAmount:      applied,
			RemainingAmount: 0,
			CreatedByDNI:    strings.ToUpper(strings.TrimSpace(in.ActorDNI)),
			CashAmount:      in.CashAmount,
			NequiAmount:     in.NequiAmount,
			DaviplataAmount: in.DaviplataAmount,
			FondoAmount:     in.FondoAmount,
			CoinsAmount:     in.CoinsAmount,
		}
		if err := tx.Create(expense).Error; err != nil {
			return fmt.Errorf("insert expense: %w", err)
		}

		// 6) Update installment.
		updates := map[string]interface{}{
			"paid_amount":           applied + inst.PaidAmount,
			"paid_at":               paidAt,
			"status":                models.InstallmentStatusPaid,
			"settlement_expense_id": expense.ID,
			"updated_at":            time.Now(),
		}
		if err := tx.Model(&models.LoanInstallment{}).
			Where("id = ?", inst.ID).
			Updates(updates).Error; err != nil {
			return fmt.Errorf("update installment: %w", err)
		}

		// 7) Update loan.remaining_balance y status.
		prevRemaining := loan.RemainingBalance
		newRemainingCents := toCents2(prevRemaining) - toCents2(applied)
		if newRemainingCents < 0 {
			newRemainingCents = 0 // clamp
		}
		newRemaining := float64(newRemainingCents) / 100.0

		// Determinar nuevo status: PAID si no quedan cuotas pendientes,
		// preservando CANCELLED / DEFAULTED (los setea un admin manualmente).
		newStatus := loan.Status
		if loan.Status != models.LoanStatusCancelled && loan.Status != models.LoanStatusDefaulted {
			var pending int64
			if err := tx.Raw(
				`SELECT COUNT(*) FROM loan_installments WHERE loan_id = ? AND status <> 'PAID'`,
				loanID,
			).Scan(&pending).Error; err != nil {
				return err
			}
			if pending == 0 {
				newStatus = models.LoanStatusPaid
			} else {
				newStatus = models.LoanStatusActive
			}
		}

		if err := tx.Model(&models.Loan{}).Where("id = ?", loanID).Updates(map[string]interface{}{
			"remaining_balance": newRemaining,
			"status":            newStatus,
			"updated_at":        time.Now(),
		}).Error; err != nil {
			return fmt.Errorf("update loan: %w", err)
		}

		// 8) Recargar cuota con valores finales para devolver al servicio.
		var reloaded models.LoanInstallment
		if err := tx.Where("id = ?", inst.ID).First(&reloaded).Error; err != nil {
			return err
		}
		outcome.Installment = &reloaded
		outcome.ExpenseID = expense.ID
		outcome.LoanStatus = newStatus
		outcome.RemainingBalance = newRemaining
		outcome.AppliedAmount = applied
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &outcome, nil
}

// RecalculateStatus consulta las cuotas y recalcula loan.status.
// Útil para un job diario o reparar tras una edición manual.
func (r *PostgresLoanRepository) RecalculateStatus(ctx context.Context, loanID uint) (string, error) {
	var status string
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		s, err := recalculateLoanStatusTx(tx, loanID)
		status = s
		return err
	})
	return status, err
}

// recalculateLoanStatusTx consulta las cuotas y determina el nuevo
// status del loan. Se ejecuta dentro de una transacción existente.
// Preserva CANCELLED y DEFAULTED (los setea un admin manualmente).
func recalculateLoanStatusTx(tx *gorm.DB, loanID uint) (string, error) {
	var currentStatus string
	if err := tx.Raw(`SELECT status FROM loans WHERE id = ?`, loanID).Scan(&currentStatus).Error; err != nil {
		return "", err
	}
	if currentStatus == models.LoanStatusCancelled || currentStatus == models.LoanStatusDefaulted {
		return currentStatus, nil
	}

	var totals struct {
		Total int64
		Paid  int64
	}
	err := tx.Raw(`
        SELECT
            COUNT(*)                                       AS total,
            COUNT(*) FILTER (WHERE status = 'PAID')        AS paid
          FROM loan_installments
         WHERE loan_id = ?
    `, loanID).Scan(&totals).Error
	if err != nil {
		return "", err
	}
	status := models.LoanStatusActive
	if totals.Total > 0 && totals.Paid == totals.Total {
		status = models.LoanStatusPaid
	}
	if err := tx.Exec(`UPDATE loans SET status = ?, updated_at = NOW() WHERE id = ?`, status, loanID).Error; err != nil {
		return "", err
	}
	return status, nil
}

// =========================================================================
// RegisterLoanExpense
// =========================================================================

// RegisterLoanExpense valida la invariante
// `SUM(amount_used) + new <= principal_amount` dentro de una transacción
// con SELECT ... FOR UPDATE sobre el loan. Devuelve el total usado tras
// el INSERT para que la UI actualice la barra "gastado / disponible".
func (r *PostgresLoanRepository) RegisterLoanExpense(ctx context.Context, exp *models.LoanExpense) (float64, error) {
	if exp == nil {
		return 0, errors.New("loan expense nulo")
	}
	if exp.LoanID == 0 {
		return 0, errors.New("loanID requerido")
	}
	if exp.AmountUsed <= 0 || math.IsNaN(exp.AmountUsed) || math.IsInf(exp.AmountUsed, 0) {
		return 0, errors.New("amountUsed debe ser mayor a cero y finito")
	}

	var totalAfter float64
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Lock del loan.
		var loan models.Loan
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", exp.LoanID).First(&loan).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ports.ErrLoanNotFound
			}
			return err
		}
		// SUM actual.
		var used float64
		if err := tx.Raw(`SELECT COALESCE(SUM(amount_used), 0) FROM loan_expenses WHERE loan_id = ? AND reversed_at IS NULL`, exp.LoanID).
			Scan(&used).Error; err != nil {
			return err
		}
		// Comparar en centavos: `used + new > principal + 0.009` deja
		// una tolerancia de 1 centavo por redondeos de la UI.
		newTotalCents := toCents2(used + exp.AmountUsed)
		principalCents := toCents2(loan.PrincipalAmount)
		if newTotalCents-principalCents > 1 { // 1 centavo de tolerancia
			return fmt.Errorf("%w (acumulado %.2f + nuevo %.2f > principal %.2f)",
				ports.ErrPrincipalExceeded, used, exp.AmountUsed, loan.PrincipalAmount)
		}
		if err := tx.Create(exp).Error; err != nil {
			return err
		}
		totalAfter = float64(newTotalCents) / 100.0
		return nil
	})
	return totalAfter, err
}

// =========================================================================
// PayExpenseAtomic
// =========================================================================

// PayExpenseAtomic implementa el endpoint POST /api/loans/:id/pay-expense en
// una única transacción. Dos variantes conviven:
//
//  1. Con ExpenseID: abona/salda una deuda existente (equivalente a
//     ExpenseService.SettleExpense), creando un expense "ABONO A DEUDA" con
//     canal PRESTAMO y actualizando la deuda original.
//
//  2. Sin ExpenseID: crea un expense nuevo pagado con la plata del préstamo.
//
// En ambos casos el expense resultante queda PAID + PRESTAMO + canales en 0.
// La bitácora `loan_expenses` descuenta `amount_used = applied` del
// disponible (`principal - SUM(amount_used)`) con tolerancia 1 centavo.
//
// Si CUALQUIER paso falla, la transacción se revierte entera: ni egreso, ni
// abono, ni fila de bitácora. Nunca queda un Expense PRESTAMO huérfano sin
// su `loan_expense` ni un `loan_expense` apuntando a un Expense fantasma.
func (r *PostgresLoanRepository) PayExpenseAtomic(ctx context.Context, loanID uint, in ports.PayExpenseAtomicInput) (*ports.PayExpenseAtomicOutcome, error) {
	if loanID == 0 {
		return nil, errors.New("loanID requerido")
	}
	if in.Amount <= 0 || math.IsNaN(in.Amount) || math.IsInf(in.Amount, 0) {
		return nil, errors.New("amount debe ser mayor a cero y finito")
	}
	actor := strings.ToUpper(strings.TrimSpace(in.ActorDNI))
	if actor == "" {
		return nil, errors.New("actor requerido")
	}

	var outcome ports.PayExpenseAtomicOutcome

	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1) Lock del préstamo.
		var loan models.Loan
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", loanID).First(&loan).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ports.ErrLoanNotFound
			}
			return err
		}

		// 2) Validar status: sólo ACTIVE y DEFAULTED permiten nuevos usos.
		//    PAID, CANCELLED → ErrLoanNotActive.
		status := strings.ToUpper(strings.TrimSpace(loan.Status))
		if status != models.LoanStatusActive && status != models.LoanStatusDefaulted {
			return ports.ErrLoanNotActive
		}

		// 3) SUM actual + disponible.
		var usedBefore float64
		if err := tx.Raw(`SELECT COALESCE(SUM(amount_used), 0) FROM loan_expenses WHERE loan_id = ? AND reversed_at IS NULL`, loanID).
			Scan(&usedBefore).Error; err != nil {
			return err
		}
		principalCents := toCents2(loan.PrincipalAmount)
		usedCents := toCents2(usedBefore)
		availableCents := principalCents - usedCents
		if availableCents < 0 {
			availableCents = 0
		}

		paidAt := in.PaidAt
		if paidAt.IsZero() {
			paidAt = time.Now()
		}

		var createdExpense *models.Expense
		var updatedDebt *models.Expense
		var appliedCents int64
		// Traza para poder reversar exactamente el pago al eliminar el
		// expense PAID+PRESTAMO. Nil = el préstamo financió un egreso nuevo.
		var sourceExpenseID *uint
		var sourceStatusBefore *string
		var sourcePaidBefore *float64
		var sourceRemainingBefore *float64

		if in.ExpenseID != nil && *in.ExpenseID > 0 {
			// --- Variante 1: abonar a una deuda existente -----------------
			var debt models.Expense
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("id = ?", *in.ExpenseID).First(&debt).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ports.ErrExpenseNotFound
				}
				return err
			}
			// Payable = deuda viva: PENDING, o PRESTAMO/PREST. no PAID/SETTLED.
			debtStatus := strings.ToUpper(strings.TrimSpace(debt.Status))
			debtSource := strings.ToUpper(strings.TrimSpace(debt.PaymentSource))
			isPendingDebt := debtStatus == "PENDING" ||
				((debtSource == "PRESTAMO" || debtSource == "PREST.") && debtStatus != "PAID" && debtStatus != "SETTLED")
			if !isPendingDebt {
				return ports.ErrExpenseNotPayable
			}
			remaining := debt.RemainingAmount
			if remaining <= 0 {
				// Legacy: deudas viejas pueden tener remaining_amount=0 y
				// amount>paid_amount; usar amount - paid como respaldo.
				remaining = debt.Amount - debt.PaidAmount
			}
			if remaining <= 0 {
				return ports.ErrExpenseNotPayable
			}

			// Snapshot ANTES de mutar la deuda. El remaining efectivo puede
			// venir del fallback legacy amount-paid, por eso guardamos ese valor
			// y no necesariamente debt.RemainingAmount (que podría ser 0).
			sourceID := debt.ID
			statusBefore := debt.Status
			paidBefore := float64(toCents2(debt.PaidAmount)) / 100.0
			remainingBefore := float64(toCents2(remaining)) / 100.0
			sourceExpenseID = &sourceID
			sourceStatusBefore = &statusBefore
			sourcePaidBefore = &paidBefore
			sourceRemainingBefore = &remainingBefore

			// Recortar al remaining; nunca pagar de más.
			requestedCents := toCents2(in.Amount)
			remainingCents := toCents2(remaining)
			applyCents := requestedCents
			if applyCents > remainingCents {
				applyCents = remainingCents
			}
			if applyCents <= 0 {
				return ports.ErrExpenseNotPayable
			}
			// Validar disponible del préstamo.
			if applyCents > availableCents {
				return fmt.Errorf("%w (disponible %.2f, solicitado %.2f)",
					ports.ErrPrincipalExceeded,
					float64(availableCents)/100.0, float64(applyCents)/100.0)
			}
			applied := float64(applyCents) / 100.0
			appliedCents = applyCents

			// Crear el expense de abono con PaymentSource="PRESTAMO".
			abonoDesc := "ABONO A DEUDA: " + debt.Description
			if applyCents == remainingCents {
				abonoDesc = debt.Description
			}
			if len(abonoDesc) > 255 {
				abonoDesc = abonoDesc[:255]
			}
			category := debt.Category
			if strings.TrimSpace(category) == "" {
				category = "Otros Gastos"
			}
			newExpense := &models.Expense{
				Description:     abonoDesc,
				Amount:          applied,
				Date:            paidAt,
				PaymentSource:   "PRESTAMO",
				Category:        category,
				Status:          "PAID",
				PaidAmount:      applied,
				RemainingAmount: 0,
				CreatedByDNI:    actor,
				SupplierID:      debt.SupplierID,
				// Canales explícitamente en 0: la plata NO sale de ningún
				// bolsillo de la tienda.
				CashAmount:      0,
				NequiAmount:     0,
				DaviplataAmount: 0,
				FondoAmount:     0,
				CoinsAmount:     0,
			}
			if err := tx.Create(newExpense).Error; err != nil {
				return fmt.Errorf("insert expense abono: %w", err)
			}
			createdExpense = newExpense

			// Actualizar la deuda original.
			newPaidCents := toCents2(debt.PaidAmount) + applyCents
			newRemainCents := remainingCents - applyCents
			if newRemainCents < 0 {
				newRemainCents = 0
			}
			newStatus := debt.Status
			if newRemainCents == 0 {
				newStatus = "SETTLED"
			}
			updates := map[string]interface{}{
				"paid_amount":      float64(newPaidCents) / 100.0,
				"remaining_amount": float64(newRemainCents) / 100.0,
				"status":           newStatus,
			}
			if err := tx.Model(&models.Expense{}).Where("id = ?", debt.ID).Updates(updates).Error; err != nil {
				return fmt.Errorf("update deuda original: %w", err)
			}
			// Recargar para devolver el estado final al handler.
			var reloaded models.Expense
			if err := tx.Where("id = ?", debt.ID).First(&reloaded).Error; err != nil {
				return err
			}
			updatedDebt = &reloaded
		} else {
			// --- Variante 2: crear expense nuevo -------------------------
			desc := strings.TrimSpace(in.Description)
			if desc == "" {
				return errors.New("description requerida cuando no hay expenseId")
			}
			if len(desc) > 255 {
				desc = desc[:255]
			}
			category := strings.TrimSpace(in.Category)
			if category == "" {
				category = "Otros Gastos"
			}
			requestedCents := toCents2(in.Amount)
			if requestedCents <= 0 {
				return errors.New("amount debe ser mayor a cero")
			}
			if requestedCents > availableCents {
				return fmt.Errorf("%w (disponible %.2f, solicitado %.2f)",
					ports.ErrPrincipalExceeded,
					float64(availableCents)/100.0, float64(requestedCents)/100.0)
			}
			applied := float64(requestedCents) / 100.0
			appliedCents = requestedCents

			newExpense := &models.Expense{
				Description:     desc,
				Amount:          applied,
				Date:            paidAt,
				PaymentSource:   "PRESTAMO",
				Category:        category,
				Status:          "PAID",
				PaidAmount:      applied,
				RemainingAmount: 0,
				CreatedByDNI:    actor,
				SupplierID:      in.SupplierID,
				CashAmount:      0,
				NequiAmount:     0,
				DaviplataAmount: 0,
				FondoAmount:     0,
				CoinsAmount:     0,
			}
			if err := tx.Create(newExpense).Error; err != nil {
				return fmt.Errorf("insert expense nuevo: %w", err)
			}
			createdExpense = newExpense
		}

		// 4) INSERT en loan_expenses (bitácora de uso del principal).
		purpose := strings.TrimSpace(in.Purpose)
		if purpose == "" {
			purpose = createdExpense.Description
		}
		if len(purpose) > 255 {
			purpose = purpose[:255]
		}
		expenseID := createdExpense.ID
		loanExp := &models.LoanExpense{
			LoanID:                loanID,
			ExpenseID:             &expenseID,
			AmountUsed:            float64(appliedCents) / 100.0,
			Purpose:               purpose,
			CreatedByDNI:          actor,
			CreatedAt:             time.Now(),
			SourceExpenseID:       sourceExpenseID,
			SourceStatusBefore:    sourceStatusBefore,
			SourcePaidBefore:      sourcePaidBefore,
			SourceRemainingBefore: sourceRemainingBefore,
		}
		if err := tx.Create(loanExp).Error; err != nil {
			return fmt.Errorf("insert loan_expense: %w", err)
		}

		// 5) Preparar outcome. El total y disponible se calculan contra la
		//    suma final (usedBefore + applied) sin volver a consultar.
		totalUsedCents := usedCents + appliedCents
		availAfterCents := principalCents - totalUsedCents
		if availAfterCents < 0 {
			availAfterCents = 0
		}
		outcome.Expense = createdExpense
		outcome.UpdatedDebt = updatedDebt
		outcome.LoanExpense = loanExp
		outcome.AppliedAmount = float64(appliedCents) / 100.0
		outcome.TotalUsedAfter = float64(totalUsedCents) / 100.0
		outcome.Available = float64(availAfterCents) / 100.0
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &outcome, nil
}

// =========================================================================

// ReverseOrphanedLoanExpense repara un pago que fue soft-deleted antes de
// existir la reversión 022. Si la traza source_expense_id está ausente, sólo
// procede cuando encuentra EXACTAMENTE UNA deuda activa que coincide en
// concepto, categoría y proveedor y tiene paid_amount suficiente. Nunca
// adivina entre varias candidatas.
func (r *PostgresLoanRepository) ReverseOrphanedLoanExpense(ctx context.Context, loanID, usageID uint, actorDNI string) (*ports.ReverseOrphanedLoanExpenseOutcome, error) {
	actor := strings.ToUpper(strings.TrimSpace(actorDNI))
	if loanID == 0 || usageID == 0 || actor == "" {
		return nil, errors.New("loanID, usageID y actor requeridos")
	}
	out := &ports.ReverseOrphanedLoanExpenseOutcome{LoanExpenseID: usageID}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var loan models.Loan
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", loanID).First(&loan).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ports.ErrLoanNotFound
			}
			return err
		}
		var usage models.LoanExpense
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND loan_id = ? AND reversed_at IS NULL", usageID, loanID).
			First(&usage).Error; err != nil {
			return err
		}
		if usage.ExpenseID == nil {
			return ports.ErrLoanUsageNotOrphan
		}
		var deletedPayment models.Expense
		if err := tx.Unscoped().Where("id = ?", *usage.ExpenseID).First(&deletedPayment).Error; err != nil {
			return err
		}
		if !deletedPayment.DeletedAt.Valid || !models.IsLoanFundedExpense(&deletedPayment) {
			return ports.ErrLoanUsageNotOrphan
		}

		amountCents := toCents2(usage.AmountUsed)
		if amountCents <= 0 {
			return errors.New("amount_used inválido")
		}

		var debt models.Expense
		if usage.SourceExpenseID != nil && *usage.SourceExpenseID > 0 {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", *usage.SourceExpenseID).First(&debt).Error; err != nil {
				return err
			}
		} else {
			// Pago legacy: el abono parcial usa prefijo; el pago total conserva
			// exactamente la descripción original.
			desc := strings.TrimSpace(deletedPayment.Description)
			upperDesc := strings.ToUpper(desc)
			if strings.HasPrefix(upperDesc, "ABONO A DEUDA:") {
				desc = strings.TrimSpace(desc[len("ABONO A DEUDA:"):])
			}
			q := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("id <> ?", deletedPayment.ID).
				Where("UPPER(TRIM(description)) = UPPER(TRIM(?))", desc).
				Where("category = ?", deletedPayment.Category).
				Where("paid_amount >= ?", float64(amountCents)/100.0)
			if deletedPayment.SupplierID == nil {
				q = q.Where("supplier_id IS NULL")
			} else {
				q = q.Where("supplier_id = ?", *deletedPayment.SupplierID)
			}
			var candidates []models.Expense
			if err := q.Find(&candidates).Error; err != nil {
				return err
			}
			if len(candidates) != 1 {
				return fmt.Errorf("%w (candidatas=%d)", ports.ErrLoanOrphanDebtAmbiguous, len(candidates))
			}
			debt = candidates[0]
		}

		paidCents := toCents2(debt.PaidAmount) - amountCents
		if paidCents < 0 {
			return fmt.Errorf("%w (paid_amount menor al uso)", ports.ErrLoanOrphanDebtAmbiguous)
		}
		remainingCents := toCents2(debt.RemainingAmount) + amountCents
		status := "PENDING"
		if usage.SourceStatusBefore != nil {
			status = *usage.SourceStatusBefore
			if strings.EqualFold(status, "PAID") || strings.EqualFold(status, "SETTLED") {
				status = "PENDING"
			}
		}
		if err := tx.Model(&models.Expense{}).Where("id = ?", debt.ID).Updates(map[string]interface{}{
			"paid_amount":      float64(paidCents) / 100.0,
			"remaining_amount": float64(remainingCents) / 100.0,
			"status":           status,
		}).Error; err != nil {
			return err
		}
		now := time.Now()
		updates := map[string]interface{}{
			"source_expense_id": debt.ID,
			"reversed_at":       now,
			"reversed_by_dni":   actor,
		}
		if err := tx.Model(&models.LoanExpense{}).Where("id = ? AND reversed_at IS NULL", usage.ID).Updates(updates).Error; err != nil {
			return err
		}
		out.RestoredDebtID = debt.ID
		out.RestoredAmount = float64(amountCents) / 100.0
		out.ReleasedPrincipal = out.RestoredAmount
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// =========================================================================
// UpdateLoanAtomic
// =========================================================================

// UpdateLoanAtomic edita un préstamo en una transacción con locks
// pesimistas. SIEMPRE aplica la metadata editable; recrea el cronograma
// sólo si in.Recalculate y ninguna cuota tiene pagos.
//
// INVARIANTES PROTEGIDAS:
//   - Nunca pierde loan_expenses (no tiene FK a cuotas; no se toca).
//   - En recálculo exige CERO cuotas con paid_amount > 0 (si no,
//     ErrLoanHasPaidInstallments) para no romper settlement_expense_id.
//   - principal nuevo >= SUM(amount_used activo) (si no,
//     ErrLoanPrincipalBelowUsage).
//   - start_date nuevo no puede quedar después de la primera cuota
//     programada (si no, ErrLoanStartDateAfterInstallments).
//   - remaining_balance se recalcula = total_payable sólo en recálculo
//     (no había pagos); en metadata-only no se toca.
func (r *PostgresLoanRepository) UpdateLoanAtomic(ctx context.Context, loanID uint, in ports.UpdateLoanAtomicInput) (*ports.UpdateLoanAtomicOutcome, error) {
	if loanID == 0 {
		return nil, errors.New("loanID requerido")
	}

	var outcome ports.UpdateLoanAtomicOutcome

	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1) Lock del préstamo.
		var loan models.Loan
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", loanID).First(&loan).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ports.ErrLoanNotFound
			}
			return err
		}

		// 2) Determinar start_date efectivo (el nuevo si vino, si no el previo)
		//    y validar coherencia con las cuotas existentes.
		effectiveStart := loan.StartDate
		if in.StartDate != nil {
			effectiveStart = *in.StartDate
		}
		if in.StartDate != nil && !in.Recalculate {
			// En metadata-only, start_date no puede superar la primera cuota
			// ya programada (la BD rechazaría first_payment_date >= start_date,
			// pero devolvemos un error de dominio claro).
			var minDue *time.Time
			if err := tx.Raw(
				`SELECT MIN(due_date) FROM loan_installments WHERE loan_id = ?`, loanID,
			).Scan(&minDue).Error; err != nil {
				return err
			}
			if minDue != nil && in.StartDate.After(*minDue) {
				return ports.ErrLoanStartDateAfterInstallments
			}
		}
		// Revalidar maturity_date contra el start_date efectivo bajo el lock
		// del préstamo. Esto cubre también el caso donde el request sólo
		// cambia maturity_date y conserva el start_date persistido.
		if in.MaturityDate != nil && in.MaturityDate.Before(effectiveStart) {
			return ports.ErrLoanMaturityBeforeStart
		}

		// 3) Construir el mapa de UPDATE con la metadata (siempre).
		updates := map[string]interface{}{
			"lender_name":                      in.LenderName,
			"lender_dni":                       in.LenderDNI,
			"supplier_id":                      in.SupplierID,
			"disbursement_channel":             in.DisbursementChannel,
			"note":                             in.Note,
			"credit_number":                    in.CreditNumber,
			"loan_type":                        in.LoanType,
			"holder_name":                      in.HolderName,
			"holder_dni":                       in.HolderDNI,
			"currency":                         in.Currency,
			"rate_type":                        in.RateType,
			"auto_debit":                       in.AutoDebit,
			"maturity_date":                    in.MaturityDate,
			"late_annual_effective_rate_pct":   in.LateAnnualEffectiveRatePct,
			"net_disbursement_amount":          in.NetDisbursementAmount,
			"fga_iva_amount":                   in.FgaIvaAmount,
			"fga_gmf_amount":                   in.FgaGmfAmount,
			"bank_balance_amount":              in.BankBalanceAmount,
			"bank_balance_as_of":               in.BankBalanceAsOf,
			"bank_paid_amount":                 in.BankPaidAmount,
			"official_next_installment_amount": in.OfficialNextInstallmentAmount,
			"official_next_installment_date":   in.OfficialNextInstallmentDate,
			"updated_at":                       time.Now(),
		}
		if in.StartDate != nil {
			updates["start_date"] = effectiveStart
		}

		// 4) Rama de recálculo: validaciones duras + reemplazo del cronograma.
		if in.Recalculate {
			// 4a) Bloquear TODAS las cuotas y exigir CERO pagos. Un agregado
			// COUNT(*) ... FOR UPDATE no es SQL válido en PostgreSQL; por eso
			// seleccionamos las filas (id, paid_amount) con lock real y
			// verificamos en memoria. El lock previo sobre loans serializa este
			// flujo con PayInstallmentAtomic, que toma los locks en el mismo orden.
			var installments []models.LoanInstallment
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Select("id", "paid_amount").
				Where("loan_id = ?", loanID).
				Find(&installments).Error; err != nil {
				return err
			}
			for i := range installments {
				if toCents2(installments[i].PaidAmount) > 0 {
					return ports.ErrLoanHasPaidInstallments
				}
			}

			// 4b) Bloquear los usos activos y sumar en centavos. Así la
			// invariante principal >= SUM(amount_used WHERE reversed_at IS NULL)
			// se comprueba sobre exactamente las filas protegidas por la tx.
			var activeUsages []models.LoanExpense
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Select("id", "amount_used").
				Where("loan_id = ? AND reversed_at IS NULL", loanID).
				Find(&activeUsages).Error; err != nil {
				return err
			}
			var usedActiveCents int64
			for i := range activeUsages {
				usedActiveCents += toCents2(activeUsages[i].AmountUsed)
			}
			principalCents := toCents2(in.NewPrincipalAmount)
			if principalCents < usedActiveCents {
				return fmt.Errorf("%w (principal nuevo %.2f < uso activo %.2f)",
					ports.ErrLoanPrincipalBelowUsage,
					float64(principalCents)/100.0,
					float64(usedActiveCents)/100.0)
			}

			// 4c) Borrar cuotas viejas (ninguna tenía pagos ni
			//     settlement_expense_id). loan_expenses queda INTACTO.
			if err := tx.Where("loan_id = ?", loanID).
				Delete(&models.LoanInstallment{}).Error; err != nil {
				return fmt.Errorf("borrando cuotas previas: %w", err)
			}

			// 4d) Insertar el cronograma nuevo.
			if len(in.NewSchedule) == 0 {
				return errors.New("cronograma recalculado vacío")
			}
			schedule := make([]models.LoanInstallment, len(in.NewSchedule))
			copy(schedule, in.NewSchedule)
			for i := range schedule {
				schedule[i].ID = 0
				schedule[i].LoanID = loanID
			}
			if err := tx.CreateInBatches(schedule, 100).Error; err != nil {
				return fmt.Errorf("insertando cronograma nuevo: %w", err)
			}

			// 4e) Campos financieros del préstamo + remaining = total.
			updates["principal_amount"] = in.NewPrincipalAmount
			updates["interest_mode"] = in.NewInterestMode
			updates["interest_rate_pct"] = in.NewInterestRatePct
			updates["annual_effective_rate_pct"] = in.NewAnnualEffectiveRatePct
			updates["term_count"] = in.NewTermCount
			updates["payment_frequency"] = in.NewPaymentFrequency
			updates["first_payment_date"] = in.NewFirstPaymentDate
			updates["monthly_insurance_amount"] = in.NewMonthlyInsurance
			updates["fga_total_amount"] = in.NewFgaTotal
			updates["monthly_fga_amount"] = in.NewMonthlyFga
			updates["base_installment_amount"] = in.NewBaseInstallment
			updates["total_payable"] = in.NewTotalPayable
			updates["remaining_balance"] = in.NewTotalPayable
		}

		// 5) Aplicar UPDATE sobre loans.
		if err := tx.Model(&models.Loan{}).Where("id = ?", loanID).
			Updates(updates).Error; err != nil {
			return fmt.Errorf("update loan: %w", err)
		}

		// 6) Recalcular status dentro de la misma tx (preserva CANCELLED/DEFAULTED).
		status, err := recalculateLoanStatusTx(tx, loanID)
		if err != nil {
			return err
		}

		// 7) Recargar la fila para el outcome.
		var reloaded models.Loan
		if err := tx.Where("id = ?", loanID).First(&reloaded).Error; err != nil {
			return err
		}
		outcome.Loan = &reloaded
		outcome.Recalculated = in.Recalculate
		outcome.LoanStatus = status
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &outcome, nil
}

// =========================================================================

// SoftDelete anula lógicamente el préstamo. Política: no se puede
// cancelar si ya hay pagos registrados (paid_amount > 0 en alguna cuota).
func (r *PostgresLoanRepository) SoftDelete(ctx context.Context, loanID uint) error {
	if loanID == 0 {
		return errors.New("loanID requerido")
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var loan models.Loan
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", loanID).First(&loan).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ports.ErrLoanNotFound
			}
			return err
		}
		// Verificar que no haya pagos.
		var paid int64
		if err := tx.Raw(`SELECT COUNT(*) FROM loan_installments WHERE loan_id = ? AND paid_amount > 0`, loanID).
			Scan(&paid).Error; err != nil {
			return err
		}
		if paid > 0 {
			return fmt.Errorf("no se puede cancelar un préstamo con pagos registrados (%d cuotas pagadas o parciales)", paid)
		}
		now := time.Now()
		if err := tx.Model(&models.Loan{}).Where("id = ?", loanID).Updates(map[string]interface{}{
			"status":     models.LoanStatusCancelled,
			"deleted_at": now,
			"updated_at": now,
		}).Error; err != nil {
			return err
		}
		return nil
	})
}

// =========================================================================
// Helpers
// =========================================================================

// toCents2 redondea un float a centavos int64 con half-away-from-zero.
// Se replica la lógica del servicio en el repo para no acoplar paquetes.
func toCents2(value float64) int64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	if value >= 0 {
		return int64(math.Round(value*100 + 0.0000001))
	}
	return -int64(math.Round(-value*100 + 0.0000001))
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

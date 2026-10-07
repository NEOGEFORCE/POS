package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

// =============================================================================
// Pruebas del PostgresLoanRepository usando el fakeSQL driver
// (ver fake_sql_driver_test.go). No tocan Postgres: ejecutan el código
// real contra un driver en memoria que graba las sentencias y responde
// según lo que decide el test.
//
// Validamos:
//
//   - CreateLoanWithSchedule corre en UNA transacción (BEGIN/COMMIT).
//   - PayInstallmentAtomic:
//       * toma SELECT ... FOR UPDATE sobre loans y loan_installments;
//       * emite INSERT INTO expenses y UPDATE sobre loan_installments
//         y loans dentro de la MISMA transacción;
//       * si la cuota ya está PAID, retorna ErrInstallmentAlreadyPaid
//         SIN emitir INSERT INTO expenses;
//       * si la cuota no existe, retorna ErrInstallmentNotFound con
//         rollback total.
//   - RegisterLoanExpense valida SUM(amount_used) + nuevo <= principal
//     dentro de la misma transacción.
//   - SoftDelete falla si hay pagos registrados.
// =============================================================================

func TestLoanRepo_CreateLoanWithSchedule_UsaUnaTransaccion(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))

	loan := &models.Loan{
		LenderName:       "ACREEDOR DEMO",
		PrincipalAmount:  1_000_000,
		InterestRatePct:  10,
		InterestMode:     models.InterestModeSimple,
		TermCount:        3,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		StartDate:        time.Now(),
		FirstPaymentDate: time.Now().AddDate(0, 1, 0),
		Status:           models.LoanStatusActive,
		TotalPayable:     1_100_000,
		RemainingBalance: 1_100_000,
		CreatedByDNI:     "ADMIN-1",
	}
	schedule := []models.LoanInstallment{
		{Number: 1, DueDate: time.Now(), PrincipalDue: 366_666, InterestDue: 33_333},
		{Number: 2, DueDate: time.Now().AddDate(0, 1, 0), PrincipalDue: 366_666, InterestDue: 33_333},
		{Number: 3, DueDate: time.Now().AddDate(0, 2, 0), PrincipalDue: 366_668, InterestDue: 33_334},
	}
	if err := repo.CreateLoanWithSchedule(context.Background(), loan, schedule); err != nil {
		t.Fatalf("CreateLoanWithSchedule: %v", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("se esperaba BEGIN/COMMIT (una transacción), eventos=%v", f.txEvents)
	}
	// Debe haber al menos un INSERT a loans y un INSERT a loan_installments.
	var sawLoan, sawInst, sawTotalPayable bool
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, `INSERT INTO "LOANS"`) {
			sawLoan = true
			if strings.Contains(up, "TOTAL_PAYABLE") {
				sawTotalPayable = true
			}
		}
		if strings.Contains(up, `INSERT INTO "LOAN_INSTALLMENTS"`) {
			sawInst = true
		}
	}
	if !sawLoan {
		t.Error("no se detectó INSERT INTO loans dentro de la transacción")
	}
	if !sawInst {
		t.Error("no se detectó INSERT INTO loan_installments dentro de la transacción")
	}
	if !sawTotalPayable {
		t.Error("el INSERT de loans NO incluyó la columna total_payable; debe persistirse al crear")
	}
}

func TestLoanRepo_CreateLoanWithSchedule_RollbackSiFallaInsertCuotas(t *testing.T) {
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			up := strings.ToUpper(q)
			if strings.Contains(up, `INSERT INTO "LOAN_INSTALLMENTS"`) {
				return fakeResult{Err: errors.New("boom instalments")}
			}
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(1)}}}
		},
	}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))

	loan := &models.Loan{
		LenderName: "X", PrincipalAmount: 1000, InterestMode: models.InterestModeNone,
		TermCount: 1, PaymentFrequency: models.PaymentFrequencyMonthly,
		StartDate: time.Now(), FirstPaymentDate: time.Now(), Status: models.LoanStatusActive, CreatedByDNI: "ADMIN",
	}
	schedule := []models.LoanInstallment{{Number: 1, DueDate: time.Now(), PrincipalDue: 1000}}
	err := repo.CreateLoanWithSchedule(context.Background(), loan, schedule)
	if err == nil {
		t.Fatal("se esperaba error del INSERT de cuotas")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("la tx debe revertirse si falla el INSERT de cuotas; eventos=%v", f.txEvents)
	}
}

// Columnas de loan_installments usadas por el fake (una lista constante
// evita que un olvido rompa 5 tests a la vez).
var instCols = []string{
	"id", "loan_id", "number", "due_date", "principal_due", "interest_due",
	"paid_amount", "paid_at", "settlement_expense_id", "status", "created_at", "updated_at",
}

func instRow(id, loanID, number int64, principalDue, interestDue, paid float64, status string) []driver.Value {
	return []driver.Value{
		id, loanID, number, time.Now(), principalDue, interestDue, paid,
		nil, nil, status, time.Now(), time.Now(),
	}
}

// loanCols — columnas que GORM pide cuando hace First(&models.Loan).
var loanCols = []string{
	"id", "lender_name", "lender_dni", "supplier_id", "principal_amount",
	"interest_rate_pct", "interest_mode", "term_count", "payment_frequency",
	"start_date", "first_payment_date", "disbursement_channel", "status",
	"total_payable", "remaining_balance", "note", "created_by_dni",
	"created_at", "updated_at", "deleted_at",
}

func loanRow(id int64, principal, totalPayable, remaining float64, status string) []driver.Value {
	return []driver.Value{
		id, "ACREEDOR", "", nil, principal, 10.0, "SIMPLE", 3, "MONTHLY",
		time.Now(), time.Now(), "EFECTIVO", status, totalPayable, remaining, "", "ADMIN",
		time.Now(), time.Now(), nil,
	}
}

func TestLoanRepo_PayInstallmentAtomic_HappyPath(t *testing.T) {
	// Config:
	//   - lock sobre loans: devuelve principal=1000, total=1100, remaining=220, status=ACTIVE.
	//   - lock sobre installment (loan_id=10, number=2): principal_due=100, interest_due=10, paid=0.
	//   - count de pendientes tras pagar: 0 → loan pasa a PAID.
	var countPendingCalled bool
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			up := strings.ToUpper(q)
			switch {
			case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 220, "ACTIVE")}}
			case strings.Contains(up, `FROM "LOAN_INSTALLMENTS"`) && strings.Contains(up, "FOR UPDATE"):
				return fakeResult{Columns: instCols, Rows: [][]driver.Value{instRow(1, 10, 2, 100, 10, 0, "PENDING")}}
			case strings.Contains(up, `INSERT INTO "EXPENSES"`):
				return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(555)}}}
			case strings.Contains(up, "COUNT(*) FROM LOAN_INSTALLMENTS") && strings.Contains(up, "STATUS <> 'PAID'"):
				countPendingCalled = true
				return fakeResult{Columns: []string{"count"}, Rows: [][]driver.Value{{int64(0)}}}
			case strings.Contains(up, `FROM "LOAN_INSTALLMENTS"`):
				// Recarga post-update.
				return fakeResult{Columns: instCols, Rows: [][]driver.Value{instRow(1, 10, 2, 100, 10, 110, "PAID")}}
			}
			return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
		},
	}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))

	outcome, err := repo.PayInstallmentAtomic(context.Background(), 10, ports.PayInstallmentAtomicInput{
		Number: 2, Amount: 110, PaymentSource: "EFECTIVO", ActorDNI: "ADMIN",
		CashAmount: 110, Description: "test", Category: "Préstamos", PaidAt: time.Now(),
	})
	if err != nil {
		t.Fatalf("PayInstallmentAtomic: %v", err)
	}
	if outcome == nil {
		t.Fatal("outcome nil")
	}
	if outcome.LoanStatus != models.LoanStatusPaid {
		t.Errorf("loan status esperado PAID (todas las cuotas liquidadas), got %q", outcome.LoanStatus)
	}
	if outcome.ExpenseID != 555 {
		t.Errorf("ExpenseID=%v, want 555", outcome.ExpenseID)
	}
	if outcome.AppliedAmount != 110 {
		t.Errorf("AppliedAmount=%v, want 110", outcome.AppliedAmount)
	}
	// Remaining tras pagar: 220 - 110 = 110.
	if outcome.RemainingBalance != 110 {
		t.Errorf("RemainingBalance=%v, want 110", outcome.RemainingBalance)
	}
	if !countPendingCalled {
		t.Error("falta la consulta del conteo de cuotas pendientes para determinar PAID")
	}

	// Debe haber INSERT en expenses, UPDATE en loan_installments y UPDATE en loans — todo dentro de UNA tx.
	var sawInsertExpense, sawUpdateInst, sawUpdateLoan, sawInstLock, sawLoanLock bool
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		switch {
		case strings.Contains(up, `INSERT INTO "EXPENSES"`):
			sawInsertExpense = true
		case strings.Contains(up, `UPDATE "LOAN_INSTALLMENTS"`):
			sawUpdateInst = true
		case strings.Contains(up, `UPDATE "LOANS"`):
			sawUpdateLoan = true
		}
		if strings.Contains(up, `FROM "LOAN_INSTALLMENTS"`) && strings.Contains(up, "FOR UPDATE") {
			sawInstLock = true
		}
		if strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE") {
			sawLoanLock = true
		}
	}
	if !sawInsertExpense {
		t.Error("falta INSERT INTO expenses dentro de la tx atómica")
	}
	if !sawUpdateInst {
		t.Error("falta UPDATE loan_installments")
	}
	if !sawUpdateLoan {
		t.Error("falta UPDATE loans con remaining_balance")
	}
	if !sawInstLock {
		t.Error("PayInstallmentAtomic debe tomar SELECT ... FOR UPDATE sobre la cuota")
	}
	if !sawLoanLock {
		t.Error("PayInstallmentAtomic debe tomar SELECT ... FOR UPDATE sobre el loan")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("PayInstallmentAtomic debe correr en una sola transacción confirmada; eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_PayInstallmentAtomic_InstallmentNotFound(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE") {
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 220, "ACTIVE")}}
		}
		return fakeResult{Columns: instCols} // installment no encontrada
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayInstallmentAtomic(context.Background(), 10, ports.PayInstallmentAtomicInput{
		Number: 99, Amount: 10, PaymentSource: "EFECTIVO", ActorDNI: "ADMIN", CashAmount: 10,
	})
	if !errors.Is(err, ports.ErrInstallmentNotFound) {
		t.Fatalf("err=%v, want ErrInstallmentNotFound", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
	// Y NO debe haber INSERT a expenses.
	for _, st := range f.statements() {
		if strings.Contains(strings.ToUpper(st.SQL), `INSERT INTO "EXPENSES"`) {
			t.Fatal("NO debe insertarse Expense si la cuota no existe")
		}
	}
}

func TestLoanRepo_PayInstallmentAtomic_IdempotenteYaPagada(t *testing.T) {
	// La cuota aparece ya PAID. El repo DEBE devolver ErrInstallmentAlreadyPaid
	// sin crear expense, sin tocar loans ni loan_installments.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 0, "PAID")}}
		case strings.Contains(up, `FROM "LOAN_INSTALLMENTS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: instCols, Rows: [][]driver.Value{instRow(1, 10, 2, 100, 10, 110, "PAID")}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayInstallmentAtomic(context.Background(), 10, ports.PayInstallmentAtomicInput{
		Number: 2, Amount: 110, PaymentSource: "EFECTIVO", ActorDNI: "ADMIN", CashAmount: 110,
	})
	if !errors.Is(err, ports.ErrInstallmentAlreadyPaid) {
		t.Fatalf("err=%v, want ErrInstallmentAlreadyPaid", err)
	}
	// No debe haber INSERT a expenses: la idempotencia impide crear dinero duplicado.
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, `INSERT INTO "EXPENSES"`) {
			t.Error("segundo intento NO debe emitir INSERT INTO expenses")
		}
		if strings.Contains(up, `UPDATE "LOAN_INSTALLMENTS"`) {
			t.Error("segundo intento NO debe emitir UPDATE loan_installments")
		}
	}
	// La tx se abre y se rolleaba porque devolvemos error.
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("idempotencia debe terminar con ROLLBACK (no COMMIT); eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_PayInstallmentAtomic_RollbackSiFallaUpdateCuota(t *testing.T) {
	// El INSERT en expenses funciona pero el UPDATE de la cuota falla:
	// la tx debe revertirse ENTERA, de modo que el Expense tampoco quede.
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			up := strings.ToUpper(q)
			switch {
			case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 220, "ACTIVE")}}
			case strings.Contains(up, `FROM "LOAN_INSTALLMENTS"`) && strings.Contains(up, "FOR UPDATE"):
				return fakeResult{Columns: instCols, Rows: [][]driver.Value{instRow(1, 10, 2, 100, 10, 0, "PENDING")}}
			case strings.Contains(up, `INSERT INTO "EXPENSES"`):
				return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(555)}}}
			}
			return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
		},
		execError: func(q string, _ []interface{}) error {
			if strings.Contains(strings.ToUpper(q), `UPDATE "LOAN_INSTALLMENTS"`) {
				return errors.New("boom update")
			}
			return nil
		},
	}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayInstallmentAtomic(context.Background(), 10, ports.PayInstallmentAtomicInput{
		Number: 2, Amount: 110, PaymentSource: "EFECTIVO", ActorDNI: "ADMIN", CashAmount: 110,
	})
	if err == nil {
		t.Fatal("se esperaba error del UPDATE")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse para no dejar Expense huérfano; eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_PayInstallmentAtomic_RechazaMontoDistintoDeRemaining(t *testing.T) {
	// Pago parcial no admitido: la cuota debe 110 y el input manda 50.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 220, "ACTIVE")}}
		case strings.Contains(up, `FROM "LOAN_INSTALLMENTS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: instCols, Rows: [][]driver.Value{instRow(1, 10, 2, 100, 10, 0, "PENDING")}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayInstallmentAtomic(context.Background(), 10, ports.PayInstallmentAtomicInput{
		Number: 2, Amount: 50, PaymentSource: "EFECTIVO", ActorDNI: "ADMIN", CashAmount: 50,
	})
	if err == nil || !strings.Contains(err.Error(), "exactamente") {
		t.Fatalf("se esperaba rechazo por pago parcial; err=%v", err)
	}
	// Y NO debe insertar expense.
	for _, st := range f.statements() {
		if strings.Contains(strings.ToUpper(st.SQL), `INSERT INTO "EXPENSES"`) {
			t.Fatal("pago parcial NO debe generar Expense")
		}
	}
}

func TestLoanRepo_RegisterLoanExpense_RechazaOverspend(t *testing.T) {
	// Loan principal=1000, SUM(amount_used) ya es 900, nuevo intento 200.
	// 900 + 200 = 1100 > 1000 → ErrPrincipalExceeded.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 1100, "ACTIVE")}}
		case strings.Contains(up, "COALESCE(SUM(AMOUNT_USED)"):
			return fakeResult{Columns: []string{"sum"}, Rows: [][]driver.Value{{900.0}}}
		}
		return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))

	exp := &models.LoanExpense{LoanID: 10, AmountUsed: 200, CreatedByDNI: "ADMIN"}
	_, err := repo.RegisterLoanExpense(context.Background(), exp)
	if !errors.Is(err, ports.ErrPrincipalExceeded) {
		t.Fatalf("err=%v, want ErrPrincipalExceeded", err)
	}
	// La tx debe revertirse para que no quede fila huérfana.
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_RegisterLoanExpense_AceptaDentroDelPrincipal(t *testing.T) {
	// Loan principal=1000, SUM existente 400, nuevo 500 → total 900 ≤ 1000 OK.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 1100, "ACTIVE")}}
		case strings.Contains(up, "COALESCE(SUM(AMOUNT_USED)"):
			return fakeResult{Columns: []string{"sum"}, Rows: [][]driver.Value{{400.0}}}
		}
		return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	exp := &models.LoanExpense{LoanID: 10, AmountUsed: 500, CreatedByDNI: "ADMIN"}
	total, err := repo.RegisterLoanExpense(context.Background(), exp)
	if err != nil {
		t.Fatalf("RegisterLoanExpense: %v", err)
	}
	if total != 900 {
		t.Errorf("total usado = %v, want 900", total)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("tx debe confirmarse; eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_SoftDelete_RechazaSiHayPagos(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 1100, "ACTIVE")}}
		case strings.Contains(up, "COUNT(*) FROM LOAN_INSTALLMENTS") && strings.Contains(up, "PAID_AMOUNT > 0"):
			return fakeResult{Columns: []string{"c"}, Rows: [][]driver.Value{{int64(1)}}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	err := repo.SoftDelete(context.Background(), 10)
	if err == nil {
		t.Fatal("se esperaba error por pagos registrados")
	}
	if !strings.Contains(err.Error(), "pagos") {
		t.Errorf("err poco claro: %v", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
}

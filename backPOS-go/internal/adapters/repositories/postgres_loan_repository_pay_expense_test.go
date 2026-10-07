package repositories

import (
	"context"
	"database/sql/driver"
	"errors"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/ports"
)

// =============================================================================
// Pruebas del PostgresLoanRepository.PayExpenseAtomic (opción "pagar con
// préstamo") usando el fakeSQL driver (ver fake_sql_driver_test.go). No
// tocan Postgres; validan el flujo transaccional y los sentinels.
//
// Universo de validaciones:
//   - BEGIN / SELECT ... FOR UPDATE sobre loans / SUM(amount_used) /
//     INSERT INTO expenses / INSERT INTO loan_expenses / COMMIT.
//   - ErrLoanNotFound si el loan no existe.
//   - ErrLoanNotActive si el loan no está en ACTIVE/DEFAULTED.
//   - ErrPrincipalExceeded si amount > disponible.
//   - ROLLBACK y 0 side-effects al fallar.
//   - Abono: lee la deuda existente con FOR UPDATE, recorta al remaining
//     y actualiza paid_amount/remaining/status.
// =============================================================================

// Columnas que GORM pide para models.Expense. Mantener en sincronía con el
// struct `models.Expense` (expense.go) para que `First(&models.Expense{})`
// pueda deserializar la fila que devuelve el fake driver.
var expenseCols = []string{
	"id", "description", "amount", "date", "paymentSource", "category",
	"supplier_id", "status", "lenderName", "tax_amount", "reference_id",
	"return_ref", "paid_amount", "remaining_amount", "cash_amount",
	"nequi_amount", "daviplata_amount", "fondo_amount", "coins_amount",
	"is_restocked", "createdByDni", "deleted_at",
}

// expenseDebtRow construye una fila de egreso representando una DEUDA
// VIVA (status PENDING, remaining > 0).
func expenseDebtRow(id int64, amount, paid, remaining float64, status, paymentSource string) []driver.Value {
	return []driver.Value{
		id, "PROV X", amount, time.Now(), paymentSource, "Proveedores",
		nil, status, "", 0.0, "",
		nil, paid, remaining, 0.0,
		0.0, 0.0, 0.0, 0.0,
		false, "ADMIN-1", nil,
	}
}

// -------- Flujo nuevo egreso ------------------------------------------------

func TestLoanRepo_PayExpenseAtomic_NuevoEgreso_HappyPath(t *testing.T) {
	// loan: principal=1000, status=ACTIVE. SUM(amount_used) actual=200.
	// Nuevo egreso de 300 → total 500 ≤ 1000 OK. Disponible = 500.
	var sawInsertExpense, sawInsertLoanExp bool
	var sawLoanLock, sawSumUsed bool
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			up := strings.ToUpper(q)
			switch {
			case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
				sawLoanLock = true
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 800, "ACTIVE")}}
			case strings.Contains(up, "COALESCE(SUM(AMOUNT_USED)"):
				sawSumUsed = true
				return fakeResult{Columns: []string{"sum"}, Rows: [][]driver.Value{{200.0}}}
			case strings.Contains(up, `INSERT INTO "EXPENSES"`):
				sawInsertExpense = true
				return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(777)}}}
			case strings.Contains(up, `INSERT INTO "LOAN_EXPENSES"`):
				sawInsertLoanExp = true
				return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(42)}}}
			}
			return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
		},
	}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	outcome, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		Amount: 300, Description: "LUZ", Category: "Servicios",
		Purpose: "PAGO LUZ", ActorDNI: "ADMIN-1", PaidAt: time.Now(),
	})
	if err != nil {
		t.Fatalf("PayExpenseAtomic nuevo: %v", err)
	}
	if outcome == nil || outcome.Expense == nil || outcome.LoanExpense == nil {
		t.Fatalf("outcome incompleto: %+v", outcome)
	}
	if outcome.Expense.PaymentSource != "PRESTAMO" {
		t.Errorf("expense.PaymentSource = %q, want PRESTAMO", outcome.Expense.PaymentSource)
	}
	if outcome.Expense.Status != "PAID" {
		t.Errorf("expense.Status = %q, want PAID", outcome.Expense.Status)
	}
	if outcome.Expense.CashAmount != 0 || outcome.Expense.NequiAmount != 0 || outcome.Expense.DaviplataAmount != 0 || outcome.Expense.FondoAmount != 0 || outcome.Expense.CoinsAmount != 0 {
		t.Errorf("todos los canales deben quedar en 0: %+v", outcome.Expense)
	}
	if outcome.Expense.PaidAmount != outcome.Expense.Amount {
		t.Errorf("PaidAmount debe igualar Amount: %+v", outcome.Expense)
	}
	if outcome.Expense.RemainingAmount != 0 {
		t.Errorf("RemainingAmount debe ser 0: %+v", outcome.Expense)
	}
	if outcome.AppliedAmount != 300 {
		t.Errorf("appliedAmount=%v, want 300", outcome.AppliedAmount)
	}
	// usedBefore (200) + applied (300) = 500. Disponible = 1000 - 500 = 500.
	if outcome.TotalUsedAfter != 500 {
		t.Errorf("totalUsed=%v, want 500", outcome.TotalUsedAfter)
	}
	if outcome.Available != 500 {
		t.Errorf("available=%v, want 500", outcome.Available)
	}
	if outcome.UpdatedDebt != nil {
		t.Errorf("nuevo egreso no debe venir con UpdatedDebt, got %+v", outcome.UpdatedDebt)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("se esperaba BEGIN/COMMIT; eventos=%v", f.txEvents)
	}
	if !sawLoanLock {
		t.Error("falta SELECT ... FOR UPDATE sobre loans")
	}
	if !sawSumUsed {
		t.Error("falta SUM(amount_used)")
	}
	if !sawInsertExpense {
		t.Error("falta INSERT INTO expenses")
	}
	if !sawInsertLoanExp {
		t.Error("falta INSERT INTO loan_expenses")
	}
}

func TestLoanRepo_PayExpenseAtomic_LoanNotFound(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE") {
			return fakeResult{Columns: loanCols} // sin filas
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayExpenseAtomic(context.Background(), 999, ports.PayExpenseAtomicInput{
		Amount: 100, Description: "x", ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrLoanNotFound) {
		t.Fatalf("err=%v, want ErrLoanNotFound", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, `INSERT INTO "EXPENSES"`) || strings.Contains(up, `INSERT INTO "LOAN_EXPENSES"`) {
			t.Error("no debe insertarse nada si el loan no existe")
		}
	}
}

func TestLoanRepo_PayExpenseAtomic_LoanNotActive(t *testing.T) {
	// Loan en PAID → no admite más usos.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE") {
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 0, "PAID")}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		Amount: 100, Description: "x", ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrLoanNotActive) {
		t.Fatalf("err=%v, want ErrLoanNotActive", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, `INSERT INTO "EXPENSES"`) {
			t.Error("no debe insertarse Expense si el loan no está activo")
		}
	}
}

func TestLoanRepo_PayExpenseAtomic_LoanDefaultedAceptado(t *testing.T) {
	// DEFAULTED también permite nuevos usos (regla operativa).
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 500, "DEFAULTED")}}
		case strings.Contains(up, "COALESCE(SUM(AMOUNT_USED)"):
			return fakeResult{Columns: []string{"sum"}, Rows: [][]driver.Value{{0.0}}}
		case strings.Contains(up, `INSERT INTO "EXPENSES"`):
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(100)}}}
		case strings.Contains(up, `INSERT INTO "LOAN_EXPENSES"`):
			return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(50)}}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		Amount: 200, Description: "x", ActorDNI: "ADMIN",
	})
	if err != nil {
		t.Fatalf("DEFAULTED debe permitir pay-expense: %v", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("tx debe confirmar; eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_PayExpenseAtomic_PrincipalExceeded(t *testing.T) {
	// Principal=1000, usedBefore=900, intento 200 → 900+200=1100 > 1000.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 1100, "ACTIVE")}}
		case strings.Contains(up, "COALESCE(SUM(AMOUNT_USED)"):
			return fakeResult{Columns: []string{"sum"}, Rows: [][]driver.Value{{900.0}}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		Amount: 200, Description: "x", ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrPrincipalExceeded) {
		t.Fatalf("err=%v, want ErrPrincipalExceeded", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, `INSERT INTO "EXPENSES"`) || strings.Contains(up, `INSERT INTO "LOAN_EXPENSES"`) {
			t.Error("no debe insertarse nada si excede el principal")
		}
	}
}

func TestLoanRepo_PayExpenseAtomic_RollbackSiFallaInsertLoanExpense(t *testing.T) {
	// El INSERT a expenses pasa, pero el INSERT a loan_expenses falla:
	// la tx debe revertirse ENTERA para no dejar el Expense PRESTAMO
	// huérfano sin su descuento en la bitácora.
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			up := strings.ToUpper(q)
			switch {
			case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 500, "ACTIVE")}}
			case strings.Contains(up, "COALESCE(SUM(AMOUNT_USED)"):
				return fakeResult{Columns: []string{"sum"}, Rows: [][]driver.Value{{0.0}}}
			case strings.Contains(up, `INSERT INTO "EXPENSES"`):
				return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(777)}}}
			case strings.Contains(up, `INSERT INTO "LOAN_EXPENSES"`):
				return fakeResult{Err: errors.New("boom bitácora")}
			}
			return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
		},
	}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		Amount: 100, Description: "x", ActorDNI: "ADMIN",
	})
	if err == nil {
		t.Fatal("se esperaba error del INSERT loan_expenses")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
}

// -------- Flujo abono deuda ------------------------------------------------

func TestLoanRepo_PayExpenseAtomic_AbonoRecortaAlRemaining(t *testing.T) {
	// Deuda viva: amount=500, paid=200, remaining=300, status=PENDING.
	// Monto solicitado 1000, se recorta a 300. Deuda queda SETTLED.
	expenseID := uint(55)
	var expenseLockSeen, updatedDebt, insertedAbono bool
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			up := strings.ToUpper(q)
			switch {
			case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 500, "ACTIVE")}}
			case strings.Contains(up, "COALESCE(SUM(AMOUNT_USED)"):
				return fakeResult{Columns: []string{"sum"}, Rows: [][]driver.Value{{0.0}}}
			case strings.Contains(up, `FROM "EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
				expenseLockSeen = true
				return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expenseDebtRow(55, 500, 200, 300, "PENDING", "PRESTAMO")}}
			case strings.Contains(up, `INSERT INTO "EXPENSES"`):
				insertedAbono = true
				return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(777)}}}
			case strings.Contains(up, `INSERT INTO "LOAN_EXPENSES"`):
				return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(42)}}}
			case strings.Contains(up, `FROM "EXPENSES"`):
				// Recarga de la deuda tras UPDATE.
				return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expenseDebtRow(55, 500, 500, 0, "SETTLED", "PRESTAMO")}}
			}
			return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
		},
		execError: func(q string, _ []interface{}) error {
			if strings.Contains(strings.ToUpper(q), `UPDATE "EXPENSES"`) {
				updatedDebt = true
			}
			return nil
		},
	}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	outcome, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		ExpenseID: &expenseID,
		Amount:    1000, // mayor que remaining (300), debe recortarse
		ActorDNI:  "ADMIN",
	})
	if err != nil {
		t.Fatalf("abono: %v", err)
	}
	if outcome.AppliedAmount != 300 {
		t.Errorf("applied=%v, want 300 (recortado al remaining)", outcome.AppliedAmount)
	}
	if outcome.UpdatedDebt == nil {
		t.Fatal("UpdatedDebt debe venir en el outcome del abono")
	}
	if outcome.UpdatedDebt.Status != "SETTLED" {
		t.Errorf("deuda tras recorte total debe quedar SETTLED, got %q", outcome.UpdatedDebt.Status)
	}
	if outcome.LoanExpense == nil || outcome.LoanExpense.SourceExpenseID == nil || *outcome.LoanExpense.SourceExpenseID != expenseID {
		t.Fatalf("loan_expense debe guardar sourceExpenseId=%d: %+v", expenseID, outcome.LoanExpense)
	}
	if outcome.LoanExpense.SourceStatusBefore == nil || *outcome.LoanExpense.SourceStatusBefore != "PENDING" ||
		outcome.LoanExpense.SourcePaidBefore == nil || *outcome.LoanExpense.SourcePaidBefore != 200 ||
		outcome.LoanExpense.SourceRemainingBefore == nil || *outcome.LoanExpense.SourceRemainingBefore != 300 {
		t.Errorf("snapshots previos incorrectos: %+v", outcome.LoanExpense)
	}
	if !expenseLockSeen {
		t.Error("falta SELECT ... FOR UPDATE sobre expenses")
	}
	if !updatedDebt {
		t.Error("falta UPDATE expenses sobre la deuda original")
	}
	if !insertedAbono {
		t.Error("falta INSERT INTO expenses para el abono")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("tx debe confirmar; eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_PayExpenseAtomic_AbonoParcialDejaPendiente(t *testing.T) {
	// Deuda viva: remaining=300. Pago 100 → remaining tras pago = 200, PENDING.
	expenseID := uint(55)
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			up := strings.ToUpper(q)
			switch {
			case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 500, "ACTIVE")}}
			case strings.Contains(up, "COALESCE(SUM(AMOUNT_USED)"):
				return fakeResult{Columns: []string{"sum"}, Rows: [][]driver.Value{{0.0}}}
			case strings.Contains(up, `FROM "EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
				return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expenseDebtRow(55, 500, 200, 300, "PENDING", "PRESTAMO")}}
			case strings.Contains(up, `INSERT INTO "EXPENSES"`):
				return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(777)}}}
			case strings.Contains(up, `INSERT INTO "LOAN_EXPENSES"`):
				return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(42)}}}
			case strings.Contains(up, `FROM "EXPENSES"`):
				return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expenseDebtRow(55, 500, 300, 200, "PENDING", "PRESTAMO")}}
			}
			return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
		},
	}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	outcome, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		ExpenseID: &expenseID, Amount: 100, ActorDNI: "ADMIN",
	})
	if err != nil {
		t.Fatalf("abono parcial: %v", err)
	}
	if outcome.AppliedAmount != 100 {
		t.Errorf("applied=%v, want 100", outcome.AppliedAmount)
	}
	if outcome.UpdatedDebt == nil || outcome.UpdatedDebt.Status != "PENDING" {
		t.Errorf("abono parcial debe dejar deuda PENDING, got %+v", outcome.UpdatedDebt)
	}
}

func TestLoanRepo_PayExpenseAtomic_AbonoExpenseNotFound(t *testing.T) {
	expenseID := uint(999)
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 500, "ACTIVE")}}
		case strings.Contains(up, "COALESCE(SUM(AMOUNT_USED)"):
			return fakeResult{Columns: []string{"sum"}, Rows: [][]driver.Value{{0.0}}}
		case strings.Contains(up, `FROM "EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: expenseCols} // sin filas
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		ExpenseID: &expenseID, Amount: 100, ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrExpenseNotFound) {
		t.Fatalf("err=%v, want ErrExpenseNotFound", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_PayExpenseAtomic_AbonoYaPagado(t *testing.T) {
	expenseID := uint(55)
	// Deuda PAID → ErrExpenseNotPayable, sin crear nada.
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1000, 1100, 500, "ACTIVE")}}
		case strings.Contains(up, "COALESCE(SUM(AMOUNT_USED)"):
			return fakeResult{Columns: []string{"sum"}, Rows: [][]driver.Value{{0.0}}}
		case strings.Contains(up, `FROM "EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expenseDebtRow(55, 500, 500, 0, "PAID", "EFECTIVO")}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		ExpenseID: &expenseID, Amount: 100, ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrExpenseNotPayable) {
		t.Fatalf("err=%v, want ErrExpenseNotPayable", err)
	}
	for _, st := range f.statements() {
		if strings.Contains(strings.ToUpper(st.SQL), `INSERT INTO "EXPENSES"`) {
			t.Error("no debe insertarse abono si la deuda ya está PAID")
		}
	}
}

// Validaciones de input tempranas (antes del BEGIN).
func TestLoanRepo_PayExpenseAtomic_InputInvalido(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))

	// loanID = 0
	if _, err := repo.PayExpenseAtomic(context.Background(), 0, ports.PayExpenseAtomicInput{
		Amount: 100, Description: "x", ActorDNI: "ADMIN",
	}); err == nil || !strings.Contains(err.Error(), "loanID") {
		t.Errorf("loanID=0 debe fallar temprano; err=%v", err)
	}
	// amount <= 0
	if _, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		Amount: 0, Description: "x", ActorDNI: "ADMIN",
	}); err == nil {
		t.Error("amount=0 debe fallar")
	}
	// actor vacío
	if _, err := repo.PayExpenseAtomic(context.Background(), 10, ports.PayExpenseAtomicInput{
		Amount: 100, Description: "x", ActorDNI: "",
	}); err == nil {
		t.Error("actor vacío debe fallar")
	}
	// Ninguna de estas rutas debe abrir una tx.
	if len(f.txEvents) != 0 {
		t.Errorf("input inválido no debe abrir transacción; eventos=%v", f.txEvents)
	}
}

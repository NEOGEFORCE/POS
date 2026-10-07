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

var loanExpenseReversalCols = []string{
	"id", "loan_id", "expense_id", "amount_used", "purpose", "created_by_dni", "created_at",
	"source_expense_id", "source_status_before", "source_paid_before", "source_remaining_before",
	"reversed_at", "reversed_by_dni",
}

func expensePaymentRow(id int64, amount float64) []driver.Value {
	return []driver.Value{
		id, "COLOMBINA", amount, time.Now(), "PRESTAMO", "Proveedores",
		int64(9), "PAID", "", 0.0, "", nil, amount, 0.0,
		0.0, 0.0, 0.0, 0.0, 0.0, false, "ADMIN-1", nil,
	}
}

func loanExpenseReversalRow(id, loanID, paymentID, sourceID int64, amount float64) []driver.Value {
	status := "PENDING"
	paidBefore := 0.0
	remainingBefore := amount
	return []driver.Value{
		id, loanID, paymentID, amount, "COLOMBINA", "ADMIN-1", time.Now(),
		sourceID, status, paidBefore, remainingBefore, nil, "",
	}
}

func TestExpenseRepo_DeleteWithLoanReversal_RestauraDeudaYLiberaPrincipal(t *testing.T) {
	const amount = 102075.0
	var sawDebtRestore, sawUsageReverse, sawPaymentDelete, sawLoanLock bool
	f := &fakeSQL{}
	f.respond = func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
			// Primera consulta = pago; segunda = deuda original.
			if strings.Contains(q, `"expenses"."id" = $1`) {
				// Los args no son necesarios: fakeSQL registra el orden.
			}
			count := 0
			for _, s := range f.statements() {
				if strings.Contains(strings.ToUpper(s.SQL), `FROM "EXPENSES"`) && strings.Contains(strings.ToUpper(s.SQL), "FOR UPDATE") {
					count++
				}
			}
			if count <= 1 {
				return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expensePaymentRow(777, amount)}}
			}
			return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expenseDebtRow(55, amount, amount, 0, "SETTLED", "PRESTAMO")}}
		case strings.Contains(up, `FROM "LOAN_EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanExpenseReversalCols, Rows: [][]driver.Value{loanExpenseReversalRow(42, 10, 777, 55, amount)}}
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			sawLoanLock = true
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1_000_000, 1_100_000, 1_100_000, "ACTIVE")}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}
	f.execError = func(q string, _ []interface{}) error {
		up := strings.ToUpper(q)
		if strings.Contains(up, `UPDATE "EXPENSES"`) && strings.Contains(up, "PAID_AMOUNT") {
			sawDebtRestore = true
		}
		if strings.Contains(up, `UPDATE "LOAN_EXPENSES"`) && strings.Contains(up, "REVERSED_AT") {
			sawUsageReverse = true
		}
		if strings.Contains(up, `UPDATE "EXPENSES"`) && strings.Contains(up, "DELETED_AT") {
			sawPaymentDelete = true
		}
		return nil
	}
	repo := NewPostgresExpenseRepository(newFakeGormDB(t, f))
	out, err := repo.DeleteWithLoanReversal(777, "admin-1")
	if err != nil {
		t.Fatalf("DeleteWithLoanReversal: %v", err)
	}
	if out == nil || !out.LoanReversed || out.RestoredDebtID == nil || *out.RestoredDebtID != 55 {
		t.Fatalf("resultado incompleto: %+v", out)
	}
	if out.RestoredAmount != amount || out.ReleasedPrincipal != amount {
		t.Errorf("montos resultado = %+v, want %.2f", out, amount)
	}
	if !sawLoanLock || !sawDebtRestore || !sawUsageReverse || !sawPaymentDelete {
		t.Errorf("faltan efectos: loanLock=%t debt=%t usage=%t delete=%t", sawLoanLock, sawDebtRestore, sawUsageReverse, sawPaymentDelete)
	}
	if got := strings.Join(f.txEvents, ","); got != "BEGIN,COMMIT" {
		t.Errorf("tx=%s, want BEGIN,COMMIT", got)
	}
}

func TestExpenseRepo_DeleteWithLoanReversal_FalloHaceRollbackTotal(t *testing.T) {
	const amount = 102075.0
	f := &fakeSQL{}
	f.respond = func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
			count := 0
			for _, s := range f.statements() {
				if strings.Contains(strings.ToUpper(s.SQL), `FROM "EXPENSES"`) && strings.Contains(strings.ToUpper(s.SQL), "FOR UPDATE") {
					count++
				}
			}
			if count <= 1 {
				return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expensePaymentRow(777, amount)}}
			}
			return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expenseDebtRow(55, amount, amount, 0, "SETTLED", "PRESTAMO")}}
		case strings.Contains(up, `FROM "LOAN_EXPENSES"`):
			return fakeResult{Columns: loanExpenseReversalCols, Rows: [][]driver.Value{loanExpenseReversalRow(42, 10, 777, 55, amount)}}
		case strings.Contains(up, `FROM "LOANS"`):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1_000_000, 1_100_000, 1_100_000, "ACTIVE")}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}
	f.execError = func(q string, _ []interface{}) error {
		if strings.Contains(strings.ToUpper(q), `UPDATE "LOAN_EXPENSES"`) {
			return errors.New("fallo simulado al marcar reversión")
		}
		return nil
	}
	repo := NewPostgresExpenseRepository(newFakeGormDB(t, f))
	if _, err := repo.DeleteWithLoanReversal(777, "ADMIN-1"); err == nil {
		t.Fatal("se esperaba error")
	}
	if got := strings.Join(f.txEvents, ","); got != "BEGIN,ROLLBACK" {
		t.Errorf("tx=%s, want BEGIN,ROLLBACK", got)
	}
}

func TestExpenseRepo_DeleteWithLoanReversal_EgresoNormalConservaDelete(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.Contains(up, `FROM "EXPENSES"`) {
			return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expensePaymentRow(88, 500)}}
		}
		if strings.Contains(up, `FROM "LOAN_EXPENSES"`) {
			return fakeResult{Columns: loanExpenseReversalCols, Rows: nil}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresExpenseRepository(newFakeGormDB(t, f))
	out, err := repo.DeleteWithLoanReversal(88, "ADMIN")
	if err != nil {
		t.Fatalf("delete normal: %v", err)
	}
	if out.LoanReversed || out.RestoredDebtID != nil {
		t.Errorf("un egreso sin loan_expense no debe reversar préstamo: %+v", out)
	}
	if got := strings.Join(f.txEvents, ","); got != "BEGIN,COMMIT" {
		t.Errorf("tx=%s", got)
	}
}

func TestLoanRepo_ReverseOrphanedLoanExpense_UnaCandidataExacta(t *testing.T) {
	const amount = 102075.0
	deleted := expensePaymentRow(777, amount)
	deleted[len(deleted)-1] = time.Now() // deleted_at
	var debtUpdated, usageReversed bool
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1_000_000, 1_100_000, 1_100_000, "ACTIVE")}}
		case strings.Contains(up, `FROM "LOAN_EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
			row := loanExpenseReversalRow(42, 10, 777, 0, amount)
			row[7] = nil // pre-022: source_expense_id desconocido
			row[8], row[9], row[10] = nil, nil, nil
			return fakeResult{Columns: loanExpenseReversalCols, Rows: [][]driver.Value{row}}
		case strings.Contains(up, `FROM "EXPENSES"`) && !strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{deleted}}
		case strings.Contains(up, `FROM "EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{expenseDebtRow(55, amount, amount, 0, "SETTLED", "PRESTAMO")}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}, execError: func(q string, _ []interface{}) error {
		up := strings.ToUpper(q)
		if strings.Contains(up, `UPDATE "EXPENSES"`) && strings.Contains(up, "PAID_AMOUNT") {
			debtUpdated = true
		}
		if strings.Contains(up, `UPDATE "LOAN_EXPENSES"`) && strings.Contains(up, "REVERSED_AT") {
			usageReversed = true
		}
		return nil
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	out, err := repo.ReverseOrphanedLoanExpense(context.Background(), 10, 42, "ADMIN-1")
	if err != nil {
		t.Fatalf("ReverseOrphanedLoanExpense: %v", err)
	}
	if out.RestoredDebtID != 55 || out.RestoredAmount != amount || out.ReleasedPrincipal != amount {
		t.Errorf("outcome=%+v", out)
	}
	if !debtUpdated || !usageReversed {
		t.Errorf("debtUpdated=%t usageReversed=%t", debtUpdated, usageReversed)
	}
	if got := strings.Join(f.txEvents, ","); got != "BEGIN,COMMIT" {
		t.Errorf("tx=%s", got)
	}
}

func TestLoanRepo_ReverseOrphanedLoanExpense_AmbiguoHaceRollback(t *testing.T) {
	const amount = 102075.0
	deleted := expensePaymentRow(777, amount)
	deleted[len(deleted)-1] = time.Now()
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 1_000_000, 1_100_000, 1_100_000, "ACTIVE")}}
		case strings.Contains(up, `FROM "LOAN_EXPENSES"`):
			row := loanExpenseReversalRow(42, 10, 777, 0, amount)
			row[7], row[8], row[9], row[10] = nil, nil, nil, nil
			return fakeResult{Columns: loanExpenseReversalCols, Rows: [][]driver.Value{row}}
		case strings.Contains(up, `FROM "EXPENSES"`) && !strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{deleted}}
		case strings.Contains(up, `FROM "EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
			row := expenseDebtRow(55, amount, amount, 0, "SETTLED", "PRESTAMO")
			row2 := expenseDebtRow(56, amount, amount, 0, "SETTLED", "PRESTAMO")
			return fakeResult{Columns: expenseCols, Rows: [][]driver.Value{row, row2}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.ReverseOrphanedLoanExpense(context.Background(), 10, 42, "ADMIN")
	if !errors.Is(err, ports.ErrLoanOrphanDebtAmbiguous) {
		t.Fatalf("err=%v, want ErrLoanOrphanDebtAmbiguous", err)
	}
	if got := strings.Join(f.txEvents, ","); got != "BEGIN,ROLLBACK" {
		t.Errorf("tx=%s", got)
	}
}

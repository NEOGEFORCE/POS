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
// Pruebas del PostgresLoanRepository.UpdateLoanAtomic (PUT /api/loans/:id)
// usando el fakeSQL driver. Validan:
//
//   - Metadata-only: BEGIN, SELECT ... FOR UPDATE sobre loans, UPDATE loans,
//     recalc status, COMMIT; NO borra ni inserta cuotas.
//   - Recalculate: cuenta cuotas pagadas (0), suma amount_used, DELETE +
//     INSERT de loan_installments, UPDATE loans con campos financieros,
//     COMMIT. NUNCA toca loan_expenses.
//   - ErrLoanHasPaidInstallments cuando hay cuotas con paid_amount > 0.
//   - ErrLoanPrincipalBelowUsage cuando principal nuevo < SUM(amount_used).
//   - ErrLoanNotFound si no existe.
//   - ROLLBACK total ante fallo.
// =============================================================================

func baseAtomicMetadata() ports.UpdateLoanAtomicInput {
	return ports.UpdateLoanAtomicInput{
		LenderName:          "BANCO DE BOGOTA",
		DisbursementChannel: "BANCO",
		LoanType:            "CONSUMO",
		Currency:            "COP",
		RateType:            "FIJO",
		ActorDNI:            "ADMIN-1",
	}
}

func TestLoanRepo_UpdateLoanAtomic_MetadataOnly(t *testing.T) {
	var sawLoanLock, sawUpdateLoan, sawDeleteInst, sawInsertInst bool
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			up := strings.ToUpper(q)
			switch {
			case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
				sawLoanLock = true
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 25_000_000, 30_000_000, 30_000_000, "ACTIVE")}}
			case strings.Contains(up, "SELECT STATUS FROM LOANS"):
				return one("status", "ACTIVE")
			case strings.Contains(up, "COUNT(*)"):
				// recalculateLoanStatusTx totals
				return fakeResult{Columns: []string{"total", "paid"}, Rows: [][]driver.Value{{int64(60), int64(0)}}}
			case strings.Contains(up, `FROM "LOANS"`):
				// Recarga final.
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 25_000_000, 30_000_000, 30_000_000, "ACTIVE")}}
			}
			return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
		},
		execError: func(q string, _ []interface{}) error {
			up := strings.ToUpper(q)
			if strings.Contains(up, `UPDATE "LOANS"`) || strings.Contains(up, "UPDATE LOANS SET STATUS") {
				sawUpdateLoan = true
			}
			if strings.Contains(up, `DELETE FROM "LOAN_INSTALLMENTS"`) {
				sawDeleteInst = true
			}
			if strings.Contains(up, `INSERT INTO "LOAN_INSTALLMENTS"`) {
				sawInsertInst = true
			}
			return nil
		},
	}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))

	in := baseAtomicMetadata()
	cn := "0013-0021-96-00322102"
	in.CreditNumber = &cn
	outcome, err := repo.UpdateLoanAtomic(context.Background(), 10, in)
	if err != nil {
		t.Fatalf("UpdateLoanAtomic metadata-only: %v", err)
	}
	if outcome == nil || outcome.Loan == nil {
		t.Fatal("outcome incompleto")
	}
	if outcome.Recalculated {
		t.Error("metadata-only no debe marcar Recalculated")
	}
	if !sawLoanLock {
		t.Error("falta SELECT ... FOR UPDATE sobre loans")
	}
	if !sawUpdateLoan {
		t.Error("falta UPDATE loans con la metadata")
	}
	if sawDeleteInst {
		t.Error("metadata-only NO debe borrar cuotas")
	}
	if sawInsertInst {
		t.Error("metadata-only NO debe insertar cuotas")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("se esperaba BEGIN/COMMIT; eventos=%v", f.txEvents)
	}
	// NUNCA debe tocar loan_expenses.
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, `DELETE FROM "LOAN_EXPENSES"`) || strings.Contains(up, `UPDATE "LOAN_EXPENSES"`) {
			t.Error("UpdateLoanAtomic no debe mutar loan_expenses")
		}
	}
}

func TestLoanRepo_UpdateLoanAtomic_RecalculateBorraEInsertaCuotas(t *testing.T) {
	var sawDeleteInst, sawInsertInst, sawPaidCount, sawSumUsed bool
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			up := strings.ToUpper(q)
			switch {
			case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 25_000_000, 30_000_000, 30_000_000, "ACTIVE")}}
			case strings.Contains(up, `FROM "LOAN_INSTALLMENTS"`) && strings.Contains(up, "FOR UPDATE"):
				sawPaidCount = true
				return fakeResult{
					Columns: []string{"id", "paid_amount"},
					Rows: [][]driver.Value{
						{int64(1), 0.0}, {int64(2), 0.0}, {int64(3), 0.0},
					},
				}
			case strings.Contains(up, `FROM "LOAN_EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
				sawSumUsed = true
				return fakeResult{Columns: []string{"id", "amount_used"}, Rows: [][]driver.Value{{int64(91), 5_000_000.0}}}
			case strings.Contains(up, "SELECT STATUS FROM LOANS"):
				return one("status", "ACTIVE")
			case strings.Contains(up, "COUNT(*)") && strings.Contains(up, "FILTER"):
				return fakeResult{Columns: []string{"total", "paid"}, Rows: [][]driver.Value{{int64(60), int64(0)}}}
			case strings.Contains(up, `INSERT INTO "LOAN_INSTALLMENTS"`):
				sawInsertInst = true
				// CreateInBatches con RETURNING id: devolver ids para 3 cuotas.
				return fakeResult{Columns: []string{"id"}, Rows: [][]driver.Value{{int64(1)}, {int64(2)}, {int64(3)}}}
			case strings.Contains(up, `FROM "LOANS"`):
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 25_000_000, 30_000_000, 30_000_000, "ACTIVE")}}
			}
			return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
		},
		execError: func(q string, _ []interface{}) error {
			up := strings.ToUpper(q)
			if strings.Contains(up, `DELETE FROM "LOAN_INSTALLMENTS"`) {
				sawDeleteInst = true
			}
			if strings.Contains(up, `INSERT INTO "LOAN_INSTALLMENTS"`) {
				sawInsertInst = true
			}
			return nil
		},
	}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))

	in := baseAtomicMetadata()
	in.Recalculate = true
	in.NewPrincipalAmount = 25_000_000
	in.NewInterestMode = models.InterestModeSimple
	in.NewInterestRatePct = 10
	in.NewTermCount = 3
	in.NewPaymentFrequency = models.PaymentFrequencyMonthly
	in.NewFirstPaymentDate = time.Now().AddDate(0, 1, 0)
	in.NewTotalPayable = 27_500_000
	in.NewSchedule = []models.LoanInstallment{
		{Number: 1, DueDate: time.Now(), PrincipalDue: 8_333_333, InterestDue: 833_333},
		{Number: 2, DueDate: time.Now().AddDate(0, 1, 0), PrincipalDue: 8_333_333, InterestDue: 833_333},
		{Number: 3, DueDate: time.Now().AddDate(0, 2, 0), PrincipalDue: 8_333_334, InterestDue: 833_334},
	}

	outcome, err := repo.UpdateLoanAtomic(context.Background(), 10, in)
	if err != nil {
		t.Fatalf("UpdateLoanAtomic recalculate: %v", err)
	}
	if !outcome.Recalculated {
		t.Error("Recalculated debe quedar true")
	}
	if !sawPaidCount {
		t.Error("falta el conteo de cuotas pagadas antes de recalcular")
	}
	if !sawSumUsed {
		t.Error("falta SUM(amount_used) para validar el principal")
	}
	if !sawDeleteInst {
		t.Error("recalculate debe borrar las cuotas previas")
	}
	if !sawInsertInst {
		t.Error("recalculate debe insertar el cronograma nuevo")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,COMMIT" {
		t.Errorf("tx debe confirmar; eventos=%v", f.txEvents)
	}
	// loan_expenses intacto.
	for _, st := range f.statements() {
		up := strings.ToUpper(st.SQL)
		if strings.Contains(up, `DELETE FROM "LOAN_EXPENSES"`) {
			t.Error("recalculate NUNCA debe borrar loan_expenses")
		}
	}
}

func TestLoanRepo_UpdateLoanAtomic_RechazaRecalcConCuotasPagadas(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 25_000_000, 30_000_000, 29_000_000, "ACTIVE")}}
		case strings.Contains(up, `FROM "LOAN_INSTALLMENTS"`) && strings.Contains(up, "FOR UPDATE"):
			// Hay 1 cuota con pagos.
			return fakeResult{Columns: []string{"id", "paid_amount"}, Rows: [][]driver.Value{{int64(1), 693_951.69}}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))

	in := baseAtomicMetadata()
	in.Recalculate = true
	in.NewPrincipalAmount = 25_000_000
	in.NewInterestMode = models.InterestModeSimple
	in.NewTermCount = 3
	in.NewSchedule = []models.LoanInstallment{{Number: 1, DueDate: time.Now(), PrincipalDue: 1000}}

	_, err := repo.UpdateLoanAtomic(context.Background(), 10, in)
	if !errors.Is(err, ports.ErrLoanHasPaidInstallments) {
		t.Fatalf("err=%v, want ErrLoanHasPaidInstallments", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
	for _, st := range f.statements() {
		if strings.Contains(strings.ToUpper(st.SQL), `DELETE FROM "LOAN_INSTALLMENTS"`) {
			t.Error("no debe borrar cuotas si hay pagos")
		}
	}
}

func TestLoanRepo_UpdateLoanAtomic_RechazaPrincipalBajoUso(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		switch {
		case strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 25_000_000, 30_000_000, 30_000_000, "ACTIVE")}}
		case strings.Contains(up, `FROM "LOAN_INSTALLMENTS"`) && strings.Contains(up, "FOR UPDATE"):
			return fakeResult{Columns: []string{"id", "paid_amount"}, Rows: [][]driver.Value{{int64(1), 0.0}}}
		case strings.Contains(up, `FROM "LOAN_EXPENSES"`) && strings.Contains(up, "FOR UPDATE"):
			// Uso activo 10M > principal nuevo 5M.
			return fakeResult{Columns: []string{"id", "amount_used"}, Rows: [][]driver.Value{{int64(91), 10_000_000.0}}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))

	in := baseAtomicMetadata()
	in.Recalculate = true
	in.NewPrincipalAmount = 5_000_000 // menor que el uso activo 10M
	in.NewInterestMode = models.InterestModeSimple
	in.NewTermCount = 3
	in.NewSchedule = []models.LoanInstallment{{Number: 1, DueDate: time.Now(), PrincipalDue: 1000}}

	_, err := repo.UpdateLoanAtomic(context.Background(), 10, in)
	if !errors.Is(err, ports.ErrLoanPrincipalBelowUsage) {
		t.Fatalf("err=%v, want ErrLoanPrincipalBelowUsage", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_UpdateLoanAtomic_LoanNotFound(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE") {
			return fakeResult{Columns: loanCols} // sin filas
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.UpdateLoanAtomic(context.Background(), 999, baseAtomicMetadata())
	if !errors.Is(err, ports.ErrLoanNotFound) {
		t.Fatalf("err=%v, want ErrLoanNotFound", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_UpdateLoanAtomic_RollbackSiFallaUpdate(t *testing.T) {
	f := &fakeSQL{
		respond: func(q string, _ []interface{}) fakeResult {
			up := strings.ToUpper(q)
			if strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE") {
				return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 25_000_000, 30_000_000, 30_000_000, "ACTIVE")}}
			}
			return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
		},
		execError: func(q string, _ []interface{}) error {
			if strings.Contains(strings.ToUpper(q), `UPDATE "LOANS"`) {
				return errors.New("boom update loans")
			}
			return nil
		},
	}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))
	_, err := repo.UpdateLoanAtomic(context.Background(), 10, baseAtomicMetadata())
	if err == nil {
		t.Fatal("se esperaba error del UPDATE")
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
}

func TestLoanRepo_UpdateLoanAtomic_RechazaMaturityAntesDelStartPersistido(t *testing.T) {
	f := &fakeSQL{respond: func(q string, _ []interface{}) fakeResult {
		up := strings.ToUpper(q)
		if strings.Contains(up, `FROM "LOANS"`) && strings.Contains(up, "FOR UPDATE") {
			return fakeResult{Columns: loanCols, Rows: [][]driver.Value{loanRow(10, 25_000_000, 30_000_000, 30_000_000, "ACTIVE")}}
		}
		return fakeResult{Columns: []string{"ok"}, Rows: [][]driver.Value{{int64(1)}}}
	}}
	repo := NewPostgresLoanRepository(newFakeGormDB(t, f))

	in := baseAtomicMetadata()
	maturity := time.Now().AddDate(-1, 0, 0)
	in.MaturityDate = &maturity
	_, err := repo.UpdateLoanAtomic(context.Background(), 10, in)
	if !errors.Is(err, ports.ErrLoanMaturityBeforeStart) {
		t.Fatalf("err=%v, want ErrLoanMaturityBeforeStart", err)
	}
	if strings.Join(f.txEvents, ",") != "BEGIN,ROLLBACK" {
		t.Errorf("tx debe revertirse; eventos=%v", f.txEvents)
	}
	for _, st := range f.statements() {
		if strings.Contains(strings.ToUpper(st.SQL), `UPDATE "LOANS"`) {
			t.Error("maturity_date inválida no debe actualizar el préstamo")
		}
	}
}

package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

// =============================================================================
// Pruebas de LoanService.PayExpenseWithLoan.
//
// Contrato validado (decisión del dueño, opción 1):
//   - El endpoint NO toca ningún canal de la tienda.
//   - El servicio delega al repo (que crea el Expense PAID+PRESTAMO con
//     canales en 0 e inserta `loan_expenses`) y propaga su outcome.
//   - Errores clave: ErrLoanNotFound, ErrLoanNotActive, ErrPrincipalExceeded,
//     ErrExpenseNotFound, ErrExpenseNotPayable.
//   - La variante abono recorta al remaining (lo hace el repo); el servicio
//     redondea a 2 decimales y propaga el amount tal cual al repo.
// =============================================================================

func TestPayExpenseWithLoan_NuevoEgreso_HappyPath(t *testing.T) {
	// Repo acepta y devuelve outcome con disponible/total poblado.
	repo := &stubLoanRepoSvc{
		payExpOutcome: &ports.PayExpenseAtomicOutcome{
			Expense:        &models.Expense{ID: 42, PaymentSource: "PRESTAMO", Status: "PAID", Amount: 300, PaidAmount: 300, Description: "LUZ"},
			LoanExpense:    &models.LoanExpense{ID: 7, LoanID: 10, AmountUsed: 300, Purpose: "LUZ"},
			AppliedAmount:  300,
			TotalUsedAfter: 300,
			Available:      700,
		},
	}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	res, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID:      10,
		Amount:      300,
		Description: "LUZ",
		Category:    "Servicios",
		ActorDNI:    "ADMIN-1",
	})
	if err != nil {
		t.Fatalf("PayExpenseWithLoan: %v", err)
	}
	if repo.payExpCapture == nil {
		t.Fatal("el repo no recibió el pago")
	}
	if repo.payExpLoanIDCap != 10 {
		t.Errorf("loanID propagado = %d, want 10", repo.payExpLoanIDCap)
	}
	if repo.payExpCapture.ExpenseID != nil {
		t.Errorf("ExpenseID debe ser nil (nuevo egreso), got %v", repo.payExpCapture.ExpenseID)
	}
	if repo.payExpCapture.Amount != 300 {
		t.Errorf("amount propagado = %v, want 300", repo.payExpCapture.Amount)
	}
	if strings.TrimSpace(repo.payExpCapture.Description) != "LUZ" {
		t.Errorf("description = %q, want LUZ", repo.payExpCapture.Description)
	}
	if res == nil || res.Expense == nil {
		t.Fatal("resultado nil")
	}
	if res.Expense.PaymentSource != "PRESTAMO" {
		t.Errorf("expense.PaymentSource = %q, want PRESTAMO", res.Expense.PaymentSource)
	}
	if res.Available != 700 {
		t.Errorf("available = %v, want 700", res.Available)
	}
	if res.TotalUsedAfter != 300 {
		t.Errorf("totalUsed = %v, want 300", res.TotalUsedAfter)
	}
}

func TestPayExpenseWithLoan_Abono_HappyPath(t *testing.T) {
	expID := uint(55)
	repo := &stubLoanRepoSvc{
		payExpOutcome: &ports.PayExpenseAtomicOutcome{
			Expense:        &models.Expense{ID: 100, PaymentSource: "PRESTAMO", Status: "PAID", Amount: 150, PaidAmount: 150, Description: "ABONO A DEUDA: PROV X"},
			UpdatedDebt:    &models.Expense{ID: 55, Status: "SETTLED", Amount: 500, PaidAmount: 500, RemainingAmount: 0},
			LoanExpense:    &models.LoanExpense{ID: 8, LoanID: 10, ExpenseID: &expID, AmountUsed: 150},
			AppliedAmount:  150,
			TotalUsedAfter: 450,
			Available:      550,
		},
	}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	res, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID:    10,
		ExpenseID: &expID,
		Amount:    200, // repo recorta al remaining (150)
		ActorDNI:  "ADMIN-1",
	})
	if err != nil {
		t.Fatalf("PayExpenseWithLoan abono: %v", err)
	}
	if repo.payExpCapture.ExpenseID == nil || *repo.payExpCapture.ExpenseID != 55 {
		t.Errorf("ExpenseID propagado mal: %+v", repo.payExpCapture.ExpenseID)
	}
	if res.UpdatedDebt == nil {
		t.Fatal("UpdatedDebt debe venir en el resultado del abono")
	}
	if res.UpdatedDebt.Status != "SETTLED" {
		t.Errorf("updatedDebt.status = %q, want SETTLED", res.UpdatedDebt.Status)
	}
	// AppliedAmount es el valor recortado por el repo, no el solicitado.
	if res.AppliedAmount != 150 {
		t.Errorf("appliedAmount = %v, want 150 (recortado al remaining)", res.AppliedAmount)
	}
}

func TestPayExpenseWithLoan_RechazaAmountZero(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, Amount: 0, Description: "LUZ", ActorDNI: "ADMIN",
	})
	if err == nil || !strings.Contains(err.Error(), "mayor a cero") {
		t.Fatalf("amount=0 debe fallar; err=%v", err)
	}
}

func TestPayExpenseWithLoan_RechazaActorVacio(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, Amount: 100, Description: "LUZ",
	})
	if !errors.Is(err, ErrActorRequired) {
		t.Fatalf("sin actor debe retornar ErrActorRequired; err=%v", err)
	}
}

func TestPayExpenseWithLoan_RechazaLoanIDCero(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 0, Amount: 100, Description: "LUZ", ActorDNI: "ADMIN",
	})
	if err == nil {
		t.Fatal("loanID=0 debe fallar")
	}
}

func TestPayExpenseWithLoan_RechazaNaN(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, Amount: nanFloat(), Description: "LUZ", ActorDNI: "ADMIN",
	})
	if err == nil {
		t.Fatal("NaN debe fallar")
	}
}

func TestPayExpenseWithLoan_RechazaDescripcionVaciaSinExpenseID(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, Amount: 100, ActorDNI: "ADMIN",
	})
	if err == nil || !strings.Contains(err.Error(), "description") {
		t.Fatalf("se esperaba error de description; err=%v", err)
	}
}

func TestPayExpenseWithLoan_PropagaErrLoanNotActive(t *testing.T) {
	repo := &stubLoanRepoSvc{payExpErr: ports.ErrLoanNotActive}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, Amount: 100, Description: "x", ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrLoanNotActive) {
		t.Fatalf("err=%v, want ErrLoanNotActive", err)
	}
}

func TestPayExpenseWithLoan_PropagaPrincipalExceeded(t *testing.T) {
	repo := &stubLoanRepoSvc{payExpErr: ports.ErrPrincipalExceeded}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, Amount: 999999, Description: "x", ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrPrincipalExceeded) {
		t.Fatalf("err=%v, want ErrPrincipalExceeded", err)
	}
}

func TestPayExpenseWithLoan_PropagaExpenseNotFound(t *testing.T) {
	repo := &stubLoanRepoSvc{payExpErr: ports.ErrExpenseNotFound}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	expID := uint(999)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, ExpenseID: &expID, Amount: 100, ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrExpenseNotFound) {
		t.Fatalf("err=%v, want ErrExpenseNotFound", err)
	}
}

func TestPayExpenseWithLoan_PropagaExpenseNotPayable(t *testing.T) {
	repo := &stubLoanRepoSvc{payExpErr: ports.ErrExpenseNotPayable}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	expID := uint(55)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, ExpenseID: &expID, Amount: 100, ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrExpenseNotPayable) {
		t.Fatalf("err=%v, want ErrExpenseNotPayable", err)
	}
}

func TestPayExpenseWithLoan_RechazaDescripcionLarga(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	tooLong := strings.Repeat("A", 500)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, Amount: 100, Description: tooLong, ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ErrStringTooLong) {
		t.Fatalf("err=%v, want ErrStringTooLong", err)
	}
}

func TestPayExpenseWithLoan_RedondeaAmountA2Decimales(t *testing.T) {
	// 100.126 → 100.13 (redondeo bancario half-away-from-zero).
	repo := &stubLoanRepoSvc{}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, Amount: 100.126, Description: "LUZ", ActorDNI: "ADMIN",
	})
	if err != nil {
		t.Fatalf("round: %v", err)
	}
	if repo.payExpCapture == nil || repo.payExpCapture.Amount != 100.13 {
		t.Fatalf("amount redondeado mal: %+v", repo.payExpCapture)
	}
}

func TestPayExpenseWithLoan_RechazaExpenseIDCero(t *testing.T) {
	zero := uint(0)
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayExpenseWithLoan(context.Background(), PayExpenseInput{
		LoanID: 10, ExpenseID: &zero, Amount: 100, ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ErrInvalidExpensePayment) {
		t.Fatalf("expenseId=0: err=%v, want ErrInvalidExpensePayment", err)
	}
}

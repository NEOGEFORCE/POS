package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

// =============================================================================
// Pruebas del LoanService con un repo stub en memoria. Validan el contrato
// clave:
//
//   1. CreateLoan calcula el cronograma, PERSISTE TotalPayable y
//      RemainingBalance con preview.TotalPayable (ambas columnas), y
//      aplica defaults.
//
//   2. PayInstallment delega al repo con shape atómica (número lógico,
//      no PK), canal real y breakdown. El SERVICE no llama a
//      expenseRepo.Save: el repo crea el expense en la misma tx que la
//      cuota y el loan.
//
//   3. PayInstallment valida: canal, actor, breakdown que no suma,
//      NaN/Inf, strings demasiado largos.
//
//   4. Idempotencia: si el repo responde ErrInstallmentAlreadyPaid, el
//      servicio lo propaga sin crear nada extra.
//
//   5. RegisterLoanExpense valida inputs y propaga ErrPrincipalExceeded.
// =============================================================================

// stubLoanRepoSvc minimal; implementa ports.LoanRepository.
type stubLoanRepoSvc struct {
	loanByID        *models.Loan
	installment     *models.LoanInstallment
	payErr          error
	payCapture      *ports.PayInstallmentAtomicInput
	payLoanIDCap    uint
	expenseTotal    float64
	expenseErr      error
	expenseCapture  *models.LoanExpense
	createdLoan     *models.Loan
	createdSchedule []models.LoanInstallment
	// Pay-expense-with-loan
	payExpOutcome   *ports.PayExpenseAtomicOutcome
	payExpErr       error
	payExpCapture   *ports.PayExpenseAtomicInput
	payExpLoanIDCap uint
	// Update
	updateOutcome   *ports.UpdateLoanAtomicOutcome
	updateErr       error
	updateCapture   *ports.UpdateLoanAtomicInput
	updateLoanIDCap uint
}

func (s *stubLoanRepoSvc) CreateLoanWithSchedule(ctx context.Context, loan *models.Loan, schedule []models.LoanInstallment) error {
	loan.ID = 7
	s.createdLoan = loan
	s.createdSchedule = schedule
	return nil
}
func (s *stubLoanRepoSvc) GetByID(ctx context.Context, id uint) (*models.Loan, error) {
	if s.loanByID != nil {
		return s.loanByID, nil
	}
	return &models.Loan{ID: id, LenderName: "ACREEDOR", PrincipalAmount: 1_000_000, RemainingBalance: 1_100_000, TotalPayable: 1_100_000}, nil
}
func (s *stubLoanRepoSvc) GetByIDWithRelations(ctx context.Context, id uint) (*models.Loan, error) {
	if s.loanByID != nil {
		return s.loanByID, nil
	}
	return &models.Loan{ID: id, LenderName: "ACREEDOR"}, nil
}
func (s *stubLoanRepoSvc) ListWithStats(ctx context.Context, filter ports.LoanListFilter) ([]ports.LoanWithStatsRow, int64, error) {
	return nil, 0, nil
}
func (s *stubLoanRepoSvc) PayInstallmentAtomic(ctx context.Context, loanID uint, input ports.PayInstallmentAtomicInput) (*ports.PayInstallmentAtomicOutcome, error) {
	cp := input
	s.payCapture = &cp
	s.payLoanIDCap = loanID
	if s.payErr != nil {
		return nil, s.payErr
	}
	inst := s.installment
	if inst == nil {
		inst = &models.LoanInstallment{
			ID: 42, LoanID: loanID, Number: input.Number,
			PrincipalDue: 100, InterestDue: 10, PaidAmount: 110, Status: models.InstallmentStatusPaid,
		}
	}
	return &ports.PayInstallmentAtomicOutcome{
		Installment:      inst,
		ExpenseID:        111,
		LoanStatus:       models.LoanStatusActive,
		RemainingBalance: 500,
		AppliedAmount:    input.Amount,
	}, nil
}
func (s *stubLoanRepoSvc) RegisterLoanExpense(ctx context.Context, exp *models.LoanExpense) (float64, error) {
	s.expenseCapture = exp
	return s.expenseTotal, s.expenseErr
}
func (s *stubLoanRepoSvc) PayExpenseAtomic(ctx context.Context, loanID uint, input ports.PayExpenseAtomicInput) (*ports.PayExpenseAtomicOutcome, error) {
	cp := input
	s.payExpCapture = &cp
	s.payExpLoanIDCap = loanID
	if s.payExpErr != nil {
		return nil, s.payExpErr
	}
	if s.payExpOutcome != nil {
		return s.payExpOutcome, nil
	}
	// Outcome por defecto: egreso nuevo PAID + PRESTAMO.
	expID := uint(777)
	exp := &models.Expense{ID: expID, PaymentSource: "PRESTAMO", Status: "PAID", Amount: input.Amount, PaidAmount: input.Amount}
	le := &models.LoanExpense{ID: 88, LoanID: loanID, ExpenseID: &expID, AmountUsed: input.Amount}
	return &ports.PayExpenseAtomicOutcome{
		Expense:        exp,
		LoanExpense:    le,
		AppliedAmount:  input.Amount,
		TotalUsedAfter: input.Amount,
		Available:      1000 - input.Amount,
	}, nil
}
func (s *stubLoanRepoSvc) RecalculateStatus(ctx context.Context, loanID uint) (string, error) {
	return models.LoanStatusActive, nil
}
func (s *stubLoanRepoSvc) UpdateLoanAtomic(ctx context.Context, loanID uint, input ports.UpdateLoanAtomicInput) (*ports.UpdateLoanAtomicOutcome, error) {
	cp := input
	s.updateCapture = &cp
	s.updateLoanIDCap = loanID
	if s.updateErr != nil {
		return nil, s.updateErr
	}
	if s.updateOutcome != nil {
		return s.updateOutcome, nil
	}
	return &ports.UpdateLoanAtomicOutcome{
		Loan: &models.Loan{
			ID: loanID, LenderName: input.LenderName, LoanType: input.LoanType,
			Currency: input.Currency, RateType: input.RateType,
		},
		Recalculated: input.Recalculate,
		LoanStatus:   models.LoanStatusActive,
	}, nil
}
func (s *stubLoanRepoSvc) SoftDelete(ctx context.Context, loanID uint) error { return nil }

// stubExpenseRepo implementa ports.ExpenseRepository. El servicio NO
// debería llamar Save: todo lo persiste el repo del loan atómicamente.
// Mantenemos el stub para construir el servicio y detectar llamadas
// indeseadas.
type stubExpenseRepo struct {
	saved []*models.Expense
}

func (s *stubExpenseRepo) Save(e *models.Expense) error {
	e.ID = uint(len(s.saved) + 1)
	s.saved = append(s.saved, e)
	return nil
}
func (s *stubExpenseRepo) SaveWithTx(tx interface{}, e *models.Expense) error { return s.Save(e) }
func (s *stubExpenseRepo) GetAll() ([]models.Expense, error)                  { return nil, nil }
func (s *stubExpenseRepo) GetAllFiltered(_, _ string) ([]models.Expense, error) {
	return nil, nil
}
func (s *stubExpenseRepo) GetExpensesPaginated(_ ports.ExpenseFilter) ([]models.Expense, int64, error) {
	return nil, 0, nil
}
func (s *stubExpenseRepo) GetByID(_ uint) (*models.Expense, error) { return nil, nil }
func (s *stubExpenseRepo) GetByDateRange(_, _ time.Time) ([]models.Expense, error) {
	return nil, nil
}
func (s *stubExpenseRepo) GetByDateRangeWithTx(_ interface{}, _, _ time.Time) ([]models.Expense, error) {
	return nil, nil
}
func (s *stubExpenseRepo) GetByReferenceIDs(_ []string) ([]models.Expense, error) {
	return nil, nil
}
func (s *stubExpenseRepo) GetTotalAmountByDateRange(_, _ time.Time) (float64, error) {
	return 0, nil
}
func (s *stubExpenseRepo) GetPendingRestockExpensesBySupplier(_ uint) ([]models.Expense, error) {
	return nil, nil
}
func (s *stubExpenseRepo) Delete(_ uint) error                           { return nil }
func (s *stubExpenseRepo) Count() (int64, error)                         { return 0, nil }
func (s *stubExpenseRepo) Update(_ uint, _ *models.Expense) error        { return nil }
func (s *stubExpenseRepo) Settle(_ uint, _ string) error                 { return nil }
func (s *stubExpenseRepo) GetMonthlyTotals() (map[string]float64, error) { return nil, nil }
func (s *stubExpenseRepo) GetPendingDebtsSummary() (float64, int64, error) {
	return 0, 0, nil
}
func (s *stubExpenseRepo) GetExpensesByStatus(_ string) ([]models.Expense, error) {
	return nil, nil
}
func (s *stubExpenseRepo) GetGlobalTotalPaidExpenses() (float64, error) {
	return 0, nil
}
func (s *stubExpenseRepo) GetGlobalPaidExpensesByMethod() (map[string]float64, error) {
	return nil, nil
}
func (s *stubExpenseRepo) GetPaidAmountByRange(_, _ time.Time) (float64, error) {
	return 0, nil
}
func (s *stubExpenseRepo) GetGlobalPaidExpensesByMethodInRange(_, _ time.Time) (map[string]float64, error) {
	return nil, nil
}

// --- tests ------------------------------------------------------------------

// Cuota que, en el repo, requiere pago de exactamente 110 (principal
// 100 + interés 10, 0 pagado). Usada en varios tests.
func cuotaPendientePorFull() *models.LoanInstallment {
	return &models.LoanInstallment{
		ID: 1, LoanID: 10, Number: 2,
		PrincipalDue: 100, InterestDue: 10, PaidAmount: 0,
		Status: models.InstallmentStatusPending,
	}
}

func TestLoanService_PayInstallment_PasaCanalRealYAplicaBreakdown(t *testing.T) {
	repo := &stubLoanRepoSvc{
		installment: cuotaPendientePorFull(),
		loanByID:    &models.Loan{ID: 10, LenderName: "ACREEDOR", PrincipalAmount: 1000, RemainingBalance: 220, TotalPayable: 220},
	}
	exps := &stubExpenseRepo{}
	svc := NewLoanService(repo, exps, nil)

	out, err := svc.PayInstallment(context.Background(), PayInstallmentServiceInput{
		LoanID:        10,
		Number:        2,
		Amount:        110,
		PaymentSource: "EFECTIVO",
		ActorDNI:      "ADMIN-1",
	})
	if err != nil {
		t.Fatalf("PayInstallment: %v", err)
	}
	if repo.payCapture == nil {
		t.Fatal("el repo no recibió el pago")
	}
	// Canal real, NUNCA PRESTAMO.
	if strings.ToUpper(repo.payCapture.PaymentSource) == "PRESTAMO" {
		t.Errorf("PaymentSource NO debe ser PRESTAMO; got %q", repo.payCapture.PaymentSource)
	}
	// Sin desglose explícito → todo a EFECTIVO.
	if repo.payCapture.CashAmount != 110 {
		t.Errorf("CashAmount esperado 110 (todo EFECTIVO); got %v", repo.payCapture.CashAmount)
	}
	if repo.payCapture.NequiAmount != 0 || repo.payCapture.DaviplataAmount != 0 || repo.payCapture.FondoAmount != 0 || repo.payCapture.CoinsAmount != 0 {
		t.Errorf("desglose debió quedar en 0 fuera de cash; got %+v", repo.payCapture)
	}
	// El servicio NO debe haber llamado al expenseRepo.Save: todo va atómico.
	if len(exps.saved) != 0 {
		t.Errorf("servicio llamó a expenseRepo.Save por fuera de la tx atómica (saved=%d)", len(exps.saved))
	}
	if out == nil || out.AppliedAmount != 110 {
		t.Errorf("outcome inesperado: %+v", out)
	}
	if repo.payLoanIDCap != 10 {
		t.Errorf("loanID propagado = %d, want 10", repo.payLoanIDCap)
	}
	if repo.payCapture.Number != 2 {
		t.Errorf("number propagado = %d, want 2", repo.payCapture.Number)
	}
}

func TestLoanService_PayInstallment_RechazaCanalInvalido(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayInstallment(context.Background(), PayInstallmentServiceInput{
		LoanID: 10, Number: 1, Amount: 50,
		PaymentSource: "PRESTAMO", // explícitamente prohibido
		ActorDNI:      "ADMIN-1",
	})
	if !errors.Is(err, ErrInvalidChannel) {
		t.Fatalf("err=%v, want ErrInvalidChannel", err)
	}
}

func TestLoanService_PayInstallment_RechazaMontoCero(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayInstallment(context.Background(), PayInstallmentServiceInput{
		LoanID: 10, Number: 1, Amount: 0,
		PaymentSource: "EFECTIVO", ActorDNI: "ADMIN",
	})
	if err == nil || !strings.Contains(err.Error(), "mayor a cero") {
		t.Fatalf("se esperaba error de monto <= 0, got %v", err)
	}
}

func TestLoanService_PayInstallment_RechazaActorVacio(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayInstallment(context.Background(), PayInstallmentServiceInput{
		LoanID: 10, Number: 1, Amount: 10, PaymentSource: "EFECTIVO",
	})
	if !errors.Is(err, ErrActorRequired) {
		t.Fatalf("err=%v, want ErrActorRequired", err)
	}
}

func TestLoanService_PayInstallment_RechazaNumberCero(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayInstallment(context.Background(), PayInstallmentServiceInput{
		LoanID: 10, Number: 0, Amount: 10, PaymentSource: "EFECTIVO", ActorDNI: "ADMIN",
	})
	if err == nil || !strings.Contains(err.Error(), "cuota") {
		t.Fatalf("se esperaba error de number inválido, got %v", err)
	}
}

func TestLoanService_PayInstallment_RechazaBreakdownQueNoSuma(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayInstallment(context.Background(), PayInstallmentServiceInput{
		LoanID: 10, Number: 1, Amount: 100, PaymentSource: "EFECTIVO", ActorDNI: "ADMIN",
		CashAmount:  60,
		NequiAmount: 30, // suma 90 vs amount 100
	})
	if !errors.Is(err, ErrBreakdownMismatch) {
		t.Fatalf("err=%v, want ErrBreakdownMismatch", err)
	}
}

func TestLoanService_PayInstallment_AceptaBreakdownQueSuma(t *testing.T) {
	repo := &stubLoanRepoSvc{installment: cuotaPendientePorFull()}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	_, err := svc.PayInstallment(context.Background(), PayInstallmentServiceInput{
		LoanID: 10, Number: 2, Amount: 110, PaymentSource: "NEQUI", ActorDNI: "ADMIN",
		CashAmount: 10, NequiAmount: 100,
	})
	if err != nil {
		t.Fatalf("breakdown suma: %v", err)
	}
	if repo.payCapture.CashAmount != 10 || repo.payCapture.NequiAmount != 100 {
		t.Errorf("breakdown no se propagó: cash=%v nequi=%v", repo.payCapture.CashAmount, repo.payCapture.NequiAmount)
	}
}

func TestLoanService_PayInstallment_RechazaNaNInf(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.PayInstallment(context.Background(), PayInstallmentServiceInput{
		LoanID: 10, Number: 1, Amount: nanFloat(),
		PaymentSource: "EFECTIVO", ActorDNI: "ADMIN",
	})
	if err == nil {
		t.Fatal("se esperaba error con NaN")
	}
}

func TestLoanService_PayInstallment_Idempotente(t *testing.T) {
	// El repo retorna el sentinel: ya pagada. El servicio debe propagarlo
	// sin crear expense por ningún lado.
	repo := &stubLoanRepoSvc{payErr: ports.ErrInstallmentAlreadyPaid}
	exps := &stubExpenseRepo{}
	svc := NewLoanService(repo, exps, nil)

	_, err := svc.PayInstallment(context.Background(), PayInstallmentServiceInput{
		LoanID: 10, Number: 1, Amount: 100,
		PaymentSource: "EFECTIVO", ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrInstallmentAlreadyPaid) {
		t.Fatalf("err=%v, want ErrInstallmentAlreadyPaid", err)
	}
	if len(exps.saved) != 0 {
		t.Errorf("segundo intento NO debe crear expense; saved=%d", len(exps.saved))
	}
}

func TestLoanService_CreateLoan_PersisteTotalPayableYRemainingBalance(t *testing.T) {
	repo := &stubLoanRepoSvc{}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	loan, err := svc.CreateLoan(context.Background(), CreateLoanInput{
		LenderName:       "ACREEDOR X",
		PrincipalAmount:  1_000_000,
		InterestRatePct:  10,
		InterestMode:     models.InterestModeSimple,
		TermCount:        5,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		CreatedByDNI:     "ADMIN-1",
	})
	if err != nil {
		t.Fatalf("CreateLoan: %v", err)
	}
	if loan == nil || loan.ID == 0 {
		t.Fatalf("loan.ID debe quedar poblado, got %+v", loan)
	}
	if repo.createdLoan == nil {
		t.Fatalf("repo no recibió loan")
	}
	// total = 1_000_000 * (1 + 10/100) = 1_100_000.
	if repo.createdLoan.TotalPayable != 1_100_000 {
		t.Errorf("TotalPayable = %v, want 1_100_000", repo.createdLoan.TotalPayable)
	}
	if repo.createdLoan.RemainingBalance != 1_100_000 {
		t.Errorf("RemainingBalance al crear = %v, want 1_100_000 (igual al total)", repo.createdLoan.RemainingBalance)
	}
	if len(repo.createdSchedule) != 5 {
		t.Fatalf("se esperaba cronograma de 5 cuotas, got %d", len(repo.createdSchedule))
	}
}

func TestLoanService_CreateLoan_RechazaLenderVacio(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	_, err := svc.CreateLoan(context.Background(), CreateLoanInput{
		LenderName:      "   ",
		PrincipalAmount: 1000,
		TermCount:       1,
		CreatedByDNI:    "ADMIN",
		InterestMode:    models.InterestModeNone,
	})
	if !errors.Is(err, ErrLenderRequired) {
		t.Fatalf("err=%v, want ErrLenderRequired", err)
	}
}

func TestLoanService_CreateLoan_RechazaStringsExcedidos(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	tooLong := strings.Repeat("A", 500)
	_, err := svc.CreateLoan(context.Background(), CreateLoanInput{
		LenderName:      tooLong,
		PrincipalAmount: 1000,
		TermCount:       1,
		CreatedByDNI:    "ADMIN",
		InterestMode:    models.InterestModeNone,
	})
	if !errors.Is(err, ErrStringTooLong) {
		t.Fatalf("err=%v, want ErrStringTooLong", err)
	}
}

func TestLoanService_RegisterLoanExpense_ValidaInputs(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{expenseTotal: 500}, &stubExpenseRepo{}, nil)
	// 1) actor vacío
	if _, _, err := svc.RegisterLoanExpense(context.Background(), RegisterLoanExpenseInput{LoanID: 10, AmountUsed: 100}); !errors.Is(err, ErrActorRequired) {
		t.Errorf("sin actor: err=%v, want ErrActorRequired", err)
	}
	// 2) amount <= 0
	if _, _, err := svc.RegisterLoanExpense(context.Background(), RegisterLoanExpenseInput{LoanID: 10, AmountUsed: 0, ActorDNI: "A"}); err == nil {
		t.Errorf("amount=0 debe fallar")
	}
	// 3) loanID 0
	if _, _, err := svc.RegisterLoanExpense(context.Background(), RegisterLoanExpenseInput{LoanID: 0, AmountUsed: 100, ActorDNI: "A"}); err == nil {
		t.Errorf("loanID=0 debe fallar")
	}
	// 4) NaN
	if _, _, err := svc.RegisterLoanExpense(context.Background(), RegisterLoanExpenseInput{LoanID: 10, AmountUsed: nanFloat(), ActorDNI: "A"}); err == nil {
		t.Errorf("NaN debe fallar")
	}
	// 5) happy path
	exp, total, err := svc.RegisterLoanExpense(context.Background(), RegisterLoanExpenseInput{
		LoanID: 10, AmountUsed: 123.45, Purpose: "test", ActorDNI: "ADMIN",
	})
	if err != nil {
		t.Fatalf("happy path: %v", err)
	}
	if exp == nil || total != 500 {
		t.Fatalf("exp=%+v total=%v", exp, total)
	}
}

func TestLoanService_RegisterLoanExpense_PropagaOverspend(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{expenseErr: ports.ErrPrincipalExceeded}, &stubExpenseRepo{}, nil)
	_, _, err := svc.RegisterLoanExpense(context.Background(), RegisterLoanExpenseInput{
		LoanID: 10, AmountUsed: 10, ActorDNI: "ADMIN",
	})
	if !errors.Is(err, ports.ErrPrincipalExceeded) {
		t.Fatalf("err=%v, want ErrPrincipalExceeded", err)
	}
}

// nanFloat devuelve un NaN sin importar math.
func nanFloat() float64 {
	zero := 0.0
	return zero / zero
}

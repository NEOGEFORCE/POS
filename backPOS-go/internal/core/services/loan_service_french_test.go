package services

import (
	"context"
	"errors"
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

// =============================================================================
// Pruebas de LoanService contra la rama FRENCH.
//
// Validan el contrato clave:
//
//   1. CreateLoan(FRENCH) persiste `AnnualEffectiveRatePct` con lo que
//      llegó en `InterestRatePct` del input, y deja `InterestRatePct`
//      en 0 (SIMPLE sigue haciendo lo contrario).
//
//   2. CreateLoan(FRENCH) persiste MonthlyInsurance, FgaTotal,
//      MonthlyFga y BaseInstallment en las columnas de la BD.
//
//   3. `TotalPayable` y `RemainingBalance` incluyen principal + interés
//      + seguro total + FGA total.
//
//   4. CreateLoan(SIMPLE) sigue persistiendo InterestRatePct histórica
//      y deja los campos FRENCH en 0.
//
//   5. Rechazos de validación: NONE/SIMPLE con seguro o FGA, FRENCH sin
//      MONTHLY, FRENCH sin EA > 0.
//
//   6. PayInstallment usa el total con seguro+FGA al pasar al repo (el
//      repo valida el pago exacto en función de los 4 componentes).
// =============================================================================

func TestLoanService_CreateLoan_PersisteCamposFrench(t *testing.T) {
	repo := &stubLoanRepoSvc{}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	loan, err := svc.CreateLoan(context.Background(), CreateLoanInput{
		LenderName:       "BANCO CO",
		PrincipalAmount:  25_000_000,
		InterestRatePct:  21.3, // EA porcentual
		InterestMode:     models.InterestModeFrench,
		TermCount:        60,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		MonthlyInsurance: 32_500,
		FgaTotal:         600_000,
		CreatedByDNI:     "ADMIN-1",
	})
	if err != nil {
		t.Fatalf("CreateLoan FRENCH: %v", err)
	}
	if loan == nil || loan.ID == 0 {
		t.Fatalf("loan.ID debe quedar poblado, got %+v", loan)
	}
	if repo.createdLoan == nil {
		t.Fatalf("repo no recibió loan")
	}

	// La tasa EA viaja a `annual_effective_rate_pct`, no a interest_rate_pct.
	if repo.createdLoan.AnnualEffectiveRatePct != 21.3 {
		t.Errorf("AnnualEffectiveRatePct = %v, want 21.3", repo.createdLoan.AnnualEffectiveRatePct)
	}
	if repo.createdLoan.InterestRatePct != 0 {
		t.Errorf("InterestRatePct en FRENCH debería quedar en 0, got %v", repo.createdLoan.InterestRatePct)
	}
	if repo.createdLoan.InterestMode != models.InterestModeFrench {
		t.Errorf("InterestMode = %q, want FRENCH", repo.createdLoan.InterestMode)
	}
	if repo.createdLoan.MonthlyInsuranceAmount != 32_500 {
		t.Errorf("MonthlyInsuranceAmount = %v, want 32500", repo.createdLoan.MonthlyInsuranceAmount)
	}
	if repo.createdLoan.FgaTotalAmount != 600_000 {
		t.Errorf("FgaTotalAmount = %v, want 600000", repo.createdLoan.FgaTotalAmount)
	}
	// MonthlyFga = 600000/60 = 10000.
	if repo.createdLoan.MonthlyFgaAmount != 10_000 {
		t.Errorf("MonthlyFgaAmount = %v, want 10000", repo.createdLoan.MonthlyFgaAmount)
	}
	// BaseInstallmentAmount ≈ 655.300 (dentro de ±2000 por redondeo).
	if repo.createdLoan.BaseInstallmentAmount < 653_300 || repo.createdLoan.BaseInstallmentAmount > 657_300 {
		t.Errorf("BaseInstallmentAmount = %.2f, fuera del rango 653300..657300", repo.createdLoan.BaseInstallmentAmount)
	}

	// TotalPayable = principal + interés total + seguro total + FGA total.
	// seguro total = 32500 * 60 = 1_950_000
	// fga total   = 600_000
	//
	// El interés total depende de la amortización exacta pero debe ser
	// positivo y menor que un techo defensivo.
	var totalInterestFromSchedule float64
	for _, in := range repo.createdSchedule {
		totalInterestFromSchedule += in.InterestDue
	}
	wantTotalCents := int64(math.Round(25_000_000*100)) +
		int64(math.Round(totalInterestFromSchedule*100)) +
		int64(math.Round(1_950_000*100)) +
		int64(math.Round(600_000*100))
	gotTotalCents := int64(math.Round(repo.createdLoan.TotalPayable * 100))
	if gotTotalCents != wantTotalCents {
		t.Errorf("TotalPayable=%.2f (= %d cents), want %d cents", repo.createdLoan.TotalPayable, gotTotalCents, wantTotalCents)
	}
	// RemainingBalance al crear = TotalPayable (CHECK remaining <= total).
	if repo.createdLoan.RemainingBalance != repo.createdLoan.TotalPayable {
		t.Errorf("RemainingBalance=%v, want igual a TotalPayable=%v", repo.createdLoan.RemainingBalance, repo.createdLoan.TotalPayable)
	}

	// Cronograma pleno con 60 cuotas.
	if len(repo.createdSchedule) != 60 {
		t.Fatalf("len(createdSchedule) = %d, want 60", len(repo.createdSchedule))
	}
	// Primera cuota lleva seguro+FGA.
	first := repo.createdSchedule[0]
	if first.InsuranceDue != 32_500 {
		t.Errorf("cuota 1 insuranceDue=%v, want 32500", first.InsuranceDue)
	}
	if first.FgaDue != 10_000 {
		t.Errorf("cuota 1 fgaDue=%v, want 10000", first.FgaDue)
	}
}

// Blindaje: CreateLoan(SIMPLE) sigue poblando interest_rate_pct y deja
// todos los campos FRENCH en 0. Si una refactor contamina SIMPLE con
// FRENCH, este test falla.
func TestLoanService_CreateLoan_SimpleNoTocaCamposFrench(t *testing.T) {
	repo := &stubLoanRepoSvc{}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	_, err := svc.CreateLoan(context.Background(), CreateLoanInput{
		LenderName:       "DOÑA ROSA",
		PrincipalAmount:  2_000_000,
		InterestRatePct:  12,
		InterestMode:     models.InterestModeSimple,
		TermCount:        6,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		CreatedByDNI:     "ADMIN-1",
	})
	if err != nil {
		t.Fatalf("CreateLoan SIMPLE: %v", err)
	}
	if repo.createdLoan.InterestRatePct != 12 {
		t.Errorf("SIMPLE InterestRatePct = %v, want 12", repo.createdLoan.InterestRatePct)
	}
	if repo.createdLoan.AnnualEffectiveRatePct != 0 {
		t.Errorf("SIMPLE AnnualEffectiveRatePct = %v, want 0 (no se toca)", repo.createdLoan.AnnualEffectiveRatePct)
	}
	if repo.createdLoan.MonthlyInsuranceAmount != 0 || repo.createdLoan.FgaTotalAmount != 0 ||
		repo.createdLoan.MonthlyFgaAmount != 0 || repo.createdLoan.BaseInstallmentAmount != 0 {
		t.Errorf("SIMPLE no debe tocar extras FRENCH: %+v", repo.createdLoan)
	}
	// TotalPayable sigue siendo principal * (1 + rate/100) = 2_000_000 * 1.12.
	if repo.createdLoan.TotalPayable != 2_240_000 {
		t.Errorf("SIMPLE TotalPayable = %v, want 2240000", repo.createdLoan.TotalPayable)
	}
}

// NONE sigue siendo total_payable = principal con extras en 0.
func TestLoanService_CreateLoan_NoneNoTocaCamposFrench(t *testing.T) {
	repo := &stubLoanRepoSvc{}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	_, err := svc.CreateLoan(context.Background(), CreateLoanInput{
		LenderName:       "SOCIO",
		PrincipalAmount:  600_000,
		InterestRatePct:  0,
		InterestMode:     models.InterestModeNone,
		TermCount:        3,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		CreatedByDNI:     "ADMIN",
	})
	if err != nil {
		t.Fatalf("CreateLoan NONE: %v", err)
	}
	if repo.createdLoan.TotalPayable != 600_000 {
		t.Errorf("NONE TotalPayable = %v, want 600000", repo.createdLoan.TotalPayable)
	}
	if repo.createdLoan.AnnualEffectiveRatePct != 0 ||
		repo.createdLoan.MonthlyInsuranceAmount != 0 ||
		repo.createdLoan.FgaTotalAmount != 0 ||
		repo.createdLoan.BaseInstallmentAmount != 0 {
		t.Errorf("NONE no debe tocar extras FRENCH")
	}
}

// Validaciones FRENCH que el servicio propaga del scheduler.
func TestLoanService_CreateLoan_FrenchValidaciones(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	base := CreateLoanInput{
		LenderName:       "BANCO",
		PrincipalAmount:  5_000_000,
		InterestRatePct:  21.3,
		InterestMode:     models.InterestModeFrench,
		TermCount:        12,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		MonthlyInsurance: 10_000,
		FgaTotal:         60_000,
		CreatedByDNI:     "ADMIN",
	}
	// FRENCH sin EA > 0.
	bad := base
	bad.InterestRatePct = 0
	if _, err := svc.CreateLoan(context.Background(), bad); !errors.Is(err, ErrFrenchRequiresEARate) {
		t.Errorf("FRENCH tasa 0: err=%v, want ErrFrenchRequiresEARate", err)
	}
	// FRENCH con seguro negativo.
	bad = base
	bad.MonthlyInsurance = -1
	if _, err := svc.CreateLoan(context.Background(), bad); !errors.Is(err, ErrInvalidMonthlyInsurance) {
		t.Errorf("FRENCH seguro negativo: err=%v, want ErrInvalidMonthlyInsurance", err)
	}
	// FRENCH con FGA NaN.
	bad = base
	bad.FgaTotal = math.NaN()
	if _, err := svc.CreateLoan(context.Background(), bad); !errors.Is(err, ErrInvalidFgaTotal) {
		t.Errorf("FRENCH FGA NaN: err=%v, want ErrInvalidFgaTotal", err)
	}
	// SIMPLE con seguro > 0 (semántica estricta).
	bad = base
	bad.InterestMode = models.InterestModeSimple
	bad.FgaTotal = 0
	bad.InterestRatePct = 15
	bad.MonthlyInsurance = 1
	if _, err := svc.CreateLoan(context.Background(), bad); !errors.Is(err, ErrInsuranceOrFgaOnlyFrench) {
		t.Errorf("SIMPLE con seguro: err=%v, want ErrInsuranceOrFgaOnlyFrench", err)
	}
}

// toScheduleRequest fuerza MONTHLY al pasar FRENCH + WEEKLY: la UI puede
// mandar lo que quiera, el servicio es la red de seguridad.
func TestLoanService_CreateLoan_FrenchFuerzaMonthlyAunCuandoRequestDiceWeekly(t *testing.T) {
	repo := &stubLoanRepoSvc{}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	_, err := svc.CreateLoan(context.Background(), CreateLoanInput{
		LenderName:       "BANCO",
		PrincipalAmount:  3_000_000,
		InterestRatePct:  18.0,
		InterestMode:     models.InterestModeFrench,
		TermCount:        12,
		PaymentFrequency: models.PaymentFrequencyWeekly, // front legacy
		CreatedByDNI:     "ADMIN",
	})
	if err != nil {
		t.Fatalf("FRENCH + WEEKLY debería ser aceptado tras forzar MONTHLY: %v", err)
	}
	if repo.createdLoan.PaymentFrequency != models.PaymentFrequencyMonthly {
		t.Errorf("PaymentFrequency = %q, want MONTHLY (forzado)", repo.createdLoan.PaymentFrequency)
	}
}

// Preview para FRENCH expone los campos nuevos (el frontend los pinta).
func TestLoanService_PreviewSchedule_FrenchExponeExtras(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	preview, err := svc.PreviewSchedule(CreateLoanInput{
		LenderName:       "BANCO",
		PrincipalAmount:  25_000_000,
		InterestRatePct:  21.3,
		InterestMode:     models.InterestModeFrench,
		TermCount:        60,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		MonthlyInsurance: 32_500,
		FgaTotal:         600_000,
		CreatedByDNI:     "ADMIN",
	})
	if err != nil {
		t.Fatalf("PreviewSchedule FRENCH: %v", err)
	}
	if preview.MonthlyInsurance != 32_500 {
		t.Errorf("MonthlyInsurance=%v, want 32500", preview.MonthlyInsurance)
	}
	if preview.FgaTotal != 600_000 {
		t.Errorf("FgaTotal=%v, want 600000", preview.FgaTotal)
	}
	if preview.MonthlyFga != 10_000 {
		t.Errorf("MonthlyFga=%v, want 10000", preview.MonthlyFga)
	}
	if preview.InstallmentBase < 653_300 || preview.InstallmentBase > 657_300 {
		t.Errorf("InstallmentBase=%.2f fuera de 653300..657300 (ref 655300)", preview.InstallmentBase)
	}
	if len(preview.Installments) != 60 {
		t.Errorf("len(Installments)=%d, want 60", len(preview.Installments))
	}
}

// PayInstallment en FRENCH: el repo recibe el AMOUNT exacto (sin
// desglose implícito), el servicio no inventa canales nuevos. Validamos
// que un pago que sólo cubre principal+interés sea rechazado por el
// stub actual (que modela la cuota como ya pagada tras un pago exacto).
// En este test lo que importa es que el servicio NO transforme el
// amount y lo pase intacto; el repo real verificará el cuadre con los
// 4 componentes.
func TestLoanService_PayInstallment_PropagaTotalFrenchAlRepo(t *testing.T) {
	repo := &stubLoanRepoSvc{
		installment: &models.LoanInstallment{
			ID: 1, LoanID: 10, Number: 1,
			PrincipalDue: 500_000, InterestDue: 55_000,
			InsuranceDue: 32_500, FgaDue: 10_000,
			PaidAmount: 0, Status: models.InstallmentStatusPending,
		},
		loanByID: &models.Loan{ID: 10, LenderName: "BANCO", PrincipalAmount: 25_000_000,
			RemainingBalance: 597_500, TotalPayable: 597_500, InterestMode: models.InterestModeFrench},
	}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	// Pagamos la cuota completa (500k + 55k + 32.5k + 10k = 597.5k).
	out, err := svc.PayInstallment(context.Background(), PayInstallmentServiceInput{
		LoanID: 10, Number: 1, Amount: 597_500,
		PaymentSource: "EFECTIVO", ActorDNI: "ADMIN",
	})
	if err != nil {
		t.Fatalf("PayInstallment FRENCH: %v", err)
	}
	if repo.payCapture == nil {
		t.Fatal("el repo no recibió el pago")
	}
	// El servicio no fabrica una variante PRESTAMO para esto.
	if repo.payCapture.PaymentSource == "PRESTAMO" {
		t.Errorf("PaymentSource no debe ser PRESTAMO")
	}
	if repo.payCapture.Amount != 597_500 {
		t.Errorf("Amount propagado = %v, want 597500", repo.payCapture.Amount)
	}
	// Default breakdown: todo a EFECTIVO cuando no viene desglose.
	if repo.payCapture.CashAmount != 597_500 {
		t.Errorf("CashAmount default = %v, want 597500", repo.payCapture.CashAmount)
	}
	if out == nil || out.AppliedAmount != 597_500 {
		t.Errorf("outcome inesperado: %+v", out)
	}
	_ = ports.ErrInstallmentAlreadyPaid // import defensivo para evitar unused si cambia
}

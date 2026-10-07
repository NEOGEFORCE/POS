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
// Pruebas de LoanService.UpdateLoan (PUT /api/loans/:id).
//
// Contrato validado:
//
//  1. Metadata-only: el servicio propaga la metadata al repo sin tocar los
//     campos financieros; Recalculate=false.
//
//  2. Caso bancario real: credit_number, loan_type=CONSUMO, holder,
//     currency, rate_type, auto_debit, maturity, late rate, net
//     disbursement, FGA IVA/GMF, snapshot (balance+as_of+paid) y cuota
//     oficial (monto+fecha) viajan tal cual al repo.
//
//  3. Recalculate=true construye el cronograma con BuildLoanSchedule y pasa
//     el NewSchedule + campos financieros al repo.
//
//  4. Rechazos de validación: enums inválidos, snapshot a medias, cuota
//     oficial a medias, maturity < start, montos no finitos, campos
//     financieros sin recalculate.
//
//  5. Propagación de sentinels del repo: ErrLoanNotFound,
//     ErrLoanHasPaidInstallments, ErrLoanPrincipalBelowUsage.
// =============================================================================

func strPtr(s string) *string     { return &s }
func f64Ptr(v float64) *float64   { return &v }
func tPtr(t time.Time) *time.Time { return &t }

func baseUpdateInput() UpdateLoanInput {
	return UpdateLoanInput{
		LoanID:              10,
		LenderName:          "BANCO DE BOGOTA",
		DisbursementChannel: "BANCO",
		LoanType:            "CONSUMO",
		Currency:            "COP",
		RateType:            "FIJO",
		ActorDNI:            "ADMIN-1",
	}
}

func TestUpdateLoan_MetadataOnly_PropagaAlRepo(t *testing.T) {
	repo := &stubLoanRepoSvc{}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)

	in := baseUpdateInput()
	in.CreditNumber = strPtr("0013-0021-96-00322102")
	in.HolderName = strPtr("FABIAN ERNESTO SARMIENTO")
	in.AutoDebit = true
	in.LateAnnualEffectiveRatePct = 0
	in.NetDisbursementAmount = f64Ptr(25_000_000)
	in.FgaIvaAmount = 47_500
	in.FgaGmfAmount = 1_190
	in.BankBalanceAmount = f64Ptr(25_326_046.44)
	in.BankBalanceAsOf = tPtr(time.Date(2026, 10, 7, 12, 0, 0, 0, LoanBogotaLocation()))
	in.BankPaidAmount = f64Ptr(0)
	in.OfficialNextInstallmentAmount = f64Ptr(693_951.69)
	in.OfficialNextInstallmentDate = tPtr(time.Date(2026, 11, 5, 0, 0, 0, 0, LoanBogotaLocation()))
	in.MaturityDate = tPtr(time.Date(2031, 10, 5, 0, 0, 0, 0, LoanBogotaLocation()))

	_, err := svc.UpdateLoan(context.Background(), in)
	if err != nil {
		t.Fatalf("UpdateLoan metadata-only: %v", err)
	}
	cap := repo.updateCapture
	if cap == nil {
		t.Fatal("el repo no recibió el update")
	}
	if repo.updateLoanIDCap != 10 {
		t.Errorf("loanID propagado = %d, want 10", repo.updateLoanIDCap)
	}
	if cap.Recalculate {
		t.Error("metadata-only no debe marcar Recalculate")
	}
	if cap.CreditNumber == nil || *cap.CreditNumber != "0013-0021-96-00322102" {
		t.Errorf("creditNumber mal propagado: %+v", cap.CreditNumber)
	}
	if cap.LoanType != "CONSUMO" {
		t.Errorf("loanType = %q, want CONSUMO", cap.LoanType)
	}
	if cap.HolderName == nil || *cap.HolderName != "FABIAN ERNESTO SARMIENTO" {
		t.Errorf("holderName mal propagado: %+v", cap.HolderName)
	}
	if !cap.AutoDebit {
		t.Error("autoDebit debe propagarse true")
	}
	if cap.BankBalanceAmount == nil || *cap.BankBalanceAmount != 25_326_046.44 {
		t.Errorf("bankBalanceAmount mal: %+v", cap.BankBalanceAmount)
	}
	if cap.BankBalanceAsOf == nil {
		t.Error("bankBalanceAsOf debe propagarse")
	}
	if cap.OfficialNextInstallmentAmount == nil || *cap.OfficialNextInstallmentAmount != 693_951.69 {
		t.Errorf("officialNextInstallmentAmount mal: %+v", cap.OfficialNextInstallmentAmount)
	}
	if cap.FgaIvaAmount != 47_500 || cap.FgaGmfAmount != 1_190 {
		t.Errorf("desglose FGA mal: iva=%v gmf=%v", cap.FgaIvaAmount, cap.FgaGmfAmount)
	}
	// Metadata-only NO debe fabricar cronograma.
	if len(cap.NewSchedule) != 0 {
		t.Errorf("metadata-only no debe construir cronograma, got %d cuotas", len(cap.NewSchedule))
	}
}

func TestUpdateLoan_Recalculate_FrenchConstruyeCronograma(t *testing.T) {
	repo := &stubLoanRepoSvc{}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)

	in := baseUpdateInput()
	in.Recalculate = true
	in.HasScheduleFields = true
	in.PrincipalAmount = 25_000_000
	in.InterestRatePct = 21.3 // EA
	in.InterestMode = models.InterestModeFrench
	in.TermCount = 60
	in.PaymentFrequency = models.PaymentFrequencyMonthly
	in.FirstPaymentDate = time.Date(2026, 11, 5, 0, 0, 0, 0, LoanBogotaLocation())
	in.MonthlyInsurance = 30_040.78

	_, err := svc.UpdateLoan(context.Background(), in)
	if err != nil {
		t.Fatalf("UpdateLoan recalculate FRENCH: %v", err)
	}
	cap := repo.updateCapture
	if cap == nil {
		t.Fatal("el repo no recibió el update")
	}
	if !cap.Recalculate {
		t.Error("Recalculate debe quedar en true")
	}
	if len(cap.NewSchedule) != 60 {
		t.Fatalf("cronograma recalculado = %d cuotas, want 60", len(cap.NewSchedule))
	}
	// FRENCH: EA viaja a NewAnnualEffectiveRatePct, no a NewInterestRatePct.
	if cap.NewAnnualEffectiveRatePct != 21.3 {
		t.Errorf("NewAnnualEffectiveRatePct = %v, want 21.3", cap.NewAnnualEffectiveRatePct)
	}
	if cap.NewInterestRatePct != 0 {
		t.Errorf("NewInterestRatePct debe quedar 0 en FRENCH, got %v", cap.NewInterestRatePct)
	}
	if cap.NewPrincipalAmount != 25_000_000 {
		t.Errorf("NewPrincipalAmount = %v, want 25000000", cap.NewPrincipalAmount)
	}
	if cap.NewTermCount != 60 {
		t.Errorf("NewTermCount = %v, want 60", cap.NewTermCount)
	}
	// La primera cuota debe traer seguro mensual.
	if cap.NewSchedule[0].InsuranceDue != 30_040.78 {
		t.Errorf("cuota 1 insuranceDue = %v, want 30040.78", cap.NewSchedule[0].InsuranceDue)
	}
	// remaining = total (no había pagos).
	if cap.NewTotalPayable <= 0 {
		t.Errorf("NewTotalPayable debe ser > 0, got %v", cap.NewTotalPayable)
	}
}

func TestUpdateLoan_Recalculate_SimpleNoTocaCamposFrench(t *testing.T) {
	repo := &stubLoanRepoSvc{}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)

	in := baseUpdateInput()
	in.Recalculate = true
	in.HasScheduleFields = true
	in.PrincipalAmount = 2_000_000
	in.InterestRatePct = 12
	in.InterestMode = models.InterestModeSimple
	in.TermCount = 6
	in.PaymentFrequency = models.PaymentFrequencyMonthly
	in.FirstPaymentDate = time.Date(2026, 11, 5, 0, 0, 0, 0, LoanBogotaLocation())

	_, err := svc.UpdateLoan(context.Background(), in)
	if err != nil {
		t.Fatalf("UpdateLoan recalculate SIMPLE: %v", err)
	}
	cap := repo.updateCapture
	if cap.NewInterestRatePct != 12 {
		t.Errorf("SIMPLE NewInterestRatePct = %v, want 12", cap.NewInterestRatePct)
	}
	if cap.NewAnnualEffectiveRatePct != 0 || cap.NewMonthlyInsurance != 0 || cap.NewFgaTotal != 0 || cap.NewBaseInstallment != 0 {
		t.Errorf("SIMPLE no debe tocar campos FRENCH: %+v", cap)
	}
	// total = 2_000_000 * 1.12 = 2_240_000.
	if cap.NewTotalPayable != 2_240_000 {
		t.Errorf("SIMPLE NewTotalPayable = %v, want 2240000", cap.NewTotalPayable)
	}
}

func TestUpdateLoan_RechazaCamposFinancierosSinRecalculate(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.Recalculate = false
	in.HasScheduleFields = true // llegaron campos financieros
	in.PrincipalAmount = 9_999_999
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ErrScheduleFieldsRequireRecalc) {
		t.Fatalf("err=%v, want ErrScheduleFieldsRequireRecalc", err)
	}
}

func TestUpdateLoan_RechazaLoanTypeInvalido(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.LoanType = "HIPOTECA" // no está en el enum (sería HIPOTECARIO)
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ErrInvalidLoanType) {
		t.Fatalf("err=%v, want ErrInvalidLoanType", err)
	}
}

func TestUpdateLoan_RechazaRateTypeInvalido(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.RateType = "MIXTA"
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ErrInvalidRateType) {
		t.Fatalf("err=%v, want ErrInvalidRateType", err)
	}
}

func TestUpdateLoan_RechazaCurrencyInvalida(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.Currency = "EUR"
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ErrInvalidCurrency) {
		t.Fatalf("err=%v, want ErrInvalidCurrency", err)
	}
}

func TestUpdateLoan_RechazaSnapshotAMedias(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	// Saldo sin fecha de consulta.
	in := baseUpdateInput()
	in.BankBalanceAmount = f64Ptr(100)
	in.BankBalanceAsOf = nil
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ErrInvalidBankSnapshot) {
		t.Fatalf("saldo sin fecha: err=%v, want ErrInvalidBankSnapshot", err)
	}
	// bank_paid sin snapshot.
	in2 := baseUpdateInput()
	in2.BankPaidAmount = f64Ptr(50)
	_, err = svc.UpdateLoan(context.Background(), in2)
	if !errors.Is(err, ErrInvalidBankSnapshot) {
		t.Fatalf("paid sin snapshot: err=%v, want ErrInvalidBankSnapshot", err)
	}
}

func TestUpdateLoan_RechazaCuotaOficialAMedias(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.OfficialNextInstallmentAmount = f64Ptr(500_000)
	in.OfficialNextInstallmentDate = nil
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ErrInvalidOfficialInstallment) {
		t.Fatalf("err=%v, want ErrInvalidOfficialInstallment", err)
	}
}

func TestUpdateLoan_RechazaMaturityAntesDeStart(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.StartDate = tPtr(time.Date(2026, 10, 5, 0, 0, 0, 0, LoanBogotaLocation()))
	in.MaturityDate = tPtr(time.Date(2026, 1, 1, 0, 0, 0, 0, LoanBogotaLocation()))
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ErrMaturityBeforeStart) {
		t.Fatalf("err=%v, want ErrMaturityBeforeStart", err)
	}
}

func TestUpdateLoan_RechazaMontoNoFinito(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.NetDisbursementAmount = f64Ptr(nanFloat())
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ErrInvalidMoneyField) {
		t.Fatalf("err=%v, want ErrInvalidMoneyField", err)
	}
}

func TestUpdateLoan_RechazaActorVacio(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.ActorDNI = ""
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ErrActorRequired) {
		t.Fatalf("err=%v, want ErrActorRequired", err)
	}
}

func TestUpdateLoan_RechazaLenderVacio(t *testing.T) {
	svc := NewLoanService(&stubLoanRepoSvc{}, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.LenderName = "   "
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ErrLenderRequired) {
		t.Fatalf("err=%v, want ErrLenderRequired", err)
	}
}

func TestUpdateLoan_PropagaHasPaidInstallments(t *testing.T) {
	repo := &stubLoanRepoSvc{updateErr: ports.ErrLoanHasPaidInstallments}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.Recalculate = true
	in.HasScheduleFields = true
	in.PrincipalAmount = 1_000_000
	in.InterestRatePct = 10
	in.InterestMode = models.InterestModeSimple
	in.TermCount = 5
	in.PaymentFrequency = models.PaymentFrequencyMonthly
	in.FirstPaymentDate = time.Date(2026, 11, 5, 0, 0, 0, 0, LoanBogotaLocation())
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ports.ErrLoanHasPaidInstallments) {
		t.Fatalf("err=%v, want ErrLoanHasPaidInstallments", err)
	}
}

func TestUpdateLoan_PropagaPrincipalBelowUsage(t *testing.T) {
	repo := &stubLoanRepoSvc{updateErr: ports.ErrLoanPrincipalBelowUsage}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.Recalculate = true
	in.HasScheduleFields = true
	in.PrincipalAmount = 100
	in.InterestRatePct = 10
	in.InterestMode = models.InterestModeSimple
	in.TermCount = 5
	in.PaymentFrequency = models.PaymentFrequencyMonthly
	in.FirstPaymentDate = time.Date(2026, 11, 5, 0, 0, 0, 0, LoanBogotaLocation())
	_, err := svc.UpdateLoan(context.Background(), in)
	if !errors.Is(err, ports.ErrLoanPrincipalBelowUsage) {
		t.Fatalf("err=%v, want ErrLoanPrincipalBelowUsage", err)
	}
}

func TestUpdateLoan_PropagaLoanNotFound(t *testing.T) {
	repo := &stubLoanRepoSvc{updateErr: ports.ErrLoanNotFound}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	_, err := svc.UpdateLoan(context.Background(), baseUpdateInput())
	if !errors.Is(err, ports.ErrLoanNotFound) {
		t.Fatalf("err=%v, want ErrLoanNotFound", err)
	}
}

// La metadata se recorta antes de viajar al repo (trim de strings).
func TestUpdateLoan_RecortaStrings(t *testing.T) {
	repo := &stubLoanRepoSvc{}
	svc := NewLoanService(repo, &stubExpenseRepo{}, nil)
	in := baseUpdateInput()
	in.LenderName = "  BANCO  "
	in.CreditNumber = strPtr("  0013-0021  ")
	_, err := svc.UpdateLoan(context.Background(), in)
	if err != nil {
		t.Fatalf("UpdateLoan: %v", err)
	}
	cap := repo.updateCapture
	if cap.LenderName != "BANCO" {
		t.Errorf("lenderName no recortado: %q", cap.LenderName)
	}
	if cap.CreditNumber == nil || strings.TrimSpace(*cap.CreditNumber) != *cap.CreditNumber || *cap.CreditNumber != "0013-0021" {
		t.Errorf("creditNumber no recortado: %+v", cap.CreditNumber)
	}
}

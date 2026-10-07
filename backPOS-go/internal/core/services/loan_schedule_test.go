package services

import (
	"errors"
	"math"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// Pruebas de la lógica pura del cronograma. No tocan BD ni Gin: ejecutan
// BuildLoanSchedule / AdvanceDueDate / NextMonthlyDue / Round2 /
// DeriveInstallmentStatus contra una tabla de casos con expectativas al
// centavo.
//
// La invariante crítica es que la suma de PrincipalDue y InterestDue del
// cronograma SIEMPRE empate con principal + interés total: no se permite
// que un redondeo deje al préstamo sobrecobrando o subcobrando.
//
// MODOS DE INTERÉS SOPORTADOS: NONE, SIMPLE y FRENCH. Para FRENCH, además
// de principal+interés el cronograma incluye seguro mensual fijo
// (loan_installments.insurance_due) y FGA diferido
// (loan_installments.fga_due). En NONE/SIMPLE esas dos columnas quedan
// en 0 y el JSON serializado se reduce al contrato histórico.
// =============================================================================

func fecha(t *testing.T, s string) time.Time {
	t.Helper()
	parsed, err := time.ParseInLocation("2006-01-02", s, LoanBogotaLocation())
	if err != nil {
		t.Fatalf("ParseInLocation(%q): %v", s, err)
	}
	return parsed
}

// sumInstallmentCents es un helper pequeño para que los asserts queden
// honestos (en centavos int64, no en float64).
func sumInstallmentCents(ins []models.LoanInstallment) (principalCents, interestCents int64) {
	for _, in := range ins {
		principalCents += toCents(in.PrincipalDue)
		interestCents += toCents(in.InterestDue)
	}
	return
}

func TestBuildLoanSchedule_SimpleInterestCentsExact(t *testing.T) {
	cases := []struct {
		name           string
		principal      float64
		ratePct        float64
		termCount      int
		expectInterest float64
		expectTotal    float64
	}{
		{"1.000.000 al 10% en 10 cuotas", 1_000_000, 10, 10, 100_000, 1_100_000},
		{"500.000 al 20% en 12 cuotas", 500_000, 20, 12, 100_000, 600_000},
		{"333.333 al 15% en 7 cuotas (residuo)", 333_333, 15, 7, 49_999.95, 383_332.95},
		{"100.000 sin interés en 5 cuotas (NONE)", 100_000, 0, 5, 0, 100_000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mode := models.InterestModeSimple
			if tc.ratePct == 0 {
				mode = models.InterestModeNone
			}
			req := LoanScheduleRequest{
				PrincipalAmount:  tc.principal,
				InterestRatePct:  tc.ratePct,
				InterestMode:     mode,
				TermCount:        tc.termCount,
				PaymentFrequency: models.PaymentFrequencyMonthly,
				FirstPaymentDate: fecha(t, "2026-11-15"),
			}
			preview, err := BuildLoanSchedule(req)
			if err != nil {
				t.Fatalf("BuildLoanSchedule: %v", err)
			}
			if toCents(preview.TotalInterest) != toCents(tc.expectInterest) {
				t.Errorf("totalInterest = %.2f, want %.2f", preview.TotalInterest, tc.expectInterest)
			}
			if toCents(preview.TotalPayable) != toCents(tc.expectTotal) {
				t.Errorf("totalPayable = %.2f, want %.2f", preview.TotalPayable, tc.expectTotal)
			}
			if len(preview.Installments) != tc.termCount {
				t.Fatalf("len(installments) = %d, want %d", len(preview.Installments), tc.termCount)
			}
			// Invariantes al centavo.
			sumP, sumI := sumInstallmentCents(preview.Installments)
			if sumP != toCents(tc.principal) {
				t.Errorf("sum(principalDue) = %d cents, want %d cents (principal)", sumP, toCents(tc.principal))
			}
			if sumI != toCents(tc.expectInterest) {
				t.Errorf("sum(interestDue) = %d cents, want %d cents (interés total)", sumI, toCents(tc.expectInterest))
			}
			// Verificar la fórmula SIMPLE flat total = principal*(1+rate/100):
			// Si mode==SIMPLE, totalPayable debe ser principal*(1+rate/100)
			// (± 1 centavo por redondeo).
			if mode == models.InterestModeSimple {
				expected := tc.principal * (1 + tc.ratePct/100.0)
				if math.Abs(preview.TotalPayable-expected) > 0.01 {
					t.Errorf("totalPayable=%v, fórmula SIMPLE flat esperada=%v", preview.TotalPayable, expected)
				}
			}
			// Verificar NONE: totalPayable == principal.
			if mode == models.InterestModeNone {
				if preview.TotalPayable != tc.principal {
					t.Errorf("NONE: totalPayable=%v, want principal=%v", preview.TotalPayable, tc.principal)
				}
				if preview.TotalInterest != 0 {
					t.Errorf("NONE: totalInterest=%v, want 0", preview.TotalInterest)
				}
			}
			// Números y status.
			for i, in := range preview.Installments {
				if in.Number != i+1 {
					t.Errorf("installment %d: Number = %d, want %d", i, in.Number, i+1)
				}
				if in.PaidAmount != 0 {
					t.Errorf("installment %d: PaidAmount = %v, want 0 al crear", i, in.PaidAmount)
				}
				if in.Status != models.InstallmentStatusPending {
					t.Errorf("installment %d: Status = %q, want PENDING", i, in.Status)
				}
			}
		})
	}
}

func TestBuildLoanSchedule_UltimaCuotaAbsorbeResiduo(t *testing.T) {
	// 100.000 en 3 cuotas: 100000/3 = 33333.33... → base 33333, última 33334.
	req := LoanScheduleRequest{
		PrincipalAmount:  100_000,
		InterestRatePct:  0,
		InterestMode:     models.InterestModeNone,
		TermCount:        3,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2026-11-15"),
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		t.Fatalf("BuildLoanSchedule: %v", err)
	}
	if toCents(preview.Installments[0].PrincipalDue) != 3_333_333 {
		t.Errorf("primera cuota = %v, want 33333.33", preview.Installments[0].PrincipalDue)
	}
	if toCents(preview.Installments[1].PrincipalDue) != 3_333_333 {
		t.Errorf("segunda cuota = %v, want 33333.33", preview.Installments[1].PrincipalDue)
	}
	if toCents(preview.Installments[2].PrincipalDue) != 3_333_334 {
		t.Errorf("última cuota = %v, want 33333.34 (absorbe residuo)", preview.Installments[2].PrincipalDue)
	}
}

func TestBuildLoanSchedule_FechasMonthlyPreservanDia(t *testing.T) {
	// Enero 31 → febrero 28 (2026 no es bisiesto) → marzo 28 (preserva el día válido).
	// Nota del comportamiento: tras caer al día 28 por febrero, el día de pago
	// se "pierde": todos los meses siguientes también quedan el 28. Esto es
	// consistente con calendarios bancarios conservadores.
	req := LoanScheduleRequest{
		PrincipalAmount:  120_000,
		InterestRatePct:  0,
		InterestMode:     models.InterestModeNone,
		TermCount:        4,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2026-01-31"),
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		t.Fatalf("BuildLoanSchedule: %v", err)
	}
	wantDates := []string{"2026-01-31", "2026-02-28", "2026-03-28", "2026-04-28"}
	for i, want := range wantDates {
		got := preview.Installments[i].DueDate.Format("2006-01-02")
		if got != want {
			t.Errorf("installment %d dueDate = %s, want %s", i, got, want)
		}
	}
}

func TestBuildLoanSchedule_FechasMonthlyBisiesto(t *testing.T) {
	// 2028 sí es bisiesto: 2028-01-31 → 2028-02-29 (día válido).
	req := LoanScheduleRequest{
		PrincipalAmount:  60_000,
		InterestRatePct:  0,
		InterestMode:     models.InterestModeNone,
		TermCount:        2,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2028-01-31"),
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		t.Fatalf("BuildLoanSchedule: %v", err)
	}
	if preview.Installments[1].DueDate.Format("2006-01-02") != "2028-02-29" {
		t.Errorf("segunda cuota = %s, want 2028-02-29", preview.Installments[1].DueDate.Format("2006-01-02"))
	}
}

func TestBuildLoanSchedule_FrecuenciaWeeklyBiweekly(t *testing.T) {
	for _, tc := range []struct {
		freq      string
		expectGap int
	}{
		{models.PaymentFrequencyWeekly, 7},
		{models.PaymentFrequencyBiweekly, 14},
	} {
		t.Run(tc.freq, func(t *testing.T) {
			req := LoanScheduleRequest{
				PrincipalAmount:  40_000,
				InterestRatePct:  0,
				InterestMode:     models.InterestModeNone,
				TermCount:        4,
				PaymentFrequency: tc.freq,
				FirstPaymentDate: fecha(t, "2026-11-15"),
			}
			preview, err := BuildLoanSchedule(req)
			if err != nil {
				t.Fatalf("BuildLoanSchedule: %v", err)
			}
			for i := 1; i < len(preview.Installments); i++ {
				delta := preview.Installments[i].DueDate.Sub(preview.Installments[i-1].DueDate).Hours() / 24
				if int(delta) != tc.expectGap {
					t.Errorf("gap entre cuotas %d y %d = %.0f días, want %d", i-1, i, delta, tc.expectGap)
				}
			}
		})
	}
}

func TestBuildLoanSchedule_Validaciones(t *testing.T) {
	base := LoanScheduleRequest{
		PrincipalAmount:  1_000_000,
		InterestRatePct:  10,
		InterestMode:     models.InterestModeSimple,
		TermCount:        5,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2026-11-15"),
	}
	cases := []struct {
		name    string
		mutate  func(*LoanScheduleRequest)
		wantErr error
	}{
		{"principal cero", func(r *LoanScheduleRequest) { r.PrincipalAmount = 0 }, ErrInvalidPrincipal},
		{"principal negativo", func(r *LoanScheduleRequest) { r.PrincipalAmount = -1 }, ErrInvalidPrincipal},
		{"principal NaN", func(r *LoanScheduleRequest) { r.PrincipalAmount = math.NaN() }, ErrPrincipalOverflow},
		{"principal +Inf", func(r *LoanScheduleRequest) { r.PrincipalAmount = math.Inf(1) }, ErrPrincipalOverflow},
		{"term 0", func(r *LoanScheduleRequest) { r.TermCount = 0 }, ErrInvalidTermCount},
		{"term 601", func(r *LoanScheduleRequest) { r.TermCount = 601 }, ErrInvalidTermCount},
		{"tasa negativa", func(r *LoanScheduleRequest) { r.InterestRatePct = -1 }, ErrInvalidInterestRate},
		{"tasa NaN", func(r *LoanScheduleRequest) { r.InterestRatePct = math.NaN() }, ErrInvalidInterestRate},
		{"tasa +Inf", func(r *LoanScheduleRequest) { r.InterestRatePct = math.Inf(1) }, ErrInvalidInterestRate},
		{"tasa gigante", func(r *LoanScheduleRequest) { r.InterestRatePct = 10000 }, ErrInvalidInterestRate},
		{"modo inválido", func(r *LoanScheduleRequest) { r.InterestMode = "XX" }, ErrInvalidInterestMode},
		{"SIMPLE con tasa 0", func(r *LoanScheduleRequest) { r.InterestRatePct = 0 }, ErrInterestRequiresRate},
		{"FRENCH sin tasa cae en ErrFrenchRequiresEARate", func(r *LoanScheduleRequest) { r.InterestMode = "FRENCH"; r.InterestRatePct = 0 }, ErrFrenchRequiresEARate},
		{"FRENCH exige MONTHLY", func(r *LoanScheduleRequest) {
			r.InterestMode = "FRENCH"
			r.PaymentFrequency = models.PaymentFrequencyWeekly
		}, ErrFrenchRequiresMonthly},
		{"NONE con seguro mensual", func(r *LoanScheduleRequest) {
			r.InterestMode = models.InterestModeNone
			r.InterestRatePct = 0
			r.MonthlyInsurance = 10_000
		}, ErrInsuranceOrFgaOnlyFrench},
		{"SIMPLE con FGA total", func(r *LoanScheduleRequest) { r.FgaTotal = 100_000 }, ErrInsuranceOrFgaOnlyFrench},
		{"FRENCH con seguro negativo", func(r *LoanScheduleRequest) { r.InterestMode = "FRENCH"; r.MonthlyInsurance = -1 }, ErrInvalidMonthlyInsurance},
		{"FRENCH con FGA NaN", func(r *LoanScheduleRequest) { r.InterestMode = "FRENCH"; r.FgaTotal = math.NaN() }, ErrInvalidFgaTotal},
		{"NONE con tasa positiva", func(r *LoanScheduleRequest) { r.InterestMode = models.InterestModeNone; r.InterestRatePct = 5 }, ErrNoneForbidsRate},
		{"freq inválida", func(r *LoanScheduleRequest) { r.PaymentFrequency = "YEARLY" }, ErrInvalidPaymentFrequency},
		{"firstDueDate vacía", func(r *LoanScheduleRequest) { r.FirstPaymentDate = time.Time{} }, ErrFirstDueDateMissing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := base
			tc.mutate(&req)
			_, err := BuildLoanSchedule(req)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestAdvanceDueDate_Monthly31Enero(t *testing.T) {
	start := fecha(t, "2026-01-31")
	next := AdvanceDueDate(start, models.PaymentFrequencyMonthly)
	if next.Format("2006-01-02") != "2026-02-28" {
		t.Errorf("Enero 31 → %s, want 2026-02-28", next.Format("2006-01-02"))
	}
}

func TestNextMonthlyDue_DaySameNextMonth(t *testing.T) {
	ref := fecha(t, "2026-11-05")
	nxt := NextMonthlyDue(ref)
	if nxt.Format("2006-01-02") != "2026-12-05" {
		t.Errorf("NextMonthlyDue(nov 5) = %s, want 2026-12-05", nxt.Format("2006-01-02"))
	}
}

func TestRound2_RedondeaACentavosConsistente(t *testing.T) {
	// Usamos valores que son exactamente representables en float64 para
	// evitar depender de rareza binaria (1.005 vs 1.00499999...).
	cases := []struct {
		in  float64
		out float64
	}{
		{0, 0},
		{1.25, 1.25},
		{1.254, 1.25},
		{1.256, 1.26},
		{-1.256, -1.26},
	}
	for _, tc := range cases {
		if got := Round2(tc.in); got != tc.out {
			t.Errorf("Round2(%v) = %v, want %v", tc.in, got, tc.out)
		}
	}
}

func TestDeriveInstallmentStatus(t *testing.T) {
	due := fecha(t, "2026-11-15")
	now := fecha(t, "2026-11-10")
	later := fecha(t, "2026-11-20")

	cases := []struct {
		name                string
		principal, interest float64
		paid                float64
		dueDate, now        time.Time
		want                string
	}{
		{"sin pago antes del vencimiento", 100, 10, 0, due, now, models.InstallmentStatusPending},
		{"parcial antes del vencimiento", 100, 10, 50, due, now, models.InstallmentStatusPartial},
		{"pagada completa", 100, 10, 110, due, now, models.InstallmentStatusPaid},
		{"vencida sin pago", 100, 10, 0, due, later, models.InstallmentStatusLate},
		{"vencida con pago parcial", 100, 10, 50, due, later, models.InstallmentStatusLate},
		{"pagada después del vencimiento (sigue PAID)", 100, 10, 110, due, later, models.InstallmentStatusPaid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DeriveInstallmentStatus(tc.principal, tc.interest, tc.paid, tc.dueDate, tc.now)
			if got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBuildLoanSchedule_GranPrincipalSimpleNoDesborda(t *testing.T) {
	// 999.999.999.99 (dentro del rango NUMERIC(14,2) y del techo defensivo
	// maxMoneyAbs=1e12) al 1% en 100 cuotas. Validamos que la aritmética
	// en int64 cents no desborde y la suma empate con el total declarado.
	req := LoanScheduleRequest{
		PrincipalAmount:  999_999_999.99,
		InterestRatePct:  1,
		InterestMode:     models.InterestModeSimple,
		TermCount:        100,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2026-11-15"),
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		t.Fatalf("BuildLoanSchedule: %v", err)
	}
	sumP, sumI := sumInstallmentCents(preview.Installments)
	if sumP != toCents(req.PrincipalAmount) {
		t.Errorf("principal mismatch con monto grande (sumP=%d, want=%d)", sumP, toCents(req.PrincipalAmount))
	}
	totalCents := sumP + sumI
	if totalCents != toCents(preview.TotalPayable) {
		t.Errorf("totalPayable mismatch con monto grande")
	}
}

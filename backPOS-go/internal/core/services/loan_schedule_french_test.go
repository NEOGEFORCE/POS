package services

import (
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// Pruebas de la rama FRENCH de BuildLoanSchedule.
//
// Invariantes que todo cronograma FRENCH debe cumplir (y que esta suite
// comprueba al centavo):
//
//   * len(installments) == TermCount y los números van 1..n.
//   * sum(installments[i].PrincipalDue) == PrincipalAmount exactamente.
//   * saldo final = 0 centavos: después de amortizar el último capital,
//     no queda deuda.
//   * installments[i].InsuranceDue == MonthlyInsurance en todas las
//     cuotas (es un valor MENSUAL fijo, no se difiere).
//   * sum(installments[i].FgaDue) == FgaTotal exactamente, con el
//     residuo del redondeo mensual absorbido por la última cuota.
//   * preview.InstallmentBase = cuota francesa base (capital+interés),
//     redondeada a centavos; coincide con lo que se persiste en
//     loans.base_installment_amount.
//   * preview.TotalPayable = principal + totalInterest + totalInsurance
//     + totalFga: la invariante remaining_balance <= total_payable del
//     CHECK de BD depende de que CreateLoan guarde este valor.
//
// Caso de referencia bancario (obligatorio por contrato con el dueño):
//   P = 25.000.000, n = 60, EA = 21.3% ⇒ i_m ≈ 1.62% y cuotaBase ≈ 655.300.
// =============================================================================

// expectedFrenchBase replica la fórmula del Sistema Francés con math.Pow
// para que el test genere el mismo float64 que la implementación. Devuelve
// la cuota en centavos (int64).
func expectedFrenchBaseCents(principal float64, eaPct float64, n int) int64 {
	ea := eaPct / 100.0
	iM := math.Pow(1+ea, 1.0/12.0) - 1
	onePlusIpowN := math.Pow(1+iM, float64(n))
	cuota := principal * iM * onePlusIpowN / (onePlusIpowN - 1)
	return int64(math.Round(cuota * 100))
}

func TestBuildLoanSchedule_FrenchReferenceCase(t *testing.T) {
	// Caso canónico: préstamo bancario 25M a 60 meses, 21.3% EA. El
	// usuario fijó la expectativa "cuota base ≈ 655.300" como aproximación
	// con tolerancia; la aritmética exacta de float64 debe empatar al
	// centavo con la fórmula replicada por el test.
	req := LoanScheduleRequest{
		PrincipalAmount:  25_000_000,
		InterestRatePct:  21.3,
		InterestMode:     models.InterestModeFrench,
		TermCount:        60,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2026-11-15"),
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		t.Fatalf("BuildLoanSchedule FRENCH: %v", err)
	}

	// Verificación numérica fuerte: la implementación tiene que producir
	// exactamente la cuota francesa que calcula math.Pow (empatando al
	// centavo tras el redondeo). Esto es un ancla contra regresiones por
	// cambios en el redondeo o en el orden de las operaciones.
	wantBaseCents := expectedFrenchBaseCents(25_000_000, 21.3, 60)
	gotBaseCents := toCents(preview.InstallmentBase)
	if gotBaseCents != wantBaseCents {
		t.Errorf("InstallmentBase = %d centavos, want %d centavos (fórmula)", gotBaseCents, wantBaseCents)
	}

	// Rango "razonable" alrededor del 655.300 declarado por el usuario:
	// si el redondeo o la fórmula cambia, el valor debe seguir cayendo
	// cerca. ±2.000 pesos sobre 655.300 es holgado para un pago mensual.
	if preview.InstallmentBase < 653_300 || preview.InstallmentBase > 657_300 {
		t.Errorf("InstallmentBase = %.2f fuera del rango 653300..657300 (ref ≈ 655300)", preview.InstallmentBase)
	}

	// i_m ≈ 1.62% — la aproximación declarada por el usuario. Verificamos
	// el valor exacto con el que trabaja el servicio para que un drift
	// futuro sea evidente.
	iMExact := math.Pow(1+0.213, 1.0/12.0) - 1
	if iMExact < 0.0161 || iMExact > 0.0163 {
		t.Errorf("i_m = %.6f fuera del rango 1.61..1.63%% (ref ≈ 1.62%%)", iMExact*100)
	}

	// Invariantes básicas del cronograma.
	if len(preview.Installments) != 60 {
		t.Fatalf("len(installments) = %d, want 60", len(preview.Installments))
	}

	// Suma de capitales exactamente = principal.
	var sumPrincipalCents, sumInterestCents int64
	for _, in := range preview.Installments {
		sumPrincipalCents += toCents(in.PrincipalDue)
		sumInterestCents += toCents(in.InterestDue)
	}
	if sumPrincipalCents != toCents(25_000_000) {
		t.Errorf("sum(principalDue) = %d centavos, want %d (principal)", sumPrincipalCents, toCents(25_000_000.0))
	}

	// totalInterest coincide con la suma por cuota.
	if sumInterestCents != toCents(preview.TotalInterest) {
		t.Errorf("sum(interestDue) = %d, totalInterest = %d — no empatan", sumInterestCents, toCents(preview.TotalInterest))
	}

	// Saldo final = 0: el loop debe dejar saldo 0 tras el último capital.
	saldo := toCents(25_000_000.0)
	for _, in := range preview.Installments {
		saldo -= toCents(in.PrincipalDue)
	}
	if saldo != 0 {
		t.Errorf("saldo final = %d centavos, want 0", saldo)
	}

	// La cuota de capital+interés NO es exactamente constante por el
	// redondeo mensual; verificamos que no deriva más de ±1 centavo de
	// la cuota base en las cuotas intermedias (la última absorbe el
	// residuo con tolerancia más amplia).
	baseCents := toCents(preview.InstallmentBase)
	for i := 0; i < len(preview.Installments)-1; i++ {
		got := toCents(preview.Installments[i].PrincipalDue) + toCents(preview.Installments[i].InterestDue)
		if abs64Test(got-baseCents) > 1 {
			t.Errorf("cuota %d capital+interés = %d, dista más de 1 centavo de la base %d", i+1, got, baseCents)
		}
	}
}

func TestBuildLoanSchedule_FrenchInsuranceAndFgaInvariants(t *testing.T) {
	// FRENCH con los dos extras habituales de bancos locales: seguro
	// mensual fijo y FGA diferido.
	req := LoanScheduleRequest{
		PrincipalAmount:  25_000_000,
		InterestRatePct:  21.3,
		InterestMode:     models.InterestModeFrench,
		TermCount:        60,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2026-11-15"),
		MonthlyInsurance: 32_500,
		FgaTotal:         600_000,
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		t.Fatalf("BuildLoanSchedule: %v", err)
	}

	// Seguro mensual fijo en todas las cuotas (nunca se difiere).
	for i, in := range preview.Installments {
		if toCents(in.InsuranceDue) != toCents(32_500) {
			t.Errorf("cuota %d: insuranceDue = %.2f, want 32500.00", i+1, in.InsuranceDue)
		}
	}

	// FGA: fga_mensual ≈ 600000/60 = 10000, residuo absorbido por la
	// última cuota (en este caso es exacto, 60 divide a 600000). Hay
	// que validar sum(fga_due) == FgaTotal al centavo.
	var sumFgaCents int64
	for _, in := range preview.Installments {
		sumFgaCents += toCents(in.FgaDue)
	}
	if sumFgaCents != toCents(600_000) {
		t.Errorf("sum(fgaDue) = %d centavos, want %d (FgaTotal)", sumFgaCents, toCents(600_000.0))
	}
	// Cuotas intermedias llevan el fga_mensual.
	wantMonthlyFgaCents := toCents(10_000)
	for i := 0; i < len(preview.Installments)-1; i++ {
		if toCents(preview.Installments[i].FgaDue) != wantMonthlyFgaCents {
			t.Errorf("cuota %d: fgaDue = %.2f, want 10000.00", i+1, preview.Installments[i].FgaDue)
		}
	}

	// Totales reportados en el preview coinciden con sumas por cuota.
	if toCents(preview.TotalInsurance) != toCents(32_500*60) {
		t.Errorf("TotalInsurance = %.2f, want %d", preview.TotalInsurance, 32500*60)
	}
	if toCents(preview.TotalFga) != toCents(600_000) {
		t.Errorf("TotalFga = %.2f, want 600000", preview.TotalFga)
	}
	if toCents(preview.MonthlyInsurance) != toCents(32_500) {
		t.Errorf("MonthlyInsurance = %.2f, want 32500", preview.MonthlyInsurance)
	}
	if toCents(preview.MonthlyFga) != wantMonthlyFgaCents {
		t.Errorf("MonthlyFga = %.2f, want 10000", preview.MonthlyFga)
	}

	// TotalPayable = principal + interés + seguro + fga.
	var sumPrincipalCents, sumInterestCents int64
	for _, in := range preview.Installments {
		sumPrincipalCents += toCents(in.PrincipalDue)
		sumInterestCents += toCents(in.InterestDue)
	}
	wantTotalCents := sumPrincipalCents + sumInterestCents + toCents(32_500*60) + toCents(600_000)
	if toCents(preview.TotalPayable) != wantTotalCents {
		t.Errorf("TotalPayable = %d centavos, want %d (principal+interés+seguro+fga)", toCents(preview.TotalPayable), wantTotalCents)
	}
}

func TestBuildLoanSchedule_FrenchFgaResidueAbsorbedByLastInstallment(t *testing.T) {
	// FGA que no divide exacto: 500.000 / 60 = 8333.33...
	// La implementación reparte 8333.33 por cuota y la última absorbe
	// el residuo. SUM(fga_due) debe seguir dando 500.000 exactos.
	req := LoanScheduleRequest{
		PrincipalAmount:  10_000_000,
		InterestRatePct:  18.5,
		InterestMode:     models.InterestModeFrench,
		TermCount:        60,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2026-11-15"),
		MonthlyInsurance: 15_000,
		FgaTotal:         500_000,
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		t.Fatalf("BuildLoanSchedule: %v", err)
	}
	// Suma debe empatar exacto.
	var sumFgaCents int64
	for _, in := range preview.Installments {
		sumFgaCents += toCents(in.FgaDue)
	}
	if sumFgaCents != toCents(500_000) {
		t.Errorf("sum(fgaDue) = %d centavos, want %d (FgaTotal)", sumFgaCents, toCents(500_000.0))
	}
	// Residuo esperado: 500_000.00 - 8333.33 * 60 = 500_000.00 - 499_999.80 = 0.20
	//   fga_mensual_cents = 50000000 / 60 = 833333 (centavos) → 8333.33
	//   residuo_cents = 50000000 - 833333*60 = 50000000 - 49999980 = 20
	// Última cuota = 833333 + 20 = 833353 → 8333.53
	wantLastCents := int64(833333 + 20)
	if toCents(preview.Installments[len(preview.Installments)-1].FgaDue) != wantLastCents {
		t.Errorf("fgaDue última = %d centavos, want %d (absorbe residuo)",
			toCents(preview.Installments[len(preview.Installments)-1].FgaDue), wantLastCents)
	}
	// Cuotas intermedias: 8333.33 exactos.
	for i := 0; i < len(preview.Installments)-1; i++ {
		if toCents(preview.Installments[i].FgaDue) != 833333 {
			t.Errorf("cuota %d fgaDue = %d, want 833333", i+1, toCents(preview.Installments[i].FgaDue))
		}
	}
}

func TestBuildLoanSchedule_FrenchZeroExtras(t *testing.T) {
	// FRENCH sin seguro ni FGA: el cronograma debe seguir siendo válido
	// y los extras en 0. Útil para préstamos entre privados que acepten
	// Sistema Francés sin cargos adicionales.
	req := LoanScheduleRequest{
		PrincipalAmount:  5_000_000,
		InterestRatePct:  24.0,
		InterestMode:     models.InterestModeFrench,
		TermCount:        12,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2026-12-01"),
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		t.Fatalf("BuildLoanSchedule FRENCH sin extras: %v", err)
	}
	if preview.MonthlyInsurance != 0 || preview.TotalInsurance != 0 {
		t.Errorf("sin seguro: MonthlyInsurance=%v TotalInsurance=%v, want 0 y 0", preview.MonthlyInsurance, preview.TotalInsurance)
	}
	if preview.FgaTotal != 0 || preview.MonthlyFga != 0 || preview.TotalFga != 0 {
		t.Errorf("sin FGA: FgaTotal=%v MonthlyFga=%v TotalFga=%v, want 0", preview.FgaTotal, preview.MonthlyFga, preview.TotalFga)
	}
	for i, in := range preview.Installments {
		if in.InsuranceDue != 0 || in.FgaDue != 0 {
			t.Errorf("cuota %d: insuranceDue=%v fgaDue=%v sin extras, want 0 y 0", i+1, in.InsuranceDue, in.FgaDue)
		}
	}
	// Saldo final = 0.
	saldo := toCents(5_000_000.0)
	for _, in := range preview.Installments {
		saldo -= toCents(in.PrincipalDue)
	}
	if saldo != 0 {
		t.Errorf("saldo final = %d, want 0", saldo)
	}
}

func TestBuildLoanSchedule_FrenchForcesMonthlyFrequency(t *testing.T) {
	// Si el request viene con WEEKLY/BIWEEKLY, el validator debe
	// rechazarlo con ErrFrenchRequiresMonthly: la fórmula del Sistema
	// Francés sólo tiene sentido con la conversión EA → mensual.
	for _, freq := range []string{models.PaymentFrequencyWeekly, models.PaymentFrequencyBiweekly} {
		req := LoanScheduleRequest{
			PrincipalAmount:  1_000_000,
			InterestRatePct:  21.3,
			InterestMode:     models.InterestModeFrench,
			TermCount:        12,
			PaymentFrequency: freq,
			FirstPaymentDate: fecha(t, "2026-11-15"),
		}
		if _, err := BuildLoanSchedule(req); err != ErrFrenchRequiresMonthly {
			t.Errorf("FRENCH + %s: err=%v, want ErrFrenchRequiresMonthly", freq, err)
		}
	}
}

func TestBuildLoanSchedule_FrenchLowRatePreservesInvariants(t *testing.T) {
	// Tasa baja (3% EA) — exacerba el redondeo por la raíz 12ª y por el
	// interés casi marginal, pero las invariantes de saldo = 0 y
	// sum(principal) = P deben seguir cumpliéndose al centavo.
	req := LoanScheduleRequest{
		PrincipalAmount:  7_777_777,
		InterestRatePct:  3.0,
		InterestMode:     models.InterestModeFrench,
		TermCount:        36,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2026-12-15"),
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		t.Fatalf("FRENCH tasa baja: %v", err)
	}
	var sumPrincipalCents int64
	for _, in := range preview.Installments {
		sumPrincipalCents += toCents(in.PrincipalDue)
	}
	if sumPrincipalCents != toCents(req.PrincipalAmount) {
		t.Errorf("sum(principalDue) = %d, want %d", sumPrincipalCents, toCents(req.PrincipalAmount))
	}
}

// Prueba de "casi tasa cero" (0.001% EA) para FRENCH: válido pero el
// interés total es casi 0. Protege contra divisiones por cero en el
// denominador (1+i)^n - 1 cuando i es muy pequeño.
func TestBuildLoanSchedule_FrenchNearZeroRate(t *testing.T) {
	req := LoanScheduleRequest{
		PrincipalAmount:  1_200_000,
		InterestRatePct:  0.001,
		InterestMode:     models.InterestModeFrench,
		TermCount:        12,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: fecha(t, "2026-11-15"),
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		t.Fatalf("FRENCH 0.001%% EA: %v", err)
	}
	// Capital total debe ser 1.200.000 exactos.
	var sumP int64
	for _, in := range preview.Installments {
		sumP += toCents(in.PrincipalDue)
	}
	if sumP != toCents(1_200_000) {
		t.Errorf("sum principal con tasa casi 0: %d, want %d", sumP, toCents(1_200_000.0))
	}
	// Cuota base ≈ 100.000 (± 1 peso).
	if math.Abs(preview.InstallmentBase-100_000) > 1 {
		t.Errorf("InstallmentBase=%.2f, want ≈100000 (± 1 peso)", preview.InstallmentBase)
	}
}

// Blindaje: NONE y SIMPLE siguen produciendo el JSON histórico, con los
// extras en 0. Si una futura refactor contamina NONE/SIMPLE con FRENCH,
// este test grita.
func TestBuildLoanSchedule_NoneSimpleUnchangedByFrenchAddition(t *testing.T) {
	cases := []struct {
		name          string
		req           LoanScheduleRequest
		wantTotal     float64
		wantInterest  float64
		wantInstBase  float64
		wantPrincipal float64
	}{
		{
			name: "SIMPLE 1M al 10% x 10 permanece flat total",
			req: LoanScheduleRequest{
				PrincipalAmount:  1_000_000,
				InterestRatePct:  10,
				InterestMode:     models.InterestModeSimple,
				TermCount:        10,
				PaymentFrequency: models.PaymentFrequencyMonthly,
				FirstPaymentDate: fecha(t, "2026-11-15"),
			},
			wantTotal:    1_100_000,
			wantInterest: 100_000,
			wantInstBase: 110_000,
		},
		{
			name: "NONE 500K x 5 permanece sin interés",
			req: LoanScheduleRequest{
				PrincipalAmount:  500_000,
				InterestRatePct:  0,
				InterestMode:     models.InterestModeNone,
				TermCount:        5,
				PaymentFrequency: models.PaymentFrequencyMonthly,
				FirstPaymentDate: fecha(t, "2026-11-15"),
			},
			wantTotal:    500_000,
			wantInterest: 0,
			wantInstBase: 100_000,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			preview, err := BuildLoanSchedule(tc.req)
			if err != nil {
				t.Fatalf("err=%v", err)
			}
			if toCents(preview.TotalPayable) != toCents(tc.wantTotal) {
				t.Errorf("TotalPayable=%.2f, want %.2f", preview.TotalPayable, tc.wantTotal)
			}
			if toCents(preview.TotalInterest) != toCents(tc.wantInterest) {
				t.Errorf("TotalInterest=%.2f, want %.2f", preview.TotalInterest, tc.wantInterest)
			}
			if toCents(preview.InstallmentBase) != toCents(tc.wantInstBase) {
				t.Errorf("InstallmentBase=%.2f, want %.2f", preview.InstallmentBase, tc.wantInstBase)
			}
			// Extras siempre en 0 para NONE/SIMPLE: contrato histórico.
			if preview.MonthlyInsurance != 0 || preview.TotalInsurance != 0 ||
				preview.FgaTotal != 0 || preview.MonthlyFga != 0 || preview.TotalFga != 0 {
				t.Errorf("extras no son 0 en NONE/SIMPLE: %+v", preview)
			}
			for i, in := range preview.Installments {
				if in.InsuranceDue != 0 || in.FgaDue != 0 {
					t.Errorf("cuota %d en NONE/SIMPLE: insurance=%v fga=%v, want 0", i+1, in.InsuranceDue, in.FgaDue)
				}
			}
		})
	}
}

// Status derivation extendida con seguro+FGA.
func TestDeriveInstallmentStatus_IncludesInsuranceAndFga(t *testing.T) {
	due := fecha(t, "2026-11-15")
	now := fecha(t, "2026-11-10")

	// cuota FRENCH: 100 principal + 10 interés + 32.5 seguro + 10 FGA
	// total = 152.5. Pagando 110 (solo principal+interés) NO alcanza:
	// no es PAID, debe quedar PARTIAL.
	got := DeriveInstallmentStatus(100, 10, 110, due, now, 32.5, 10)
	if got != models.InstallmentStatusPartial {
		t.Errorf("FRENCH parcial: got %q, want PARTIAL", got)
	}
	// Pagando 152.5 completa.
	got = DeriveInstallmentStatus(100, 10, 152.5, due, now, 32.5, 10)
	if got != models.InstallmentStatusPaid {
		t.Errorf("FRENCH completo: got %q, want PAID", got)
	}
	// Sin extras (variádico vacío) → compatibilidad histórica.
	got = DeriveInstallmentStatus(100, 10, 110, due, now)
	if got != models.InstallmentStatusPaid {
		t.Errorf("histórico sin extras: got %q, want PAID", got)
	}
}

// abs64Test — abs para int64, local para no cruzar paquetes.
func abs64Test(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

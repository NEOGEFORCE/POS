package services

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// Caso obligatorio del dueño (2026-10-07): P=25.000.000, EA=21,3%, n=60,
// cargos mensuales 37.472 (seguro de vida 30.040 + FGA prorrateado 7.432).
// Con la fórmula pedida la cuota base exacta es 654.938,94 y la cuota final
// 692.410,94; el "≈692.772" del banco queda 361 pesos (0,05%) por encima.
func TestFrenchSchedule_CasoBancoDueno(t *testing.T) {
	preview, err := BuildLoanSchedule(LoanScheduleRequest{
		PrincipalAmount:  25_000_000,
		InterestRatePct:  21.3,
		InterestMode:     models.InterestModeFrench,
		TermCount:        60,
		PaymentFrequency: models.PaymentFrequencyMonthly,
		FirstPaymentDate: time.Date(2026, 11, 7, 0, 0, 0, 0, LoanBogotaLocation()),
		MonthlyInsurance: 37_472,
	})
	if err != nil {
		t.Fatalf("BuildLoanSchedule: %v", err)
	}

	iM := math.Pow(1.213, 1.0/12) - 1
	if preview.MonthlyRate == nil || math.Abs(*preview.MonthlyRate-iM) > 1e-12 {
		t.Fatalf("monthlyRate = %v, want %v", preview.MonthlyRate, iM)
	}
	if preview.InstallmentBase != 654938.94 {
		t.Errorf("cuota base = %.2f, want 654938.94", preview.InstallmentBase)
	}
	if preview.MonthlyTotal == nil || *preview.MonthlyTotal != 692410.94 {
		t.Errorf("cuota mensual final = %v, want 692410.94", preview.MonthlyTotal)
	}
	if math.Abs(692772-*preview.MonthlyTotal) > 500 {
		t.Errorf("cuota final %.2f se aleja más de $500 del valor del banco 692.772", *preview.MonthlyTotal)
	}

	// Cronograma por saldos: interés = saldo_anterior * i_m,
	// capital = cuota_base - interés, saldo = saldo_anterior - capital.
	prev := int64(2_500_000_000)
	var sumPrincipal int64
	for i, inst := range preview.Installments {
		if inst.Balance == nil {
			t.Fatalf("cuota %d sin saldo", inst.Number)
		}
		wantInterest := int64(math.Round(float64(prev) * iM))
		if toCents(inst.InterestDue) != wantInterest {
			t.Errorf("cuota %d interés = %.2f, want %.2f", inst.Number, inst.InterestDue, fromCents(wantInterest))
		}
		if i < len(preview.Installments)-1 && toCents(inst.PrincipalDue)+toCents(inst.InterestDue) != 65_493_894 {
			t.Errorf("cuota %d capital+interés != cuota base", inst.Number)
		}
		if inst.InsuranceDue != 37_472 {
			t.Errorf("cuota %d cargos = %.2f, want 37472", inst.Number, inst.InsuranceDue)
		}
		prev -= toCents(inst.PrincipalDue)
		sumPrincipal += toCents(inst.PrincipalDue)
		if toCents(*inst.Balance) != prev {
			t.Errorf("cuota %d saldo = %.2f, want %.2f", inst.Number, *inst.Balance, fromCents(prev))
		}
	}
	if prev != 0 || sumPrincipal != 2_500_000_000 {
		t.Errorf("saldo final = %d centavos, Σcapital = %d; want 0 y P", prev, sumPrincipal)
	}

	// El JSON de cada cuota trae saldo, interés y capital.
	raw, _ := json.Marshal(preview.Installments[0])
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	for _, k := range []string{"balance", "interestDue", "principalDue", "totalDue"} {
		if _, ok := m[k]; !ok {
			t.Errorf("JSON de cuota sin %q: %s", k, raw)
		}
	}
}

func TestLoanInstallment_SinBalanceNoLoSerializa(t *testing.T) {
	raw, _ := json.Marshal(models.LoanInstallment{Number: 1, PrincipalDue: 10})
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if _, ok := m["balance"]; ok {
		t.Errorf("filas leídas de BD (Balance nil) no deben exponer balance: %s", raw)
	}
}

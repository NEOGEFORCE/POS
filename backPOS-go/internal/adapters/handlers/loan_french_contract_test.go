package handlers

import (
	"encoding/json"
	"math"
	"net/http"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// Payload EXACTO que arma LoanFormModal.toPayload en modo FRENCH:
// interestRatePct=0 y la EA en annualEffectiveRatePct. Este test existe
// porque cada proyecto se probó por separado y el backend ignoraba el
// campo canónico, respondiendo 400 a todo préstamo francés real.
const frenchFrontendPayload = `{
	"lenderName":"BANCO",
	"lenderDni":null,
	"principalAmount":25000000,
	"interestRatePct":0,
	"interestMode":"FRENCH",
	"termCount":60,
	"paymentFrequency":"MONTHLY",
	"startDate":"2026-10-06",
	"firstPaymentDate":"2026-11-06",
	"disbursementChannel":"EFECTIVO",
	"note":null,
	"annualEffectiveRatePct":21.3,
	"monthlyInsurance":25000,
	"fgaTotal":600000
}`

func TestLoanHandler_Preview_FrenchConPayloadRealDelFrontend(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/preview", frenchFrontendPayload)
	c.Set("userDni", "ADMIN-1")
	h.Preview(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("FRENCH con EA en annualEffectiveRatePct debe devolver 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var resp struct {
		Preview map[string]any `json:"preview"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body no es JSON: %v", err)
	}
	p := resp.Preview
	// Claves que lee normalizeLoanPreviewResponse en loans.mjs.
	for _, key := range []string{"baseInstallment", "monthlyRate", "monthlyTotal", "monthlyInsurance", "monthlyFga", "totalInsurance", "totalFga", "totalPayable", "totalInterest"} {
		if _, ok := p[key]; !ok {
			t.Errorf("preview FRENCH debe exponer %q (lo lee el frontend); body=%s", key, rec.Body.String())
		}
	}
	base, _ := p["baseInstallment"].(float64)
	if math.Abs(base-655300) > 2000 {
		t.Errorf("baseInstallment = %v, want ≈655300", base)
	}
	rate, _ := p["monthlyRate"].(float64)
	if math.Abs(rate-0.0162) > 0.0005 {
		t.Errorf("monthlyRate = %v, want ≈0.0162 (decimal)", rate)
	}
	fga, _ := p["monthlyFga"].(float64)
	total, _ := p["monthlyTotal"].(float64)
	if math.Abs(total-(base+25000+fga)) > 0.005 {
		t.Errorf("monthlyTotal = %v, want base+seguro+fga = %v", total, base+25000+fga)
	}
	insts, _ := p["installments"].([]any)
	if len(insts) != 60 {
		t.Fatalf("len(installments) = %d, want 60", len(insts))
	}
	first, _ := insts[0].(map[string]any)
	if _, ok := first["totalDue"]; !ok {
		t.Errorf("cada cuota debe exponer totalDue; got %+v", first)
	}
}

func TestLoanHandler_Preview_SimpleNoExponeExtrasFrench(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	body := `{"principalAmount":1000000,"interestRatePct":10,"interestMode":"SIMPLE","termCount":5,"paymentFrequency":"MONTHLY","firstPaymentDate":"2026-11-15"}`
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/preview", body)
	c.Set("userDni", "ADMIN-1")
	h.Preview(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("SIMPLE debe devolver 200, got %d", rec.Code)
	}
	var resp struct {
		Preview map[string]any `json:"preview"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	for _, key := range []string{"baseInstallment", "monthlyRate", "monthlyTotal"} {
		if _, ok := resp.Preview[key]; ok {
			t.Errorf("SIMPLE no debe exponer %q (la UI lo trataría como francés)", key)
		}
	}
}

func TestCreateOrPreviewRequest_EffectiveRate(t *testing.T) {
	cases := []struct {
		name string
		req  createOrPreviewRequest
		want float64
	}{
		{"FRENCH usa EA canónica", createOrPreviewRequest{InterestMode: "FRENCH", InterestRatePct: 0, AnnualEffectiveRatePct: 21.3}, 21.3},
		{"FRENCH minúsculas", createOrPreviewRequest{InterestMode: " french ", AnnualEffectiveRatePct: 18}, 18},
		{"FRENCH fallback legacy", createOrPreviewRequest{InterestMode: "FRENCH", InterestRatePct: 21.3}, 21.3},
		{"SIMPLE ignora EA", createOrPreviewRequest{InterestMode: "SIMPLE", InterestRatePct: 10, AnnualEffectiveRatePct: 99}, 10},
		{"NONE ignora EA", createOrPreviewRequest{InterestMode: "NONE", AnnualEffectiveRatePct: 5}, 0},
	}
	for _, tc := range cases {
		if got := tc.req.effectiveRatePct(); got != tc.want {
			t.Errorf("%s: effectiveRatePct() = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestLoanInstallment_JSONIncluyeTotalDue(t *testing.T) {
	inst := models.LoanInstallment{Number: 1, PrincipalDue: 249442.1, InterestDue: 405496.84, InsuranceDue: 25000, FgaDue: 10000}
	raw, err := json.Marshal(inst)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if m["totalDue"].(float64) != 689938.94 {
		t.Errorf("totalDue = %v, want 689938.94 (body=%s)", m["totalDue"], raw)
	}
	for _, key := range []string{"principalDue", "interestDue", "insuranceDue", "fgaDue", "number", "status"} {
		if _, ok := m[key]; !ok {
			t.Errorf("MarshalJSON no debe perder %q", key)
		}
	}
}

package handlers

import (
	"encoding/json"
	"net/http"
	"testing"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Pruebas del LoanHandler.Update (PUT /api/loans/:id).
//
// Validan el contrato HTTP:
//   - 200 con { loan } en metadata-only.
//   - 200 con recalculate=true (schedule FRENCH).
//   - 401 sin sesión.
//   - 400 payload inválido / id inválido.
//   - 400 LOAN_PRINCIPAL_BELOW_USAGE.
//   - 409 LOAN_HAS_PAID_INSTALLMENTS.
//   - 404 LOAN_NOT_FOUND.
//   - 400 LOAN_INVALID_INPUT (metadata inválida: enums, snapshot a medias).
//   - Ruta registrada en main.go.
// =============================================================================

func TestLoanHandler_Update_MetadataOnly200(t *testing.T) {
	repo := &stubLoanRepo{
		getByIDLoan: &models.Loan{ID: 10, LenderName: "BANCO DE BOGOTA", LoanType: "CONSUMO", Currency: "COP", RateType: "FIJO"},
		updateOutcome: &ports.UpdateLoanAtomicOutcome{
			Loan:         &models.Loan{ID: 10, LenderName: "BANCO DE BOGOTA", LoanType: "CONSUMO", Currency: "COP", RateType: "FIJO"},
			Recalculated: false,
			LoanStatus:   models.LoanStatusActive,
		},
	}
	h := newLoanHandlerWithStub(repo)
	body := `{
		"metadata":{
			"lenderName":"BANCO DE BOGOTA",
			"disbursementChannel":"BANCO",
			"loanType":"CONSUMO",
			"currency":"COP",
			"rateType":"FIJO",
			"autoDebit":true,
			"creditNumber":"0013-0021-96-00322102",
			"holderName":"FABIAN ERNESTO SARMIENTO",
			"maturityDate":"2031-10-05",
			"bankBalanceAmount":25326046.44,
			"bankBalanceAsOf":"2026-10-07T12:00:00-05:00",
			"bankPaidAmount":0,
			"officialNextInstallmentAmount":693951.69,
			"officialNextInstallmentDate":"2026-11-05"
		}
	}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/10", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("update metadata-only debe devolver 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("json: %v", err)
	}
	loan, ok := resp["loan"].(map[string]any)
	if !ok {
		t.Fatalf("falta clave 'loan': %+v", resp)
	}
	if loan["loanType"].(string) != "CONSUMO" {
		t.Errorf("loanType=%v, want CONSUMO", loan["loanType"])
	}
	// El repo recibió la metadata (sin recalculate).
	if repo.updateCapture == nil || repo.updateCapture.Recalculate {
		t.Errorf("metadata-only no debe marcar Recalculate: %+v", repo.updateCapture)
	}
	if repo.updateCapture.CreditNumber == nil || *repo.updateCapture.CreditNumber != "0013-0021-96-00322102" {
		t.Errorf("creditNumber mal propagado: %+v", repo.updateCapture.CreditNumber)
	}
}

func TestLoanHandler_Update_Recalculate200(t *testing.T) {
	repo := &stubLoanRepo{
		updateOutcome: &ports.UpdateLoanAtomicOutcome{
			Loan:         &models.Loan{ID: 10, LenderName: "BANCO", LoanType: "CONSUMO", Currency: "COP", RateType: "FIJO"},
			Recalculated: true,
			LoanStatus:   models.LoanStatusActive,
		},
	}
	h := newLoanHandlerWithStub(repo)
	body := `{
		"metadata":{
			"lenderName":"BANCO",
			"disbursementChannel":"BANCO",
			"loanType":"CONSUMO",
			"currency":"COP",
			"rateType":"FIJO"
		},
		"schedule":{
			"recalculate":true,
			"principalAmount":25000000,
			"interestRatePct":0,
			"annualEffectiveRatePct":21.3,
			"interestMode":"FRENCH",
			"termCount":60,
			"paymentFrequency":"MONTHLY",
			"firstPaymentDate":"2026-11-05",
			"monthlyInsurance":30040.78
		}
	}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/10", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("update recalculate debe devolver 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	cap := repo.updateCapture
	if cap == nil || !cap.Recalculate {
		t.Fatalf("Recalculate debe quedar true en el repo: %+v", cap)
	}
	if len(cap.NewSchedule) != 60 {
		t.Errorf("cronograma recalculado = %d cuotas, want 60", len(cap.NewSchedule))
	}
	// EA canónica resuelta: FRENCH usa annualEffectiveRatePct.
	if cap.NewAnnualEffectiveRatePct != 21.3 {
		t.Errorf("NewAnnualEffectiveRatePct=%v, want 21.3", cap.NewAnnualEffectiveRatePct)
	}
}

func TestLoanHandler_Update_RequiereSesion(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	body := `{"metadata":{"lenderName":"X","loanType":"OTRO","currency":"COP","rateType":"FIJO"}}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/10", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	h.Update(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe devolver 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestLoanHandler_Update_PayloadInvalido400(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/10", `not json`)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("payload inválido debe devolver 400, got %d", rec.Code)
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INVALID_INPUT" {
		t.Errorf("code=%q, want LOAN_INVALID_INPUT", env.Error.Code)
	}
}

func TestLoanHandler_Update_IDInvalido400(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	body := `{"metadata":{"lenderName":"X","loanType":"OTRO","currency":"COP","rateType":"FIJO"}}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/0", body)
	c.Params = gin.Params{{Key: "id", Value: "0"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("id=0 debe devolver 400, got %d", rec.Code)
	}
}

func TestLoanHandler_Update_HasPaidInstallments409(t *testing.T) {
	repo := &stubLoanRepo{updateErr: ports.ErrLoanHasPaidInstallments}
	h := newLoanHandlerWithStub(repo)
	body := `{
		"metadata":{"lenderName":"BANCO","disbursementChannel":"BANCO","loanType":"CONSUMO","currency":"COP","rateType":"FIJO"},
		"schedule":{"recalculate":true,"principalAmount":25000000,"annualEffectiveRatePct":21.3,"interestMode":"FRENCH","termCount":60,"paymentFrequency":"MONTHLY","firstPaymentDate":"2026-11-05","monthlyInsurance":30040}
	}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/10", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusConflict {
		t.Fatalf("cuotas pagadas debe devolver 409, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_HAS_PAID_INSTALLMENTS" {
		t.Errorf("code=%q, want LOAN_HAS_PAID_INSTALLMENTS", env.Error.Code)
	}
}

func TestLoanHandler_Update_PrincipalBelowUsage400(t *testing.T) {
	repo := &stubLoanRepo{updateErr: ports.ErrLoanPrincipalBelowUsage}
	h := newLoanHandlerWithStub(repo)
	body := `{
		"metadata":{"lenderName":"BANCO","disbursementChannel":"BANCO","loanType":"CONSUMO","currency":"COP","rateType":"FIJO"},
		"schedule":{"recalculate":true,"principalAmount":100,"interestRatePct":10,"interestMode":"SIMPLE","termCount":5,"paymentFrequency":"MONTHLY","firstPaymentDate":"2026-11-05"}
	}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/10", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("principal bajo uso debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_PRINCIPAL_BELOW_USAGE" {
		t.Errorf("code=%q, want LOAN_PRINCIPAL_BELOW_USAGE", env.Error.Code)
	}
}

func TestLoanHandler_Update_LoanNotFound404(t *testing.T) {
	repo := &stubLoanRepo{updateErr: ports.ErrLoanNotFound}
	h := newLoanHandlerWithStub(repo)
	body := `{"metadata":{"lenderName":"X","disbursementChannel":"BANCO","loanType":"OTRO","currency":"COP","rateType":"FIJO"}}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/999", body)
	c.Params = gin.Params{{Key: "id", Value: "999"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("loan not found debe devolver 404, got %d", rec.Code)
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_NOT_FOUND" {
		t.Errorf("code=%q, want LOAN_NOT_FOUND", env.Error.Code)
	}
}

func TestLoanHandler_Update_LoanTypeInvalido400(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	body := `{"metadata":{"lenderName":"X","disbursementChannel":"BANCO","loanType":"HIPOTECA","currency":"COP","rateType":"FIJO"}}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/10", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("loanType inválido debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INVALID_INPUT" {
		t.Errorf("code=%q, want LOAN_INVALID_INPUT", env.Error.Code)
	}
}

func TestLoanHandler_Update_SnapshotAMedias400(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	// Saldo sin fecha de consulta.
	body := `{"metadata":{"lenderName":"X","disbursementChannel":"BANCO","loanType":"OTRO","currency":"COP","rateType":"FIJO","bankBalanceAmount":100}}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/10", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("snapshot a medias debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INVALID_INPUT" {
		t.Errorf("code=%q, want LOAN_INVALID_INPUT", env.Error.Code)
	}
}

// Campos financieros sin recalculate → LOAN_INVALID_INPUT.
func TestLoanHandler_Update_CamposFinancierosSinRecalc400(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	body := `{
		"metadata":{"lenderName":"X","disbursementChannel":"BANCO","loanType":"OTRO","currency":"COP","rateType":"FIJO"},
		"schedule":{"recalculate":false,"principalAmount":9999999}
	}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/10", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("campos financieros sin recalc debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INVALID_INPUT" {
		t.Errorf("code=%q, want LOAN_INVALID_INPUT", env.Error.Code)
	}
}

// Ruta registrada en main.go: anti-regresión del contrato (admin-only).
func TestLoanHandler_UpdateRouteRegistered(t *testing.T) {
	src := readMainSource(t)
	if !hasPattern(src, `loansAdmin\.PUT\("/:id",\s*loanHandler\.Update\)`) {
		t.Error("Falta la ruta PUT /:id (admin) en main.go")
	}
}

func TestLoanHandler_Update_FechaInvalida400(t *testing.T) {
	repo := &stubLoanRepo{}
	h := newLoanHandlerWithStub(repo)
	body := `{"metadata":{"lenderName":"BANCO","disbursementChannel":"BANCO","loanType":"CONSUMO","currency":"COP","rateType":"FIJO","bankBalanceAmount":100,"bankBalanceAsOf":"fecha-invalida"}}`
	c, rec := newLoanTestContext(http.MethodPut, "/api/loans/10", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.Update(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("fecha inválida debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INVALID_INPUT" {
		t.Errorf("code=%q, want LOAN_INVALID_INPUT", env.Error.Code)
	}
	if repo.updateCapture != nil {
		t.Error("la fecha inválida no debe llegar al repositorio")
	}
}

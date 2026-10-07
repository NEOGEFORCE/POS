package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Pruebas del LoanHandler.PayExpense (POST /api/loans/:id/pay-expense).
//
// Validamos:
//   - 201 con body shape { expense, loanExpense, totalUsed, available }
//     en el camino feliz.
//   - 401 cuando no hay sesión.
//   - 400 cuando el payload no se puede bindear.
//   - 400 cuando el servicio retorna ErrPrincipalExceeded.
//   - 404 cuando el servicio retorna ErrLoanNotFound / ErrExpenseNotFound.
//   - 409 cuando el servicio retorna ErrLoanNotActive / ErrExpenseNotPayable.
// =============================================================================

func TestLoanHandler_PayExpense_201ConContrato(t *testing.T) {
	exp := &models.Expense{ID: 777, PaymentSource: "PRESTAMO", Status: "PAID", Amount: 300, PaidAmount: 300, Description: "LUZ"}
	le := &models.LoanExpense{ID: 42, LoanID: 10, AmountUsed: 300, Purpose: "LUZ"}
	repo := &stubLoanRepo{
		payExpOutcome: &ports.PayExpenseAtomicOutcome{
			Expense:        exp,
			LoanExpense:    le,
			AppliedAmount:  300,
			TotalUsedAfter: 300,
			Available:      700,
		},
	}
	h := newLoanHandlerWithStub(repo)
	body := `{"amount":300,"description":"LUZ","category":"Servicios"}`
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/pay-expense", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.PayExpense(c)
	if rec.Code != http.StatusCreated {
		t.Fatalf("pay-expense válido debe devolver 201, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("json: %v", err)
	}
	if _, ok := resp["expense"]; !ok {
		t.Error("falta 'expense' en el body 201")
	}
	if _, ok := resp["loanExpense"]; !ok {
		t.Error("falta 'loanExpense' en el body 201")
	}
	if resp["totalUsed"].(float64) != 300 {
		t.Errorf("totalUsed=%v, want 300", resp["totalUsed"])
	}
	if resp["available"].(float64) != 700 {
		t.Errorf("available=%v, want 700", resp["available"])
	}
	if resp["appliedAmount"].(float64) != 300 {
		t.Errorf("appliedAmount=%v, want 300", resp["appliedAmount"])
	}
	// updatedDebt NO debe aparecer cuando el caso fue "nuevo egreso".
	if _, has := resp["updatedDebt"]; has {
		t.Errorf("no debe venir updatedDebt para nuevo egreso: %v", resp["updatedDebt"])
	}
}

func TestLoanHandler_PayExpense_AbonoDevuelveUpdatedDebt(t *testing.T) {
	exp := &models.Expense{ID: 777, PaymentSource: "PRESTAMO", Status: "PAID", Amount: 150, PaidAmount: 150, Description: "ABONO A DEUDA: PROV X"}
	debt := &models.Expense{ID: 55, Status: "SETTLED", Amount: 500, PaidAmount: 500, RemainingAmount: 0}
	expenseID := uint(55)
	le := &models.LoanExpense{ID: 42, LoanID: 10, ExpenseID: &expenseID, AmountUsed: 150}
	repo := &stubLoanRepo{
		payExpOutcome: &ports.PayExpenseAtomicOutcome{
			Expense:        exp,
			UpdatedDebt:    debt,
			LoanExpense:    le,
			AppliedAmount:  150,
			TotalUsedAfter: 150,
			Available:      850,
		},
	}
	h := newLoanHandlerWithStub(repo)
	body := `{"amount":150,"expenseId":55}`
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/pay-expense", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.PayExpense(c)
	if rec.Code != http.StatusCreated {
		t.Fatalf("abono válido debe devolver 201, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("json: %v", err)
	}
	ud, ok := resp["updatedDebt"].(map[string]any)
	if !ok {
		t.Fatal("abono debe devolver updatedDebt")
	}
	if ud["status"].(string) != "SETTLED" {
		t.Errorf("updatedDebt.status=%v, want SETTLED", ud["status"])
	}
}

func TestLoanHandler_PayExpense_RequiereSesion(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	body := `{"amount":100,"description":"LUZ"}`
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/pay-expense", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	h.PayExpense(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe devolver 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "ERR_UNAUTHORIZED" {
		t.Errorf("code=%q, want ERR_UNAUTHORIZED", env.Error.Code)
	}
}

func TestLoanHandler_PayExpense_PayloadInvalido400(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	// Payload no es JSON válido.
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/pay-expense", `not json`)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.PayExpense(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("payload inválido debe devolver 400, got %d", rec.Code)
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INVALID_INPUT" {
		t.Errorf("code=%q, want LOAN_INVALID_INPUT", env.Error.Code)
	}
}

func TestLoanHandler_PayExpense_IDInvalido400(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/0/pay-expense", `{"amount":100,"description":"x"}`)
	c.Params = gin.Params{{Key: "id", Value: "0"}}
	c.Set("userDni", "ADMIN-1")
	h.PayExpense(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("id=0 debe devolver 400, got %d", rec.Code)
	}
}

func TestLoanHandler_PayExpense_LoanNotFound404(t *testing.T) {
	repo := &stubLoanRepo{payExpErr: ports.ErrLoanNotFound}
	h := newLoanHandlerWithStub(repo)
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/999/pay-expense", `{"amount":100,"description":"x"}`)
	c.Params = gin.Params{{Key: "id", Value: "999"}}
	c.Set("userDni", "ADMIN-1")
	h.PayExpense(c)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("loan not found: got %d", rec.Code)
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_NOT_FOUND" {
		t.Errorf("code=%q, want LOAN_NOT_FOUND", env.Error.Code)
	}
}

func TestLoanHandler_PayExpense_LoanNotActive409(t *testing.T) {
	repo := &stubLoanRepo{payExpErr: ports.ErrLoanNotActive}
	h := newLoanHandlerWithStub(repo)
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/pay-expense", `{"amount":100,"description":"x"}`)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.PayExpense(c)
	if rec.Code != http.StatusConflict {
		t.Fatalf("loan not active: got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_NOT_ACTIVE" {
		t.Errorf("code=%q, want LOAN_NOT_ACTIVE", env.Error.Code)
	}
}

func TestLoanHandler_PayExpense_PrincipalExceeded400(t *testing.T) {
	repo := &stubLoanRepo{payExpErr: ports.ErrPrincipalExceeded}
	h := newLoanHandlerWithStub(repo)
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/pay-expense", `{"amount":9999999,"description":"x"}`)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.PayExpense(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("principal exceeded: got %d", rec.Code)
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_PRINCIPAL_EXCEEDED" {
		t.Errorf("code=%q, want LOAN_PRINCIPAL_EXCEEDED", env.Error.Code)
	}
}

func TestLoanHandler_PayExpense_ExpenseNotFound404(t *testing.T) {
	repo := &stubLoanRepo{payExpErr: ports.ErrExpenseNotFound}
	h := newLoanHandlerWithStub(repo)
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/pay-expense", `{"amount":100,"expenseId":999}`)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.PayExpense(c)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expense not found: got %d", rec.Code)
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_EXPENSE_NOT_FOUND" {
		t.Errorf("code=%q, want LOAN_EXPENSE_NOT_FOUND", env.Error.Code)
	}
}

func TestLoanHandler_PayExpense_ExpenseNotPayable409(t *testing.T) {
	repo := &stubLoanRepo{payExpErr: ports.ErrExpenseNotPayable}
	h := newLoanHandlerWithStub(repo)
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/pay-expense", `{"amount":100,"expenseId":55}`)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.PayExpense(c)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expense not payable: got %d", rec.Code)
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_EXPENSE_NOT_PAYABLE" {
		t.Errorf("code=%q, want LOAN_EXPENSE_NOT_PAYABLE", env.Error.Code)
	}
}

// Rutas registradas en main.go: anti-regresión del contrato.
func TestLoanHandler_PayExpenseRouteRegistered(t *testing.T) {
	// La ruta `loansAdmin.POST("/:id/pay-expense", loanHandler.PayExpense)`
	// debe existir dentro de main.go, en el grupo admin. Esto evita que un
	// refactor del cableado deje el handler sin ruta.
	//
	// El test `TestLoanHandler_RutasRegistradasEnMain` del archivo
	// loan_handler_test.go ya valida varias rutas; aquí sumamos la nueva
	// expresión regular.
	src := readMainSource(t)
	if !hasPattern(src, `loansAdmin\.POST\("/:id/pay-expense",\s*loanHandler\.PayExpense\)`) {
		t.Error("Falta la ruta /:id/pay-expense (admin) en main.go")
	}
}

// readMainSource lee el main.go para auditar que la ruta esté registrada.
func readMainSource(t *testing.T) string {
	t.Helper()
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("No se pudo leer %s: %v", root, err)
	}
	return string(bts)
}

func hasPattern(src, pattern string) bool {
	return regexp.MustCompile(pattern).MatchString(src)
}

func TestLoanHandler_PayExpense_AmountCero400(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/pay-expense", `{"amount":0,"description":"x"}`)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.PayExpense(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("amount=0 debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INVALID_INPUT" {
		t.Errorf("code=%q, want LOAN_INVALID_INPUT", env.Error.Code)
	}
}

package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
)

// =============================================================================
// Pruebas del LoanHandler. Validan el contrato HTTP (códigos de estado,
// códigos de error APIError.code, campos obligatorios) y la envoltura
// SendError sin levantar Postgres.
//
// Para Preview no hace falta repo: el servicio llama solo a BuildSchedule
// cuando el input viene mal, falla con un sentinel y nunca toca el repo.
// Para los endpoints que requerirían BD montamos un stub mínimo que
// devuelve el error que queremos ejercitar.
// =============================================================================

// stubLoanRepo satisface ports.LoanRepository para pruebas HTTP.
// Cada método devuelve el valor que el test configura.
type stubLoanRepo struct {
	createErr     error
	getByIDLoan   *models.Loan
	getByIDErr    error
	getRelErr     error
	listRows      []ports.LoanWithStatsRow
	listTotal     int64
	listErr       error
	payOutcome    *ports.PayInstallmentAtomicOutcome
	payErr        error
	expenseTotal  float64
	expenseErr    error
	recalcStatus  string
	recalcErr     error
	softDeleteErr error
	// Pay-expense-with-loan
	payExpOutcome *ports.PayExpenseAtomicOutcome
	payExpErr     error
	payExpCapture *ports.PayExpenseAtomicInput
	// Update
	updateOutcome *ports.UpdateLoanAtomicOutcome
	updateErr     error
	updateCapture *ports.UpdateLoanAtomicInput
}

func (s *stubLoanRepo) CreateLoanWithSchedule(ctx context.Context, loan *models.Loan, schedule []models.LoanInstallment) error {
	if s.createErr != nil {
		return s.createErr
	}
	loan.ID = 42
	return nil
}
func (s *stubLoanRepo) GetByID(ctx context.Context, id uint) (*models.Loan, error) {
	if s.getByIDErr != nil {
		return nil, s.getByIDErr
	}
	if s.getByIDLoan != nil {
		return s.getByIDLoan, nil
	}
	return &models.Loan{ID: id, LenderName: "ACREEDOR DEMO", PrincipalAmount: 1000, TotalPayable: 1000, RemainingBalance: 1000}, nil
}
func (s *stubLoanRepo) GetByIDWithRelations(ctx context.Context, id uint) (*models.Loan, error) {
	if s.getRelErr != nil {
		return nil, s.getRelErr
	}
	if s.getByIDLoan != nil {
		return s.getByIDLoan, nil
	}
	return &models.Loan{ID: id, LenderName: "ACREEDOR DEMO", PrincipalAmount: 1000, TotalPayable: 1000, RemainingBalance: 1000}, nil
}
func (s *stubLoanRepo) ListWithStats(ctx context.Context, filter ports.LoanListFilter) ([]ports.LoanWithStatsRow, int64, error) {
	return s.listRows, s.listTotal, s.listErr
}
func (s *stubLoanRepo) PayInstallmentAtomic(ctx context.Context, loanID uint, input ports.PayInstallmentAtomicInput) (*ports.PayInstallmentAtomicOutcome, error) {
	if s.payErr != nil {
		return nil, s.payErr
	}
	if s.payOutcome != nil {
		return s.payOutcome, nil
	}
	return &ports.PayInstallmentAtomicOutcome{
		Installment:      &models.LoanInstallment{ID: 55, LoanID: loanID, Number: input.Number, Status: models.InstallmentStatusPaid},
		ExpenseID:        111,
		LoanStatus:       models.LoanStatusActive,
		RemainingBalance: 500,
		AppliedAmount:    input.Amount,
	}, nil
}
func (s *stubLoanRepo) RegisterLoanExpense(ctx context.Context, exp *models.LoanExpense) (float64, error) {
	return s.expenseTotal, s.expenseErr
}
func (s *stubLoanRepo) PayExpenseAtomic(ctx context.Context, loanID uint, input ports.PayExpenseAtomicInput) (*ports.PayExpenseAtomicOutcome, error) {
	cp := input
	s.payExpCapture = &cp
	if s.payExpErr != nil {
		return nil, s.payExpErr
	}
	if s.payExpOutcome != nil {
		return s.payExpOutcome, nil
	}
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
func (s *stubLoanRepo) RecalculateStatus(ctx context.Context, loanID uint) (string, error) {
	return s.recalcStatus, s.recalcErr
}
func (s *stubLoanRepo) UpdateLoanAtomic(ctx context.Context, loanID uint, input ports.UpdateLoanAtomicInput) (*ports.UpdateLoanAtomicOutcome, error) {
	cp := input
	s.updateCapture = &cp
	if s.updateErr != nil {
		return nil, s.updateErr
	}
	if s.updateOutcome != nil {
		return s.updateOutcome, nil
	}
	return &ports.UpdateLoanAtomicOutcome{
		Loan:         &models.Loan{ID: loanID, LenderName: input.LenderName, LoanType: input.LoanType, Currency: input.Currency, RateType: input.RateType},
		Recalculated: input.Recalculate,
		LoanStatus:   models.LoanStatusActive,
	}, nil
}
func (s *stubLoanRepo) SoftDelete(ctx context.Context, loanID uint) error {
	return s.softDeleteErr
}

// --- helpers ---------------------------------------------------------------

func newLoanTestContext(method, url, body string) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	var reader *bytes.Reader
	if body != "" {
		reader = bytes.NewReader([]byte(body))
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, url, reader)
	req.Header.Set("Content-Type", "application/json")
	c.Request = req
	return c, rec
}

func newLoanHandlerWithStub(repo ports.LoanRepository) *LoanHandler {
	// expenseRepo nil es seguro: el servicio no llama Save por fuera; el
	// repo es quien crea el Expense dentro de la transacción atómica.
	return NewLoanHandler(services.NewLoanService(repo, nil, nil))
}

func readAPIError(t *testing.T, body []byte) ErrorResponse {
	t.Helper()
	var env ErrorResponse
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("body no es ErrorResponse: %v (body=%s)", err, body)
	}
	return env
}

// --- Preview ---------------------------------------------------------------

func TestLoanHandler_Preview_RequiereSesion(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/preview", `{}`)
	h.Preview(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("sin sesión debe devolver 401, got %d (body=%s)", rec.Code, rec.Body.String())
	}
}

func TestLoanHandler_Preview_InputInvalido400(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	// Principal 0: BuildLoanSchedule devuelve ErrInvalidPrincipal.
	body := `{"principalAmount":0,"termCount":5,"interestRatePct":10,"interestMode":"SIMPLE","paymentFrequency":"MONTHLY","firstPaymentDate":"2026-12-01"}`
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/preview", body)
	c.Set("userDni", "ADMIN-1")
	h.Preview(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("principal=0 debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INVALID_SCHEDULE" {
		t.Errorf("code=%q, want LOAN_INVALID_SCHEDULE (body=%s)", env.Error.Code, rec.Body.String())
	}
}

func TestLoanHandler_Preview_ValidoDevuelveCronograma(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	body := `{"principalAmount":1000000,"interestRatePct":10,"interestMode":"SIMPLE","termCount":5,"paymentFrequency":"MONTHLY","firstPaymentDate":"2026-11-15"}`
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/preview", body)
	c.Set("userDni", "ADMIN-1")
	h.Preview(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("preview válido debe devolver 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body no es JSON: %v", err)
	}
	preview, ok := resp["preview"].(map[string]any)
	if !ok {
		t.Fatalf("falta la clave 'preview' en el body: %+v", resp)
	}
	if preview["totalInterest"].(float64) != 100000 {
		t.Errorf("totalInterest = %v, want 100000", preview["totalInterest"])
	}
	if preview["totalPayable"].(float64) != 1100000 {
		t.Errorf("totalPayable = %v, want 1100000", preview["totalPayable"])
	}
}

// --- List -------------------------------------------------------------------

func TestLoanHandler_List_PropagaRows(t *testing.T) {
	repo := &stubLoanRepo{
		listRows: []ports.LoanWithStatsRow{
			{Loan: models.Loan{ID: 1, LenderName: "A"}, TotalDue: 100, OutstandingDue: 80, TotalPayable: 100, RemainingBalance: 80},
			{Loan: models.Loan{ID: 2, LenderName: "B"}, TotalDue: 200, OutstandingDue: 0, TotalPayable: 200, RemainingBalance: 0},
		},
		listTotal: 2,
	}
	h := newLoanHandlerWithStub(repo)
	c, rec := newLoanTestContext(http.MethodGet, "/api/loans", "")
	c.Set("userDni", "USR-1")
	h.List(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("list debe devolver 200, got %d", rec.Code)
	}
	var resp struct {
		Loans []map[string]any `json:"loans"`
		Total int64            `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("json: %v", err)
	}
	if resp.Total != 2 || len(resp.Loans) != 2 {
		t.Fatalf("total/loans mal: %+v", resp)
	}
	// La fila debe exponer totalPayable y remainingBalance.
	if _, ok := resp.Loans[0]["totalPayable"]; !ok {
		t.Error("falta totalPayable en la fila listada")
	}
	if _, ok := resp.Loans[0]["remainingBalance"]; !ok {
		t.Error("falta remainingBalance en la fila listada")
	}
}

// --- GetByID ----------------------------------------------------------------

func TestLoanHandler_GetByID_NotFound(t *testing.T) {
	repo := &stubLoanRepo{getRelErr: ports.ErrLoanNotFound}
	h := newLoanHandlerWithStub(repo)
	c, rec := newLoanTestContext(http.MethodGet, "/api/loans/99", "")
	c.Params = gin.Params{{Key: "id", Value: "99"}}
	c.Set("userDni", "ADMIN-1")
	h.GetByID(c)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("getByID inexistente debe devolver 404, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_NOT_FOUND" {
		t.Errorf("code debe ser LOAN_NOT_FOUND, got %q", env.Error.Code)
	}
}

func TestLoanHandler_GetByID_IDInvalido(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	c, rec := newLoanTestContext(http.MethodGet, "/api/loans/0", "")
	c.Params = gin.Params{{Key: "id", Value: "0"}}
	h.GetByID(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("id=0 debe devolver 400, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INVALID_INPUT" {
		t.Errorf("code=%q, want LOAN_INVALID_INPUT", env.Error.Code)
	}
}

// --- Pay --------------------------------------------------------------------

func TestLoanHandler_Pay_UsaNumberDeURLYRespondeOK(t *testing.T) {
	repo := &stubLoanRepo{
		payOutcome: &ports.PayInstallmentAtomicOutcome{
			Installment:      &models.LoanInstallment{ID: 99, LoanID: 10, Number: 3, Status: models.InstallmentStatusPaid},
			ExpenseID:        777,
			LoanStatus:       models.LoanStatusActive,
			RemainingBalance: 1000,
			AppliedAmount:    110,
		},
	}
	h := newLoanHandlerWithStub(repo)
	body := `{"amount":110,"paymentSource":"EFECTIVO"}`
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/installments/3/pay", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}, {Key: "number", Value: "3"}}
	c.Set("userDni", "ADMIN-1")
	h.Pay(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("pay válido debe devolver 200, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("json: %v", err)
	}
	if resp["expenseId"].(float64) != 777 {
		t.Errorf("expenseId=%v, want 777", resp["expenseId"])
	}
	if resp["remainingBalance"].(float64) != 1000 {
		t.Errorf("remainingBalance=%v, want 1000", resp["remainingBalance"])
	}
	inst := resp["installment"].(map[string]any)
	if inst["number"].(float64) != 3 {
		t.Errorf("installment.number=%v, want 3 (vino de la URL)", inst["number"])
	}
}

func TestLoanHandler_Pay_IdempotenteDevuelve409(t *testing.T) {
	repo := &stubLoanRepo{payErr: ports.ErrInstallmentAlreadyPaid}
	h := newLoanHandlerWithStub(repo)
	body := `{"amount":110,"paymentSource":"EFECTIVO"}`
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/installments/3/pay", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}, {Key: "number", Value: "3"}}
	c.Set("userDni", "ADMIN-1")
	h.Pay(c)
	if rec.Code != http.StatusConflict {
		t.Fatalf("ya pagada debe devolver 409, got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INSTALLMENT_ALREADY_PAID" {
		t.Errorf("code=%q, want LOAN_INSTALLMENT_ALREADY_PAID", env.Error.Code)
	}
}

func TestLoanHandler_Pay_NumberInvalido400(t *testing.T) {
	h := newLoanHandlerWithStub(&stubLoanRepo{})
	body := `{"amount":110,"paymentSource":"EFECTIVO"}`
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/installments/0/pay", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}, {Key: "number", Value: "0"}}
	c.Set("userDni", "ADMIN-1")
	h.Pay(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("number=0 debe devolver 400, got %d", rec.Code)
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INVALID_INPUT" {
		t.Errorf("code=%q, want LOAN_INVALID_INPUT", env.Error.Code)
	}
}

func TestLoanHandler_Pay_InstallmentNotFound404(t *testing.T) {
	repo := &stubLoanRepo{payErr: ports.ErrInstallmentNotFound}
	h := newLoanHandlerWithStub(repo)
	body := `{"amount":110,"paymentSource":"EFECTIVO"}`
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/installments/99/pay", body)
	c.Params = gin.Params{{Key: "id", Value: "10"}, {Key: "number", Value: "99"}}
	c.Set("userDni", "ADMIN-1")
	h.Pay(c)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("not found: got %d", rec.Code)
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_INSTALLMENT_NOT_FOUND" {
		t.Errorf("code=%q, want LOAN_INSTALLMENT_NOT_FOUND", env.Error.Code)
	}
}

// --- RegisterExpense --------------------------------------------------------

func TestLoanHandler_RegisterExpense_PrincipalExceeded(t *testing.T) {
	repo := &stubLoanRepo{expenseErr: ports.ErrPrincipalExceeded}
	h := newLoanHandlerWithStub(repo)
	c, rec := newLoanTestContext(http.MethodPost, "/api/loans/10/expenses", `{"amountUsed":100}`)
	c.Params = gin.Params{{Key: "id", Value: "10"}}
	c.Set("userDni", "ADMIN-1")
	h.RegisterExpense(c)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("overspend: got %d (body=%s)", rec.Code, rec.Body.String())
	}
	env := readAPIError(t, rec.Body.Bytes())
	if env.Error.Code != "LOAN_PRINCIPAL_EXCEEDED" {
		t.Errorf("code=%q, want LOAN_PRINCIPAL_EXCEEDED", env.Error.Code)
	}
}

// --- mapServiceError --------------------------------------------------------

func TestLoanHandler_MapServiceError_SentinelsClaros(t *testing.T) {
	cases := []struct {
		err       error
		wantCode  int
		wantCode2 string
	}{
		{ports.ErrLoanNotFound, http.StatusNotFound, "LOAN_NOT_FOUND"},
		{ports.ErrInstallmentNotFound, http.StatusNotFound, "LOAN_INSTALLMENT_NOT_FOUND"},
		{ports.ErrInstallmentAlreadyPaid, http.StatusConflict, "LOAN_INSTALLMENT_ALREADY_PAID"},
		{ports.ErrPrincipalExceeded, http.StatusBadRequest, "LOAN_PRINCIPAL_EXCEEDED"},
		{ports.ErrLoanHasPaidInstallments, http.StatusConflict, "LOAN_HAS_PAID_INSTALLMENTS"},
		{ports.ErrLoanPrincipalBelowUsage, http.StatusBadRequest, "LOAN_PRINCIPAL_BELOW_USAGE"},
		{ports.ErrLoanStartDateAfterInstallments, http.StatusBadRequest, "LOAN_INVALID_INPUT"},
		{ports.ErrLoanMaturityBeforeStart, http.StatusBadRequest, "LOAN_INVALID_INPUT"},
		{services.ErrInvalidPrincipal, http.StatusBadRequest, "LOAN_INVALID_SCHEDULE"},
		{services.ErrInvalidTermCount, http.StatusBadRequest, "LOAN_INVALID_SCHEDULE"},
		{services.ErrInterestRequiresRate, http.StatusBadRequest, "LOAN_INVALID_SCHEDULE"},
		{services.ErrInvalidInterestMode, http.StatusBadRequest, "LOAN_INVALID_SCHEDULE"},
		{services.ErrNoneForbidsRate, http.StatusBadRequest, "LOAN_INVALID_SCHEDULE"},
		{services.ErrPrincipalOverflow, http.StatusBadRequest, "LOAN_INVALID_SCHEDULE"},
		{services.ErrInvalidChannel, http.StatusBadRequest, "LOAN_INVALID_INPUT"},
		{services.ErrBreakdownMismatch, http.StatusBadRequest, "LOAN_INVALID_INPUT"},
		{services.ErrStringTooLong, http.StatusBadRequest, "LOAN_INVALID_INPUT"},
		{errors.New("boom genérico"), http.StatusInternalServerError, "ERR_INTERNAL_ERROR"},
	}
	for _, tc := range cases {
		gin.SetMode(gin.TestMode)
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Request = httptest.NewRequest(http.MethodPost, "/x", nil)
		mapServiceError(c, tc.err)
		if rec.Code != tc.wantCode {
			t.Errorf("err=%v: status=%d, want %d (body=%s)", tc.err, rec.Code, tc.wantCode, rec.Body.String())
		}
		env := readAPIError(t, rec.Body.Bytes())
		if env.Error.Code != tc.wantCode2 {
			t.Errorf("err=%v: code=%q, want %q", tc.err, env.Error.Code, tc.wantCode2)
		}
		if env.Success {
			t.Errorf("err=%v: envelope debe tener success=false", tc.err)
		}
	}
}

// --- Rutas registradas en main.go ------------------------------------------

func TestLoanHandler_RutasRegistradasEnMain(t *testing.T) {
	root := filepath.Join("..", "..", "..", "cmd", "api", "main.go")
	bts, err := os.ReadFile(root)
	if err != nil {
		t.Skipf("No se pudo leer %s: %v", root, err)
	}
	src := string(bts)
	// Verifica rutas canónicas. En particular, la ruta de pago usa
	// `/:id/installments/:number/pay` (número lógico, no PK ni body).
	patterns := []string{
		`loans\.GET\("",\s*loanHandler\.List\)`,
		`loans\.GET\("/:id",\s*loanHandler\.GetByID\)`,
		`loans\.POST\("/preview",\s*loanHandler\.Preview\)`,
		`loansAdmin\.POST\("",\s*loanHandler\.Create\)`,
		`loansAdmin\.POST\("/:id/installments/:number/pay",\s*loanHandler\.Pay\)`,
		`loansAdmin\.POST\("/:id/expenses",\s*loanHandler\.RegisterExpense\)`,
		`loansAdmin\.DELETE\("/:id",\s*loanHandler\.Delete\)`,
	}
	for _, p := range patterns {
		if !regexp.MustCompile(p).MatchString(src) {
			t.Errorf("Falta la ruta que empata %q en main.go", p)
		}
	}
	// Rechazar la ruta vieja (anti-regresión): un POST sobre
	// `/:id/pay` sin `/installments/:number/` escaparía al contrato.
	if regexp.MustCompile(`loansAdmin\.POST\("/:id/pay"`).MatchString(src) {
		t.Error("la ruta vieja /:id/pay (sin installments/:number) ya no debe estar registrada")
	}
	// Y que loansAdmin esté montado con RoleMiddleware("admin").
	if !regexp.MustCompile(`loansAdmin\s*:=\s*loans\.Group\(.*\)[\s\S]+?loansAdmin\.Use\(middlewares\.RoleMiddleware\("admin"\)\)`).MatchString(src) {
		t.Error("loansAdmin debe aplicar RoleMiddleware(\"admin\") antes de registrar las mutaciones")
	}
}

// --- SendError no filtra texto técnico -------------------------------------

func TestLoanHandler_SendError_NoFiltraStackTraceSQL(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/x", nil)
	// Un error "técnico" con fingerprints de SQL/Postgres:
	raw := errors.New(`ERROR: duplicate key value violates unique constraint "idx_loans_pk" (SQLSTATE 23505) at /internal/foo.go:33`)
	mapServiceError(c, raw)
	env := readAPIError(t, rec.Body.Bytes())
	// El `details` NO debe contener la cadena cruda (que trae SQLSTATE,
	// /internal/ y nombre de constraint).
	low := strings.ToLower(env.Error.Details)
	for _, needle := range []string{"sqlstate", "/internal/", "duplicate key", "constraint"} {
		if strings.Contains(low, needle) {
			t.Errorf("APIError.Details filtró texto técnico %q: %q", needle, env.Error.Details)
		}
	}
}

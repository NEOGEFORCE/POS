// Handler HTTP del módulo avanzado de Préstamos.
//
// Rutas (todas protegidas por AuthMiddleware; mutaciones admin-only):
//
//	GET    /api/loans                                     list (empleado + admin)
//	GET    /api/loans/:id                                 detail (empleado + admin)
//	POST   /api/loans/preview                             preview cronograma (empleado + admin)
//	POST   /api/loans                                     create loan (admin)
//	POST   /api/loans/:id/installments/:number/pay        pagar cuota (admin)
//	POST   /api/loans/:id/expenses                        registrar uso del principal (admin)
//	DELETE /api/loans/:id                                 cancelar sin pagos (admin)
//
// El contrato de pago usa `number` (número lógico de cuota dentro del
// préstamo, 1..term_count), NO la PK autoincremental. El id de la cuota
// nunca viaja en el body: lo determina (loan_id, number).
//
// Contratos de respuesta estables para el frontend:
//
//   - { "preview": {...} }                                     en POST /preview
//   - { "loan": {...} }                                        en POST / y GET /:id
//   - { "loans": [...], "total": N }                           en GET /
//   - { "installment": {...}, "loanStatus": "...",
//     "remainingBalance": N, "expenseId": N,
//     "appliedAmount": N }                                   en POST /:id/installments/:number/pay
//   - { "loanExpense": {...}, "totalUsed": N }                 en POST /:id/expenses
//
// Códigos de error canónicos (APIError.code), consumidos por el frontend:
//
//   - LOAN_NOT_FOUND                 — 404 — el préstamo no existe.
//   - LOAN_INSTALLMENT_NOT_FOUND     — 404 — la cuota (loan_id, number) no existe.
//   - LOAN_INSTALLMENT_ALREADY_PAID  — 409 — idempotencia: la cuota ya estaba PAID.
//   - LOAN_PRINCIPAL_EXCEEDED        — 400 — SUM(amount_used) + nuevo > principal.
//   - LOAN_INVALID_SCHEDULE          — 400 — cronograma inválido (principal, plazo, tasa, modo, fecha).
//   - LOAN_INVALID_INPUT             — 400 — otros errores de validación (payload mal formado, canal, actor, breakdown).
//   - LOAN_HAS_PAYMENTS              — 409 — intento de cancelar un préstamo con pagos.
//
// Las respuestas de error salen por `SendError`, el envelope estándar
// del backend: NUNCA se propaga el texto crudo del driver de BD al cliente.
package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/core/services"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// Códigos de error del módulo (snake-screaming para el frontend).
const (
	loanErrNotFound               = "LOAN_NOT_FOUND"
	loanErrInstallmentNotFound    = "LOAN_INSTALLMENT_NOT_FOUND"
	loanErrInstallmentAlreadyPaid = "LOAN_INSTALLMENT_ALREADY_PAID"
	loanErrPrincipalExceeded      = "LOAN_PRINCIPAL_EXCEEDED"
	loanErrInvalidSchedule        = "LOAN_INVALID_SCHEDULE"
	loanErrInvalidInput           = "LOAN_INVALID_INPUT"
	loanErrHasPayments            = "LOAN_HAS_PAYMENTS"
	loanErrNotActive              = "LOAN_NOT_ACTIVE"
	loanErrExpenseNotFound        = "LOAN_EXPENSE_NOT_FOUND"
	loanErrExpenseNotPayable      = "LOAN_EXPENSE_NOT_PAYABLE"
	loanErrOrphanAmbiguous        = "LOAN_ORPHAN_DEBT_AMBIGUOUS"
	loanErrUsageNotOrphan         = "LOAN_USAGE_NOT_ORPHAN"
	loanErrHasPaidInstallments    = "LOAN_HAS_PAID_INSTALLMENTS"
	loanErrPrincipalBelowUsage    = "LOAN_PRINCIPAL_BELOW_USAGE"
)

// LoanHandler agrupa los endpoints del módulo.
type LoanHandler struct {
	service *services.LoanService
}

// NewLoanHandler construye el handler.
func NewLoanHandler(service *services.LoanService) *LoanHandler {
	return &LoanHandler{service: service}
}

// --- helpers ---------------------------------------------------------------

// loanActorDNI replica actorDNI de label_handler sin importarlo: evita
// acoplar módulos. Mantener el mismo contrato: prefiere "dni" o
// "userDni" en el contexto, cae al header X-Actor-DNI para pruebas.
func loanActorDNI(c *gin.Context) string {
	for _, key := range []string{"dni", "userDni"} {
		if v, exists := c.Get(key); exists {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
		}
	}
	return strings.TrimSpace(c.GetHeader("X-Actor-DNI"))
}

func loanActorName(c *gin.Context) string {
	if v, exists := c.Get("userName"); exists {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func parseLoanDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{"2006-01-02", time.RFC3339, "2006-01-02T15:04:05Z07:00"} {
		if t, err := time.ParseInLocation(layout, s, services.LoanBogotaLocation()); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// parseOptionalLoanDate valida una fecha opcional del PUT. Vacío significa
// limpiar/no informar (nil); una cadena no vacía con formato inválido es 400
// y nunca se ignora silenciosamente.
func parseOptionalLoanDate(c *gin.Context, field, raw string) (*time.Time, bool) {
	if strings.TrimSpace(raw) == "" {
		return nil, true
	}
	t, ok := parseLoanDate(raw)
	if !ok {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, field+" inválida", nil)
		return nil, false
	}
	return &t, true
}

// parseLoanIDParam devuelve el id del préstamo o emite 400 ya respondido.
func parseLoanIDParam(c *gin.Context) (uint, bool) {
	raw := strings.TrimSpace(c.Param("id"))
	if raw == "" {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "id requerido", nil)
		return 0, false
	}
	n, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || n == 0 {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "id inválido", nil)
		return 0, false
	}
	return uint(n), true
}

// parseInstallmentNumberParam valida el :number de la ruta
// `/loans/:id/installments/:number/pay`.
func parseInstallmentNumberParam(c *gin.Context) (int, bool) {
	raw := strings.TrimSpace(c.Param("number"))
	if raw == "" {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "número de cuota requerido", nil)
		return 0, false
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "número de cuota inválido", nil)
		return 0, false
	}
	return n, true
}

// mapServiceError convierte los sentinels del servicio y el repo en
// respuestas HTTP consistentes vía SendError. Mantener el switch
// centralizado facilita agregar un sentinel nuevo sin dispersar magic
// strings.
func mapServiceError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ports.ErrLoanNotFound):
		SendError(c, http.StatusNotFound, loanErrNotFound, "préstamo no encontrado", nil)
	case errors.Is(err, ports.ErrLoanNotActive):
		SendError(c, http.StatusConflict, loanErrNotActive, "el préstamo no está activo para nuevos usos", nil)
	case errors.Is(err, ports.ErrInstallmentNotFound):
		SendError(c, http.StatusNotFound, loanErrInstallmentNotFound, "cuota no encontrada", nil)
	case errors.Is(err, ports.ErrInstallmentAlreadyPaid):
		SendError(c, http.StatusConflict, loanErrInstallmentAlreadyPaid, "la cuota ya está pagada", nil)
	case errors.Is(err, ports.ErrPrincipalExceeded):
		SendError(c, http.StatusBadRequest, loanErrPrincipalExceeded, "el gasto excede el principal disponible del préstamo", err)
	case errors.Is(err, ports.ErrExpenseNotFound):
		SendError(c, http.StatusNotFound, loanErrExpenseNotFound, "egreso a abonar no encontrado", nil)
	case errors.Is(err, ports.ErrExpenseNotPayable):
		SendError(c, http.StatusConflict, loanErrExpenseNotPayable, "el egreso ya está completamente pagado", nil)
	case errors.Is(err, ports.ErrLoanHasPaidInstallments):
		SendError(c, http.StatusConflict, loanErrHasPaidInstallments, "no se puede recalcular el cronograma: el préstamo ya tiene cuotas pagadas", nil)
	case errors.Is(err, ports.ErrLoanPrincipalBelowUsage):
		SendError(c, http.StatusBadRequest, loanErrPrincipalBelowUsage, "el principal nuevo es menor que el uso activo del préstamo", err)
	case errors.Is(err, ports.ErrLoanStartDateAfterInstallments):
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "la nueva fecha de inicio es posterior a cuotas ya programadas", nil)
	case errors.Is(err, ports.ErrLoanMaturityBeforeStart):
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "la fecha de vencimiento no puede ser anterior a la fecha de inicio", nil)
	case errors.Is(err, services.ErrInvalidPrincipal),
		errors.Is(err, services.ErrInvalidTermCount),
		errors.Is(err, services.ErrInvalidInterestRate),
		errors.Is(err, services.ErrInterestRequiresRate),
		errors.Is(err, services.ErrInvalidInterestMode),
		errors.Is(err, services.ErrNoneForbidsRate),
		errors.Is(err, services.ErrInvalidPaymentFrequency),
		errors.Is(err, services.ErrFirstDueDateMissing),
		errors.Is(err, services.ErrPrincipalOverflow),
		errors.Is(err, services.ErrFrenchRequiresMonthly),
		errors.Is(err, services.ErrFrenchRequiresEARate),
		errors.Is(err, services.ErrInvalidMonthlyInsurance),
		errors.Is(err, services.ErrInvalidFgaTotal),
		errors.Is(err, services.ErrInsuranceOrFgaOnlyFrench):
		SendError(c, http.StatusBadRequest, loanErrInvalidSchedule, err.Error(), nil)
	case errors.Is(err, services.ErrInvalidChannel),
		errors.Is(err, services.ErrLenderRequired),
		errors.Is(err, services.ErrActorRequired),
		errors.Is(err, services.ErrStringTooLong),
		errors.Is(err, services.ErrBreakdownMismatch),
		errors.Is(err, services.ErrInvalidExpensePayment),
		errors.Is(err, services.ErrInvalidLoanType),
		errors.Is(err, services.ErrInvalidRateType),
		errors.Is(err, services.ErrInvalidCurrency),
		errors.Is(err, services.ErrInvalidBankSnapshot),
		errors.Is(err, services.ErrInvalidOfficialInstallment),
		errors.Is(err, services.ErrInvalidMoneyField),
		errors.Is(err, services.ErrMaturityBeforeStart),
		errors.Is(err, services.ErrScheduleFieldsRequireRecalc):
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, err.Error(), nil)
	default:
		SendError(c, http.StatusInternalServerError, ErrInternalServer, "error procesando la solicitud", err)
	}
}

// --- GET /api/loans --------------------------------------------------------

func (h *LoanHandler) List(c *gin.Context) {
	filter := ports.LoanListFilter{
		Status:     c.Query("status"),
		LenderName: c.Query("lenderName"),
		LenderDNI:  c.Query("lenderDni"),
	}
	if v := strings.TrimSpace(c.Query("supplierId")); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil && n > 0 {
			id := uint(n)
			filter.SupplierID = &id
		}
	}
	if v := strings.TrimSpace(c.Query("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			filter.Limit = n
		}
	}
	if v := strings.TrimSpace(c.Query("offset")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			filter.Offset = n
		}
	}
	loans, total, err := h.service.List(c.Request.Context(), filter)
	if err != nil {
		mapServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"loans": loans, "total": total})
}

// --- GET /api/loans/:id ----------------------------------------------------

func (h *LoanHandler) GetByID(c *gin.Context) {
	id, ok := parseLoanIDParam(c)
	if !ok {
		return
	}
	loan, err := h.service.GetByID(c.Request.Context(), id)
	if err != nil {
		mapServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"loan": loan})
}

// --- POST /api/loans/preview -----------------------------------------------

// createOrPreviewRequest es el body de preview y create. Se mantiene
// unificado para que el frontend use el mismo DTO al previsualizar y al
// confirmar.
//
// Campos específicos del modo FRENCH:
//
//   - monthlyInsurance — seguro MENSUAL fijo cobrado por la entidad; se
//     replica igual en cada cuota.
//   - fgaTotal         — FGA (Fondo de Garantías) TOTAL cobrado al
//     desembolso; el servicio lo DIFIERE entre todas las cuotas.
//
// Ambos son opcionales y, si el modo no es FRENCH, deben venir en 0 (o
// no venir): la validación del scheduler aborta con
// ErrInsuranceOrFgaOnlyFrench si NONE/SIMPLE llega con valores > 0.
type createOrPreviewRequest struct {
	LenderName          string  `json:"lenderName"`
	LenderDNI           string  `json:"lenderDni"`
	SupplierID          *uint   `json:"supplierId"`
	PrincipalAmount     float64 `json:"principalAmount"`
	InterestRatePct     float64 `json:"interestRatePct"`
	InterestMode        string  `json:"interestMode"`
	TermCount           int     `json:"termCount"`
	PaymentFrequency    string  `json:"paymentFrequency"`
	StartDate           string  `json:"startDate"`
	FirstPaymentDate    string  `json:"firstPaymentDate"`
	DisbursementChannel string  `json:"disbursementChannel"`
	Note                string  `json:"note"`
	// Extras FRENCH.
	//
	// AnnualEffectiveRatePct es el campo canónico de la tasa EA que envía
	// el frontend en FRENCH (con interestRatePct=0). Si viene > 0 en modo
	// FRENCH, manda sobre interestRatePct; si no, se usa interestRatePct
	// como fallback para clientes que envíen la EA por el campo legacy.
	AnnualEffectiveRatePct float64 `json:"annualEffectiveRatePct"`
	MonthlyInsurance       float64 `json:"monthlyInsurance"`
	FgaTotal               float64 `json:"fgaTotal"`
}

// effectiveRatePct resuelve la tasa que viaja al servicio según el modo.
func (req *createOrPreviewRequest) effectiveRatePct() float64 {
	if strings.EqualFold(strings.TrimSpace(req.InterestMode), models.InterestModeFrench) && req.AnnualEffectiveRatePct > 0 {
		return req.AnnualEffectiveRatePct
	}
	return req.InterestRatePct
}

func (req *createOrPreviewRequest) toServiceInput(actor string) services.CreateLoanInput {
	input := services.CreateLoanInput{
		LenderName:          req.LenderName,
		LenderDNI:           req.LenderDNI,
		SupplierID:          req.SupplierID,
		PrincipalAmount:     req.PrincipalAmount,
		InterestRatePct:     req.effectiveRatePct(),
		InterestMode:        req.InterestMode,
		TermCount:           req.TermCount,
		PaymentFrequency:    req.PaymentFrequency,
		DisbursementChannel: req.DisbursementChannel,
		Note:                req.Note,
		CreatedByDNI:        actor,
		MonthlyInsurance:    req.MonthlyInsurance,
		FgaTotal:            req.FgaTotal,
	}
	if t, ok := parseLoanDate(req.StartDate); ok {
		input.StartDate = t
	}
	if t, ok := parseLoanDate(req.FirstPaymentDate); ok {
		input.FirstPaymentDate = t
	}
	return input
}

func (h *LoanHandler) Preview(c *gin.Context) {
	var req createOrPreviewRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "payload inválido", nil)
		return
	}
	actor := loanActorDNI(c)
	if actor == "" {
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "sesión requerida", nil)
		return
	}
	preview, err := h.service.PreviewSchedule(req.toServiceInput(actor))
	if err != nil {
		mapServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"preview": preview})
}

// --- POST /api/loans -------------------------------------------------------

func (h *LoanHandler) Create(c *gin.Context) {
	var req createOrPreviewRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "payload inválido", nil)
		return
	}
	actor := loanActorDNI(c)
	if actor == "" {
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "sesión requerida", nil)
		return
	}
	loan, err := h.service.CreateLoan(c.Request.Context(), req.toServiceInput(actor))
	if err != nil {
		mapServiceError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"loan": loan})
}

// --- POST /api/loans/:id/installments/:number/pay --------------------------

// payRequest es el body del pago. `installmentId` NO existe aquí: el
// número lógico de cuota viaja en la URL, y el repo busca por
// (loan_id, number). La idempotencia la garantiza el lock pesimista del
// repo + el chequeo de estado PAID.
type payRequest struct {
	Amount          float64 `json:"amount"`
	PaymentSource   string  `json:"paymentSource"`
	Note            string  `json:"note"`
	CashAmount      float64 `json:"cashAmount"`
	NequiAmount     float64 `json:"nequiAmount"`
	DaviplataAmount float64 `json:"daviplataAmount"`
	FondoAmount     float64 `json:"fondoAmount"`
	CoinsAmount     float64 `json:"coinsAmount"`
	ClientTxID      string  `json:"clientTxId"`
}

func (h *LoanHandler) Pay(c *gin.Context) {
	id, ok := parseLoanIDParam(c)
	if !ok {
		return
	}
	number, ok := parseInstallmentNumberParam(c)
	if !ok {
		return
	}
	var req payRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "payload inválido", nil)
		return
	}
	actor := loanActorDNI(c)
	if actor == "" {
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "sesión requerida", nil)
		return
	}
	result, err := h.service.PayInstallment(c.Request.Context(), services.PayInstallmentServiceInput{
		LoanID:          id,
		Number:          number,
		Amount:          req.Amount,
		PaymentSource:   req.PaymentSource,
		Note:            req.Note,
		ActorDNI:        actor,
		ActorName:       loanActorName(c),
		ClientIP:        c.ClientIP(),
		DeviceUA:        c.Request.UserAgent(),
		CashAmount:      req.CashAmount,
		NequiAmount:     req.NequiAmount,
		DaviplataAmount: req.DaviplataAmount,
		FondoAmount:     req.FondoAmount,
		CoinsAmount:     req.CoinsAmount,
		ClientTxID:      req.ClientTxID,
	})
	if err != nil {
		mapServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"installment":      result.Installment,
		"loanStatus":       result.LoanStatus,
		"expenseId":        result.ExpenseID,
		"remainingBalance": result.RemainingBalance,
		"appliedAmount":    result.AppliedAmount,
	})
}

// --- POST /api/loans/:id/expenses -------------------------------------------

type registerExpenseRequest struct {
	ExpenseID  *uint   `json:"expenseId"`
	AmountUsed float64 `json:"amountUsed"`
	Purpose    string  `json:"purpose"`
}

func (h *LoanHandler) RegisterExpense(c *gin.Context) {
	id, ok := parseLoanIDParam(c)
	if !ok {
		return
	}
	var req registerExpenseRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "payload inválido", nil)
		return
	}
	actor := loanActorDNI(c)
	if actor == "" {
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "sesión requerida", nil)
		return
	}
	expense, totalUsed, err := h.service.RegisterLoanExpense(c.Request.Context(), services.RegisterLoanExpenseInput{
		LoanID:     id,
		ExpenseID:  req.ExpenseID,
		AmountUsed: req.AmountUsed,
		Purpose:    req.Purpose,
		ActorDNI:   actor,
		ActorName:  loanActorName(c),
		ClientIP:   c.ClientIP(),
		DeviceUA:   c.Request.UserAgent(),
	})
	if err != nil {
		mapServiceError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"loanExpense": expense, "totalUsed": totalUsed})
}

// --- POST /api/loans/:id/pay-expense ---------------------------------------

// payExpenseRequest es el body del endpoint "pagar un egreso con la plata
// del préstamo". Dos variantes:
//
//   - Con `expenseId`: abona/salda una deuda existente.
//   - Sin `expenseId`: crea un egreso nuevo pagado (requiere `description`).
//
// `supplierId` sólo aplica cuando se crea un egreso nuevo (si viene en el
// caso de abono se ignora: el supplier lo hereda la deuda original).
type payExpenseRequest struct {
	ExpenseID   *uint   `json:"expenseId"`
	Amount      float64 `json:"amount"`
	Description string  `json:"description"`
	Category    string  `json:"category"`
	SupplierID  *uint   `json:"supplierId"`
	Purpose     string  `json:"purpose"`
}

// PayExpense expone POST /api/loans/:id/pay-expense (admin-only).
//
// Respuesta 201 (contrato con el frontend):
//
//	{
//	  "expense":     { ...Expense creado... },
//	  "updatedDebt": { ...Expense deuda actualizada... }, // sólo si fue abono
//	  "loanExpense": { ...LoanExpense de bitácora... },
//	  "appliedAmount": N,
//	  "totalUsed":     N,
//	  "available":     N
//	}
//
// Errores:
//
//   - 400 LOAN_INVALID_INPUT      — payload mal formado, amount <= 0, strings
//     demasiado largos, description faltante
//     cuando no viene expenseId.
//   - 400 LOAN_PRINCIPAL_EXCEEDED — amount > principal - SUM(amount_used).
//   - 404 LOAN_NOT_FOUND          — el préstamo no existe o está soft-deleted.
//   - 404 LOAN_EXPENSE_NOT_FOUND  — el expenseId del body no existe.
//   - 409 LOAN_NOT_ACTIVE         — el préstamo no está en ACTIVE/DEFAULTED.
//   - 409 LOAN_EXPENSE_NOT_PAYABLE — el expenseId ya está completamente pagado.
//   - 401 ERR_UNAUTHORIZED        — sesión requerida.
//   - 500 ERR_INTERNAL_ERROR      — fallo inesperado (todo con texto de SQL
//     crudo se filtra en SendError).
func (h *LoanHandler) PayExpense(c *gin.Context) {
	id, ok := parseLoanIDParam(c)
	if !ok {
		return
	}
	var req payExpenseRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "payload inválido", nil)
		return
	}
	actor := loanActorDNI(c)
	if actor == "" {
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "sesión requerida", nil)
		return
	}
	result, err := h.service.PayExpenseWithLoan(c.Request.Context(), services.PayExpenseInput{
		LoanID:      id,
		ExpenseID:   req.ExpenseID,
		Amount:      req.Amount,
		Description: req.Description,
		Category:    req.Category,
		SupplierID:  req.SupplierID,
		Purpose:     req.Purpose,
		ActorDNI:    actor,
		ActorName:   loanActorName(c),
		ClientIP:    c.ClientIP(),
		DeviceUA:    c.Request.UserAgent(),
	})
	if err != nil {
		mapServiceError(c, err)
		return
	}
	resp := gin.H{
		"expense":       result.Expense,
		"loanExpense":   result.LoanExpense,
		"appliedAmount": result.AppliedAmount,
		"totalUsed":     result.TotalUsedAfter,
		"available":     result.Available,
	}
	if result.UpdatedDebt != nil {
		resp["updatedDebt"] = result.UpdatedDebt
	}
	c.JSON(http.StatusCreated, resp)
}

// ReverseOrphanedExpense repara un uso cuyo payment expense ya fue borrado
// antes de la migración 022. Sólo se registra bajo loansAdmin.
func (h *LoanHandler) ReverseOrphanedExpense(c *gin.Context) {
	loanID, ok := parseLoanIDParam(c)
	if !ok {
		return
	}
	usageRaw := strings.TrimSpace(c.Param("usageId"))
	usage64, err := strconv.ParseUint(usageRaw, 10, 32)
	if err != nil || usage64 == 0 {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "usageId inválido", nil)
		return
	}
	actor := loanActorDNI(c)
	if actor == "" {
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "sesión requerida", nil)
		return
	}
	out, err := h.service.ReverseOrphanedLoanExpense(c.Request.Context(), loanID, uint(usage64), actor, loanActorName(c), c.ClientIP(), c.Request.UserAgent())
	if err != nil {
		switch {
		case errors.Is(err, ports.ErrLoanNotFound):
			SendError(c, http.StatusNotFound, loanErrNotFound, "préstamo no encontrado", nil)
		case errors.Is(err, gorm.ErrRecordNotFound), errors.Is(err, ports.ErrLoanUsageNotOrphan):
			SendError(c, http.StatusConflict, loanErrUsageNotOrphan, "este uso no es un pago eliminado pendiente de reparar", nil)
		case errors.Is(err, ports.ErrLoanOrphanDebtAmbiguous):
			SendError(c, http.StatusConflict, loanErrOrphanAmbiguous, "no se encontró una única cuenta original; no se modificó nada", nil)
		default:
			SendError(c, http.StatusInternalServerError, ErrInternalServer, "no se pudo reparar el pago eliminado", err)
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"message": "Cuenta restaurada y principal liberado",
		"result":  out,
	})
}

// --- PUT /api/loans/:id ----------------------------------------------------

// updateLoanRequest es el body del endpoint de edición. Dos bloques:
//
//   - metadata: siempre editable (datos bancarios + snapshot + cuota oficial).
//   - schedule: sólo se aplica si recalculate=true. Si llegan campos
//     financieros sin recalculate, el servicio responde LOAN_INVALID_INPUT.
//
// Los campos nullable usan punteros para distinguir "no vino" (nil) de
// "vino en 0/vacío". Las fechas viajan como string ISO (parseLoanDate).
type updateLoanRequest struct {
	Metadata struct {
		LenderName          string  `json:"lenderName"`
		LenderDNI           string  `json:"lenderDni"`
		SupplierID          *uint   `json:"supplierId"`
		DisbursementChannel string  `json:"disbursementChannel"`
		Note                string  `json:"note"`
		CreditNumber        *string `json:"creditNumber"`
		LoanType            string  `json:"loanType"`
		HolderName          *string `json:"holderName"`
		HolderDNI           *string `json:"holderDni"`
		Currency            string  `json:"currency"`
		RateType            string  `json:"rateType"`
		AutoDebit           bool    `json:"autoDebit"`
		StartDate           string  `json:"startDate"`
		MaturityDate        string  `json:"maturityDate"`

		LateAnnualEffectiveRatePct float64  `json:"lateAnnualEffectiveRatePct"`
		NetDisbursementAmount      *float64 `json:"netDisbursementAmount"`
		FgaIvaAmount               float64  `json:"fgaIvaAmount"`
		FgaGmfAmount               float64  `json:"fgaGmfAmount"`

		BankBalanceAmount             *float64 `json:"bankBalanceAmount"`
		BankBalanceAsOf               string   `json:"bankBalanceAsOf"`
		BankPaidAmount                *float64 `json:"bankPaidAmount"`
		OfficialNextInstallmentAmount *float64 `json:"officialNextInstallmentAmount"`
		OfficialNextInstallmentDate   string   `json:"officialNextInstallmentDate"`
	} `json:"metadata"`

	Schedule *struct {
		Recalculate            bool    `json:"recalculate"`
		PrincipalAmount        float64 `json:"principalAmount"`
		InterestRatePct        float64 `json:"interestRatePct"`
		AnnualEffectiveRatePct float64 `json:"annualEffectiveRatePct"`
		InterestMode           string  `json:"interestMode"`
		TermCount              int     `json:"termCount"`
		PaymentFrequency       string  `json:"paymentFrequency"`
		FirstPaymentDate       string  `json:"firstPaymentDate"`
		MonthlyInsurance       float64 `json:"monthlyInsurance"`
		FgaTotal               float64 `json:"fgaTotal"`
	} `json:"schedule"`
}

// scheduleEffectiveRate resuelve la tasa que viaja al servicio en recálculo
// (igual que createOrPreviewRequest.effectiveRatePct).
func (req *updateLoanRequest) scheduleEffectiveRate() float64 {
	if req.Schedule == nil {
		return 0
	}
	if strings.EqualFold(strings.TrimSpace(req.Schedule.InterestMode), models.InterestModeFrench) && req.Schedule.AnnualEffectiveRatePct > 0 {
		return req.Schedule.AnnualEffectiveRatePct
	}
	return req.Schedule.InterestRatePct
}

// Update expone PUT /api/loans/:id (admin-only).
//
// Respuesta 200: { "loan": LoanRecord } (mismo envelope que GET /:id).
//
// Errores:
//   - 400 LOAN_INVALID_INPUT         — payload mal formado, metadata inválida,
//     campos financieros sin recalculate.
//   - 400 LOAN_INVALID_SCHEDULE      — cronograma inválido al recalcular.
//   - 400 LOAN_PRINCIPAL_BELOW_USAGE — principal nuevo < uso activo.
//   - 404 LOAN_NOT_FOUND             — el préstamo no existe/soft-deleted.
//   - 409 LOAN_HAS_PAID_INSTALLMENTS — recalcular con cuotas pagadas.
//   - 401 ERR_UNAUTHORIZED           — sesión requerida.
func (h *LoanHandler) Update(c *gin.Context) {
	id, ok := parseLoanIDParam(c)
	if !ok {
		return
	}
	var req updateLoanRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		SendError(c, http.StatusBadRequest, loanErrInvalidInput, "payload inválido", nil)
		return
	}
	actor := loanActorDNI(c)
	if actor == "" {
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "sesión requerida", nil)
		return
	}

	in := services.UpdateLoanInput{
		LoanID:                        id,
		LenderName:                    req.Metadata.LenderName,
		LenderDNI:                     req.Metadata.LenderDNI,
		SupplierID:                    req.Metadata.SupplierID,
		DisbursementChannel:           req.Metadata.DisbursementChannel,
		Note:                          req.Metadata.Note,
		CreditNumber:                  req.Metadata.CreditNumber,
		LoanType:                      req.Metadata.LoanType,
		HolderName:                    req.Metadata.HolderName,
		HolderDNI:                     req.Metadata.HolderDNI,
		Currency:                      req.Metadata.Currency,
		RateType:                      req.Metadata.RateType,
		AutoDebit:                     req.Metadata.AutoDebit,
		LateAnnualEffectiveRatePct:    req.Metadata.LateAnnualEffectiveRatePct,
		NetDisbursementAmount:         req.Metadata.NetDisbursementAmount,
		FgaIvaAmount:                  req.Metadata.FgaIvaAmount,
		FgaGmfAmount:                  req.Metadata.FgaGmfAmount,
		BankBalanceAmount:             req.Metadata.BankBalanceAmount,
		BankPaidAmount:                req.Metadata.BankPaidAmount,
		OfficialNextInstallmentAmount: req.Metadata.OfficialNextInstallmentAmount,
		ActorDNI:                      actor,
		ActorName:                     loanActorName(c),
		ClientIP:                      c.ClientIP(),
		DeviceUA:                      c.Request.UserAgent(),
	}

	// Fechas opcionales de la metadata. Una cadena inválida se rechaza;
	// cadena vacía representa nil/limpieza del dato.
	var datesOK bool
	in.StartDate, datesOK = parseOptionalLoanDate(c, "startDate", req.Metadata.StartDate)
	if !datesOK {
		return
	}
	in.MaturityDate, datesOK = parseOptionalLoanDate(c, "maturityDate", req.Metadata.MaturityDate)
	if !datesOK {
		return
	}
	in.BankBalanceAsOf, datesOK = parseOptionalLoanDate(c, "bankBalanceAsOf", req.Metadata.BankBalanceAsOf)
	if !datesOK {
		return
	}
	in.OfficialNextInstallmentDate, datesOK = parseOptionalLoanDate(c, "officialNextInstallmentDate", req.Metadata.OfficialNextInstallmentDate)
	if !datesOK {
		return
	}

	// Bloque de cronograma (opcional).
	if req.Schedule != nil {
		in.Recalculate = req.Schedule.Recalculate
		// Marcar que llegaron campos financieros: cualquier valor no-cero
		// en los campos del cronograma activa el flag para que el servicio
		// rechace su edición sin recalculate.
		if req.Schedule.PrincipalAmount != 0 || req.Schedule.TermCount != 0 ||
			req.Schedule.InterestRatePct != 0 || req.Schedule.AnnualEffectiveRatePct != 0 ||
			strings.TrimSpace(req.Schedule.InterestMode) != "" ||
			strings.TrimSpace(req.Schedule.PaymentFrequency) != "" ||
			strings.TrimSpace(req.Schedule.FirstPaymentDate) != "" ||
			req.Schedule.MonthlyInsurance != 0 || req.Schedule.FgaTotal != 0 {
			in.HasScheduleFields = true
		}
		in.PrincipalAmount = req.Schedule.PrincipalAmount
		in.InterestRatePct = req.scheduleEffectiveRate()
		in.InterestMode = req.Schedule.InterestMode
		in.TermCount = req.Schedule.TermCount
		in.PaymentFrequency = req.Schedule.PaymentFrequency
		in.MonthlyInsurance = req.Schedule.MonthlyInsurance
		in.FgaTotal = req.Schedule.FgaTotal
		if strings.TrimSpace(req.Schedule.FirstPaymentDate) != "" {
			firstPayment, ok := parseLoanDate(req.Schedule.FirstPaymentDate)
			if !ok {
				SendError(c, http.StatusBadRequest, loanErrInvalidInput, "firstPaymentDate inválida", nil)
				return
			}
			in.FirstPaymentDate = firstPayment
		}
	}

	loan, err := h.service.UpdateLoan(c.Request.Context(), in)
	if err != nil {
		mapServiceError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"loan": loan})
}

// --- DELETE /api/loans/:id -------------------------------------------------

// Delete cancela el préstamo lógicamente. 409 si tiene pagos.
func (h *LoanHandler) Delete(c *gin.Context) {
	id, ok := parseLoanIDParam(c)
	if !ok {
		return
	}
	actor := loanActorDNI(c)
	if actor == "" {
		SendError(c, http.StatusUnauthorized, ErrUnauthorized, "sesión requerida", nil)
		return
	}
	if err := h.service.SoftDeleteLoan(c.Request.Context(), id, actor, loanActorName(c), c.ClientIP(), c.Request.UserAgent()); err != nil {
		switch {
		case errors.Is(err, ports.ErrLoanNotFound):
			SendError(c, http.StatusNotFound, loanErrNotFound, "préstamo no encontrado", nil)
		default:
			// "no se puede cancelar un préstamo con pagos" lo tratamos
			// como 409 Conflict: la cuota ya tuvo movimiento de dinero.
			if strings.Contains(err.Error(), "no se puede cancelar") {
				SendError(c, http.StatusConflict, loanErrHasPayments, err.Error(), nil)
				return
			}
			SendError(c, http.StatusInternalServerError, ErrInternalServer, "error procesando la solicitud", err)
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id, "status": models.LoanStatusCancelled})
}

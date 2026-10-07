// Package services — orquestación transaccional del módulo de Préstamos.
//
// Decisiones clave:
//
//   - La aritmética fina (centavos, cronograma) vive en loan_schedule.go,
//     que es puro. Este archivo coordina el repositorio y aplica reglas
//     de negocio (idempotencia, validación cruzada, auditoría).
//
//   - El PAGO DE CUOTA (POST /loans/:id/installments/:number/pay) NUNCA
//     emite un Expense con paymentSource='PRESTAMO': el pago de la cuota
//     se registra con el canal real de la tienda (EFECTIVO|NEQUI|…) y la
//     cuota lo apunta vía settlement_expense_id. Ese Expense lo persiste
//     el REPO dentro de la MISMA transacción que la actualización de la
//     cuota y el loan; nunca por fuera. Así, si algo falla, no queda
//     Expense huérfano.
//
//   - EN CAMBIO, el PAGO CON PRÉSTAMO (POST /loans/:id/pay-expense) sí
//     emite un Expense con paymentSource='PRESTAMO' DELIBERADAMENTE
//     (`PayExpenseWithLoan`). Ese egreso NO sale de ningún canal de la
//     tienda: Cash/Nequi/Daviplata/Fondo/Coins quedan en 0 y no suma en
//     ningún arqueo. Por eso NO descuadra la caja: el egreso real contra
//     caja ocurre más tarde cuando se paga la cuota. El filtro
//     `models.IsLoanFundedExpense` + `isOperationalExpense` lo mantienen
//     fuera de ComputeClosureMetrics, ComputeShiftExpenseTotals, los
//     KPIs del dashboard, el PDF y Telegram.
//
//   - CreateLoan calcula el cronograma, llena `TotalPayable` y
//     `RemainingBalance` con `preview.TotalPayable` y persiste en una
//     sola transacción (repo-side). Si falla la inserción, no queda
//     cuota ni préstamo huérfano.
//
//   - PayInstallment delega al repo que toma los locks necesarios y
//     recalcula el status del préstamo. La idempotencia del pago cae
//     sobre el repo: la cuota ya PAID devuelve ErrInstallmentAlreadyPaid
//     SIN crear expense.
//
//   - RegisterLoanExpense valida la invariante SUM(amount_used) <=
//     principal_amount dentro de una transacción con SELECT FOR UPDATE
//     sobre el préstamo (lo hace el repo).
package services

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/sse"
)

// AllowedDisbursementChannels fija el repertorio aceptado por el handler.
// Debe coincidir con los canales reales de la tienda (expenses.paymentSource).
// NO incluye "PRESTAMO" ni "PREST." para evitar bucles conceptuales: un
// préstamo no se "paga con otro préstamo".
var AllowedDisbursementChannels = map[string]bool{
	"EFECTIVO":  true,
	"NEQUI":     true,
	"DAVIPLATA": true,
	"FONDO":     true,
	"BANCO":     true,
	"MONEDAS":   true,
}

// Límites de tamaño para strings libres. Mantienen el input manejable y
// evitan payloads abusivos.
const (
	maxLenderNameLen = 120
	maxNoteLen       = 2000
	maxPurposeLen    = 255
	maxDescLen       = 255
	maxDNILen        = 32
	maxChannelLen    = 32

	// Límites de la metadata bancaria editable (migración 023). Coinciden
	// con los VARCHAR del esquema para que la validación del servicio
	// rechace antes de que el CHECK/longitud de la BD lo haga.
	maxCreditNumberLen = 64
	maxHolderNameLen   = 160
	maxCurrencyLen     = 8
)

// AllowedLoanTypes es el repertorio cerrado de tipos de crédito (CHECK
// ck_loans_loan_type en 023). "VEHICULO" sin tilde a propósito (ASCII).
var AllowedLoanTypes = map[string]bool{
	"CONSUMO":     true,
	"HIPOTECARIO": true,
	"LIBRANZA":    true,
	"COMERCIAL":   true,
	"VEHICULO":    true,
	"OTRO":        true,
}

// AllowedRateTypes — FIJO o VARIABLE (CHECK ck_loans_rate_type).
var AllowedRateTypes = map[string]bool{
	"FIJO":     true,
	"VARIABLE": true,
}

// AllowedCurrencies — COP o USD (CHECK ck_loans_currency_known).
var AllowedCurrencies = map[string]bool{
	"COP": true,
	"USD": true,
}

// LoanService agrupa la lógica de negocio del módulo.
type LoanService struct {
	repo         ports.LoanRepository
	expenseRepo  ports.ExpenseRepository
	auditService *AuditService
}

// NewLoanService inyecta las dependencias necesarias.
// `expenseRepo` queda como dependencia explícita por simetría con el
// resto del backend aunque este servicio NO lo invoque directamente: el
// Expense del pago lo crea el repo del loan dentro de la transacción
// atómica para garantizar que no quede huérfano.
func NewLoanService(repo ports.LoanRepository, expenseRepo ports.ExpenseRepository, auditService *AuditService) *LoanService {
	return &LoanService{
		repo:         repo,
		expenseRepo:  expenseRepo,
		auditService: auditService,
	}
}

// CreateLoanInput describe los parámetros validables que llegan del handler.
// Se mantiene separado de models.Loan para que el servicio sea el único
// punto que traduce request→modelo.
type CreateLoanInput struct {
	LenderName          string
	LenderDNI           string
	SupplierID          *uint
	PrincipalAmount     float64
	InterestRatePct     float64
	InterestMode        string
	TermCount           int
	PaymentFrequency    string
	StartDate           time.Time // opcional; default: hoy en Bogotá
	FirstPaymentDate    time.Time // opcional; default: NextMonthlyDue(hoy)
	DisbursementChannel string
	Note                string
	CreatedByDNI        string

	// Extras del modo FRENCH. En NONE/SIMPLE deben venir en 0 (si no, la
	// validación del scheduler aborta con ErrInsuranceOrFgaOnlyFrench).
	MonthlyInsurance float64
	FgaTotal         float64
}

// PreviewSchedule construye el cronograma SIN persistir. El handler lo
// expone en POST /loans/preview para que la UI pinte las cuotas antes
// de confirmar.
//
// Garantías: aplica los mismos defaults que CreateLoan (StartDate=hoy,
// FirstPaymentDate=NextMonthlyDue(StartDate)) para que el preview empate
// con el cronograma final.
func (s *LoanService) PreviewSchedule(input CreateLoanInput) (LoanSchedulePreview, error) {
	req, err := s.toScheduleRequest(input)
	if err != nil {
		return LoanSchedulePreview{}, err
	}
	return BuildLoanSchedule(req)
}

// toScheduleRequest aplica defaults, normaliza modo/freq y pasa a la
// forma pura. Un único lugar donde se decide la fecha por defecto evita
// que preview y create diverjan.
func (s *LoanService) toScheduleRequest(input CreateLoanInput) (LoanScheduleRequest, error) {
	start := input.StartDate
	if start.IsZero() {
		start = time.Now().In(bogotaLocation)
	}
	first := input.FirstPaymentDate
	if first.IsZero() {
		first = NextMonthlyDue(start)
	}
	mode := strings.ToUpper(strings.TrimSpace(input.InterestMode))
	if mode == "" {
		mode = models.InterestModeSimple
	}
	freq := strings.ToUpper(strings.TrimSpace(input.PaymentFrequency))
	if freq == "" {
		freq = models.PaymentFrequencyMonthly
	}
	// FRENCH exige frecuencia MONTHLY: si el handler envía otra cosa (o
	// la UI heredada no actualiza el campo tras cambiar el modo), la
	// forzamos aquí para que el cronograma sea coherente con la cuota
	// francesa y con la columna base_installment_amount.
	if mode == models.InterestModeFrench {
		freq = models.PaymentFrequencyMonthly
	}
	req := LoanScheduleRequest{
		PrincipalAmount:  input.PrincipalAmount,
		InterestRatePct:  input.InterestRatePct,
		InterestMode:     mode,
		TermCount:        input.TermCount,
		PaymentFrequency: freq,
		FirstPaymentDate: first,
		MonthlyInsurance: input.MonthlyInsurance,
		FgaTotal:         input.FgaTotal,
	}
	if err := ValidateLoanScheduleRequest(req); err != nil {
		return LoanScheduleRequest{}, err
	}
	if first.Before(start) {
		return LoanScheduleRequest{}, fmt.Errorf("firstPaymentDate (%s) no puede ser anterior a startDate (%s)",
			first.Format("2006-01-02"), start.Format("2006-01-02"))
	}
	return req, nil
}

// ErrInvalidChannel se devuelve si el canal de desembolso no está en
// AllowedDisbursementChannels.
var ErrInvalidChannel = errors.New("canal de desembolso inválido")

// ErrLenderRequired se devuelve si falta el nombre del acreedor.
var ErrLenderRequired = errors.New("lenderName requerido")

// ErrActorRequired si falta el DNI de quien lo crea (middleware auth
// garantiza que llegue, pero por si acaso).
var ErrActorRequired = errors.New("createdByDni requerido")

// ErrStringTooLong señala un string excedido en tamaño.
var ErrStringTooLong = errors.New("campo de texto demasiado largo")

// ErrInvalidExpensePayment agrupa validaciones del endpoint
// POST /loans/:id/pay-expense para que el handler responda 400 y nunca 500
// ante amount inválido, expenseId=0 o descripción faltante.
var ErrInvalidExpensePayment = errors.New("pago de egreso con préstamo inválido")

// ErrBreakdownMismatch señala que el desglose por canal no suma el
// amount del pago.
var ErrBreakdownMismatch = errors.New("el desglose por canal no suma el monto del pago")

// CreateLoan valida inputs, construye el cronograma y persiste todo en
// una transacción. Devuelve el préstamo con las cuotas cargadas.
//
// AUDITORÍA: módulo FINANCES, acción CREATE_LOAN. isCritical=true.
// SSE: BroadcastDashboardUpdate (afecta "Cuentas por Pagar"). Cache:
// InvalidateDashboard.
func (s *LoanService) CreateLoan(ctx context.Context, input CreateLoanInput) (*models.Loan, error) {
	if err := validateStringLen("lenderName", input.LenderName, maxLenderNameLen); err != nil {
		return nil, err
	}
	if err := validateStringLen("lenderDni", input.LenderDNI, maxDNILen); err != nil {
		return nil, err
	}
	if err := validateStringLen("note", input.Note, maxNoteLen); err != nil {
		return nil, err
	}
	if err := validateStringLen("disbursementChannel", input.DisbursementChannel, maxChannelLen); err != nil {
		return nil, err
	}
	if err := validateStringLen("createdByDni", input.CreatedByDNI, maxDNILen); err != nil {
		return nil, err
	}
	if strings.TrimSpace(input.LenderName) == "" {
		return nil, ErrLenderRequired
	}
	if strings.TrimSpace(input.CreatedByDNI) == "" {
		return nil, ErrActorRequired
	}
	channel := strings.ToUpper(strings.TrimSpace(input.DisbursementChannel))
	if channel == "" {
		channel = "EFECTIVO"
	}
	if !AllowedDisbursementChannels[channel] {
		return nil, fmt.Errorf("%w: %s", ErrInvalidChannel, channel)
	}

	req, err := s.toScheduleRequest(input)
	if err != nil {
		return nil, err
	}
	preview, err := BuildLoanSchedule(req)
	if err != nil {
		return nil, err
	}

	start := input.StartDate
	if start.IsZero() {
		start = time.Now().In(bogotaLocation)
	}
	// Normalizar start a 00:00 Bogotá para que DATE no derive al día siguiente
	// por el convertido UTC.
	start = time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, bogotaLocation)
	first := req.FirstPaymentDate

	loan := &models.Loan{
		LenderName:          strings.TrimSpace(input.LenderName),
		LenderDNI:           strings.TrimSpace(input.LenderDNI),
		SupplierID:          input.SupplierID,
		PrincipalAmount:     Round2(input.PrincipalAmount),
		InterestMode:        req.InterestMode,
		TermCount:           req.TermCount,
		PaymentFrequency:    req.PaymentFrequency,
		StartDate:           start,
		FirstPaymentDate:    first,
		DisbursementChannel: channel,
		Status:              models.LoanStatusActive,
		TotalPayable:        preview.TotalPayable,
		RemainingBalance:    preview.TotalPayable,
		Note:                strings.TrimSpace(input.Note),
		CreatedByDNI:        strings.ToUpper(strings.TrimSpace(input.CreatedByDNI)),
	}
	// La tasa del request es el mismo campo para SIMPLE (flat total) y
	// FRENCH (EA porcentual), pero la BD las guarda en columnas distintas
	// para no perder la semántica histórica. Para FRENCH además se
	// persisten los extras y la cuota base calculados por el scheduler.
	if req.InterestMode == models.InterestModeFrench {
		loan.AnnualEffectiveRatePct = input.InterestRatePct
		loan.InterestRatePct = 0
		loan.MonthlyInsuranceAmount = Round2(input.MonthlyInsurance)
		loan.FgaTotalAmount = Round2(input.FgaTotal)
		loan.MonthlyFgaAmount = Round2(preview.MonthlyFga)
		loan.BaseInstallmentAmount = Round2(preview.InstallmentBase)
	} else {
		loan.InterestRatePct = input.InterestRatePct
		loan.AnnualEffectiveRatePct = 0
		loan.MonthlyInsuranceAmount = 0
		loan.FgaTotalAmount = 0
		loan.MonthlyFgaAmount = 0
		loan.BaseInstallmentAmount = 0
	}

	if err := s.repo.CreateLoanWithSchedule(ctx, loan, preview.Installments); err != nil {
		return nil, fmt.Errorf("persistiendo préstamo: %w", err)
	}

	// Carga completa para devolver cuotas al cliente (una query extra, barata).
	full, err := s.repo.GetByIDWithRelations(ctx, loan.ID)
	if err != nil {
		// El préstamo quedó bien, no podemos deshacer; devolvemos el
		// loan sin cuotas y dejamos el error subyacente perdido en el log.
		return loan, nil
	}

	// Auditoría + sincronización global.
	if s.auditService != nil {
		rateLabel := fmt.Sprintf("%.3f%%", loan.InterestRatePct)
		if loan.InterestMode == models.InterestModeFrench {
			rateLabel = fmt.Sprintf("%.3f%% EA", loan.AnnualEffectiveRatePct)
		}
		s.auditService.Log(
			loan.CreatedByDNI, "", "CREATE_LOAN", "FINANCES",
			fmt.Sprintf("Préstamo #%d (%s): $%s @ %s × %d cuotas, total $%s",
				loan.ID, loan.LenderName, formatMoney(loan.PrincipalAmount), rateLabel, loan.TermCount, formatMoney(loan.TotalPayable)),
			fmt.Sprintf("Se registró un préstamo con %s por $%s en %d cuotas (total a pagar $%s)",
				loan.LenderName, formatMoney(loan.PrincipalAmount), loan.TermCount, formatMoney(loan.TotalPayable)),
			"", "", "", true,
		)
	}
	cache.InvalidateDashboard()
	sse.GetSSEService().BroadcastDashboardUpdate()
	return full, nil
}

// GetByID devuelve el préstamo con cuotas y expenses.
func (s *LoanService) GetByID(ctx context.Context, id uint) (*models.Loan, error) {
	return s.repo.GetByIDWithRelations(ctx, id)
}

// List devuelve el dashboard enriquecido (saldo vivo, próxima cuota,
// total usado del principal). El handler le pega directo.
func (s *LoanService) List(ctx context.Context, filter ports.LoanListFilter) ([]ports.LoanWithStatsRow, int64, error) {
	if filter.Limit <= 0 || filter.Limit > 500 {
		filter.Limit = 100
	}
	if filter.Offset < 0 {
		filter.Offset = 0
	}
	return s.repo.ListWithStats(ctx, filter)
}

// PayInstallmentServiceInput describe un pago de cuota desde el handler.
// `Number` es el número lógico de la cuota (1..term_count) tomado de la
// ruta `/loans/:id/installments/:number/pay`.
type PayInstallmentServiceInput struct {
	LoanID          uint
	Number          int
	Amount          float64
	PaymentSource   string
	Note            string
	ActorDNI        string
	ActorName       string
	ClientIP        string
	DeviceUA        string
	CashAmount      float64
	NequiAmount     float64
	DaviplataAmount float64
	FondoAmount     float64
	CoinsAmount     float64
	ClientTxID      string
}

// PayInstallmentResult describe lo que devuelve PayInstallment al handler.
type PayInstallmentResult struct {
	Installment      *models.LoanInstallment `json:"installment"`
	ExpenseID        uint                    `json:"expenseId"`
	LoanStatus       string                  `json:"loanStatus"`
	RemainingBalance float64                 `json:"remainingBalance"`
	AppliedAmount    float64                 `json:"appliedAmount"`
}

// PayInstallment registra el pago de una cuota de forma atómica:
//
//  1. El repo abre una transacción, bloquea el loan y la cuota por
//     (loan_id, number), crea el Expense con el canal real, actualiza
//     la cuota, actualiza loans.remaining_balance y loans.status, y
//     commitea TODO en una sola transacción.
//
//  2. Idempotencia: si la cuota ya está PAID, el repo devuelve
//     ErrInstallmentAlreadyPaid SIN crear expense. El handler lo mapea
//     a 409 con código `LOAN_INSTALLMENT_ALREADY_PAID`.
//
//  3. Contrato: el pago debe cubrir EXACTAMENTE el saldo pendiente de la
//     cuota (tolerancia 1 centavo). No se admiten abonos parciales en el
//     contrato actual.
func (s *LoanService) PayInstallment(ctx context.Context, in PayInstallmentServiceInput) (*PayInstallmentResult, error) {
	if in.LoanID == 0 {
		return nil, errors.New("loanId requerido")
	}
	if in.Number <= 0 {
		return nil, errors.New("número de cuota inválido (>=1)")
	}
	if math.IsNaN(in.Amount) || math.IsInf(in.Amount, 0) {
		return nil, errors.New("amount no es un número finito")
	}
	amount := Round2(in.Amount)
	if amount <= 0 {
		return nil, errors.New("el monto del pago debe ser mayor a cero")
	}
	if !isFiniteMoney(amount) {
		return nil, errors.New("amount excede el rango permitido")
	}
	channel := strings.ToUpper(strings.TrimSpace(in.PaymentSource))
	if channel == "" {
		channel = "EFECTIVO"
	}
	if err := validateStringLen("paymentSource", channel, maxChannelLen); err != nil {
		return nil, err
	}
	if !AllowedDisbursementChannels[channel] {
		return nil, fmt.Errorf("%w: %s", ErrInvalidChannel, channel)
	}
	actor := strings.ToUpper(strings.TrimSpace(in.ActorDNI))
	if actor == "" {
		return nil, ErrActorRequired
	}
	if err := validateStringLen("actorDni", actor, maxDNILen); err != nil {
		return nil, err
	}
	if err := validateStringLen("note", in.Note, maxNoteLen); err != nil {
		return nil, err
	}
	if err := validateStringLen("clientTxId", in.ClientTxID, 64); err != nil {
		return nil, err
	}

	// Normalizar/validar breakdown.
	cash := Round2(in.CashAmount)
	nequi := Round2(in.NequiAmount)
	davi := Round2(in.DaviplataAmount)
	fondo := Round2(in.FondoAmount)
	coins := Round2(in.CoinsAmount)
	for _, v := range []float64{cash, nequi, davi, fondo, coins} {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || !isFiniteMoney(v) {
			return nil, errors.New("desglose por canal inválido (negativo, NaN o fuera de rango)")
		}
	}
	breakdownTotal := Round2(cash + nequi + davi + fondo + coins)
	if breakdownTotal == 0 {
		// Sin desglose explícito: lo asignamos al canal primario.
		switch channel {
		case "EFECTIVO":
			cash = amount
		case "NEQUI":
			nequi = amount
		case "DAVIPLATA":
			davi = amount
		case "FONDO", "BANCO":
			fondo = amount
		case "MONEDAS":
			coins = amount
		}
		breakdownTotal = amount
	}
	// Breakdown debe sumar amount con tolerancia 1 centavo.
	if math.Abs(breakdownTotal-amount) > 0.01 {
		return nil, fmt.Errorf("%w: desglose %.2f ≠ monto %.2f", ErrBreakdownMismatch, breakdownTotal, amount)
	}

	// Resolver nombre del acreedor para la descripción del Expense.
	loan, err := s.repo.GetByID(ctx, in.LoanID)
	if err != nil {
		return nil, err
	}
	description := fmt.Sprintf("PAGO CUOTA #%d PRÉSTAMO #%d - %s", in.Number, loan.ID, loan.LenderName)
	if err := validateStringLen("description", description, maxDescLen); err != nil {
		// Debería ser raro: lender_name está limitado y el prefijo es corto.
		return nil, err
	}

	outcome, err := s.repo.PayInstallmentAtomic(ctx, in.LoanID, ports.PayInstallmentAtomicInput{
		Number:          in.Number,
		Amount:          amount,
		CashAmount:      cash,
		NequiAmount:     nequi,
		DaviplataAmount: davi,
		FondoAmount:     fondo,
		CoinsAmount:     coins,
		PaymentSource:   channel,
		Description:     description,
		Category:        "Préstamos",
		PaidAt:          time.Now().In(bogotaLocation),
		ActorDNI:        actor,
		ClientTxID:      strings.TrimSpace(in.ClientTxID),
	})
	if err != nil {
		return nil, err
	}

	// Auditoría + sincronización.
	if s.auditService != nil {
		s.auditService.Log(
			actor, strings.TrimSpace(in.ActorName), "PAY_LOAN_INSTALLMENT", "FINANCES",
			fmt.Sprintf("Pago cuota #%d (préstamo #%d): $%s via %s. Saldo tras pago: $%s",
				in.Number, loan.ID, formatMoney(outcome.AppliedAmount), channel, formatMoney(outcome.RemainingBalance)),
			fmt.Sprintf("Se saldó la cuota #%d del préstamo con %s por $%s",
				in.Number, loan.LenderName, formatMoney(outcome.AppliedAmount)),
			"", in.ClientIP, in.DeviceUA, true,
		)
	}
	cache.InvalidateDashboard()
	sse.GetSSEService().BroadcastDashboardUpdate()
	sse.GetSSEService().BroadcastExpenseUpdate(nil)

	return &PayInstallmentResult{
		Installment:      outcome.Installment,
		ExpenseID:        outcome.ExpenseID,
		LoanStatus:       outcome.LoanStatus,
		RemainingBalance: outcome.RemainingBalance,
		AppliedAmount:    outcome.AppliedAmount,
	}, nil
}

// RegisterLoanExpenseInput son los parámetros de "en qué me gasté el
// préstamo". El handler lo invoca después de que el usuario registra el
// expense físico; aquí sólo escribimos la fila de rastreo (NO se crea
// un Expense contable aquí: eso lo gestiona /expenses).
type RegisterLoanExpenseInput struct {
	LoanID     uint
	ExpenseID  *uint
	AmountUsed float64
	Purpose    string
	ActorDNI   string
	ActorName  string
	ClientIP   string
	DeviceUA   string
}

// RegisterLoanExpense aplica la invariante SUM(amount_used) <= principal
// y devuelve el total usado tras el INSERT para que la UI actualice la
// barra "gastado / disponible".
func (s *LoanService) RegisterLoanExpense(ctx context.Context, in RegisterLoanExpenseInput) (*models.LoanExpense, float64, error) {
	if in.LoanID == 0 {
		return nil, 0, errors.New("loanId requerido")
	}
	actor := strings.ToUpper(strings.TrimSpace(in.ActorDNI))
	if actor == "" {
		return nil, 0, ErrActorRequired
	}
	if err := validateStringLen("actorDni", actor, maxDNILen); err != nil {
		return nil, 0, err
	}
	if err := validateStringLen("purpose", in.Purpose, maxPurposeLen); err != nil {
		return nil, 0, err
	}
	if math.IsNaN(in.AmountUsed) || math.IsInf(in.AmountUsed, 0) {
		return nil, 0, errors.New("amountUsed no es un número finito")
	}
	amount := Round2(in.AmountUsed)
	if amount <= 0 {
		return nil, 0, errors.New("amountUsed debe ser mayor a cero")
	}
	if !isFiniteMoney(amount) {
		return nil, 0, errors.New("amountUsed excede el rango permitido")
	}
	exp := &models.LoanExpense{
		LoanID:       in.LoanID,
		ExpenseID:    in.ExpenseID,
		AmountUsed:   amount,
		Purpose:      strings.TrimSpace(in.Purpose),
		CreatedByDNI: actor,
		CreatedAt:    time.Now(),
	}
	totalUsed, err := s.repo.RegisterLoanExpense(ctx, exp)
	if err != nil {
		return nil, 0, err
	}
	if s.auditService != nil {
		s.auditService.Log(
			actor, strings.TrimSpace(in.ActorName), "LOAN_EXPENSE", "FINANCES",
			fmt.Sprintf("Uso del préstamo #%d: $%s - %s", in.LoanID, formatMoney(amount), in.Purpose),
			fmt.Sprintf("Se registró un uso de $%s del préstamo (acumulado: $%s)",
				formatMoney(amount), formatMoney(totalUsed)),
			"", in.ClientIP, in.DeviceUA, false,
		)
	}
	cache.InvalidateDashboard()
	sse.GetSSEService().BroadcastDashboardUpdate()
	return exp, totalUsed, nil
}

// SoftDeleteLoan permite anular un préstamo que no ha tenido pagos. El
// repo valida que la suma de paid_amount sea 0; si no, aborta.
func (s *LoanService) SoftDeleteLoan(ctx context.Context, loanID uint, actorDNI, actorName, ip, device string) error {
	if err := s.repo.SoftDelete(ctx, loanID); err != nil {
		return err
	}
	if s.auditService != nil {
		s.auditService.Log(
			strings.ToUpper(strings.TrimSpace(actorDNI)), actorName, "CANCEL_LOAN", "FINANCES",
			fmt.Sprintf("Préstamo #%d cancelado", loanID),
			"Se canceló un préstamo sin pagos registrados",
			"", ip, device, true,
		)
	}
	cache.InvalidateDashboard()
	sse.GetSSEService().BroadcastDashboardUpdate()
	return nil
}

// ErrInvalidLoanType / ErrInvalidRateType / ErrInvalidCurrency validan la
// metadata bancaria contra los enums cerrados de la migración 023. El
// handler los mapea a LOAN_INVALID_INPUT (400).
var ErrInvalidLoanType = errors.New("tipo de crédito inválido (CONSUMO|HIPOTECARIO|LIBRANZA|COMERCIAL|VEHICULO|OTRO)")
var ErrInvalidRateType = errors.New("tipo de tasa inválido (FIJO|VARIABLE)")
var ErrInvalidCurrency = errors.New("moneda inválida (COP|USD)")

// ErrInvalidBankSnapshot señala que el snapshot bancario llegó a medias
// (saldo sin fecha o fecha sin saldo), lo que violaría el CHECK atado de
// la migración 023. El handler lo mapea a LOAN_INVALID_INPUT (400).
var ErrInvalidBankSnapshot = errors.New("snapshot del banco incompleto: saldo y fecha de consulta van juntos")

// ErrInvalidOfficialInstallment idem para la cuota oficial del banco
// (monto y fecha van juntos).
var ErrInvalidOfficialInstallment = errors.New("cuota oficial del banco incompleta: monto y fecha van juntos")

// ErrInvalidMoneyField señala un monto no finito o fuera de rango en la
// metadata bancaria (desembolso neto, FGA IVA/GMF, snapshot, cuota oficial).
var ErrInvalidMoneyField = errors.New("monto inválido (no finito o fuera de rango)")

// ErrMaturityBeforeStart evita vencimiento anterior al desembolso (CHECK
// ck_loans_maturity_after_start). El handler lo mapea a LOAN_INVALID_INPUT.
var ErrMaturityBeforeStart = errors.New("la fecha de vencimiento no puede ser anterior a la fecha de inicio")

// ErrScheduleFieldsRequireRecalc señala que llegaron campos financieros
// (principal, plazo, tasa, frecuencia, firstPaymentDate, extras FRENCH)
// sin pedir recalculate=true. Cambiarlos sin recalcular dejaría el
// cronograma inconsistente, así que se rechaza explícitamente.
var ErrScheduleFieldsRequireRecalc = errors.New("para cambiar condiciones financieras hay que recalcular el cronograma (recalculate=true)")

// formatMoney es un helper mínimo para los mensajes de auditoría/UI de
// este módulo. 2 decimales, sin separadores de miles para no romper
// grep en logs. El dashboard del frontend formatea con Intl.
func formatMoney(v float64) string {
	return fmt.Sprintf("%.2f", v)
}

// UpdateLoanInput describe los parámetros validables del endpoint
// PUT /api/loans/:id. Separa metadata (siempre editable) del cronograma
// (sólo con Recalculate). Punteros = "campo opcional / nullable".
type UpdateLoanInput struct {
	LoanID uint

	// --- Metadata siempre editable --------------------------------------
	LenderName          string
	LenderDNI           string
	SupplierID          *uint
	DisbursementChannel string
	Note                string

	CreditNumber               *string
	LoanType                   string
	HolderName                 *string
	HolderDNI                  *string
	Currency                   string
	RateType                   string
	AutoDebit                  bool
	MaturityDate               *time.Time
	LateAnnualEffectiveRatePct float64
	NetDisbursementAmount      *float64
	FgaIvaAmount               float64
	FgaGmfAmount               float64

	// Snapshot bancario (trío) y cuota oficial (par). Coherencia validada
	// aquí para no filtrar un error de CHECK crudo al cliente.
	BankBalanceAmount             *float64
	BankBalanceAsOf               *time.Time
	BankPaidAmount                *float64
	OfficialNextInstallmentAmount *float64
	OfficialNextInstallmentDate   *time.Time

	// StartDate editable (opcional). El repo valida que no quede después
	// de una cuota ya programada.
	StartDate *time.Time

	// --- Rama de recálculo ----------------------------------------------
	Recalculate bool
	// Campos financieros. Sólo se usan y validan cuando Recalculate=true.
	// Se interpretan igual que en CreateLoanInput: InterestRatePct carga
	// la EA cuando el modo es FRENCH.
	PrincipalAmount  float64
	InterestRatePct  float64
	InterestMode     string
	TermCount        int
	PaymentFrequency string
	FirstPaymentDate time.Time
	MonthlyInsurance float64
	FgaTotal         float64

	// HasScheduleFields lo activa el handler cuando el JSON trae campos
	// financieros. Permite rechazar su edición si no pidieron recalcular.
	HasScheduleFields bool

	ActorDNI  string
	ActorName string
	ClientIP  string
	DeviceUA  string
}

// validateMetadata recorta/normaliza y valida la metadata editable.
func (in *UpdateLoanInput) validateMetadata() error {
	if err := validateStringLen("lenderName", in.LenderName, maxLenderNameLen); err != nil {
		return err
	}
	if strings.TrimSpace(in.LenderName) == "" {
		return ErrLenderRequired
	}
	if err := validateStringLen("lenderDni", in.LenderDNI, maxDNILen); err != nil {
		return err
	}
	if err := validateStringLen("note", in.Note, maxNoteLen); err != nil {
		return err
	}
	if err := validateStringLen("disbursementChannel", in.DisbursementChannel, maxChannelLen); err != nil {
		return err
	}
	if in.CreditNumber != nil {
		if err := validateStringLen("creditNumber", *in.CreditNumber, maxCreditNumberLen); err != nil {
			return err
		}
	}
	if in.HolderName != nil {
		if err := validateStringLen("holderName", *in.HolderName, maxHolderNameLen); err != nil {
			return err
		}
	}
	if in.HolderDNI != nil {
		if err := validateStringLen("holderDni", *in.HolderDNI, maxDNILen); err != nil {
			return err
		}
	}

	// Enums cerrados.
	if !AllowedLoanTypes[in.LoanType] {
		return fmt.Errorf("%w: %s", ErrInvalidLoanType, in.LoanType)
	}
	if !AllowedRateTypes[in.RateType] {
		return fmt.Errorf("%w: %s", ErrInvalidRateType, in.RateType)
	}
	if !AllowedCurrencies[in.Currency] {
		return fmt.Errorf("%w: %s", ErrInvalidCurrency, in.Currency)
	}
	// Canal de desembolso.
	if !AllowedDisbursementChannels[in.DisbursementChannel] {
		return fmt.Errorf("%w: %s", ErrInvalidChannel, in.DisbursementChannel)
	}

	// Tasa de mora: finita, >= 0, techo 1000 (igual que el scheduler).
	if math.IsNaN(in.LateAnnualEffectiveRatePct) || math.IsInf(in.LateAnnualEffectiveRatePct, 0) ||
		in.LateAnnualEffectiveRatePct < 0 || in.LateAnnualEffectiveRatePct > 1000 {
		return fmt.Errorf("%w: tasa de mora EA fuera de rango", ErrInvalidMoneyField)
	}

	// Montos no-nullable del FGA.
	for _, v := range []float64{in.FgaIvaAmount, in.FgaGmfAmount} {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || !isFiniteMoney(v) {
			return fmt.Errorf("%w: desglose del FGA", ErrInvalidMoneyField)
		}
	}
	// Montos nullable.
	for _, p := range []*float64{in.NetDisbursementAmount, in.BankBalanceAmount, in.BankPaidAmount, in.OfficialNextInstallmentAmount} {
		if p == nil {
			continue
		}
		v := *p
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || !isFiniteMoney(v) {
			return fmt.Errorf("%w: metadata bancaria", ErrInvalidMoneyField)
		}
	}

	// Snapshot bancario atado: ambos o ninguno. bank_paid sólo si hay snapshot.
	if (in.BankBalanceAmount == nil) != (in.BankBalanceAsOf == nil) {
		return ErrInvalidBankSnapshot
	}
	if in.BankPaidAmount != nil && in.BankBalanceAmount == nil {
		return ErrInvalidBankSnapshot
	}
	// Cuota oficial atada: monto y fecha van juntos.
	if (in.OfficialNextInstallmentAmount == nil) != (in.OfficialNextInstallmentDate == nil) {
		return ErrInvalidOfficialInstallment
	}

	// Vencimiento >= inicio cuando ambos vienen en el input.
	if in.MaturityDate != nil && in.StartDate != nil {
		if in.MaturityDate.Before(*in.StartDate) {
			return ErrMaturityBeforeStart
		}
	}
	return nil
}

// UpdateLoan edita un préstamo (admin-only). SIEMPRE aplica metadata; sólo
// recalcula el cronograma si Recalculate=true y no hay cuotas pagadas.
//
// AUDITORÍA: módulo FINANCES, acción UPDATE_LOAN, isCritical=true.
// SSE: BroadcastDashboardUpdate. Cache: InvalidateDashboard.
//
// Errores propagados (ports):
//   - ErrLoanNotFound
//   - ErrLoanHasPaidInstallments (409) — recalc con cuotas pagadas
//   - ErrLoanPrincipalBelowUsage (400) — principal nuevo < uso activo
//   - ErrLoanStartDateAfterInstallments (400)
//
// Errores de validación (servicio):
//   - ErrInvalidLoanType / ErrInvalidRateType / ErrInvalidCurrency
//   - ErrInvalidBankSnapshot / ErrInvalidOfficialInstallment
//   - ErrMaturityBeforeStart / ErrInvalidMoneyField
//   - ErrScheduleFieldsRequireRecalc
//   - cualquier Err*Schedule de BuildLoanSchedule cuando Recalculate=true.
func (s *LoanService) UpdateLoan(ctx context.Context, in UpdateLoanInput) (*models.Loan, error) {
	if in.LoanID == 0 {
		return nil, errors.New("loanId requerido")
	}
	actor := strings.ToUpper(strings.TrimSpace(in.ActorDNI))
	if actor == "" {
		return nil, ErrActorRequired
	}
	if err := validateStringLen("actorDni", actor, maxDNILen); err != nil {
		return nil, err
	}

	// Defaults de los enums cuando el handler no mandó valor (equivalente
	// a los DEFAULT de la BD) para no romper préstamos editados parcialmente.
	in.LoanType = strings.ToUpper(strings.TrimSpace(in.LoanType))
	if in.LoanType == "" {
		in.LoanType = "OTRO"
	}
	in.RateType = strings.ToUpper(strings.TrimSpace(in.RateType))
	if in.RateType == "" {
		in.RateType = "FIJO"
	}
	in.Currency = strings.ToUpper(strings.TrimSpace(in.Currency))
	if in.Currency == "" {
		in.Currency = "COP"
	}
	channel := strings.ToUpper(strings.TrimSpace(in.DisbursementChannel))
	if channel == "" {
		channel = "EFECTIVO"
	}
	in.DisbursementChannel = channel

	// Si llegaron campos financieros SIN recalculate, rechazar: cambiarlos
	// sin recalcular dejaría el cronograma inconsistente.
	if in.HasScheduleFields && !in.Recalculate {
		return nil, ErrScheduleFieldsRequireRecalc
	}

	if err := in.validateMetadata(); err != nil {
		return nil, err
	}

	// Construir el input atómico con la metadata ya normalizada.
	atomic := ports.UpdateLoanAtomicInput{
		LenderName:                    strings.TrimSpace(in.LenderName),
		LenderDNI:                     strings.TrimSpace(in.LenderDNI),
		SupplierID:                    in.SupplierID,
		DisbursementChannel:           channel,
		Note:                          strings.TrimSpace(in.Note),
		CreditNumber:                  trimLoanPtr(in.CreditNumber),
		LoanType:                      in.LoanType,
		HolderName:                    trimLoanPtr(in.HolderName),
		HolderDNI:                     trimLoanPtr(in.HolderDNI),
		Currency:                      in.Currency,
		RateType:                      in.RateType,
		AutoDebit:                     in.AutoDebit,
		MaturityDate:                  in.MaturityDate,
		LateAnnualEffectiveRatePct:    in.LateAnnualEffectiveRatePct,
		NetDisbursementAmount:         round2LoanPtr(in.NetDisbursementAmount),
		FgaIvaAmount:                  Round2(in.FgaIvaAmount),
		FgaGmfAmount:                  Round2(in.FgaGmfAmount),
		BankBalanceAmount:             round2LoanPtr(in.BankBalanceAmount),
		BankBalanceAsOf:               in.BankBalanceAsOf,
		BankPaidAmount:                round2LoanPtr(in.BankPaidAmount),
		OfficialNextInstallmentAmount: round2LoanPtr(in.OfficialNextInstallmentAmount),
		OfficialNextInstallmentDate:   in.OfficialNextInstallmentDate,
		StartDate:                     normalizeStartLoanPtr(in.StartDate),
		Recalculate:                   in.Recalculate,
		ActorDNI:                      actor,
	}

	// Rama de recálculo: construir el cronograma con el motor puro, idéntico
	// a CreateLoan, y poblar los campos financieros del input atómico.
	if in.Recalculate {
		req, err := s.toScheduleRequest(CreateLoanInput{
			PrincipalAmount:  in.PrincipalAmount,
			InterestRatePct:  in.InterestRatePct,
			InterestMode:     in.InterestMode,
			TermCount:        in.TermCount,
			PaymentFrequency: in.PaymentFrequency,
			StartDate:        derefLoanTime(in.StartDate),
			FirstPaymentDate: in.FirstPaymentDate,
			MonthlyInsurance: in.MonthlyInsurance,
			FgaTotal:         in.FgaTotal,
		})
		if err != nil {
			return nil, err
		}
		preview, err := BuildLoanSchedule(req)
		if err != nil {
			return nil, err
		}

		atomic.NewPrincipalAmount = Round2(in.PrincipalAmount)
		atomic.NewInterestMode = req.InterestMode
		atomic.NewTermCount = req.TermCount
		atomic.NewPaymentFrequency = req.PaymentFrequency
		atomic.NewFirstPaymentDate = req.FirstPaymentDate
		atomic.NewTotalPayable = preview.TotalPayable
		atomic.NewSchedule = preview.Installments
		if req.InterestMode == models.InterestModeFrench {
			atomic.NewAnnualEffectiveRatePct = in.InterestRatePct
			atomic.NewInterestRatePct = 0
			atomic.NewMonthlyInsurance = Round2(in.MonthlyInsurance)
			atomic.NewFgaTotal = Round2(in.FgaTotal)
			atomic.NewMonthlyFga = Round2(preview.MonthlyFga)
			atomic.NewBaseInstallment = Round2(preview.InstallmentBase)
		} else {
			atomic.NewInterestRatePct = in.InterestRatePct
			atomic.NewAnnualEffectiveRatePct = 0
			atomic.NewMonthlyInsurance = 0
			atomic.NewFgaTotal = 0
			atomic.NewMonthlyFga = 0
			atomic.NewBaseInstallment = 0
		}
	}

	outcome, err := s.repo.UpdateLoanAtomic(ctx, in.LoanID, atomic)
	if err != nil {
		return nil, err
	}

	// Recargar completo para el envelope { loan } con cuotas y expenses.
	full, err := s.repo.GetByIDWithRelations(ctx, in.LoanID)
	if err != nil {
		// La edición quedó bien; devolvemos lo que el repo nos dio.
		full = outcome.Loan
	}

	// Auditoría + sincronización global.
	if s.auditService != nil {
		recalcLabel := "metadata"
		if outcome.Recalculated {
			recalcLabel = "metadata + cronograma recalculado"
		}
		s.auditService.Log(
			actor, strings.TrimSpace(in.ActorName), "UPDATE_LOAN", "FINANCES",
			fmt.Sprintf("Préstamo #%d editado (%s). Tipo=%s, moneda=%s, tasa=%s, estado=%s",
				in.LoanID, recalcLabel, in.LoanType, in.Currency, in.RateType, outcome.LoanStatus),
			fmt.Sprintf("Se editó el préstamo #%d (%s)", in.LoanID, recalcLabel),
			"", in.ClientIP, in.DeviceUA, true,
		)
	}
	cache.InvalidateDashboard()
	sse.GetSSEService().BroadcastDashboardUpdate()
	return full, nil
}

// trimLoanPtr recorta el string apuntado; nil se preserva como nil.
func trimLoanPtr(p *string) *string {
	if p == nil {
		return nil
	}
	v := strings.TrimSpace(*p)
	return &v
}

// round2LoanPtr redondea el float apuntado a 2 decimales; nil se preserva.
func round2LoanPtr(p *float64) *float64 {
	if p == nil {
		return nil
	}
	v := Round2(*p)
	return &v
}

// derefLoanTime devuelve el valor de un *time.Time o el zero value si es nil.
func derefLoanTime(p *time.Time) time.Time {
	if p == nil {
		return time.Time{}
	}
	return *p
}

// normalizeStartLoanPtr normaliza start_date a 00:00 Bogotá (para que la
// columna DATE no derive al día siguiente). nil se preserva.
func normalizeStartLoanPtr(p *time.Time) *time.Time {
	if p == nil {
		return nil
	}
	t := p.In(bogotaLocation)
	n := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, bogotaLocation)
	return &n
}

// validateStringLen chequea tamaño del string (en runes, para no cortar
// un carácter UTF-8 en el medio y dejar al CHECK de BD aceptarlo mal).
func validateStringLen(field, value string, max int) error {
	if len([]rune(value)) > max {
		return fmt.Errorf("%w: %s", ErrStringTooLong, field)
	}
	return nil
}

// =============================================================================
// PayExpenseWithLoan — pagar un egreso con la plata del préstamo
// =============================================================================
//
// Decisión del dueño (opción 1): pagar con préstamo NO sale de ningún canal
// de la tienda y NO cuenta como egreso en el cuadre. Sólo descuenta del
// disponible del préstamo (`principal - SUM(amount_used)`). El egreso real
// contra caja ocurre cuando se paga la cuota del préstamo.
//
// El servicio orquesta validación de inputs, la transacción atómica del
// repo (que crea el Expense con PaymentSource='PRESTAMO' + canales en 0 y
// la fila de `loan_expenses`) y los side effects post-commit: auditoría,
// invalidación de caché y broadcast SSE.

// PayExpenseInput es lo que recibe el servicio desde el handler.
type PayExpenseInput struct {
	LoanID      uint
	ExpenseID   *uint   // nil = crear expense nuevo; valor = abonar/saldar deuda existente
	Amount      float64 // monto en pesos
	Description string  // obligatorio cuando ExpenseID == nil
	Category    string  // opcional; default "Otros Gastos"
	SupplierID  *uint   // opcional; sólo aplica cuando ExpenseID == nil
	Purpose     string  // texto para loan_expenses.purpose; si vacío, cae a Description
	ActorDNI    string
	ActorName   string
	ClientIP    string
	DeviceUA    string
}

// PayExpenseResult es lo que devuelve el servicio al handler.
type PayExpenseResult struct {
	Expense        *models.Expense     `json:"expense"`
	UpdatedDebt    *models.Expense     `json:"updatedDebt,omitempty"`
	LoanExpense    *models.LoanExpense `json:"loanExpense"`
	AppliedAmount  float64             `json:"appliedAmount"`
	TotalUsedAfter float64             `json:"totalUsed"`
	Available      float64             `json:"available"`
}

// PayExpenseWithLoan es el camino financiero crítico para
// POST /api/loans/:id/pay-expense.
//
//  1. Valida inputs (actor, amount finito y > 0, strings dentro de
//     límites, expenseId/description coherentes).
//  2. Delega al repo `PayExpenseAtomic`, que corre TODO (SELECT FOR
//     UPDATE + INSERT expense + UPDATE deuda si aplica + INSERT
//     loan_expense) en una única transacción.
//  3. Al éxito, emite auditoría (acción LOAN_PAY_EXPENSE, módulo
//     FINANCES, isCritical=true), invalida cache de dashboard y hace
//     BroadcastDashboardUpdate + BroadcastExpenseUpdate.
//
// Errores propagados con sentinels del paquete `ports`:
//   - ports.ErrLoanNotFound (loan no existe)
//   - ports.ErrLoanNotActive (status no permite nuevos usos)
//   - ports.ErrPrincipalExceeded (amount > disponible)
//   - ports.ErrExpenseNotFound / ErrExpenseNotPayable (al abonar)
func (s *LoanService) PayExpenseWithLoan(ctx context.Context, in PayExpenseInput) (*PayExpenseResult, error) {
	if in.LoanID == 0 {
		return nil, fmt.Errorf("%w: loanId requerido", ErrInvalidExpensePayment)
	}
	if math.IsNaN(in.Amount) || math.IsInf(in.Amount, 0) {
		return nil, fmt.Errorf("%w: amount no es un número finito", ErrInvalidExpensePayment)
	}
	amount := Round2(in.Amount)
	if amount <= 0 {
		return nil, fmt.Errorf("%w: amount debe ser mayor a cero", ErrInvalidExpensePayment)
	}
	if !isFiniteMoney(amount) {
		return nil, fmt.Errorf("%w: amount excede el rango permitido", ErrInvalidExpensePayment)
	}
	actor := strings.ToUpper(strings.TrimSpace(in.ActorDNI))
	if actor == "" {
		return nil, ErrActorRequired
	}
	if err := validateStringLen("actorDni", actor, maxDNILen); err != nil {
		return nil, err
	}
	if err := validateStringLen("description", in.Description, maxDescLen); err != nil {
		return nil, err
	}
	if err := validateStringLen("category", in.Category, maxDescLen); err != nil {
		return nil, err
	}
	if err := validateStringLen("purpose", in.Purpose, maxPurposeLen); err != nil {
		return nil, err
	}
	if in.ExpenseID != nil && *in.ExpenseID == 0 {
		return nil, fmt.Errorf("%w: expenseId debe ser mayor a cero", ErrInvalidExpensePayment)
	}
	// Si no viene expenseId, description obligatoria.
	if in.ExpenseID == nil && strings.TrimSpace(in.Description) == "" {
		return nil, fmt.Errorf("%w: description requerida cuando no hay expenseId", ErrInvalidExpensePayment)
	}

	outcome, err := s.repo.PayExpenseAtomic(ctx, in.LoanID, ports.PayExpenseAtomicInput{
		ExpenseID:   in.ExpenseID,
		Amount:      amount,
		Description: strings.TrimSpace(in.Description),
		Category:    strings.TrimSpace(in.Category),
		SupplierID:  in.SupplierID,
		Purpose:     strings.TrimSpace(in.Purpose),
		PaidAt:      time.Now().In(bogotaLocation),
		ActorDNI:    actor,
	})
	if err != nil {
		return nil, err
	}

	// Side effects post-commit.
	if s.auditService != nil {
		variant := "nuevo egreso"
		if in.ExpenseID != nil {
			variant = fmt.Sprintf("abono a deuda #%d", *in.ExpenseID)
		}
		s.auditService.Log(
			actor, strings.TrimSpace(in.ActorName), "LOAN_PAY_EXPENSE", "FINANCES",
			fmt.Sprintf("Pago con préstamo #%d (%s): $%s. Disponible tras pago: $%s",
				in.LoanID, variant, formatMoney(outcome.AppliedAmount), formatMoney(outcome.Available)),
			fmt.Sprintf("Se pagó $%s usando la plata del préstamo (no sale de ningún canal de la tienda)",
				formatMoney(outcome.AppliedAmount)),
			"", in.ClientIP, in.DeviceUA, true,
		)
	}
	cache.InvalidateDashboard()
	sse.GetSSEService().BroadcastDashboardUpdate()
	sse.GetSSEService().BroadcastExpenseUpdate(nil)

	return &PayExpenseResult{
		Expense:        outcome.Expense,
		UpdatedDebt:    outcome.UpdatedDebt,
		LoanExpense:    outcome.LoanExpense,
		AppliedAmount:  outcome.AppliedAmount,
		TotalUsedAfter: outcome.TotalUsedAfter,
		Available:      outcome.Available,
	}, nil
}

// orphanLoanExpenseReverser es una capacidad del repositorio PostgreSQL
// usada sólo para reparar pagos eliminados antes de la migración 022.
type orphanLoanExpenseReverser interface {
	ReverseOrphanedLoanExpense(ctx context.Context, loanID, usageID uint, actorDNI string) (*ports.ReverseOrphanedLoanExpenseOutcome, error)
}

func (s *LoanService) ReverseOrphanedLoanExpense(ctx context.Context, loanID, usageID uint, actorDNI, actorName, clientIP, deviceUA string) (*ports.ReverseOrphanedLoanExpenseOutcome, error) {
	actor := strings.ToUpper(strings.TrimSpace(actorDNI))
	if loanID == 0 || usageID == 0 || actor == "" {
		return nil, ErrActorRequired
	}
	repo, ok := s.repo.(orphanLoanExpenseReverser)
	if !ok {
		return nil, errors.New("repositorio no soporta recuperación de pagos eliminados")
	}
	out, err := repo.ReverseOrphanedLoanExpense(ctx, loanID, usageID, actor)
	if err != nil {
		return nil, err
	}
	if s.auditService != nil {
		s.auditService.Log(actor, strings.TrimSpace(actorName), "LOAN_REVERSE_ORPHANED_EXPENSE", "FINANCES",
			fmt.Sprintf("Pago eliminado del préstamo #%d reparado: deuda #%d restaurada por $%s", loanID, out.RestoredDebtID, formatMoney(out.RestoredAmount)),
			fmt.Sprintf("Se liberó $%s del principal y la cuenta volvió a Cuentas por pagar", formatMoney(out.ReleasedPrincipal)),
			"", clientIP, deviceUA, true)
	}
	cache.InvalidateDashboard()
	sse.GetSSEService().BroadcastDashboardUpdate()
	sse.GetSSEService().BroadcastExpenseUpdate(nil)
	return out, nil
}

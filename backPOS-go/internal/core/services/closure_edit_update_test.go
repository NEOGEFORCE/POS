package services

import (
	"errors"
	"math"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

// =============================================================================
// EdiciÃ³n de cierres (UpdateClosure): fechas efectivas, egresos olvidados
// leÃ­dos dentro de la tx y propagaciÃ³n de errores de lectura.
// =============================================================================

var editTZ = time.FixedZone("America/editTZ", -5*60*60)

func approx(t *testing.T, name string, got interface{}, want float64) {
	t.Helper()
	g, ok := got.(float64)
	if !ok {
		t.Fatalf("%s: se esperaba float64, got %T (%v)", name, got, got)
	}
	if math.Abs(g-want) > 0.001 {
		t.Fatalf("%s = %.2f, se esperaba %.2f", name, g, want)
	}
}

func cashExpense(amount float64, date time.Time) models.Expense {
	return models.Expense{
		Amount:        amount,
		CashAmount:    amount,
		PaymentSource: "EFECTIVO",
		Category:      "Otros",
		Status:        "PAID",
		Date:          date,
	}
}

func baseClosure() *models.CashierClosure {
	start := time.Date(2026, 10, 3, 7, 0, 0, 0, editTZ)
	end := time.Date(2026, 10, 3, 21, 0, 0, 0, editTZ)
	return &models.CashierClosure{
		ID:           7,
		Date:         end,
		StartDate:    start,
		EndDate:      end,
		OpeningCash:  50_000,
		TotalCash:    100_000,
		TotalReturns: 0,
		TotalSales:   100_000,
		PhysicalCash: 130_000,
		ClosedByDNI:  "EMP-1",
		AuthorizedBy: "ADMIN ORIGINAL",
	}
}

// ---------------------------------------------------------------------------
// FunciÃ³n pura
// ---------------------------------------------------------------------------

func TestClosureEdit_VentanaIgualConservaTotalCash(t *testing.T) {
	c := baseClosure()
	in := closureWindowInputs{Expenses: []models.Expense{cashExpense(20_000, c.StartDate.Add(time.Hour))}}

	u := computeClosureEditUpdates(c, c.StartDate, c.EndDate, 130_000, in)

	if _, ok := u["total_cash"]; ok {
		t.Fatal("si la ventana no cambiÃ³ no se debe reescribir total_cash")
	}
	approx(t, "expected_cash", u["expected_cash"], 50_000+100_000-20_000)
	approx(t, "difference", u["difference"], 0)
	approx(t, "total_expenses", u["total_expenses"], 20_000)
}

func TestClosureEdit_VentanaNuevaRecalculaTotalCashYDevoluciones(t *testing.T) {
	c := baseClosure()
	newStart := c.StartDate.Add(-2 * time.Hour)
	newEnd := c.EndDate.Add(time.Hour)
	in := closureWindowInputs{
		Expenses: []models.Expense{cashExpense(20_000, newStart.Add(time.Hour))},
		Sales: []models.Sale{
			{Status: "PAID", CashAmount: 80_000},
			{Status: "credit", CashAmount: 10_000, Change: 2_000},
			{Status: "PAID", CashAmount: 1_000, Change: 5_000}, // vuelto mayor: no resta
			{Status: "CANCELLED", CashAmount: 999_999},
		},
		Payments: []models.CreditPayment{{AmountCash: 5_000, TotalPaid: 7_000}},
		Returns:  []models.Return{{TotalReturned: 3_000}},
	}

	u := computeClosureEditUpdates(c, newStart, newEnd, 120_000, in)

	wantCash := 80_000.0 + 8_000 + 0 + 5_000
	approx(t, "total_cash", u["total_cash"], wantCash)
	approx(t, "total_returns", u["total_returns"], 3_000)
	approx(t, "expected_cash", u["expected_cash"], 50_000+wantCash-20_000-3_000)
	approx(t, "difference", u["difference"], 120_000-(50_000+wantCash-20_000-3_000))
	approx(t, "total_sales", u["total_sales"], 80_000+8_000+0+7_000)
}

func TestClosureEdit_EgresoPendienteNoRestaDelEsperado(t *testing.T) {
	c := baseClosure()
	pending := cashExpense(40_000, c.StartDate.Add(time.Hour))
	pending.Status = "PENDING"

	u := computeClosureEditUpdates(c, c.StartDate, c.EndDate, 150_000, closureWindowInputs{Expenses: []models.Expense{pending}})

	approx(t, "expected_cash", u["expected_cash"], 150_000)
	approx(t, "difference", u["difference"], 0)
}

func TestClosureEdit_ForgottenExpenseDateQuedaDentroDeLaVentana(t *testing.T) {
	start := time.Date(2026, 10, 3, 20, 0, 0, 0, editTZ)
	end := time.Date(2026, 10, 4, 2, 0, 0, 0, editTZ)
	// Regla de mayorÃ­a: Date = viernes con la hora del fin (02:00), que cae
	// ANTES del inicio del turno.
	majority := time.Date(2026, 10, 3, 2, 0, 0, 0, editTZ)

	if got := forgottenExpenseDate(majority, start, end); !got.Equal(start) {
		t.Fatalf("fecha antes de la ventana debe acotarse al inicio; got %v", got)
	}
	inside := start.Add(time.Hour)
	if got := forgottenExpenseDate(inside, start, end); !got.Equal(inside) {
		t.Fatalf("fecha dentro de la ventana no debe cambiar; got %v", got)
	}
	if got := forgottenExpenseDate(end.Add(time.Hour), start, end); !got.Equal(end) {
		t.Fatalf("fecha despuÃ©s de la ventana debe acotarse al fin; got %v", got)
	}
}

// ---------------------------------------------------------------------------
// UpdateClosure completo con fakes
// ---------------------------------------------------------------------------

type editClosureRepo struct {
	ports.ClosureRepository // mÃ©todos no usados: panic si se llaman
	closure                 *models.CashierClosure
	updates                 map[string]interface{}
	committed               bool
}

type editTx struct{}

func (r *editClosureRepo) Transaction(fn func(tx interface{}) error) error {
	if err := fn(&editTx{}); err != nil {
		return err
	}
	r.committed = true
	return nil
}
func (r *editClosureRepo) GetByIDWithTx(_ interface{}, _ uint) (*models.CashierClosure, error) {
	cp := *r.closure
	return &cp, nil
}
func (r *editClosureRepo) UpdateWithTx(_ interface{}, _ uint, u map[string]interface{}) error {
	r.updates = u
	return nil
}

// editExpenseRepo modela la visibilidad transaccional: lo guardado con
// SaveWithTx sÃ³lo lo ve una lectura hecha con la misma tx.
type editExpenseRepo struct {
	ports.ExpenseRepository
	committed []models.Expense
	inTx      []models.Expense
	savedDate []time.Time
}

func (r *editExpenseRepo) SaveWithTx(tx interface{}, e *models.Expense) error {
	if tx == nil {
		return errors.New("SaveWithTx sin tx")
	}
	r.inTx = append(r.inTx, *e)
	r.savedDate = append(r.savedDate, e.Date)
	return nil
}
func (r *editExpenseRepo) GetByDateRange(_, _ time.Time) ([]models.Expense, error) {
	return append([]models.Expense(nil), r.committed...), nil
}
func (r *editExpenseRepo) GetByDateRangeWithTx(tx interface{}, from, to time.Time) ([]models.Expense, error) {
	if tx == nil {
		return nil, errors.New("lectura sin tx")
	}
	var out []models.Expense
	for _, e := range append(append([]models.Expense(nil), r.committed...), r.inTx...) {
		if !e.Date.Before(from) && !e.Date.After(to) {
			out = append(out, e)
		}
	}
	return out, nil
}

type editSaleRepo struct {
	ports.SaleRepository
	sales []models.Sale
	err   error
}

func (r *editSaleRepo) GetByDateRangeWithoutDetails(_, _ time.Time) ([]models.Sale, error) {
	return r.sales, r.err
}

type editCreditRepo struct {
	ports.CreditPaymentRepository
}

func (r *editCreditRepo) GetByDateRange(_, _ time.Time) ([]models.CreditPayment, error) {
	return nil, nil
}

type editReturnRepo struct {
	ports.ReturnRepository
	returns []models.Return
}

func (r *editReturnRepo) GetByDateRange(_, _ time.Time) ([]models.Return, error) {
	return r.returns, nil
}

func buildEditService(c *models.CashierClosure) (*DashboardService, *editClosureRepo, *editExpenseRepo, *editSaleRepo) {
	cr := &editClosureRepo{closure: c}
	er := &editExpenseRepo{}
	sr := &editSaleRepo{sales: []models.Sale{{Status: "PAID", CashAmount: 100_000}}}
	s := &DashboardService{}
	s.closureRepo = cr
	s.expenseRepo = er
	s.saleRepo = sr
	s.creditRepo = &editCreditRepo{}
	s.returnRepo = &editReturnRepo{}
	return s, cr, er, sr
}

func TestUpdateClosure_EgresoOlvidadoEntraAlArqueo(t *testing.T) {
	c := baseClosure()
	svc, cr, er, _ := buildEditService(c)

	err := svc.UpdateClosure(c.ID, map[string]interface{}{
		"physical_cash":      110_000.0,
		"forgotten_expenses": []models.Expense{{Amount: 20_000, CashAmount: 20_000, PaymentSource: "EFECTIVO", Category: "Otros"}},
	})
	if err != nil {
		t.Fatalf("UpdateClosure: %v", err)
	}
	if !cr.committed || cr.updates == nil {
		t.Fatal("debe confirmar la tx y escribir el UPDATE")
	}
	if len(er.inTx) != 1 {
		t.Fatalf("el egreso olvidado debe guardarse dentro de la tx; guardados=%d", len(er.inTx))
	}
	// 50.000 + 100.000 - 20.000 = 130.000 esperado; contado 110.000.
	approx(t, "expected_cash", cr.updates["expected_cash"], 130_000)
	approx(t, "difference", cr.updates["difference"], -20_000)
	if _, ok := cr.updates["forgotten_expenses"]; ok {
		t.Error("forgotten_expenses no es columna: no debe viajar al UPDATE")
	}
}

func TestUpdateClosure_EgresoOlvidadoSeFechaDentroDeTurnoQueCruzaMedianoche(t *testing.T) {
	c := baseClosure()
	c.StartDate = time.Date(2026, 10, 3, 20, 0, 0, 0, editTZ)
	c.EndDate = time.Date(2026, 10, 4, 2, 0, 0, 0, editTZ)
	c.Date = time.Date(2026, 10, 3, 2, 0, 0, 0, editTZ) // antes del inicio
	svc, cr, er, _ := buildEditService(c)

	if err := svc.UpdateClosure(c.ID, map[string]interface{}{
		"forgotten_expenses": []models.Expense{{Amount: 10_000, CashAmount: 10_000, PaymentSource: "EFECTIVO", Category: "Otros"}},
	}); err != nil {
		t.Fatalf("UpdateClosure: %v", err)
	}
	if len(er.savedDate) != 1 || er.savedDate[0].Before(c.StartDate) {
		t.Fatalf("el egreso olvidado debe quedar dentro de la ventana; fecha=%v", er.savedDate)
	}
	approx(t, "total_expenses", cr.updates["total_expenses"], 10_000)
}

func TestUpdateClosure_CambioDeFechasRecalculaEsperado(t *testing.T) {
	c := baseClosure()
	svc, cr, _, sr := buildEditService(c)
	sr.sales = []models.Sale{{Status: "PAID", CashAmount: 60_000}}

	newEnd := c.EndDate.Add(-3 * time.Hour)
	if err := svc.UpdateClosure(c.ID, map[string]interface{}{
		"end_date":      newEnd,
		"physical_cash": 110_000.0,
	}); err != nil {
		t.Fatalf("UpdateClosure: %v", err)
	}
	approx(t, "total_cash", cr.updates["total_cash"], 60_000)
	approx(t, "expected_cash", cr.updates["expected_cash"], 50_000+60_000)
	approx(t, "difference", cr.updates["difference"], 0)
}

func TestUpdateClosure_ErrorDeLecturaAbortaSinEscribir(t *testing.T) {
	c := baseClosure()
	svc, cr, _, sr := buildEditService(c)
	sr.err = errors.New("timeout")

	err := svc.UpdateClosure(c.ID, map[string]interface{}{"physical_cash": 1.0})
	if err == nil {
		t.Fatal("un error leyendo ventas debe propagarse")
	}
	if cr.updates != nil || cr.committed {
		t.Fatal("con lectura fallida no debe escribirse el cierre")
	}
}

func TestUpdateClosure_ConservaAutorizadorSiLlegaVacio(t *testing.T) {
	c := baseClosure()
	svc, cr, _, _ := buildEditService(c)

	if err := svc.UpdateClosure(c.ID, map[string]interface{}{"authorized_by": "  "}); err != nil {
		t.Fatalf("UpdateClosure: %v", err)
	}
	if _, ok := cr.updates["authorized_by"]; ok {
		t.Fatal("un authorized_by vacÃ­o no debe borrar al autorizador original")
	}
}

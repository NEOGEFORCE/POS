package services

import (
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// BOLD QR / Bre-B como canal propio del dashboard y de los egresos
// ============================================================================
//
// Las ventas cobradas con el QR Bre-B de Bold se materializan vía el
// dispatcher asíncrono con `transferSource='BOLD_QR'`. Antes del 2026-10-23
// esos ingresos se diluían en "TRANSFERENCIA" y los egresos pagados con
// Bold QR caían al fallback de EFECTIVO en parsePaymentSourceAmounts: la
// venta del mes se inflaba igual que ocurrió con la alcancía en 2026-08-31.
//
// Estos tests cristalizan tres invariantes:
//
//   1. Un egreso con paymentSource='BOLD_QR' deja los cinco canales
//      desglosados en cero y se identifica únicamente por el texto. Así
//      los agregadores SQL legacy lo levantan bajo la clave "BOLD_QR" sin
//      necesidad de columna física.
//
//   2. parseExpenseChannelsFull reconoce BOLD_QR como su propio canal.
//      Un egreso BOLD_QR nunca mancha ni el efectivo de caja ni el saldo
//      Nequi/Daviplata.
//
//   3. ComputeClosureMetrics NO suma BoldQR a VentasCajero (la fórmula
//      cash-only sigue siendo PhysicalCash + Digital + EgresosCaja +
//      Returns). El canal Bold QR vive aparte en EgresosBoldQr para que el
//      dashboard pueda mostrar "cuánto hay" sin romper el arqueo físico.

func TestIsBoldQRPaymentSource_Variantes(t *testing.T) {
	cases := []struct {
		input string
		want  bool
	}{
		{"BOLD_QR", true},
		{"bold_qr", true},
		{"bold-qr", true},
		{"bold qr", true},
		{"BOLDQR", true},
		{"BOLD_QR_BRE_B", true},
		{"PAGO BOLD", true},
		{"QR_BOLD", true},
		{" BOLD_QR ", true},
		{"NEQUI", false},
		{"DAVIPLATA", false},
		{"EFECTIVO", false},
		{"CAJA", false},
		{"", false},
		// Rechaza "QR" solitario sin la marca "BOLD" para no capturar
		// descripciones genéricas (código QR, etc.).
		{"QR", false},
		{"codigo QR del banco", false},
	}
	for _, c := range cases {
		got := models.IsBoldQRPaymentSource(c.input)
		if got != c.want {
			t.Errorf("IsBoldQRPaymentSource(%q) = %v; want %v", c.input, got, c.want)
		}
	}
}

func TestParseExpenseChannelsFull_BoldQrEsCanalPropio(t *testing.T) {
	// Egreso pagado con BOLD_QR puro: las cinco columnas desglosadas vienen
	// en 0 (porque no existe columna física) y el canal se identifica por
	// el texto. Debe quedar en el canal BoldQR, NO en Cash.
	e := &models.Expense{
		Status:        "PAID",
		Amount:        45000,
		PaymentSource: "BOLD_QR",
	}
	a := parseExpenseChannelsFull(e)
	if a.BoldQR != 45000 {
		t.Fatalf("BoldQR = %v; want 45000", a.BoldQR)
	}
	if a.Cash != 0 {
		t.Fatalf("EL BUG VOLVIO: egreso BOLD_QR se contó como efectivo de caja (%v)", a.Cash)
	}
	if a.Nequi != 0 || a.Davi != 0 || a.Fondo != 0 || a.Coins != 0 {
		t.Fatalf("se contaminó otro canal: %+v", a)
	}
	if math.Abs(a.Total()-45000) > 0.01 {
		t.Fatalf("invariante rota: Total()=%v, want 45000", a.Total())
	}
}

func TestParseExpenseChannelsFull_BoldQrPorColumna(t *testing.T) {
	// En el caso raro de que alguien pre-poblara BoldQrAmount antes de que
	// Full repartiera los canales (p.ej. en un segundo pase), el valor se
	// respeta y se incluye en la suma.
	e := &models.Expense{
		Status:       "PAID",
		Amount:       12000,
		BoldQrAmount: 12000,
	}
	a := parseExpenseChannelsFull(e)
	if a.BoldQR != 12000 {
		t.Fatalf("BoldQR = %v; want 12000", a.BoldQR)
	}
	if a.Cash != 0 {
		t.Fatalf("se contaminó efectivo: %+v", a)
	}
}

func TestParseExpenseChannelsFull_WrapperDescartaBoldQR(t *testing.T) {
	// El wrapper legacy `parseExpenseChannels` sigue devolviendo cinco
	// canales. Un egreso BOLD_QR puro queda invisible para los callers
	// viejos (como el arqueo cash-only de audited_income.go), lo cual es
	// correcto: Bold QR no se cuenta como efectivo de la gaveta.
	e := &models.Expense{
		Status:        "PAID",
		Amount:        45000,
		PaymentSource: "BOLD_QR",
	}
	cash, nequi, davi, fondo, coins := parseExpenseChannels(e)
	if cash != 0 {
		t.Fatalf("wrapper: cash = %v; want 0 (BoldQR nunca cae a efectivo)", cash)
	}
	if nequi+davi+fondo+coins != 0 {
		t.Fatalf("wrapper: otros canales = %v+%v+%v+%v; todos deben ser 0",
			nequi, davi, fondo, coins)
	}
}

func TestParseExpenseChannelsFull_PendingNoAporta(t *testing.T) {
	e := &models.Expense{
		Status:        "PENDING",
		Amount:        100000,
		PaymentSource: "BOLD_QR",
	}
	a := parseExpenseChannelsFull(e)
	if a.Total() != 0 {
		t.Fatalf("PENDING debe dar 0 en todos los canales: %+v", a)
	}
}

func TestExpenseChannelBuckets_BoldQrApareceComoClavePropia(t *testing.T) {
	expenses := []models.Expense{
		{Status: "PAID", Amount: 100000, CashAmount: 100000, Category: "Servicios"},
		{Status: "PAID", Amount: 50000, NequiAmount: 50000, PaymentSource: "NEQUI"},
		{Status: "PAID", Amount: 30000, PaymentSource: "BOLD_QR"},
		{Status: "PAID", Amount: 15000, CoinsAmount: 15000, PaymentSource: "ALCANCIA"},
	}
	buckets := ExpenseChannelBuckets(expenses)
	if buckets["BOLD_QR"] != 30000 {
		t.Fatalf("buckets[BOLD_QR] = %v; want 30000", buckets["BOLD_QR"])
	}
	if buckets["EFECTIVO"] != 100000 {
		t.Fatalf("buckets[EFECTIVO] = %v; want 100000 (no incluye el BOLD_QR)", buckets["EFECTIVO"])
	}
	if buckets["NEQUI"] != 50000 {
		t.Fatalf("buckets[NEQUI] = %v; want 50000", buckets["NEQUI"])
	}

	// INVARIANTE: la suma de buckets = total multicanal del helper hermano.
	sum := buckets["EFECTIVO"] + buckets["NEQUI"] + buckets["DAVIPLATA"] +
		buckets["FONDO"] + buckets["MONEDAS"] + buckets["BOLD_QR"]
	total, _ := ComputeShiftExpenseTotals(expenses)
	if math.Abs(sum-total) > 0.01 {
		t.Fatalf("suma de buckets (%v) ≠ total canónico (%v); los helpers no comparten universo", sum, total)
	}
}

func TestComputeClosureMetrics_BoldQrNoInflaLaVenta(t *testing.T) {
	// Mismo patrón que la alcancía: un egreso pagado por Bold QR NO sale
	// de la gaveta, así que no debe sumarse a VentasCajero.
	base := models.CashierClosure{
		PhysicalCash: 1_000_000,
		TotalNequi:   200_000,
	}

	conEfectivo := base
	conEfectivo.Expenses = []models.Expense{
		{Status: "PAID", Amount: 100_000, CashAmount: 100_000, Category: "Servicios"},
	}
	mEfectivo := ComputeClosureMetrics(&conEfectivo)

	conBold := base
	conBold.Expenses = []models.Expense{
		{Status: "PAID", Amount: 100_000, PaymentSource: "BOLD_QR", Category: "Servicios"},
	}
	mBold := ComputeClosureMetrics(&conBold)

	if mEfectivo.VentasCajero != 1_300_000 {
		t.Fatalf("venta con egreso en efectivo = %v; want 1300000", mEfectivo.VentasCajero)
	}
	if mBold.VentasCajero != 1_200_000 {
		t.Fatalf("venta con egreso en Bold QR = %v; want 1200000 (NO debe sumar los 100.000)",
			mBold.VentasCajero)
	}
	if mBold.VentasCajero == mEfectivo.VentasCajero {
		t.Fatal("EL BUG VOLVIO: pagar con Bold QR infla la venta igual que pagar con la gaveta")
	}

	if mBold.EgresosBoldQr != 100_000 {
		t.Fatalf("EgresosBoldQr = %v; want 100000", mBold.EgresosBoldQr)
	}
	if mBold.EgresosCaja != 0 {
		t.Fatalf("EgresosCaja = %v; want 0 (el egreso NO salió de la gaveta)", mBold.EgresosCaja)
	}
	if mBold.EgresosTotales != 100_000 {
		t.Fatalf("EgresosTotales = %v; want 100000 (la plata no puede desaparecer)", mBold.EgresosTotales)
	}
}

// Tarjeta de "egresos del turno" del dashboard: una línea de egreso BOLD_QR
// debe aportar al total multicanal.
func TestComputeShiftExpenseTotals_IncluyeBoldQR(t *testing.T) {
	expenses := []models.Expense{
		{Status: "PAID", Amount: 100000, CashAmount: 100000, Category: "Servicios"},
		{Status: "PAID", Amount: 25000, PaymentSource: "BOLD_QR", Category: "Papelería"},
	}
	total, count := ComputeShiftExpenseTotals(expenses)
	if math.Abs(total-125000) > 0.01 {
		t.Fatalf("total = %v; want 125000", total)
	}
	if count != 2 {
		t.Fatalf("count = %d; want 2", count)
	}
}

// SplitExpensesByKind debe sumar BOLD_QR dentro del tipo de gasto que
// corresponda. La invariante "suppliers + others == total" no cambia.
func TestSplitExpensesByKind_IncluyeBoldQR(t *testing.T) {
	expenses := []models.Expense{
		// Mercancía pagada con Bold QR.
		{Status: "PAID", Amount: 80000, PaymentSource: "BOLD_QR", Category: "Proveedores", SupplierID: supplierID(3)},
		// Gasto del local pagado con Bold QR.
		{Status: "PAID", Amount: 15000, PaymentSource: "BOLD_QR", Category: "Otros Gastos"},
	}
	suppliers, others := SplitExpensesByKind(expenses)
	total, _ := ComputeShiftExpenseTotals(expenses)
	if math.Abs(suppliers-80000) > 0.01 {
		t.Fatalf("suppliers = %v; want 80000", suppliers)
	}
	if math.Abs(others-15000) > 0.01 {
		t.Fatalf("others = %v; want 15000", others)
	}
	if math.Abs(suppliers+others-total) > 0.01 {
		t.Fatalf("suppliers+others=%v ≠ total=%v (invariante rota)", suppliers+others, total)
	}
}

func TestParsePaymentSourceAmounts_BoldQrNoAsignaACash(t *testing.T) {
	// REGRESIÓN HISTÓRICA: el fallback por defecto de parsePaymentSourceAmounts
	// manda `expense.Amount` a `CashAmount` cuando el PaymentSource no se
	// reconoce. Antes del 2026-10-23 un egreso con paymentSource='BOLD_QR'
	// terminaba contado como efectivo de caja, inflando la venta del mes y
	// descuadrando el arqueo. La corrección es un short-circuit que detecta
	// Bold QR ANTES del default.
	e := &models.Expense{
		Status:        "PAID",
		Amount:        50000,
		PaymentSource: "BOLD_QR",
	}
	parsePaymentSourceAmounts(e)
	if e.CashAmount != 0 {
		t.Fatalf("EL BUG VOLVIO: egreso BOLD_QR se asignó a CashAmount (%v)", e.CashAmount)
	}
	if e.NequiAmount != 0 || e.DaviplataAmount != 0 || e.FondoAmount != 0 || e.CoinsAmount != 0 {
		t.Fatalf("se contaminó otra columna: %+v", e)
	}
	// Comprobación de identidad: el egreso queda con las cinco columnas en 0
	// y PaymentSource='BOLD_QR'. Es la condición que levantan los
	// agregadores legacy en PostgresExpenseRepository.
	if e.PaymentSource != "BOLD_QR" {
		t.Fatalf("se perdió el identificador BOLD_QR: %q", e.PaymentSource)
	}
}

func TestParsePaymentSourceAmounts_BoldQrVariantes(t *testing.T) {
	// Variantes que el frontend o un script heredado pudieran mandar:
	// todas deben respetar el canal y nunca caer al efectivo.
	for _, src := range []string{"BOLD_QR", "bold_qr", "BoldQR", "BOLD-QR", "BOLD QR"} {
		e := &models.Expense{
			Status:        "PAID",
			Amount:        10000,
			PaymentSource: src,
		}
		parsePaymentSourceAmounts(e)
		if e.CashAmount != 0 {
			t.Errorf("variante %q: CashAmount = %v; want 0", src, e.CashAmount)
		}
	}
}

func TestAssignExpenseChannel_BoldQrNoTocaColumnas(t *testing.T) {
	// assignExpenseChannel es parte de normalizeClosureExpenses (al guardar
	// un cierre). Para BOLD_QR debe comportarse como no-op sobre las
	// columnas desglosadas, igual que PRESTAMO.
	expense := &models.Expense{}
	assignExpenseChannel(expense, "BOLD_QR", 50000)
	if expense.CashAmount != 0 || expense.NequiAmount != 0 || expense.DaviplataAmount != 0 || expense.FondoAmount != 0 || expense.CoinsAmount != 0 {
		t.Fatalf("BOLD_QR contaminó alguna columna: %+v", expense)
	}
}

func TestNormalizeClosureExpenses_PreservaBoldQrSinColumnas(t *testing.T) {
	expenses := []models.Expense{{
		Status:        "PAID",
		Amount:        30000,
		PaymentSource: "BOLD_QR",
	}}
	if err := normalizeClosureExpenses(expenses); err != nil {
		t.Fatalf("normalizeClosureExpenses devolvió error: %v", err)
	}
	got := expenses[0]
	if got.CashAmount != 0 || got.NequiAmount != 0 || got.DaviplataAmount != 0 || got.FondoAmount != 0 || got.CoinsAmount != 0 {
		t.Fatalf("se asignó un canal desglosado para BOLD_QR: %+v", got)
	}
}

// INVARIANTE DE AISLAMIENTO: el total multicanal de Bold QR nunca debe
// filtrarse al arqueo cash-only de caja física.
func TestEgresoBoldQrNoContaminaElArqueo(t *testing.T) {
	c := models.CashierClosure{
		OpeningCash:   200000,
		PhysicalCash:  500000,
		TotalCash:     600000,
		TotalReturns:  0,
		TotalExpenses: 0,
		Expenses: []models.Expense{
			{Status: "PAID", Amount: 100000, PaymentSource: "BOLD_QR", Category: "Servicios"},
		},
	}
	m := ComputeClosureMetrics(&c)

	if m.EgresosCaja != 0 {
		t.Fatalf("EgresosCaja = %v; want 0 (Bold QR NO toca la gaveta)", m.EgresosCaja)
	}
	if m.EgresosBoldQr != 100000 {
		t.Fatalf("EgresosBoldQr = %v; want 100000", m.EgresosBoldQr)
	}

	expected := c.OpeningCash + c.TotalCash - m.EgresosCaja - c.TotalReturns
	if math.Abs(expected-800000) > 0.01 {
		t.Fatalf("efectivo esperado = %v; want 800000 (el egreso BOLD_QR NO reduce el esperado de caja)", expected)
	}
}

// Caso real: un turno con ventas por Bold QR y egresos por Bold QR. El
// cierre debe reflejar el saldo neto en el canal Bold QR aparte del arqueo
// de caja.
func TestCierreCompletoConBoldQR(t *testing.T) {
	c := models.CashierClosure{
		OpeningCash:   100000,
		PhysicalCash:  150000,
		TotalCash:     150000,  // efectivo de ventas del turno
		TotalNequi:    100000,  // ventas Nequi
		TotalDaviplata: 50000,  // ventas Daviplata
		Expenses: []models.Expense{
			{Status: "PAID", Amount: 25000, PaymentSource: "BOLD_QR", Category: "Servicios"},
			{Status: "PAID", Amount: 10000, CashAmount: 10000, Category: "Aseo"},
		},
	}
	m := ComputeClosureMetrics(&c)

	// Egresos por canal
	if m.EgresosCaja != 10000 {
		t.Fatalf("EgresosCaja = %v; want 10000", m.EgresosCaja)
	}
	if m.EgresosBoldQr != 25000 {
		t.Fatalf("EgresosBoldQr = %v; want 25000", m.EgresosBoldQr)
	}
	if math.Abs(m.EgresosTotales-35000) > 0.01 {
		t.Fatalf("EgresosTotales = %v; want 35000", m.EgresosTotales)
	}

	// VentasCajero = PhysicalCash + Digital + EgresosCaja + Returns.
	// NO suma EgresosBoldQr: Bold QR es dinero digital que no estaba en la
	// gaveta.
	wantVentas := m.PhysicalCash + m.DigitalIncome + m.EgresosCaja + m.Returns
	if math.Abs(m.VentasCajero-wantVentas) > 0.01 {
		t.Fatalf("VentasCajero = %v; want %v", m.VentasCajero, wantVentas)
	}
	if m.VentasCajero != 310000 {
		t.Fatalf("VentasCajero = %v; want 310000 (150k físico + 150k digital + 10k egreso caja)", m.VentasCajero)
	}
}

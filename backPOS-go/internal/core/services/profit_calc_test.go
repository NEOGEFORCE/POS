package services

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

func almostEqual(t *testing.T, got, want float64, label string) {
	t.Helper()
	if math.Abs(got-want) > 1.0 {
		t.Errorf("%s: got %.2f, want %.2f", label, got, want)
	}
}

// almostEqualTol compara con una tolerancia mayor. Se usa en las cifras
// derivadas del margen: el brief del negocio las calculó con el margen
// redondeado a 18,6%, mientras el motor usa el exacto (18,5709%), lo que
// produce una diferencia de ~$25 en el costo del excedente.
func almostEqualTol(t *testing.T, got, want, tol float64, label string) {
	t.Helper()
	if math.Abs(got-want) > tol {
		t.Errorf("%s: got %.2f, want %.2f (tolerancia %.0f)", label, got, want, tol)
	}
}

// -------------------------------------------------------------
// Cifras reales de Julio 2026 usadas como caso de aceptación
// -------------------------------------------------------------

const (
	julAuditedIncome = 49_198_976.0 // PASO 1: ingresos auditados en caja
	julKnownSales    = 39_205_900.0 // ventas con costo real registrado
	julKnownCost     = 31_925_002.0 // costo real de esas ventas
	julOpExpenses    = 6_003_680.0  // gastos del local
)

// julLines reproduce el detalle del mes: un tramo con costo real y un
// tramo de ventas rápidas sin costo.
func julLines() []ProfitLine {
	return []ProfitLine{
		{
			Barcode:     "7702011100123",
			Name:        "Productos con código",
			Sales:       julKnownSales,
			CostedSales: julKnownSales,
			KnownCost:   julKnownCost,
		},
		{
			Barcode:       QuickSaleGroupBarcode,
			Name:          QuickSaleGroupName,
			Sales:         3_857_200,
			UncostedSales: 3_857_200,
		},
	}
}

// -------------------------------------------------------------
// Criterio 1: PASO 1 = ingresos auditados ($49.198.976)
// -------------------------------------------------------------

func TestPaso1EsElIngresoAuditadoDeCaja(t *testing.T) {
	agg := AggregateProfitAudited(julLines(), julAuditedIncome)

	almostEqual(t, agg.AuditedIncome, julAuditedIncome, "PASO 1 (ingresos auditados)")

	// El detalle de productos es MENOR que el Paso 1 y no lo limita.
	if agg.DetailSales >= agg.AuditedIncome {
		t.Fatalf("el detalle (%.0f) no debería alcanzar al auditado (%.0f)", agg.DetailSales, agg.AuditedIncome)
	}
}

// -------------------------------------------------------------
// Criterio 2: margen real medido y extrapolado al excedente
// -------------------------------------------------------------

func TestMargenRealMedidoSeAplicaAlExcedente(t *testing.T) {
	agg := AggregateProfitAudited(julLines(), julAuditedIncome)

	// Margen real = (39.205.900 - 31.925.002) / 39.205.900 = 18,57%
	wantMargin := (julKnownSales - julKnownCost) / julKnownSales
	if math.Abs(agg.KnownMargin-wantMargin) > 0.0001 {
		t.Errorf("margen real: got %.4f, want %.4f", agg.KnownMargin, wantMargin)
	}
	if agg.KnownMargin < 0.18 || agg.KnownMargin > 0.19 {
		t.Errorf("el margen real de julio debería rondar 18,6%%, got %.2f%%", agg.KnownMargin*100)
	}

	// Excedente auditado = 49.198.976 - 39.205.900 = 9.993.076
	almostEqual(t, agg.UncostedSales, 9_993_076, "excedente auditado")

	// Ganancia adicional = excedente * margen real ~ 1.855.832
	almostEqual(t, agg.UncostedProfit, agg.UncostedSales*wantMargin, "ganancia del excedente")
	almostEqual(t, agg.UncostedCost, agg.UncostedSales-agg.UncostedProfit, "costo del excedente")

	// Estado de resultados de julio 2026
	almostEqual(t, agg.KnownProfit, 7_280_898, "ganancia del tramo medido")
	almostEqualTol(t, agg.TotalCost, 40_062_246, 50, "PASO 2 (costo total)")
	almostEqualTol(t, agg.GrossProfit, 9_136_730, 50, "PASO 3 (ganancia bruta)")

	// PASO 5
	almostEqualTol(t, FreeProfit(agg.GrossProfit, julOpExpenses), 3_133_050, 50, "PASO 5 (ganancia libre)")

	// Coherencia: el margen general no puede diferir del medido, porque el
	// mismo margen se aplicó a todo el ingreso auditado.
	if math.Abs(agg.OverallMargin()-agg.KnownMargin) > 0.0001 {
		t.Errorf("margen general %.4f debería igualar el medido %.4f", agg.OverallMargin(), agg.KnownMargin)
	}
}

func TestNoHayPorcentajesFijos(t *testing.T) {
	// Con un margen real del 30% el excedente debe valorarse al 30%,
	// no al 20% de la regla antigua.
	lines := []ProfitLine{
		{Barcode: "7702011100123", Sales: 1_000_000, CostedSales: 1_000_000, KnownCost: 700_000},
	}
	agg := AggregateProfitAudited(lines, 2_000_000)

	almostEqual(t, agg.KnownMargin*100, 30, "margen real medido")
	almostEqual(t, agg.UncostedSales, 1_000_000, "excedente")
	almostEqual(t, agg.UncostedProfit, 300_000, "ganancia del excedente al 30%")
	almostEqual(t, agg.GrossProfit, 600_000, "ganancia bruta total")
}

func TestMargenDeRespaldoSoloSinDatos(t *testing.T) {
	// Sin ninguna venta con costo real no se puede medir el margen:
	// se usa el de respaldo.
	agg := AggregateProfitAudited(nil, 1_000_000)
	almostEqual(t, agg.KnownMargin, DefaultFallbackMargin, "margen de respaldo")
	almostEqual(t, agg.GrossProfit, 200_000, "ganancia con margen de respaldo")

	// Costo mayor que la venta: dato inservible para extrapolar.
	bad := []ProfitLine{{Barcode: "111", Sales: 100, CostedSales: 100, KnownCost: 200}}
	if got := AggregateProfitAudited(bad, 100).KnownMargin; got != DefaultFallbackMargin {
		t.Errorf("margen con costo>venta: got %.4f, want respaldo", got)
	}
}

func TestPaso1NuncaPorDebajoDeLoMedido(t *testing.T) {
	// Si la caja reporta menos que lo ya medido con costo real, el Paso 1
	// se eleva para no producir un costo mayor que el ingreso.
	lines := []ProfitLine{
		{Barcode: "111", Sales: 1_000_000, CostedSales: 1_000_000, KnownCost: 800_000},
	}
	agg := AggregateProfitAudited(lines, 400_000)
	almostEqual(t, agg.AuditedIncome, 1_000_000, "Paso 1 elevado al tramo medido")
	almostEqual(t, agg.UncostedSales, 0, "sin excedente")
	if agg.GrossProfit <= 0 {
		t.Error("la ganancia bruta no debería ser negativa por un cierre incompleto")
	}
}

func TestCostoPorLineaUsaElMargenMedido(t *testing.T) {
	quick := ProfitLine{Barcode: "MISC-", Sales: 10_000, UncostedSales: 10_000}
	// Con margen real del 18,57% el costo de la venta rápida es el 81,43%
	almostEqual(t, quick.CostAt(0.1857), 8_143, "costo de venta rápida al margen real")

	normal := ProfitLine{Barcode: "7702011100123", Sales: 6_250, CostedSales: 6_250, KnownCost: 5_000}
	almostEqual(t, normal.CostAt(0.1857), 5_000, "el producto con costo real no se extrapola")
}

func TestVentasRapidasSeIdentifican(t *testing.T) {
	quick := []string{"MISC-1", "misc-abc", "MISC", "0000", "", "  0000  "}
	for _, b := range quick {
		if !IsQuickSaleBarcode(b) {
			t.Errorf("%q debería ser venta rápida", b)
		}
	}
	if IsQuickSaleBarcode("7702011100123") {
		t.Error("un código de barras real no es venta rápida")
	}
}

// -------------------------------------------------------------
// Criterio 3: gastos del local (PASO 4)
// -------------------------------------------------------------

func TestGananciaLibreSoloRestaGastosDelLocal(t *testing.T) {
	type expense struct {
		category    string
		description string
		hasSupplier bool
		amount      float64
	}
	expenses := []expense{
		{"NOMINA", "Quincena empleados", false, 3_000_000},
		{"SERVICIOS", "Pago de luz ENEL", false, 800_000},
		{"ARRIENDO", "Arriendo del local", false, 2_000_000},
		{"MANTENIMIENTO", "Arreglo de nevera", false, 200_000},
		{"SERVICIOS", "CUOTA BANCO - obligación mensual", false, 615_900},
		// Los siguientes NO deben restarse
		{"PROVEEDORES", "Pago de proveedor POSTOBON", true, 5_000_000},
		{"COMPRAS", "Recepción de mercancía ALPINA", false, 4_000_000},
		{"PRESTAMOS", "Abono a deuda de inventario", false, 1_500_000},
		{"VARIOS", "MANTEQUILLA DE CERDO", false, 46_000},
		{"VARIOS", "Deuda COLOMBINA", false, 300_000},
	}

	var opExpenses float64
	byCategory := map[string]float64{}
	for _, e := range expenses {
		if IsMerchandiseExpense(e.category, e.description, e.hasSupplier) {
			continue
		}
		opExpenses += e.amount
		byCategory[ClassifyOpExpense(e.category, e.description)] += e.amount
	}

	almostEqual(t, opExpenses, 6_615_900, "gastos operativos del local")
	almostEqual(t, byCategory[OpExpensePayroll], 3_000_000, "nómina")
	almostEqual(t, byCategory[OpExpenseServices], 800_000, "servicios públicos (sin cuota banco)")
	almostEqual(t, byCategory[OpExpenseRent], 2_000_000, "arriendo")
	almostEqual(t, byCategory[OpExpenseMaintenance], 200_000, "mantenimiento")
	almostEqual(t, byCategory[OpExpenseFinancial], 615_900, "obligaciones bancarias")
}

func TestExclusionDeInsumosYMercancia(t *testing.T) {
	mercancia := []struct{ category, description string }{
		{"VARIOS", "MANTEQUILLA DE CERDO"},
		{"GASTOS", "Compra de pollo"},
		{"VARIOS", "CARNE DE RES"},
		{"VARIOS", "Huevos AA canasta"},
		{"VARIOS", "Queso campesino"},
		{"VARIOS", "Insumos para la venta"},
		{"VARIOS", "Recepcion de mercancia"},
		{"INSUMOS", "Surtido de la semana"},
		{"VARIOS", "Abono deuda COLOMBINA"},
		{"VARIOS", "Factura RAMO"},
		{"VARIOS", "Pedido semanal"},
	}
	for _, m := range mercancia {
		if !IsMerchandiseExpense(m.category, m.description, false) {
			t.Errorf("%q debería contarse como mercancía y excluirse de los gastos del local", m.description)
		}
	}

	// Estos SÍ son gastos del local.
	operativos := []struct{ category, description string }{
		{"SERVICIOS", "Pago de luz"},
		{"NOMINA", "Sueldo de Maria"},
		{"ARRIENDO", "Arriendo del local"},
		{"BANCO", "Intereses del mes"},
		{"VARIOS", "Presupuesto de papeleria"},
		{"MANTENIMIENTO", "Reparación de estantería"},
	}
	for _, o := range operativos {
		if IsMerchandiseExpense(o.category, o.description, false) {
			t.Errorf("%q NO es mercancía: debe restarse como gasto del local", o.description)
		}
	}
}

func TestCuotaBancoNoSumaEnServiciosPublicos(t *testing.T) {
	cases := []struct{ category, description, want string }{
		{"SERVICIOS", "CUOTA BANCO", OpExpenseFinancial},
		{"SERVICIOS PUBLICOS", "Cuota banco Bancolombia", OpExpenseFinancial},
		{"BANCO", "Intereses obligación", OpExpenseFinancial},
		{"SERVICIOS", "Recibo de luz", OpExpenseServices},
		{"SERVICIOS", "Internet fibra", OpExpenseServices},
		{"ARRIENDO", "Cuota de arriendo del local", OpExpenseRent},
	}
	for _, c := range cases {
		if got := ClassifyOpExpense(c.category, c.description); got != c.want {
			t.Errorf("%s/%s: got %s, want %s", c.category, c.description, got, c.want)
		}
	}
}

// -------------------------------------------------------------
// Formato de moneda bogotana
// -------------------------------------------------------------

func TestFormatoMonedaBogotana(t *testing.T) {
	cases := map[float64]string{
		0:        "$ 0",
		1234:     "$ 1.234",
		1234567:  "$ 1.234.567",
		49198976: "$ 49.198.976",
		-1234567: "-$ 1.234.567",
	}
	for in, want := range cases {
		if got := fmtCOP(in); got != want {
			t.Errorf("fmtCOP(%.0f): got %q, want %q", in, got, want)
		}
	}
	if got := fmtCOPNeg(6_003_680); got != "-$ 6.003.680" {
		t.Errorf("fmtCOPNeg: got %q", got)
	}
	if got := fmtPercent(0.1857); got != "18,6%" {
		t.Errorf("fmtPercent: got %q", got)
	}
}

// -------------------------------------------------------------
// PDF: los módulos nuevos deben quedar visibles
// -------------------------------------------------------------

func julReport() *ProfitabilityReport {
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 7, 31, 23, 59, 0, 0, time.UTC)
	agg := AggregateProfitAudited(julLines(), julAuditedIncome)

	return &ProfitabilityReport{
		From: from, To: to, TargetMargin: 0.17,
		TotalSales:        agg.AuditedIncome,
		TotalCost:         agg.TotalCost,
		GrossProfit:       agg.GrossProfit,
		OverallMargin:     agg.OverallMargin(),
		KnownSales:        agg.KnownSales,
		KnownCost:         agg.KnownCost,
		KnownProfit:       agg.KnownProfit,
		KnownMargin:       agg.KnownMargin,
		UncostedSales:     agg.UncostedSales,
		UncostedCost:      agg.UncostedCost,
		UncostedProfit:    agg.UncostedProfit,
		QuickSales:        agg.QuickSales,
		SalesFromRegister: 43_500_000,
		SalesFromClosures: 44_721_265,
		SalesFromDetails:  agg.DetailSales,
		Audited: &AuditedIncome{
			Total:        julAuditedIncome,
			PhysicalCash: 30_000_000,
			Digital:      12_000_000,
			CashExpenses: 6_000_000,
			Returns:      1_198_976,
			SystemTotal:  44_721_265,
			ClosureCount: 62,
			Closing: func() ClosingBalances {
				c := ClosingBalances{
					HasData:      true,
					ClosureID:    119,
					ClosedAt:     time.Date(2026, 7, 31, 21, 30, 0, 0, time.UTC),
					ClosedByName: "MARIA LOPEZ",
					Cash:         388_881,
					Nequi:        202_874,
					Daviplata:    114_030,
				}
				c.Total = c.Cash + c.Nequi + c.Daviplata
				return c
			}(),
		},
		PayrollExp:      3_000_000,
		RentExp:         2_000_000,
		FinancialExp:    615_900,
		TotalOpExpenses: julOpExpenses,
		NetProfit:       FreeProfit(agg.GrossProfit, julOpExpenses),
		OpExpenseItems: []OpExpenseRow{
			{Date: from, Category: "NOMINA", Description: "Quincena de julio", PaymentSource: "CAJA", Amount: 3_000_000},
		},
		TotalCreditReceivable: 1_503_200,
		CreditReceivables: []CreditReceivableRow{
			{ClientName: "Ana Pérez", ClientDNI: "1122334", Phone: "3001234567", Balance: 1_503_200},
		},
		TotalDebtsPayable: 7_110_280,
		DebtsPayable: []DebtPayableRow{
			{ProviderName: "COLOMBINA", Concept: "Mercancía a crédito", Balance: 4_000_000},
			{ProviderName: "RAMO", Concept: "Factura pendiente", Balance: 2_110_280},
			{ProviderName: "PLASTICOS", Concept: "Insumos", Balance: 1_000_000},
		},
		Rows: []ProfitabilityRow{
			{ProductName: "Arroz 500g", Barcode: "7702011100123", UnitsSold: 120, GrossSales: 600_000, GrossCost: 500_000, GrossProfit: 100_000, MarginPct: 0.16},
			{ProductName: QuickSaleGroupName, Barcode: QuickSaleGroupBarcode, GrossSales: 3_857_200, GrossCost: 3_141_000, GrossProfit: 716_200, MarginPct: 0.1857, MeetsTarget: true, IsQuickSale: true},
		},
		WorkingCapital: func() *WorkingCapital {
			w := julWorkingCapital(FreeProfit(agg.GrossProfit, julOpExpenses))
			w.CashClosing = 705_785
			w.CashDelta = w.CashClosing - w.CashOpening
			w.Explained = w.InventoryDelta + w.ReceivableDelta + w.CashDelta + w.PayableDelta
			w.OtherMovements = w.NetProfit - w.Explained
			w.CreditSalesInPeriod = 2_400_000
			w.CreditPaymentsInPeriod = 1_996_800
			w.NewDebtInPeriod = 5_000_000
			w.DebtPaidInPeriod = 7_129_720
			return &w
		}(),
	}
}

func TestReporteDeJulioCuadraDePuntaAPunta(t *testing.T) {
	r := julReport()

	almostEqual(t, r.TotalSales, 49_198_976, "PASO 1")
	almostEqualTol(t, r.TotalCost, 40_062_246, 50, "PASO 2")
	almostEqualTol(t, r.GrossProfit, 9_136_730, 50, "PASO 3")
	almostEqual(t, r.TotalOpExpenses, 6_003_680, "PASO 4")
	almostEqualTol(t, r.NetProfit, 3_133_050, 50, "PASO 5")
	almostEqual(t, r.TotalDebtsPayable, 7_110_280, "deudas activas del Centro de Pagos")
	almostEqual(t, r.TotalCreditReceivable, 1_503_200, "cartera por cobrar")
	almostEqual(t, r.Audited.Closing.Total, 705_785, "TOTAL GENERAL GUARDADO que pasa al mes siguiente")

	// Los 5 pasos deben encadenar sin huecos.
	almostEqual(t, r.TotalSales-r.TotalCost, r.GrossProfit, "Paso1 - Paso2 = Paso3")
	almostEqual(t, r.GrossProfit-r.TotalOpExpenses, r.NetProfit, "Paso3 - Paso4 = Paso5")
}

func TestGenerateProfitabilityPDFIncluyeModulosNuevos(t *testing.T) {
	svc := &ExportService{}
	buf, err := svc.GenerateProfitabilityPDF(julReport())
	if err != nil {
		t.Fatalf("GenerateProfitabilityPDF: %v", err)
	}
	if buf.Len() < 1000 {
		t.Fatalf("PDF sospechosamente pequeño: %d bytes", buf.Len())
	}
	if string(buf.Bytes()[:4]) != "%PDF" {
		t.Fatal("el archivo generado no es un PDF")
	}
}

// TestPDFNoTieneSeccionDeProductos verifica que la tabla por producto ya
// no se genera, aunque el reporte traiga los datos cargados.
func TestPDFNoTieneSeccionDeProductos(t *testing.T) {
	svc := &ExportService{}

	r := julReport()
	if len(r.Rows) == 0 {
		t.Fatal("el reporte de prueba debe traer productos para que la prueba tenga sentido")
	}

	conProductos, err := svc.GenerateProfitabilityPDF(r)
	if err != nil {
		t.Fatalf("con productos: %v", err)
	}

	// El mismo reporte sin productos debe producir un PDF del mismo
	// tamaño: si la sección se hubiera dibujado, el primero sería mayor.
	sinProductos := julReport()
	sinProductos.Rows = nil
	limpio, err := svc.GenerateProfitabilityPDF(sinProductos)
	if err != nil {
		t.Fatalf("sin productos: %v", err)
	}

	if conProductos.Len() != limpio.Len() {
		t.Errorf("el PDF sigue dibujando los productos: %d bytes con productos vs %d sin ellos",
			conProductos.Len(), limpio.Len())
	}
}

func TestSaldosAlCierreSonLaSumaDeLosTresCanales(t *testing.T) {
	// El total guardado es solo caja + Nequi + Daviplata: ya no se suman
	// tarjetas ni bancos, que eran movimientos del turno y no un saldo.
	c := ClosingBalances{Cash: 2_450_000, Nequi: 1_120_000, Daviplata: 680_000}
	c.Total = c.Cash + c.Nequi + c.Daviplata
	almostEqual(t, c.Total, 4_250_000, "total general guardado")
}

func TestNotaDelSaldoInicialEstaEnElTexto(t *testing.T) {
	// Se verifica la nota REAL que inyecta el PDF (misma función).
	r := julReport()
	nota := closingBalanceNote(r.Audited.Closing, r.TotalSales)

	for _, frase := range []string{
		"BASE O SALDO INICIAL",
		"arranca el mes siguiente",
		"31/07/2026",
		"MARIA LOPEZ",
		"$ 49.198.976",
	} {
		if !strings.Contains(nota, frase) {
			t.Errorf("la nota del saldo inicial debe contener %q\nnota: %s", frase, nota)
		}
	}
}

// -------------------------------------------------------------
// Distribución de la ganancia: ¿dónde quedó repartida?
// -------------------------------------------------------------

// julWorkingCapital reproduce las fotos de julio 2026.
func julWorkingCapital(netProfit float64) WorkingCapital {
	return ComputeWorkingCapital(WorkingCapitalInput{
		InventoryOpening: 18_000_000, InventoryClosing: 21_200_000, // surtido creció 3,2M
		ReceivableOpening: 1_100_000, ReceivableClosing: 1_503_200, // calle creció 403.200
		PayableOpening: 9_240_000, PayableClosing: 7_110_280, // deuda bajó 2.129.720
		CashOpening: 350_000, CashClosing: 776_000, // efectivo creció 426.000
		NetProfit: netProfit,
	})
}

func TestDistribucionDeLaGananciaIncluyeInventario(t *testing.T) {
	const netProfit = 3_132_803.0
	w := julWorkingCapital(netProfit)

	almostEqual(t, w.InventoryDelta, 3_200_000, "mercancía que quedó de más en el local")
	almostEqual(t, w.ReceivableDelta, 403_200, "plata que quedó en la calle")
	almostEqual(t, w.PayableDelta, 2_129_720, "plata usada para pagar mercancía")
	almostEqual(t, w.CashDelta, 426_000, "efectivo que creció")

	almostEqual(t, w.Explained, 3_200_000+403_200+2_129_720+426_000, "suma de los cuatro movimientos")
	almostEqual(t, w.OtherMovements, netProfit-w.Explained, "movimientos no operativos")
}

func TestLaDistribucionSiempreSumaLaGananciaLibre(t *testing.T) {
	// Criterio clave: la tabla no puede dejar "diferencias sin explicar".
	// La suma de TODAS las filas debe dar exactamente la ganancia libre.
	for _, netProfit := range []float64{3_132_803, 0, -1_500_000, 12_000_000} {
		w := julWorkingCapital(netProfit)

		var sum float64
		for _, l := range w.Distribution() {
			sum += l.Delta
		}
		almostEqual(t, sum, netProfit, fmt.Sprintf("distribución con ganancia %.0f", netProfit))
	}
}

func TestFilaDeMovimientosNoOperativosTieneNombrePropio(t *testing.T) {
	// Cuando hay diferencia, la fila debe llamarse por lo que es, nunca
	// "diferencia sin explicar".
	w := julWorkingCapital(3_132_803)
	lines := w.Distribution()

	if len(lines) != 5 {
		t.Fatalf("con movimientos no operativos deben haber 5 filas, hay %d", len(lines))
	}
	last := lines[4]
	if strings.Contains(strings.ToLower(last.Concept), "sin explicar") {
		t.Errorf("la fila no debe decir 'sin explicar': %q", last.Concept)
	}
	if !strings.Contains(last.Concept, "Retiros") {
		t.Errorf("la fila debe nombrar los retiros: %q", last.Concept)
	}

	// Si la distribución cuadra exacta, esa fila no aparece.
	exact := julWorkingCapital(6_158_920) // = suma de los cuatro deltas
	if got := len(exact.Distribution()); got != 4 {
		t.Errorf("cuando cuadra exacto deben ser 4 filas, hay %d", got)
	}
}

func TestSignosDeLaDistribucion(t *testing.T) {
	// Caso en contra: inventario baja, cartera baja, deuda sube, efectivo baja.
	w := ComputeWorkingCapital(WorkingCapitalInput{
		InventoryOpening: 20_000_000, InventoryClosing: 18_000_000,
		ReceivableOpening: 2_000_000, ReceivableClosing: 1_500_000,
		PayableOpening: 5_000_000, PayableClosing: 6_000_000,
		CashOpening: 900_000, CashClosing: 400_000,
	})

	if w.InventoryDelta >= 0 {
		t.Error("si el surtido baja, el delta debe ser negativo")
	}
	if w.ReceivableDelta >= 0 {
		t.Error("si la cartera baja, el delta debe ser negativo")
	}
	if w.PayableDelta >= 0 {
		t.Error("si la deuda sube, el delta debe ser negativo")
	}
	if w.CashDelta >= 0 {
		t.Error("si el efectivo baja, el delta debe ser negativo")
	}
	almostEqual(t, w.Explained, -4_000_000, "todo en contra")
}

func TestExplicacionesEnLenguajeHumano(t *testing.T) {
	w := julWorkingCapital(3_132_803)
	lines := w.Distribution()

	if !strings.Contains(lines[0].Meaning, "surtido") {
		t.Errorf("el inventario debe explicarse como surtido: %q", lines[0].Meaning)
	}
	if !strings.Contains(lines[1].Meaning, "calle") {
		t.Errorf("la cartera debe explicarse como plata en la calle: %q", lines[1].Meaning)
	}
	if !strings.Contains(lines[2].Meaning, "Efectivo") {
		t.Errorf("el efectivo debe explicarse como disponible: %q", lines[2].Meaning)
	}
	if !strings.Contains(lines[3].Meaning, "mercancía") {
		t.Errorf("la deuda debe explicarse como pago de mercancía: %q", lines[3].Meaning)
	}
}

// -------------------------------------------------------------
// Criterio 2: la narrativa del inventario debe ser explícita
// -------------------------------------------------------------

func TestNarrativaDeInventarioEsExplicita(t *testing.T) {
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 7, 31, 23, 59, 0, 0, time.UTC)

	texto := InventoryNarrative(from, to, 18_000_000, 21_200_000)

	for _, frase := range []string{
		"Al 1 de julio de 2026 iniciamos con $ 18.000.000",
		"al 31 de julio de 2026 finalizamos con $ 21.200.000",
		"Hay $ 3.200.000 más en mercancía dentro del local",
		"ganancia del mes reinvertida en producto",
	} {
		if !strings.Contains(texto, frase) {
			t.Errorf("la narrativa debe contener %q\ntexto: %s", frase, texto)
		}
	}

	// Caso inverso
	bajo := InventoryNarrative(from, to, 21_000_000, 18_000_000)
	if !strings.Contains(bajo, "menos en mercancía") {
		t.Errorf("si el inventario baja debe decirlo: %s", bajo)
	}
}

func TestFechasEnEspanol(t *testing.T) {
	// Go no localiza fechas: se valida que el mes salga en español y no
	// siempre "enero" (bug clásico de usar un layout inválido).
	casos := map[time.Time]string{
		time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC):   "1 de julio de 2026",
		time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC): "31 de diciembre de 2026",
		time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC):  "15 de enero de 2026",
	}
	for in, want := range casos {
		if got := formatSpanishDate(in); got != want {
			t.Errorf("formatSpanishDate: got %q, want %q", got, want)
		}
	}
}

// -------------------------------------------------------------
// Criterio 1: Sección 5 sincronizada con el Dashboard
// -------------------------------------------------------------

func TestSaldosCoincidenConTotalGeneralGuardadoDelDashboard(t *testing.T) {
	// Cifras de ejemplo de la tarjeta "TOTAL GENERAL GUARDADO
	// (CAJA + DIGITAL)" del Centro de Control.
	c := ClosingBalances{
		Cash:      388_881,
		Nequi:     202_874,
		Daviplata: 114_030,
		HasData:   true,
	}
	c.Total = c.Cash + c.Nequi + c.Daviplata

	almostEqual(t, c.Total, 705_785, "TOTAL GENERAL GUARDADO (CAJA + DIGITAL)")
	// La plata en mano del análisis patrimonial debe ser ese mismo total:
	// no puede haber dos cifras distintas de dinero disponible.
	almostEqual(t, c.CashOnHand(), c.Total, "plata en mano == total guardado")

	// Nequi y Daviplata NO pueden quedar en cero cuando el acumulado los tiene.
	if c.Nequi == 0 || c.Daviplata == 0 {
		t.Error("las billeteras digitales no deben quedar en cero")
	}
}

func TestSaldoRealSeccion5NoImprimeSumatoriaDeVentas(t *testing.T) {
	// Criterio de Aceptación 1: La Sección 5 NO debe imprimir $20.333.300 (la sumatoria de ingresos),
	// sino el saldo real disponible en el Dashboard (~$705.785).
	incorrectSum := 20_333_300.0
	rep := julReport()
	c := rep.Audited.Closing

	if c.Total == incorrectSum {
		t.Fatalf("La Sección 5 no debe imprimir la sumatoria de ingresos del mes ($%.2f)", incorrectSum)
	}

	almostEqual(t, c.Total, 705_785, "Saldo real final Sección 5 (Dashboard)")
}

func TestCascadaSeccion7CuadraConNuevoDeltaEfectivo(t *testing.T) {
	// Criterio de Aceptación 2: Al corregir la Sección 5, la tabla de distribución
	// de la Sección 7 cuadra matemáticamente con el nuevo DeltaEfectivo sin distorsionarse.
	r := julReport()
	w := r.WorkingCapital
	if w == nil {
		t.Fatal("WorkingCapital no debe ser nulo")
	}

	almostEqual(t, w.CashClosing, 705_785, "EfectivoFinal real Sección 5")
	almostEqual(t, w.CashDelta, w.CashClosing-w.CashOpening, "DeltaEfectivo")

	// Verificación de conciliación patrimonial:
	// NetProfit = InventoryDelta + ReceivableDelta + CashDelta + PayableDelta + OtherMovements
	calculatedExplained := w.InventoryDelta + w.ReceivableDelta + w.CashDelta + w.PayableDelta
	almostEqual(t, w.Explained, calculatedExplained, "Explained coincide con la suma de deltas")
	almostEqual(t, w.NetProfit, w.Explained+w.OtherMovements, "NetProfit = Explained + OtherMovements")

	// La distorsión previa del bug (-$68.817.974 en fila 5) debe ser eliminada
	if math.Abs(w.OtherMovements) > 50_000_000 {
		t.Errorf("OtherMovements sigue distorsionado por sumatoria incorrecta: got %.2f", w.OtherMovements)
	}
}

func TestPlataEnManoEsElTotalGuardado(t *testing.T) {
	b := ClosingBalances{Cash: 526_000, Nequi: 180_000, Daviplata: 70_000}
	b.Total = b.Cash + b.Nequi + b.Daviplata
	almostEqual(t, b.CashOnHand(), 776_000, "plata en mano")
}

// -------------------------------------------------------------
// Criterio 2: escenarios de "Libre Libre"
// -------------------------------------------------------------

func TestEscenarioAGananciaTodaEnMercancia(t *testing.T) {
	// Julio 2026: la ganancia libre es menor que el crecimiento del surtido.
	const netProfit = 3_132_803.0
	const inventoryDelta = 10_278_697.0

	liq := ComputeProfitLiquidity(netProfit, inventoryDelta)

	if liq.Scenario != LiquidityAllMerchandise {
		t.Errorf("escenario: got %q, want A", liq.Scenario)
	}
	almostEqual(t, liq.InMerchandise, 3_132_803, "atrapado en mercancía")
	almostEqual(t, liq.Liquid, 0, "dinero líquido")
	almostEqual(t, liq.MerchandisePct*100, 100, "porcentaje en mercancía")
	almostEqual(t, liq.LiquidPct*100, 0, "porcentaje líquido")

	for _, frase := range []string{"100%", "reinvirtió", "surtido", "$ 10.278.697"} {
		if !strings.Contains(liq.Explanation, frase) {
			t.Errorf("la explicación debe mencionar %q\ntexto: %s", frase, liq.Explanation)
		}
	}
}

func TestEscenarioBGananciaMixta(t *testing.T) {
	liq := ComputeProfitLiquidity(5_000_000, 2_000_000)

	if liq.Scenario != LiquidityMixed {
		t.Errorf("escenario: got %q, want B", liq.Scenario)
	}
	almostEqual(t, liq.InMerchandise, 2_000_000, "en mercancía")
	almostEqual(t, liq.Liquid, 3_000_000, "líquido")
	almostEqual(t, liq.MerchandisePct*100, 40, "porcentaje en mercancía")
	almostEqual(t, liq.LiquidPct*100, 60, "porcentaje líquido")
	if !strings.Contains(liq.Explanation, "Libre Libre") {
		t.Errorf("debe usar el término del dueño: %s", liq.Explanation)
	}
}

func TestEscenarioCGananciaTodaLiquida(t *testing.T) {
	// El inventario bajó: no absorbió nada de la ganancia.
	liq := ComputeProfitLiquidity(4_000_000, -1_500_000)

	if liq.Scenario != LiquidityAllLiquid {
		t.Errorf("escenario: got %q, want C", liq.Scenario)
	}
	almostEqual(t, liq.InMerchandise, 0, "en mercancía")
	almostEqual(t, liq.Liquid, 4_000_000, "líquido")
	almostEqual(t, liq.LiquidPct*100, 100, "porcentaje líquido")

	// Inventario exactamente igual también es escenario C.
	if got := ComputeProfitLiquidity(4_000_000, 0).Scenario; got != LiquidityAllLiquid {
		t.Errorf("con inventario plano el escenario debe ser C, got %q", got)
	}
}

func TestEscenarioPerdidaNoRepartePorcentajes(t *testing.T) {
	liq := ComputeProfitLiquidity(-800_000, 3_000_000)

	if liq.Scenario != LiquidityLoss {
		t.Errorf("escenario: got %q, want D", liq.Scenario)
	}
	almostEqual(t, liq.InMerchandise, 0, "sin ganancia que repartir")
	// Sin ganancia los porcentajes quedan en cero, nunca en infinito.
	almostEqual(t, liq.MerchandisePct, 0, "porcentaje en mercancía")
	almostEqual(t, liq.LiquidPct, 0, "porcentaje líquido")
}

func TestLiquidezSiempreSumaLaGanancia(t *testing.T) {
	casos := [][2]float64{
		{3_132_803, 10_278_697}, {5_000_000, 2_000_000},
		{4_000_000, -1_500_000}, {1_000_000, 1_000_000}, {2_500_000, 0},
	}
	for _, c := range casos {
		liq := ComputeProfitLiquidity(c[0], c[1])
		almostEqual(t, liq.InMerchandise+liq.Liquid, c[0],
			fmt.Sprintf("ganancia %.0f con inventario %.0f", c[0], c[1]))
	}
}

func TestFormatoDeVariacionMuestraSigno(t *testing.T) {
	if got := fmtCOPSigned(403_200); got != "+$ 403.200" {
		t.Errorf("variación positiva: got %q", got)
	}
	if got := fmtCOPSigned(-500_000); got != "-$ 500.000" {
		t.Errorf("variación negativa: got %q", got)
	}
}

func TestRenderPDFSmoke(t *testing.T) {
	svc := &ExportService{}
	p := ReportPayload{
		Title:    "Mermas y Averías",
		Subtitle: "Productos dados de baja, vencidos o dañados",
		From:     time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
		To:       time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC),
		Headers:  []string{"Fecha", "Producto", "Motivo", "Cantidad", "Costo Unit.", "Pérdida"},
		Rows: [][]string{
			{"=== JULIO ===", "", "", "", "", ""},
			{"05/07/2026", "Leche entera 1L", "Vencido", "3", fmtCOP(3200), fmtCOP(9600)},
			{"11/07/2026", "Pan tajado", "Dañado", "2", fmtCOP(4500), fmtCOP(9000)},
		},
		Totals: []string{"TOTAL", "", "", "5", "", fmtCOP(18600)},
		Footer: "Desglose por motivo: Vencido " + fmtCOP(9600) + " · Dañado " + fmtCOP(9000),
	}
	out, err := svc.RenderPDF(p)
	if err != nil {
		t.Fatalf("RenderPDF: %v", err)
	}
	if len(out) < 1000 || string(out[:4]) != "%PDF" {
		t.Fatalf("PDF inválido (%d bytes)", len(out))
	}
}

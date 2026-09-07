package services

import (
	"math"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// FUENTE ÚNICA DE VERDAD DE LA TARJETA "EGRESOS DEL TURNO" (dashboard)
// ============================================================================
//
// La tarjeta consumía dos números:
//   amount = shiftClosure.TotalExpenses  (solo EFECTIVO DE CAJA)
//   count  = len(shiftClosure.Expenses)   (incluía pendientes, préstamos y
//                                          devoluciones)
//
// El dueño reportó que el número se veía más chico que la suma de egresos
// del turno en el modal de auditoría. La causa era la diferencia de universo:
// TotalExpenses solo cuenta la caja, mientras que la auditoría suma todos los
// canales (caja + Nequi + Daviplata + fondo + alcancía).
//
// A partir de ahora la tarjeta usa el UNIVERSO CANÓNICO:
//   amount = ComputeClosureMetrics(shiftClosure).EgresosTotales
//   count  = misma población (líneas que aportaron a ese total)
//
// TotalExpenses del cierre queda intacto porque alimenta ExpectedCash y el
// arqueo de caja física; solo la tarjeta del dashboard cambia.
// ============================================================================

func TestComputeShiftExpenseTotals_MultiCanalCanonico(t *testing.T) {
	// Egresos típicos del turno con desglose por canal.
	expenses := []models.Expense{
		{Status: "PAID", Amount: 100000, PaymentSource: "CAJA", CashAmount: 100000, Category: "Servicios"},
		{Status: "PAID", Amount: 50000, PaymentSource: "NEQUI", NequiAmount: 50000, Category: "Aseo"},
		{Status: "PAID", Amount: 30000, PaymentSource: "DAVIPLATA", DaviplataAmount: 30000, Category: "Papelería"},
		{Status: "PAID", Amount: 80000, PaymentSource: "FONDO", FondoAmount: 80000, Category: "Proveedores"},
		{Status: "PAID", Amount: 15000, PaymentSource: "ALCANCIA", CoinsAmount: 15000, Category: "Aseo"},
	}
	total, count := ComputeShiftExpenseTotals(expenses)
	if math.Abs(total-275000) > 0.01 {
		t.Fatalf("total canónico = %v; want 275000", total)
	}
	if count != 5 {
		t.Fatalf("count = %d; want 5", count)
	}
}

func TestComputeShiftExpenseTotals_ExcluyePending(t *testing.T) {
	expenses := []models.Expense{
		{Status: "PAID", Amount: 100000, CashAmount: 100000},
		{Status: "PENDING", Amount: 500000, PaymentSource: "PRESTAMO"},
		{Status: "PENDING", Amount: 200000, PaymentSource: "CAJA", CashAmount: 200000},
	}
	total, count := ComputeShiftExpenseTotals(expenses)
	if total != 100000 {
		t.Fatalf("total = %v; want 100000 (los PENDING no aportan)", total)
	}
	if count != 1 {
		t.Fatalf("count = %d; want 1", count)
	}
}

func TestComputeShiftExpenseTotals_ExcluyePrestamos(t *testing.T) {
	// Un egreso pagado con PRESTAMO no representa salida de caja todavía.
	expenses := []models.Expense{
		{Status: "PAID", Amount: 100000, CashAmount: 100000},
		{Status: "PAID", Amount: 250000, PaymentSource: "PRESTAMO"},
		{Status: "PAID", Amount: 250000, PaymentSource: "DEUDA"},
	}
	total, count := ComputeShiftExpenseTotals(expenses)
	if total != 100000 {
		t.Fatalf("total = %v; want 100000 (préstamos/deudas no cuentan)", total)
	}
	if count != 1 {
		t.Fatalf("count = %d; want 1", count)
	}
}

func TestComputeShiftExpenseTotals_ExcluyeDevoluciones(t *testing.T) {
	// Las devoluciones se registran como egresos de categoría DEVOLUCIONES,
	// pero el arqueo las cuenta aparte vía TotalReturns. Contarlas aquí
	// duplicaría el impacto en la venta del cajero.
	expenses := []models.Expense{
		{Status: "PAID", Amount: 100000, CashAmount: 100000, Category: "Servicios"},
		{Status: "PAID", Amount: 20000, CashAmount: 20000, Category: "DEVOLUCIONES"},
		{Status: "PAID", Amount: 10000, CashAmount: 10000, Category: "devoluciones"},
	}
	total, count := ComputeShiftExpenseTotals(expenses)
	if total != 100000 {
		t.Fatalf("total = %v; want 100000 (devoluciones excluidas)", total)
	}
	if count != 1 {
		t.Fatalf("count = %d; want 1", count)
	}
}

// INVARIANTE AMOUNT ↔ COUNT: cada línea que aportó al total debe estar en el
// count, y cada línea contada debe haber aportado al total. Si esta invariante
// se rompe, la tarjeta muestra "5 egresos por $0" o "$100.000 en 0 egresos".
func TestComputeShiftExpenseTotals_InvarianteAmountCount(t *testing.T) {
	expenses := []models.Expense{
		// Aporta: 3 canales, cuenta como 1 línea.
		{Status: "PAID", Amount: 100000, CashAmount: 50000, NequiAmount: 30000, DaviplataAmount: 20000},
		// No aporta: pending.
		{Status: "PENDING", Amount: 500000, PaymentSource: "PRESTAMO"},
		// No aporta: devolución.
		{Status: "PAID", Amount: 20000, CashAmount: 20000, Category: "DEVOLUCIONES"},
		// Aporta.
		{Status: "PAID", Amount: 40000, FondoAmount: 40000, PaymentSource: "FONDO"},
	}
	total, count := ComputeShiftExpenseTotals(expenses)
	if total != 140000 {
		t.Fatalf("total = %v; want 140000", total)
	}
	if count != 2 {
		t.Fatalf("count = %d; want 2 (solo dos líneas aportaron)", count)
	}

	// Sanity: recorrer y validar la invariante línea por línea.
	linesThatContributed := 0
	sumContrib := 0.0
	for i := range expenses {
		e := &expenses[i]
		if !isOperationalExpense(e) {
			continue
		}
		cash, nequi, davi, fondo, coins := parseExpenseChannels(e)
		lineTotal := cash + nequi + davi + fondo + coins
		if lineTotal > 0 {
			linesThatContributed++
			sumContrib += lineTotal
		}
	}
	if linesThatContributed != count {
		t.Fatalf("invariante rota: count=%d vs líneas que aportaron=%d", count, linesThatContributed)
	}
	if math.Abs(sumContrib-total) > 0.01 {
		t.Fatalf("invariante rota: total=%v vs suma línea a línea=%v", total, sumContrib)
	}
}

func TestExpenseChannelBuckets_AlineaConParseExpenseChannels(t *testing.T) {
	// Caso mixto en un único egreso: dashboard debe ver la misma clasificación
	// que el modal de auditoría del cierre.
	expenses := []models.Expense{{
		Status:        "PAID",
		Amount:        189469,
		PaymentSource: "CAJA: $59469/FONDO: $80000/ALCANCIA: $50000",
	}}
	buckets := ExpenseChannelBuckets(expenses)
	if buckets["EFECTIVO"] != 59469 {
		t.Errorf("efectivo = %v; want 59469", buckets["EFECTIVO"])
	}
	if buckets["FONDO"] != 80000 {
		t.Errorf("fondo = %v; want 80000", buckets["FONDO"])
	}
	if buckets["MONEDAS"] != 50000 {
		t.Errorf("monedas = %v; want 50000", buckets["MONEDAS"])
	}
	if buckets["NEQUI"] != 0 || buckets["DAVIPLATA"] != 0 {
		t.Errorf("canales no involucrados: nequi=%v davi=%v", buckets["NEQUI"], buckets["DAVIPLATA"])
	}
	// Suma total debe coincidir con el egreso.
	sum := buckets["EFECTIVO"] + buckets["NEQUI"] + buckets["DAVIPLATA"] + buckets["FONDO"] + buckets["MONEDAS"]
	if sum != 189469 {
		t.Fatalf("suma de canales = %v; want 189469 (parseExpenseChannels debe distribuir todo)", sum)
	}
}

func TestExpenseChannelBuckets_ExcluyeMismasCategoriasQueTotales(t *testing.T) {
	// Buckets y totales deben excluir el MISMO universo (pendientes,
	// préstamos, devoluciones). Si uno excluye y el otro no, el dashboard
	// clasifica distinto al cierre y aparecen huecos.
	expenses := []models.Expense{
		{Status: "PAID", Amount: 100000, CashAmount: 100000, Category: "Servicios"},
		{Status: "PAID", Amount: 20000, CashAmount: 20000, Category: "DEVOLUCIONES"},
		{Status: "PENDING", Amount: 500000, PaymentSource: "CAJA", CashAmount: 500000},
		{Status: "PAID", Amount: 300000, PaymentSource: "PRESTAMO"},
	}
	buckets := ExpenseChannelBuckets(expenses)
	if buckets["EFECTIVO"] != 100000 {
		t.Fatalf("EFECTIVO = %v; want 100000 (solo el operativo)", buckets["EFECTIVO"])
	}
	sum := 0.0
	for _, v := range buckets {
		sum += v
	}
	total, _ := ComputeShiftExpenseTotals(expenses)
	if math.Abs(sum-total) > 0.01 {
		t.Fatalf("suma de buckets (%v) ≠ total canónico (%v) — los helpers no comparten universo", sum, total)
	}
}

// La tarjeta del dashboard usa exactamente el mismo número que
// ComputeClosureMetrics(shiftClosure).EgresosTotales. Este test verifica el
// contrato entre ambos helpers para que no diverjan.
func TestComputeShiftExpenseTotals_CoincideConEgresosTotales(t *testing.T) {
	c := models.CashierClosure{
		PhysicalCash: 500000,
		Expenses: []models.Expense{
			{Status: "PAID", Amount: 100000, CashAmount: 100000, Category: "Servicios"},
			{Status: "PAID", Amount: 50000, NequiAmount: 50000, PaymentSource: "NEQUI"},
			{Status: "PAID", Amount: 30000, DaviplataAmount: 30000, PaymentSource: "DAVIPLATA"},
			{Status: "PAID", Amount: 80000, FondoAmount: 80000, PaymentSource: "FONDO"},
			{Status: "PAID", Amount: 15000, CoinsAmount: 15000, PaymentSource: "ALCANCIA"},
			// Ruido: no deben aportar.
			{Status: "PAID", Amount: 20000, CashAmount: 20000, Category: "DEVOLUCIONES"},
			{Status: "PENDING", Amount: 500000, PaymentSource: "CAJA", CashAmount: 500000},
			{Status: "PAID", Amount: 200000, PaymentSource: "PRESTAMO"},
		},
	}

	m := ComputeClosureMetrics(&c)
	total, count := ComputeShiftExpenseTotals(c.Expenses)

	if math.Abs(m.EgresosTotales-total) > 0.01 {
		t.Fatalf("total dashboard=%v ≠ EgresosTotales del cierre=%v", total, m.EgresosTotales)
	}
	if count != 5 {
		t.Fatalf("count = %d; want 5", count)
	}
	// TotalExpenses cash-only NO debe haber cambiado: sigue siendo el arqueo.
	if m.EgresosCaja != 100000 {
		t.Fatalf("EgresosCaja del arqueo cambió: %v; want 100000", m.EgresosCaja)
	}
}

// ============================================================================
// INVARIANTE DE AISLAMIENTO: el total multicanal del dashboard NUNCA debe
// filtrarse al arqueo de caja física.
// ============================================================================
//
// El arqueo (ExpectedCash) es EfectivoApertura + EfectivoDelTurno −
// EgresosEnEFECTIVO − Devoluciones. Si los egresos pagados por Nequi,
// Daviplata, fondo o alcancía entraran en esa resta, el esperado bajaría por
// plata que jamás salió de la gaveta y el cajero aparecería con sobrante
// falso. Por el mismo camino VentasCajero (que suma EgresosCaja) inflaría la
// venta del mes: es exactamente el bug histórico de la alcancía.
//
// Este test fija la frontera: la tarjeta del dashboard puede ser multicanal,
// el arqueo tiene que seguir siendo cash-only.
func TestEgresosMultiCanalNoContaminanElArqueo(t *testing.T) {
	// Un solo egreso de $100.000 en efectivo; el resto sale por canales que
	// NO tocan la gaveta, por un total muy superior.
	c := models.CashierClosure{
		OpeningCash:   200000,
		PhysicalCash:  500000,
		TotalCash:     600000,
		TotalNequi:    0,
		TotalReturns:  0,
		TotalExpenses: 100000, // columna cash-only del arqueo
		Expenses: []models.Expense{
			{Status: "PAID", Amount: 100000, CashAmount: 100000, Category: "Servicios"},
			{Status: "PAID", Amount: 900000, NequiAmount: 900000, PaymentSource: "NEQUI"},
			{Status: "PAID", Amount: 700000, DaviplataAmount: 700000, PaymentSource: "DAVIPLATA"},
			{Status: "PAID", Amount: 800000, FondoAmount: 800000, PaymentSource: "FONDO"},
			{Status: "PAID", Amount: 50000, CoinsAmount: 50000, PaymentSource: "ALCANCIA"},
		},
	}

	m := ComputeClosureMetrics(&c)
	dashboardTotal, dashboardCount := ComputeShiftExpenseTotals(c.Expenses)

	// La tarjeta del dashboard ve TODO el gasto operativo.
	const wantDashboard = 100000.0 + 900000 + 700000 + 800000 + 50000
	if math.Abs(dashboardTotal-wantDashboard) > 0.01 {
		t.Fatalf("total dashboard = %v; want %v", dashboardTotal, wantDashboard)
	}
	if dashboardCount != 5 {
		t.Fatalf("count dashboard = %d; want 5", dashboardCount)
	}

	// El arqueo SOLO ve el efectivo de la gaveta.
	if math.Abs(m.EgresosCaja-100000) > 0.01 {
		t.Fatalf("EgresosCaja = %v; want 100000 (los canales digitales/fondo/alcancía NO tocan la gaveta)", m.EgresosCaja)
	}

	// ExpectedCash = apertura + efectivo del turno − egresos EN EFECTIVO − devoluciones.
	// Si se hubiera usado el total multicanal, el esperado se hundiría en $2.450.000.
	wantExpected := c.OpeningCash + c.TotalCash - m.EgresosCaja - c.TotalReturns
	if math.Abs(wantExpected-700000) > 0.01 {
		t.Fatalf("esperado de arqueo = %v; want 700000", wantExpected)
	}

	// Y la venta del cajero no se infla con la plata que salió por otros canales.
	if math.Abs(m.VentasCajero-(m.PhysicalCash+m.DigitalIncome+m.EgresosCaja+m.Returns)) > 0.01 {
		t.Fatalf("VentasCajero no respeta su fórmula cash-only: %v", m.VentasCajero)
	}
	if m.VentasCajero >= wantDashboard {
		t.Fatalf("VentasCajero (%v) se contaminó con el total multicanal (%v)", m.VentasCajero, wantDashboard)
	}
}

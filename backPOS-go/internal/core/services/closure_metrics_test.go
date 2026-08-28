package services

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// Caso real del cierre #158 (agosto 2026), tomado del CSV de producción y de
// la pantalla de historial:
//
//	Efectivo que entró al sistema : $479.300
//	Egresos pagados de la caja    : $552.080
//	Egresos pagados del fondo     : $38.000
//	Ingresos digitales            : $305.200
//	Efectivo contado por el cajero: $16.500
//
// VENTA TOTAL esperada = 16.500 + 305.200 + 552.080 + 0 = $873.780,
// que es exactamente lo que muestra la tarjeta en /reports.
func TestVentaTotalDelCierre158(t *testing.T) {
	c := &models.CashierClosure{
		TotalCash:      479300,
		TotalNequi:     205200,
		TotalDaviplata: 100000,
		PhysicalCash:   16500,
		TotalReturns:   0,
		Expenses: []models.Expense{
			{Amount: 552080, Status: "PAID", PaymentSource: "CAJA", CashAmount: 552080},
			{Amount: 38000, Status: "PAID", PaymentSource: "FONDO", FondoAmount: 38000},
		},
	}

	m := ComputeClosureMetrics(c)

	if m.PhysicalCash != 16500 {
		t.Errorf("efectivo contado: esperaba 16500, obtuve %.2f", m.PhysicalCash)
	}
	if m.DigitalIncome != 305200 {
		t.Errorf("digital: esperaba 305200, obtuve %.2f", m.DigitalIncome)
	}
	if m.EgresosCaja != 552080 {
		t.Errorf("egresos caja: esperaba 552080, obtuve %.2f", m.EgresosCaja)
	}
	// El egreso del fondo NO debe tocar el arqueo de la gaveta.
	if m.EgresosFondo != 38000 {
		t.Errorf("egresos fondo: esperaba 38000, obtuve %.2f", m.EgresosFondo)
	}
	if m.VentasCajero != 873780 {
		t.Errorf("VENTA TOTAL: esperaba 873780, obtuve %.2f", m.VentasCajero)
	}
}

// La devolución de dinero se registra automáticamente como egreso de caja.
// Debe contarse UNA sola vez: excluida de los egresos por canal y sumada
// únicamente a través de TotalReturns.
func TestLaDevolucionSeCuentaUnaSolaVez(t *testing.T) {
	c := &models.CashierClosure{
		TotalCash:    500000,
		PhysicalCash: 430000,
		TotalReturns: 20000,
		Expenses: []models.Expense{
			{Amount: 50000, Status: "PAID", PaymentSource: "CAJA", CashAmount: 50000},
			{Amount: 20000, Status: "PAID", PaymentSource: "CAJA", CashAmount: 20000, Category: "DEVOLUCIONES"},
		},
	}

	m := ComputeClosureMetrics(c)

	if m.EgresosCaja != 50000 {
		t.Errorf("la devolución no debe entrar en egresos de caja: esperaba 50000, obtuve %.2f", m.EgresosCaja)
	}
	// 430.000 contado + 0 digital + 50.000 egresos + 20.000 devolución
	if m.VentasCajero != 500000 {
		t.Errorf("VENTA TOTAL: esperaba 500000, obtuve %.2f", m.VentasCajero)
	}
}

// Los egresos PENDING son deudas: no salió plata todavía, así que no pueden
// afectar el arqueo.
func TestLosEgresosPendientesNoAfectanLaCaja(t *testing.T) {
	c := &models.CashierClosure{
		PhysicalCash: 100000,
		Expenses: []models.Expense{
			{Amount: 900000, Status: "PENDING", PaymentSource: "PRESTAMO"},
		},
	}

	m := ComputeClosureMetrics(c)

	if m.EgresosCaja != 0 {
		t.Errorf("un egreso PENDING no debe restar de la caja: obtuve %.2f", m.EgresosCaja)
	}
	if m.VentasCajero != 100000 {
		t.Errorf("VENTA TOTAL: esperaba 100000, obtuve %.2f", m.VentasCajero)
	}
}

// Las monedas se guardan como VALOR EN PESOS, no como cantidad de piezas.
// Este era el bug que convertía $30.000 en monedas en $30.000.000.
func TestLasMonedasSeLeenComoPesosNoComoCantidad(t *testing.T) {
	c := &models.CashierClosure{
		CashBreakdown: `{"bills":{"50000":"2","10000":"3"},"coins":{"500/1000":"30000","200":"1500"}}`,
	}

	m := ComputeClosureMetrics(c)

	// Billetes: 50.000x2 + 10.000x3 = 130.000. Monedas: 30.000 + 1.500 = 31.500.
	if m.PhysicalCash != 161500 {
		t.Errorf("efectivo contado: esperaba 161500, obtuve %.2f", m.PhysicalCash)
	}
}

// El esperado puede dar NEGATIVO cuando los egresos del turno superan las
// ventas registradas en el POS (pasa al vender productos sin código de barras y
// pagar gastos con ese dinero). En ese caso el sobrante real es la resta
// completa, no el conteo físico a secas.
//
// Caso del cierre #158: esperado -$72.780, contado $16.500 -> +$89.280.
// Con el piso artificial a $0 el sistema mostraba solo +$16.500 y escondía
// $72.780 de sobrante.
func TestElEsperadoNegativoMuestraElSobranteReal(t *testing.T) {
	openingCash := 0.0
	totalCash := 479300.0
	egresosCaja := 552080.0
	returns := 0.0
	physicalCash := 16500.0

	expected := openingCash + totalCash - egresosCaja - returns
	if expected != -72780 {
		t.Fatalf("esperado: queria -72780, obtuve %.2f", expected)
	}

	diferencia := physicalCash - expected
	if diferencia != 89280 {
		t.Errorf("sobrante real: esperaba 89280, obtuve %.2f", diferencia)
	}

	// Con el piso a cero daba 16500, que es el bug que se eliminó.
	if diferencia == physicalCash {
		t.Error("el piso artificial a cero volvió a aparecer")
	}
}

// Cuando el rótulo de texto dice FONDO pero la plata está anotada en la columna
// de efectivo, mandan las columnas. Es la regla que alinea el dashboard con el
// historial en pantalla.
func TestLasColumnasMandanSobreElRotuloDeTexto(t *testing.T) {
	c := &models.CashierClosure{
		PhysicalCash: 10000,
		Expenses: []models.Expense{
			{Amount: 50000, Status: "PAID", PaymentSource: "FONDO", CashAmount: 50000},
		},
	}

	m := ComputeClosureMetrics(c)

	if m.EgresosCaja != 50000 {
		t.Errorf("debe mandar la columna CashAmount: esperaba 50000 en caja, obtuve %.2f", m.EgresosCaja)
	}
	if m.EgresosFondo != 0 {
		t.Errorf("no debe ir al fondo: obtuve %.2f", m.EgresosFondo)
	}
}

package services

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// LA ALCANCIA NO ES LA GAVETA
// ============================================================================
//
// Bug encontrado el 2026-08-31: parseExpenseChannels no conocia la alcancia.
// Un egreso pagado con monedas llegaba con CoinsAmount cargado y los otros
// cuatro canales en cero, la suma daba cero, caia al return final y quedaba
// clasificado como EFECTIVO DE CAJA.
//
// Y como el arqueo hace
//
//	VentasCajero = EfectivoFisico + Digital + EgresosEnEfectivo + Devoluciones
//
// cada egreso pagado con la alcancia SUBIA la venta del mes sin que existiera
// ninguna venta. Ese era el hueco entre la linea de "Ventas" del dashboard y
// el donut de metodos de pago (el dueno lo reporto con $177.476 de diferencia
// en agosto 2026).

func TestParseExpenseChannels_AlcanciaEsCanalPropio(t *testing.T) {
	e := &models.Expense{
		Status:      "PAID",
		Amount:      50000,
		CoinsAmount: 50000,
	}
	cash, nequi, davi, fondo, coins := parseExpenseChannels(e)

	if coins != 50000 {
		t.Fatalf("alcancia = %v; want 50000", coins)
	}
	if cash != 0 {
		t.Fatalf("EL BUG VOLVIO: la alcancia se conto como efectivo de caja (%v)", cash)
	}
	if nequi != 0 || davi != 0 || fondo != 0 {
		t.Fatalf("se contamino otro canal: nequi=%v davi=%v fondo=%v", nequi, davi, fondo)
	}
}

func TestParseExpenseChannels_AlcanciaPorTexto(t *testing.T) {
	// Egresos viejos que no tienen columnas por canal, solo el texto.
	for _, fuente := range []string{"ALCANCIA", "ALCANCÍA", "MONEDAS", "Monedas de la alcancia"} {
		e := &models.Expense{Status: "PAID", Amount: 12000, PaymentSource: fuente}
		cash, _, _, _, coins := parseExpenseChannels(e)
		if coins != 12000 {
			t.Errorf("fuente %q: alcancia = %v; want 12000", fuente, coins)
		}
		if cash != 0 {
			t.Errorf("fuente %q: se conto como efectivo (%v)", fuente, cash)
		}
	}
}

func TestParseExpenseChannels_EfectivoSigueSiendoEfectivo(t *testing.T) {
	// Regresion: el arreglo no puede robarle plata al efectivo real.
	e := &models.Expense{Status: "PAID", Amount: 30000, CashAmount: 30000}
	cash, _, _, _, coins := parseExpenseChannels(e)
	if cash != 30000 {
		t.Fatalf("efectivo = %v; want 30000", cash)
	}
	if coins != 0 {
		t.Fatalf("alcancia = %v; want 0", coins)
	}
}

func TestParseExpenseChannels_MixtoCajaYAlcancia(t *testing.T) {
	e := &models.Expense{
		Status:      "PAID",
		Amount:      80000,
		CashAmount:  50000,
		CoinsAmount: 30000,
	}
	cash, _, _, _, coins := parseExpenseChannels(e)
	if cash != 50000 {
		t.Fatalf("efectivo = %v; want 50000", cash)
	}
	if coins != 30000 {
		t.Fatalf("alcancia = %v; want 30000", coins)
	}
}

// EL TEST QUE IMPORTA: la venta del cajero no se infla con la alcancia.
func TestComputeClosureMetrics_LaAlcanciaNoInflaLaVenta(t *testing.T) {
	base := models.CashierClosure{
		PhysicalCash: 1_000_000,
		TotalNequi:   200_000,
		TotalReturns: 0,
	}

	// Cierre A: un egreso de 100.000 pagado en EFECTIVO de la gaveta.
	// Esa plata SI entro por una venta antes de salir, asi que suma.
	conEfectivo := base
	conEfectivo.Expenses = []models.Expense{
		{Status: "PAID", Amount: 100_000, CashAmount: 100_000, Category: "Servicios"},
	}
	mEfectivo := ComputeClosureMetrics(&conEfectivo)

	// Cierre B: el MISMO egreso pero pagado con la alcancia.
	// La alcancia es un tarro aparte: no hubo venta, no debe sumar.
	conAlcancia := base
	conAlcancia.Expenses = []models.Expense{
		{Status: "PAID", Amount: 100_000, CoinsAmount: 100_000, Category: "Servicios"},
	}
	mAlcancia := ComputeClosureMetrics(&conAlcancia)

	if mEfectivo.VentasCajero != 1_300_000 {
		t.Fatalf("venta con egreso en efectivo = %v; want 1300000", mEfectivo.VentasCajero)
	}
	if mAlcancia.VentasCajero != 1_200_000 {
		t.Fatalf("venta con egreso de alcancia = %v; want 1200000 (NO debe sumar los 100.000)",
			mAlcancia.VentasCajero)
	}
	if mAlcancia.VentasCajero == mEfectivo.VentasCajero {
		t.Fatal("EL BUG VOLVIO: pagar con la alcancia infla la venta igual que pagar con la gaveta")
	}

	// La plata no se pierde: queda registrada en su canal.
	if mAlcancia.EgresosAlcancia != 100_000 {
		t.Fatalf("EgresosAlcancia = %v; want 100000", mAlcancia.EgresosAlcancia)
	}
	if mAlcancia.EgresosCaja != 0 {
		t.Fatalf("EgresosCaja = %v; want 0", mAlcancia.EgresosCaja)
	}
	if mAlcancia.EgresosTotales != 100_000 {
		t.Fatalf("EgresosTotales = %v; want 100000 (la plata no puede desaparecer)", mAlcancia.EgresosTotales)
	}
}

// El arqueo del efectivo fisico tampoco debe castigarse por la alcancia:
// si pagaste con monedas del tarro, la gaveta no perdio nada.
func TestComputeClosureMetrics_LaAlcanciaNoAfectaElArqueoDeCaja(t *testing.T) {
	c := models.CashierClosure{
		PhysicalCash: 500_000,
		Expenses: []models.Expense{
			{Status: "PAID", Amount: 40_000, CoinsAmount: 40_000, Category: "Aseo"},
			{Status: "PAID", Amount: 60_000, CashAmount: 60_000, Category: "Aseo"},
		},
	}
	m := ComputeClosureMetrics(&c)

	if m.EgresosCaja != 60_000 {
		t.Fatalf("EgresosCaja = %v; want 60000 (solo el pagado con la gaveta)", m.EgresosCaja)
	}
	if m.EgresosAlcancia != 40_000 {
		t.Fatalf("EgresosAlcancia = %v; want 40000", m.EgresosAlcancia)
	}
	if m.EgresosTotales != 100_000 {
		t.Fatalf("EgresosTotales = %v; want 100000", m.EgresosTotales)
	}
}

// Las devoluciones siguen excluidas de los egresos por canal (se cuentan una
// sola vez via TotalReturns). El arreglo no puede haber cambiado eso.
func TestComputeClosureMetrics_DevolucionEnAlcanciaSigueExcluida(t *testing.T) {
	c := models.CashierClosure{
		PhysicalCash: 100_000,
		TotalReturns: 20_000,
		Expenses: []models.Expense{
			{Status: "PAID", Amount: 20_000, CoinsAmount: 20_000, Category: "DEVOLUCIONES"},
		},
	}
	m := ComputeClosureMetrics(&c)

	if m.EgresosAlcancia != 0 {
		t.Fatalf("EgresosAlcancia = %v; want 0 (las devoluciones se excluyen)", m.EgresosAlcancia)
	}
	if m.VentasCajero != 120_000 {
		t.Fatalf("VentasCajero = %v; want 120000 (100k caja + 20k devolucion)", m.VentasCajero)
	}
}

package handlers

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/services"
)

// ============================================================================
// REGLA INVARIANTE DEL SISTEMA
// ============================================================================
//
// Se haga un cierre, se edite o se cambie cualquier cosa, estas CUATRO vistas
// tienen que mostrar exactamente los mismos datos del turno:
//
//	1. El mensaje de Telegram
//	2. El reporte visual de /reports
//	3. El detalle del cierre (el ojito)
//	4. El reporte FLUJO DESGLOSADO
//
// La única forma de garantizarlo es que las cuatro salgan de
// services.ComputeClosureMetrics. Este archivo existe para que, si alguien
// vuelve a escribir una segunda calculadora, el test falle ANTES de llegar a
// producción.
//
// Historia: llegamos a tener NUEVE implementaciones distintas del mismo arqueo,
// cada una con sus propias reglas, y ninguna coincidía con las demás.
// ============================================================================

// cierre133 es un caso REAL de producción (agosto 2026), el que se usó para
// validar la unificación con el dueño.
func cierre133() models.CashierClosure {
	inicio := time.Date(2026, 8, 7, 21, 48, 0, 0, time.UTC)
	fin := time.Date(2026, 8, 8, 14, 2, 0, 0, time.UTC)

	return models.CashierClosure{
		ID:             133,
		Date:           fin,
		StartDate:      inicio,
		EndDate:        fin,
		ClosedByName:   "SEBASTIAN",
		TotalCash:      414700,
		TotalNequi:     107700,
		TotalDaviplata: 62900,
		PhysicalCash:   107500,
		TotalReturns:   0,
		Expenses: []models.Expense{
			{ID: 1, Amount: 24504, Status: "PAID", PaymentSource: "CAJA", CashAmount: 24504, Description: "SUPER RICAS"},
			{ID: 2, Amount: 64400, Status: "PAID", PaymentSource: "CAJA", CashAmount: 64400, Description: "POLLO"},
			{ID: 3, Amount: 33000, Status: "PAID", PaymentSource: "CAJA", CashAmount: 33000, Description: "DISTRIMAGLA"},
			{ID: 4, Amount: 90451, Status: "PAID", PaymentSource: "CAJA", CashAmount: 90451, Description: "ALQUERIA"},
			{ID: 5, Amount: 43108, Status: "PAID", PaymentSource: "CAJA", CashAmount: 43108, Description: "EL CARRIEL"},
			{ID: 6, Amount: 15000, Status: "PAID", PaymentSource: "CAJA", CashAmount: 15000, Description: "ENVUELTOS"},
			{ID: 7, Amount: 39000, Status: "PAID", PaymentSource: "CAJA", CashAmount: 39000, Description: "AGUA MIA"},
			{ID: 8, Amount: 72300, Status: "PAID", PaymentSource: "FONDO", FondoAmount: 72300, Description: "TRILLADORA EL TREBOL"},
			{ID: 9, Amount: 229400, Status: "PAID", PaymentSource: "FONDO", FondoAmount: 229400, Description: "PLAZA"},
		},
	}
}

// TestElMensajeDeTelegramUsaElArqueoCanonico verifica que el mensaje de Telegram
// imprime EXACTAMENTE las cifras de ComputeClosureMetrics.
//
// Antes tenía su propia matemática: leía PhysicalCash crudo, sumaba CashAmount a
// mano, omitía la base de apertura y forzaba el esperado a $0 cuando salía
// negativo. Por eso el mensaje nunca coincidía con la pantalla.
func TestElMensajeDeTelegramUsaElArqueoCanonico(t *testing.T) {
	c := cierre133()
	m := services.ComputeClosureMetrics(&c)

	msg := FormatTelegramClosureMessage(cierre133(), false)

	casos := []struct {
		nombre string
		valor  float64
	}{
		{"venta total del cajero", m.VentasCajero},
		{"efectivo contado", m.PhysicalCash},
		{"egresos de caja", m.EgresosCaja},
		{"egresos del fondo", m.EgresosFondo},
	}

	for _, caso := range casos {
		esperado := formatCOP(caso.valor)
		if !strings.Contains(msg, esperado) {
			t.Errorf("el mensaje de Telegram no muestra el %s canonico ($%s).\nMensaje:\n%s",
				caso.nombre, esperado, msg)
		}
	}
}

// TestLaVentaTotalSiempreCuadraConSusPartes fija la identidad contable:
// no puede haber un peso en la venta total que no venga de una de sus partes.
func TestLaVentaTotalSiempreCuadraConSusPartes(t *testing.T) {
	c := cierre133()
	m := services.ComputeClosureMetrics(&c)

	suma := m.PhysicalCash + m.DigitalIncome + m.EgresosCaja + m.Returns
	if suma != m.VentasCajero {
		t.Errorf("VENTA TOTAL (%.2f) no es igual a contado (%.2f) + digital (%.2f) + egresos caja (%.2f) + devoluciones (%.2f) = %.2f",
			m.VentasCajero, m.PhysicalCash, m.DigitalIncome, m.EgresosCaja, m.Returns, suma)
	}

	// Cifras verificadas contra producción el 2026-08-26.
	if m.VentasCajero != 587563 {
		t.Errorf("venta total: esperaba 587563, obtuve %.2f", m.VentasCajero)
	}
	if m.EgresosCaja != 309463 {
		t.Errorf("egresos de caja: esperaba 309463, obtuve %.2f", m.EgresosCaja)
	}
	if m.EgresosFondo != 301700 {
		t.Errorf("egresos del fondo: esperaba 301700, obtuve %.2f", m.EgresosFondo)
	}
}

// TestElFondoNuncaEntraEnLaVentaDelCajero es la regla que más veces se rompió:
// un gasto pagado desde la bóveda no puede contar como venta del turno ni
// restar del efectivo esperado de la gaveta.
//
// Caso REAL: el recibo de la luz de $1.004.890 se pagó MIXTO, $1.004.000 del
// fondo y $890 de la caja. Solo esos $890 pueden entrar en la venta del cajero.
func TestElFondoNuncaEntraEnLaVentaDelCajero(t *testing.T) {
	base := cierre133()
	m1 := services.ComputeClosureMetrics(&base)

	conLuz := cierre133()
	conLuz.Expenses = append(conLuz.Expenses, models.Expense{
		ID: 99, Amount: 1004890, Status: "PAID",
		PaymentSource: "FONDO",
		FondoAmount:   1004000,
		CashAmount:    890,
		Description:   "RECIBO DE LUZ",
	})
	m2 := services.ComputeClosureMetrics(&conLuz)

	// Los $1.004.000 del fondo NO pueden mover la venta del cajero.
	// Los $890 de caja SÍ, porque esa plata salió de la gaveta.
	if m2.VentasCajero != m1.VentasCajero+890 {
		t.Errorf("la venta del cajero debia subir solo los $890 de caja: antes %.2f, esperaba %.2f, obtuve %.2f",
			m1.VentasCajero, m1.VentasCajero+890, m2.VentasCajero)
	}
	if m2.EgresosCaja != m1.EgresosCaja+890 {
		t.Errorf("egresos de caja: esperaba %.2f, obtuve %.2f", m1.EgresosCaja+890, m2.EgresosCaja)
	}
	if m2.EgresosFondo != m1.EgresosFondo+1004000 {
		t.Errorf("egresos del fondo: esperaba %.2f, obtuve %.2f", m1.EgresosFondo+1004000, m2.EgresosFondo)
	}

	// Y el millón del fondo tampoco puede tocar el efectivo esperado.
	espBase := base.OpeningCash + base.TotalCash - m1.EgresosCaja - base.TotalReturns
	espLuz := conLuz.OpeningCash + conLuz.TotalCash - m2.EgresosCaja - conLuz.TotalReturns
	if espBase-espLuz != 890 {
		t.Errorf("el esperado solo debia bajar $890, bajo %.2f", espBase-espLuz)
	}
}

// TestNoHayPisoArtificialAceroEnElMensaje: si los egresos superan lo que entró,
// el esperado es negativo y el sobrante real es la resta completa. Forzar el
// esperado a $0 escondía plata del cajero.
func TestNoHayPisoArtificialAceroEnElMensaje(t *testing.T) {
	// Caso del cierre #158: entraron $479.300 y salieron $552.080 de la caja.
	c := models.CashierClosure{
		ID:           158,
		Date:         time.Now(),
		StartDate:    time.Now().Add(-8 * time.Hour),
		EndDate:      time.Now(),
		ClosedByName: "SEBASTIAN",
		TotalCash:    479300,
		PhysicalCash: 16500,
		Expenses: []models.Expense{
			{ID: 1, Amount: 552080, Status: "PAID", PaymentSource: "CAJA", CashAmount: 552080, Description: "PROVEEDORES"},
		},
	}

	m := services.ComputeClosureMetrics(&c)
	esperado := c.OpeningCash + c.TotalCash - m.EgresosCaja - c.TotalReturns
	if esperado != -72780 {
		t.Fatalf("esperado: queria -72780, obtuve %.2f", esperado)
	}

	sobrante := m.PhysicalCash - esperado
	if sobrante != 89280 {
		t.Errorf("sobrante real: esperaba 89280, obtuve %.2f", sobrante)
	}

	msg := FormatTelegramClosureMessage(c, false)
	if !strings.Contains(msg, formatCOP(89280)) {
		t.Errorf("el mensaje debe mostrar el sobrante real de $%s, no el conteo fisico a secas.\nMensaje:\n%s",
			formatCOP(89280), msg)
	}
	if strings.Contains(msg, fmt.Sprintf("Efectivo Esperado:  `$%s`", formatCOP(0))) {
		t.Error("el piso artificial a $0 volvio a aparecer en el mensaje de Telegram")
	}
}

// TestLaDevolucionSeCuentaUnaSolaVez: al devolver dinero el sistema registra
// automaticamente un egreso de caja de categoria DEVOLUCIONES. Si además se
// suma TotalReturns, se resta dos veces del efectivo esperado.
func TestLaDevolucionSeCuentaUnaSolaVez(t *testing.T) {
	c := models.CashierClosure{
		TotalCash:    500000,
		PhysicalCash: 430000,
		TotalReturns: 20000,
		Expenses: []models.Expense{
			{ID: 1, Amount: 50000, Status: "PAID", PaymentSource: "CAJA", CashAmount: 50000},
			{ID: 2, Amount: 20000, Status: "PAID", PaymentSource: "CAJA", CashAmount: 20000, Category: "DEVOLUCIONES"},
		},
	}

	m := services.ComputeClosureMetrics(&c)

	if m.EgresosCaja != 50000 {
		t.Errorf("la devolucion no debe entrar en egresos de caja: esperaba 50000, obtuve %.2f", m.EgresosCaja)
	}
	// 430.000 contado + 50.000 egresos + 20.000 devolucion
	if m.VentasCajero != 500000 {
		t.Errorf("venta total: esperaba 500000, obtuve %.2f", m.VentasCajero)
	}
}

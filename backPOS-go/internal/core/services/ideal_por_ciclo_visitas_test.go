package services

import (
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// EL PEDIDO SE CALCULA POR EL CICLO DE VISITAS DEL PROVEEDOR
//
// REGLA DEL DUENO (2026-09-10, textual): "ya tiene que empezar a calcular
// dependiendo las visitas de los provedor, no a 30 dias, osea si cocacola viene
// 2 veces a la semana, pues lo calcula en esos dias, y si arroz del llano una
// ves a la semana pues en ese tiempo".
//
// Antes el ideal salia de `demanda * leadDays`, y leadDays responde otra
// pregunta: cuanto tarda en llegar lo que pido. Eso rompia por los dos extremos:
//
//   - Con agenda configurada (visita martes, entrega miercoles) leadDays = 1 y
//     el pedido se calculaba para UN dia de venta.
//   - Sin agenda pero con visit_frequency_days aprendido en 30, el pedido se
//     calculaba para un MES entero e inflaba la factura. Ese es el "no a 30
//     dias" del reporte.
// ============================================================================

// dosVecesPorSemana / unaVezPorSemana: los dos proveedores que nombro el dueno.
func metricaConAgenda(t *testing.T, visitas, entregas []string, ventas14 float64) models.ProductRestockMetric {
	t.Helper()
	input := models.RestockCalculationInput{
		ProductID:    "TEST",
		ProductName:  "PRODUCTO",
		CurrentStock: 0,
		// La demanda efectiva se apoya en la ventana de 14 dias cuando hay
		// movimiento reciente. 14 dias con stock => tasa = ventas14 / 14.
		TotalSold14d:     ventas14,
		DaysZeroStock14d: 0,
		TotalSold30d:     ventas14 * 2,
		DaysZeroStock:    0,
		MinStock:         0,
	}
	input.PrimaryVisitDays = visitas
	input.PrimaryDeliveryDays = entregas
	return calculateRestockMetric(input, time.Date(2026, 9, 10, 8, 0, 0, 0, time.UTC))
}

func TestIdeal_CocaColaDosVecesPorSemanaVsArrozUnaVez(t *testing.T) {
	// Misma demanda para los dos: 14 unidades en 14 dias = 1/dia.
	const ventas14 = 14.0

	// Coca-Cola: viene martes y viernes, entrega el mismo dia.
	// Peor hueco: viernes -> martes = 4 dias. Lead 0. Cobertura 4.
	coca := metricaConAgenda(t, []string{"martes", "viernes"}, []string{"martes", "viernes"}, ventas14)

	// Arroz del Llano: viene una vez por semana, martes, entrega miercoles.
	// Ciclo 7 + lead 1 = 8 dias.
	arroz := metricaConAgenda(t, []string{"martes"}, []string{"miercoles"}, ventas14)

	if coca.IdealStock >= arroz.IdealStock {
		t.Fatalf("con la misma demanda, el proveedor que viene 2 veces por semana "+
			"debe pedir MENOS que el semanal.\n  coca (2x/sem) ideal = %v\n  arroz (1x/sem) ideal = %v",
			coca.IdealStock, arroz.IdealStock)
	}

	// Con 28 unidades en 30 dias el producto cae en clase B (colchon 1.15):
	//   coca  = ceil(1 * 4 * 1.15) = ceil(4.6) = 5
	//   arroz = ceil(1 * 8 * 1.15) = ceil(9.2) = 10
	if coca.IdealStock != 5 {
		t.Errorf("coca: ideal = %v; want 5 (1/dia x 4 dias de ciclo x 1.15)", coca.IdealStock)
	}
	if arroz.IdealStock != 10 {
		t.Errorf("arroz: ideal = %v; want 10 (1/dia x 8 dias x 1.15)", arroz.IdealStock)
	}
}

func TestIdeal_NoSeCalculaConElLeadTime(t *testing.T) {
	// Guardian del bug: visita martes y entrega miercoles es lead time 1. Si el
	// ideal volviera a usar leadDays, con 1/dia daria 1.
	m := metricaConAgenda(t, []string{"martes"}, []string{"miercoles"}, 14.0)

	if m.IdealStock <= 1 {
		t.Fatalf("ideal = %v: se volvio a calcular con el lead time (1 dia) en vez "+
			"del ciclo de visitas", m.IdealStock)
	}
}

func TestIdeal_ProveedorDiarioPideParaUnDia(t *testing.T) {
	// Si el proveedor viene todos los dias no hace falta stock para una semana.
	todos := []string{"lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"}
	m := metricaConAgenda(t, todos, todos, 14.0) // 1/dia, clase B

	// ceil(1 * 1 dia * 1.15) = 2
	if m.IdealStock != 2 {
		t.Errorf("proveedor diario: ideal = %v; want 2 (1/dia x 1 dia x 1.15)", m.IdealStock)
	}
	// Y muy por debajo del semanal.
	semanal := metricaConAgenda(t, []string{"martes"}, []string{"miercoles"}, 14.0)
	if m.IdealStock >= semanal.IdealStock {
		t.Errorf("el diario (%v) debe pedir menos que el semanal (%v)", m.IdealStock, semanal.IdealStock)
	}
}

func TestIdeal_SinAgendaNoSeInflaAUnMes(t *testing.T) {
	// El caso "no a 30 dias": un proveedor sin dias configurados cuyo
	// visit_frequency_days aprendido es 30. La cobertura se acota a
	// MaxUnknownCycleDays (14) para no pedir un mes de inventario.
	input := models.RestockCalculationInput{
		ProductID:                 "SINAGENDA",
		CurrentStock:              0,
		TotalSold14d:              14, // 1/dia
		TotalSold30d:              28,
		MinStock:                  0,
		PrimaryVisitFrequencyDays: 30,
	}
	m := calculateRestockMetric(input, time.Date(2026, 9, 10, 8, 0, 0, 0, time.UTC))

	// Antes: ceil(1 * 30 * 1.15) = 35. Ahora el tope son 14 dias:
	// ceil(1 * 14 * 1.15) = 17.
	if m.IdealStock >= 30 {
		t.Fatalf("ideal = %v: sin agenda el pedido se sigue calculando para un mes "+
			"entero, que es justo lo que el dueno pidio que no pasara", m.IdealStock)
	}
	if m.IdealStock != 17 {
		t.Errorf("ideal = %v; want 17 (tope de 14 dias x 1.15)", m.IdealStock)
	}
}

func TestIdeal_ConservaElColchonPorClaseABC(t *testing.T) {
	// El colchon por rotacion no se toca: un producto de clase A sigue pidiendo
	// 30% mas que la demanda pelada.
	// 42 en 14 dias = 3/dia => clase A (avgDaily >= 3), factor 1.30.
	// Visita martes, entrega miercoles => cobertura 8.
	// ideal = ceil(3 * 8 * 1.30) = ceil(31.2) = 32
	m := metricaConAgenda(t, []string{"martes"}, []string{"miercoles"}, 42.0)

	if m.ABCCategory != "A" {
		t.Fatalf("clase = %q; want A (3/dia)", m.ABCCategory)
	}
	if m.IdealStock != 32 {
		t.Errorf("ideal = %v; want 32 (3/dia x 8 dias x 1.30 de colchon)", m.IdealStock)
	}
}

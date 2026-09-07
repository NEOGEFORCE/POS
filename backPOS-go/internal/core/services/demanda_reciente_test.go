package services

import (
	"math"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// ============================================================================
// LA DEMANDA RECIENTE MANDA SOBRE LA VIEJA
// ============================================================================
//
// Regla del dueño (2026-09-05), textual:
//
//	"aparte de basarte en los 90 tienes que basarte mucho mucho en las ultimas
//	 2 semanas o una semana porque los proveedores la mayoria se demoran 8 dias
//	 y uno que otro 15 o 20"
//	"me interesan mas los datos recientes que los viejos"
//
// Antes la demanda efectiva era max(demand30, demand90). Ese max tenía un
// defecto de fondo: un producto que SE FRENÓ seguía pidiéndose como cuando
// vendía, porque la ventana vieja lo mantenía inflado. Ahora la ventana de 14
// días manda, y las largas quedan sólo como respaldo para los lentos.
//
// El caso que más importa es el de DESACELERACIÓN: es el único donde la regla
// nueva pide MENOS que la vieja, y es justamente lo que evita inflar la factura.

// El asOf se fija para que los cálculos sean deterministas.
var demandaAsOf = time.Date(2026, 9, 5, 22, 0, 0, 0, bogotaLocation)

func TestDemandaReciente_ProductoQueSeFrenoPideMenos(t *testing.T) {
	// Vendió MUCHO en el trimestre (180 en 90 días = 2/día) pero en las últimas
	// dos semanas casi nada (2 en 14 días = 0,14/día).
	//
	// Con la regla vieja (max) la demanda habría sido 2/día y se pedía para dos
	// semanas de una venta que ya no existe. Ahora manda la reciente.
	m := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "FRENADO",
		TotalSold14d:     2,
		TotalSold30d:     20,
		TotalSold90d:     180,
		CurrentStock:     5,
		SupplierLeadDays: 8,
	}, demandaAsOf)

	esperado := 2.0 / 14.0
	if math.Abs(m.AvgDailySales-esperado) > 0.01 {
		t.Fatalf("AvgDailySales = %v; want ~%v (la tasa de los ultimos 14 dias, NO la de 90)",
			m.AvgDailySales, esperado)
	}
	// Sanity: la tasa de 90 días era 2/día. Si la demanda hubiera salido de ahí,
	// este test no tendría sentido.
	if m.AvgDailySales > 1.0 {
		t.Fatalf("AvgDailySales = %v; la ventana vieja se colo (era 2/dia)", m.AvgDailySales)
	}
}

func TestDemandaReciente_ProductoQueSeAceleroPideMas(t *testing.T) {
	// Casi no vendió en el trimestre pero se disparó esta quincena:
	// 28 en 14 días = 2/día, contra 30 en 90 días = 0,33/día.
	m := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "ACELERADO",
		TotalSold14d:     28,
		TotalSold30d:     30,
		TotalSold90d:     30,
		CurrentStock:     4,
		SupplierLeadDays: 8,
	}, demandaAsOf)

	esperado := 28.0 / 14.0
	if math.Abs(m.AvgDailySales-esperado) > 0.01 {
		t.Fatalf("AvgDailySales = %v; want ~%v (la tasa reciente)", m.AvgDailySales, esperado)
	}
	// Y con lead de 8 días, el ideal tiene que alcanzar para reponer de verdad.
	if m.IdealStock < 16 {
		t.Errorf("IdealStock = %v; want >= 16 (2/dia por 8 dias de lead)", m.IdealStock)
	}
	if m.SuggestedOrderQty <= 0 {
		t.Errorf("SuggestedOrderQty = %v; un producto acelerado con stock 4 debe pedirse", m.SuggestedOrderQty)
	}
}

func TestDemandaReciente_SinVentasEnDosSemanasCaeALasVentanasLargas(t *testing.T) {
	// Producto lento: nada en 14 días, pero sí se movió en el trimestre. No debe
	// quedar en demanda cero, porque entonces desaparecería del radar.
	m := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "LENTO",
		TotalSold14d:     0,
		TotalSold30d:     0,
		TotalSold90d:     9,
		CurrentStock:     1,
		MinStock:         6,
		SupplierLeadDays: 8,
	}, demandaAsOf)

	if m.AvgDailySales <= 0 {
		t.Fatalf("AvgDailySales = %v; want > 0 (respaldo a la ventana de 90 dias)", m.AvgDailySales)
	}
	esperado90 := 9.0 / 90.0
	if math.Abs(m.AvgDailySales-esperado90) > 0.01 {
		t.Errorf("AvgDailySales = %v; want ~%v (tasa de 90 dias como respaldo)", m.AvgDailySales, esperado90)
	}
}

func TestDemandaReciente_SinVentasEnNingunaVentanaQuedaEnCero(t *testing.T) {
	m := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "MUERTO",
		CurrentStock:     3,
		SupplierLeadDays: 8,
	}, demandaAsOf)

	if m.AvgDailySales != 0 {
		t.Fatalf("AvgDailySales = %v; want 0", m.AvgDailySales)
	}
}

func TestDemandaReciente_LosDiasAgotadoNoCastiganLaTasa(t *testing.T) {
	// Vendió 10 en 14 días pero estuvo agotado 7 de esos días. La tasa real es
	// 10/7 = 1,43/día, no 10/14 = 0,71. Si se dividiera por los 14 días
	// completos, un producto que se agota siempre parecería vender poco y nunca
	// se repondría lo suficiente.
	m := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "AGOTADO_SEGUIDO",
		TotalSold14d:     10,
		DaysZeroStock14d: 7,
		CurrentStock:     0,
		SupplierLeadDays: 8,
	}, demandaAsOf)

	esperado := 10.0 / 7.0
	if math.Abs(m.AvgDailySales-esperado) > 0.01 {
		t.Fatalf("AvgDailySales = %v; want ~%v (10 unidades en los 7 dias que SI tuvo stock)",
			m.AvgDailySales, esperado)
	}
}

func TestDemandaReciente_LaVentanaCortaEsDeCatorceDias(t *testing.T) {
	// Fija el valor acordado. Si alguien lo cambia, que sea a propósito: a 7
	// días un fin de semana flojo distorsiona la tasa; a 30 se pierde la
	// reacción que el dueño necesita con proveedores que vuelven en 8.
	if restockWindowRecentDays != 14 {
		t.Fatalf("restockWindowRecentDays = %d; want 14", restockWindowRecentDays)
	}
}

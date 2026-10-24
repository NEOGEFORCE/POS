package services

import (
	"math"
	"testing"
)

// =============================================================================
// B2 — Flujo del día por canal (todayCashFlowDetail)
// =============================================================================

func TestBuildTodayCashFlowDetail_CasoTipico(t *testing.T) {
	// salesByMethod viene de GetSalesBreakdownByRange: YA incluye
	// credit_payments. No se vuelve a sumar.
	salesByMethod := map[string]float64{
		"EFECTIVO":  600_000,
		"NEQUI":     200_000,
		"DAVIPLATA": 100_000,
		"BOLD_QR":   80_000,
	}
	expensesByMethod := map[string]float64{
		"EFECTIVO":  50_000,
		"NEQUI":     20_000,
		"DAVIPLATA": 10_000,
		"BOLD_QR":   15_000,
	}
	cashReturns := 30_000.0

	d := BuildTodayCashFlowDetail(salesByMethod, expensesByMethod, cashReturns)

	// EFECTIVO: 600000 - 30000 (devoluciones) = 570000; egreso 50000.
	if d.Income["EFECTIVO"] != 570_000 {
		t.Errorf("income EFECTIVO = %v; want 570000 (neto de devoluciones)", d.Income["EFECTIVO"])
	}
	if d.Expense["EFECTIVO"] != 50_000 {
		t.Errorf("expense EFECTIVO = %v; want 50000", d.Expense["EFECTIVO"])
	}
	if d.Income["NEQUI"] != 200_000 {
		t.Errorf("income NEQUI = %v; want 200000", d.Income["NEQUI"])
	}
	if d.Income["DAVIPLATA"] != 100_000 {
		t.Errorf("income DAVIPLATA = %v; want 100000", d.Income["DAVIPLATA"])
	}
	if d.Income["BOLD_QR"] != 80_000 {
		t.Errorf("income BOLD_QR = %v; want 80000", d.Income["BOLD_QR"])
	}
	if d.Expense["BOLD_QR"] != 15_000 {
		t.Errorf("expense BOLD_QR = %v; want 15000", d.Expense["BOLD_QR"])
	}

	// Balance: (570 + 200 + 100 + 80) - (50 + 20 + 10 + 15) = 950 - 95 = 855 mil
	want := 570_000.0 + 200_000.0 + 100_000.0 + 80_000.0 -
		(50_000.0 + 20_000.0 + 10_000.0 + 15_000.0)
	if math.Abs(d.Balance-want) > 0.01 {
		t.Errorf("balance = %v; want %v", d.Balance, want)
	}
}

func TestBuildTodayCashFlowDetail_SinDobleConteoDeAbonos(t *testing.T) {
	// Caso clave B2: salesByMethod viene de GetSalesBreakdownByRange que
	// YA incluye credit_payments en EFECTIVO y en las transferencias. La
	// función NO debe aceptar un segundo mapa "dayCollectedByMethod" ni
	// sumarlo (de lo contrario, los abonos se cuentan dos veces).
	//
	// Verificamos que, pasando salesByMethod="completo" (con abonos
	// embebidos), el resultado NO infla.
	salesByMethod := map[string]float64{
		"EFECTIVO":  100_000, // 70k venta + 30k abono (ya unido en el repo)
		"NEQUI":     50_000,  // 40k venta + 10k abono
		"DAVIPLATA": 0,
		"BOLD_QR":   0,
	}
	expensesByMethod := map[string]float64{}
	d := BuildTodayCashFlowDetail(salesByMethod, expensesByMethod, 0)

	if d.Income["EFECTIVO"] != 100_000 {
		t.Fatalf("income EFECTIVO = %v; want 100000 (abonos ya incluidos vía GetSalesBreakdownByRange, no se vuelven a sumar)", d.Income["EFECTIVO"])
	}
	if d.Income["NEQUI"] != 50_000 {
		t.Fatalf("income NEQUI = %v; want 50000", d.Income["NEQUI"])
	}
	if d.Balance != 150_000 {
		t.Fatalf("balance = %v; want 150000", d.Balance)
	}
}

func TestBuildTodayCashFlowDetail_ClavesSiemprePresentes(t *testing.T) {
	d := BuildTodayCashFlowDetail(nil, nil, 0)
	for _, k := range []string{"EFECTIVO", "NEQUI", "DAVIPLATA", "BOLD_QR"} {
		if _, ok := d.Income[k]; !ok {
			t.Errorf("falta clave income[%s]", k)
		}
		if _, ok := d.Expense[k]; !ok {
			t.Errorf("falta clave expense[%s]", k)
		}
	}
	if d.Balance != 0 {
		t.Errorf("balance con mapas vacíos = %v; want 0", d.Balance)
	}
}

func TestBuildTodayCashFlowDetail_IgnoraCanalesExtraDelMapaDeVentas(t *testing.T) {
	// Si GetSalesBreakdownByRange trae canales adicionales (p.ej.
	// BANCOLOMBIA, TARJETA, TRANSFERENCIA agregado), el detalle sólo
	// expone los cuatro canales canónicos y NO los suma al balance (eso
	// corresponde al dashboard "ingresos digitales" global).
	salesByMethod := map[string]float64{
		"EFECTIVO":      100_000,
		"NEQUI":         50_000,
		"BANCOLOMBIA":   30_000,
		"TARJETA":       20_000,
		"TRANSFERENCIA": 50_000, // suma de nequi+davi+etc; no debe sumarse al balance
	}
	d := BuildTodayCashFlowDetail(salesByMethod, nil, 0)

	// Sólo los cuatro canónicos cuentan.
	if d.Balance != 150_000 {
		t.Fatalf("balance = %v; want 150000 (sólo EFECTIVO+NEQUI+DAVIPLATA+BOLD_QR)", d.Balance)
	}
	// Las claves extra NO se exponen.
	if _, ok := d.Income["BANCOLOMBIA"]; ok {
		t.Fatal("income no debería exponer BANCOLOMBIA (sólo los 4 canales canónicos)")
	}
	if _, ok := d.Income["TRANSFERENCIA"]; ok {
		t.Fatal("income no debería exponer TRANSFERENCIA agregada")
	}
}

func TestBuildTodayCashFlowDetail_EfectivoNetoDeDevoluciones(t *testing.T) {
	salesByMethod := map[string]float64{"EFECTIVO": 500_000}
	d := BuildTodayCashFlowDetail(salesByMethod, nil, 200_000)
	if d.Income["EFECTIVO"] != 300_000 {
		t.Fatalf("income EFECTIVO = %v; want 300000 (500k - 200k devoluciones)", d.Income["EFECTIVO"])
	}
	// Las devoluciones NO deben afectar otros canales.
	if d.Income["NEQUI"] != 0 {
		t.Fatalf("income NEQUI = %v; want 0 (devoluciones son sólo efectivo)", d.Income["NEQUI"])
	}
}

func TestBuildTodayCashFlowDetail_RedondeoACOP(t *testing.T) {
	salesByMethod := map[string]float64{"EFECTIVO": 100_000.49, "NEQUI": 50_000.51}
	expensesByMethod := map[string]float64{"EFECTIVO": 20.3}
	d := BuildTodayCashFlowDetail(salesByMethod, expensesByMethod, 0)
	if d.Income["EFECTIVO"] != 100_000 {
		t.Errorf("income EFECTIVO = %v; want 100000 (redondeo abajo)", d.Income["EFECTIVO"])
	}
	if d.Income["NEQUI"] != 50_001 {
		t.Errorf("income NEQUI = %v; want 50001 (redondeo arriba)", d.Income["NEQUI"])
	}
	if d.Expense["EFECTIVO"] != 20 {
		t.Errorf("expense EFECTIVO = %v; want 20", d.Expense["EFECTIVO"])
	}
}

// Caso turno completo con Bold QR: ventas QR, egresos QR, devoluciones en
// efectivo y abonos (ya embebidos en salesByMethod).
func TestBuildTodayCashFlowDetail_TurnoConBoldQR(t *testing.T) {
	salesByMethod := map[string]float64{
		"EFECTIVO":  1_200_000, // ventas + abonos efectivo
		"NEQUI":     300_000,   // ventas + abonos
		"DAVIPLATA": 50_000,
		"BOLD_QR":   250_000, // ventas y abonos QR
	}
	expensesByMethod := map[string]float64{
		"EFECTIVO":  100_000,
		"BOLD_QR":   25_000,
		"DAVIPLATA": 0,
		"NEQUI":     0,
		"FONDO":     80_000, // NO afecta el detalle (sólo los 4 canónicos)
	}

	d := BuildTodayCashFlowDetail(salesByMethod, expensesByMethod, 40_000)

	if d.Income["BOLD_QR"] != 250_000 {
		t.Errorf("income BOLD_QR = %v; want 250000", d.Income["BOLD_QR"])
	}
	if d.Expense["BOLD_QR"] != 25_000 {
		t.Errorf("expense BOLD_QR = %v; want 25000", d.Expense["BOLD_QR"])
	}
	if d.Income["EFECTIVO"] != 1_160_000 {
		t.Errorf("income EFECTIVO = %v; want 1160000 (1.2M - 40k devoluciones)", d.Income["EFECTIVO"])
	}

	// Balance = (1.16M + 300k + 50k + 250k) - (100k + 0 + 0 + 25k) = 1.76M - 125k = 1.635M
	wantBalance := 1_160_000.0 + 300_000.0 + 50_000.0 + 250_000.0 -
		(100_000.0 + 0 + 0 + 25_000.0)
	if math.Abs(d.Balance-wantBalance) > 0.01 {
		t.Errorf("balance = %v; want %v", d.Balance, wantBalance)
	}

	// El FONDO del expensesByMethod NO se cuenta en el detalle (sólo los
	// 4 canales canónicos).
	// Verificamos de forma indirecta: si lo hubiera sumado, el balance
	// cambiaría.
}

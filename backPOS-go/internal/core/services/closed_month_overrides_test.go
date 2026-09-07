package services

import "testing"

// Estos tests blindan el mecanismo de "venta fijada en meses cerrados".
// Lo que se protege, en orden de importancia:
//
//  1. Que el mes EN CURSO nunca quede fijado. Es la garantía que pidió el
//     dueño: no arriesgar los datos del mes que está corriendo.
//  2. Que el mes cerrado quede exactamente en la cifra que él dio.
//  3. Que no se toquen otros meses.

func TestClosedMonthOverride_FijaJulio2026EnLaCifraDelDueno(t *testing.T) {
	const esperado = 49_198_976.0
	got, ok := closedMonthSalesOverride["2026-07"]
	if !ok {
		t.Fatal("se perdió la cifra fijada para julio 2026")
	}
	if got != esperado {
		t.Fatalf("julio 2026 = %v; want %v", got, esperado)
	}
}

func TestApplyClosedMonthSalesOverrides_PisaElMesCerrado(t *testing.T) {
	salesByMonth := map[string]float64{
		"2026-07": 61_500_000, // valor inflado que salía del recálculo
		"2026-08": 12_345_678, // mes en curso
	}

	pinned := applyClosedMonthSalesOverrides(salesByMonth, "2026-08")

	if salesByMonth["2026-07"] != 49_198_976 {
		t.Fatalf("julio no quedó fijado: %v", salesByMonth["2026-07"])
	}
	if len(pinned) != 1 || pinned[0] != "2026-07" {
		t.Fatalf("meses fijados = %v; want [2026-07]", pinned)
	}
}

// EL CANDADO. Si alguien agrega el mes en curso al mapa, se ignora.
func TestApplyClosedMonthSalesOverrides_NuncaPisaElMesEnCurso(t *testing.T) {
	// Se simula el peor caso: el mapa trae el mes que está corriendo.
	original := closedMonthSalesOverride
	closedMonthSalesOverride = map[string]float64{
		"2026-08": 99_999_999,
	}
	defer func() { closedMonthSalesOverride = original }()

	const ventaRealDelMes = 12_345_678.0
	salesByMonth := map[string]float64{"2026-08": ventaRealDelMes}

	pinned := applyClosedMonthSalesOverrides(salesByMonth, "2026-08")

	if salesByMonth["2026-08"] != ventaRealDelMes {
		t.Fatalf("SE PISÓ EL MES EN CURSO: %v; debía quedar en %v",
			salesByMonth["2026-08"], ventaRealDelMes)
	}
	if len(pinned) != 0 {
		t.Fatalf("no debió fijar nada, fijó %v", pinned)
	}
}

func TestApplyClosedMonthSalesOverrides_NoInventaMesesNiTocaOtros(t *testing.T) {
	salesByMonth := map[string]float64{
		"2026-05": 30_000_000,
		"2026-06": 40_000_000,
		"2026-08": 12_000_000,
	}

	applyClosedMonthSalesOverrides(salesByMonth, "2026-08")

	if salesByMonth["2026-05"] != 30_000_000 {
		t.Fatalf("mayo cambió: %v", salesByMonth["2026-05"])
	}
	if salesByMonth["2026-06"] != 40_000_000 {
		t.Fatalf("junio cambió: %v", salesByMonth["2026-06"])
	}
	if salesByMonth["2026-08"] != 12_000_000 {
		t.Fatalf("agosto cambió: %v", salesByMonth["2026-08"])
	}
	// Julio no estaba en el mapa de entrada; el override lo agrega igual,
	// porque el dueño quiere ver esa cifra aunque no haya cierres cargados.
	if salesByMonth["2026-07"] != 49_198_976 {
		t.Fatalf("julio = %v; want la cifra fijada", salesByMonth["2026-07"])
	}
}

func TestApplyClosedMonthSalesOverrides_ToleraMapaNil(t *testing.T) {
	if pinned := applyClosedMonthSalesOverrides(nil, "2026-08"); pinned != nil {
		t.Fatalf("con mapa nil no debe fijar nada, dio %v", pinned)
	}
}

// Un valor en cero o negativo en el mapa no se aplica: sería peor que el
// recálculo, porque borraría la venta del mes en pantalla.
func TestApplyClosedMonthSalesOverrides_IgnoraValoresInvalidos(t *testing.T) {
	original := closedMonthSalesOverride
	closedMonthSalesOverride = map[string]float64{
		"2026-06": 0,
		"2026-07": -100,
	}
	defer func() { closedMonthSalesOverride = original }()

	salesByMonth := map[string]float64{
		"2026-06": 40_000_000,
		"2026-07": 61_500_000,
	}

	pinned := applyClosedMonthSalesOverrides(salesByMonth, "2026-08")

	if len(pinned) != 0 {
		t.Fatalf("no debió fijar nada con valores inválidos, fijó %v", pinned)
	}
	if salesByMonth["2026-06"] != 40_000_000 || salesByMonth["2026-07"] != 61_500_000 {
		t.Fatal("un valor inválido no puede borrar la venta calculada")
	}
}

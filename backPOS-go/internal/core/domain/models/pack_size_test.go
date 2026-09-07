package models

import "testing"

// ============================================================================
// EMPAQUE APRENDIDO DEL HISTORIAL DE RECEPCIONES
// ============================================================================
//
// Caso del dueño: las cuchillas llegan de a 12. No se puede sugerir pedir 1 o 2;
// cuando el stock baje hay que pedir la caja.

func TestLearnPackSize_CuchillasQueSiempreLleganDeADoce(t *testing.T) {
	// El caso textual del dueño: siempre la misma cantidad.
	got := LearnPackSize([]ReceptionQuantityCount{{Quantity: 12, Times: 5}})
	if got != 12 {
		t.Fatalf("empaque = %v; want 12", got)
	}
}

func TestLearnPackSize_ToleraAlgunaRecepcionSuelta(t *testing.T) {
	// 4 recepciones de 12 y una de 5 (un faltante del proveedor). El patron
	// sigue siendo 12: 4/5 = 0,8 supera el 0,6 exigido.
	got := LearnPackSize([]ReceptionQuantityCount{
		{Quantity: 12, Times: 4},
		{Quantity: 5, Times: 1},
	})
	if got != 12 {
		t.Fatalf("empaque = %v; want 12 (una recepcion suelta no rompe el patron)", got)
	}
}

func TestLearnPackSize_CantidadesIrregularesNoInventanEmpaque(t *testing.T) {
	// EL CASO QUE JUSTIFICA NO USAR MAXIMO COMUN DIVISOR: 12, 18 y 6 tienen MCD 6,
	// pero no hay ninguna cantidad que se repita, asi que no hay evidencia de
	// empaque. Inventar 6 obligaria al dueño a pedir de mas.
	got := LearnPackSize([]ReceptionQuantityCount{
		{Quantity: 12, Times: 1},
		{Quantity: 18, Times: 1},
		{Quantity: 6, Times: 1},
	})
	if got != 0 {
		t.Fatalf("empaque = %v; want 0 (sin repeticion no hay evidencia)", got)
	}
}

func TestLearnPackSize_PocasRecepcionesNoAlcanzan(t *testing.T) {
	// Dos coincidencias pueden ser casualidad.
	got := LearnPackSize([]ReceptionQuantityCount{{Quantity: 12, Times: 2}})
	if got != 0 {
		t.Fatalf("empaque = %v; want 0 (hacen falta al menos %d recepciones)", got, PackLearnMinReceptions)
	}
}

func TestLearnPackSize_IgnoraRecepcionesDeUnaUnidad(t *testing.T) {
	// Un "empaque" de 1 es lo mismo que no tener empaque, y las recepciones de 1
	// suelen ser ajustes.
	got := LearnPackSize([]ReceptionQuantityCount{{Quantity: 1, Times: 10}})
	if got != 0 {
		t.Fatalf("empaque = %v; want 0", got)
	}
}

func TestLearnPackSize_IgnoraCantidadesFraccionarias(t *testing.T) {
	// Productos pesados: media unidad no es un empaque.
	got := LearnPackSize([]ReceptionQuantityCount{{Quantity: 2.5, Times: 8}})
	if got != 0 {
		t.Fatalf("empaque = %v; want 0", got)
	}
}

func TestLearnPackSize_CajasMultiplesUsanLaMasChica(t *testing.T) {
	// Un proveedor que entrega 12 y 24 vende cajas de 12: los 24 son DOS cajas.
	// Pedir en multiplos de 12 es correcto en ambos casos.
	got := LearnPackSize([]ReceptionQuantityCount{
		{Quantity: 12, Times: 3},
		{Quantity: 24, Times: 3},
	})
	if got != 12 {
		t.Fatalf("empaque = %v; want 12 (24 son dos cajas de 12)", got)
	}
}

func TestLearnPackSize_ListaVaciaNoExplota(t *testing.T) {
	if got := LearnPackSize(nil); got != 0 {
		t.Fatalf("empaque = %v; want 0", got)
	}
}

// ============================================================================
// REDONDEO AL EMPAQUE
// ============================================================================

func TestRoundToPackSize_UnaUnidadNecesariaPideLaCajaCompleta(t *testing.T) {
	// EL PROBLEMA QUE RESUELVE: sin esto la sugerencia decia "pedir 1" en
	// productos que solo llegan de a 12.
	if got := RoundToPackSize(1, 12); got != 12 {
		t.Fatalf("cantidad = %v; want 12", got)
	}
	if got := RoundToPackSize(3, 12); got != 12 {
		t.Fatalf("cantidad = %v; want 12", got)
	}
}

func TestRoundToPackSize_MasDeUnaCajaRedondeaHaciaArriba(t *testing.T) {
	if got := RoundToPackSize(13, 12); got != 24 {
		t.Fatalf("cantidad = %v; want 24", got)
	}
	if got := RoundToPackSize(24, 12); got != 24 {
		t.Fatalf("cantidad = %v; want 24 (multiplo exacto no se infla)", got)
	}
}

func TestRoundToPackSize_SinNecesidadNoSePideCaja(t *testing.T) {
	// Si no hace falta nada, tener empaque no obliga a pedir.
	if got := RoundToPackSize(0, 12); got != 0 {
		t.Fatalf("cantidad = %v; want 0", got)
	}
	if got := RoundToPackSize(-5, 12); got != 0 {
		t.Fatalf("cantidad = %v; want 0", got)
	}
}

func TestRoundToPackSize_SinEmpaqueDejaLaCantidadIgual(t *testing.T) {
	if got := RoundToPackSize(7, 0); got != 7 {
		t.Fatalf("cantidad = %v; want 7", got)
	}
	if got := RoundToPackSize(7, 1); got != 7 {
		t.Fatalf("cantidad = %v; want 7", got)
	}
}

// El escenario completo que describio el dueño: caja de 12, stock en 3.
func TestEmpaque_EscenarioDelDueno_StockTresConCajaDeDoce(t *testing.T) {
	pack := LearnPackSize([]ReceptionQuantityCount{{Quantity: 12, Times: 4}})
	if pack != 12 {
		t.Fatalf("empaque aprendido = %v; want 12", pack)
	}

	// Minimo 12, stock 3, nada en camino: falta llegar al objetivo del 75%.
	necesidad := TargetShortfall(12, 3, 0)
	if necesidad <= 0 {
		t.Fatalf("necesidad = %v; se esperaba faltante con stock 3 de minimo 12", necesidad)
	}

	final := RoundToPackSize(necesidad, pack)
	if final != 12 {
		t.Fatalf("cantidad final = %v; want 12 (una caja completa)", final)
	}
}

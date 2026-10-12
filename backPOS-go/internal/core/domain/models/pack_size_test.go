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

// ============================================================================
// APRENDIZAJE DEL EMPAQUE ⇄ UMBRAL 20% (regla 2026-10)
// ============================================================================
//
// Conecta explicitamente LearnPackSize (sobre stock_movements reason=RECEPTION)
// con PackOrderQuantity. Expone dos constantes de UI:
//
//   habitualOrderQty         = packSize
//   habitualReorderThreshold = ceil(packSize * PackReorderRatio) = 20% del empaque
//
// El disparador real toma el MAX con 25% del minimo configurado, para que ni
// el habitual ni el minimo queden anulados por el otro:
//
//   threshold = max(ceil(packSize*0.20), ceil(minStock*0.25))

// 12→threshold3→qty12: con pack=12 el umbral habitual es ceil(2.4)=3. Al
// disparar se sugiere UNA caja habitual completa (12).
func TestPackOrderQuantity_Pack12_Umbral3_PideCajaCompleta(t *testing.T) {
	if got := PackReorderThreshold(12, 0); got != 3 {
		t.Fatalf("PackReorderThreshold(12, 0) = %v; want 3 (ceil(12*0.20))", got)
	}
	// En el umbral exacto (stock 3) se dispara.
	if got := PackOrderQuantity(0, 3, 0, 0, 12); got != 12 {
		t.Fatalf("stock 3 pide %v; want 12 (una caja habitual completa, no faltante)", got)
	}
	// Debajo del umbral tambien.
	if got := PackOrderQuantity(0, 0, 0, 0, 12); got != 12 {
		t.Fatalf("stock 0 pide %v; want 12", got)
	}
}

// stock4 no: con pack=12 y stock=4, el disponible esta por encima del umbral
// (3). No se dispara el pedido habitual.
func TestPackOrderQuantity_Pack12_Stock4_NoDispara(t *testing.T) {
	if got := PackOrderQuantity(0, 4, 0, 0, 12); got != 0 {
		t.Fatalf("stock 4 pide %v; want 0 (umbral 3, 4 queda por encima)", got)
	}
	// Stock 10 tampoco.
	if got := PackOrderQuantity(0, 10, 0, 0, 12); got != 0 {
		t.Fatalf("stock 10 pide %v; want 0", got)
	}
}

// minStock grande gana: la componente del minimo (ceil(100*0.25)=25) supera
// a la del empaque (ceil(12*0.20)=3). El umbral final queda en 25.
func TestPackOrderQuantity_MinStockGrande_UmbralDominadoPorElMinimo(t *testing.T) {
	// Umbral: max(3, 25) = 25.
	if got := PackReorderThreshold(12, 100); got != 25 {
		t.Fatalf("PackReorderThreshold(12, 100) = %v; want 25 (gana el 25%% del minimo)", got)
	}
	// Stock 26 queda arriba del umbral; no dispara.
	if got := PackOrderQuantity(0, 26, 0, 100, 12); got != 0 {
		t.Fatalf("stock 26 min 100 pide %v; want 0 (sobre el umbral 25)", got)
	}
	// Stock 25 esta EN el umbral; dispara una caja habitual.
	if got := PackOrderQuantity(0, 25, 0, 100, 12); got != 12 {
		t.Fatalf("stock 25 min 100 pide %v; want 12 (umbral del minimo)", got)
	}
	// Stock 0 tambien dispara una caja habitual, no 7 cajas.
	if got := PackOrderQuantity(0, 0, 0, 100, 12); got != 12 {
		t.Fatalf("stock 0 min 100 pide %v; want 12 (caja habitual, no cubre faltante)", got)
	}
}

// habitual gana sobre mínimo chico: con pack=12 (umbral 3) y minStock=4
// (umbral 1), el max es 3. El habitual no se posterga a que el stock caiga a 1.
func TestPackOrderQuantity_HabitualGanaSobreMinimoChico(t *testing.T) {
	// Umbral: max(3, 1) = 3.
	if got := PackReorderThreshold(12, 4); got != 3 {
		t.Fatalf("PackReorderThreshold(12, 4) = %v; want 3 (gana el 20%% del empaque)", got)
	}
	// Stock 3 dispara (no se espera a que caiga a 1).
	if got := PackOrderQuantity(0, 3, 0, 4, 12); got != 12 {
		t.Fatalf("stock 3 min 4 pide %v; want 12 (el habitual gana al minimo chico)", got)
	}
	// Stock 2 tambien.
	if got := PackOrderQuantity(0, 2, 0, 4, 12); got != 12 {
		t.Fatalf("stock 2 min 4 pide %v; want 12", got)
	}
	// Stock 4 queda arriba del umbral; no dispara.
	if got := PackOrderQuantity(0, 4, 0, 4, 12); got != 0 {
		t.Fatalf("stock 4 min 4 pide %v; want 0 (sobre el umbral del habitual)", got)
	}
}

// pack0 conserva comportamiento: sin empaque aprendido la funcion devuelve 0
// (el llamador cae al pedido unitario SuggestedOrderQty, no interfiere).
func TestPackOrderQuantity_Pack0_ConservaComportamiento(t *testing.T) {
	if got := PackReorderThreshold(0, 100); got != 0 {
		t.Fatalf("PackReorderThreshold(0, 100) = %v; want 0 (sin empaque, sin umbral habitual)", got)
	}
	if got := PackOrderQuantity(50, 0, 0, 100, 0); got != 0 {
		t.Fatalf("pack 0 pide %v; want 0 (sin empaque, PackOrderQuantity no decide)", got)
	}
	if got := PackOrderQuantity(0, 0, 0, 0, 1); got != 0 {
		t.Fatalf("pack 1 pide %v; want 0 (empaque de 1 = sin empaque)", got)
	}
	// Pack negativo tambien se trata como sin empaque.
	if got := PackOrderQuantity(0, 0, 0, 10, -3); got != 0 {
		t.Fatalf("pack negativo pide %v; want 0", got)
	}
}

// tránsito cubre: una caja ya en camino bloquea el pedido duplicado porque
// se descuenta via disponible = stock + transito. Mantiene la caja habitual
// como unidad de pedido pero evita doblar.
func TestPackOrderQuantity_TransitoCubreYBloqueaDuplicado(t *testing.T) {
	// Stock 1 (en umbral) pero caja de 12 ya viene en camino: NO se pide otra.
	if got := PackOrderQuantity(0, 1, 12, 12, 12); got != 0 {
		t.Fatalf("stock 1 con caja de 12 en transito pide %v; want 0 (ya cubierto)", got)
	}
	// Sin transito, con mismo stock, SI pide.
	if got := PackOrderQuantity(0, 1, 0, 12, 12); got != 12 {
		t.Fatalf("stock 1 sin transito pide %v; want 12", got)
	}
	// Transito que apenas cubre el umbral (3) tambien bloquea.
	if got := PackOrderQuantity(0, 0, 4, 12, 12); got != 0 {
		t.Fatalf("stock 0 + transito 4 (umbral 3) pide %v; want 0", got)
	}
	// Transito que no alcanza al umbral deja pasar el pedido.
	if got := PackOrderQuantity(0, 0, 2, 12, 12); got != 12 {
		t.Fatalf("stock 0 + transito 2 (debajo del umbral 3) pide %v; want 12", got)
	}
	// Transito aislado sin minimo configurado: tambien bloquea.
	if got := PackOrderQuantity(0, 0, 12, 0, 12); got != 0 {
		t.Fatalf("stock 0 + transito 12 sin minimo pide %v; want 0", got)
	}
}

// minStock0 stock0/positivo ambos sin_minimo: el semaforo pinta UNSET para
// minStock<=0 independientemente del stock. Nunca rojo/critico.
func TestClassifyStockBand_MinStockCero_SiempreUnset(t *testing.T) {
	// Stock 0 con minimo 0: UNSET (regla 2026-10), no RED.
	if got := ClassifyStockBand(0, 0); got != StockBandUnset {
		t.Fatalf("ClassifyStockBand(0, 0) = %q; want %q (nunca rojo con minimo 0)", got, StockBandUnset)
	}
	// Stock negativo con minimo 0: tambien UNSET.
	if got := ClassifyStockBand(-5, 0); got != StockBandUnset {
		t.Fatalf("ClassifyStockBand(-5, 0) = %q; want %q", got, StockBandUnset)
	}
	// Stock positivo con minimo 0: UNSET.
	if got := ClassifyStockBand(10, 0); got != StockBandUnset {
		t.Fatalf("ClassifyStockBand(10, 0) = %q; want %q", got, StockBandUnset)
	}
	// Minimo negativo tambien se trata como sin minimo.
	if got := ClassifyStockBand(0, -1); got != StockBandUnset {
		t.Fatalf("ClassifyStockBand(0, -1) = %q; want %q", got, StockBandUnset)
	}
	// Verificacion por simetria: con minimo positivo si se activa la banda.
	if got := ClassifyStockBand(0, 10); got != StockBandRed {
		t.Fatalf("ClassifyStockBand(0, 10) = %q; want %q (minimo positivo si pinta rojo)", got, StockBandRed)
	}
}

// Umbral del habitual expuesto al frontend: ceil(packSize * 0.20).
// Es el numero que la UI usa para explicar "pedir cuando quede <= N".
func TestPackReorderThreshold_HabitualOnly_SinMinimo(t *testing.T) {
	cases := []struct {
		packSize float64
		want     float64
	}{
		{packSize: 6, want: 2},    // ceil(1.2)
		{packSize: 12, want: 3},   // ceil(2.4)
		{packSize: 24, want: 5},   // ceil(4.8)
		{packSize: 10, want: 2},   // ceil(2.0)
		{packSize: 100, want: 20}, // ceil(20.0)
	}
	for _, tc := range cases {
		if got := PackReorderThreshold(tc.packSize, 0); got != tc.want {
			t.Errorf("PackReorderThreshold(%v, 0) = %v; want %v (ceil(%v*0.20))",
				tc.packSize, got, tc.want, tc.packSize)
		}
	}
}

// Combinacion de aprendizaje y disparador: el habitual aprendido con 4
// recepciones de 12 fija packSize=12, y el pedido en stock 3 sugiere la
// caja completa. Es el punto final del cableado "LearnPackSize ⇄ 20% ⇄ caja".
func TestEmpaque_AprendizajeConUmbral20_SugierePack(t *testing.T) {
	pack := LearnPackSize([]ReceptionQuantityCount{{Quantity: 12, Times: 4}})
	if pack != 12 {
		t.Fatalf("empaque aprendido = %v; want 12", pack)
	}
	threshold := PackReorderThreshold(pack, 0) // sin minimo configurado
	if threshold != 3 {
		t.Fatalf("umbral habitual = %v; want 3", threshold)
	}
	// En el umbral se pide una caja completa.
	got := PackOrderQuantity(0, threshold, 0, 0, pack)
	if got != pack {
		t.Fatalf("sugerencia = %v; want %v (caja habitual completa)", got, pack)
	}
}

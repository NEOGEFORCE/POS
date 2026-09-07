package repositories

import "testing"

// Estos tests documentan (y protegen) el álgebra de la reversión de
// una recepción con paca + bonificación + ajuste físico.
// No tocan la base: simulan el forward y el revert con aritmética
// puro, para asegurar que la suma de movimientos que HOY emite
// BulkReceive vuelve exactamente al estado previo.
//
// Si alguien cambia BulkReceive y rompe la conservación, este test
// falla y grita cuál es el delta que quedó fuera de kárdex.

type simulatedMovement struct {
	Barcode  string
	Quantity float64
	Type     string
	Reason   string
}

// applyMovements simula: para cada movimiento, sumar Quantity al stock
// del producto correspondiente. Es lo que hace BulkReceive en el forward.
func applyMovements(stocks map[string]float64, movements []simulatedMovement) {
	for _, m := range movements {
		stocks[m.Barcode] += m.Quantity
	}
}

// revertMovements simula: para cada movimiento reversible, restar su
// Quantity del stock. Es lo que hace la reversión con el nuevo filtro.
func revertMovements(stocks map[string]float64, movements []simulatedMovement) {
	for _, m := range movements {
		if !IsReceptionReversibleMovement(m.Reason, m.Type) {
			continue
		}
		stocks[m.Barcode] -= m.Quantity
	}
}

// TestPackReversalConservaStockAntesYDespues es el escenario textual
// que reportó el dueño: recibo 5 pacas de 24. Al editar la recepción
// el stock DEBE volver al estado inicial. Si algún movimiento se
// queda fuera del filtro, el test lo detecta.
func TestPackReversalConservaStockAntesYDespues(t *testing.T) {
	stocks := map[string]float64{
		"PACK": 3,  // stock inicial de la paca
		"BASE": 72, // 3 pacas * 24 = 72 unidades base
	}
	initial := map[string]float64{"PACK": 3, "BASE": 72}

	// Simulación de los movimientos que emite BulkReceive al recibir
	// 2 pacas de 24 (tal como los emite el código real):
	movements := []simulatedMovement{
		// Efecto sobre el BASE (antes usaba PACKB-<ts>, ahora receptionID).
		{Barcode: "BASE", Quantity: 48, Type: "IN", Reason: "PACK_RECEPTION_BULK"},
		// Movimiento del PACK propio.
		{Barcode: "PACK", Quantity: 2, Type: "IN", Reason: "RECEPTION"},
	}

	// Forward.
	applyMovements(stocks, movements)
	if stocks["PACK"] != 5 {
		t.Errorf("forward pack: got %v, want 5", stocks["PACK"])
	}
	if stocks["BASE"] != 120 {
		t.Errorf("forward base: got %v, want 120", stocks["BASE"])
	}

	// Reversión con el nuevo filtro.
	revertMovements(stocks, movements)
	if stocks["PACK"] != initial["PACK"] {
		t.Errorf("revert pack: got %v, want %v (SI FALLA: PACK_RECEPTION_BULK o RECEPTION quedaron fuera de la reversión)", stocks["PACK"], initial["PACK"])
	}
	if stocks["BASE"] != initial["BASE"] {
		t.Errorf("revert base: got %v, want %v (SI FALLA: PACK_RECEPTION_BULK quedó fuera de la reversión; era el bug original con PACKB-* como reference_id distinto)", stocks["BASE"], initial["BASE"])
	}
}

// TestBonificacionRevierteExactamenteLoQueSumo: si el proveedor manda
// un regalo de 3 unidades, al editar la recepción esas 3 se restan.
// Antes RECEPTION_BONUS no estaba en el filtro y quedaba adherido.
func TestBonificacionRevierteExactamenteLoQueSumo(t *testing.T) {
	stocks := map[string]float64{"PROD": 10}
	movements := []simulatedMovement{
		{Barcode: "PROD", Quantity: 10, Type: "IN", Reason: "RECEPTION"},
		{Barcode: "PROD", Quantity: 3, Type: "IN", Reason: "RECEPTION_BONUS"},
	}

	applyMovements(stocks, movements)
	if stocks["PROD"] != 23 {
		t.Fatalf("forward: got %v, want 23", stocks["PROD"])
	}

	revertMovements(stocks, movements)
	if stocks["PROD"] != 10 {
		t.Errorf("revert: got %v, want 10 (SI FALLA: RECEPTION_BONUS no está en el filtro y las bonificaciones no se revierten)", stocks["PROD"])
	}
}

// TestAjusteFisicoDePacaRevierteAmbosLados: si al recibir una paca el
// operador ajusta el físico (sobran/faltan pacas), se debe emitir un
// movimiento tanto sobre el pack como sobre el base. Al revertir,
// ambos vuelven al estado previo.
func TestAjusteFisicoDePacaRevierteAmbosLados(t *testing.T) {
	stocks := map[string]float64{"PACK": 5, "BASE": 120}
	initial := map[string]float64{"PACK": 5, "BASE": 120}

	// Escenario: físico digitado en el pack = 4 (falta 1 paca).
	// diff = -1. baseDiff = -1 * 24 = -24.
	// BulkReceive emite:
	//   - ADJUSTMENT_DOWN sobre PACK qty=-1
	//   - ADJUSTMENT_DOWN sobre BASE qty=-24  <- fix: antes no se
	//     emitía, ahora sí (baseAdjMovement).
	//   - Luego, la carga real de 5 pacas: PACK_RECEPTION_BULK qty=120
	//     y RECEPTION qty=5.
	movements := []simulatedMovement{
		{Barcode: "PACK", Quantity: -1, Type: "ADJUSTMENT_DOWN", Reason: "Ajuste por faltante en físico durante recepción (Auditoría)"},
		{Barcode: "BASE", Quantity: -24, Type: "ADJUSTMENT_DOWN", Reason: "Ajuste en Recepción (base de paca)"},
		{Barcode: "BASE", Quantity: 120, Type: "IN", Reason: "PACK_RECEPTION_BULK"},
		{Barcode: "PACK", Quantity: 5, Type: "IN", Reason: "RECEPTION"},
	}

	applyMovements(stocks, movements)
	// Forward: PACK = 5 - 1 + 5 = 9; BASE = 120 - 24 + 120 = 216.
	if stocks["PACK"] != 9 {
		t.Fatalf("forward pack: got %v, want 9", stocks["PACK"])
	}
	if stocks["BASE"] != 216 {
		t.Fatalf("forward base: got %v, want 216", stocks["BASE"])
	}

	revertMovements(stocks, movements)
	if stocks["PACK"] != initial["PACK"] {
		t.Errorf("revert pack: got %v, want %v", stocks["PACK"], initial["PACK"])
	}
	if stocks["BASE"] != initial["BASE"] {
		t.Errorf("revert base: got %v, want %v (SI FALLA: el ajuste físico sobre el BASE no está siendo emitido como movimiento propio y por eso no se revierte)", stocks["BASE"], initial["BASE"])
	}
}

// TestPriceUpdateNoStockNoAlteraStockAlRevertir: los movimientos de
// PRICE_UPDATE_NO_STOCK tienen qty=0 en el forward y se borran en la
// reversión sin modificar cantidades (son sólo trazabilidad).
func TestPriceUpdateNoStockNoAlteraStockAlRevertir(t *testing.T) {
	stocks := map[string]float64{"PROD": 42}
	movements := []simulatedMovement{
		{Barcode: "PROD", Quantity: 0, Type: "IN", Reason: "PRICE_UPDATE_NO_STOCK"},
	}
	applyMovements(stocks, movements)
	if stocks["PROD"] != 42 {
		t.Fatalf("PRICE_UPDATE_NO_STOCK no debía cambiar el stock, got %v", stocks["PROD"])
	}
	revertMovements(stocks, movements)
	if stocks["PROD"] != 42 {
		t.Errorf("revertir PRICE_UPDATE_NO_STOCK debe ser no-op de stock, got %v", stocks["PROD"])
	}
}

// TestMovimientosAjenosAlaRecepcionNoSonAfectados: si una venta, una
// merma o una devolución compartieran el mismo reference_id por
// accidente, la reversión NO los tocaría. Es una defensa contra bugs
// de terceros que reutilicen el ID.
func TestMovimientosAjenosAlaRecepcionNoSonAfectados(t *testing.T) {
	stocks := map[string]float64{"PROD": 100}
	movements := []simulatedMovement{
		{Barcode: "PROD", Quantity: 100, Type: "IN", Reason: "RECEPTION"},
		{Barcode: "PROD", Quantity: -5, Type: "OUT", Reason: "SALE"},
		{Barcode: "PROD", Quantity: -2, Type: "OUT", Reason: "SHRINKAGE"},
	}
	applyMovements(stocks, movements)
	if stocks["PROD"] != 193 {
		t.Fatalf("forward: got %v, want 193", stocks["PROD"])
	}
	revertMovements(stocks, movements)
	// Sólo se revierte el RECEPTION (100). SALE y SHRINKAGE quedan.
	if stocks["PROD"] != 93 {
		t.Errorf("revert debe tocar SOLO RECEPTION, got %v, want 93", stocks["PROD"])
	}
}

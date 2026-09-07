package repositories

import "testing"

// La lista de reasons a revertir es lo que evita que la edición de una
// recepción con pacas o bonos duplique el stock. Estos tests fallan si
// alguien accidentalmente saca uno de la lista.

func TestReceptionMovementReasonsIncluyeTodosLosCasosDeBulkReceive(t *testing.T) {
	requeridos := map[string]string{
		"RECEPTION":             "movimiento del producto recibido",
		"RECEPTION_BONUS":       "bonificación del proveedor",
		"PACK_RECEPTION_BULK":   "efecto sobre el producto base al recibir pacas",
		"PRICE_UPDATE_NO_STOCK": "recepción de solo actualización de precios",
	}

	present := make(map[string]bool, len(ReceptionMovementReasons))
	for _, r := range ReceptionMovementReasons {
		present[r] = true
	}

	for reason, purpose := range requeridos {
		if !present[reason] {
			t.Errorf("reason %q (%s) NO está en ReceptionMovementReasons; su reversión no ocurrirá y se duplicará stock", reason, purpose)
		}
	}
}

func TestReceptionAdjustmentTypesCubreAmbasDirecciones(t *testing.T) {
	// Los ajustes físicos usan reason en texto libre (español), así
	// que la única forma segura de encontrarlos es por Type.
	if len(ReceptionAdjustmentTypes) != 2 {
		t.Fatalf("se esperan exactamente 2 tipos de ajuste, hay %d", len(ReceptionAdjustmentTypes))
	}
	types := map[string]bool{}
	for _, x := range ReceptionAdjustmentTypes {
		types[x] = true
	}
	if !types["ADJUSTMENT_UP"] {
		t.Error("falta ADJUSTMENT_UP (sobrante físico)")
	}
	if !types["ADJUSTMENT_DOWN"] {
		t.Error("falta ADJUSTMENT_DOWN (faltante físico)")
	}
}

func TestIsReceptionReversibleMovementReconoceCadaCaso(t *testing.T) {
	cases := []struct {
		name       string
		reason     string
		mvmtType   string
		reversible bool
	}{
		{"recepción normal", "RECEPTION", "IN", true},
		{"bonificación", "RECEPTION_BONUS", "IN", true},
		{"base de una paca", "PACK_RECEPTION_BULK", "IN", true},
		{"actualización de precio sin stock", "PRICE_UPDATE_NO_STOCK", "IN", true},

		// Ajustes físicos: reason es texto libre en español, se
		// identifican por type.
		{"ajuste físico arriba (paca base)", "Ajuste en Recepción (base de paca)", "ADJUSTMENT_UP", true},
		{"ajuste físico abajo", "Ajuste por faltante en físico durante recepción (Auditoría)", "ADJUSTMENT_DOWN", true},
		{"ajuste físico arriba", "Ajuste en Recepción", "ADJUSTMENT_UP", true},

		// Casos que NO deben tocarse durante la reversión.
		{"venta", "SALE", "OUT", false},
		{"devolución de venta", "RETURN", "IN", false},
		{"merma", "SHRINKAGE", "OUT", false},
		{"apertura de caja", "OPEN", "IN", false},
		{"ajuste manual fuera de recepción", "MANUAL_ADJUSTMENT", "OUT", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := IsReceptionReversibleMovement(tc.reason, tc.mvmtType)
			if got != tc.reversible {
				t.Errorf("IsReceptionReversibleMovement(%q, %q) = %v, want %v", tc.reason, tc.mvmtType, got, tc.reversible)
			}
		})
	}
}

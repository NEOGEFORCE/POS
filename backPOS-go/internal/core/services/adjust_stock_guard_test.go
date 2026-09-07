package services

import (
	"testing"
)

// TestValidateStockAdjustment cubre el bug del botón "+" en caja: cuando un
// producto está en stock negativo, cualquier ajuste positivo debe pasar aunque
// el resultado siga siendo negativo (no se puede recuperar desde -3 si la
// guarda antigua exige que quede >=0).
//
// La guarda sólo debe frenar ajustes hacia abajo que hagan al stock más
// negativo de lo actual.
func TestValidateStockAdjustment(t *testing.T) {
	cases := []struct {
		name        string
		current     float64
		delta       float64
		expectError bool
	}{
		// Bug reproducido: producto en -3, se pulsa +1. Antes bloqueaba porque
		// -3 + 1 = -2 sigue siendo < 0. Ahora pasa porque cualquier ajuste
		// hacia arriba está permitido.
		{name: "recupera desde negativo con delta positivo", current: -3, delta: 1, expectError: false},
		// Ajustes positivos siempre pasan, sin importar la existencia previa.
		{name: "suma sobre stock cero", current: 0, delta: 5, expectError: false},
		{name: "suma sobre stock positivo", current: 10, delta: 3, expectError: false},
		{name: "suma grande recuperando desde muy negativo", current: -100, delta: 50, expectError: false},
		// Ajustes hacia abajo que dejan >=0 también pasan.
		{name: "resta que deja exactamente en cero", current: 5, delta: -5, expectError: false},
		{name: "resta que deja stock positivo", current: 10, delta: -3, expectError: false},
		// Ajustes hacia abajo que dejarían más negativo: se bloquean, EXCEPTO
		// que estemos yendo por encima de la disponibilidad actual.
		{name: "resta que llevaría a negativo bloquea", current: 2, delta: -5, expectError: true},
		{name: "resta desde negativo bloquea (más negativo)", current: -3, delta: -1, expectError: true},
		{name: "resta desde cero bloquea", current: 0, delta: -1, expectError: true},
		// Casos borde: delta=0 nunca ocurre porque AdjustStock lo rechaza
		// antes, pero la función debe tratarlo como no negativo (pasa).
		{name: "delta cero pasa", current: -3, delta: 0, expectError: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateStockAdjustment(tc.current, tc.delta)
			if tc.expectError && err == nil {
				t.Fatalf("current=%v delta=%v: se esperaba error y no llegó", tc.current, tc.delta)
			}
			if !tc.expectError && err != nil {
				t.Fatalf("current=%v delta=%v: no debía fallar, dio: %v", tc.current, tc.delta, err)
			}
		})
	}
}

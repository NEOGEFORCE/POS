package models

import "testing"

// ============================================================================
// PRODUCTOS CON CAJA: SE PIDE TARDE Y SE PIDE UNA CAJA
// ============================================================================
//
// Regla final del dueño (2026-09-05), textual:
//
//	"no me gusta porque quedariamos con mucho producto de uno y faltando el otro,
//	 entonces es mejor que si llega a 3 o menos ahi si pedir porque los productos
//	 normalmente llegan entre 1 y 2 dias entonces esos 3 aguantan y ya cuando
//	 lleguen quedamos en 15"
//
// Es una decision de FLUJO DE CAJA: comprar por caja siempre deja el stock por
// encima del minimo, asi que adelantar la compra no ahorra nada y solo inmoviliza
// plata que otro producto puede necesitar.

func TestPackOrder_MinimoDoceCajaDoce_DisparaEnTresYQuedaEnQuince(t *testing.T) {
	const minStock, pack = 12.0, 12.0

	casos := []struct {
		stock, want float64
		por         string
	}{
		{stock: 12, want: 0, por: "sano"},
		{stock: 10, want: 0, por: "arriba del umbral rojo (3)"},
		{stock: 8, want: 0, por: "arriba del umbral rojo; antes pedia caja aca"},
		{stock: 4, want: 0, por: "todavia arriba de 3"},
		{stock: 3, want: 12, por: "EN el umbral: pide la caja y queda en 15"},
		{stock: 2, want: 12, por: "debajo del umbral"},
		{stock: 0, want: 12, por: "agotado"},
	}

	for _, c := range casos {
		got := PackOrderQuantity(0, c.stock, 0, minStock, pack)
		if got != c.want {
			t.Errorf("stock %v: pide %v; want %v (%s)", c.stock, got, c.want, c.por)
		}
	}
}

func TestPackOrder_QuedaEnQuinceComoLoDescribioElDueno(t *testing.T) {
	pedido := PackOrderQuantity(0, 3, 0, 12, 12)
	if final := 3 + pedido; final != 15 {
		t.Fatalf("stock final = %v; want 15", final)
	}
}

func TestPackOrder_LoQueVieneEnCaminoEvitaPedirOtraCaja(t *testing.T) {
	// Stock 2 (en rojo) pero ya hay una caja en transito: no se pide otra.
	if got := PackOrderQuantity(0, 2, 12, 12, 12); got != 0 {
		t.Fatalf("pide %v; want 0 (ya viene una caja)", got)
	}
}

func TestPackOrder_MinimoGrandeConCajaChicaPideVariasCajas(t *testing.T) {
	// Minimo 100, caja de 12, stock 0. Umbral rojo 25; objetivo 75.
	// Necesidad 75 -> 7 cajas = 84.
	got := PackOrderQuantity(0, 0, 0, 100, 12)
	if got != 84 {
		t.Fatalf("pide %v; want 84 (7 cajas de 12 para cubrir 75)", got)
	}
}

func TestPackOrder_SinMinimoMandaLaDemanda(t *testing.T) {
	// Sin minimo no hay umbral rojo que medir. Con ideal 20 y stock 0, la
	// necesidad es 20 -> 2 cajas de 12 = 24.
	got := PackOrderQuantity(20, 0, 0, 0, 12)
	if got != 24 {
		t.Fatalf("pide %v; want 24", got)
	}
}

func TestPackOrder_SinEmpaqueNoAplica(t *testing.T) {
	if got := PackOrderQuantity(0, 0, 0, 12, 1); got != 0 {
		t.Fatalf("pide %v; want 0 (sin empaque esta funcion no decide)", got)
	}
}

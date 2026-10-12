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

func TestPackOrder_MinimoGrandeConCajaChicaPideUnaCajaHabitual(t *testing.T) {
	// Minimo 100, caja de 12, stock 0.
	//
	// Umbral de reposicion habitual = max(ceil(12*0.20), ceil(100*0.25)) = max(3, 25)
	// = 25. Dispara en cuanto el stock+transito cae por debajo de 25.
	//
	// Regla 2026-10: aunque la "necesidad" del minimo sea grande (75%), la
	// sugerencia habitual es UNA caja. Pedir multiples cajas de golpe cuando
	// el proveedor vuelve en 1-2 dias inmoviliza plata; el operador puede
	// aumentar la cantidad a mano si lo necesita.
	got := PackOrderQuantity(0, 0, 0, 100, 12)
	if got != 12 {
		t.Fatalf("pide %v; want 12 (una caja habitual, aunque el minimo sea grande)", got)
	}
}

func TestPackOrder_SinMinimoDispara_UmbralEnVeintePorCientoDelEmpaque(t *testing.T) {
	// Sin minimo (minStock=0), caja de 12.
	//
	// Umbral = max(ceil(12*0.20), 0) = 3. El 20% del empaque es la unica
	// señal cuando no hay minimo. En stock 0 dispara y sugiere UNA caja de 12,
	// no "cantidades que cubran la demanda" como hacia antes.
	got := PackOrderQuantity(20, 0, 0, 0, 12)
	if got != 12 {
		t.Fatalf("pide %v; want 12 (una caja habitual, el 20%% del empaque es el umbral sin minimo)", got)
	}
}

func TestPackOrder_SinEmpaqueNoAplica(t *testing.T) {
	if got := PackOrderQuantity(0, 0, 0, 12, 1); got != 0 {
		t.Fatalf("pide %v; want 0 (sin empaque esta funcion no decide)", got)
	}
}

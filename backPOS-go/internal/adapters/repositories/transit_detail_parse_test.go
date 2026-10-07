package repositories

import "testing"

// parseTransitDetailJSON es una funcion pura que decodifica el JSON agregado
// en el SQL de /restock/suggestions-v2. Los tests cubren los casos que mas
// importan para la UI cross-proveedor:
//
//   - Transito vacio -> nil (el frontend oculta el aviso).
//   - Varios proveedores -> N entradas con sus datos de supplier/orden/fecha.
//   - JSON invalido o cantidades <= 0 -> se descartan sin fallar.
//
// Es un contrato con el frontend: cualquier cambio aqui tiene que cuidarse
// porque la pantalla de pedidos lo usa para armar el mensaje "6 en camino
// de HERMARLY".

func TestParseTransitDetailJSONVacioDaNil(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"", "[]", "null"} {
		if got := parseTransitDetailJSON(raw, "770123", "PRODUCTO"); got != nil {
			t.Fatalf("transito vacio con raw=%q: got %+v; want nil", raw, got)
		}
	}
}

func TestParseTransitDetailJSONVariosProveedores(t *testing.T) {
	t.Parallel()
	raw := `[
		{"s": 7, "n": "HERMARLY", "q": 6, "o": "co-1", "d": "2026-10-04"},
		{"s": 9, "n": "POSTOBON", "q": 4, "o": "co-2", "d": "2026-10-07"}
	]`
	got := parseTransitDetailJSON(raw, "770123", "PRODUCTO X")
	if len(got) != 2 {
		t.Fatalf("entradas = %d; want 2", len(got))
	}
	// Verificar que el productId se completa desde el padre (el agregado SQL
	// NO lo incluye por fila).
	for _, item := range got {
		if item.ProductID != "770123" {
			t.Errorf("ProductID no inyectado: %q", item.ProductID)
		}
		if item.ProductName != "PRODUCTO X" {
			t.Errorf("ProductName no inyectado: %q", item.ProductName)
		}
	}
	if got[0].SupplierName != "HERMARLY" || got[0].Quantity != 6 || got[0].OrderID != "co-1" || got[0].ExpectedDate != "2026-10-04" {
		t.Errorf("primera entrada mal parseada: %+v", got[0])
	}
	if got[1].SupplierID != 9 || got[1].SupplierName != "POSTOBON" {
		t.Errorf("segunda entrada mal parseada: %+v", got[1])
	}
}

func TestParseTransitDetailJSONDescartaCantidadesNoPositivas(t *testing.T) {
	t.Parallel()
	// Una cantidad 0 no deberia existir en la base (HAVING SUM > 0 en el SQL),
	// pero el parser blinda por si acaso.
	raw := `[
		{"s": 7, "n": "HERMARLY", "q": 0, "o": "co-1", "d": ""},
		{"s": 9, "n": "POSTOBON", "q": -1, "o": "co-2", "d": ""},
		{"s": 11, "n": "COCA", "q": 2, "o": "co-3", "d": ""}
	]`
	got := parseTransitDetailJSON(raw, "p", "P")
	if len(got) != 1 {
		t.Fatalf("entradas validas = %d; want 1 (coca)", len(got))
	}
	if got[0].SupplierName != "COCA" {
		t.Errorf("se esperaba conservar solo COCA; got %+v", got[0])
	}
}

func TestParseTransitDetailJSONToleraSupplierDesconocido(t *testing.T) {
	t.Parallel()
	// Dato historico: proveedor borrado -> supplier_id = 0, nombre vacio.
	raw := `[{"s": 0, "n": "", "q": 3, "o": "po-99", "d": "2026-01-01"}]`
	got := parseTransitDetailJSON(raw, "p", "P")
	if len(got) != 1 || got[0].SupplierID != 0 || got[0].SupplierName != "" {
		t.Fatalf("fila sin proveedor debe conservarse: %+v", got)
	}
}

func TestParseTransitDetailJSONJSONInvalidoNoRompe(t *testing.T) {
	t.Parallel()
	// Un JSON corrupto NO debe tumbar la respuesta: se omite el desglose y
	// el total general (inTransitQty) sigue siendo el valor autoritativo.
	if got := parseTransitDetailJSON("{bad json", "p", "P"); got != nil {
		t.Fatalf("json invalido debe devolver nil: %+v", got)
	}
}

package repositories

import (
	"os"
	"strings"
	"testing"
)

// ============================================================================
// CON UN PROVEEDOR ELEGIDO SE VEN TODOS SUS PRODUCTOS
// ============================================================================
//
// El dueno lo reclamo TRES veces: "no me esta trayendo todos los productos que
// tiene un proveedor".
//
// Hubo DOS causas encadenadas:
//
//  1. La consulta arrancaba con 'FROM product_restock_metrics JOIN products',
//     un JOIN INTERNO, asi que un producto sin fila de metricas no existia. Y
//     esa tabla la llena el batch nocturno, que estaba abortando. Ya corregido:
//     ahora arranca desde products con LEFT JOIN (ver
//     TestCandidatosArrancaDesdeProducts).
//
//  2. El filtro de "solo prioridades" (include_all=false) seguia escondiendo los
//     productos VERDES y SIN MINIMO incluso con un proveedor elegido. Ese filtro
//     existe para no mandar miles de tarjetas al celular en la vista GLOBAL,
//     pero cuando ya elegiste proveedor el objetivo es otro: ver su catalogo y
//     decidir. Este test fija esa regla.

func leerRepoFuente(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("restock_metrics_repository.go")
	if err != nil {
		t.Fatalf("no se pudo leer el repositorio: %v", err)
	}
	return string(b)
}

func TestProveedorElegidoMuestraTodoSuCatalogo(t *testing.T) {
	source := leerRepoFuente(t)

	// La condicion debe contemplar el proveedor elegido, no solo include_all.
	if !strings.Contains(source, "mostrarTodo := params.IncludeAll || filterSupplierID != 0") {
		t.Fatal("con un proveedor elegido se deben mostrar todos sus productos: " +
			"la condicion debe ser 'params.IncludeAll || filterSupplierID != 0'")
	}

	// Y el filtro de prioridades debe consultar esa variable, no IncludeAll suelto.
	if strings.Contains(source, "if !params.IncludeAll {\n\t\t\tif item.StockBand") {
		t.Fatal("el filtro de prioridades sigue mirando params.IncludeAll directo: " +
			"debe usar mostrarTodo para no esconder el catalogo del proveedor elegido")
	}
	if !strings.Contains(source, "if !mostrarTodo {") {
		t.Fatal("el filtro de prioridades debe consultar mostrarTodo")
	}
}

func TestCandidatosArrancaDesdeProducts(t *testing.T) {
	source := leerRepoFuente(t)

	// Un producto sin metricas SIGUE apareciendo: el batch nocturno puede fallar
	// y eso no debe esconder inventario.
	if !strings.Contains(source, "FROM products p\n\tLEFT JOIN product_restock_metrics m ON m.product_id = p.barcode") {
		t.Fatal("candidatos debe arrancar desde products con LEFT JOIN a las metricas: " +
			"con JOIN interno un producto sin fila de metricas desaparece de la pantalla")
	}
	if strings.Contains(source, "FROM product_restock_metrics m\n\tJOIN products p") {
		t.Fatal("volvio el JOIN interno que escondia los productos sin metricas")
	}
}

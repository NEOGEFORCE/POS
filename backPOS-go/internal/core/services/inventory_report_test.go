package services

import (
	"math"
	"testing"
	"time"
)

func casiIgual(t *testing.T, got, want float64, etiqueta string) {
	t.Helper()
	if math.Abs(got-want) > 0.01 {
		t.Errorf("%s = %.2f; want %.2f", etiqueta, got, want)
	}
}

// inventarioDePrueba: una tienda chica con los casos que sí ocurren en la
// operación real, no un catálogo idealizado.
func inventarioDePrueba() []InventoryQueryRow {
	return []InventoryQueryRow{
		// Producto normal: 10 unidades a $1.000 de costo, $1.500 de venta.
		{Barcode: "001", ProductName: "ARROZ 500G", CategoryName: "GRANOS",
			Stock: 10, MinStock: 5, PurchasePrice: 1000, SalePrice: 1500},
		// Pesable con stock fraccionario.
		{Barcode: "002", ProductName: "QUESO KG", CategoryName: "LACTEOS",
			Stock: 2.5, MinStock: 1, PurchasePrice: 12000, SalePrice: 18000},
		// Agotado: no aporta valor pero sí cuenta como referencia.
		{Barcode: "003", ProductName: "ACEITE 1L", CategoryName: "DESPENSA",
			Stock: 0, MinStock: 3, PurchasePrice: 8000, SalePrice: 11000},
		// Stock NEGATIVO: el POS permite vender en negativo, así que existe y
		// RESTA del valor del inventario.
		{Barcode: "004", ProductName: "GASEOSA 350", CategoryName: "BEBIDAS",
			Stock: -4, MinStock: 6, PurchasePrice: 2000, SalePrice: 3000},
		// Sin precio de compra: valoriza en cero a costo. Es un dato faltante,
		// no un producto gratis.
		{Barcode: "005", ProductName: "BOLSA EMPAQUE", CategoryName: "(sin categoría)",
			Stock: 100, MinStock: 0, PurchasePrice: 0, SalePrice: 200},
	}
}

// TestAggregateInventory_ValorDelInventario es el test de la cifra que se pide:
// cuánta plata hay en la bodega, a costo y a precio de venta.
func TestAggregateInventory_ValorDelInventario(t *testing.T) {
	rep := AggregateInventory(inventarioDePrueba(), time.Now())

	// A costo: 10*1000 + 2.5*12000 + 0*8000 + (-4)*2000 + 100*0
	//        = 10.000 + 30.000 + 0 - 8.000 + 0 = 32.000
	casiIgual(t, rep.TotalCostValue, 32000, "valor a costo")

	// A venta: 10*1500 + 2.5*18000 + 0 + (-4)*3000 + 100*200
	//        = 15.000 + 45.000 + 0 - 12.000 + 20.000 = 68.000
	casiIgual(t, rep.TotalRetailValue, 68000, "valor a precio de venta")

	casiIgual(t, rep.PotentialProfit, 36000, "utilidad potencial")
	casiIgual(t, rep.GlobalMarginPct, 36000.0/68000.0, "margen global")

	if rep.TotalProducts != 5 {
		t.Errorf("TotalProducts = %d; want 5", rep.TotalProducts)
	}
	// Unidades: 10 + 2.5 + 0 - 4 + 100
	casiIgual(t, rep.TotalUnits, 108.5, "unidades totales")
}

// TestAggregateInventory_TotalEsLaSumaDeLasLineas fija la invariante que hace
// creíble un reporte: el total del pie tiene que ser exactamente la suma de las
// líneas impresas arriba. Si divergen, el lector no sabe a cuál creerle.
func TestAggregateInventory_TotalEsLaSumaDeLasLineas(t *testing.T) {
	rep := AggregateInventory(inventarioDePrueba(), time.Now())

	var sumaCosto, sumaVenta, sumaUnidades float64
	for _, row := range rep.Rows {
		// Cada línea vale stock × precio; si esto falla, la columna "Valor
		// Costo" del PDF está mintiendo.
		casiIgual(t, row.CostValue, row.Stock*row.PurchasePrice,
			"valor a costo de "+row.Barcode)
		casiIgual(t, row.RetailValue, row.Stock*row.SalePrice,
			"valor a venta de "+row.Barcode)

		sumaCosto += row.CostValue
		sumaVenta += row.RetailValue
		sumaUnidades += row.Stock
	}

	casiIgual(t, rep.TotalCostValue, sumaCosto, "total a costo vs suma de lineas")
	casiIgual(t, rep.TotalRetailValue, sumaVenta, "total a venta vs suma de lineas")
	casiIgual(t, rep.TotalUnits, sumaUnidades, "total de unidades vs suma de lineas")
}

// TestAggregateInventory_SenalesDeCalidad: los contadores existen para explicar
// por qué un total sorprende. Un valor de inventario bajo puede ser stock
// negativo sin registrar, no plata perdida.
func TestAggregateInventory_SenalesDeCalidad(t *testing.T) {
	rep := AggregateInventory(inventarioDePrueba(), time.Now())

	if rep.NegativeStockCount != 1 {
		t.Errorf("NegativeStockCount = %d; want 1 (la gaseosa en -4)", rep.NegativeStockCount)
	}
	if rep.OutOfStockCount != 1 {
		t.Errorf("OutOfStockCount = %d; want 1 (el aceite en 0)", rep.OutOfStockCount)
	}
	if rep.ZeroCostCount != 1 {
		t.Errorf("ZeroCostCount = %d; want 1 (la bolsa sin precio de compra)", rep.ZeroCostCount)
	}
	// Por debajo o en el mínimo: aceite (0 <= 3) y gaseosa (-4 <= 6).
	// El arroz (10 > 5) y el queso (2.5 > 1) están bien.
	// La bolsa tiene minStock 0, así que no se evalúa.
	if rep.BelowMinStockCount != 2 {
		t.Errorf("BelowMinStockCount = %d; want 2 (aceite y gaseosa)", rep.BelowMinStockCount)
	}
}

// TestAggregateInventory_MargenPorLinea verifica el margen sobre precio de
// venta, que es la convención del resto del sistema, no sobre el costo.
func TestAggregateInventory_MargenPorLinea(t *testing.T) {
	rep := AggregateInventory([]InventoryQueryRow{
		{Barcode: "A", Stock: 1, PurchasePrice: 1000, SalePrice: 1500},
		{Barcode: "B", Stock: 1, PurchasePrice: 1000, SalePrice: 0}, // sin precio de venta
		{Barcode: "C", Stock: 1, PurchasePrice: 0, SalePrice: 500},  // regalo/sin costo
	}, time.Now())

	// (1500-1000)/1500 = 0.3333
	casiIgual(t, rep.Rows[0].MarginPct, 1.0/3.0, "margen de A")
	// Sin precio de venta no hay margen calculable: 0, no una división por cero.
	casiIgual(t, rep.Rows[1].MarginPct, 0, "margen de B")
	// Sin costo el margen es total.
	casiIgual(t, rep.Rows[2].MarginPct, 1, "margen de C")
}

// TestAggregateInventory_InventarioVacio: una bodega vacía no puede reventar el
// reporte ni dividir por cero al calcular el margen global.
func TestAggregateInventory_InventarioVacio(t *testing.T) {
	rep := AggregateInventory(nil, time.Now())

	if rep == nil {
		t.Fatal("AggregateInventory(nil) no puede devolver nil")
	}
	if rep.TotalProducts != 0 || len(rep.Rows) != 0 {
		t.Errorf("un inventario vacío debe dar 0 productos; got %d", rep.TotalProducts)
	}
	casiIgual(t, rep.TotalCostValue, 0, "valor a costo")
	casiIgual(t, rep.GlobalMarginPct, 0, "margen global sin ventas")
}

// TestAggregateInventory_ConservaElOrdenYLosDatos: el reporte tiene que mostrar
// los datos, no sólo los números. Código, nombre y categoría viajan intactos y
// en el orden que impuso la consulta.
func TestAggregateInventory_ConservaElOrdenYLosDatos(t *testing.T) {
	entrada := inventarioDePrueba()
	rep := AggregateInventory(entrada, time.Now())

	if len(rep.Rows) != len(entrada) {
		t.Fatalf("se perdieron filas: %d de %d", len(rep.Rows), len(entrada))
	}
	for i, row := range rep.Rows {
		if row.Barcode != entrada[i].Barcode {
			t.Errorf("fila %d: se alteró el orden (%s vs %s)", i, row.Barcode, entrada[i].Barcode)
		}
		if row.ProductName != entrada[i].ProductName {
			t.Errorf("fila %d: se perdió el nombre del producto", i)
		}
		if row.CategoryName != entrada[i].CategoryName {
			t.Errorf("fila %d: se perdió la categoría", i)
		}
		if row.MinStock != entrada[i].MinStock {
			t.Errorf("fila %d: se perdió el stock mínimo", i)
		}
	}
}

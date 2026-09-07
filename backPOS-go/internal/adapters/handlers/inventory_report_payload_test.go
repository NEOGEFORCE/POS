package handlers

import (
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/services"
)

func reporteInventarioDePrueba() *services.InventoryReport {
	return services.AggregateInventory([]services.InventoryQueryRow{
		{Barcode: "001", ProductName: "ARROZ 500G", CategoryName: "GRANOS",
			Stock: 10, MinStock: 5, PurchasePrice: 1000, SalePrice: 1500},
		{Barcode: "002", ProductName: "QUESO KG", CategoryName: "LACTEOS",
			Stock: 2.5, MinStock: 1, PurchasePrice: 12000, SalePrice: 18000},
		{Barcode: "004", ProductName: "GASEOSA 350", CategoryName: "BEBIDAS",
			Stock: -4, MinStock: 6, PurchasePrice: 2000, SalePrice: 3000},
	}, time.Date(2026, 9, 7, 10, 30, 0, 0, time.UTC))
}

// TestInventoryPayload_ColumnasAlineadas es el guardián del bug más silencioso
// de un reporte tabular: que la fila de totales tenga distinta cantidad de
// celdas que los encabezados. El PDF no falla, simplemente imprime el valor del
// inventario debajo de la columna equivocada.
func TestInventoryPayload_ColumnasAlineadas(t *testing.T) {
	p := inventoryToPayload(reporteInventarioDePrueba())

	n := len(p.Headers)
	if n == 0 {
		t.Fatal("el reporte debe tener encabezados")
	}
	for i, row := range p.Rows {
		if len(row) != n {
			t.Errorf("fila %d tiene %d celdas y hay %d encabezados: %v", i, len(row), n, row)
		}
	}
	if len(p.Totals) != n {
		t.Errorf("la fila de TOTAL tiene %d celdas y hay %d encabezados; las cifras "+
			"saldrían bajo la columna equivocada: %v", len(p.Totals), n, p.Totals)
	}
}

// TestInventoryPayload_MuestraElValorDelInventario: el reporte se pide para
// saber cuánto vale la bodega. Si el total no aparece, no sirvió.
func TestInventoryPayload_MuestraElValorDelInventario(t *testing.T) {
	rep := reporteInventarioDePrueba()
	p := inventoryToPayload(rep)

	if len(p.Totals) == 0 {
		t.Fatal("el reporte de inventario debe cerrar con una fila de totales")
	}

	// A costo: 10*1000 + 2.5*12000 - 4*2000 = 32.000
	esperadoCosto := fmtMoney(32000)
	// A venta: 10*1500 + 2.5*18000 - 4*3000 = 48.000
	esperadoVenta := fmtMoney(48000)

	totales := strings.Join(p.Totals, " | ")
	if !strings.Contains(totales, esperadoCosto) {
		t.Errorf("la fila de totales no trae el valor a costo %s: %s", esperadoCosto, totales)
	}
	if !strings.Contains(totales, esperadoVenta) {
		t.Errorf("la fila de totales no trae el valor a precio de venta %s: %s", esperadoVenta, totales)
	}

	// Y el pie tiene que decirlo en palabras, porque el PDF se manda por
	// Telegram y se lee en un celular sin ver bien la tabla.
	if !strings.Contains(p.Footer, esperadoCosto) {
		t.Errorf("el pie del reporte debe declarar el valor del inventario a costo (%s): %s",
			esperadoCosto, p.Footer)
	}
	if !strings.Contains(strings.ToUpper(p.Footer), "VALOR DEL INVENTARIO") {
		t.Errorf("el pie debe nombrar explícitamente el valor del inventario: %s", p.Footer)
	}
}

// TestInventoryPayload_TraeLosDatosPorProducto: además del total, cada producto
// tiene que traer sus datos y su valorización de línea.
func TestInventoryPayload_TraeLosDatosPorProducto(t *testing.T) {
	p := inventoryToPayload(reporteInventarioDePrueba())

	if len(p.Rows) != 3 {
		t.Fatalf("se esperaban 3 filas, hay %d", len(p.Rows))
	}

	// Las columnas mínimas que el usuario pidió: identificación, existencias y
	// valorización a costo y a venta.
	for _, columna := range []string{"Código", "Producto", "Categoría", "Stock",
		"Costo Unit.", "Valor Costo", "Venta Unit.", "Valor Venta", "Margen"} {
		encontrada := false
		for _, h := range p.Headers {
			if h == columna {
				encontrada = true
				break
			}
		}
		if !encontrada {
			t.Errorf("falta la columna %q; encabezados: %v", columna, p.Headers)
		}
	}

	arroz := strings.Join(p.Rows[0], " | ")
	if !strings.Contains(arroz, "ARROZ 500G") {
		t.Errorf("la fila no trae el nombre del producto: %s", arroz)
	}
	if !strings.Contains(arroz, "GRANOS") {
		t.Errorf("la fila no trae la categoría: %s", arroz)
	}
	// 10 unidades × $1.000 = $10.000 valorizado en la línea.
	if !strings.Contains(arroz, fmtMoney(10000)) {
		t.Errorf("la fila no trae su valorización a costo (%s): %s", fmtMoney(10000), arroz)
	}
}

// TestInventoryPayload_SinMojibake: los encabezados venían con la codificación
// doble rota y el PDF imprimía "CÃ³digo" en lugar de "Código". Se ve en el
// primer renglón del reporte que abre el dueño.
func TestInventoryPayload_SinMojibake(t *testing.T) {
	p := inventoryToPayload(reporteInventarioDePrueba())

	textos := append([]string{p.Title, p.Subtitle, p.Footer}, p.Headers...)
	textos = append(textos, p.Totals...)
	for _, row := range p.Rows {
		textos = append(textos, row...)
	}

	// "Ã" (U+00C3) sólo aparece en texto español cuando el UTF-8 se codificó
	// dos veces. Ninguna palabra en español lo usa.
	for _, s := range textos {
		if strings.ContainsRune(s, 'Ã') {
			t.Errorf("texto con codificación doble (mojibake): %q", s)
		}
		if strings.Contains(s, "â€") {
			t.Errorf("texto con puntuación mal codificada: %q", s)
		}
	}

	// Y verificamos que los acentos correctos sí estén: si alguien "arregla" el
	// mojibake quitando las tildes, este test lo detecta.
	unidos := strings.Join(p.Headers, " ")
	if !strings.Contains(unidos, "Código") || !strings.Contains(unidos, "Categoría") {
		t.Errorf("los encabezados perdieron sus acentos: %v", p.Headers)
	}
}

// TestInventoryPayload_AvisaStockNegativo: el stock negativo resta del valor del
// inventario. Sin el aviso, el dueño ve un total bajo y no sabe por qué.
func TestInventoryPayload_AvisaStockNegativo(t *testing.T) {
	p := inventoryToPayload(reporteInventarioDePrueba())

	if !strings.Contains(strings.ToUpper(p.Footer), "NEGATIVO") {
		t.Errorf("el pie debe advertir del stock negativo que resta del total: %s", p.Footer)
	}
}

// TestInventoryPayload_NoRevientaConReporteVacio cubre los dos bordes: un
// inventario sin productos y un reporte nulo por un fallo aguas arriba.
func TestInventoryPayload_NoRevientaConReporteVacio(t *testing.T) {
	t.Run("nil", func(t *testing.T) {
		p := inventoryToPayload(nil)
		if len(p.Headers) == 0 {
			t.Error("incluso sin datos el reporte debe traer sus encabezados")
		}
		if len(p.Rows) != 0 {
			t.Error("un reporte nulo no puede inventar filas")
		}
	})

	t.Run("vacío", func(t *testing.T) {
		vacio := services.AggregateInventory(nil, time.Now())
		p := inventoryToPayload(vacio)
		if len(p.Headers) == 0 {
			t.Error("faltan los encabezados")
		}
		if len(p.Totals) != len(p.Headers) {
			t.Errorf("la fila de totales debe seguir alineada con %d columnas: %v",
				len(p.Headers), p.Totals)
		}
		if !strings.Contains(p.Totals[1], "0 productos") {
			t.Errorf("un inventario vacío debe declarar 0 productos: %v", p.Totals)
		}
	})
}

// TestFmtQty documenta la convención de cantidades: entero cuando es entero,
// coma decimal cuando el producto es pesable.
func TestFmtQty(t *testing.T) {
	casos := []struct {
		in   float64
		want string
	}{
		{10, "10"},
		{0, "0"},
		{-4, "-4"},
		{2.5, "2,50"},
		{108.5, "108,50"},
		{1000, "1000"},
	}
	for _, c := range casos {
		if got := fmtQty(c.in); got != c.want {
			t.Errorf("fmtQty(%v) = %q; want %q", c.in, got, c.want)
		}
	}
}

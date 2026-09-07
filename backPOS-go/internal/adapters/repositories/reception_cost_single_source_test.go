package repositories

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Existen TRES rutas que registran mercancía y escriben products.purchasePrice:
//
//	POST  /products/bulk-receive      -> BulkReceive        (la pantalla real)
//	PATCH /inventory/receive/:ref     -> EditReception      (editar una recepción)
//	POST  /products/receive-stock     -> ReceiveStock       (legada, sin UI)
//
// Las tres calculaban el costo con impuestos por su cuenta y NO coincidían:
// BulkReceive guardaba la base pelada (sin impuestos) mientras las otras dos
// guardaban el costo con impuestos. Consecuencia concreta: recibías con IVA 19%,
// la pantalla te mostraba COSTO $1.190 y en la base quedaba $1.000; después
// editabas esa misma recepción sin cambiar nada y el costo "subía" a $1.190.
//
// Estos tests fijan que las tres deriven el costo de models.GrossFromNet.

func leerArchivo(t *testing.T, ruta string) string {
	t.Helper()
	b, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatalf("no se pudo leer %s: %v", ruta, err)
	}
	return string(b)
}

func cuerpoDeFuncion(t *testing.T, src, firma string) string {
	t.Helper()
	i := strings.Index(src, firma)
	if i < 0 {
		t.Fatalf("no se encontró %q", firma)
	}
	resto := src[i:]
	if fin := strings.Index(resto[len(firma):], "\nfunc "); fin > 0 {
		resto = resto[:len(firma)+fin]
	}
	return resto
}

func TestBulkReceiveUsaLaFuenteUnicaDeImpuestos(t *testing.T) {
	src := leerArchivo(t, "postgres_product_inventory.go")
	cuerpo := cuerpoDeFuncion(t, src, "func (r *PostgresProductRepository) BulkReceive(")

	if !strings.Contains(cuerpo, "models.GrossFromNet") {
		t.Error("BulkReceive debe calcular el costo con models.GrossFromNet, no a mano")
	}
	// La suma manual de montos es la forma vieja: prohibido reintroducirla.
	sumaManual := regexp.MustCompile(`entry\.NewPurchasePrice\s*\+\s*entry\.Iva\s*\+\s*entry\.Icui\s*\+\s*entry\.Ibua`)
	if sumaManual.MatchString(cuerpo) {
		t.Error("BulkReceive volvió a sumar los montos a mano en vez de usar la fuente única")
	}
	// El WAC tiene que ponderar el costo CON impuestos.
	if !strings.Contains(cuerpo, "entry.AddedQuantity * totalEntryCost") {
		t.Error("el WAC debe ponderar totalEntryCost (con impuestos); " +
			"con entry.NewPurchasePrice pelado el costo queda por debajo de lo pagado")
	}
	// Y los porcentajes se guardan como porcentajes.
	for _, asignacion := range []string{
		"product.Iva = entry.IvaPct",
		"product.Icui = entry.IcuiPct",
		"product.Ibua = entry.IbuaPct",
	} {
		if !strings.Contains(cuerpo, asignacion) {
			t.Errorf("falta %q: products.iva guarda la TASA, no el monto", asignacion)
		}
	}
}

func TestEditReceptionUsaLaFuenteUnicaDeImpuestos(t *testing.T) {
	src := leerArchivo(t, "postgres_product_repository.go")
	cuerpo := cuerpoDeFuncion(t, src, "func (r *PostgresProductRepository) EditReception(")

	if !strings.Contains(cuerpo, "models.GrossFromNet") {
		t.Error("EditReception debe usar models.GrossFromNet")
	}
	formulaVieja := regexp.MustCompile(`\(\s*1\s*\+\s*item\.IVA/100\s*\+`)
	if formulaVieja.MatchString(cuerpo) {
		t.Error("EditReception volvió a escribir la fórmula a mano")
	}
}

func TestReceiveStockNoConfundeMontoConPorcentaje(t *testing.T) {
	ruta := filepath.Join("..", "..", "core", "services", "product_service.go")
	src := leerArchivo(t, ruta)
	cuerpo := cuerpoDeFuncion(t, src, "func (s *ProductService) ReceiveStock(")

	if !strings.Contains(cuerpo, "models.RatesFromAmounts") {
		t.Error("ReceiveStock debe derivar las tasas de los montos con models.RatesFromAmounts")
	}
	if !strings.Contains(cuerpo, "models.GrossFromNet") {
		t.Error("ReceiveStock debe calcular el costo con models.GrossFromNet")
	}
	// El bug original: el mismo valor sumado al costo y guardado como tasa.
	bugOriginal := regexp.MustCompile(`product\.Iva,\s*product\.Icui,\s*product\.Ibua\s*=\s*iva,\s*icui,\s*ibua`)
	if bugOriginal.MatchString(cuerpo) {
		t.Error("ReceiveStock volvió a guardar los MONTOS en las columnas de PORCENTAJE: " +
			"con $190 de IVA el producto queda con tasa 190% y la factura electrónica la declara así")
	}
	if !strings.Contains(cuerpo, "rates.IvaPct") {
		t.Error("products.iva debe recibir la tasa derivada (rates.IvaPct)")
	}
}

func TestLectorDeFacturasUsaLaMismaFormulaQueLaRecepcion(t *testing.T) {
	ruta := filepath.Join("..", "..", "core", "services", "product_service.go")
	src := leerArchivo(t, ruta)
	cuerpo := cuerpoDeFuncion(t, src, "func (s *ProductService) calculateItemDetails(")

	if !strings.Contains(cuerpo, "models.GrossFromNet") {
		t.Error("calculateItemDetails debe usar models.GrossFromNet para el costo real")
	}
	if !strings.Contains(cuerpo, "models.NetFromGross") {
		t.Error("calculateItemDetails debe usar models.NetFromGross para quitar impuestos incluidos")
	}
	// La cadena multiplicativa era la que divergía de la recepción.
	multiplicativa := regexp.MustCompile(`costoReal\s*\*=\s*\(1\s*\+`)
	if multiplicativa.MatchString(cuerpo) {
		t.Error("volvió la fórmula multiplicativa: con dos impuestos deja de cuadrar con la recepción")
	}
}

// El porcentaje del descuento sigue sin persistirse (necesita la migración 015).
// Este test documenta la deuda para que no se olvide ni se dé por hecha.
func TestPendiente_ElDescuentoAunNoSePersiste(t *testing.T) {
	src := leerArchivo(t, "postgres_product_inventory.go")

	// Verificación real: si algún día alguien empieza a leer DiscountPct, este
	// test falla y hay que quitar el Skip porque la deuda ya se pagó.
	if strings.Contains(src, "entry.DiscountPct") {
		t.Fatal("entry.DiscountPct ya se usa: la deuda se pagó, actualizá este test y quitá el Skip")
	}

	t.Skip("DEUDA CONOCIDA: entry.DiscountPct no se guarda en ninguna parte. " +
		"Requiere la migración 015 (stock_movements.discount_pct), escrita y sin aplicar. " +
		"Hasta entonces el DTO del proveedor no es auditable después de la recepción.")
}

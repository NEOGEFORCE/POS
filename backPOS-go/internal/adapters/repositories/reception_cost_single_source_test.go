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

// El porcentaje del descuento SI se persiste desde la migracion 015. Antes se
// escribia en la pantalla, se usaba para calcular el PVP y se perdia al
// guardar: no habia forma de auditar que descuento dio cada proveedor.
func TestElDescuentoSePersisteEnElKardex(t *testing.T) {
	src := leerArchivo(t, "postgres_product_inventory.go")
	cuerpo := cuerpoDeFuncion(t, src, "func (r *PostgresProductRepository) BulkReceive(")

	// Los cuatro porcentajes de la linea tienen que viajar al movimiento.
	for _, campo := range []string{"DiscountPct:", "IvaPct:", "IcuiPct:", "IbuaPct:"} {
		if !strings.Contains(cuerpo, campo) {
			t.Errorf("el movimiento de kardex debe guardar %s de la linea de compra", campo)
		}
	}

	// Y deben salir de la linea, no de la variable del bucle por referencia:
	// tomar &entry.X hace que todos los movimientos apunten al mismo valor si
	// cambia la semantica de captura del range.
	for _, copia := range []string{"lineDiscountPct", "lineIvaPct", "lineIcuiPct", "lineIbuaPct"} {
		if !strings.Contains(cuerpo, copia) {
			t.Errorf("falta la copia local %s: no tomar la direccion de la variable del bucle", copia)
		}
	}
	if strings.Contains(cuerpo, "&entry.DiscountPct") {
		t.Error("no tomes la direccion de entry.DiscountPct; usa una copia local por linea")
	}
}

// Los porcentajes son punteros para poder distinguir "no aplica" de "0% real".
// Un movimiento de venta o de merma no tiene porcentajes de compra.
func TestLosPorcentajesDelKardexSonOpcionales(t *testing.T) {
	ruta := filepath.Join("..", "..", "core", "domain", "models", "stock_movement.go")
	src := leerArchivo(t, ruta)

	for _, campo := range []string{
		`DiscountPct *float64 `,
		`IvaPct      *float64 `,
		`IcuiPct     *float64 `,
		`IbuaPct     *float64 `,
	} {
		if !strings.Contains(src, campo) {
			t.Errorf("StockMovement debe declarar %q como puntero: un 0%% real no es lo mismo que 'no aplica'", strings.TrimSpace(campo))
		}
	}
	// El tipo debe coincidir con el de la migracion 015 para que AutoMigrate no
	// recree las columnas con otra precision.
	for _, col := range []string{"discount_pct", "iva_pct", "icui_pct", "ibua_pct"} {
		if !strings.Contains(src, "column:"+col+";type:numeric(6,3)") {
			t.Errorf("la columna %s debe declararse type:numeric(6,3), igual que en la migracion 015", col)
		}
	}
}

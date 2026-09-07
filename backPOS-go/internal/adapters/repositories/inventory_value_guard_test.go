package repositories

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"backPOS-go/internal/core/ports"
)

// El bug: products."isActive" admite NULL en las filas legadas, y en SQL
// `NULL = true` es NULL (no false). Un filtro `"isActive" = true` descarta esas
// filas EN SILENCIO.
//
// La pantalla de productos usaba COALESCE y el reporte de inventario el filtro
// pelado, así que el reporte mostraba MENOS productos que la pantalla y su
// valorización quedaba por debajo de la realidad. Nadie se dio cuenta porque
// ninguna de las dos consultas falla: simplemente no coinciden.
//
// Estos tests fijan que exista UNA sola definición y que las consultas que
// responden "cuánto vale mi inventario" la usen.

func leerFuente(t *testing.T, ruta string) string {
	t.Helper()
	body, err := os.ReadFile(ruta)
	if err != nil {
		t.Fatalf("no se pudo leer %s: %v", ruta, err)
	}
	return string(body)
}

// extraerFuncion devuelve el cuerpo de una función desde su firma hasta el
// siguiente "\nfunc " del archivo.
func extraerFuncion(t *testing.T, src, firma string) string {
	t.Helper()
	idx := strings.Index(src, firma)
	if idx < 0 {
		t.Fatalf("no se encontró %q en la fuente", firma)
	}
	resto := src[idx:]
	if fin := strings.Index(resto[len(firma):], "\nfunc "); fin > 0 {
		resto = resto[:len(firma)+fin]
	}
	return resto
}

func TestDefinicionDeProductoActivoEsUnaSola(t *testing.T) {
	// La constante canónica tiene que llevar el COALESCE: sin él no arregla nada.
	if !strings.Contains(ports.SQLActiveProduct, "COALESCE") {
		t.Fatalf("ports.SQLActiveProduct debe usar COALESCE para no perder las filas "+
			"con isActive NULL; hoy es %q", ports.SQLActiveProduct)
	}
	if !strings.Contains(ports.SQLActiveProduct, `"isActive"`) {
		t.Errorf("ports.SQLActiveProduct debe citar la columna camelCase entre comillas dobles; hoy es %q",
			ports.SQLActiveProduct)
	}

	// La versión con alias tiene que calificar la columna, o Postgres se queja
	// de ambigüedad en cuanto la consulta haga JOIN con otra tabla que la tenga.
	conAlias := ports.SQLActiveProductAliased("p")
	if !strings.Contains(conAlias, `p."isActive"`) {
		t.Errorf("SQLActiveProductAliased(\"p\") debe calificar la columna; hoy es %q", conAlias)
	}
	if !strings.Contains(conAlias, "COALESCE") {
		t.Errorf("SQLActiveProductAliased debe conservar el COALESCE; hoy es %q", conAlias)
	}
}

// Las dos consultas que responden "cuánto vale mi inventario" alimentan el KPI
// del dashboard y el total del reporte. Si usan predicados distintos, el reporte
// y el dashboard muestran cifras diferentes de la misma plata, que es el patrón
// de bug más repetido de este proyecto.
func TestValorDelInventarioUsaLaDefinicionCanonica(t *testing.T) {
	src := leerFuente(t, "postgres_product_inventory.go")

	firmas := []string{
		"func (r *PostgresProductRepository) GetGlobalInventoryValue(",
		"func (r *PostgresProductRepository) GetGlobalInventoryRetailValue(",
	}
	for _, firma := range firmas {
		cuerpo := extraerFuncion(t, src, firma)

		if !strings.Contains(cuerpo, "ports.SQLActiveProduct") {
			t.Errorf("%s debe filtrar con ports.SQLActiveProduct, no con un predicado propio.\n%s",
				firma, cuerpo)
		}
		// El filtro pelado es exactamente el bug: prohibido reintroducirlo.
		if regexp.MustCompile(`Where\("\\"isActive\\" = \?"`).MatchString(cuerpo) {
			t.Errorf(`%s volvió al filtro pelado "isActive" = ?, que descarta las filas con NULL`, firma)
		}
	}
}

// El reporte de inventario tiene que valorizar sobre el mismo universo de
// productos que el KPI. Su consulta vive en el servicio de exportación.
func TestReporteDeInventarioUsaLaDefinicionCanonica(t *testing.T) {
	ruta := filepath.Join("..", "..", "core", "services", "export_service.go")
	src := leerFuente(t, ruta)

	cuerpo := extraerFuncion(t, src, "func (s *ExportService) GetInventoryReport(")

	if !strings.Contains(cuerpo, "ports.SQLActiveProductAliased") {
		t.Errorf("GetInventoryReport debe filtrar con ports.SQLActiveProductAliased.\n%s", cuerpo)
	}
	if strings.Contains(cuerpo, `p."isActive" = true`) {
		t.Error(`GetInventoryReport volvió al filtro pelado p."isActive" = true`)
	}
	// El LEFT JOIN a categorías no es cosmético: con INNER JOIN, un producto sin
	// categoría desaparece del inventario y de su valorización.
	if !strings.Contains(cuerpo, "LEFT JOIN categories") {
		t.Error("GetInventoryReport debe usar LEFT JOIN a categories: " +
			"un producto sin categoría no puede desaparecer del inventario")
	}
	// Un reporte de inventario acotado por LIMIT daría un total parcial que
	// parece correcto, que es peor que un error.
	if regexp.MustCompile(`Limit\(\s*\d+\s*\)`).MatchString(cuerpo) {
		t.Error("GetInventoryReport no puede llevar Limit: un valor de inventario " +
			"parcial parece correcto y no lo es")
	}
}

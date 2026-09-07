package repositories

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// ============================================================================
// GUARDIAN: NINGUNA CTE PUEDE LLAMARSE IGUAL QUE UNA TABLA REAL
// ============================================================================
//
// Falla real en produccion, reportada por Telegram el 2026-09-04 21:00 y de
// nuevo esa misma noche:
//
//	FALLO EN CALCULO NOCTURNO DE RESTOCK:
//	ERROR: no existe la columna s.saleId (SQLSTATE 42703)
//
// CAUSA: en LoadCalculationInputs la primera CTE se llamaba `sales`, igual que
// la tabla. En Postgres una CTE SOMBREA la tabla del mismo nombre para todo lo
// que venga despues en la misma consulta. Asi, la CTE `consumo_posterior`
// escribia `JOIN sales s ON s."saleId" = sd."saleId"` creyendo que usaba la
// tabla real, pero resolvia a la CTE, que solo expone product_id,
// total_sold_30d y total_sold_90d. Sin columna saleId, la consulta abortaba y
// con ella TODO el batch nocturno de restock.
//
// El sintoma aparece LEJOS del nombre culpable, por eso costo encontrarlo. Este
// test lo bloquea en la raiz.

// tablasReales son los nombres que una CTE no puede usar. No pretende ser el
// esquema completo: son las tablas que estas consultas tocan de verdad.
var tablasReales = map[string]bool{
	"sales": true, "sale_details": true, "products": true, "expenses": true,
	"suppliers": true, "product_suppliers": true, "stock_movements": true,
	"confirmed_orders": true, "confirmed_order_items": true,
	"purchase_orders": true, "purchase_order_items": true,
	"daily_stock_snapshots": true, "cashier_closures": true,
	"clients": true, "credit_payments": true, "returns": true,
	"product_restock_metrics": true, "expected_orders": true,
}

// cteNameRegex captura los nombres declarados en un WITH: tanto el primero
// (WITH x AS) como los siguientes (), y AS).
var cteNameRegex = regexp.MustCompile(`(?i)(?:WITH|,)\s*([a-z_][a-z0-9_]*)\s+AS\s*\(`)

func TestNingunaCTEUsaElNombreDeUnaTablaReal(t *testing.T) {
	archivos := []string{
		"restock_metrics_repository.go",
		"postgres_sale_repository.go",
		"postgres_product_repository.go",
		"postgres_expense_repository.go",
		"restock_repository.go",
	}

	for _, archivo := range archivos {
		b, err := os.ReadFile(archivo)
		if err != nil {
			// Si el archivo no existe en esta version, no es motivo de fallo.
			continue
		}
		contenido := string(b)

		for _, m := range cteNameRegex.FindAllStringSubmatch(contenido, -1) {
			nombre := strings.ToLower(m[1])
			// "select" aparece cuando el regex engancha una subconsulta, no una CTE.
			if nombre == "select" {
				continue
			}
			if tablasReales[nombre] {
				t.Errorf("%s: la CTE %q se llama igual que una tabla real. "+
					"En Postgres la CTE la sombrea y cualquier JOIN posterior a esa tabla "+
					"resuelve a la CTE, produciendo errores de columna inexistente lejos del "+
					"nombre culpable (paso con la CTE 'sales' y el error s.saleId que tumbo "+
					"el batch nocturno). Renombrala, por ejemplo a %q.",
					archivo, nombre, "ventas_por_producto")
			}
		}
	}
}

// El JOIN que se rompio debe seguir apuntando a la TABLA real, no a una CTE.
func TestConsumoPosteriorUsaLaTablaSalesReal(t *testing.T) {
	b, err := os.ReadFile("restock_metrics_repository.go")
	if err != nil {
		t.Fatalf("no se pudo leer el repositorio: %v", err)
	}
	contenido := string(b)

	if !strings.Contains(contenido, `JOIN sales s ON s."saleId" = sd."saleId"`) {
		t.Error("se esperaba el JOIN a la tabla sales real dentro de consumo_posterior")
	}
	// Y la CTE de ventas debe tener su nombre propio.
	if !strings.Contains(contenido, "WITH ventas_por_producto AS (") {
		t.Error("la CTE de ventas debe llamarse ventas_por_producto, no sales")
	}
	if strings.Contains(contenido, "LEFT JOIN sales v ON v.product_id") {
		t.Error("el LEFT JOIN debe apuntar a ventas_por_producto, no a la tabla sales")
	}
}

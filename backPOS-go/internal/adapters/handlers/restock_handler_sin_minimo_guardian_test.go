package handlers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// GUARDIAN (2026-10-08): el endpoint GET /inventory/restock/critical debe
// clasificar como "crítico" EXCLUSIVAMENTE lo que diga models.ClassifyStockBand
// (via inventory_service.go, que ya mapea StockBandUnset -> StockOptimal).
//
// Antes, el handler tenía un fallback historico:
//
//	if item.Status == services.StockCritical || item.Stock <= item.MinStock {
//
// Con minStock=0 y stock=0, la condicion `item.Stock <= item.MinStock`
// (0 <= 0) marcaba como critico un producto que el dueno dejo deliberadamente
// sin minimo (descontinuado, consignacion). Ademas, con minStock>0, la misma
// condicion capturaba productos exactamente al minimo (stock=minStock=10,
// ratio=1.0), que la banda clasifica como VERDE: era un sobre-reporte.
//
// Este guardian es estatico: lee el archivo y falla si alguien vuelve a
// introducir el fallback. La verdad del semaforo vive una sola vez en
// models.ClassifyStockBand, y las pruebas de ese helper
// (TestClassifyStockBand y TestClassifyStockBand_MinStockCero_SiempreUnset)
// ya cubren el contrato minStock<=0 -> UNSET.
func TestGetCriticalDoesNotFallBackToStockLeMinStock(t *testing.T) {
	t.Parallel()
	path := filepath.Join("restock_handler.go")
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no se pudo leer %s: %v", path, err)
	}
	content := string(source)
	// Aislar GetCritical para no analizar el archivo completo.
	start := strings.Index(content, "func (h *RestockHandler) GetCritical")
	if start == -1 {
		t.Fatal("no se encontro GetCritical en restock_handler.go")
	}
	// Buscar el cierre del handler (siguiente func top-level).
	rest := content[start:]
	end := strings.Index(rest[1:], "\nfunc ")
	var block string
	if end == -1 {
		block = rest
	} else {
		block = rest[:end+1]
	}
	forbidden := []string{
		"item.Stock <= item.MinStock",
		"item.Stock<=item.MinStock",
	}
	for _, pattern := range forbidden {
		if strings.Contains(block, pattern) {
			t.Fatalf("GetCritical volvio al fallback historico %q. "+
				"La fuente unica de 'critico' es models.ClassifyStockBand via "+
				"item.Status == services.StockCritical. Un producto con minStock=0 "+
				"y stock=0 NUNCA debe clasificarse como critico (regla 2026-10).",
				pattern)
		}
	}
	// Debe seguir existiendo el filtro por Status.
	if !strings.Contains(block, "services.StockCritical") {
		t.Fatal("GetCritical ya no filtra por services.StockCritical; " +
			"la clasificacion canonica desaparecio")
	}
}

// GUARDIAN (2026-10-08): el filtro ?stockFilter=warning de GET /products NO
// debe reintroducir el fallback historico "sin minimo con stock bajo (<=5)".
// Un producto con minStock<=0 queda en banda UNSET y mapea a Optimal en los
// conteos agregados; esta consulta tiene que coincidir con
// GetProductStatsAggregate para no reportar numeros contradictorios.
//
// Antes:
//
//	OR (COALESCE(products."minStock", 0) <= 0 AND products.quantity > 0 AND products.quantity <= 5)
//
// Ahora: solo cuenta amarillo lo que tenga minimo CONFIGURADO con ratio
// entre 25% y 75%.
func TestWarningFilterDoesNotFallBackToSinMinimo(t *testing.T) {
	t.Parallel()
	path := filepath.Join("..", "..", "adapters", "repositories", "postgres_product_repository.go")
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no se pudo leer %s: %v", path, err)
	}
	content := string(source)
	// Aislar el bloque del filtro warning.
	marker := `else if stockFilter == "warning"`
	start := strings.Index(content, marker)
	if start == -1 {
		t.Fatalf("no se encontro el bloque %q en postgres_product_repository.go", marker)
	}
	// Siguiente cierre de bloque del `if`-chain.
	rest := content[start:]
	end := strings.Index(rest, "\n\tif err := query.Count")
	if end == -1 {
		// Fallback: tomar un chunk suficiente.
		if len(rest) > 1200 {
			end = 1200
		} else {
			end = len(rest)
		}
	}
	block := rest[:end]
	forbidden := []string{
		`"minStock", 0) <= 0`,
		`"minStock",0) <= 0`,
		`"minStock", 0)<=0`,
		`"minStock",0)<=0`,
	}
	for _, pattern := range forbidden {
		if strings.Contains(block, pattern) {
			t.Fatalf("El filtro ?stockFilter=warning volvio a aceptar minStock<=0 (patron %q). "+
				"Regla 2026-10: sin minimo configurado -> SIN_MINIMO en TODOS los caminos. "+
				"Debe quedar alineado con GetProductStatsAggregate.",
				pattern)
		}
	}
}

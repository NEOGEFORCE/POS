package repositories

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestNoAutoWriteToMinStock es el guardian estatico que amarra la regla del
// dueno (agosto 2026): NADA en el backend puede escribir automaticamente a
// products."minStock". El minimo es dato exclusivo del dueno, igual que la
// agenda manual de proveedores (visit_days / delivery_days).
//
// El sistema PUEDE sugerir un nuevo minimo mas realista (campo
// suggestedMinStock en el JSON de /restock/suggestions-v2 y en las alertas
// Telegram/UI); el dueno decide si aplicarlo. NUNCA se aplica solo.
//
// Estrategia: escanear todos los .go de produccion (excluyendo *_test.go)
// bajo internal/ en busca de patrones peligrosos:
//
//	.Update("minStock" ...             UPDATE de GORM apuntando a la columna
//	.Updates(map con "minStock" ...)   update masivo por map[string]interface{}
//	UPDATE products ... SET ... "minStock"  SQL crudo mutando la columna
//
// Allowlist explicita: archivos donde la mutacion es el CRUD MANUAL iniciado
// por el dueno via endpoints de producto. Estos son los caminos legitimos
// identificados en el informe de la etapa anterior:
//
//   - internal/adapters/repositories/postgres_product_update.go
//     UpdateWithTx del producto, disparado por PUT /products/update-products/:barcode
//     (formulario completo del producto) y por PATCH /products/update-min-stock/:barcode
//     (editor cabecera del sugerido). Es un .Updates(map) que lista
//     "minStock" junto a las demas columnas del formulario.
//   - internal/adapters/handlers/product_handler.go
//     El handler UpdateMinStock setea product.MinStock desde el body
//     antes de llamar al servicio. No es una escritura directa a BD
//     (Update/Updates), pero se allowlistea por si en el futuro se
//     reescribe como escritura directa. Actualmente no matchea el
//     patron.
//   - internal/core/services/product_service.go
//     UpdateProduct hace existing.MinStock = updatedProduct.MinStock
//     antes de delegar al repo. Tampoco matchea el patron actual, pero
//     se allowlistea por la misma razon defensiva.
//
// Si alguien agrega un flujo automatico que quiera actualizar minStock, este
// test falla y protege la regla.
func TestNoAutoWriteToMinStock(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("no se pudo resolver la ruta base de internal/: %v", err)
	}

	// Patrones prohibidos.
	updateColumnCall := regexp.MustCompile(`\.Update\(\s*"(?:minStock|min_stock)"\s*,`)
	updatesMultiCall := regexp.MustCompile(`(?s)\.Updates\(\s*map\[string\]interface\{\}\{[^}]*"(?:minStock|min_stock)"`)
	rawUpdateSQL := regexp.MustCompile(`(?is)UPDATE\s+products[^;]*SET[^;]*"minStock"`)

	// Allowlist: rutas relativas (POSIX) del CRUD manual autorizado.
	allowed := map[string]bool{
		"adapters/repositories/postgres_product_update.go": true,
		"adapters/handlers/product_handler.go":             true,
		"core/services/product_service.go":                 true,
	}

	var violations []string

	walkErr := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		name := info.Name()
		if !strings.HasSuffix(name, ".go") {
			return nil
		}
		if strings.HasSuffix(name, "_test.go") {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			rel = path
		}
		rel = filepath.ToSlash(rel)
		if allowed[rel] {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		body := string(data)

		full := "internal/" + rel
		if updateColumnCall.MatchString(body) {
			violations = append(violations, full+`: .Update("minStock", ...) detectado`)
		}
		if updatesMultiCall.MatchString(body) {
			violations = append(violations, full+`: .Updates(map con "minStock") detectado`)
		}
		if rawUpdateSQL.MatchString(body) {
			violations = append(violations, full+`: UPDATE products ... SET "minStock" detectado en SQL crudo`)
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("error al escanear internal/: %v", walkErr)
	}
	if len(violations) > 0 {
		t.Fatalf("Se detectaron escrituras automaticas prohibidas a products.\"minStock\".\n"+
			"El minimo configurado es dato del dueno (agosto 2026), igual que suppliers.visit_days.\n"+
			"El sistema SUGIERE (campo suggestedMinStock), NUNCA aplica.\n"+
			"Violaciones:\n  - %s", strings.Join(violations, "\n  - "))
	}
}

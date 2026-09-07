package repositories

import (
	"errors"
	"os"
	"regexp"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// TestHistoricalMarkerErrorSemantics documenta el contrato semántico de
// HistoricalMarkerReservedError tal como debe emitirlo
// postgres_product_update.go cuando el UPDATE detecta que el código destino
// está tomado por un marcador '[HISTORICO]'. Sirve como spec ejecutable.
//
// Reglas:
//   - RealBarcode   = barcode ACTUAL del producto real (el `barcode` de la
//     URL, i.e. lo que el operador está editando).
//   - MarkerBarcode = código destino que el operador ingresó y que hoy
//     ocupa el marcador '[HISTORICO]'.
//   - Los dos códigos SON DIFERENTES: si fueran iguales no habría colisión
//     (targetBarcode == barcode salta el chequeo en UpdateWithTx). Enviar
//     ambos iguales rompe la fusión: el repositorio Merge la rechaza con
//     "no pueden ser iguales" y el helper del frontend buildMergeRequest
//     devuelve null.
func TestHistoricalMarkerErrorSemantics(t *testing.T) {
	const (
		urlBarcode    = "X-REAL-000001" // el `barcode` de la URL
		targetBarcode = "B-MARK-999999" // product.Barcode del payload
		markerName    = "[HISTORICO] SODA VIEJA 500ML"
	)

	err := &models.HistoricalMarkerReservedError{
		RealBarcode:   urlBarcode,
		MarkerBarcode: targetBarcode,
		MarkerName:    markerName,
	}

	var typed *models.HistoricalMarkerReservedError
	if !errors.As(err, &typed) {
		t.Fatal("errors.As no reconoció el error tipado en su forma más directa")
	}

	if typed.RealBarcode != urlBarcode {
		t.Fatalf("RealBarcode = %q; want %q (el código actual del producto real, no el destino)", typed.RealBarcode, urlBarcode)
	}
	if typed.MarkerBarcode != targetBarcode {
		t.Fatalf("MarkerBarcode = %q; want %q (el código destino que retiene el marcador)", typed.MarkerBarcode, targetBarcode)
	}
	if typed.MarkerName != markerName {
		t.Fatalf("MarkerName = %q; want %q", typed.MarkerName, markerName)
	}
	if typed.RealBarcode == typed.MarkerBarcode {
		t.Fatalf(
			"RealBarcode y MarkerBarcode NO pueden coincidir; got %q. "+
				"Es el bug clásico: si la rama isHistoricalMarker asigna "+
				"targetBarcode a los dos campos, la fusión se bloquea porque "+
				"MergeHistoricalMarker rechaza real==marker.",
			typed.RealBarcode,
		)
	}
}

// TestUpdateWithTxAssignsHistoricalMarkerFieldsCorrectly es un guardián
// estático de la fuente: lee postgres_product_update.go y verifica que la
// rama que construye &models.HistoricalMarkerReservedError{...} asigne
//
//	RealBarcode:   barcode
//	MarkerBarcode: targetBarcode
//
// La regresión que quiere prevenir es asignar `targetBarcode` a los dos
// campos, que fue el bug original que se resolvió en este cambio. Un test
// dinámico requeriría una base de datos real; este guardián estático corre
// en CI sin dependencias.
func TestUpdateWithTxAssignsHistoricalMarkerFieldsCorrectly(t *testing.T) {
	source, err := os.ReadFile("postgres_product_update.go")
	if err != nil {
		t.Fatalf("no se pudo leer postgres_product_update.go: %v", err)
	}

	// Buscamos el literal que construye el error del dominio, tolerando
	// espacios en blanco y comentarios menores. La regexp exige el orden
	// exacto: RealBarcode <- barcode  y  MarkerBarcode <- targetBarcode.
	pattern := regexp.MustCompile(
		`(?s)&models\.HistoricalMarkerReservedError\{\s*` +
			`RealBarcode:\s*barcode\s*,\s*` +
			`MarkerBarcode:\s*targetBarcode\s*,`,
	)
	if !pattern.Match(source) {
		t.Fatal(
			"postgres_product_update.go NO asigna " +
				"RealBarcode=barcode y MarkerBarcode=targetBarcode. " +
				"El bug clásico es poner targetBarcode en ambos campos: " +
				"eso hace que /admin/products/merge-historical rechace la " +
				"fusión con 'no pueden ser iguales'. RealBarcode debe ser " +
				"el código ACTUAL del producto (el `barcode` de la URL) y " +
				"MarkerBarcode el destino que retiene el marcador.",
		)
	}

	// Y adicionalmente, verificamos que NO exista el patrón erróneo con
	// targetBarcode duplicado.
	badPattern := regexp.MustCompile(
		`(?s)&models\.HistoricalMarkerReservedError\{\s*` +
			`RealBarcode:\s*targetBarcode\s*,\s*` +
			`MarkerBarcode:\s*targetBarcode\s*,`,
	)
	if badPattern.Match(source) {
		t.Fatal(
			"REGRESIÓN: postgres_product_update.go volvió a asignar " +
				"targetBarcode tanto a RealBarcode como a MarkerBarcode. " +
				"Eso bloquea la fusión.",
		)
	}
}

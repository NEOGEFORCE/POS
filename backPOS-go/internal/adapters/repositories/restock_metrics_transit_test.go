package repositories

import (
	"strings"
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// Ensamblamiento end-to-end (sin BD): verificar que un transit_detail en
// JSON agregado por el SQL se propaga como InTransitBreakdown en el
// response de /restock/suggestions-v2.

func TestBuildRestockSuggestion_InTransitBreakdownSePropaga(t *testing.T) {
	row := restockSuggestionRow{}
	row.ProductRestockMetric = models.ProductRestockMetric{
		ProductID: "770123", ProductName: "COCA 1L",
	}
	row.LiveStock = 2
	row.LiveInTransitQty = 10
	row.MinStock = 6
	row.EffectiveSupplierID = uintPtr(7)
	row.EffectiveSupplierName = strPtr("HERMARLY")
	row.EffectiveUnitCost = floatPtr(100)
	// SQL agregado: dos proveedores en camino, el mismo producto.
	row.TransitDetail = `[
		{"s":7,"n":"HERMARLY","q":6,"o":"co-1","d":"2026-10-04"},
		{"s":9,"n":"POSTOBON","q":4,"o":"co-2","d":"2026-10-07"}
	]`

	got := buildRestockSuggestion(row, time.Now())
	if !got.InTransit {
		t.Fatal("InTransit deberia ser true con live_in_transit_qty = 10")
	}
	if len(got.InTransitBreakdown) != 2 {
		t.Fatalf("InTransitBreakdown = %d entradas; want 2 (dos proveedores)", len(got.InTransitBreakdown))
	}
	first := got.InTransitBreakdown[0]
	if first.SupplierName != "HERMARLY" || first.Quantity != 6 {
		t.Errorf("primera entrada %+v no coincide con HERMARLY/6", first)
	}
	if first.ProductID != "770123" || first.ProductName != "COCA 1L" {
		t.Errorf("datos del producto no se inyectaron en el breakdown: %+v", first)
	}
}

func TestBuildRestockSuggestion_SinTransitoNoEmiteBreakdown(t *testing.T) {
	row := restockSuggestionRow{}
	row.ProductRestockMetric = models.ProductRestockMetric{ProductID: "X"}
	row.TransitDetail = "[]"
	row.EffectiveSupplierID = uintPtr(1)
	row.EffectiveSupplierName = strPtr("X")
	row.EffectiveUnitCost = floatPtr(1)

	got := buildRestockSuggestion(row, time.Now())
	if got.InTransitBreakdown != nil {
		t.Fatalf("Esperaba InTransitBreakdown nil cuando no hay transito; got %+v", got.InTransitBreakdown)
	}
}

// Garantiza que el SQL incluye el agregado JSON y las dos CTEs auxiliares.
// Si alguien renombra transito_total o transito_detalle este test falla.
func TestRestockSuggestionsSQLIncluyeTransitDetail(t *testing.T) {
	required := []string{
		"), transito_vivo AS (",
		"), transito_total AS (",
		"), transito_detalle AS (",
		"COALESCE(td.detail, '[]') AS transit_detail",
		"LEFT JOIN transito_total tv ON tv.product_id = c.product_id",
		"LEFT JOIN transito_detalle td ON td.product_id = c.product_id",
	}
	for _, want := range required {
		if !strings.Contains(restockSuggestionsSQL, want) {
			t.Errorf("SQL deberia contener %q", want)
		}
	}
}

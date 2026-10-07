package services

import (
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

// Estos tests ejercen la logica pura de agrupamiento y resolucion de proveedor
// de ReceptionSummary. No construyen el DashboardService completo (que tiene
// 12 dependencias) porque la verdad del algoritmo vive en:
//
//  - isReceptionMovement
//  - parseReceptionMetadata
//  - receptionGroup.append / toSummary
//
// y pueden testearse sin tocar la BD. El contrato HTTP de /receptions-history
// se cubre en los tests de handlers (dashboard_report_handler_test.go) con un
// servidor Gin aislado.

func TestIsReceptionMovement(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		m    models.StockMovement
		want bool
	}{
		{"reception", models.StockMovement{ReferenceID: "RECP-1", Reason: "RECEPTION"}, true},
		{"reception_bonus", models.StockMovement{ReferenceID: "RECP-1", Reason: "RECEPTION_BONUS"}, true},
		{"adjustment_up_in_recp", models.StockMovement{ReferenceID: "RECP-7", Reason: "ADJUSTMENT_UP"}, true},
		{"adjustment_down_in_recp", models.StockMovement{ReferenceID: "RECP-7", Reason: "ADJUSTMENT_DOWN"}, true},
		{"sale_no_match", models.StockMovement{ReferenceID: "SALE-9", Reason: "SALE"}, false},
		{"no_reference", models.StockMovement{ReferenceID: "", Reason: "RECEPTION"}, false},
		{"adjustment_without_recp_prefix", models.StockMovement{ReferenceID: "ADJ-5", Reason: "ADJUSTMENT_UP"}, false},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := isReceptionMovement(tc.m); got != tc.want {
				t.Fatalf("isReceptionMovement(%+v) = %v; want %v", tc.m, got, tc.want)
			}
		})
	}
}

func TestParseReceptionMetadata(t *testing.T) {
	t.Parallel()

	if m := parseReceptionMetadata(""); m != nil {
		t.Fatalf("empty = %+v; want nil", m)
	}
	if m := parseReceptionMetadata("{}"); m != nil {
		t.Fatalf("empty-object = %+v; want nil", m)
	}
	if m := parseReceptionMetadata("not-json"); m != nil {
		t.Fatalf("garbage = %+v; want nil", m)
	}

	raw := `{"entry":{"barcode":"EAN1","addedQuantity":10,"newPurchasePrice":1250},"supplierName":"COCA-COLA","employeeName":"JOSE"}`
	m := parseReceptionMetadata(raw)
	if m == nil {
		t.Fatalf("full = nil; want parseo exitoso")
	}
	if m.SupplierName != "COCA-COLA" || m.EmployeeName != "JOSE" {
		t.Fatalf("names = %+v", m)
	}
	if m.Entry.NewPurchasePrice != 1250 || m.Entry.AddedQuantity != 10 {
		t.Fatalf("entry = %+v", m.Entry)
	}
}

func TestReceptionGroup_SingleSupplier(t *testing.T) {
	t.Parallel()
	g := &receptionGroup{ID: "RECP-A", Employee: "JOSE"}
	meta := `{"entry":{"newPurchasePrice":1000,"addedQuantity":5},"supplierName":"COCA-COLA","employeeName":"JOSE"}`
	g.append(models.StockMovement{Barcode: "EAN1", Quantity: 5, Reason: "RECEPTION", Metadata: meta, Date: time.Now(), Product: models.Product{ProductName: "COCA 1L"}})
	g.append(models.StockMovement{Barcode: "EAN2", Quantity: 2, Reason: "RECEPTION_BONUS", Metadata: meta, Date: time.Now(), Product: models.Product{ProductName: "COCA 350"}})

	s := g.toSummary(nil)
	if s.SupplierName != "COCA-COLA" {
		t.Fatalf("supplier = %q; want COCA-COLA", s.SupplierName)
	}
	if s.MultiSupplier {
		t.Fatalf("multiSupplier = true; want false (un solo proveedor)")
	}
	if s.TotalLines != 2 || s.TotalUnits != 7 {
		t.Fatalf("totales = lines=%d units=%v; want 2 lineas y 7 unidades", s.TotalLines, s.TotalUnits)
	}
	if s.TotalCost == nil || *s.TotalCost != 7000 {
		t.Fatalf("totalCost = %v; want *7000 (5*1000 + 2*1000)", s.TotalCost)
	}
	if !s.IsBypass {
		t.Fatalf("isBypass = false; want true (sin egreso)")
	}
	if s.IsEdited {
		t.Fatalf("isEdited = true; want false (sin EditedAt)")
	}
}

func TestReceptionGroup_MultiSupplier(t *testing.T) {
	t.Parallel()
	g := &receptionGroup{ID: "RECP-B", Employee: "ANA"}
	g.append(models.StockMovement{
		Barcode: "A", Quantity: 1, Reason: "RECEPTION", Date: time.Now(),
		Metadata: `{"entry":{"newPurchasePrice":100,"addedQuantity":1},"supplierName":"PROVEEDOR X"}`,
		Product:  models.Product{ProductName: "P1"},
	})
	g.append(models.StockMovement{
		Barcode: "B", Quantity: 2, Reason: "RECEPTION", Date: time.Now(),
		Metadata: `{"entry":{"newPurchasePrice":50,"addedQuantity":2},"supplierName":"PROVEEDOR Y"}`,
		Product:  models.Product{ProductName: "P2"},
	})

	s := g.toSummary(nil)
	if s.SupplierName != "Varios proveedores" || !s.MultiSupplier {
		t.Fatalf("supplier = %q (multi=%v); want 'Varios proveedores' / multi=true", s.SupplierName, s.MultiSupplier)
	}
	if len(s.Suppliers) != 2 {
		t.Fatalf("suppliers = %v; want 2", s.Suppliers)
	}
}

func TestReceptionGroup_LegacyFallbackFromExpense(t *testing.T) {
	t.Parallel()
	g := &receptionGroup{ID: "RECP-C"}
	// Movimiento legacy: metadata vacio, sin supplierName
	g.append(models.StockMovement{Barcode: "X", Quantity: 3, Reason: "RECEPTION", Metadata: "", Date: time.Now(), Product: models.Product{ProductName: "LEGACY"}})

	expense := &models.Expense{ReferenceID: "RECP-C", Supplier: &models.Supplier{Name: "DIPSA SAS"}}
	s := g.toSummary(expense)

	if s.SupplierName != "DIPSA SAS" {
		t.Fatalf("supplier = %q; want 'DIPSA SAS' (fallback de egreso)", s.SupplierName)
	}
	if s.IsBypass {
		t.Fatalf("isBypass = true; want false (hay egreso)")
	}
	if len(s.Lines) != 1 || s.Lines[0].SupplierName != "DIPSA SAS" {
		t.Fatalf("line supplier no se relleno con fallback: %+v", s.Lines)
	}
}

func TestReceptionGroup_LegacyWithoutExpenseFallsBackToHonestLabel(t *testing.T) {
	t.Parallel()
	g := &receptionGroup{ID: "RECP-D"}
	g.append(models.StockMovement{Barcode: "Y", Quantity: 1, Reason: "RECEPTION", Metadata: "", Date: time.Now(), Product: models.Product{ProductName: "HUERFANO"}})

	s := g.toSummary(nil)
	if s.SupplierName != "Proveedor no registrado" {
		t.Fatalf("supplier = %q; want 'Proveedor no registrado'", s.SupplierName)
	}
	if !s.IsBypass {
		t.Fatalf("isBypass = false; want true (no hay egreso)")
	}
	if s.TotalCost != nil {
		t.Fatalf("totalCost = %v; want nil (metadata vacio, sin costo)", s.TotalCost)
	}
}

func TestReceptionGroup_IncludesBonusAndAdjustments(t *testing.T) {
	t.Parallel()
	g := &receptionGroup{ID: "RECP-E"}
	meta := `{"entry":{"newPurchasePrice":100,"addedQuantity":5},"supplierName":"CORONA"}`
	g.append(models.StockMovement{Barcode: "A", Quantity: 5, Reason: "RECEPTION", Metadata: meta, Date: time.Now(), Product: models.Product{ProductName: "P1"}})
	g.append(models.StockMovement{Barcode: "B", Quantity: 2, Reason: "RECEPTION_BONUS", Metadata: meta, Date: time.Now(), Product: models.Product{ProductName: "P2"}})
	// Ajuste con reference_id RECP-E tambien debe entrar al resumen
	g.append(models.StockMovement{Barcode: "C", Quantity: -1, Reason: "ADJUSTMENT_DOWN", Metadata: meta, Date: time.Now(), Product: models.Product{ProductName: "P3"}})

	s := g.toSummary(nil)
	if s.TotalLines != 3 {
		t.Fatalf("totalLines = %d; want 3 (RECEPTION + RECEPTION_BONUS + ADJUSTMENT_DOWN)", s.TotalLines)
	}
	// 5 + 2 + (-1) = 6
	if s.TotalUnits != 6 {
		t.Fatalf("totalUnits = %v; want 6", s.TotalUnits)
	}
}

func TestReceptionGroup_MarksEditedWhenAnyMovementHasEditedAt(t *testing.T) {
	t.Parallel()
	g := &receptionGroup{ID: "RECP-F"}
	now := time.Now()
	g.append(models.StockMovement{Barcode: "A", Quantity: 1, Reason: "RECEPTION", Date: now, Product: models.Product{ProductName: "P"}})
	g.append(models.StockMovement{Barcode: "B", Quantity: 1, Reason: "RECEPTION", Date: now, EditedAt: &now, Product: models.Product{ProductName: "P2"}})

	s := g.toSummary(nil)
	if !s.IsEdited {
		t.Fatalf("isEdited = false; want true (uno de los movimientos tiene EditedAt)")
	}
}

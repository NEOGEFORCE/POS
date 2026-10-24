package services

import (
	"os"
	"strings"
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// =============================================================================
// Guardarraíles del namespace POSINT- en ProductService.
//
// Fijan los invariantes que mantienen la reserva como ÚNICA puerta de entrada
// del namespace:
//
//   - CreateProduct rechaza barcodes POSINT- (deben ir por el flujo del
//     InternalBarcodeRepository.CreateProductConsumingReservation).
//   - UpdateProduct bloquea renames hacia POSINT- (no se puede "renombrar
//     un producto existente a POSINT-ABC" sin pasar por el flujo).
//   - UpsertProduct (CSV import) bloquea POSINT- de raíz.
//   - UpdateProduct bloquea POSINT- en alternate_codes.
//
// Son pruebas de servicio puras: no abren Postgres. Verifican el camino
// antes de llegar al repositorio.
// =============================================================================

func TestProductService_CreateProduct_RechazaPOSINT(t *testing.T) {
	t.Parallel()
	// Construimos un service con repo nil: la validación POSINT corre
	// ANTES del Save, así que nunca llega al repositorio y el nil es
	// seguro aquí.
	s := &ProductService{}
	err := s.CreateProduct(&models.Product{
		Barcode:     "POSINT-ABCDEF01",
		ProductName: "GRANEL",
	})
	if err == nil {
		t.Fatal("CreateProduct con barcode POSINT- debe fallar; el namespace exige reserva atómica")
	}
	if !strings.Contains(err.Error(), "POSINT") {
		t.Errorf("el error debe mencionar POSINT para que el handler enrute al flujo correcto; got %q", err.Error())
	}
}

func TestProductService_CreateProduct_PermiteCódigosComerciales(t *testing.T) {
	t.Parallel()
	// Un barcode EAN13 real no debe caer en el guardia POSINT. Como el
	// repo es nil, falla al llegar al Save, pero el ERROR concreto no
	// debe ser el del guardia. Verificamos que el error no mencione
	// POSINT.
	//
	// La forma más defensiva es "detectar que PASÓ el guardia": si el
	// repo nil hace panic, atrapamos con defer.
	defer func() {
		if r := recover(); r != nil {
			// Panic esperado del nil repo; el guardia POSINT no se activó.
			return
		}
	}()
	s := &ProductService{}
	err := s.CreateProduct(&models.Product{
		Barcode:     "7709999999999",
		ProductName: "COCA COLA 500ML",
	})
	// Si no panic (porque el nil se chequeó), el error no debe ser POSINT.
	if err != nil && strings.Contains(err.Error(), "POSINT") {
		t.Errorf("el guardia POSINT no debe activarse para códigos comerciales; got %q", err.Error())
	}
}

func TestProductService_UpsertProduct_RechazaPOSINT(t *testing.T) {
	t.Parallel()
	s := &ProductService{}
	err := s.UpsertProduct(&models.Product{
		Barcode:     "POSINT-DEADBEEF",
		ProductName: "IMPORT CSV",
	})
	if err == nil {
		t.Fatal("UpsertProduct (CSV import) con POSINT- debe fallar")
	}
	if !strings.Contains(err.Error(), "CSV") || !strings.Contains(err.Error(), "POSINT") {
		t.Errorf("el error debe mencionar CSV y POSINT; got %q", err.Error())
	}
}

func TestProductService_UpdateProduct_BloqueaRenameHaciaPOSINT(t *testing.T) {
	t.Parallel()
	// barcode original = EAN13, target = POSINT → rechazo del guardia.
	s := &ProductService{}
	err := s.UpdateProduct("7709999999999", &models.Product{
		Barcode:     "POSINT-ABCDEF01",
		ProductName: "COCA COLA 500ML",
	})
	if err == nil {
		t.Fatal("UpdateProduct debe rechazar renames hacia POSINT-")
	}
	if !strings.Contains(err.Error(), "POSINT") {
		t.Errorf("el error debe mencionar POSINT; got %q", err.Error())
	}
	if !strings.Contains(err.Error(), "reserva") {
		t.Errorf("el error debe mencionar que requiere reserva; got %q", err.Error())
	}
}

func TestProductService_UpdateProduct_BloqueaPOSINTEnAlternateCodes(t *testing.T) {
	t.Parallel()
	s := &ProductService{}
	err := s.UpdateProduct("7709999999999", &models.Product{
		Barcode:        "7709999999999",
		ProductName:    "COCA COLA",
		AlternateCodes: "7709000000001, POSINT-ABCDEF01, 7709111111111",
	})
	if err == nil {
		t.Fatal("UpdateProduct debe rechazar alternate_codes que contengan POSINT-")
	}
	if !strings.Contains(err.Error(), "alterno") || !strings.Contains(err.Error(), "POSINT") {
		t.Errorf("el error debe mencionar \"alterno\" y \"POSINT\"; got %q", err.Error())
	}
}

func TestProductService_UpdateProduct_PermiteUpdateSobreProductoPOSINTExistente(t *testing.T) {
	// Si el producto YA existe con barcode POSINT-ABC y el update NO
	// cambia el barcode (currentBarcode == targetBarcode), el guardia no
	// debe activarse. El repo nil hará panic al llegar al Save, lo
	// atrapamos; lo relevante es que el error NO sea del guardia.
	defer func() { _ = recover() }()
	s := &ProductService{}
	err := s.UpdateProduct("POSINT-ABCDEF01", &models.Product{
		Barcode:     "POSINT-ABCDEF01",
		ProductName: "GRANEL NUEVO NOMBRE",
	})
	if err != nil && strings.Contains(err.Error(), "renombrar hacia POSINT-") {
		t.Errorf("el guardia NO debe activarse en update del mismo barcode POSINT; got %q", err.Error())
	}
}

// TestProductService_PosintCheckUsaIsInternalBarcode: el guardia se apoya
// en el helper del modelo. Si alguien duplica la lógica inline (p.ej.
// strings.HasPrefix(target, "POSINT-")) y luego el namespace cambia,
// una ruta queda desactualizada. El guardián estático obliga a usar el
// helper.
func TestProductService_PosintCheckUsaIsInternalBarcode(t *testing.T) {
	bts, err := os.ReadFile("product_service.go")
	if err != nil {
		t.Fatalf("ReadFile(product_service.go): %v", err)
	}
	src := string(bts)
	// Debe usar el helper del modelo.
	if !strings.Contains(src, "models.IsInternalBarcode(") {
		t.Error("product_service.go debe usar models.IsInternalBarcode(...) para detectar el namespace")
	}
	// Las comparaciones no deben hacerse inline con HasPrefix: ese sería
	// un camino que ignora cambios futuros al prefijo o a la normalización.
	for _, forbidden := range []string{
		`strings.HasPrefix(product.Barcode, "POSINT-")`,
		`strings.HasPrefix(updatedProduct.Barcode, "POSINT-")`,
		`strings.HasPrefix(targetBarcode, "POSINT-")`,
	} {
		if strings.Contains(src, forbidden) {
			t.Errorf("product_service.go no debe inlinearse comparación %q — usar models.IsInternalBarcode()", forbidden)
		}
	}
}

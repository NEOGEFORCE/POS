package services

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

func TestBuildProductLookupIndexesPrimaryAlternateAndBase(t *testing.T) {
	baseBarcode := "BASE-1"
	products := []models.Product{{
		Barcode:            "PACK-1",
		AlternateCodes:     " ALT-1,ALT-2 ",
		BaseProductBarcode: &baseBarcode,
		BaseProduct:        &models.Product{Barcode: baseBarcode, ProductName: "Base"},
	}}

	lookup := buildProductLookup(products)
	for _, barcode := range []string{"PACK-1", "ALT-1", "ALT-2", "BASE-1"} {
		if lookup[barcode] == nil {
			t.Fatalf("barcode %s no fue indexado", barcode)
		}
	}
	if lookup["ALT-1"].Barcode != "PACK-1" {
		t.Fatalf("alterno resolvió a producto incorrecto: %+v", lookup["ALT-1"])
	}
	if lookup["BASE-1"].ProductName != "Base" {
		t.Fatalf("producto base incorrecto: %+v", lookup["BASE-1"])
	}
}

package handlers

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

func TestNeedsInTransitConfirmationAllowsExplicitOverride(t *testing.T) {
	t.Parallel()

	products := []models.InTransitProduct{{
		ProductID:   "770123",
		ProductName: "Producto pedido",
		Quantity:    12,
	}}
	if !needsInTransitConfirmation(products, false) {
		t.Fatal("se esperaba advertencia cuando existe tránsito y no hay override")
	}
	if needsInTransitConfirmation(products, true) {
		t.Fatal("el override explícito no debe quedar bloqueado")
	}
	if needsInTransitConfirmation(nil, false) {
		t.Fatal("no debe advertir cuando no hay productos en tránsito")
	}
}

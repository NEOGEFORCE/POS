package services

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

func TestRegisterShrinkageValidatesBeforeRepository(t *testing.T) {
	t.Parallel()

	service := &ProductService{}
	tests := []struct {
		name      string
		shrinkage *models.Shrinkage
	}{
		{name: "missing product", shrinkage: &models.Shrinkage{Quantity: 1, Reason: models.ShrinkageRotura}},
		{name: "zero quantity", shrinkage: &models.Shrinkage{ProductID: "7701", Quantity: 0, Reason: models.ShrinkageRotura}},
		{name: "negative quantity", shrinkage: &models.Shrinkage{ProductID: "7701", Quantity: -1, Reason: models.ShrinkageRotura}},
		{name: "invalid reason", shrinkage: &models.Shrinkage{ProductID: "7701", Quantity: 1, Reason: models.ShrinkageReason("OTRO")}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := service.RegisterShrinkage(test.shrinkage); err == nil {
				t.Fatal("RegisterShrinkage() error = nil; se esperaba validación antes del repositorio")
			}
		})
	}
}

package repositories

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// TestIsHistoricalMarker documenta la firma que dejó
// paquete_produccion\corregir_referencias.ps1 al crear productos fantasma para
// tapar FKs huérfanas. La firma exacta importa: si el nombre no empieza con
// "[HISTORICO]" o el producto está activo, NO es un marcador y no puede
// pasar por el endpoint de fusión (arreglo 5).
func TestIsHistoricalMarker(t *testing.T) {
	cases := []struct {
		name    string
		product models.Product
		want    bool
	}{
		{
			name:    "marcador tipico creado por corregir_referencias.ps1",
			product: models.Product{Barcode: "7701234567890", ProductName: "[HISTORICO] 7701234567890", IsActive: false},
			want:    true,
		},
		{
			name:    "marcador con espacio inicial",
			product: models.Product{Barcode: "ABC", ProductName: "  [HISTORICO] ABC", IsActive: false},
			want:    true,
		},
		{
			name:    "producto activo con nombre historico NO es marcador (protege datos reales)",
			product: models.Product{Barcode: "X", ProductName: "[HISTORICO] X", IsActive: true},
			want:    false,
		},
		{
			name:    "producto real desactivado desde UI NO es marcador",
			product: models.Product{Barcode: "X", ProductName: "COCA COLA 350ML", IsActive: false},
			want:    false,
		},
		{
			name:    "nombre parecido pero no coincide con el prefijo",
			product: models.Product{Barcode: "X", ProductName: "HISTORICO X", IsActive: false},
			want:    false,
		},
		{
			name:    "nombre vacio con inactivo NO es marcador",
			product: models.Product{Barcode: "X", ProductName: "", IsActive: false},
			want:    false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isHistoricalMarker(tc.product); got != tc.want {
				t.Fatalf("isHistoricalMarker(%+v) = %v; want %v", tc.product, got, tc.want)
			}
		})
	}
}

package repositories

import (
	"testing"

	"backPOS-go/internal/core/domain/models"
)

// TestSortSuggestionsByBandAndUrgency verifica el orden autoritativo de
// Fase 1: banda -> pedido -> cobertura -> demanda -> nombre.
func TestSortSuggestionsByBandAndUrgency(t *testing.T) {
	items := []models.RestockSuggestionResponse{
		{
			ProductRestockMetric: models.ProductRestockMetric{
				ProductName:       "GREEN sin pedido",
				SuggestedOrderQty: 0,
				AvgDailySales:     0.1,
				InTransitQty:      0,
			},
			StockBand: models.StockBandGreen,
			LiveStock: 10,
		},
		{
			ProductRestockMetric: models.ProductRestockMetric{
				ProductName:       "RED con pedido",
				SuggestedOrderQty: 5,
				AvgDailySales:     3,
				InTransitQty:      0,
			},
			StockBand: models.StockBandRed,
			LiveStock: 1,
		},
		{
			ProductRestockMetric: models.ProductRestockMetric{
				ProductName:       "YELLOW con pedido",
				SuggestedOrderQty: 2,
				AvgDailySales:     1,
				InTransitQty:      0,
			},
			StockBand: models.StockBandYellow,
			LiveStock: 5,
		},
		{
			ProductRestockMetric: models.ProductRestockMetric{
				ProductName:       "UNSET",
				SuggestedOrderQty: 0,
				AvgDailySales:     0,
				InTransitQty:      0,
			},
			StockBand: models.StockBandUnset,
			LiveStock: 3,
		},
		{
			ProductRestockMetric: models.ProductRestockMetric{
				ProductName:       "RED sin pedido",
				SuggestedOrderQty: 0,
				AvgDailySales:     0.5,
				InTransitQty:      0,
			},
			StockBand: models.StockBandRed,
			LiveStock: 0,
		},
	}

	sortSuggestionsByBandAndUrgency(items)

	// Esperado: RED con pedido, RED sin pedido, YELLOW con pedido,
	// GREEN sin pedido, UNSET.
	wantOrder := []string{
		"RED con pedido",
		"RED sin pedido",
		"YELLOW con pedido",
		"GREEN sin pedido",
		"UNSET",
	}
	for i, want := range wantOrder {
		if items[i].ProductName != want {
			t.Errorf("posicion %d = %q; want %q", i, items[i].ProductName, want)
		}
	}
}

// TestSortSuggestionsCoberturaGanaEnMismaBanda verifica que dentro de una
// misma banda con pedido, se ordena por menor cobertura (dias hasta
// agotarse).
func TestSortSuggestionsCoberturaGanaEnMismaBanda(t *testing.T) {
	items := []models.RestockSuggestionResponse{
		{
			ProductRestockMetric: models.ProductRestockMetric{
				ProductName:       "cobertura alta",
				SuggestedOrderQty: 1,
				AvgDailySales:     1,
			},
			StockBand: models.StockBandRed,
			LiveStock: 6, // 6 dias de cobertura
		},
		{
			ProductRestockMetric: models.ProductRestockMetric{
				ProductName:       "cobertura baja",
				SuggestedOrderQty: 1,
				AvgDailySales:     1,
			},
			StockBand: models.StockBandRed,
			LiveStock: 1, // 1 dia de cobertura -> mas urgente
		},
	}
	sortSuggestionsByBandAndUrgency(items)
	if items[0].ProductName != "cobertura baja" {
		t.Fatalf("primero = %q; want cobertura baja (menor cobertura)", items[0].ProductName)
	}
}

// TestSortSuggestionsDemandaGanaCuandoCoberturaEmpata verifica el desempate
// por demanda diaria (mayor primero).
func TestSortSuggestionsDemandaGanaCuandoCoberturaEmpata(t *testing.T) {
	items := []models.RestockSuggestionResponse{
		{
			ProductRestockMetric: models.ProductRestockMetric{
				ProductName:       "demanda baja",
				SuggestedOrderQty: 1,
				AvgDailySales:     1,
			},
			StockBand: models.StockBandRed,
			LiveStock: 2,
		},
		{
			ProductRestockMetric: models.ProductRestockMetric{
				ProductName:       "demanda alta",
				SuggestedOrderQty: 1,
				AvgDailySales:     5,
			},
			StockBand: models.StockBandRed,
			LiveStock: 10, // 10/5 = 2 dias, mismo que "demanda baja" (2/1)
		},
	}
	sortSuggestionsByBandAndUrgency(items)
	if items[0].ProductName != "demanda alta" {
		t.Fatalf("primero = %q; want demanda alta (mayor demanda diaria)", items[0].ProductName)
	}
}

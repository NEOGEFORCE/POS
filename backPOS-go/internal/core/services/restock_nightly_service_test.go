package services

import (
	"testing"
	"time"

	"backPOS-go/internal/core/domain/models"
)

func TestCalculateRestockMetricAdjustsDemandAndTransit(t *testing.T) {
	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "7701",
		ProductName:      "Producto A",
		CurrentStock:     4,
		TotalSold30d:     60,
		DaysZeroStock:    10,
		InTransitQty:     5,
		SupplierLeadDays: 7,
		UnitCost:         1000,
	}, time.Unix(1, 0))

	if metric.AvgDailySales != 3 {
		t.Fatalf("demand = %v; want 3", metric.AvgDailySales)
	}
	if metric.ABCCategory != "A" {
		t.Fatalf("category = %q; want A", metric.ABCCategory)
	}
	if metric.IdealStock != 21 {
		t.Fatalf("ideal stock = %v; want 21", metric.IdealStock)
	}
	if metric.SuggestedOrderQty != 12 {
		t.Fatalf("suggestion = %v; want 12", metric.SuggestedOrderQty)
	}
}

func TestCalculateRestockMetricCategoryCAlwaysSuggestsZero(t *testing.T) {
	metric := calculateRestockMetric(models.RestockCalculationInput{
		ProductID:        "7702",
		CurrentStock:     0,
		TotalSold30d:     3,
		DaysZeroStock:    0,
		SupplierLeadDays: 30,
	}, time.Unix(1, 0))

	if metric.ABCCategory != "C" {
		t.Fatalf("category = %q; want C", metric.ABCCategory)
	}
	if metric.IdealStock != 3 {
		t.Fatalf("ideal stock = %v; want 3 for auditability", metric.IdealStock)
	}
	if metric.SuggestedOrderQty != 0 {
		t.Fatalf("category C suggestion = %v; want 0", metric.SuggestedOrderQty)
	}
}

func TestCalculateRestockMetricUsesDefensiveFallbacks(t *testing.T) {
	metric := calculateRestockMetric(models.RestockCalculationInput{
		TotalSold30d:     15,
		DaysZeroStock:    30,
		SupplierLeadDays: 0,
	}, time.Unix(1, 0))

	if metric.DaysWithStock != 1 {
		t.Fatalf("days with stock = %d; want 1", metric.DaysWithStock)
	}
	if metric.SupplierLeadDays != 7 {
		t.Fatalf("lead days = %d; want 7", metric.SupplierLeadDays)
	}
	if metric.ABCCategory != "A" {
		t.Fatalf("category = %q; want A because adjusted demand is 15/day", metric.ABCCategory)
	}
	if metric.SuggestedOrderQty != 105 {
		t.Fatalf("suggestion = %v; want 105", metric.SuggestedOrderQty)
	}
}

func TestClassifyABCUsesEitherThreshold(t *testing.T) {
	tests := []struct {
		name      string
		demand    float64
		totalSold float64
		want      string
	}{
		{name: "A by daily demand", demand: 3, totalSold: 1, want: "A"},
		{name: "A by monthly sales", demand: 0.1, totalSold: 60, want: "A"},
		{name: "B by daily demand", demand: 0.5, totalSold: 1, want: "B"},
		{name: "B by monthly sales", demand: 0.1, totalSold: 15, want: "B"},
		{name: "C", demand: 0.49, totalSold: 14.99, want: "C"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyABC(tt.demand, tt.totalSold); got != tt.want {
				t.Fatalf("classifyABC(%v, %v) = %q; want %q", tt.demand, tt.totalSold, got, tt.want)
			}
		})
	}
}

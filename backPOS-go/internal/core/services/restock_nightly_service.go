package services

import (
	"context"
	"log"
	"math"
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
)

const restockWindowDays = 30

var bogotaLocation = time.FixedZone("America/Bogota", -5*60*60)

type RestockNightlyService struct {
	metricsRepo *repositories.RestockMetricsRepository
	now         func() time.Time
}

func NewRestockNightlyService(mr *repositories.RestockMetricsRepository) *RestockNightlyService {
	return &RestockNightlyService{
		metricsRepo: mr,
		now:         time.Now,
	}
}

func (s *RestockNightlyService) RunNightlyMetricsCalculation(ctx context.Context) error {
	now := s.now().In(bogotaLocation)
	since := now.AddDate(0, 0, -restockWindowDays)
	inputs, err := s.metricsRepo.LoadCalculationInputs(ctx, since, now)
	if err != nil {
		return err
	}

	snapshots := make([]models.DailyStockSnapshot, 0, len(inputs))
	metrics := make([]models.ProductRestockMetric, 0, len(inputs))
	for _, input := range inputs {
		snapshots = append(snapshots, models.DailyStockSnapshot{
			ProductID:    input.ProductID,
			SnapshotDate: now.Format("2006-01-02"),
			ClosingStock: input.CurrentStock,
			WasZero:      input.CurrentStock <= 0,
		})
		metrics = append(metrics, calculateRestockMetric(input, now))
	}

	if err := s.metricsRepo.SaveNightlyBatch(ctx, snapshots, metrics); err != nil {
		return err
	}
	log.Printf("[RESTOCK-NIGHTLY] completed batch for %d products", len(metrics))
	return nil
}

func calculateRestockMetric(input models.RestockCalculationInput, calculatedAt time.Time) models.ProductRestockMetric {
	daysZero := input.DaysZeroStock
	if daysZero < 0 {
		daysZero = 0
	}
	if daysZero > restockWindowDays {
		daysZero = restockWindowDays
	}
	daysWithStock := restockWindowDays - daysZero
	if daysWithStock < 1 {
		daysWithStock = 1
	}

	demand := input.TotalSold30d / float64(daysWithStock)
	if demand < 0 {
		demand = 0
	}
	leadDays := input.SupplierLeadDays
	if leadDays <= 0 {
		leadDays = 7
	}
	category := classifyABC(demand, input.TotalSold30d)
	idealStock := math.Ceil(demand * float64(leadDays))
	suggested := math.Max(0, idealStock-(input.CurrentStock+input.InTransitQty))
	if category == "C" {
		suggested = 0
	}

	return models.ProductRestockMetric{
		ProductID:         input.ProductID,
		ProductName:       input.ProductName,
		TotalSold30d:      input.TotalSold30d,
		DaysWithStock:     daysWithStock,
		DaysZeroStock:     daysZero,
		AvgDailySales:     math.Round(demand*10000) / 10000,
		ABCCategory:       category,
		CurrentStock:      input.CurrentStock,
		InTransitQty:      input.InTransitQty,
		IdealStock:        idealStock,
		SuggestedOrderQty: suggested,
		PrimarySupplierID: input.PrimarySupplierID,
		SupplierName:      input.SupplierName,
		SupplierLeadDays:  leadDays,
		UnitCost:          input.UnitCost,
		CalculatedAt:      calculatedAt,
	}
}

func classifyABC(avgDaily, totalSold float64) string {
	if avgDaily >= 3 || totalSold >= 60 {
		return "A"
	}
	if avgDaily >= 0.5 || totalSold >= 15 {
		return "B"
	}
	return "C"
}

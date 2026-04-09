package services

import (
	"math"
	"time"

	"backPOS-go/internal/core/ports"
)

type InventoryService struct {
	repo ports.ProductRepository
}

func NewInventoryService(repo ports.ProductRepository) *InventoryService {
	return &InventoryService{repo: repo}
}

func (s *InventoryService) GetInventory(from, to string) ([]ports.InventoryStat, error) {
	stats, err := s.repo.GetInventoryStats(from, to)
	if err != nil {
		return nil, err
	}

	days := calculateDays(from, to)

	for i := range stats {
		if days > 0 {
			avg := float64(stats[i].UnitsSold) / float64(days)
			stats[i].AvgSoldPerDay = math.Round(avg*100) / 100
		}
	}

	return stats, nil
}

func calculateDays(from, to string) int {
	if from == "" || to == "" {
		return 1
	}
	start, err1 := time.Parse("2006-01-02", from)
	end, err2 := time.Parse("2006-01-02", to)
	if err1 != nil || err2 != nil {
		return 1
	}
	diff := int(end.Sub(start).Hours()/24) + 1
	if diff < 1 {
		return 1
	}
	return diff
}

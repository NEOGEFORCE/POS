package services

import (
	"math"
	"time"

	"backPOS-go/internal/core/ports"
)

type InventoryService struct {
	repo     ports.ProductRepository
	saleRepo ports.SaleRepository
}

func NewInventoryService(repo ports.ProductRepository, saleRepo ports.SaleRepository) *InventoryService {
	return &InventoryService{repo: repo, saleRepo: saleRepo}
}

type SuggestedOrder struct {
	Barcode     string  `json:"barcode"`
	ProductName string  `json:"productName"`
	Stock       float64 `json:"stock"`
	MinStock    float64 `json:"minStock"`
	RecentSales float64 `json:"recentSales"` // Last 15 days
	Suggested   float64 `json:"suggested"`
}

func (s *InventoryService) GetSuggestedOrders(supplierID uint) ([]SuggestedOrder, error) {
	products, err := s.repo.GetBySupplier(supplierID)
	if err != nil {
		return nil, err
	}

	suggested := []SuggestedOrder{}
	now := time.Now()
	fifteenDaysAgo := now.AddDate(0, 0, -15).Format("2006-01-02")
	todayStr := now.Format("2006-01-02")

	for _, p := range products {
		if p.Quantity <= p.MinStock {
			sold, _ := s.saleRepo.GetSoldQuantityByProduct(p.Barcode, fifteenDaysAgo, todayStr)
			
			// Simple algorithm: fill to MinStock + average sales of 15 days
			suggestedQty := (p.MinStock - p.Quantity) + sold

			suggested = append(suggested, SuggestedOrder{
				Barcode:     p.Barcode,
				ProductName: p.ProductName,
				Stock:       p.Quantity,
				MinStock:    p.MinStock,
				RecentSales: sold,
				Suggested:   math.Ceil(suggestedQty),
			})
		}
	}

	return suggested, nil
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

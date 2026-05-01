package services

import (
	"log"
	"math"
	"sort"
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

// Usar StockStatus, StockCritical, StockWarning, StockOptimal desde dashboard_service.go

type SuggestedOrder struct {
	Barcode        string      `json:"barcode"`
	ProductName    string      `json:"productName"`
	Stock          float64     `json:"stock"`
	MinStock       float64     `json:"minStock"`
	IsPack         bool        `json:"isPack"`         // Modo Pack existente
	PackMultiplier int         `json:"packMultiplier"` // Multiplicador del pack
	RequiredMin    float64     `json:"requiredMin"`    // Mínimo obligado (MinStock - Stock)
	ProjectedSales float64     `json:"projectedSales"` // Proyección por ventas (TotalIdeal - RequiredMin)
	TotalIdeal     float64     `json:"totalIdeal"`     // Total ideal calculado (redondeado a PackMultiplier)
	RecentSales    float64     `json:"recentSales"`    // Last 14 days
	AvgDailySales  float64     `json:"avgDailySales"`  // Promedio venta diaria
	Suggested      float64     `json:"suggested"`      // Sugerencia final (igual a TotalIdeal)
	PurchasePrice  float64     `json:"purchasePrice"`
	SupplierID     uint        `json:"supplierId"` // 0 = sin proveedor asignado
	Threshold      int         `json:"threshold"`  // Umbral crítico calculado dinámicamente
	Status         StockStatus `json:"status"`     // CRITICAL, WARNING, OPTIMAL
	BestSupplierID   uint    `json:"bestSupplierId"`
	BestSupplierName string      `json:"bestSupplierName"`
	LowestPrice      float64     `json:"lowestPrice"`
	IsHighRotation   bool        `json:"isHighRotation"`
}

// CalculateSalesVelocity calcula el promedio de venta diaria para un producto
func (s *InventoryService) CalculateSalesVelocity(barcode string, days int) (float64, error) {
	if days <= 0 {
		days = 14
	}

	now := time.Now()
	startDate := now.AddDate(0, 0, -days).Format("2006-01-02")
	endDate := now.Format("2006-01-02")

	salesMap, err := s.saleRepo.GetSoldQuantitiesByBarcodes([]string{barcode}, startDate, endDate)
	if err != nil {
		return 0, err
	}

	totalSold := salesMap[barcode]
	avgDaily := float64(totalSold) / float64(days)

	return math.Round(avgDaily*100) / 100, nil
}

// GetGlobalRestockSuggestions devuelve todos los productos con bajo stock, incluyendo los sin proveedor asignado
func (s *InventoryService) GetGlobalRestockSuggestions() ([]SuggestedOrder, error) {
	log.Printf("[InventoryService] Iniciando GetGlobalRestockSuggestions (Smart Sourcing)...")

	// Obtener todos los productos con info de mejor proveedor
	products, err := s.repo.GetProductsWithBestSupplier(nil)
	if err != nil {
		log.Printf("[InventoryService] Error en GetProductsWithBestSupplier: %v", err)
		return nil, err
	}

	if len(products) == 0 {
		return []SuggestedOrder{}, nil
	}

	barcodes := make([]string, len(products))
	for i, p := range products {
		barcodes[i] = p.Barcode
	}

	now := time.Now()
	fourteenDaysAgo := now.AddDate(0, 0, -14).Format("2006-01-02")
	todayStr := now.Format("2006-01-02")

	salesMap, err := s.saleRepo.GetSoldQuantitiesByBarcodes(barcodes, fourteenDaysAgo, todayStr)
	if err != nil {
		return nil, err
	}

	suggested := []SuggestedOrder{}
	for _, p := range products {
		sold := salesMap[p.Barcode]
		avgDaily := float64(sold) / 14.0
		avgDaily = math.Round(avgDaily*100) / 100

		const DIAS_COBERTURA = 15.0
		
		sugeridoBase := p.MinStock - p.Quantity
		stockProyectado := avgDaily * DIAS_COBERTURA
		sugeridoPorVentas := stockProyectado - p.Quantity

		// La Regla de Decisión: El pedido final es el MAYOR entre el sugerido por ventas y el sugerido base
		totalIdeal := math.Max(sugeridoBase, sugeridoPorVentas)
		isHighRotation := sugeridoPorVentas > sugeridoBase && totalIdeal > 0

		if totalIdeal <= 0 {
			totalIdeal = 0
		} else {
			// Redondeo hacia arriba para evitar fracciones en pedidos de logística
			totalIdeal = math.Ceil(totalIdeal)
			
			// Si es un pack, ajustar al multiplicador
			if p.IsPack && p.PackMultiplier > 1 {
				totalIdeal = math.Ceil(totalIdeal/float64(p.PackMultiplier)) * float64(p.PackMultiplier)
			}
		}

		requiredMin := math.Max(0, sugeridoBase)
		projectedSales := math.Max(0, sugeridoPorVentas)

		// REMOVED FILTER: Traer todo el catálogo activo

		supplierID := uint(0)
		if p.SupplierID != nil {
			supplierID = *p.SupplierID
		}

		minStock := int(p.MinStock)
		if minStock <= 0 {
			minStock = 5
		}
		criticalThreshold := GetCriticalThreshold(minStock)

		// SPRINT HOTFIX: Lógica de Estado mejorada (CRÍTICO: stock <= minStock/2, BAJO: stock <= minStock)
		var status StockStatus
		if p.MinStock <= 0 {
			if p.Quantity <= 0 {
				status = StockCritical
			} else if p.Quantity <= 2 { // Margen mínimo de seguridad si no hay minStock definido
				status = StockWarning
			} else {
				status = StockOptimal
			}
		} else {
			if p.Quantity <= (p.MinStock / 2) {
				status = StockCritical
			} else if p.Quantity <= p.MinStock {
				status = StockWarning
			} else {
				status = StockOptimal
			}
		}

		suggested = append(suggested, SuggestedOrder{
			Barcode:        p.Barcode,
			ProductName:    p.ProductName,
			Stock:          p.Quantity,
			MinStock:       p.MinStock,
			IsPack:         p.IsPack,
			PackMultiplier: p.PackMultiplier,
			RequiredMin:    requiredMin,
			ProjectedSales: projectedSales,
			TotalIdeal:     totalIdeal,
			RecentSales:    sold,
			AvgDailySales:  avgDaily,
			Suggested:      totalIdeal,
			PurchasePrice:  p.PurchasePrice,
			SupplierID:     supplierID,
			Threshold:      criticalThreshold,
			Status:         status,
			BestSupplierID:   p.BestSupplierID,
			BestSupplierName: p.BestSupplierName,
			LowestPrice:      p.LowestPrice,
			IsHighRotation:   isHighRotation,
		})
	}

	sort.Slice(suggested, func(i, j int) bool {
		// Prioridad 1: Gravedad del Stock (Urgencia)
		statusPriority := map[StockStatus]int{StockCritical: 0, StockWarning: 1, StockOptimal: 2}
		if statusPriority[suggested[i].Status] != statusPriority[suggested[j].Status] {
			return statusPriority[suggested[i].Status] < statusPriority[suggested[j].Status]
		}
		
		// Prioridad 2: Productos sin proveedor (para Radar Global)
		if suggested[i].SupplierID == 0 && suggested[j].SupplierID != 0 {
			return true
		}
		if suggested[i].SupplierID != 0 && suggested[j].SupplierID == 0 {
			return false
		}
		
		// Prioridad 3: Orden Alfabético
		return suggested[i].ProductName < suggested[j].ProductName
	})

	return suggested, nil
}

func (s *InventoryService) GetSuggestedOrders(supplierID uint) ([]SuggestedOrder, error) {
	// Obtener productos filtrados por proveedor con info de mejor proveedor
	products, err := s.repo.GetProductsWithBestSupplier(&supplierID)
	if err != nil {
		return nil, err
	}

	if len(products) == 0 {
		return []SuggestedOrder{}, nil
	}

	barcodes := make([]string, len(products))
	for i, p := range products {
		barcodes[i] = p.Barcode
	}

	now := time.Now()
	fourteenDaysAgo := now.AddDate(0, 0, -14).Format("2006-01-02")
	todayStr := now.Format("2006-01-02")

	salesMap, err := s.saleRepo.GetSoldQuantitiesByBarcodes(barcodes, fourteenDaysAgo, todayStr)
	if err != nil {
		return nil, err
	}

	suggested := []SuggestedOrder{}
	for _, p := range products {
		sold := salesMap[p.Barcode]
		avgDaily := float64(sold) / 14.0
		avgDaily = math.Round(avgDaily*100) / 100

		const DIAS_COBERTURA = 15.0
		
		sugeridoBase := p.MinStock - p.Quantity
		stockProyectado := avgDaily * DIAS_COBERTURA
		sugeridoPorVentas := stockProyectado - p.Quantity

		// La Regla de Decisión: El pedido final es el MAYOR entre el sugerido por ventas y el sugerido base
		totalIdeal := math.Max(sugeridoBase, sugeridoPorVentas)
		isHighRotation := sugeridoPorVentas > sugeridoBase && totalIdeal > 0

		if totalIdeal <= 0 {
			totalIdeal = 0
		} else {
			// Redondeo hacia arriba
			totalIdeal = math.Ceil(totalIdeal)
			
			// Si es un pack, ajustar al multiplicador
			if p.IsPack && p.PackMultiplier > 1 {
				totalIdeal = math.Ceil(totalIdeal/float64(p.PackMultiplier)) * float64(p.PackMultiplier)
			}
		}

		requiredMin := math.Max(0, sugeridoBase)
		projectedSales := math.Max(0, sugeridoPorVentas)

		// REMOVED FILTER: Traer todo el catálogo activo

		// SPRINT HOTFIX: Lógica de Estado consistente
		var status StockStatus
		if p.MinStock <= 0 {
			if p.Quantity <= 0 {
				status = StockCritical
			} else if p.Quantity <= 2 {
				status = StockWarning
			} else {
				status = StockOptimal
			}
		} else {
			if p.Quantity <= (p.MinStock / 2) {
				status = StockCritical
			} else if p.Quantity <= p.MinStock {
				status = StockWarning
			} else {
				status = StockOptimal
			}
		}

		suggested = append(suggested, SuggestedOrder{
			Barcode:        p.Barcode,
			ProductName:    p.ProductName,
			Stock:          p.Quantity,
			MinStock:       p.MinStock,
			IsPack:         p.IsPack,
			PackMultiplier: p.PackMultiplier,
			RequiredMin:    requiredMin,
			ProjectedSales: projectedSales,
			TotalIdeal:     totalIdeal,
			RecentSales:    sold,
			AvgDailySales:  avgDaily,
			Suggested:      totalIdeal,
			PurchasePrice:  p.PurchasePrice,
			SupplierID:     supplierID,
			Threshold:      int(p.MinStock / 2),
			Status:         status,
			BestSupplierID:   p.BestSupplierID,
			BestSupplierName: p.BestSupplierName,
			LowestPrice:      p.LowestPrice,
			IsHighRotation:   isHighRotation,
		})
	}

	sort.Slice(suggested, func(i, j int) bool {
		// Prioridad 1: Estado de Stock (Urgencia)
		isLowI := suggested[i].Stock <= suggested[i].MinStock
		isLowJ := suggested[j].Stock <= suggested[j].MinStock
		
		if isLowI != isLowJ {
			return isLowI // Los que tienen bajo stock van primero (true < false en sort invertido)
		}

		// Prioridad 2: Sugerencia de la IA
		if suggested[i].Suggested != suggested[j].Suggested {
			return suggested[i].Suggested > suggested[j].Suggested
		}
		
		// Prioridad 3: Orden Alfabético
		return suggested[i].ProductName < suggested[j].ProductName
	})

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

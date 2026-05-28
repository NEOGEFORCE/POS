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
	Barcode          string      `json:"barcode"`
	ProductName      string      `json:"productName"`
	Stock            float64     `json:"stock"`
	MinStock         float64     `json:"minStock"`
	MinShelfStock    float64     `json:"minShelfStock"`
	IsPack           bool        `json:"isPack"`         // Modo Pack existente
	PackMultiplier   int         `json:"packMultiplier"` // Multiplicador del pack
	OrderMultiple    int         `json:"orderMultiple"`  // Alias para frontend (REQUERIDO)
	RequiredMin      float64     `json:"requiredMin"`    // Mínimo obligado (MinStock - Stock)
	ProjectedSales   float64     `json:"projectedSales"` // Proyección por ventas (TotalIdeal - RequiredMin)
	TotalIdeal       float64     `json:"totalIdeal"`     // Total ideal calculado (redondeado a PackMultiplier)
	RecentSales      float64     `json:"recentSales"`    // Last 14 days
	AvgDailySales    float64     `json:"avgDailySales"`  // Promedio venta diaria
	Suggested        float64     `json:"suggested"`      // Sugerencia final (igual a TotalIdeal)
	PurchasePrice    float64     `json:"purchasePrice"`
	SupplierID       uint        `json:"supplierId"` // 0 = sin proveedor asignado
	Threshold        int         `json:"threshold"`  // Umbral crítico calculado dinámicamente
	Status           StockStatus `json:"status"`     // CRITICAL, WARNING, OPTIMAL
	BestSupplierID   uint        `json:"bestSupplierId"`
	BestSupplierName string      `json:"bestSupplierName"`
	LowestPrice      float64     `json:"lowestPrice"`
	IsHighRotation   bool        `json:"isHighRotation"`
	Alert            string      `json:"alert"`
	AlertType        string      `json:"alertType"`
	Sales30d         float64     `json:"sales30d"`
	SuggestedMinStock float64    `json:"suggestedMinStock"`
	PendingOrderQty  float64     `json:"pendingOrderQty"`
	TransitDetail    string      `json:"transitDetail"`
}

type SupplierGroup struct {
	SupplierID   uint             `json:"supplierId"`
	SupplierName string           `json:"supplierName"`
	Items        []SuggestedOrder `json:"items"`
}

// CalculateSalesVelocity calcula el promedio de venta diaria para un producto
func (s *InventoryService) CalculateSalesVelocity(barcode string, days int) (float64, error) {
	if days <= 0 {
		days = 14
	}

	now := time.Now()
	startDate := now.AddDate(0, 0, -days)
	endDate := now

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
	fourteenDaysAgo := now.AddDate(0, 0, -14)
	thirtyDaysAgo := now.AddDate(0, 0, -30)

	salesMap, err := s.saleRepo.GetSoldQuantitiesByBarcodes(barcodes, fourteenDaysAgo, now)
	if err != nil {
		return nil, err
	}

	salesMap30d, err := s.saleRepo.GetSoldQuantitiesByBarcodes(barcodes, thirtyDaysAgo, now)
	if err != nil {
		return nil, err
	}

	transitQtyMap, transitSupplierMap, err := s.repo.GetPendingTransitQuantities()
	if err != nil {
		log.Printf("[InventoryService] Error en GetPendingTransitQuantities: %v", err)
		transitQtyMap = make(map[string]float64)
		transitSupplierMap = make(map[string]string)
	}

	suggested := []SuggestedOrder{}
	for _, p := range products {
		sold := salesMap[p.Barcode]
		sold30d := salesMap30d[p.Barcode]

		// Velocidad basada en 30 días para suavizar la tendencia
		avgDaily := float64(sold30d) / 30.0
		avgDaily = math.Round(avgDaily*100) / 100

		// --- LÓGICA DE SMART RESTOCK CON FALLBACKS ---
		diasCobertura := float64(p.VisitFrequencyDays)
		if diasCobertura <= 0 {
			diasCobertura = 30.0 // Fallback seguro de 1 mes
		}

		multiplo := float64(p.OrderMultiple)
		if multiplo <= 0 {
			multiplo = 1.0 // Evitar división por cero o anulaciones
		}
		
		pendingQty := transitQtyMap[p.Barcode]
		transitDetail := ""
		if pendingQty > 0 {
			supplierName := transitSupplierMap[p.Barcode]
			if supplierName == "" {
				supplierName = "Desconocido"
			}
			transitDetail = supplierName
		}

		effectiveStock := p.Quantity + pendingQty
		sugeridoBase := p.MinStock - effectiveStock
		stockRequeridoPorVentas := avgDaily * diasCobertura
		sugeridoPorVentas := stockRequeridoPorVentas - effectiveStock

		// La Regla de Decisión: si stock actual + tránsito >= min, NO sugerir.
		var deficit float64
		if effectiveStock >= p.MinStock {
			deficit = 0
		} else {
			deficit = math.Max(sugeridoBase, sugeridoPorVentas)
		}
		
		alert := ""
		alertType := ""

		// High-Mover check
		if p.Quantity <= 0 && avgDaily >= 0.3 {
			alert = "Aumentar pedido: Alta rotación"
			alertType = "HIGH_MOVER"
		}

		// Slow/High-Mover and Min Stock checks
		suggestedMinStock := p.MinStock
		if avgDaily * 14 > p.MinStock + 2 {
			alert = "Aumentar Stock Mínimo: Ventas altas"
			alertType = "INCREASE_MIN_STOCK"
			suggestedMinStock = math.Ceil(avgDaily * 14)
		} else if p.MinStock >= 10 && sold30d <= 1 {
			alert = "Reducir Stock Mínimo: Producto estancado"
			alertType = "SLOW_MOVER"
			deficit = 0
			if sold30d == 0 {
				suggestedMinStock = 2.0
			} else {
				suggestedMinStock = 3.0
			}
		}

		totalIdeal := 0.0
		if deficit > 0 {
			pacas := math.Ceil(deficit / multiplo)
			totalIdeal = pacas * multiplo
		}
		
		isHighRotation := (sugeridoPorVentas > sugeridoBase && totalIdeal > 0) || alertType == "HIGH_MOVER"

		requiredMin := math.Max(0, sugeridoBase)
		projectedSales := math.Max(0, sugeridoPorVentas)

		supplierID := uint(0)
		if p.SupplierID != nil {
			supplierID = *p.SupplierID
		}

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
			criticalThreshold := float64(GetCriticalThreshold(int(p.MinStock)))
			warningThreshold := math.Ceil(p.MinStock * 0.50)
			
			if p.Quantity <= criticalThreshold {
				status = StockCritical
			} else if p.Quantity <= warningThreshold {
				status = StockWarning
			} else {
				status = StockOptimal
			}
		}

		suggested = append(suggested, SuggestedOrder{
			Barcode:          p.Barcode,
			ProductName:      p.ProductName,
			Stock:            p.Quantity,
			MinStock:         p.MinStock,
			MinShelfStock:    p.MinShelfStock,
			IsPack:           p.IsPack,
			PackMultiplier:   p.PackMultiplier,
			OrderMultiple:    p.OrderMultiple,
			RequiredMin:      requiredMin,
			ProjectedSales:   projectedSales,
			TotalIdeal:       totalIdeal,
			RecentSales:      sold,
			AvgDailySales:    avgDaily,
			Suggested:        totalIdeal,
			PurchasePrice:    p.PurchasePrice,
			SupplierID:       supplierID,
			Threshold:        GetCriticalThreshold(int(p.MinStock)),
			Status:           status,
			BestSupplierID:   p.BestSupplierID,
			BestSupplierName: p.BestSupplierName,
			LowestPrice:      p.LowestPrice,
			IsHighRotation:   isHighRotation,
			Alert:            alert,
			AlertType:        alertType,
			Sales30d:         sold30d,
			SuggestedMinStock: suggestedMinStock,
			PendingOrderQty:  pendingQty,
			TransitDetail:    transitDetail,
		})
	}

	sort.Slice(suggested, func(i, j int) bool {
		statusPriority := map[StockStatus]int{StockCritical: 0, StockWarning: 1, StockOptimal: 2}
		if statusPriority[suggested[i].Status] != statusPriority[suggested[j].Status] {
			return statusPriority[suggested[i].Status] < statusPriority[suggested[j].Status]
		}
		if suggested[i].SupplierID == 0 && suggested[j].SupplierID != 0 {
			return true
		}
		if suggested[i].SupplierID != 0 && suggested[j].SupplierID == 0 {
			return false
		}
		return suggested[i].ProductName < suggested[j].ProductName
	})

	return suggested, nil
}

// GetGlobalRestockSuggestionsGrouped retorna las sugerencias agrupadas por proveedor
func (s *InventoryService) GetGlobalRestockSuggestionsGrouped() ([]SupplierGroup, error) {
	suggestions, err := s.GetGlobalRestockSuggestions()
	if err != nil {
		return nil, err
	}

	groupsMap := make(map[uint][]SuggestedOrder)
	supplierNames := make(map[uint]string)

	for _, item := range suggestions {
		targetID := item.BestSupplierID
		if targetID == 0 {
			targetID = item.SupplierID // Fallback
		}
		
		groupsMap[targetID] = append(groupsMap[targetID], item)
		if targetID != 0 {
			if item.BestSupplierName != "" {
				supplierNames[targetID] = item.BestSupplierName
			}
		}
	}

	var groups []SupplierGroup
	for id, items := range groupsMap {
		name := supplierNames[id]
		if id == 0 {
			name = "SIN PROVEEDOR"
		}
		groups = append(groups, SupplierGroup{
			SupplierID:   id,
			SupplierName: name,
			Items:        items,
		})
	}

	sort.Slice(groups, func(i, j int) bool {
		if groups[i].SupplierID == 0 && groups[j].SupplierID != 0 {
			return true
		}
		if groups[i].SupplierID != 0 && groups[j].SupplierID == 0 {
			return false
		}
		return groups[i].SupplierName < groups[j].SupplierName
	})

	return groups, nil
}

func (s *InventoryService) GetSuggestedOrders(supplierID uint) ([]SuggestedOrder, error) {
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
	fourteenDaysAgo := now.AddDate(0, 0, -14)
	thirtyDaysAgo := now.AddDate(0, 0, -30)

	salesMap, err := s.saleRepo.GetSoldQuantitiesByBarcodes(barcodes, fourteenDaysAgo, now)
	if err != nil {
		return nil, err
	}

	salesMap30d, err := s.saleRepo.GetSoldQuantitiesByBarcodes(barcodes, thirtyDaysAgo, now)
	if err != nil {
		return nil, err
	}

	transitQtyMap, transitSupplierMap, err := s.repo.GetPendingTransitQuantities()
	if err != nil {
		log.Printf("[InventoryService] Error en GetPendingTransitQuantities: %v", err)
		transitQtyMap = make(map[string]float64)
		transitSupplierMap = make(map[string]string)
	}

	suggested := []SuggestedOrder{}
	for _, p := range products {
		sold := salesMap[p.Barcode]
		sold30d := salesMap30d[p.Barcode]

		avgDaily := float64(sold30d) / 30.0
		avgDaily = math.Round(avgDaily*100) / 100

		diasCobertura := float64(p.VisitFrequencyDays)
		if diasCobertura <= 0 {
			diasCobertura = 30.0
		}

		multiplo := float64(p.OrderMultiple)
		if multiplo <= 0 {
			multiplo = 1.0
		}
		
		pendingQty := transitQtyMap[p.Barcode]
		transitDetail := ""
		if pendingQty > 0 {
			supplierName := transitSupplierMap[p.Barcode]
			if supplierName == "" {
				supplierName = "Desconocido"
			}
			transitDetail = supplierName
		}

		effectiveStock := p.Quantity + pendingQty
		sugeridoBase := p.MinStock - effectiveStock
		stockRequeridoPorVentas := avgDaily * diasCobertura
		sugeridoPorVentas := stockRequeridoPorVentas - effectiveStock

		deficit := math.Max(sugeridoBase, sugeridoPorVentas)
		
		alert := ""
		alertType := ""

		if p.Quantity <= 0 && avgDaily >= 0.3 {
			alert = "Aumentar pedido: Alta rotación"
			alertType = "HIGH_MOVER"
		}

		suggestedMinStock := p.MinStock
		if avgDaily * 14 > p.MinStock + 2 {
			alert = "Aumentar Stock Mínimo: Ventas altas"
			alertType = "INCREASE_MIN_STOCK"
			suggestedMinStock = math.Ceil(avgDaily * 14)
		} else if p.MinStock >= 10 && sold30d <= 1 {
			alert = "Reducir Stock Mínimo: Producto estancado"
			alertType = "SLOW_MOVER"
			deficit = 0
			if sold30d == 0 {
				suggestedMinStock = 2.0
			} else {
				suggestedMinStock = 3.0
			}
		}

		totalIdeal := 0.0
		if deficit > 0 {
			pacas := math.Ceil(deficit / multiplo)
			totalIdeal = pacas * multiplo
		}
		
		isHighRotation := (sugeridoPorVentas > sugeridoBase && totalIdeal > 0) || alertType == "HIGH_MOVER"

		requiredMin := math.Max(0, sugeridoBase)
		projectedSales := math.Max(0, sugeridoPorVentas)

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
			criticalThreshold := float64(GetCriticalThreshold(int(p.MinStock)))
			warningThreshold := math.Ceil(p.MinStock * 0.50)
			
			if p.Quantity <= criticalThreshold {
				status = StockCritical
			} else if p.Quantity <= warningThreshold {
				status = StockWarning
			} else {
				status = StockOptimal
			}
		}

		suggested = append(suggested, SuggestedOrder{
			Barcode:          p.Barcode,
			ProductName:      p.ProductName,
			Stock:            p.Quantity,
			MinStock:         p.MinStock,
			MinShelfStock:    p.MinShelfStock,
			IsPack:           p.IsPack,
			PackMultiplier:   p.PackMultiplier,
			OrderMultiple:    p.OrderMultiple,
			RequiredMin:      requiredMin,
			ProjectedSales:   projectedSales,
			TotalIdeal:       totalIdeal,
			RecentSales:      sold,
			AvgDailySales:    avgDaily,
			Suggested:        totalIdeal,
			PurchasePrice:    p.PurchasePrice,
			SupplierID:       supplierID,
			Threshold:        GetCriticalThreshold(int(p.MinStock)),
			Status:           status,
			BestSupplierID:   p.BestSupplierID,
			BestSupplierName: p.BestSupplierName,
			LowestPrice:      p.LowestPrice,
			IsHighRotation:   isHighRotation,
			Alert:            alert,
			AlertType:        alertType,
			Sales30d:         sold30d,
			SuggestedMinStock: suggestedMinStock,
			PendingOrderQty:  pendingQty,
			TransitDetail:    transitDetail,
		})
	}

	sort.Slice(suggested, func(i, j int) bool {
		isLowI := suggested[i].Stock <= suggested[i].MinStock
		isLowJ := suggested[j].Stock <= suggested[j].MinStock
		if isLowI != isLowJ {
			return isLowI
		}
		if suggested[i].Suggested != suggested[j].Suggested {
			return suggested[i].Suggested > suggested[j].Suggested
		}
		return suggested[i].ProductName < suggested[j].ProductName
	})

	return suggested, nil
}

func (s *InventoryService) GetInventory(from, to time.Time) ([]ports.InventoryStat, error) {
	stats, err := s.repo.GetInventoryStats(from, to)
	if err != nil {
		return nil, err
	}

	days := calculateDaysTime(from, to)

	for i := range stats {
		if days > 0 {
			avg := float64(stats[i].UnitsSold) / float64(days)
			stats[i].AvgSoldPerDay = math.Round(avg*100) / 100
		}
	}

	return stats, nil
}

func calculateDaysTime(start, end time.Time) int {
	diff := int(end.Sub(start).Hours()/24) + 1
	if diff < 1 {
		return 1
	}
	return diff
}

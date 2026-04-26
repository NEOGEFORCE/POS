package services

import (
	"fmt"
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
	log.Printf("[InventoryService] Iniciando GetGlobalRestockSuggestions...")

	// Obtener todos los productos con bajo stock o sin proveedor
	log.Printf("[InventoryService] Ejecutando GetAllWithLowStock()...")
	products, err := s.repo.GetAllWithLowStock()
	if err != nil {
		log.Printf("[InventoryService] SQL Error en GetAllWithLowStock: %v", err)
		return nil, fmt.Errorf("error en consulta SQL GetAllWithLowStock: %w", err)
	}
	log.Printf("[InventoryService] GetAllWithLowStock exitoso: %d productos encontrados", len(products))

	if len(products) == 0 {
		log.Printf("[InventoryService] No hay productos con bajo stock, retornando lista vacía")
		return []SuggestedOrder{}, nil
	}

	barcodes := make([]string, len(products))
	for i, p := range products {
		barcodes[i] = p.Barcode
		log.Printf("[InventoryService] Producto %d: barcode=%s, quantity=%.2f, minStock=%.2f, supplierId=%v",
			i, p.Barcode, p.Quantity, p.MinStock, p.SupplierID)
	}

	now := time.Now()
	fourteenDaysAgo := now.AddDate(0, 0, -14).Format("2006-01-02")
	todayStr := now.Format("2006-01-02")
	log.Printf("[InventoryService] Consultando ventas desde %s hasta %s", fourteenDaysAgo, todayStr)

	salesMap, err := s.saleRepo.GetSoldQuantitiesByBarcodes(barcodes, fourteenDaysAgo, todayStr)
	if err != nil {
		log.Printf("[InventoryService] Error en GetSoldQuantitiesByBarcodes: %v", err)
		return nil, fmt.Errorf("error consultando ventas: %w", err)
	}
	log.Printf("[InventoryService] Ventas consultadas: %d registros", len(salesMap))

	suggested := []SuggestedOrder{}
	erroredProducts := 0

	for i, p := range products {
		// Manejo de panic para productos individuales - no dejar que uno malo arruine todo
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[InventoryService] PANIC al procesar producto %s: %v", p.Barcode, r)
					erroredProducts++
				}
			}()

			sold := salesMap[p.Barcode]

			log.Printf("[InventoryService] Procesando producto %d/%d: %s (stock=%.2f, minStock=%.2f)",
				i+1, len(products), p.Barcode, p.Quantity, p.MinStock)

			// Calcular promedio de venta diaria (últimos 14 días)
			avgDaily := float64(sold) / 14.0
			avgDaily = math.Round(avgDaily*100) / 100

			// === ALGORITMO LIMPIO DE 5 PASOS (sin SafetyStock, usando Modo Pack existente) ===
			daysCoverage := 7.0
			leadTime := 0.0 // Simplificado para Radar Global

			// PASO 1: Mínimo Obligado (garantía de stock mínimo)
			requiredMin := math.Max(0, p.MinStock-p.Quantity)

			// PASO 2: Total Crudo (fórmula maestra sin safety stock)
			rawTotal := (avgDaily * (daysCoverage + leadTime)) - p.Quantity

			// PASO 3: Freno/Garantía (el mayor entre mínimo y proyección)
			baseTotal := math.Max(requiredMin, rawTotal)

			// PASO 4: Redondeo por Modo Pack (usando campos preexistentes)
			totalIdeal := baseTotal
			if p.IsPack && p.PackMultiplier > 1 && baseTotal > 0 {
				// Redondear hacia arriba al múltiplo del PackMultiplier
				totalIdeal = math.Ceil(baseTotal/float64(p.PackMultiplier)) * float64(p.PackMultiplier)
			}

			// PASO 5: Asignación de valores de transparencia
			projectedSales := totalIdeal - requiredMin

			// Asegurar que no sugiera cantidades negativas
			if totalIdeal < 0 {
				totalIdeal = 0
				projectedSales = 0
			}

			// Marcar productos sin proveedor
			supplierID := uint(0)
			if p.SupplierID != nil {
				supplierID = *p.SupplierID
			}

			// Calcular umbral crítico dinámicamente (FUENTE DE VERDAD)
			minStock := int(p.MinStock)
			if minStock <= 0 {
				minStock = 5
			}
			criticalThreshold := GetCriticalThreshold(minStock)

			// Determinar estado del producto
			var status StockStatus
			if int(p.Quantity) <= criticalThreshold {
				status = StockCritical
			} else if int(p.Quantity) <= minStock {
				status = StockWarning
			} else {
				status = StockOptimal
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
			})
		}()
	}

	if erroredProducts > 0 {
		log.Printf("[InventoryService] %d productos tuvieron errores y fueron omitidos", erroredProducts)
	}

	// Ordenar por urgencia: CRÍTICO > WARNING > OPTIMAL, luego por stock menor
	sort.Slice(suggested, func(i, j int) bool {
		// Prioridad 1: Estado de urgencia (CRITICAL primero, luego WARNING, luego OPTIMAL)
		statusPriority := map[StockStatus]int{StockCritical: 0, StockWarning: 1, StockOptimal: 2}
		if statusPriority[suggested[i].Status] != statusPriority[suggested[j].Status] {
			return statusPriority[suggested[i].Status] < statusPriority[suggested[j].Status]
		}

		// Prioridad 2: Sin proveedor va antes que con proveedor
		if suggested[i].SupplierID == 0 && suggested[j].SupplierID != 0 {
			return true
		}
		if suggested[i].SupplierID != 0 && suggested[j].SupplierID == 0 {
			return false
		}

		// Prioridad 3: Stock de menor a mayor
		return suggested[i].Stock < suggested[j].Stock
	})

	return suggested, nil
}

func (s *InventoryService) GetSuggestedOrders(supplierID uint) ([]SuggestedOrder, error) {
	products, err := s.repo.GetBySupplier(supplierID)
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

		// Calcular promedio de venta diaria (últimos 14 días)
		avgDaily := float64(sold) / 14.0
		avgDaily = math.Round(avgDaily*100) / 100

		// === ALGORITMO LIMPIO DE 5 PASOS (sin SafetyStock, usando Modo Pack existente) ===
		daysCoverage := 7.0
		leadTime := 0.0 // Simplificado, se puede extender con lógica de método de abastecimiento

		// PASO 1: Mínimo Obligado (garantía de stock mínimo)
		requiredMin := math.Max(0, p.MinStock-p.Quantity)

		// PASO 2: Total Crudo (fórmula maestra sin safety stock)
		rawTotal := (avgDaily * (daysCoverage + leadTime)) - p.Quantity

		// PASO 3: Freno/Garantía (el mayor entre mínimo y proyección)
		baseTotal := math.Max(requiredMin, rawTotal)

		// PASO 4: Redondeo por Modo Pack (usando campos preexistentes)
		totalIdeal := baseTotal
		if p.IsPack && p.PackMultiplier > 1 && baseTotal > 0 {
			// Redondear hacia arriba al múltiplo del PackMultiplier
			totalIdeal = math.Ceil(baseTotal/float64(p.PackMultiplier)) * float64(p.PackMultiplier)
		}

		// PASO 5: Asignación de valores de transparencia
		projectedSales := totalIdeal - requiredMin

		// Asegurar que no sugiera cantidades negativas
		if totalIdeal < 0 {
			totalIdeal = 0
			projectedSales = 0
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
		})
	}

	// Ordenar por stock de menor a mayor (para priorizar productos más críticos)
	sort.Slice(suggested, func(i, j int) bool {
		return suggested[i].Stock < suggested[j].Stock
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

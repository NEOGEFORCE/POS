package services

import (
	"fmt"
	"log"
	"math"
	"sort"
	"time"

	"backPOS-go/internal/core/domain/models"
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
	Barcode           string      `json:"barcode"`
	ProductName       string      `json:"productName"`
	Stock             float64     `json:"stock"`
	MinStock          float64     `json:"minStock"`
	MinShelfStock     float64     `json:"minShelfStock"`
	IsPack            bool        `json:"isPack"`         // Modo Pack existente
	PackMultiplier    int         `json:"packMultiplier"` // Multiplicador del pack
	OrderMultiple     int         `json:"orderMultiple"`  // Alias para frontend (REQUERIDO)
	RequiredMin       float64     `json:"requiredMin"`    // Piso para salir del rojo (25% del min - stock - transito, ceileado). Bajo la regla del duenio (agosto 2026) el minimo NO es meta.
	ProjectedSales    float64     `json:"projectedSales"` // Proyección por ventas (avgDaily * diasCobertura - effectiveStock)
	TotalIdeal        float64     `json:"totalIdeal"`     // Total ideal calculado (redondeado a PackMultiplier)
	RecentSales       float64     `json:"recentSales"`    // Last 14 days
	AvgDailySales     float64     `json:"avgDailySales"`  // Promedio venta diaria
	Suggested         float64     `json:"suggested"`      // Sugerencia final (igual a TotalIdeal)
	PurchasePrice     float64     `json:"purchasePrice"`
	SupplierID        uint        `json:"supplierId"` // 0 = sin proveedor asignado
	Threshold         int         `json:"threshold"`  // Umbral crítico calculado dinámicamente
	Status            StockStatus `json:"status"`     // CRITICAL, WARNING, OPTIMAL
	BestSupplierID    uint        `json:"bestSupplierId"`
	BestSupplierName  string      `json:"bestSupplierName"`
	LowestPrice       float64     `json:"lowestPrice"`
	IsHighRotation    bool        `json:"isHighRotation"`
	Alert             string      `json:"alert"`
	AlertType         string      `json:"alertType"`
	Sales30d          float64     `json:"sales30d"`
	SuggestedMinStock float64     `json:"suggestedMinStock"`
	PendingOrderQty   float64     `json:"pendingOrderQty"`
	TransitDetail     string      `json:"transitDetail"`
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

// GetGlobalRestockSuggestions retorna todas las sugerencias de restock (Smart Sourcing)
func (s *InventoryService) GetGlobalRestockSuggestions(ignoreStock bool) ([]SuggestedOrder, error) {
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

	salesMap, salesMap30d, err := s.saleRepo.GetSoldQuantitiesByBarcodesForWindows(barcodes, fourteenDaysAgo, thirtyDaysAgo, now)
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
		stockRequeridoPorVentas := avgDaily * diasCobertura
		sugeridoPorVentas := stockRequeridoPorVentas - effectiveStock

		// Regla nueva del dueno (agosto 2026): el minimo es alarma, NO meta.
		// Prohibido llenar hasta el 100% del minimo — encarece el pedido.
		// La cantidad a pedir es el MAYOR de:
		//   (a) POR DEMANDA: demanda hasta la proxima visita menos lo
		//       disponible (stock + transito). No usa colchon ABC porque
		//       este servicio no clasifica ABC; el batch nocturno si lo
		//       hace y alimenta /restock/suggestions-v2. Aca se pasa "" y
		//       se toma la rama de demanda con el ideal ya calculado.
		//   (b) PISO PARA SALIR DEL ROJO: solo si la banda es ROJA, lo que
		//       falta para llegar al 25% del minimo. En amarillo/verde NO
		//       existe. El helper vive en models.RedFloorShortfall.
		// La funcion canonica que combina ambas cosas es
		// models.SuggestedOrderQty; usarla aca en vez de duplicar la logica
		// mata la divergencia entre este endpoint y /restock/suggestions-v2.
		deficit := models.SuggestedOrderQty(stockRequeridoPorVentas, p.Quantity, pendingQty, p.MinStock, "")
		redFloor := models.RedFloorShortfall(p.MinStock, p.Quantity, pendingQty)

		// Filtro temprano: si no hay nada que pedir (demanda cubierta y
		// banda no roja) y tampoco viene mercancia, no se emite item.
		// El caso `ignoreStock=true` deja pasar todo para que el operador
		// pueda revisar el catalogo completo.
		if !ignoreStock && deficit <= 0 && pendingQty <= 0 {
			continue
		}

		alert := ""
		alertType := ""

		// High-Mover check
		if p.Quantity <= 0 && avgDaily >= 0.3 {
			alert = "Aumentar pedido: Alta rotación"
			alertType = "HIGH_MOVER"
		}

		// Slow/High-Mover and Min Stock checks. Estas heuristicas SUGIEREN
		// un nuevo minimo al operador; NUNCA lo escriben (regla permanente,
		// vigilada por TestNoAutoWriteToMinStock).
		suggestedMinStock := p.MinStock
		if avgDaily*14 > p.MinStock+2 {
			suggestedMinStock = math.Ceil(avgDaily * 14)
			alert = fmt.Sprintf("Aumentar min. a %.0f: Ventas altas", suggestedMinStock)
			alertType = "INCREASE_MIN_STOCK"
		} else if p.MinStock >= 10 && sold30d <= 1 {
			if sold30d == 0 {
				suggestedMinStock = 2.0
			} else {
				suggestedMinStock = 3.0
			}
			alert = fmt.Sprintf("Reducir min. a %.0f: Estancado", suggestedMinStock)
			alertType = "SLOW_MOVER"
			deficit = 0
		}

		totalIdeal := 0.0
		if deficit > 0 {
			pacas := math.Ceil(deficit / multiplo)
			totalIdeal = pacas * multiplo
		}

		// Si no hay deficit (totalIdeal <= 0) y no hay pedido en transito, se ignora la sugerencia
		if totalIdeal <= 0 && pendingQty <= 0 {
			continue
		}

		// "Alta rotacion" bajo la regla nueva: el pedido calculado supera
		// al piso rojo Y la demanda proyectada supera al piso rojo. Es
		// decir: no estamos pidiendo solo para salir del rojo, la demanda
		// ya justifica pedir mas por si sola.
		isHighRotation := (totalIdeal > redFloor && sugeridoPorVentas > redFloor) || alertType == "HIGH_MOVER" || alertType == "INCREASE_MIN_STOCK"

		if alert == "" {
			if isHighRotation && totalIdeal > 0 {
				alert = fmt.Sprintf("Aumentado a %.0f: Ventas altas", totalIdeal)
				alertType = "HIGH_MOVER"
			} else if totalIdeal > 0 {
				alert = fmt.Sprintf("Sugerido pedir %.0f unid.", totalIdeal)
				alertType = "SUGGESTED_ORDER"
			}
		}

		// requiredMin (JSON field) ahora expone el piso "salir del rojo":
		// cuanto falta para llegar al 25% del minimo. Bajo la regla nueva
		// esa es la unica cantidad "obligada" contra el minimo — el minimo
		// entero ya no manda. Ver models.RedFloorShortfall.
		requiredMin := redFloor
		projectedSales := math.Max(0, sugeridoPorVentas)

		supplierID := uint(0)
		if p.SupplierID != nil {
			supplierID = *p.SupplierID
		}

		// Banda del semaforo con la regla nueva del dueno (agosto 2026):
		// ROJO < 25% del minimo, AMARILLO 25%–75%, VERDE >= 75%. La logica
		// canonica vive en models.ClassifyStockBand para que no se repita
		// aca ni en la SQL de stats. StockCritical/Warning/Optimal son los
		// nombres historicos que este endpoint sigue emitiendo por
		// compatibilidad con el frontend.
		var status StockStatus
		switch models.ClassifyStockBand(p.Quantity, p.MinStock) {
		case models.StockBandRed:
			status = StockCritical
		case models.StockBandYellow:
			status = StockWarning
		default:
			// StockBandGreen y StockBandUnset -> Optimal.
			status = StockOptimal
		}

		suggested = append(suggested, SuggestedOrder{
			Barcode:           p.Barcode,
			ProductName:       p.ProductName,
			Stock:             p.Quantity,
			MinStock:          p.MinStock,
			MinShelfStock:     p.MinShelfStock,
			IsPack:            p.IsPack,
			PackMultiplier:    p.PackMultiplier,
			OrderMultiple:     p.OrderMultiple,
			RequiredMin:       requiredMin,
			ProjectedSales:    projectedSales,
			TotalIdeal:        totalIdeal,
			RecentSales:       sold,
			AvgDailySales:     avgDaily,
			Suggested:         totalIdeal,
			PurchasePrice:     p.PurchasePrice,
			SupplierID:        supplierID,
			Threshold:         GetCriticalThreshold(int(p.MinStock)),
			Status:            status,
			BestSupplierID:    p.BestSupplierID,
			BestSupplierName:  p.BestSupplierName,
			LowestPrice:       p.LowestPrice,
			IsHighRotation:    isHighRotation,
			Alert:             alert,
			AlertType:         alertType,
			Sales30d:          sold30d,
			SuggestedMinStock: suggestedMinStock,
			PendingOrderQty:   pendingQty,
			TransitDetail:     transitDetail,
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
func (s *InventoryService) GetGlobalRestockSuggestionsGrouped(ignoreStock bool) ([]SupplierGroup, error) {
	suggestions, err := s.GetGlobalRestockSuggestions(ignoreStock)
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

	groups := make([]SupplierGroup, 0)
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

// GetSuggestedOrders retorna las sugerencias para un proveedor especifico
func (s *InventoryService) GetSuggestedOrders(supplierID uint, ignoreStock bool) ([]SuggestedOrder, error) {
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

	salesMap, salesMap30d, err := s.saleRepo.GetSoldQuantitiesByBarcodesForWindows(barcodes, fourteenDaysAgo, thirtyDaysAgo, now)
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
		stockRequeridoPorVentas := avgDaily * diasCobertura
		sugeridoPorVentas := stockRequeridoPorVentas - effectiveStock

		// Regla nueva del dueno (agosto 2026): mismo helper compartido que
		// GetGlobalRestockSuggestions y /restock/suggestions-v2 para que
		// los tres endpoints jamas divergan sobre "cuanto se pide". El
		// minimo es alarma, NO meta: solo salir del rojo (25% del min) y
		// demanda hasta la proxima visita.
		deficit := models.SuggestedOrderQty(stockRequeridoPorVentas, p.Quantity, pendingQty, p.MinStock, "")
		redFloor := models.RedFloorShortfall(p.MinStock, p.Quantity, pendingQty)

		if !ignoreStock && deficit <= 0 && pendingQty <= 0 {
			continue
		}

		alert := ""
		alertType := ""

		if p.Quantity <= 0 && avgDaily >= 0.3 {
			alert = "Aumentar pedido: Alta rotación"
			alertType = "HIGH_MOVER"
		}

		suggestedMinStock := p.MinStock
		if avgDaily*14 > p.MinStock+2 {
			suggestedMinStock = math.Ceil(avgDaily * 14)
			alert = fmt.Sprintf("Aumentar min. a %.0f: Ventas altas", suggestedMinStock)
			alertType = "INCREASE_MIN_STOCK"
		} else if p.MinStock >= 10 && sold30d <= 1 {
			if sold30d == 0 {
				suggestedMinStock = 2.0
			} else {
				suggestedMinStock = 3.0
			}
			alert = fmt.Sprintf("Reducir min. a %.0f: Estancado", suggestedMinStock)
			alertType = "SLOW_MOVER"
			deficit = 0
		}

		totalIdeal := 0.0
		if deficit > 0 {
			pacas := math.Ceil(deficit / multiplo)
			totalIdeal = pacas * multiplo
		}

		// Si no hay deficit (totalIdeal <= 0) y no hay pedido en transito, se ignora la sugerencia
		if totalIdeal <= 0 && pendingQty <= 0 {
			continue
		}

		isHighRotation := (totalIdeal > redFloor && sugeridoPorVentas > redFloor) || alertType == "HIGH_MOVER" || alertType == "INCREASE_MIN_STOCK"

		if alert == "" {
			if isHighRotation && totalIdeal > 0 {
				alert = fmt.Sprintf("Aumentado a %.0f: Ventas altas", totalIdeal)
				alertType = "HIGH_MOVER"
			} else if totalIdeal > 0 {
				alert = fmt.Sprintf("Sugerido pedir %.0f unid.", totalIdeal)
				alertType = "SUGGESTED_ORDER"
			}
		}

		// requiredMin (JSON field) = piso "salir del rojo" bajo la regla
		// nueva. Nunca "MinStock - Stock".
		requiredMin := redFloor
		projectedSales := math.Max(0, sugeridoPorVentas)

		// Misma regla que arriba: banda ROJO/AMARILLO/VERDE contra el minimo
		// configurado, delegada a models.ClassifyStockBand.
		var status StockStatus
		switch models.ClassifyStockBand(p.Quantity, p.MinStock) {
		case models.StockBandRed:
			status = StockCritical
		case models.StockBandYellow:
			status = StockWarning
		default:
			status = StockOptimal
		}

		suggested = append(suggested, SuggestedOrder{
			Barcode:           p.Barcode,
			ProductName:       p.ProductName,
			Stock:             p.Quantity,
			MinStock:          p.MinStock,
			MinShelfStock:     p.MinShelfStock,
			IsPack:            p.IsPack,
			PackMultiplier:    p.PackMultiplier,
			OrderMultiple:     p.OrderMultiple,
			RequiredMin:       requiredMin,
			ProjectedSales:    projectedSales,
			TotalIdeal:        totalIdeal,
			RecentSales:       sold,
			AvgDailySales:     avgDaily,
			Suggested:         totalIdeal,
			PurchasePrice:     p.PurchasePrice,
			SupplierID:        supplierID,
			Threshold:         GetCriticalThreshold(int(p.MinStock)),
			Status:            status,
			BestSupplierID:    p.BestSupplierID,
			BestSupplierName:  p.BestSupplierName,
			LowestPrice:       p.LowestPrice,
			IsHighRotation:    isHighRotation,
			Alert:             alert,
			AlertType:         alertType,
			Sales30d:          sold30d,
			SuggestedMinStock: suggestedMinStock,
			PendingOrderQty:   pendingQty,
			TransitDetail:     transitDetail,
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

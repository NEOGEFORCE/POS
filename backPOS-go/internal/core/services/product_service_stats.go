package services

	// no imports needed besides standard ones if any, but since we use nothing external, just the package is fine

func (s *ProductService) GetProductStats() (map[string]interface{}, error) {
	products, err := s.repo.GetAll()
	if err != nil {
		return nil, err
	}

	var totalCost, totalRetail float64
	var criticalStock, warningStock int
	totalItems := 0

	for _, p := range products {
		// Solo productos activos. El dashboard filtra por isActive en su
		// consulta (GetGlobalInventoryValue) y aqui no se filtraba, asi que las
		// dos vistas daban valores distintos del mismo inventario.
		if !p.IsActive {
			continue
		}
		totalItems++

		totalCost += p.Quantity * p.PurchasePrice
		totalRetail += p.Quantity * p.SalePrice

		effectiveStock := p.Quantity
		var percentage float64
		if p.MinStock > 0 {
			percentage = (effectiveStock / p.MinStock) * 100
		}

		status := "OPTIMAL"
		if p.MinStock <= 0 {
			if effectiveStock <= 0 {
				status = "CRITICAL"
			}
		} else {
			if percentage <= 20 {
				status = "CRITICAL"
			} else if percentage <= 50 {
				status = "WARNING"
			}
		}

		if status == "CRITICAL" {
			criticalStock++
		} else if status == "WARNING" {
			warningStock++
		}
	}

	return map[string]interface{}{
		"totalCost":     totalCost,
		"totalRetail":   totalRetail,
		"criticalStock": criticalStock,
		"warningStock":  warningStock,
		"totalItems":    totalItems,
	}, nil
}

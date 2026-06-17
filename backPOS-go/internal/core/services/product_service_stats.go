package services

	// no imports needed besides standard ones if any, but since we use nothing external, just the package is fine

func (s *ProductService) GetProductStats() (map[string]interface{}, error) {
	products, err := s.repo.GetAll()
	if err != nil {
		return nil, err
	}

	var totalCost, totalRetail float64
	var criticalStock, warningStock int
	totalItems := len(products)

	for _, p := range products {
		if !p.IsWeighted {
			totalCost += p.Quantity * p.PurchasePrice
			totalRetail += p.Quantity * p.SalePrice
		}

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

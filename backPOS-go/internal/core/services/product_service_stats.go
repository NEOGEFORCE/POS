package services

// GetProductStats devuelve el resumen del catálogo (costo total del
// inventario, precio de venta total, cantidad de productos activos y
// contadores por severidad de stock).
//
// Antes recorría todo el catálogo en un bucle Go tras un GetAll() con Preload
// y ORDER BY sobre 2168 filas. Ahora delega en una sola consulta agregada del
// repositorio (ver postgres_product_stats.go). La clasificación crítico /
// advertencia se replica EXACTAMENTE del bucle antiguo (ver ClassifyStockHealth
// y su test de tabla en stock_health_test.go), incluyendo el caso minStock<=0.
func (s *ProductService) GetProductStats() (map[string]interface{}, error) {
	totalCost, totalRetail, totalItems, criticalStock, warningStock, err := s.repo.GetProductStatsAggregate()
	if err != nil {
		return nil, err
	}
	agg := ProductStatsAggregate{
		TotalCost:     totalCost,
		TotalRetail:   totalRetail,
		TotalItems:    totalItems,
		CriticalStock: criticalStock,
		WarningStock:  warningStock,
	}
	return agg.AsMap(), nil
}

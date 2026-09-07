package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"fmt"
	"time"
)

// GetProductStatsAggregate calcula en UNA sola consulta el resumen del
// catálogo activo (costo total, precio de venta total, número de productos y
// cuántos están en estado crítico / advertencia). Reemplaza el bucle en Go
// sobre repo.GetAll(), que arrastraba el catálogo completo con Preload y
// ORDER BY cada vez que la caché estaba fría.
//
// IMPORTANTE: las expresiones CASE reproducen EXACTAMENTE la clasificación
// de models.ClassifyStockBand (ver internal/core/domain/models/stock_health.go
// y su test de tabla). Regla permanente del dueño (agosto 2026):
// ROJO < 25% del mínimo, AMARILLO 25%–75%, VERDE >= 75%. Una divergencia
// daría cifras distintas y sería un bug, no una optimización.
//
// El agregado sigue devolviendo solo dos columnas (critical / warning). Bajo
// la regla nueva "warning" es la banda AMARILLA completa (25%–75%); la banda
// VERDE se puede derivar en el frontend como (totalItems - critical - warning).
// No se inventa una columna nueva porque el JSON existente ya sirve.
func (r *PostgresProductRepository) GetProductStatsAggregate() (float64, float64, int64, int64, int64, error) {
	type row struct {
		TotalCost     float64 `gorm:"column:total_cost"`
		TotalRetail   float64 `gorm:"column:total_retail"`
		TotalItems    int64   `gorm:"column:total_items"`
		CriticalStock int64   `gorm:"column:critical_stock"`
		WarningStock  int64   `gorm:"column:warning_stock"`
	}
	var r0 row
	// COALESCE("minStock", 0) protege contra NULL histórico. NULLIF evita
	// división por cero en el ratio. FILTER es más legible que SUM(CASE)
	// para el conteo.
	err := r.db.Raw(`
		SELECT
			COALESCE(SUM(quantity * "purchasePrice"), 0)::numeric AS total_cost,
			COALESCE(SUM(quantity * "salePrice"), 0)::numeric     AS total_retail,
			COUNT(*)::bigint                                       AS total_items,
			COUNT(*) FILTER (
				WHERE (COALESCE("minStock", 0) <= 0 AND quantity <= 0)
				   OR (COALESCE("minStock", 0) > 0
				       AND (quantity / NULLIF("minStock", 0)) < 0.25)
			)::bigint AS critical_stock,
			COUNT(*) FILTER (
				WHERE COALESCE("minStock", 0) > 0
				  AND (quantity / NULLIF("minStock", 0)) >= 0.25
				  AND (quantity / NULLIF("minStock", 0)) < 0.75
			)::bigint AS warning_stock
		FROM products
		WHERE COALESCE("isActive", TRUE) = TRUE
		  AND deleted_at IS NULL
	`).Scan(&r0).Error
	if err != nil {
		return 0, 0, 0, 0, 0, err
	}
	return r0.TotalCost, r0.TotalRetail, r0.TotalItems, r0.CriticalStock, r0.WarningStock, nil
}
func (r *PostgresProductRepository) GetInventoryStats(from, to time.Time) ([]ports.InventoryStat, error) {
	var stats []ports.InventoryStat

	query := r.db.Table("products").
		Select("products.barcode, products.\"productName\", products.\"categoryId\", categories.name as category_name, products.\"salePrice\", products.\"purchasePrice\", products.quantity as stock, COALESCE(SUM(sale_details.quantity), 0) as units_sold, COALESCE(SUM(sale_details.subtotal), 0) as total_revenue").
		Joins("left join categories on categories.id = products.\"categoryId\"").
		Joins("left join sale_details on sale_details.barcode = products.barcode").
		Joins("left join sales on sales.\"saleId\" = sale_details.\"saleId\"")

	if !from.IsZero() {
		query = query.Where("sales.\"saleDate\" >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("sales.\"saleDate\" <= ?", to)
	}

	err := query.Group("products.barcode, products.\"productName\", products.\"categoryId\", categories.name, products.\"salePrice\", products.\"purchasePrice\", products.quantity").
		Scan(&stats).Error

	if err != nil {
		return nil, err
	}

	for i, s := range stats {
		stats[i].TotalCost = float64(s.UnitsSold) * s.PurchasePrice
		stats[i].GrossMargin = s.TotalRevenue - stats[i].TotalCost
	}

	return stats, nil
}

// GetSavingsOpportunities identifica productos que pueden ser comprados a menor costo según el histórico de proveedores
func (r *PostgresProductRepository) GetSavingsOpportunities() ([]ports.SavingsOpportunity, error) {
	var opportunities []ports.SavingsOpportunity

	query := `
		WITH SupplierStats AS (
			SELECT
				product_barcode,
				COUNT(supplier_id) as supplier_count,
				MIN("purchasePrice") as min_price,
				MAX("purchasePrice") as max_price
			FROM product_suppliers
			WHERE "purchasePrice" > 0
			GROUP BY product_barcode
			HAVING COUNT(supplier_id) >= 2
		),
		BestWorst AS (
			SELECT 
				ss.product_barcode,
				ss.min_price,
				ss.max_price,
				(SELECT s.name FROM product_suppliers ps JOIN suppliers s ON ps.supplier_id = s.id WHERE ps.product_barcode = ss.product_barcode AND ps."purchasePrice" = ss.min_price LIMIT 1) as best_supplier,
				(SELECT s.name FROM product_suppliers ps JOIN suppliers s ON ps.supplier_id = s.id WHERE ps.product_barcode = ss.product_barcode AND ps."purchasePrice" = ss.max_price LIMIT 1) as worst_supplier
			FROM SupplierStats ss
			WHERE ss.max_price > ss.min_price
		)
		SELECT 
			p.barcode, 
			p."productName", 
			p."purchasePrice", 
			p.quantity, 
			bw.min_price, 
			bw.best_supplier, 
			bw.max_price, 
			bw.worst_supplier,
			(bw.max_price - bw.min_price) as potential_save
		FROM products p
		JOIN BestWorst bw ON p.barcode = bw.product_barcode
		WHERE p."isActive" = true
		ORDER BY (bw.max_price - bw.min_price) DESC
		LIMIT 20
	`

	rows, err := r.db.Raw(query).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var o ports.SavingsOpportunity
		if err := rows.Scan(&o.Barcode, &o.ProductName, &o.CurrentPrice, &o.Stock, &o.BestPrice, &o.BestSupplier, &o.WorstPrice, &o.WorstSupplier, &o.PotentialSave); err != nil {
			return nil, err
		}
		opportunities = append(opportunities, o)
	}

	return opportunities, nil
}

func (r *PostgresProductRepository) GetAllWithLowStock() ([]models.Product, error) {
	var products []models.Product

	// Filtrar solo productos con stock igual o inferior a su mínimo (o stock <= 5 como salvaguarda), limitado a los 100 más críticos
	err := r.db.
		Where("\"isActive\" = true AND (quantity <= \"minStock\" OR quantity <= 5)").
		Order("\"quantity\" ASC").
		Limit(100).
		Find(&products).Error

	if err != nil {
		return nil, fmt.Errorf("error SQL en GetAllWithLowStock: %w", err)
	}

	return products, nil
}

// GetProductsWithBestSupplier - Obtiene productos y su mejor opción de proveedor inyectada
func (r *PostgresProductRepository) GetProductsWithBestSupplier(supplierID *uint) ([]ports.ProductRestockInfo, error) {
	var results []ports.ProductRestockInfo

	query := r.db.Model(&models.Product{}).
		Select(`products.*, 
			bs.best_supplier_id, 
			bs.best_supplier_name, 
			bs.lowest_price,
			ws.worst_supplier_name,
			ws.worst_price,
			bs.visit_frequency_days`).
		Joins(`LEFT JOIN (
			SELECT 
				ps.product_barcode, 
				ps.supplier_id as best_supplier_id, 
				s.name as best_supplier_name, 
				ps."purchasePrice" as lowest_price,
				s.visit_frequency_days,
				ROW_NUMBER() OVER(PARTITION BY ps.product_barcode ORDER BY ps."purchasePrice" ASC) as rn
			FROM product_suppliers ps
			JOIN suppliers s ON ps.supplier_id = s.id
		) bs ON products.barcode = bs.product_barcode AND bs.rn = 1`).
		Joins(`LEFT JOIN (
			SELECT 
				ps.product_barcode, 
				s.name as worst_supplier_name, 
				ps."purchasePrice" as worst_price,
				ROW_NUMBER() OVER(PARTITION BY ps.product_barcode ORDER BY ps."purchasePrice" DESC) as rn
			FROM product_suppliers ps
			JOIN suppliers s ON ps.supplier_id = s.id
		) ws ON products.barcode = ws.product_barcode AND ws.rn = 1`).
		Where("products.\"isActive\" = ?", true)

	if supplierID != nil {
		query = query.Where(`(
			products.barcode IN (SELECT product_barcode FROM product_suppliers WHERE supplier_id = ?) 
			OR products."supplierId" = ?
		)`, *supplierID, *supplierID)
	}

	err := query.Order("products.quantity ASC").Scan(&results).Error
	return results, err
}

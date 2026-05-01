package repositories

import (
	"fmt"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

// GetInventoryStats genera un reporte detallado de rotación, costos y rentabilidad por producto
func (r *PostgresProductRepository) GetInventoryStats(from, to string) ([]ports.InventoryStat, error) {
	var stats []ports.InventoryStat

	query := r.db.Table("products").
		Select("products.barcode, products.\"productName\", products.\"categoryId\", categories.name as category_name, products.\"salePrice\", products.\"purchasePrice\", products.quantity as stock, COALESCE(SUM(sale_details.quantity), 0) as units_sold, COALESCE(SUM(sale_details.subtotal), 0) as total_revenue").
		Joins("left join categories on categories.id = products.\"categoryId\"").
		Joins("left join sale_details on sale_details.barcode = products.barcode").
		Joins("left join sales on sales.\"saleId\" = sale_details.\"saleId\"")

	if from != "" {
		query = query.Where("sales.\"saleDate\" >= ?", from)
	}
	if to != "" {
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
		WITH RankedSuppliers AS (
			SELECT
				p.barcode,
				p."productName" as product_name,
				p."purchasePrice" as current_price,
				p."quantity" as stock,
				ps."purchasePrice" as best_price,
				s.name as best_supplier,
				(p."purchasePrice" - ps."purchasePrice") * p."quantity" as potential_save,
				ROW_NUMBER() OVER(PARTITION BY p.barcode ORDER BY ps."purchasePrice" ASC) as rn
			FROM products p
			JOIN product_suppliers ps ON p.barcode = ps."productBarcode"
			JOIN suppliers s ON ps."supplierId" = s.id
			WHERE ps."purchasePrice" < p."purchasePrice"
			AND p."quantity" > 0
		)
		SELECT barcode, product_name, current_price, stock, best_price, best_supplier, potential_save
		FROM RankedSuppliers
		WHERE rn = 1
		ORDER BY potential_save DESC
		LIMIT 20
	`

	rows, err := r.db.Raw(query).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var o ports.SavingsOpportunity
		if err := rows.Scan(&o.Barcode, &o.ProductName, &o.CurrentPrice, &o.Stock, &o.BestPrice, &o.BestSupplier, &o.PotentialSave); err != nil {
			return nil, err
		}
		opportunities = append(opportunities, o)
	}

	return opportunities, nil
}

func (r *PostgresProductRepository) GetAllWithLowStock() ([]models.Product, error) {
	var products []models.Product

	// Devolver todos los productos activos para que el usuario pueda paginar libremente en el Radar Global
	err := r.db.
		Where("\"isActive\" = ?", true).
		Order("\"quantity\" ASC").
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
			bs.lowest_price`).
		Joins(`LEFT JOIN (
			SELECT 
				ps.product_barcode, 
				ps.supplier_id as best_supplier_id, 
				s.name as best_supplier_name, 
				ps."purchasePrice" as lowest_price,
				ROW_NUMBER() OVER(PARTITION BY ps.product_barcode ORDER BY ps."purchasePrice" ASC) as rn
			FROM product_suppliers ps
			JOIN suppliers s ON ps.supplier_id = s.id
		) bs ON products.barcode = bs.product_barcode AND bs.rn = 1`).
		Where("products.\"isActive\" = ?", true)

	if supplierID != nil {
		query = query.Where(`(
			products.barcode IN (SELECT "productBarcode" FROM product_suppliers WHERE "supplierId" = ?) 
			OR products."supplierId" = ?
		)`, *supplierID, *supplierID)
	}

	err := query.Order("products.quantity ASC").Scan(&results).Error
	return results, err
}

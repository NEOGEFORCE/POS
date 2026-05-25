package repositories

import (
	"fmt"
	"math"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type PostgresProductRepository struct {
	db               *gorm.DB
}

func NewPostgresProductRepository(db *gorm.DB) *PostgresProductRepository {
	return &PostgresProductRepository{db: db}
}

func (r *PostgresProductRepository) invalidateDashboardCache() {
	cache.InvalidateCache(cache.CacheKeyDashboardOverview)
	// Solicitar refresco asíncrono y debounced al servicio centralizado
	refresher.GetRefresherService(r.db).RequestRefresh("mv_dashboard_stats_monthly")
	
	// Notificar sincronización global
	sse.GetSSEService().BroadcastProductUpdate(nil)
}

// Save persiste un producto y sus asociaciones de forma separada
func (r *PostgresProductRepository) Save(product *models.Product) error {
	suppliers := product.Suppliers
	product.Suppliers = nil

	if err := r.db.Omit("Suppliers").Save(product).Error; err != nil {
		return fmt.Errorf("error guardando producto: %w", err)
	}

	// INVALIDACIÓN L1: El catálogo maestro ha cambiado
	cache.InvalidateCache(cache.CacheKeyProducts)
	cache.InvalidateCache(cache.CacheKeyProductCount)
	r.invalidateDashboardCache()

	if len(suppliers) > 0 {
		if err := r.db.Model(product).Association("Suppliers").Replace(suppliers); err != nil {
			return fmt.Errorf("error asociando proveedores: %w", err)
		}
		product.Suppliers = suppliers
	}

	return nil
}

func (r *PostgresProductRepository) GetByBarcode(barcode string) (*models.Product, error) {
	var product models.Product
	// Búsqueda en código principal o en el array de códigos alternos
	err := r.db.Preload("Category").Preload("Suppliers").
		Where("barcode = ? OR ? = ANY(string_to_array(\"alternate_codes\", ','))", barcode, barcode).
		First(&product).Error
	return &product, err
}

func (r *PostgresProductRepository) GetByBarcodes(barcodes []string) ([]models.Product, error) {
	var products []models.Product
	err := r.db.Preload("Category").
		Where("barcode IN ?", barcodes).
		Find(&products).Error
	return products, err
}

func (r *PostgresProductRepository) GetByName(name string) (*models.Product, error) {
	var product models.Product
	err := r.db.Where("UPPER(\"productName\") = UPPER(?)", name).First(&product).Error
	return &product, err
}

func (r *PostgresProductRepository) GetByBarcodeWithPreloads(barcode string, preloads ...string) (*models.Product, error) {
	var product models.Product
	query := r.db.Model(&models.Product{})
	for _, p := range preloads {
		query = query.Preload(p)
	}
	err := query.Where("barcode = ? OR ? = ANY(string_to_array(\"alternate_codes\", ','))", barcode, barcode).First(&product).Error
	return &product, err
}

func (r *PostgresProductRepository) GetAll() ([]models.Product, error) {
	// CACHÉ L1: Intentar recuperar de RAM primero
	if cached, found := cache.CacheManager.Get(cache.CacheKeyProducts); found {
		return cached.([]models.Product), nil
	}

	var products []models.Product
	err := r.db.Preload("Category").Where("\"isActive\" = ?", true).Order("\"productName\" ASC").Find(&products).Error

	// PERSISTENCIA EN RAM: Guardar si la consulta fue exitosa
	if err == nil {
		cache.CacheManager.Set(cache.CacheKeyProducts, products, 24*time.Hour)
	}

	return products, err
}

func (r *PostgresProductRepository) GetAllWithLimit(limit int) ([]models.Product, error) {
	var products []models.Product
	err := r.db.Preload("Category").Where("\"isActive\" = ?", true).Limit(limit).Find(&products).Error
	return products, err
}

func (r *PostgresProductRepository) GetPaginated(page, pageSize int, search string, supplierID int) ([]models.Product, int64, error) {
	var products []models.Product
	var total int64

	query := r.db.Model(&models.Product{}).Where("\"isActive\" = ?", true)
	if search != "" {
		searchTerm := "%" + search + "%"
		query = query.Joins("LEFT JOIN categories ON categories.id = products.\"categoryId\"").
			Where("products.barcode ILIKE ? OR unaccent(products.\"productName\") ILIKE unaccent(?) OR products.\"alternate_codes\" ILIKE ? OR unaccent(categories.name) ILIKE unaccent(?)", 
				searchTerm, searchTerm, searchTerm, searchTerm)
	}

	if supplierID > 0 {
		query = query.Joins("LEFT JOIN product_suppliers ON product_suppliers.product_barcode = products.barcode").
			Where("products.\"supplierId\" = ? OR product_suppliers.supplier_id = ?", supplierID, supplierID).
			Distinct("products.barcode")
	}

	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * pageSize
	err := query.Preload("Category").
		Preload("BaseProduct").
		Preload("Suppliers").
		Order("\"productName\" ASC").
		Limit(pageSize).
		Offset(offset).
		Find(&products).Error

	return products, total, err
}

func (r *PostgresProductRepository) Update(barcode string, product *models.Product) error {
	// === PREPARACIÓN DE VALORES SEGUROS ===

	catID := int64(product.CategoryID)
	if catID == 0 {
		var currentCatID int64
		r.db.Raw(`SELECT "categoryId" FROM products WHERE barcode = ?`, barcode).Scan(&currentCatID)
		if currentCatID > 0 {
			catID = currentCatID
		}
	}

	var suppID interface{}
	if product.SupplierID != nil && *product.SupplierID > 0 {
		suppID = int64(*product.SupplierID)
	} else {
		var currentSuppID *int64
		r.db.Raw(`SELECT "supplierId" FROM products WHERE barcode = ?`, barcode).Scan(&currentSuppID)
		suppID = currentSuppID
	}

	var baseBc interface{}
	if product.BaseProductBarcode != nil && *product.BaseProductBarcode != "" {
		baseBc = *product.BaseProductBarcode
	} else {
		baseBc = nil
	}

	barcodeChanged := product.Barcode != barcode

	if barcodeChanged {
		// === ESTRATEGIA: DELETE + UPDATE + RE-INSERT ===
		// Paso 1: Guardar los IDs de proveedores asociados
		var supplierIDs []int64
		r.db.Raw(`SELECT supplier_id FROM product_suppliers WHERE product_barcode = $1`, barcode).Scan(&supplierIDs)

		// Paso 2: Borrar las asociaciones viejas (esto libera la FK)
		r.db.Exec(`DELETE FROM product_suppliers WHERE product_barcode = $1`, barcode)

		// Paso 3: Actualizar auto-referencia de packs ANTES de cambiar el barcode
		r.db.Exec(`UPDATE products SET "baseProductBarcode" = $1 WHERE "baseProductBarcode" = $2 AND barcode != $3`,
			product.Barcode, barcode, barcode)

		// Paso 4: UPDATE del producto (incluye cambio de barcode)
		query := `UPDATE products SET 
			barcode = $1, "productName" = $2, quantity = $3, "isWeighted" = $4, 
			"purchasePrice" = $5, "salePrice" = $6, "categoryId" = $7, "supplierId" = $8, 
			iva = $9, icui = $10, ibua = $11, discount = $12, "marginPercentage" = $13, "imageUrl" = $14, 
			"minStock" = $15, "isActive" = $16, "isPack" = $17, "packMultiplier" = $18, 
			"baseProductBarcode" = $19, alternate_codes = $20, "alternateCodes" = $21, 
			"updatedByDni" = $22, "updatedByName" = $23, order_multiple = $24
			WHERE barcode = $25`

		result := r.db.Exec(query,
			product.Barcode, product.ProductName, product.Quantity, product.IsWeighted,
			product.PurchasePrice, product.SalePrice, catID, suppID,
			product.Iva, product.Icui, product.Ibua, product.Discount, product.MarginPercentage, product.ImageUrl,
			product.MinStock, product.IsActive, product.IsPack, product.PackMultiplier,
			baseBc, product.AlternateCodes, product.AlternateCodes,
			product.UpdatedByDNI, product.UpdatedByName, product.OrderMultiple,
			barcode,
		)
		if result.Error != nil {
			return fmt.Errorf("error actualizando producto: %w", result.Error)
		}
		if result.RowsAffected == 0 {
			fmt.Printf("[WARNING] No rows updated for barcode: %s (Original: %s)\n", product.Barcode, barcode)
		} else {
			fmt.Printf("[SUCCESS] Product updated and barcode changed from %s to %s\n", barcode, product.Barcode)
		}

		// Paso 5: Re-insertar las asociaciones con el nuevo barcode
		for _, sid := range supplierIDs {
			r.db.Exec(`INSERT INTO product_suppliers (product_barcode, supplier_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
				product.Barcode, sid)
		}

	} else {
		// === SIN CAMBIO DE BARCODE: Update directo y simple ===
		query := `UPDATE products SET 
			"productName" = $1, quantity = $2, "isWeighted" = $3, 
			"purchasePrice" = $4, "salePrice" = $5, "categoryId" = $6, "supplierId" = $7, 
			iva = $8, icui = $9, ibua = $10, discount = $11, "marginPercentage" = $12, "imageUrl" = $13, 
			"minStock" = $14, "isActive" = $15, "isPack" = $16, "packMultiplier" = $17, 
			"baseProductBarcode" = $18, alternate_codes = $19, "alternateCodes" = $20, 
			"updatedByDni" = $21, "updatedByName" = $22, order_multiple = $23
			WHERE barcode = $24`

		result := r.db.Exec(query,
			product.ProductName, product.Quantity, product.IsWeighted,
			product.PurchasePrice, product.SalePrice, catID, suppID,
			product.Iva, product.Icui, product.Ibua, product.Discount, product.MarginPercentage, product.ImageUrl,
			product.MinStock, product.IsActive, product.IsPack, product.PackMultiplier,
			baseBc, product.AlternateCodes, product.AlternateCodes,
			product.UpdatedByDNI, product.UpdatedByName, product.OrderMultiple,
			barcode,
		)
		if result.Error != nil {
			return fmt.Errorf("error actualizando producto: %w", result.Error)
		}
		if result.RowsAffected == 0 {
			fmt.Printf("[WARNING] No rows updated for barcode: %s\n", barcode)
		} else {
			fmt.Printf("[SUCCESS] Product updated: %s\n", barcode)
		}
	}

	// INVALIDACIÓN L1
	cache.InvalidateCache(cache.CacheKeyProducts)
	cache.InvalidateCache(cache.CacheKeyProductCount)
	r.invalidateDashboardCache()

	return nil
}

func (r *PostgresProductRepository) Delete(barcode string) error {
	err := r.db.Model(&models.Product{}).Where("barcode = ?", barcode).Update("isActive", false).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyProducts)
		cache.InvalidateCache(cache.CacheKeyProductCount)
		r.invalidateDashboardCache()
	}
	return err
}

func (r *PostgresProductRepository) Count() (int64, error) {
	if cached, found := cache.CacheManager.Get(cache.CacheKeyProductCount); found {
		return cached.(int64), nil
	}
	var count int64
	err := r.db.Model(&models.Product{}).Where("\"isActive\" = ?", true).Count(&count).Error
	if err == nil {
		cache.CacheManager.Set(cache.CacheKeyProductCount, count, 1*time.Hour)
	}
	return count, err
}

func (r *PostgresProductRepository) GetActiveCount() (int64, error) {
	// Reusamos la lógica de caché para conteos activos
	cacheKey := cache.CacheKeyProductCount + "_active"
	if cached, found := cache.CacheManager.Get(cacheKey); found {
		return cached.(int64), nil
	}
	var count int64
	err := r.db.Model(&models.Product{}).Where("quantity > 0").Count(&count).Error
	if err == nil {
		cache.CacheManager.Set(cacheKey, count, 1*time.Hour)
	}
	return count, err
}

func (r *PostgresProductRepository) UpdateSupplierPrice(barcode string, supplierID uint, price float64) error {
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "product_barcode"}, {Name: "supplier_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"purchasePrice"}),
	}).Create(&models.ProductSupplier{
		ProductID:     barcode,
		SupplierID:    supplierID,
		PurchasePrice: price,
	}).Error
}

func (r *PostgresProductRepository) GetSupplierPrices(barcode string) ([]models.ProductSupplier, error) {
	var prices []models.ProductSupplier
	err := r.db.Where("product_barcode = ?", barcode).Find(&prices).Error
	return prices, err
}

func (r *PostgresProductRepository) GetBySupplier(supplierID uint) ([]models.Product, error) {
	var products []models.Product
	err := r.db.Where(
		`products.barcode IN (
			SELECT product_barcode FROM product_suppliers WHERE supplier_id = ?
			UNION
			SELECT barcode FROM products WHERE "supplierId" = ?
		)`,
		supplierID, supplierID,
	).Find(&products).Error
	return products, err
}
func (r *PostgresProductRepository) UpdateSupplierFrequency(supplierID uint, days int) error {
	return r.db.Model(&models.Supplier{}).Where("id = ?", supplierID).Update("visit_frequency_days", days).Error
}

func (r *PostgresProductRepository) GetDailySalesAverage(barcode string, days int) (float64, error) {
	var totalSold float64
	query := `SELECT COALESCE(SUM(quantity), 0) FROM sale_details 
	          JOIN sales ON sale_details.sale_id = sales.sale_id 
	          WHERE sale_details.barcode = ? AND sales.sale_date > ?`
	
	since := time.Now().AddDate(0, 0, -days)
	err := r.db.Raw(query, barcode, since).Scan(&totalSold).Error
	if err != nil {
		return 0, err
	}
	
	avg := totalSold / float64(days)
	return math.Round(avg*100) / 100, nil
}

func (r *PostgresProductRepository) GetPriceChangesToday() ([]models.PriceLog, error) {
	var logs []models.PriceLog
	// Start of today in Unix timestamp (seconds)
	now := time.Now()
	startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).Unix()
	
	err := r.db.Where("created_at >= ?", startOfDay).Order("created_at DESC").Find(&logs).Error
	return logs, err
}

func (r *PostgresProductRepository) RecordPriceChange(tx interface{}, barcode string, oldPrice, newPrice float64) error {
	var db *gorm.DB
	if tx != nil {
		db = tx.(*gorm.DB)
	} else {
		db = r.db
	}

	var productName string
	var product models.Product
	if err := db.Select("\"productName\"").Where("barcode = ?", barcode).First(&product).Error; err == nil {
		productName = product.ProductName
	}

	log := models.PriceLog{
		ProductBarcode: barcode,
		ProductName:    productName,
		OldPrice:       oldPrice,
		NewPrice:       newPrice,
	}

	if err := db.Create(&log).Error; err != nil {
		return fmt.Errorf("fallo al crear log de precio: %w", err)
	}
	return nil
}

func (r *PostgresProductRepository) GetPendingTransitQuantities() (map[string]float64, map[string]string, error) {
	quantities := make(map[string]float64)
	suppliers := make(map[string]string)

	type TransitRow struct {
		Barcode      string  `gorm:"column:barcode"`
		Quantity     float64 `gorm:"column:total_qty"`
		SupplierName string  `gorm:"column:supplier_name"`
	}

	var rows []TransitRow

	err := r.db.Table("expected_order_items i").
		Select("i.barcode, SUM(i.expected_quantity) as total_qty, MAX(s.name) as supplier_name").
		Joins("JOIN expected_orders o ON o.id = i.expected_order_id").
		Joins("LEFT JOIN suppliers s ON s.id = o.supplier_id").
		Where("o.status = ?", "PENDING").
		Group("i.barcode").
		Scan(&rows).Error

	if err != nil {
		return nil, nil, err
	}

	for _, row := range rows {
		quantities[row.Barcode] = row.Quantity
		suppliers[row.Barcode] = row.SupplierName
	}

	return quantities, suppliers, nil
}

func (r *PostgresProductRepository) SaveShrinkage(shrinkage *models.Shrinkage, shiftID *uint) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(shrinkage).Error; err != nil {
			return err
		}

		expense := models.Expense{
			Description:   fmt.Sprintf("MERMA (%s) - Prod: %s", shrinkage.Reason, shrinkage.ProductID),
			Amount:        shrinkage.CostAtTime * shrinkage.Quantity,
			Date:          time.Now(),
			PaymentSource: "MERMA",
			Category:      "PÉRDIDA OPERATIVA",
			Status:        "PAID",
			CreatedByDNI:  shrinkage.UserID,
		}

		if err := tx.Create(&expense).Error; err != nil {
			return err
		}

		return nil
	})
}

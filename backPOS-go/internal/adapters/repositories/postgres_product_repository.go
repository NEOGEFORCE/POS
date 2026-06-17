package repositories

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
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
	cache.InvalidateCache(fmt.Sprintf("product_barcode_%s", product.Barcode))
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
	cacheKey := fmt.Sprintf("product_barcode_%s", barcode)
	if cached, found := cache.CacheManager.Get(cacheKey); found {
		return cached.(*models.Product), nil
	}

	var product models.Product
	// Búsqueda en código principal o en el array de códigos alternos
	err := r.db.Preload("Category").Preload("Suppliers").
		Where("barcode = ? OR ? = ANY(string_to_array(\"alternate_codes\", ','))", barcode, barcode).
		First(&product).Error
		
	if err == nil {
		cache.CacheManager.Set(cacheKey, &product, 24*time.Hour)
	}
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

	var catID interface{}
	catIDInt := int64(product.CategoryID)
	if catIDInt == 0 {
		var currentCatID int64
		r.db.Raw(`SELECT "categoryId" FROM products WHERE barcode = ?`, barcode).Scan(&currentCatID)
		if currentCatID > 0 {
			catIDInt = currentCatID
		}
	}
	if catIDInt > 0 {
		catID = catIDInt
	} else {
		catID = nil
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
			"baseProductBarcode" = $19, alternate_codes = $20, 
			"updatedByDni" = $21, "updatedByName" = $22, order_multiple = $23
			WHERE barcode = $24`

		result := r.db.Exec(query,
			product.Barcode, product.ProductName, product.Quantity, product.IsWeighted,
			product.PurchasePrice, product.SalePrice, catID, suppID,
			product.Iva, product.Icui, product.Ibua, product.Discount, product.MarginPercentage, product.ImageUrl,
			product.MinStock, product.IsActive, product.IsPack, product.PackMultiplier,
			baseBc, product.AlternateCodes,
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
			"baseProductBarcode" = $18, alternate_codes = $19, 
			"updatedByDni" = $20, "updatedByName" = $21, order_multiple = $22
			WHERE barcode = $23`

		result := r.db.Exec(query,
			product.ProductName, product.Quantity, product.IsWeighted,
			product.PurchasePrice, product.SalePrice, catID, suppID,
			product.Iva, product.Icui, product.Ibua, product.Discount, product.MarginPercentage, product.ImageUrl,
			product.MinStock, product.IsActive, product.IsPack, product.PackMultiplier,
			baseBc, product.AlternateCodes,
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
	cache.InvalidateCache(fmt.Sprintf("product_barcode_%s", barcode))
	r.invalidateDashboardCache()

	return nil
}

func (r *PostgresProductRepository) Delete(barcode string) error {
	err := r.db.Model(&models.Product{}).Where("barcode = ?", barcode).Update("isActive", false).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyProducts)
		cache.InvalidateCache(cache.CacheKeyProductCount)
		cache.InvalidateCache(fmt.Sprintf("product_barcode_%s", barcode))
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

func (r *PostgresProductRepository) GetOrphanedProducts() ([]models.Product, error) {
	var products []models.Product
	err := r.db.Where(
		`"supplierId" IS NULL AND barcode NOT IN (SELECT product_barcode FROM product_suppliers)`,
	).Where("\"isActive\" = ?", true).Find(&products).Error
	return products, err
}

func (r *PostgresProductRepository) UnlinkSupplier(barcode string, supplierID uint) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		// 1. Set products.supplierId to NULL if it matches this supplier
		if err := tx.Exec(`UPDATE products SET "supplierId" = NULL WHERE barcode = ? AND "supplierId" = ?`, barcode, supplierID).Error; err != nil {
			return err
		}
		// 2. Remove from product_suppliers mapping table
		if err := tx.Exec(`DELETE FROM product_suppliers WHERE product_barcode = ? AND supplier_id = ?`, barcode, supplierID).Error; err != nil {
			return err
		}
		return nil
	})
}

func (r *PostgresProductRepository) LinkSupplier(barcode string, supplierID uint) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		// 1. Set products.supplierId
		if err := tx.Exec(`UPDATE products SET "supplierId" = ? WHERE barcode = ?`, supplierID, barcode).Error; err != nil {
			return err
		}
		// 2. Insert into product_suppliers
		if err := tx.Exec(`INSERT INTO product_suppliers (product_barcode, supplier_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, barcode, supplierID).Error; err != nil {
			return err
		}
		return nil
	})
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

	query := `
		SELECT barcode, SUM(qty) as total_qty, MAX(supplier_name) as supplier_name
		FROM (
			SELECT i.barcode as barcode, i.expected_quantity as qty, s.name as supplier_name
			FROM expected_order_items i
			JOIN expected_orders o ON o.id = i.expected_order_id
			LEFT JOIN suppliers s ON s.id = o."supplierId"
			WHERE UPPER(o.status) = 'PENDING'
			
			UNION ALL
			
			SELECT i.product_id as barcode, i.quantity as qty, s.name as supplier_name
			FROM confirmed_order_items i
			JOIN confirmed_orders o ON o.id = i.confirmed_order_id
			LEFT JOIN suppliers s ON s.id = o.supplier_id
			WHERE UPPER(o.status) = 'PENDING'
		) t
		GROUP BY barcode
	`

	err := r.db.Raw(query).Scan(&rows).Error

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

func (r *PostgresProductRepository) EditReception(ref string, dniStr string, reason string, products []models.EditReceiveItem) ([]string, error) {
	var movement models.StockMovement
	err := r.db.Where("id = ? OR reference_id = ?", ref, ref).First(&movement).Error
	if err != nil {
		return nil, fmt.Errorf("recepción original no encontrada: %w", err)
	}

	originalSnapshot, _ := json.Marshal(movement)
	movement.OriginalValues = string(originalSnapshot)

	priceChanges := make([]string, 0)
	err = r.db.Transaction(func(tx *gorm.DB) error {
		for _, item := range products {
			var product models.Product
			if err := tx.Where("barcode = ?", item.Barcode).First(&product).Error; err != nil {
				return fmt.Errorf("producto %s no encontrado", item.Barcode)
			}

			oldWac := product.PurchasePrice
			oldStock := product.Quantity - movement.Quantity
			newStock := oldStock + item.Quantity

			costoConImpuestos := item.CostUnit * (1 + item.IVA/100 + item.ICUI/100 + item.IBUA/100)
			costoFinal := costoConImpuestos * (1 - item.Discount/100)

			var nuevoWAC float64
			if newStock > 0 {
				nuevoWAC = ((oldStock * oldWac) + (item.Quantity * costoFinal)) / newStock
			} else {
				nuevoWAC = costoFinal
			}

			diff := math.Abs(nuevoWAC - oldWac)
			if oldWac > 0 && diff > 0.01 {
				priceChanges = append(priceChanges, fmt.Sprintf("%s: $%.2f → $%.2f", product.ProductName, oldWac, nuevoWAC))
			}

			product.PurchasePrice = math.Round(nuevoWAC*100) / 100
			
			if item.PVP > 0 {
				margen := ((item.PVP - nuevoWAC) / item.PVP) * 100
				product.MarginPercentage = math.Round(margen*100) / 100
				product.SalePrice = item.PVP
			}

			product.Quantity = newStock
			if err := tx.Save(&product).Error; err != nil {
				return err
			}
		}

		now := time.Now()
		movement.EditedBy = dniStr
		movement.EditedAt = &now
		movement.Reason = "EDITADO: " + reason
		movement.Quantity = products[0].Quantity 
		
		if err := tx.Save(&movement).Error; err != nil {
			return err
		}

		return nil
	})

	return priceChanges, err
}

func (r *PostgresProductRepository) GetSupplierAliases(supplierID uint) (map[string]models.SupplierProductAlias, error) {
	var aliases []models.SupplierProductAlias
	if err := r.db.Where("supplier_id = ?", supplierID).Find(&aliases).Error; err != nil {
		return nil, err
	}
	result := make(map[string]models.SupplierProductAlias)
	for _, a := range aliases {
		result[strings.ToUpper(a.InvoiceName)] = a
	}
	return result, nil
}

func (r *PostgresProductRepository) GetSupplierInvoiceParams(supplierID uint) (*models.SupplierInvoiceParams, error) {
	var params models.SupplierInvoiceParams
	if err := r.db.Where("supplier_id = ?", supplierID).First(&params).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil // Not an error if it doesn't exist yet
		}
		return nil, err
	}
	return &params, nil
}

func (r *PostgresProductRepository) SaveSupplierAlias(alias *models.SupplierProductAlias) error {
	var existing models.SupplierProductAlias
	err := r.db.Where("supplier_id = ? AND invoice_name = ?", alias.SupplierID, alias.InvoiceName).First(&existing).Error
	if err == nil {
		existing.UsesCount++
		return r.db.Save(&existing).Error
	}
	if err == gorm.ErrRecordNotFound {
		return r.db.Create(alias).Error
	}
	return err
}

func (r *PostgresProductRepository) FindProductBySimilarName(name string, supplierID uint) (*models.Product, float64) {
	var p models.Product
	// Direct ILIKE match or using trigram similarity if enabled.
	// For now, let's use a simple ILIKE search with wildcards. In production, pg_trgm is better.
	// We check if there's any product where the name matches partially.
	searchTerm := "%" + name + "%"
	err := r.db.Where("\"productName\" ILIKE ?", searchTerm).First(&p).Error
	if err == nil {
		return &p, 0.8 // Dummy confidence for ILIKE
	}
	return nil, 0
}

func (r *PostgresProductRepository) SearchSimilarProducts(name string, limit int) []models.ProductSearch {
	var products []models.Product
	searchTerm := "%" + name + "%"
	r.db.Where("\"productName\" ILIKE ?", searchTerm).Limit(limit).Find(&products)

	var suggestions []models.ProductSearch
	for _, p := range products {
		suggestions = append(suggestions, models.ProductSearch{
			ID:          1, // Not used heavily, barcode is main ID
			Barcode:     p.Barcode,
			ProductName: p.ProductName,
			Confidence:  0.8,
		})
	}
	return suggestions
}


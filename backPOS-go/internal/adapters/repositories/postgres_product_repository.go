package repositories

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/refresher"
	"backPOS-go/internal/infrastructure/sse"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type PostgresProductRepository struct {
	db *gorm.DB
}

func NewPostgresProductRepository(db *gorm.DB) *PostgresProductRepository {
	return &PostgresProductRepository{db: db}
}

func (r *PostgresProductRepository) GetDB() interface{} {
	return r.db
}

func cloneProduct(product *models.Product) *models.Product {
	if product == nil {
		return nil
	}
	clone := *product
	clone.Suppliers = append([]models.Supplier(nil), product.Suppliers...)
	clone.ProductSuppliers = append([]models.ProductSupplier(nil), product.ProductSuppliers...)
	return &clone
}

func (r *PostgresProductRepository) invalidateDashboardCache() {
	cache.InvalidateDashboard()
	// Un cambio de precio o de recepción mueve el ahorro potencial que calcula
	// GetSavingsOpportunities; si no se purga, el dashboard sigue recomendando
	// comprarle al proveedor caro durante una hora.
	cache.InvalidateSavingsOpportunities()
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
		if product, ok := cached.(*models.Product); ok {
			return cloneProduct(product), nil
		}
		cache.InvalidateCache(cacheKey)
	}

	var product models.Product
	// Búsqueda en código principal o en el array de códigos alternos
	err := r.db.Preload("Category").Preload("Suppliers").
		Where("barcode = ? OR ? = ANY(string_to_array(\"alternate_codes\", ','))", barcode, barcode).
		First(&product).Error

	if err == nil {
		cache.CacheManager.Set(cacheKey, cloneProduct(&product), 24*time.Hour)
	}
	return &product, err
}

func (r *PostgresProductRepository) GetByBarcodes(barcodes []string) ([]models.Product, error) {
	var products []models.Product
	err := r.db.Preload("Category").Preload("BaseProduct").
		Where("barcode IN ? OR EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(alternate_codes, ''), ',')) ac WHERE ac IN ?)", barcodes, barcodes).
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
	err := r.db.Preload("Category").Where("COALESCE(\"isActive\", true) = ?", true).Order("\"productName\" ASC").Find(&products).Error

	// PERSISTENCIA EN RAM: Guardar si la consulta fue exitosa
	if err == nil {
		cache.CacheManager.Set(cache.CacheKeyProducts, products, 24*time.Hour)
	}

	return products, err
}

func (r *PostgresProductRepository) GetAllWithLimit(limit int) ([]models.Product, error) {
	var products []models.Product
	err := r.db.Preload("Category").Where("COALESCE(\"isActive\", true) = ?", true).Limit(limit).Find(&products).Error
	return products, err
}

func (r *PostgresProductRepository) GetPaginated(page, pageSize int, search string, supplierID int, stockFilter string) ([]models.Product, int64, error) {
	var products []models.Product
	var total int64

	query := r.db.Model(&models.Product{}).Where("products.\"isActive\" = ?", true)
	if search != "" {
		searchTerm := "%" + search + "%"
		query = query.Joins("LEFT JOIN categories ON categories.id = products.\"categoryId\"").
			Where("products.barcode ILIKE ? OR unaccent(products.\"productName\") ILIKE unaccent(?) OR products.\"alternate_codes\" ILIKE ? OR unaccent(categories.name) ILIKE unaccent(?)",
				searchTerm, searchTerm, searchTerm, searchTerm)
	}

	if supplierID > 0 {
		query = query.Where(`products.barcode IN (
			SELECT product_barcode FROM product_suppliers WHERE supplier_id = ?
			UNION
			SELECT barcode FROM products WHERE "supplierId" = ?
		)`, supplierID, supplierID)
	}

	if stockFilter == "critical" {
		// ROJO nuevo (regla del dueno, agosto 2026): ratio < 0.25 del minimo.
		// Con minimo <= 0 se sigue considerando critico cuando quantity <= 0.
		query = query.Where(`(
			(COALESCE(products."minStock", 0) <= 0 AND products.quantity <= 0)
			OR (COALESCE(products."minStock", 0) > 0 AND (products.quantity / NULLIF(products."minStock", 0)) < 0.25)
		)`)
	} else if stockFilter == "warning" {
		// AMARILLO nuevo: 0.25 <= ratio < 0.75. Sin minimo configurado con
		// stock bajo (<=5) se sigue tolerando el fallback historico para no
		// dejar productos sin senal cuando el dueno no puso minimo.
		query = query.Where(`(
			(COALESCE(products."minStock", 0) > 0 AND (products.quantity / NULLIF(products."minStock", 0)) >= 0.25 AND (products.quantity / NULLIF(products."minStock", 0)) < 0.75)
			OR (COALESCE(products."minStock", 0) <= 0 AND products.quantity > 0 AND products.quantity <= 5)
		)`)
	}

	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * pageSize
	err := query.Preload("Category").
		Preload("BaseProduct").
		Preload("Suppliers").
		Order("products.\"productName\" ASC").
		Limit(pageSize).
		Offset(offset).
		Find(&products).Error

	return products, total, err
}

func (r *PostgresProductRepository) Update(barcode string, product *models.Product) error {
	if product == nil {
		return fmt.Errorf("producto requerido")
	}
	if err := r.db.Transaction(func(tx *gorm.DB) error {
		return r.UpdateWithTx(tx, barcode, product, ports.ProductUpdateOptions{})
	}); err != nil {
		return err
	}
	r.AfterCommitUpdate(barcode, product.Barcode)
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
	err := r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "product_barcode"}, {Name: "supplier_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"purchasePrice"}),
	}).Create(&models.ProductSupplier{
		ProductID:     barcode,
		SupplierID:    supplierID,
		PurchasePrice: price,
	}).Error

	// product_suppliers."purchasePrice" es exactamente la entrada de
	// GetSavingsOpportunities (ver postgres_product_stats.go): si no se purga,
	// el dashboard sigue recomendando el proveedor barato de hace una hora.
	if err == nil {
		cache.InvalidateSavingsOpportunities()
	}
	return err
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
	barcode = strings.TrimSpace(barcode)
	if barcode == "" || supplierID == 0 {
		return fmt.Errorf("producto y proveedor son requeridos")
	}

	err := r.db.Transaction(func(tx *gorm.DB) error {
		var product models.Product
		if err := tx.Select("barcode").Where("barcode = ?", barcode).First(&product).Error; err != nil {
			return fmt.Errorf("producto no encontrado: %w", err)
		}
		if err := tx.Model(&models.Product{}).
			Where("barcode = ? AND \"supplierId\" = ?", barcode, supplierID).
			Update("supplierId", nil).Error; err != nil {
			return err
		}
		if err := tx.Where("product_barcode = ? AND supplier_id = ?", barcode, supplierID).
			Delete(&models.ProductSupplier{}).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	r.AfterCommitUpdate(barcode)
	return nil
}

func (r *PostgresProductRepository) LinkSupplier(barcode string, supplierID uint) error {
	barcode = strings.TrimSpace(barcode)
	if barcode == "" || supplierID == 0 {
		return fmt.Errorf("producto y proveedor son requeridos")
	}

	err := r.db.Transaction(func(tx *gorm.DB) error {
		var product models.Product
		if err := tx.Select("barcode").Where("barcode = ? AND COALESCE(\"isActive\", TRUE) = TRUE", barcode).
			First(&product).Error; err != nil {
			return fmt.Errorf("producto no encontrado o inactivo: %w", err)
		}
		var supplier models.Supplier
		if err := tx.Select("id").Where("id = ? AND \"is_active\" = TRUE", supplierID).
			First(&supplier).Error; err != nil {
			return fmt.Errorf("proveedor no encontrado o inactivo: %w", err)
		}

		if err := tx.Model(&models.Product{}).Where("barcode = ?", barcode).
			Update("supplierId", supplierID).Error; err != nil {
			return err
		}
		link := models.ProductSupplier{ProductID: barcode, SupplierID: supplierID}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&link).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	r.AfterCommitUpdate(barcode)
	return nil
}

// UpdateSupplierFrequency actualiza visit_frequency_days SOLO cuando el
// proveedor no tiene agenda manual configurada. Esta funcion era el mecanismo
// que quemaba al dueno: sobreescribia la frecuencia sin preguntar y las
// sugerencias se corrian a un mes.
//
// A partir del Sprint 9 (migracion 014) el aprendizaje real vive en las
// columnas learned_* que llena el batch nocturno. Aca solo dejamos el
// fallback historico: si el proveedor jamas fue configurado a mano ni por
// aprendizaje nuevo, seguimos aportando algo. En cuanto exista visit_days o
// delivery_days, este metodo se convierte en no-op para que la configuracion
// del dueno mande.
func (r *PostgresProductRepository) UpdateSupplierFrequency(supplierID uint, days int) error {
	return r.db.Model(&models.Supplier{}).
		Where("id = ?", supplierID).
		Where("(visit_days IS NULL OR visit_days::text = '[]') AND (delivery_days IS NULL OR delivery_days::text = '[]')").
		Update("visit_frequency_days", days).Error
}

func (r *PostgresProductRepository) GetDailySalesAverage(barcode string, days int) (float64, error) {
	var totalSold float64
	query := `SELECT COALESCE(SUM(sd.quantity), 0)
	          FROM sale_details sd
	          JOIN sales s ON sd."saleId" = s."saleId"
	          WHERE sd.barcode = ? AND s."saleDate" > ?`

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
		ExpectedDate string  `gorm:"column:expected_date"`
	}

	var rows []TransitRow

	query := `
		SELECT barcode, SUM(qty) as total_qty,
		       STRING_AGG(DISTINCT supplier_name, ', ') as supplier_name,
		       MIN(expected_date) as expected_date
		FROM (
			SELECT i.barcode as barcode, i.expected_quantity as qty,
			       COALESCE(NULLIF(s.name, ''), NULLIF(o.supplier_name, ''), 'Desconocido') as supplier_name,
			       TO_CHAR(o."expectedDate", 'YYYY-MM-DD') as expected_date
			FROM expected_order_items i
			JOIN expected_orders o ON o.id = i.expected_order_id
			LEFT JOIN suppliers s ON s.id = o."supplierId"
			WHERE UPPER(o.status) = 'PENDING'
			
			UNION ALL
			
			SELECT i.product_id as barcode, i.quantity as qty,
			       COALESCE(NULLIF(s.name, ''), 'Desconocido') as supplier_name,
			       o.expected_date as expected_date
			FROM confirmed_order_items i
			JOIN confirmed_orders o ON o.id = i.confirmed_order_id
			LEFT JOIN suppliers s ON s.id = o.supplier_id
			WHERE LOWER(o.status) IN ('pending', 'in_transit')
		) t
		GROUP BY barcode
	`

	err := r.db.Raw(query).Scan(&rows).Error

	if err != nil {
		return nil, nil, err
	}

	for _, row := range rows {
		quantities[row.Barcode] = row.Quantity
		detail := row.SupplierName
		if row.ExpectedDate != "" {
			detail = fmt.Sprintf("%s • Llega: %s", row.SupplierName, row.ExpectedDate)
		}
		suppliers[row.Barcode] = detail
	}

	return quantities, suppliers, nil
}

func (r *PostgresProductRepository) SaveShrinkage(shrinkage *models.Shrinkage, shiftID *uint) error {
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var product models.Product
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("barcode = ? AND deleted_at IS NULL", shrinkage.ProductID).
			First(&product).Error; err != nil {
			return fmt.Errorf("producto de merma no encontrado: %w", err)
		}
		if shrinkage.Quantity <= 0 {
			return fmt.Errorf("la cantidad de merma debe ser positiva")
		}
		if product.Quantity < shrinkage.Quantity {
			return fmt.Errorf("stock insuficiente para merma: disponible %.3f, solicitado %.3f", product.Quantity, shrinkage.Quantity)
		}

		shrinkage.CostAtTime = product.PurchasePrice
		if shrinkage.Date.IsZero() {
			shrinkage.Date = time.Now()
		}
		if err := tx.Create(shrinkage).Error; err != nil {
			return err
		}
		referenceID := fmt.Sprintf("SHRK-%d", shrinkage.ID)
		if err := tx.Model(&models.Product{}).
			Where("barcode = ?", shrinkage.ProductID).
			Update("quantity", gorm.Expr("ROUND((quantity - ?)::numeric, 3)", shrinkage.Quantity)).Error; err != nil {
			return err
		}
		movement := models.StockMovement{
			Date:        shrinkage.Date,
			Barcode:     shrinkage.ProductID,
			Quantity:    shrinkage.Quantity,
			Type:        models.MovementTypeOut,
			Reason:      "SHRINKAGE",
			ReferenceID: referenceID,
			EmployeeDNI: shrinkage.UserID,
		}
		if err := tx.Create(&movement).Error; err != nil {
			return err
		}
		expense := models.Expense{
			Description:   fmt.Sprintf("MERMA (%s) - Prod: %s", shrinkage.Reason, shrinkage.ProductID),
			Amount:        shrinkage.CostAtTime * shrinkage.Quantity,
			Date:          shrinkage.Date,
			PaymentSource: "MERMA",
			Category:      "PÉRDIDA OPERATIVA",
			Status:        "PAID",
			CreatedByDNI:  shrinkage.UserID,
			ReferenceID:   referenceID,
		}
		if err := tx.Create(&expense).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	r.AfterCommitUpdate(shrinkage.ProductID)
	return nil
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
			// REGLA DEL NEGOCIO: el costo capturado ya es el NETO pagado en
			// factura. El DTO % no lo disminuye; se traslada al PVP.
			costoFinal := costoConImpuestos

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

	words := strings.Fields(name)
	query := r.db

	if len(words) > 0 {
		var orConditions []string
		var args []interface{}
		for _, w := range words {
			if len(w) > 3 { // Ignorar conectores cortos o palabras de 1-3 letras
				orConditions = append(orConditions, "\"productName\" ILIKE ?")
				args = append(args, "%"+w+"%")
			}
		}
		if len(orConditions) > 0 {
			query = query.Where(strings.Join(orConditions, " OR "), args...)
		} else {
			query = query.Where("\"productName\" ILIKE ?", "%"+name+"%")
		}
	} else {
		query = query.Where("\"productName\" ILIKE ?", "%"+name+"%")
	}

	query.Limit(limit).Find(&products)

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

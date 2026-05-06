package repositories

import (
	"fmt"
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type PostgresProductRepository struct {
	db *gorm.DB
}

func NewPostgresProductRepository(db *gorm.DB) *PostgresProductRepository {
	return &PostgresProductRepository{db: db}
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

func (r *PostgresProductRepository) GetPaginated(page, pageSize int, search string) ([]models.Product, int64, error) {
	var products []models.Product
	var total int64

	query := r.db.Model(&models.Product{}).Preload("Category").Where("products.\"isActive\" = ?", true)
	if search != "" {
		searchTerm := "%" + search + "%"
		query = query.Joins("LEFT JOIN categories ON categories.id = products.\"categoryId\"").
			Where("products.barcode ILIKE ? OR products.\"productName\" ILIKE ? OR products.\"alternate_codes\" ILIKE ? OR categories.name ILIKE ?", searchTerm, searchTerm, searchTerm, searchTerm)
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
			iva = $9, icui = $10, ibua = $11, "marginPercentage" = $12, "imageUrl" = $13, 
			"minStock" = $14, "isActive" = $15, "isPack" = $16, "packMultiplier" = $17, 
			"baseProductBarcode" = $18, alternate_codes = $19, "alternateCodes" = $20, 
			"updatedByDni" = $21, "updatedByName" = $22
			WHERE barcode = $23`

		result := r.db.Exec(query,
			product.Barcode, product.ProductName, product.Quantity, product.IsWeighted,
			product.PurchasePrice, product.SalePrice, catID, suppID,
			product.Iva, product.Icui, product.Ibua, product.MarginPercentage, product.ImageUrl,
			product.MinStock, product.IsActive, product.IsPack, product.PackMultiplier,
			baseBc, product.AlternateCodes, product.AlternateCodes,
			product.UpdatedByDNI, product.UpdatedByName,
			barcode,
		)
		if result.Error != nil {
			return fmt.Errorf("error actualizando producto: %w", result.Error)
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
			iva = $8, icui = $9, ibua = $10, "marginPercentage" = $11, "imageUrl" = $12, 
			"minStock" = $13, "isActive" = $14, "isPack" = $15, "packMultiplier" = $16, 
			"baseProductBarcode" = $17, alternate_codes = $18, "alternateCodes" = $19, 
			"updatedByDni" = $20, "updatedByName" = $21
			WHERE barcode = $22`

		result := r.db.Exec(query,
			product.ProductName, product.Quantity, product.IsWeighted,
			product.PurchasePrice, product.SalePrice, catID, suppID,
			product.Iva, product.Icui, product.Ibua, product.MarginPercentage, product.ImageUrl,
			product.MinStock, product.IsActive, product.IsPack, product.PackMultiplier,
			baseBc, product.AlternateCodes, product.AlternateCodes,
			product.UpdatedByDNI, product.UpdatedByName,
			barcode,
		)
		if result.Error != nil {
			return fmt.Errorf("error actualizando producto: %w", result.Error)
		}
	}

	// INVALIDACIÓN L1
	cache.InvalidateCache(cache.CacheKeyProducts)
	cache.InvalidateCache(cache.CacheKeyProductCount)

	return nil
}

func (r *PostgresProductRepository) Delete(barcode string) error {
	err := r.db.Model(&models.Product{}).Where("barcode = ?", barcode).Update("isActive", false).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyProducts)
		cache.InvalidateCache(cache.CacheKeyProductCount)
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

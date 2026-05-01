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
	err := r.db.Preload("Category").Preload("Suppliers").Where("barcode = ?", barcode).First(&product).Error
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
	err := query.Where("barcode = ?", barcode).First(&product).Error
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
			Where("products.barcode ILIKE ? OR products.\"productName\" ILIKE ? OR categories.name ILIKE ?", searchTerm, searchTerm, searchTerm)
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
	suppliers := product.Suppliers
	product.Suppliers = nil

	if err := r.db.Model(&models.Product{}).Where("barcode = ?", barcode).
		Omit("Suppliers").Updates(product).Error; err != nil {
		return fmt.Errorf("error actualizando producto: %w", err)
	}

	if len(suppliers) > 0 {
		var existing models.Product
		if err := r.db.Where("barcode = ?", barcode).First(&existing).Error; err != nil {
			return fmt.Errorf("error obteniendo producto para asociar: %w", err)
		}
		if err := r.db.Model(&existing).Association("Suppliers").Replace(suppliers); err != nil {
			return fmt.Errorf("error actualizando proveedores: %w", err)
		}
		product.Suppliers = suppliers
	}

	// INVALIDACIÓN L1: Reflejar cambios en el catálogo maestro
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
	err := r.db.Where("\"productBarcode\" = ?", barcode).Find(&prices).Error
	return prices, err
}

func (r *PostgresProductRepository) GetBySupplier(supplierID uint) ([]models.Product, error) {
	var products []models.Product
	err := r.db.Where(
		`products.barcode IN (
			SELECT "productBarcode" FROM product_suppliers WHERE "supplierId" = ?
			UNION
			SELECT barcode FROM products WHERE "supplierId" = ?
		)`,
		supplierID, supplierID,
	).Find(&products).Error
	return products, err
}

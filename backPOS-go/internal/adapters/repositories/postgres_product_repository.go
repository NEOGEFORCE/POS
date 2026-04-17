package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type PostgresProductRepository struct {
	db *gorm.DB
}

func NewPostgresProductRepository(db *gorm.DB) *PostgresProductRepository {
	return &PostgresProductRepository{db: db}
}

func (r *PostgresProductRepository) Save(product *models.Product) error {
	return r.db.Create(product).Error
}

func (r *PostgresProductRepository) GetByBarcode(barcode string) (*models.Product, error) {
	var product models.Product
	err := r.db.Preload("Category").Where("barcode = ?", barcode).First(&product).Error
	return &product, err
}

func (r *PostgresProductRepository) GetAll() ([]models.Product, error) {
	var products []models.Product
	err := r.db.Preload("Category").Find(&products).Error
	return products, err
}

func (r *PostgresProductRepository) GetAllWithLimit(limit int) ([]models.Product, error) {
	var products []models.Product
	err := r.db.Preload("Category").Limit(limit).Find(&products).Error
	return products, err
}

func (r *PostgresProductRepository) GetPaginated(page, pageSize int, search string) ([]models.Product, int64, error) {
	var products []models.Product
	var total int64

	query := r.db.Model(&models.Product{})
	if search != "" {
		searchTerm := "%" + search + "%"
		query = query.Where("barcode ILIKE ? OR \"productName\" ILIKE ?", searchTerm, searchTerm)
	}

	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * pageSize
	err := query.Preload("Category").
		Order("\"productName\" ASC").
		Limit(pageSize).
		Offset(offset).
		Find(&products).Error

	return products, total, err
}

func (r *PostgresProductRepository) Update(barcode string, product *models.Product) error {
	return r.db.Model(&models.Product{}).Where("barcode = ?", barcode).Updates(product).Error
}

func (r *PostgresProductRepository) Delete(barcode string) error {
	return r.db.Where("barcode = ?", barcode).Delete(&models.Product{}).Error
}

func (r *PostgresProductRepository) UpdateQuantity(barcode string, newQuantity float64) error {
	return r.db.Model(&models.Product{}).Where("barcode = ?", barcode).Update("quantity", newQuantity).Error
}

func (r *PostgresProductRepository) BatchUpdateQuantities(updates map[string]float64) error {
	if len(updates) == 0 {
		return nil
	}

	tx := r.db.Begin()
	if tx.Error != nil {
		return tx.Error
	}

	for barcode, newQty := range updates {
		if err := tx.Model(&models.Product{}).Where("barcode = ?", barcode).Update("quantity", newQty).Error; err != nil {
			tx.Rollback()
			return err
		}
	}

	return tx.Commit().Error
}

func (r *PostgresProductRepository) Count() (int64, error) {
	var count int64
	err := r.db.Model(&models.Product{}).Count(&count).Error
	return count, err
}

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

	// Post-procesamiento para margen y promedio (igual que en JS)
	for i, s := range stats {
		stats[i].TotalCost = float64(s.UnitsSold) * s.PurchasePrice
		stats[i].GrossMargin = s.TotalRevenue - stats[i].TotalCost
		// El cálculo de avgSoldPerDay se hará en el servicio (necesita lógica de días)
	}

	return stats, nil
}

func (r *PostgresProductRepository) UpdateSupplierPrice(barcode string, supplierID uint, price float64) error {
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "productBarcode"}, {Name: "supplierId"}},
		DoUpdates: clause.AssignmentColumns([]string{"purchasePrice", "updatedAt"}),
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
	err := r.db.Preload("Category").
		Where("\"supplierId\" = ?", supplierID).
		Find(&products).Error
	return products, err
}

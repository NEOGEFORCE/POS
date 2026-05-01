package repositories

import (
	"time"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/infrastructure/cache"
	"gorm.io/gorm"
)

type PostgresCategoryRepository struct {
	db *gorm.DB
}

func NewPostgresCategoryRepository(db *gorm.DB) *PostgresCategoryRepository {
	return &PostgresCategoryRepository{db: db}
}

func (r *PostgresCategoryRepository) Save(category *models.Category) error {
	err := r.db.Create(category).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyCategories)
		cache.InvalidateCache(cache.CacheKeyCategoryCount)
	}
	return err
}

func (r *PostgresCategoryRepository) GetByID(id uint) (*models.Category, error) {
	var category models.Category
	err := r.db.First(&category, id).Error
	return &category, err
}

func (r *PostgresCategoryRepository) GetByName(name string) (*models.Category, error) {
	var category models.Category
	err := r.db.Where("UPPER(name) = UPPER(?)", name).First(&category).Error
	return &category, err
}

func (r *PostgresCategoryRepository) GetAll() ([]models.Category, error) {
	// CACHÉ L1: Intentar recuperar de RAM primero
	if cached, found := cache.CacheManager.Get(cache.CacheKeyCategories); found {
		return cached.([]models.Category), nil
	}

	var categories []models.Category
	// 1. Obtener las categorías ordenadas y el conteo de productos en una sola consulta
	rows, err := r.db.Table("categories").
		Select("categories.*, COUNT(products.barcode) as product_count").
		Joins("LEFT JOIN products ON products.\"categoryId\" = categories.id AND products.deleted_at IS NULL").
		Where("categories.is_active = ?", true).
		Group("categories.id").
		Order("name ASC").
		Rows()

	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var category models.Category
		if err := r.db.ScanRows(rows, &category); err != nil {
			return nil, err
		}
		categories = append(categories, category)
	}

	// PERSISTENCIA EN RAM: Guardar si la consulta fue exitosa
	if err == nil {
		cache.CacheManager.Set(cache.CacheKeyCategories, categories, 24*time.Hour)
	}

	return categories, nil
}

func (r *PostgresCategoryRepository) Update(id uint, category *models.Category) error {
	err := r.db.Model(&models.Category{}).Where("id = ?", id).Updates(category).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyCategories)
		cache.InvalidateCache(cache.CacheKeyCategoryCount)
	}
	return err
}

func (r *PostgresCategoryRepository) Delete(id uint) error {
	err := r.db.Model(&models.Category{}).Where("id = ?", id).Update("is_active", false).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeyCategories)
		cache.InvalidateCache(cache.CacheKeyCategoryCount)
	}
	return err
}
func (r *PostgresCategoryRepository) Count() (int64, error) {
	if cached, found := cache.CacheManager.Get(cache.CacheKeyCategoryCount); found {
		return cached.(int64), nil
	}
	var count int64
	err := r.db.Model(&models.Category{}).Where("is_active = ?", true).Count(&count).Error
	if err == nil {
		cache.CacheManager.Set(cache.CacheKeyCategoryCount, count, 1*time.Hour)
	}
	return count, err
}

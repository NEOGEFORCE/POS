package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

type PostgresCategoryRepository struct {
	db *gorm.DB
}

func NewPostgresCategoryRepository(db *gorm.DB) *PostgresCategoryRepository {
	return &PostgresCategoryRepository{db: db}
}

func (r *PostgresCategoryRepository) Save(category *models.Category) error {
	return r.db.Create(category).Error
}

func (r *PostgresCategoryRepository) GetByID(id uint) (*models.Category, error) {
	var category models.Category
	err := r.db.First(&category, id).Error
	return &category, err
}

func (r *PostgresCategoryRepository) GetAll() ([]models.Category, error) {
	categories := []models.Category{} // Inicializar como lista vacía, no nil
	err := r.db.Find(&categories).Error
	return categories, err
}

func (r *PostgresCategoryRepository) Update(id uint, category *models.Category) error {
	return r.db.Model(&models.Category{}).Where("id = ?", id).Updates(category).Error
}

func (r *PostgresCategoryRepository) Delete(id uint) error {
	return r.db.Delete(&models.Category{}, id).Error
}

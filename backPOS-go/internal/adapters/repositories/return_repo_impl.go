package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

type GormReturnRepository struct {
	db *gorm.DB
}

func NewGormReturnRepository(db *gorm.DB) *GormReturnRepository {
	return &GormReturnRepository{db: db}
}

func (r *GormReturnRepository) Create(ret *models.Return) error {
	return r.db.Create(ret).Error
}

func (r *GormReturnRepository) GetByID(id uint) (*models.Return, error) {
	var ret models.Return
	err := r.db.Preload("Details.Product").Preload("Sale").First(&ret, id).Error
	return &ret, err
}

func (r *GormReturnRepository) GetAll() ([]models.Return, error) {
	var returns []models.Return
	err := r.db.Preload("Employee").Order("date desc").Find(&returns).Error
	return returns, err
}

func (r *GormReturnRepository) GetByDateRange(from, to string) ([]models.Return, error) {
	var returns []models.Return
	query := r.db.Model(&models.Return{})
	if from != "" {
		query = query.Where("date >= ?", from)
	}
	if to != "" {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date desc").Find(&returns).Error
	return returns, err
}

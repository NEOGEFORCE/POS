package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

type closureRepository struct {
	db *gorm.DB
}

func NewClosureRepository(db *gorm.DB) *closureRepository {
	return &closureRepository{db: db}
}

func (r *closureRepository) Save(closure *models.CashierClosure) error {
	return r.db.Save(closure).Error
}

func (r *closureRepository) GetAll() ([]models.CashierClosure, error) {
	var closures []models.CashierClosure
	err := r.db.Order("id DESC").Find(&closures).Error
	return closures, err
}

func (r *closureRepository) GetByID(id uint) (*models.CashierClosure, error) {
	var closure models.CashierClosure
	err := r.db.First(&closure, id).Error
	if err != nil {
		return nil, err
	}
	return &closure, nil
}

func (r *closureRepository) GetLast() (*models.CashierClosure, error) {
	var closure models.CashierClosure
	err := r.db.Order("id DESC").First(&closure).Error
	if err != nil {
		return nil, err
	}
	return &closure, nil
}

package repositories

import (
	"errors"

	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

type activeShiftRepository struct {
	db *gorm.DB
}

func NewActiveShiftRepository(db *gorm.DB) *activeShiftRepository {
	return &activeShiftRepository{db: db}
}

func (r *activeShiftRepository) GetActive() (*models.ActiveShift, error) {
	var shift models.ActiveShift
	err := r.db.Where("status = ?", "OPEN").First(&shift).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &shift, nil
}

func (r *activeShiftRepository) Save(shift *models.ActiveShift) error {
	return r.db.Save(shift).Error
}

func (r *activeShiftRepository) CloseActive() error {
	return r.db.Model(&models.ActiveShift{}).Where("status = ?", "OPEN").Update("status", "CLOSED").Error
}

func (r *activeShiftRepository) SaveWithTx(tx interface{}, shift *models.ActiveShift) error {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return gorm.ErrInvalidDB
	}
	return gormTx.Save(shift).Error
}

func (r *activeShiftRepository) CloseActiveWithTx(tx interface{}) error {
	gormTx, ok := tx.(*gorm.DB)
	if !ok {
		return gorm.ErrInvalidDB
	}
	return gormTx.Model(&models.ActiveShift{}).Where("status = ?", "OPEN").Update("status", "CLOSED").Error
}

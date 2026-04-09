package ports

import "backPOS-go/internal/core/domain/models"

type ReturnRepository interface {
	Create(ret *models.Return) error
	GetByID(id uint) (*models.Return, error)
	GetAll() ([]models.Return, error)
	GetByDateRange(from, to string) ([]models.Return, error)
}

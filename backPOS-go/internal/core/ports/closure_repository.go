package ports

import (
	"backPOS-go/internal/core/domain/models"
)

type ClosureRepository interface {
	Save(closure *models.CashierClosure) error
	GetAll() ([]models.CashierClosure, error)
	GetByID(id uint) (*models.CashierClosure, error)
	GetLast() (*models.CashierClosure, error)
}

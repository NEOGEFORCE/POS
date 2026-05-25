package ports

import (
	"backPOS-go/internal/core/domain/models"
)

type ClosureRepository interface {
	Save(closure *models.CashierClosure) error
	GetAll() ([]models.CashierClosure, error)
	GetByID(id uint) (*models.CashierClosure, error)
	GetLast() (*models.CashierClosure, error)
	GetGlobalReportedBalance() (float64, error)
	GetGlobalReportedBalanceByMethod() (map[string]float64, error)
	GetGlobalCoins() (map[string]float64, error)
	GetGlobalDifferenceSum() (float64, error)
	GetGlobalHistoricalSum() (expected float64, real float64, err error)
	Delete(id uint) error
	Update(id uint, updates map[string]interface{}) error
}

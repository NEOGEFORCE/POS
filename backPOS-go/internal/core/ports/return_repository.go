package ports

import (
	"backPOS-go/internal/core/domain/models"
	"time"
)

type ReturnRepository interface {
	Create(ret *models.Return) error
	CreateWithTransaction(ret *models.Return, employeeDNI string, employeeName string, adjustments map[string]float64, movements []*models.StockMovement) error
	GetByID(id uint) (*models.Return, error)
	GetAll() ([]models.Return, error)
	GetByDateRange(from, to time.Time) ([]models.Return, error)
	GetTotalReturnedByRange(from, to time.Time) (float64, error)
}

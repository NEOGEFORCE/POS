package ports

import (
	"backPOS-go/internal/core/domain/models"
	"time"
)

type StockMovementRepository interface {
	Save(movement *models.StockMovement) error
	SaveWithTx(tx interface{}, movement *models.StockMovement) error
	GetByProduct(barcode string, from, to time.Time) ([]models.StockMovement, error)
	GetByDateRange(from, to time.Time) ([]models.StockMovement, error)
}

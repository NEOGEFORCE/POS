package ports

import "backPOS-go/internal/core/domain/models"

type StockMovementRepository interface {
	Save(movement *models.StockMovement) error
	GetByProduct(barcode string, from, to string) ([]models.StockMovement, error)
	GetByDateRange(from, to string) ([]models.StockMovement, error)
}

package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

type PostgresStockMovementRepository struct {
	db *gorm.DB
}

func NewPostgresStockMovementRepository(db *gorm.DB) *PostgresStockMovementRepository {
	return &PostgresStockMovementRepository{db: db}
}

func (r *PostgresStockMovementRepository) Save(movement *models.StockMovement) error {
	return r.db.Create(movement).Error
}

func (r *PostgresStockMovementRepository) GetByProduct(barcode string, from, to string) ([]models.StockMovement, error) {
	var movements []models.StockMovement
	query := r.db.Preload("Product").Where("barcode = ?", barcode)
	if from != "" {
		query = query.Where("date >= ?", from)
	}
	if to != "" {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date DESC").Find(&movements).Error
	return movements, err
}

func (r *PostgresStockMovementRepository) GetByDateRange(from, to string) ([]models.StockMovement, error) {
	var movements []models.StockMovement
	query := r.db.Preload("Product")
	if from != "" {
		query = query.Where("date >= ?", from)
	}
	if to != "" {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date DESC").Find(&movements).Error
	return movements, err
}

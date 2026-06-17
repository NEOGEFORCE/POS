package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
	"time"
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

func (r *PostgresStockMovementRepository) SaveWithTx(tx interface{}, movement *models.StockMovement) error {
	gormDB, ok := tx.(*gorm.DB)
	if !ok {
		return r.Save(movement)
	}
	return gormDB.Create(movement).Error
}

// BatchSaveWithTx inserta N movimientos en una sola operación batch (CreateInBatches
// con tamaño 100). Reduce drásticamente el round-trip a Postgres en ventas con
// muchos items: en lugar de N INSERTs secuenciales (cada uno con su latencia
// de red/disco), realiza ⌈N/100⌉ sentencias multi-fila.
//
// Pasa transparentemente cualquier transacción activa; si tx no es *gorm.DB
// cae al db base del repo. Retorna nil si la lista viene vacía.
func (r *PostgresStockMovementRepository) BatchSaveWithTx(tx interface{}, movements []models.StockMovement) error {
	if len(movements) == 0 {
		return nil
	}
	gormDB, ok := tx.(*gorm.DB)
	if !ok {
		gormDB = r.db
	}
	return gormDB.CreateInBatches(movements, 100).Error
}

func (r *PostgresStockMovementRepository) GetByProduct(barcode string, from, to time.Time) ([]models.StockMovement, error) {
	var movements []models.StockMovement
	query := r.db.Preload("Product").Where("barcode = ?", barcode)
	if !from.IsZero() {
		query = query.Where("date >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date DESC").Find(&movements).Error
	return movements, err
}

func (r *PostgresStockMovementRepository) GetByDateRange(from, to time.Time) ([]models.StockMovement, error) {
	var movements []models.StockMovement
	query := r.db.Preload("Product")
	if !from.IsZero() {
		query = query.Where("date >= ?", from)
	}
	if !to.IsZero() {
		query = query.Where("date <= ?", to)
	}
	err := query.Order("date DESC").Find(&movements).Error
	return movements, err
}
func (r *PostgresStockMovementRepository) GetLastMovementByBarcodeAndReason(barcode string, reason string) (*models.StockMovement, error) {
	var movement models.StockMovement
	err := r.db.Where("barcode = ? AND reason = ?", barcode, reason).Order("date DESC").First(&movement).Error
	if err != nil {
		return nil, err
	}
	return &movement, nil
}

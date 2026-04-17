package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"time"

	"gorm.io/gorm"
)

type PostgresPurchaseOrderRepository struct {
	db *gorm.DB
}

func NewPostgresPurchaseOrderRepository(db *gorm.DB) *PostgresPurchaseOrderRepository {
	return &PostgresPurchaseOrderRepository{db: db}
}

func (r *PostgresPurchaseOrderRepository) Save(order *models.PurchaseOrder) error {
	return r.db.Create(order).Error
}

func (r *PostgresPurchaseOrderRepository) GetByID(id uint) (*models.PurchaseOrder, error) {
	var order models.PurchaseOrder
	err := r.db.Preload("Supplier").Preload("OrderItems.Product").First(&order, id).Error
	return &order, err
}

func (r *PostgresPurchaseOrderRepository) GetAll() ([]models.PurchaseOrder, error) {
	var orders []models.PurchaseOrder
	err := r.db.Preload("Supplier").Find(&orders).Error
	return orders, err
}

func (r *PostgresPurchaseOrderRepository) GetPendingByDeliveryDate(date time.Time) ([]models.PurchaseOrder, error) {
	var orders []models.PurchaseOrder
	// Start and end of the day for filtering
	start := time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, date.Location())
	end := start.Add(24 * time.Hour)

	err := r.db.Preload("Supplier").
		Where("status = ? AND deliveryDate >= ? AND deliveryDate < ?", models.PurchaseOrderPending, start, end).
		Find(&orders).Error
	return orders, err
}

func (r *PostgresPurchaseOrderRepository) UpdateStatus(id uint, status models.PurchaseOrderStatus) error {
	return r.db.Model(&models.PurchaseOrder{}).Where("id = ?", id).Update("status", status).Error
}

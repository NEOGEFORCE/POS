package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"log"

	"gorm.io/gorm"
)

type PostgresExpectedOrderRepository struct {
	db *gorm.DB
}

func NewPostgresExpectedOrderRepository(db *gorm.DB) *PostgresExpectedOrderRepository {
	return &PostgresExpectedOrderRepository{db: db}
}

// Save crea un nuevo pedido esperado
func (r *PostgresExpectedOrderRepository) Save(order *models.ExpectedOrder) error {
	return r.db.Create(order).Error
}

// GetByID obtiene un pedido esperado por ID
func (r *PostgresExpectedOrderRepository) GetByID(id uint) (*models.ExpectedOrder, error) {
	var order models.ExpectedOrder
	err := r.db.Preload("Supplier").First(&order, id).Error
	return &order, err
}

// GetAll obtiene todos los pedidos esperados
func (r *PostgresExpectedOrderRepository) GetAll() ([]models.ExpectedOrder, error) {
	var orders []models.ExpectedOrder
	err := r.db.Preload("Supplier").Order("expectedDate ASC").Find(&orders).Error
	return orders, err
}

// GetExpectedToday obtiene los pedidos esperados para hoy (fecha actual)
func (r *PostgresExpectedOrderRepository) GetExpectedToday() ([]models.ExpectedOrder, error) {
	var orders []models.ExpectedOrder

	err := r.db.Preload("Supplier").
		Where("DATE(\"expectedDate\") = CURRENT_DATE AND status = ?", "PENDING").
		Order("\"expectedDate\" ASC").
		Find(&orders).Error

	if err != nil {
		log.Printf("[GetExpectedToday] ERROR EN CONSULTA: %v", err)
		return nil, err
	}

	log.Printf("[GetExpectedToday] Éxito: %d pedidos encontrados para hoy", len(orders))
	return orders, nil
}

// GetBySupplier obtiene pedidos esperados por proveedor
func (r *PostgresExpectedOrderRepository) GetBySupplier(supplierID uint) ([]models.ExpectedOrder, error) {
	var orders []models.ExpectedOrder
	err := r.db.Preload("Supplier").
		Where("supplierId = ? AND status = ?", supplierID, "PENDING").
		Order("expectedDate ASC").
		Find(&orders).Error
	return orders, err
}

// UpdateStatus actualiza el estado de un pedido esperado
func (r *PostgresExpectedOrderRepository) UpdateStatus(id uint, status string) error {
	return r.db.Model(&models.ExpectedOrder{}).Where("id = ?", id).Update("status", status).Error
}

// Delete elimina un pedido esperado (soft delete)
func (r *PostgresExpectedOrderRepository) Delete(id uint) error {
	return r.db.Delete(&models.ExpectedOrder{}, id).Error
}

// GetSupplierByName busca un proveedor por nombre (case insensitive)
func (r *PostgresExpectedOrderRepository) GetSupplierByName(name string) (*models.Supplier, error) {
	var supplier models.Supplier
	err := r.db.Where("LOWER(name) = LOWER(?)", name).First(&supplier).Error
	if err != nil {
		return nil, err
	}
	return &supplier, nil
}

// CreateSupplier crea un nuevo proveedor
func (r *PostgresExpectedOrderRepository) CreateSupplier(supplier *models.Supplier) error {
	return r.db.Create(supplier).Error
}

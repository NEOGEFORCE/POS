package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"gorm.io/gorm"
)

type PostgresSupplierRepository struct {
	db *gorm.DB
}

func NewPostgresSupplierRepository(db *gorm.DB) *PostgresSupplierRepository {
	return &PostgresSupplierRepository{db: db}
}

func (r *PostgresSupplierRepository) Save(supplier *models.Supplier) error {
	return r.db.Create(supplier).Error
}

func (r *PostgresSupplierRepository) GetByID(id uint) (*models.Supplier, error) {
	var supplier models.Supplier
	err := r.db.First(&supplier, id).Error
	return &supplier, err
}

func (r *PostgresSupplierRepository) GetAll() ([]models.Supplier, error) {
	suppliers := []models.Supplier{}
	err := r.db.Find(&suppliers).Error
	return suppliers, err
}

func (r *PostgresSupplierRepository) Update(id uint, supplier *models.Supplier) error {
	return r.db.Model(&models.Supplier{}).Where("id = ?", id).Updates(supplier).Error
}

func (r *PostgresSupplierRepository) Delete(id uint) error {
	return r.db.Delete(&models.Supplier{}, id).Error
}

package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"fmt"
	"log"

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
	log.Printf("[PostgresSupplierRepository] Iniciando GetAll...")

	suppliers := []models.Supplier{}

	// Usar Find simple con Limit y Order
	log.Printf("[PostgresSupplierRepository] Ejecutando consulta Find con LIMIT 100...")
	err := r.db.Order("name ASC").Limit(100).Find(&suppliers).Error

	if err != nil {
		log.Printf("[PostgresSupplierRepository] ERROR en consulta SQL: %v", err)
		return nil, fmt.Errorf("error SQL en GetAll: %w", err)
	}

	log.Printf("[PostgresSupplierRepository] Consulta exitosa: %d proveedores encontrados", len(suppliers))

	// Log detallado de los primeros proveedores para debug
	for i, s := range suppliers {
		if i < 5 {
			log.Printf("[PostgresSupplierRepository] Proveedor %d: id=%d, name=%s", i, s.ID, s.Name)
		}
	}
	if len(suppliers) > 5 {
		log.Printf("[PostgresSupplierRepository] ... y %d proveedores más", len(suppliers)-5)
	}

	return suppliers, nil
}

func (r *PostgresSupplierRepository) Update(id uint, supplier *models.Supplier) error {
	return r.db.Model(&models.Supplier{}).Where("id = ?", id).Updates(supplier).Error
}

func (r *PostgresSupplierRepository) Delete(id uint) error {
	return r.db.Delete(&models.Supplier{}, id).Error
}

func (r *PostgresSupplierRepository) GetByVisitDay(day string) ([]models.Supplier, error) {
	var suppliers []models.Supplier
	err := r.db.Where("\"visitDay\" = ?", day).Order("name ASC").Limit(100).Find(&suppliers).Error
	return suppliers, err
}

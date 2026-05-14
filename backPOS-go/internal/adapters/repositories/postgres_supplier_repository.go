package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"fmt"
	"log"

	"backPOS-go/internal/infrastructure/cache"
	"backPOS-go/internal/infrastructure/sse"
	"gorm.io/gorm"
)

type PostgresSupplierRepository struct {
	db *gorm.DB
}

func NewPostgresSupplierRepository(db *gorm.DB) *PostgresSupplierRepository {
	return &PostgresSupplierRepository{db: db}
}

func (r *PostgresSupplierRepository) Save(supplier *models.Supplier) error {
	err := r.db.Create(supplier).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeySuppliers)
		sse.GetSSEService().Broadcast("SUPPLIER_UPDATE", nil)
	}
	return err
}

func (r *PostgresSupplierRepository) GetByID(id uint) (*models.Supplier, error) {
	var supplier models.Supplier
	err := r.db.First(&supplier, id).Error
	return &supplier, err
}

func (r *PostgresSupplierRepository) GetByName(name string) (*models.Supplier, error) {
	var supplier models.Supplier
	err := r.db.Where("UPPER(name) = UPPER(?)", name).First(&supplier).Error
	return &supplier, err
}

func (r *PostgresSupplierRepository) GetAll() ([]models.Supplier, error) {
	log.Printf("[PostgresSupplierRepository] Iniciando GetAll...")

	suppliers := []models.Supplier{}

	// Usar Find simple con Limit y Order
	log.Printf("[PostgresSupplierRepository] Ejecutando consulta Find con LIMIT 100...")
	err := r.db.Where("\"is_active\" = ?", true).Order("name ASC").Limit(100).Find(&suppliers).Error

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
	err := r.db.Model(&models.Supplier{}).Where("id = ?", id).Updates(supplier).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeySuppliers)
		sse.GetSSEService().Broadcast("SUPPLIER_UPDATE", nil)
	}
	return err
}

func (r *PostgresSupplierRepository) Delete(id uint) error {
	err := r.db.Model(&models.Supplier{}).Where("id = ?", id).Update("is_active", false).Error
	if err == nil {
		cache.InvalidateCache(cache.CacheKeySuppliers)
		sse.GetSSEService().Broadcast("SUPPLIER_UPDATE", nil)
	}
	return err
}

func (r *PostgresSupplierRepository) GetByVisitDay(day string) ([]models.Supplier, error) {
	var suppliers []models.Supplier
	err := r.db.Where("\"visitDay\" = ? AND \"is_active\" = ?", day, true).Order("name ASC").Limit(100).Find(&suppliers).Error
	return suppliers, err
}

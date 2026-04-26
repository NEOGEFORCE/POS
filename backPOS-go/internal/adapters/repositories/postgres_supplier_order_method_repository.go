package repositories

import (
	"encoding/json"
	"errors"

	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"

	"gorm.io/gorm"
)

type PostgresSupplierOrderMethodRepository struct {
	db *gorm.DB
}

func NewPostgresSupplierOrderMethodRepository(db *gorm.DB) ports.SupplierOrderMethodRepository {
	return &PostgresSupplierOrderMethodRepository{db: db}
}

func (r *PostgresSupplierOrderMethodRepository) Create(method *models.SupplierOrderMethod) error {
	// Convertir VisitDays a JSON
	if len(method.VisitDays) > 0 {
		jsonBytes, err := json.Marshal(method.VisitDays)
		if err != nil {
			return err
		}
		method.VisitDaysJSON = string(jsonBytes)
	}
	return r.db.Create(method).Error
}

func (r *PostgresSupplierOrderMethodRepository) GetByID(id uint) (*models.SupplierOrderMethod, error) {
	var method models.SupplierOrderMethod
	err := r.db.Preload("Supplier").First(&method, id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	// Parsear VisitDays desde JSON
	if method.VisitDaysJSON != "" {
		json.Unmarshal([]byte(method.VisitDaysJSON), &method.VisitDays)
	}
	return &method, nil
}

func (r *PostgresSupplierOrderMethodRepository) GetBySupplierID(supplierID uint) ([]models.SupplierOrderMethod, error) {
	var methods []models.SupplierOrderMethod
	err := r.db.Where("supplier_id = ? AND is_active = ?", supplierID, true).Find(&methods).Error
	if err != nil {
		return nil, err
	}
	// Parsear VisitDays para cada método
	for i := range methods {
		if methods[i].VisitDaysJSON != "" {
			json.Unmarshal([]byte(methods[i].VisitDaysJSON), &methods[i].VisitDays)
		}
	}
	return methods, nil
}

func (r *PostgresSupplierOrderMethodRepository) Update(method *models.SupplierOrderMethod) error {
	// Convertir VisitDays a JSON
	if len(method.VisitDays) > 0 {
		jsonBytes, err := json.Marshal(method.VisitDays)
		if err != nil {
			return err
		}
		method.VisitDaysJSON = string(jsonBytes)
	}
	return r.db.Save(method).Error
}

func (r *PostgresSupplierOrderMethodRepository) Delete(id uint) error {
	return r.db.Delete(&models.SupplierOrderMethod{}, id).Error
}

func (r *PostgresSupplierOrderMethodRepository) GetAllActive() ([]models.SupplierOrderMethod, error) {
	var methods []models.SupplierOrderMethod
	err := r.db.Where("is_active = ?", true).Preload("Supplier").Find(&methods).Error
	if err != nil {
		return nil, err
	}
	// Parsear VisitDays para cada método
	for i := range methods {
		if methods[i].VisitDaysJSON != "" {
			json.Unmarshal([]byte(methods[i].VisitDaysJSON), &methods[i].VisitDays)
		}
	}
	return methods, nil
}

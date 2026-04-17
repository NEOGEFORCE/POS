package services

import (
	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
)

type SupplierService struct {
	repo *repositories.PostgresSupplierRepository
}

func NewSupplierService(repo *repositories.PostgresSupplierRepository) *SupplierService {
	return &SupplierService{repo: repo}
}

func (s *SupplierService) CreateSupplier(supplier *models.Supplier) error {
	return s.repo.Save(supplier)
}

func (s *SupplierService) GetSupplier(id uint) (*models.Supplier, error) {
	return s.repo.GetByID(id)
}

func (s *SupplierService) GetAllSuppliers() ([]models.Supplier, error) {
	return s.repo.GetAll()
}

func (s *SupplierService) UpdateSupplier(id uint, supplier *models.Supplier) error {
	return s.repo.Update(id, supplier)
}

func (s *SupplierService) DeleteSupplier(id uint) error {
	return s.repo.Delete(id)
}

func (s *SupplierService) GetSuppliersByVisitDay(day string) ([]models.Supplier, error) {
	return s.repo.GetByVisitDay(day)
}

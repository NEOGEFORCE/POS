package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type SupplierOrderMethodService struct {
	repo ports.SupplierOrderMethodRepository
}

func NewSupplierOrderMethodService(repo ports.SupplierOrderMethodRepository) *SupplierOrderMethodService {
	return &SupplierOrderMethodService{repo: repo}
}

func (s *SupplierOrderMethodService) CreateMethod(method *models.SupplierOrderMethod) error {
	return s.repo.Create(method)
}

func (s *SupplierOrderMethodService) GetMethodByID(id uint) (*models.SupplierOrderMethod, error) {
	return s.repo.GetByID(id)
}

func (s *SupplierOrderMethodService) GetMethodsBySupplier(supplierID uint) ([]models.SupplierOrderMethod, error) {
	return s.repo.GetBySupplierID(supplierID)
}

func (s *SupplierOrderMethodService) UpdateMethod(method *models.SupplierOrderMethod) error {
	return s.repo.Update(method)
}

func (s *SupplierOrderMethodService) DeleteMethod(id uint) error {
	return s.repo.Delete(id)
}

func (s *SupplierOrderMethodService) GetAllActiveMethods() ([]models.SupplierOrderMethod, error) {
	return s.repo.GetAllActive()
}

// CalculateEffectiveLeadTime calcula el lead time efectivo considerando el método seleccionado
func (s *SupplierOrderMethodService) CalculateEffectiveLeadTime(methodID uint, baseCoverageDays int) (int, error) {
	if methodID == 0 {
		// Sin método específico, usar cobertura base
		return baseCoverageDays, nil
	}
	
	method, err := s.repo.GetByID(methodID)
	if err != nil {
		return baseCoverageDays, err
	}
	if method == nil {
		return baseCoverageDays, nil
	}
	
	// Lead time efectivo = días de cobertura deseados + lead time del método
	effectiveLeadTime := baseCoverageDays + method.LeadTimeDays
	return effectiveLeadTime, nil
}

package services

import (
	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"time"
)

type PurchaseOrderService struct {
	repo         *repositories.PostgresPurchaseOrderRepository
	supplierRepo *repositories.PostgresSupplierRepository
}

func NewPurchaseOrderService(repo *repositories.PostgresPurchaseOrderRepository, supplierRepo *repositories.PostgresSupplierRepository) *PurchaseOrderService {
	return &PurchaseOrderService{repo: repo, supplierRepo: supplierRepo}
}

func (s *PurchaseOrderService) CreateOrder(order *models.PurchaseOrder) error {
	if err := s.repo.Save(order); err != nil {
		return err
	}

	// Auto-aprendizaje de ruta: día actual = día de visita/preventa del
	// proveedor (visit_days, JSONB anti-duplicados). No-fatal.
	if s.supplierRepo != nil && order.SupplierID != 0 {
		_ = s.supplierRepo.LearnDay(order.SupplierID, "visit_days")
	}

	return nil
}

func (s *PurchaseOrderService) GetOrder(id uint) (*models.PurchaseOrder, error) {
	return s.repo.GetByID(id)
}

func (s *PurchaseOrderService) GetAllOrders() ([]models.PurchaseOrder, error) {
	return s.repo.GetAll()
}

func (s *PurchaseOrderService) UpdateOrderStatus(id uint, status models.PurchaseOrderStatus) error {
	return s.repo.UpdateStatus(id, status)
}

func (s *PurchaseOrderService) GetPendingOrdersBySupplier(supplierID uint) ([]models.PurchaseOrder, error) {
	return s.repo.GetBySupplierAndStatus(supplierID, models.PurchaseOrderPending)
}

func (s *PurchaseOrderService) GetPendingOrdersByDeliveryDate(date time.Time) ([]models.PurchaseOrder, error) {
	return s.repo.GetPendingByDeliveryDate(date)
}

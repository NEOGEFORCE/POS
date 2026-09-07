package services

import (
	"time"

	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
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

	// Auto-aprendizaje de visit_days ELIMINADO de este flujo. El
	// aprendizaje real corre en el batch nocturno y persiste SÓLO en
	// las columnas learned_* (regla del dueño: suppliers.visit_days
	// es dato manual sagrado).
	_ = order

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

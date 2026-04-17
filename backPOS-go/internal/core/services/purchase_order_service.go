package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/adapters/repositories"
	"time"
)

type PurchaseOrderService struct {
	repo *repositories.PostgresPurchaseOrderRepository
}

func NewPurchaseOrderService(repo *repositories.PostgresPurchaseOrderRepository) *PurchaseOrderService {
	return &PurchaseOrderService{repo: repo}
}

func (s *PurchaseOrderService) CreateOrder(order *models.PurchaseOrder) error {
	return s.repo.Save(order)
}

func (s *PurchaseOrderService) GetOrder(id uint) (*models.PurchaseOrder, error) {
	return s.repo.GetByID(id)
}

func (s *PurchaseOrderService) GetAllOrders() ([]models.PurchaseOrder, error) {
	return s.repo.GetAll()
}

func (s *PurchaseOrderService) GetPendingOrdersByDeliveryDate(date time.Time) ([]models.PurchaseOrder, error) {
	return s.repo.GetPendingByDeliveryDate(date)
}

func (s *PurchaseOrderService) UpdateOrderStatus(id uint, status models.PurchaseOrderStatus) error {
	return s.repo.UpdateStatus(id, status)
}

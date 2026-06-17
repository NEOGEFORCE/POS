package services

import (
	"backPOS-go/internal/adapters/repositories"
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type RestockService struct {
	repo         ports.RestockRepository
	supplierRepo *repositories.PostgresSupplierRepository
}

func NewRestockService(repo ports.RestockRepository, supplierRepo *repositories.PostgresSupplierRepository) *RestockService {
	return &RestockService{repo: repo, supplierRepo: supplierRepo}
}

func (s *RestockService) GetActivePurchaseList() ([]models.ActivePurchaseList, error) {
	return s.repo.GetActivePurchaseList()
}

func (s *RestockService) AddPurchaseListItem(item *models.ActivePurchaseList) error {
	item.Status = "pending"
	return s.repo.AddPurchaseListItem(item)
}

func (s *RestockService) RemovePurchaseListItem(id string) error {
	return s.repo.RemovePurchaseListItem(id)
}

func (s *RestockService) ConfirmOrder(supplierID uint, expectedDate, invoiceRef string, items []models.ConfirmedOrderItem, estimatedTotal, realInvoiceTotal float64, confirmedBy string, editOrderID string) error {
	if editOrderID != "" {
		if err := s.repo.DeleteOrderAndItems(editOrderID); err != nil {
			return err
		}
	}

	order := &models.ConfirmedOrder{
		SupplierID:       supplierID,
		ExpectedDate:     expectedDate,
		InvoiceRef:       invoiceRef,
		EstimatedTotal:   estimatedTotal,
		RealInvoiceTotal: realInvoiceTotal,
		Status:           "pending",
		ConfirmedBy:      confirmedBy,
	}

	err := s.repo.CreateConfirmedOrder(order, items)
	if err != nil {
		return err
	}

	// Auto-aprendizaje de ruta: el día en que se confirma un pedido es el día
	// de preventa/visita del proveedor. Se registra en visit_days (JSONB
	// anti-duplicados). No-fatal: si falla no rompe la creación del pedido.
	if s.supplierRepo != nil && supplierID != 0 {
		_ = s.supplierRepo.LearnDay(supplierID, "visit_days")
	}

	return s.repo.ClearPurchaseList(supplierID)
}

func (s *RestockService) GetPendingOrders() ([]models.ConfirmedOrder, error) {
	return s.repo.GetPendingOrders()
}

func (s *RestockService) GetPendingOrdersBySupplier(supplierID uint) ([]models.ConfirmedOrder, error) {
	return s.repo.GetPendingOrdersBySupplier(supplierID)
}

func (s *RestockService) GetOrdersHistory(limit, offset int, filters map[string]interface{}) ([]models.ConfirmedOrder, int64, error) {
	return s.repo.GetOrdersHistory(limit, offset, filters)
}

func (s *RestockService) GetOrderByID(id string) (*models.ConfirmedOrder, error) {
	return s.repo.GetOrderByID(id)
}

func (s *RestockService) UpdateOrderStatus(id string, status string, receivedBy string) error {
	return s.repo.UpdateOrderStatus(id, status, receivedBy)
}

package services

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"
)

type RestockService struct {
	repo ports.RestockRepository
}

func NewRestockService(repo ports.RestockRepository) *RestockService {
	return &RestockService{repo: repo}
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

func (s *RestockService) ConfirmOrder(supplierID uint, estimatedTotal, realInvoiceTotal float64, confirmedBy string) error {
	// First get the active items for this supplier
	activeList, err := s.repo.GetActivePurchaseList()
	if err != nil {
		return err
	}

	var items []models.ConfirmedOrderItem
	for _, item := range activeList {
		if item.SupplierID == supplierID {
			items = append(items, models.ConfirmedOrderItem{
				ProductID:      item.ProductID,
				Quantity:       item.Quantity,
				EstimatedPrice: 0, // We could pull this from product if needed, but UI calculates total
			})
		}
	}

	if len(items) == 0 {
		return nil // Nothing to confirm
	}

	order := &models.ConfirmedOrder{
		SupplierID:       supplierID,
		EstimatedTotal:   estimatedTotal,
		RealInvoiceTotal: realInvoiceTotal,
		Status:           "pending",
		ConfirmedBy:      confirmedBy,
	}

	err = s.repo.CreateConfirmedOrder(order, items)
	if err != nil {
		return err
	}
	return s.repo.ClearPurchaseList(supplierID)
}

func (s *RestockService) GetPendingOrders() ([]models.ConfirmedOrder, error) {
	return s.repo.GetPendingOrders()
}

func (s *RestockService) GetOrdersHistory(limit, offset int, filters map[string]interface{}) ([]models.ConfirmedOrder, int64, error) {
	return s.repo.GetOrdersHistory(limit, offset, filters)
}

func (s *RestockService) GetOrderByID(id string) (*models.ConfirmedOrder, error) {
	return s.repo.GetOrderByID(id)
}

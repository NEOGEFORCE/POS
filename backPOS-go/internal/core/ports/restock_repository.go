package ports

import "backPOS-go/internal/core/domain/models"

type RestockRepository interface {
	// ActivePurchaseList
	GetActivePurchaseList() ([]models.ActivePurchaseList, error)
	AddPurchaseListItem(item *models.ActivePurchaseList) error
	RemovePurchaseListItem(id string) error
	ClearPurchaseList(supplierID uint) error

	// ConfirmedOrder
	GetPendingOrders() ([]models.ConfirmedOrder, error)
	GetOrdersHistory(limit, offset int, filters map[string]interface{}) ([]models.ConfirmedOrder, int64, error)
	GetOrderByID(id string) (*models.ConfirmedOrder, error)
	CreateConfirmedOrder(order *models.ConfirmedOrder, items []models.ConfirmedOrderItem) error
	UpdateOrderStatus(id, status, receivedBy string) error
}

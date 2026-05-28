package repositories

import (
	"backPOS-go/internal/core/domain/models"
	"backPOS-go/internal/core/ports"

	"gorm.io/gorm"
)

type PostgresRestockRepository struct {
	db *gorm.DB
}

func NewPostgresRestockRepository(db *gorm.DB) ports.RestockRepository {
	return &PostgresRestockRepository{db: db}
}

func (r *PostgresRestockRepository) GetActivePurchaseList() ([]models.ActivePurchaseList, error) {
	var list []models.ActivePurchaseList
	err := r.db.Preload("Product").Preload("Supplier").Find(&list).Error
	return list, err
}

func (r *PostgresRestockRepository) AddPurchaseListItem(item *models.ActivePurchaseList) error {
	// Upsert based on product_id and supplier_id
	var existing models.ActivePurchaseList
	err := r.db.Where("product_id = ? AND supplier_id = ?", item.ProductID, item.SupplierID).First(&existing).Error
	if err == nil {
		existing.Quantity = item.Quantity
		existing.Status = item.Status
		return r.db.Save(&existing).Error
	}
	return r.db.Create(item).Error
}

func (r *PostgresRestockRepository) RemovePurchaseListItem(id string) error {
	return r.db.Where("id = ?", id).Delete(&models.ActivePurchaseList{}).Error
}

func (r *PostgresRestockRepository) ClearPurchaseList(supplierID uint) error {
	return r.db.Where("supplier_id = ?", supplierID).Delete(&models.ActivePurchaseList{}).Error
}

func (r *PostgresRestockRepository) GetPendingOrders() ([]models.ConfirmedOrder, error) {
	var orders []models.ConfirmedOrder
	err := r.db.Preload("Supplier").Preload("Items").Preload("Items.Product").Where("status != ?", "received").Where("status != ?", "dismissed").Order("confirmed_at asc").Find(&orders).Error
	return orders, err
}

func (r *PostgresRestockRepository) GetPendingOrdersBySupplier(supplierID uint) ([]models.ConfirmedOrder, error) {
	var orders []models.ConfirmedOrder
	err := r.db.Preload("Supplier").Preload("Items").Preload("Items.Product").Where("supplier_id = ?", supplierID).Where("status != ?", "received").Where("status != ?", "dismissed").Order("confirmed_at asc").Find(&orders).Error
	return orders, err
}

func (r *PostgresRestockRepository) GetOrdersHistory(limit, offset int, filters map[string]interface{}) ([]models.ConfirmedOrder, int64, error) {
	var orders []models.ConfirmedOrder
	var total int64
	
	query := r.db.Model(&models.ConfirmedOrder{})
	
	if supplierID, ok := filters["supplier_id"]; ok && supplierID != "" && supplierID != "0" {
		query = query.Where("supplier_id = ?", supplierID)
	}
	
	if status, ok := filters["status"]; ok && status != "" {
		query = query.Where("status = ?", status)
	}

	err := query.Count(&total).Error
	if err != nil {
		return nil, 0, err
	}

	err = query.Preload("Supplier").Order("confirmed_at desc").Limit(limit).Offset(offset).Find(&orders).Error
	return orders, total, err
}

func (r *PostgresRestockRepository) GetOrderByID(id string) (*models.ConfirmedOrder, error) {
	var order models.ConfirmedOrder
	err := r.db.Preload("Supplier").Preload("Items").Preload("Items.Product").Where("id = ?", id).First(&order).Error
	if err != nil {
		return nil, err
	}
	return &order, nil
}

func (r *PostgresRestockRepository) CreateConfirmedOrder(order *models.ConfirmedOrder, items []models.ConfirmedOrderItem) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(order).Error; err != nil {
			return err
		}
		for i := range items {
			items[i].ConfirmedOrderID = order.ID
		}
		if err := tx.Create(&items).Error; err != nil {
			return err
		}
		return nil
	})
}

func (r *PostgresRestockRepository) UpdateOrderStatus(id, status, receivedBy string) error {
	updates := map[string]interface{}{
		"status": status,
	}
	if status == "received" {
		updates["received_by"] = receivedBy
		updates["received_at"] = gorm.Expr("NOW()")
	}
	return r.db.Model(&models.ConfirmedOrder{}).Where("id = ?", id).Updates(updates).Error
}

func (r *PostgresRestockRepository) DeleteOrderAndItems(id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("confirmed_order_id = ?", id).Delete(&models.ConfirmedOrderItem{}).Error; err != nil {
			return err
		}
		if err := tx.Where("id = ?", id).Delete(&models.ConfirmedOrder{}).Error; err != nil {
			return err
		}
		return nil
	})
}

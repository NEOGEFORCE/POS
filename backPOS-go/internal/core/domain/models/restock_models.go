package models

import (
	"time"
)

type ActivePurchaseList struct {
	ID         string     `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	ProductID  string     `gorm:"index;column:product_id" json:"productId"` // References Product.Barcode
	SupplierID uint       `gorm:"index;column:supplier_id" json:"supplierId"`
	Quantity   float64    `gorm:"column:quantity" json:"quantity"`
	Status     string     `gorm:"type:varchar(20);column:status" json:"status"` // 'pending', 'ordered', 'received'
	CreatedAt  time.Time  `gorm:"autoCreateTime;column:created_at" json:"createdAt"`
	CreatedBy  string     `gorm:"type:varchar(255);column:created_by" json:"createdBy"` // DNI or Name

	Product    Product    `gorm:"foreignKey:ProductID;references:Barcode" json:"product,omitempty"`
	Supplier   Supplier   `gorm:"foreignKey:SupplierID" json:"supplier,omitempty"`
}

func (ActivePurchaseList) TableName() string {
	return "active_purchase_list"
}

type ConfirmedOrder struct {
	ID               string     `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	SupplierID       uint       `gorm:"index;column:supplier_id" json:"supplierId"`
	EstimatedTotal   float64    `gorm:"type:decimal(12,2);column:estimated_total" json:"estimatedTotal"`
	RealInvoiceTotal float64    `gorm:"type:decimal(12,2);column:real_invoice_total" json:"realInvoiceTotal"`
	Status           string     `gorm:"type:varchar(20);column:status" json:"status"` // 'pending', 'in_transit', 'received'
	ConfirmedAt      time.Time  `gorm:"column:confirmed_at" json:"confirmedAt"`
	ConfirmedBy      string     `gorm:"type:varchar(255);column:confirmed_by" json:"confirmedBy"`
	ReceivedAt       *time.Time `gorm:"column:received_at" json:"receivedAt"`
	ReceivedBy       string     `gorm:"type:varchar(255);column:received_by" json:"receivedBy"`

	Supplier         Supplier   `gorm:"foreignKey:SupplierID" json:"supplier,omitempty"`
}

func (ConfirmedOrder) TableName() string {
	return "confirmed_orders"
}

type ConfirmedOrderItem struct {
	ID               string     `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	ConfirmedOrderID string     `gorm:"type:uuid;index;column:confirmed_order_id" json:"confirmedOrderId"`
	ProductID        string     `gorm:"index;column:product_id" json:"productId"`
	Quantity         float64    `gorm:"column:quantity" json:"quantity"`
	EstimatedPrice   float64    `gorm:"type:decimal(10,2);column:estimated_price" json:"estimatedPrice"`

	ConfirmedOrder   ConfirmedOrder `gorm:"foreignKey:ConfirmedOrderID;constraint:OnDelete:CASCADE;" json:"confirmedOrder,omitempty"`
	Product          Product        `gorm:"foreignKey:ProductID;references:Barcode" json:"product,omitempty"`
}

func (ConfirmedOrderItem) TableName() string {
	return "confirmed_order_items"
}

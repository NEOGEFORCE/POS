package models

import (
	"time"

	"gorm.io/gorm"
)

type PurchaseOrderStatus string

const (
	PurchaseOrderPending   PurchaseOrderStatus = "PENDING"
	PurchaseOrderReceived  PurchaseOrderStatus = "RECEIVED"
	PurchaseOrderCancelled PurchaseOrderStatus = "CANCELLED"
)

type PurchaseOrder struct {
	ID            uint                `gorm:"primaryKey;autoIncrement" json:"id"`
	SupplierID    uint                `gorm:"index;not null;column:supplierId" json:"supplierId"`
	Supplier      Supplier            `gorm:"foreignKey:SupplierID" json:"supplier,omitempty"`
	OrderDate     time.Time           `gorm:"default:now();not null;column:orderDate" json:"orderDate"`
	DeliveryDate  time.Time           `gorm:"column:deliveryDate" json:"deliveryDate"`
	EstimatedCost float64             `gorm:"type:decimal(10,2);not null;column:estimatedCost" json:"estimatedCost"`
	Status        PurchaseOrderStatus `gorm:"type:varchar(20);default:'PENDING';column:status" json:"status"`
	OrderItems    []PurchaseOrderItem `gorm:"foreignKey:OrderID" json:"items,omitempty"`
	CreatedByDNI  string              `gorm:"index;column:createdByDni" json:"createdByDni"`
	Employee      Employee            `gorm:"foreignKey:CreatedByDNI;references:DNI" json:"employee,omitempty"`
	DeletedAt     gorm.DeletedAt      `gorm:"index" json:"-"`
}

func (PurchaseOrder) TableName() string {
	return "purchase_orders"
}

type PurchaseOrderItem struct {
	ID            uint           `gorm:"primaryKey;autoIncrement" json:"id"`
	OrderID       uint           `gorm:"index;not null;column:orderId" json:"orderId"`
	ProductBarcode string         `gorm:"not null;index;column:productBarcode" json:"barcode"`
	Product       Product        `gorm:"foreignKey:ProductBarcode;references:Barcode" json:"product,omitempty"`
	Quantity      float64        `gorm:"not null;column:quantity" json:"quantity"`
	UnitPrice     float64        `gorm:"type:decimal(10,2);not null;column:unitPrice" json:"unitPrice"`
	Subtotal      float64        `gorm:"type:decimal(10,2);not null;column:subtotal" json:"subtotal"`
	DeletedAt     gorm.DeletedAt `gorm:"index" json:"-"`
}

func (PurchaseOrderItem) TableName() string {
	return "purchase_order_items"
}

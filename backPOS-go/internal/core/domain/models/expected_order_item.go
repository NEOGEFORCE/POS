package models

import (
	"time"
)

// ExpectedOrderItem representa un artǭculo individual dentro de un pedido esperado
type ExpectedOrderItem struct {
	ID               uint          `gorm:"primaryKey;autoIncrement" json:"id"`
	ExpectedOrderID  uint          `gorm:"index;not null;column:expected_order_id" json:"expectedOrderId"`
	ExpectedOrder    ExpectedOrder `gorm:"foreignKey:ExpectedOrderID" json:"-"`
	Barcode          string        `gorm:"index;not null;column:barcode" json:"barcode"`
	ProductName      string        `gorm:"not null;column:product_name" json:"productName"`
	ExpectedQuantity float64       `gorm:"type:decimal(10,2);default:0;column:expected_quantity" json:"expectedQuantity"`
	CreatedAt        time.Time     `gorm:"default:now();column:created_at" json:"createdAt"`
}

func (ExpectedOrderItem) TableName() string {
	return "expected_order_items"
}

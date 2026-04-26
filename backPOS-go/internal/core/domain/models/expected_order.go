package models

import (
	"time"

	"gorm.io/gorm"
)

// ExpectedOrder representa un pedido esperado/preventa de un proveedor
type ExpectedOrder struct {
	ID             uint           `gorm:"primaryKey;autoIncrement" json:"id"`
	SupplierID     uint           `gorm:"index;column:supplierId" json:"supplierId"`
	Supplier       Supplier       `gorm:"foreignKey:SupplierID" json:"-"`          // CRITICAL FIX: Evitar bucle infinito al serializar
	SupplierName   string         `gorm:"column:supplierName" json:"supplierName"` // Nombre del proveedor (para referencia rápida)
	ExpectedDate   time.Time      `gorm:"not null;column:expectedDate" json:"expectedDate"`
	TotalEstimated float64        `gorm:"type:decimal(10,2);default:0;column:totalEstimated" json:"totalEstimated"`
	ItemCount      int            `gorm:"default:0;column:itemCount" json:"itemCount"`
	Status         string         `gorm:"type:varchar(20);default:'PENDING';column:status" json:"status"` // PENDING, RECEIVED, CANCELLED
	CreatedByDNI   string         `gorm:"index;column:createdByDni" json:"createdByDni"`
	CreatedByName  string         `gorm:"column:createdByName" json:"createdByName"`
	CreatedAt      time.Time      `gorm:"default:now();column:createdAt" json:"createdAt"`
	UpdatedAt      time.Time      `gorm:"column:updatedAt" json:"updatedAt"`
	DeletedAt      gorm.DeletedAt `gorm:"index" json:"-"`
}

func (ExpectedOrder) TableName() string {
	return "expected_orders"
}

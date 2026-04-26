package models

import (
	"gorm.io/gorm"
)

// SupplierOrderMethodType enum para tipos de método de pedido
type SupplierOrderMethodType string

const (
	OrderMethodRoute SupplierOrderMethodType = "ROUTE"
	OrderMethodApp   SupplierOrderMethodType = "APP"
)

// SupplierOrderMethod representa un método de abastecimiento para un proveedor
type SupplierOrderMethod struct {
	ID            uint                    `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	SupplierID    uint                    `gorm:"not null;index;column:supplierId" json:"supplierId"`
	Type          SupplierOrderMethodType `gorm:"not null;column:type" json:"type"`
	PlatformName  string                  `gorm:"column:platformName" json:"platformName"` // Ej: "Pideky", "Surtiapp", "Preventista"
	VisitDays     []int                   `gorm:"-" json:"visitDays"`                       // Solo para ROUTE: [1,4] = Lunes, Jueves
	VisitDaysJSON string                  `gorm:"column:visitDays" json:"-"`                // Storage en JSON
	LeadTimeDays  int                     `gorm:"not null;column:leadTimeDays;default:1" json:"leadTimeDays"`
	IsActive      bool                    `gorm:"not null;column:isActive;default:true" json:"isActive"`
	CreatedAt     int64                   `gorm:"autoCreateTime;column:createdAt" json:"createdAt"`
	UpdatedAt     int64                   `gorm:"autoUpdateTime;column:updatedAt" json:"updatedAt"`
	DeletedAt     gorm.DeletedAt          `gorm:"index" json:"-"`
	// Relaciones
	Supplier Supplier `gorm:"foreignKey:SupplierID;references:ID" json:"supplier,omitempty"`
}

func (SupplierOrderMethod) TableName() string {
	return "supplier_order_methods"
}

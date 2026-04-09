package models

import (
	"gorm.io/gorm"
)

type Product struct {
	Barcode          string         `gorm:"primaryKey;unique;not null;column:barcode" json:"barcode"`
	ProductName      string         `gorm:"not null;column:productName" json:"productName"`
	Quantity         float64        `gorm:"not null;column:quantity" json:"quantity"`
	IsWeighted       bool           `gorm:"default:false;column:isWeighted" json:"isWeighted"`
	PurchasePrice    float64        `gorm:"type:decimal(10,2);not null;column:purchasePrice" json:"purchasePrice"`
	MarginPercentage float64        `gorm:"type:decimal(10,4);default:0;column:marginPercentage" json:"marginPercentage"`
	SalePrice        float64        `gorm:"type:decimal(10,2);not null;column:salePrice" json:"salePrice"`
	CategoryID       uint           `gorm:"index;column:categoryId" json:"categoryId"`
	Category         Category       `gorm:"foreignKey:CategoryID" json:"category,omitempty"`
	SupplierID       *uint          `gorm:"index;column:supplierId" json:"supplierId"`
	Supplier         Supplier       `gorm:"foreignKey:SupplierID" json:"supplier,omitempty"`
	CreatedByDNI     string         `gorm:"index;column:createdByDni" json:"createdByDni"`
	CreatedByName    string         `gorm:"column:createdByName" json:"createdByName"`
	UpdatedByDNI     string         `gorm:"index;column:updatedByDni" json:"updatedByDni"`
	UpdatedByName    string         `gorm:"column:updatedByName" json:"updatedByName"`
	CreatedBy        Employee       `gorm:"foreignKey:CreatedByDNI;references:DNI" json:"createdByEmployee,omitempty"`
	UpdatedBy        Employee       `gorm:"foreignKey:UpdatedByDNI;references:DNI" json:"updatedByEmployee,omitempty"`
	DeletedAt        gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Product) TableName() string {
	return "products"
}

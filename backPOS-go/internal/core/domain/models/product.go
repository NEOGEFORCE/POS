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
	Iva              float64        `gorm:"type:decimal(10,2);default:0;column:iva" json:"iva"`
	Icui             float64        `gorm:"type:decimal(10,2);default:0;column:icui" json:"icui"`
	Ibua             float64        `gorm:"type:decimal(10,2);default:0;column:ibua" json:"ibua"`
	MarginPercentage float64        `gorm:"type:decimal(10,4);default:0;column:marginPercentage" json:"marginPercentage"`
	SalePrice        float64        `gorm:"type:decimal(10,2);not null;column:salePrice" json:"salePrice"`
	CategoryID       uint           `gorm:"index;column:categoryId" json:"categoryId"`
	Category         Category       `gorm:"foreignKey:CategoryID" json:"category,omitempty"`
	Suppliers        []Supplier     `gorm:"many2many:product_suppliers;" json:"suppliers,omitempty"`
	SupplierID       *uint          `gorm:"index;column:supplierId" json:"supplierId"`
	Supplier         Supplier       `gorm:"foreignKey:SupplierID" json:"supplier,omitempty"`
	CreatedByDNI     string         `gorm:"index;column:createdByDni" json:"createdByDni"`
	CreatedByName    string         `gorm:"column:createdByName" json:"createdByName"`
	UpdatedByDNI     string         `gorm:"index;column:updatedByDni" json:"updatedByDni"`
	UpdatedByName    string         `gorm:"column:updatedByName" json:"updatedByName"`
	CreatedBy        Employee       `gorm:"foreignKey:CreatedByDNI;references:DNI" json:"createdByEmployee,omitempty"`
	UpdatedBy        Employee       `gorm:"foreignKey:UpdatedByDNI;references:DNI" json:"updatedByEmployee,omitempty"`
	ImageUrl         string         `gorm:"type:text;column:imageUrl" json:"imageUrl"`
	MinStock         float64        `gorm:"type:decimal(10,2);default:0;column:minStock" json:"minStock"`
	IsActive         bool           `gorm:"default:true;column:isActive" json:"isActive"`
	NetProfit        float64        `gorm:"-" json:"netProfit"`
	DeletedAt        gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Product) TableName() string {
	return "products"
}

type ProductSupplier struct {
	ProductID     string  `gorm:"primaryKey;column:productBarcode"`
	SupplierID    uint    `gorm:"primaryKey;column:supplierId"`
	PurchasePrice float64 `gorm:"type:decimal(10,2);column:purchasePrice"`
	CreatedAt     int64   `gorm:"autoCreateTime" json:"createdAt"`
	UpdatedAt     int64   `gorm:"autoUpdateTime" json:"updatedAt"`
}

func (ProductSupplier) TableName() string {
	return "product_suppliers"
}

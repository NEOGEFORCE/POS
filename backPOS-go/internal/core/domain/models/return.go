package models

import (
	"time"

	"gorm.io/gorm"
)

type Return struct {
	ID            uint           `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	SaleID        uint           `gorm:"not null;index;column:saleId" json:"saleId"`
	Date          time.Time      `gorm:"default:now();not null;column:date" json:"date"`
	TotalReturned float64        `gorm:"type:decimal(10,2);not null;column:totalReturned" json:"totalReturned"`
	Reason        string         `gorm:"column:reason" json:"reason"`
	ReturnType    string         `gorm:"column:returnType" json:"returnType"` // "REFUND" or "EXCHANGE"
	EmployeeDNI   string         `gorm:"not null;column:employeeDni" json:"employeeDni"`
	Sale          Sale           `gorm:"foreignKey:SaleID" json:"sale,omitempty"`
	Employee      Employee       `gorm:"foreignKey:EmployeeDNI;references:DNI" json:"employee,omitempty"`
	Details       []ReturnDetail `gorm:"foreignKey:ReturnID" json:"details,omitempty"`
	DeletedAt     gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Return) TableName() string {
	return "returns"
}

type ReturnDetail struct {
	ID        uint           `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	ReturnID  uint           `gorm:"not null;index;column:returnId" json:"returnId"`
	Barcode   string         `gorm:"not null;index;column:barcode" json:"barcode"`
	Quantity  float64        `gorm:"not null;column:quantity" json:"quantity"`
	Price     float64        `gorm:"type:decimal(10,2);not null;column:price" json:"price"`
	Subtotal  float64        `gorm:"type:decimal(10,2);not null;column:subtotal" json:"subtotal"`
	IsExchange bool          `gorm:"default:false;column:isExchange" json:"isExchange"`
	Product   Product        `gorm:"foreignKey:Barcode;references:Barcode" json:"product,omitempty"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}

func (ReturnDetail) TableName() string {
	return "return_details"
}

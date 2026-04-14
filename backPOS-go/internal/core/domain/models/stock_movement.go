package models

import (
	"time"
)

type StockMovement struct {
	ID        uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	Date      time.Time `gorm:"default:now();index" json:"date"`
	Barcode   string    `gorm:"not null;index" json:"barcode"`
	Quantity  float64   `gorm:"not null" json:"quantity"`
	Type      string    `gorm:"not null;index" json:"type"` // "IN" or "OUT"
	Reason    string    `gorm:"not null;index" json:"reason"` // "SALE", "RECEPTION", "RETURN", "ADJUSTMENT", "DELETE"
	EmployeeDNI string  `gorm:"index" json:"employeeDni"`
	EmployeeName string `json:"employeeName"`
	ReferenceID  string `gorm:"index" json:"referenceId"` // e.g., SaleID or ReceptionID
	Product     Product `gorm:"foreignKey:Barcode;references:Barcode" json:"product,omitempty"`
}

func (StockMovement) TableName() string {
	return "stock_movements"
}

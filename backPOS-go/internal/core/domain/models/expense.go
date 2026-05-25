package models

import (
	"time"

	"gorm.io/gorm"
)

type Expense struct {
	ID            uint           `gorm:"primaryKey;autoIncrement;column:id" json:"id"`
	Description   string         `gorm:"not null;column:description" json:"description"`
	Amount        float64        `gorm:"type:decimal(10,2);not null;column:amount" json:"amount"`
	Date          time.Time      `gorm:"default:now();not null;column:date" json:"date"`
	PaymentSource string         `gorm:"not null;column:paymentSource;default:'EFECTIVO'" json:"paymentSource"`
	Category      string         `gorm:"not null;type:varchar(100);column:category;default:'Otros'" json:"category"`
	SupplierID    *uint          `gorm:"column:supplier_id" json:"supplierId"`
	Supplier      *Supplier      `gorm:"foreignKey:SupplierID" json:"supplier,omitempty"`
	Status        string         `gorm:"type:varchar(20);default:'PAID';column:status" json:"status"` // PAID, PENDING
	LenderName    string         `gorm:"column:lenderName" json:"lenderName"` // Socio que presta el dinero
	TaxAmount     float64        `gorm:"type:decimal(10,2);default:0;column:tax_amount" json:"taxAmount"` // GMF 4x1000
	ReferenceID   string         `gorm:"index;column:reference_id" json:"referenceId"` // e.g., RECP-123456

	PaidAmount      float64        `gorm:"type:decimal(10,2);default:0;column:paid_amount" json:"paidAmount"`
	RemainingAmount float64        `gorm:"type:decimal(10,2);default:0;column:remaining_amount" json:"remainingAmount"`

	CreatedByDNI  string         `gorm:"not null;index;column:createdByDni" json:"createdByDni"`
	Creator       Employee       `gorm:"foreignKey:CreatedByDNI;references:DNI" json:"creator,omitempty"`
	DeletedAt     gorm.DeletedAt `gorm:"index" json:"-"`
	NewSupplierName string       `gorm:"-" json:"newSupplierName,omitempty"` // For quick creation
}

func (Expense) TableName() string {
	return "expenses"
}

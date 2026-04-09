package models

import (
	"time"

	"gorm.io/gorm"
)

type CreditPayment struct {
	ID             uint           `gorm:"primaryKey;autoIncrement" json:"id"`
	ClientDNI      string         `gorm:"index;not null;column:clientDni" json:"clientDni"`
	EmployeeDNI    string         `gorm:"not null;column:employeeDni" json:"employeeDni"`
	PaymentDate    time.Time      `gorm:"default:now();not null;column:paymentDate" json:"paymentDate"`
	AmountCash     float64        `gorm:"type:decimal(10,2);column:amountCash" json:"amountCash"`
	AmountTransfer float64        `gorm:"type:decimal(10,2);column:amountTransfer" json:"amountTransfer"`
	TransferSource string         `gorm:"column:transferSource" json:"transferSource"`
	TotalPaid      float64        `gorm:"type:decimal(10,2);column:totalPaid" json:"totalPaid"`
	Client         Client         `gorm:"foreignKey:ClientDNI;references:DNI" json:"client,omitempty"`
	Employee       Employee       `gorm:"foreignKey:EmployeeDNI;references:DNI" json:"employee,omitempty"`
	DeletedAt      gorm.DeletedAt `gorm:"index" json:"-"`
}

func (CreditPayment) TableName() string {
	return "credit_payments"
}

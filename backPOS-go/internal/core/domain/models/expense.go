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
	PaymentSource string         `gorm:"column:paymentSource;default:'EFECTIVO'" json:"paymentSource"`
	CreatedByDNI  string         `gorm:"not null;index;column:createdByDni" json:"createdByDni"`
	Creator       Employee       `gorm:"foreignKey:CreatedByDNI;references:DNI" json:"creator,omitempty"`
	DeletedAt     gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Expense) TableName() string {
	return "expenses"
}

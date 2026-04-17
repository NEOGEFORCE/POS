package models

import (
	"time"
	"gorm.io/gorm"
)

type MissingItem struct {
	ID          uint           `gorm:"primaryKey" json:"id"`
	ProductName string         `gorm:"not null;column:product_name" json:"product_name"`
	Status      string         `gorm:"default:PENDIENTE;column:status" json:"status"` // PENDIENTE, ADQUIRIDO, AGOTADO
	ReportedBy  string         `gorm:"index;column:reported_by" json:"reported_by"`
	Reporter    Employee       `gorm:"foreignKey:ReportedBy;references:DNI" json:"reporter,omitempty"`
	Note        string         `gorm:"type:text;column:note" json:"note"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`
}

func (MissingItem) TableName() string {
	return "missing_items"
}

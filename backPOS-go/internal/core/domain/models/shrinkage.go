package models

import (
	"time"

	"gorm.io/gorm"
)

type ShrinkageReason string

const (
	ShrinkageVencimiento ShrinkageReason = "VENCIMIENTO"
	ShrinkageRotura      ShrinkageReason = "ROTURA"
	ShrinkageConsumoInt  ShrinkageReason = "CONSUMO_INTERNO"
	ShrinkageHurto       ShrinkageReason = "HURTO"
)

type Shrinkage struct {
	ID          uint           `gorm:"primaryKey;autoIncrement" json:"id"`
	ProductID   string         `gorm:"not null;index;column:product_id" json:"product_id"`
	Product     Product        `gorm:"foreignKey:ProductID;references:Barcode;constraint:false" json:"product,omitempty"`
	Quantity    float64        `gorm:"type:decimal(10,3);not null" json:"quantity"`
	Reason      ShrinkageReason `gorm:"type:varchar(50);not null" json:"reason"`
	CostAtTime  float64        `gorm:"type:decimal(10,2);not null" json:"cost_at_time"`
	UserID      string         `gorm:"not null;index;column:user_id" json:"user_id"`
	User        Employee       `gorm:"foreignKey:UserID;references:DNI" json:"user,omitempty"`
	Notes       string         `gorm:"type:text" json:"notes"`
	Date        time.Time      `gorm:"default:now();not null" json:"date"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`
}

func (Shrinkage) TableName() string {
	return "shrinkages"
}

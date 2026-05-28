package models

import (
	"time"

	"gorm.io/gorm"
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
	Metadata     string `gorm:"type:text" json:"metadata"` // Snapshot of prices/taxes in JSON
	EditedBy      string     `gorm:"index;column:edited_by" json:"editedBy"`
	EditedAt      *time.Time `gorm:"column:edited_at" json:"editedAt"`
	OriginalValues string    `gorm:"type:jsonb;column:original_values" json:"originalValues"`
	AnnulledBy    string     `gorm:"index;column:annulled_by" json:"annulledBy"`
	AnnulledAt    *time.Time `gorm:"column:annulled_at" json:"annulledAt"`
	AnnulledReason string    `gorm:"type:text;column:annulled_reason" json:"annulledReason"`
	Product     Product `gorm:"foreignKey:Barcode;references:Barcode;constraint:false;" json:"product,omitempty"`
}

func (StockMovement) TableName() string {
	return "stock_movements"
}

func (m *StockMovement) BeforeCreate(tx *gorm.DB) (err error) {
	if m.OriginalValues == "" {
		m.OriginalValues = "{}"
	}
	return
}

func (m *StockMovement) BeforeUpdate(tx *gorm.DB) (err error) {
	if m.OriginalValues == "" {
		m.OriginalValues = "{}"
	}
	return
}


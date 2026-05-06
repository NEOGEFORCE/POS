package models

import (
	"time"
)

type ReportHistory struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Name      string    `gorm:"size:255;not null" json:"name"`
	Type      string    `gorm:"size:50;not null" json:"type"` // PDF, CSV, XLS
	Category  string    `gorm:"size:100" json:"category"`     // Ventas, Inventario, Cierre, etc.
	CreatedAt time.Time `json:"created_at"`
	CreatedBy string    `gorm:"size:100" json:"created_by"`
	URL       string    `json:"url"` // Local path or remote URL
}

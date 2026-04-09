package models

import (
	"time"
)

type ActiveShift struct {
	ID           uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	StartTime    time.Time `gorm:"not null" json:"startTime"`
	OpeningCash  float64   `gorm:"default:120000" json:"openingCash"`
	CashierDNI   string    `json:"cashierDni"`
	CashierName  string    `json:"cashierName"`
	Status       string    `gorm:"default:'OPEN'" json:"status"` // "OPEN", "CLOSED"
}

func (ActiveShift) TableName() string {
	return "active_shifts"
}

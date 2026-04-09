package models

import (
	"time"

	"gorm.io/gorm"
)

type CashierClosure struct {
	ID              uint           `gorm:"primaryKey;autoIncrement" json:"id"`
	Date            time.Time      `gorm:"not null" json:"date"`
	StartDate       time.Time      `json:"startDate"`
	EndDate         time.Time      `json:"endDate"`
	SalesCount      int            `json:"salesCount"`
	TotalSales      float64        `json:"totalSales"`
	TotalCash       float64        `json:"totalCash"`
	TotalTransfer   float64        `json:"totalTransfer"`
	TotalExpenses   float64        `json:"totalExpenses"`
	TotalReturns    float64        `json:"totalReturns"`
	TotalCreditIssued float64      `json:"totalCreditIssued"`
	TotalCreditCollected float64   `json:"totalCreditCollected"`
	OpeningCash     float64        `json:"openingCash"`
	TotalNequi      float64        `json:"totalNequi"`
	TotalDaviplata  float64        `json:"totalDaviplata"`
	TotalBancolombia float64       `json:"totalBancolombia"`
	TotalOtherTransfer float64     `json:"totalOtherTransfer"`
	NetBalance      float64        `json:"netBalance"`
	ClosedByDNI     string         `json:"closedByDni"`
	ClosedByName    string         `json:"closedByName"`
	PhysicalCash    float64        `json:"physicalCash"`
	Difference      float64        `json:"difference"`
	SalariesDetail  string         `gorm:"type:text" json:"salariesDetail"`
	ExpensesDetail  string         `gorm:"type:text" json:"expensesDetail"`
	Expenses        []Expense      `gorm:"-" json:"expenses"`
	DeletedAt       gorm.DeletedAt `gorm:"index" json:"-"`
}

func (CashierClosure) TableName() string {
	return "cashier_closures"
}

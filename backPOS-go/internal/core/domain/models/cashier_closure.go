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
	TotalCard       float64        `json:"totalCard"`
	TotalExpenses   float64        `json:"totalExpenses"`
	TotalReturns    float64        `json:"totalReturns"`
	ReturnsCount    float64        `json:"returnsCount"`
	TotalCreditIssued float64      `json:"totalCreditIssued"`
	TotalCreditCollected float64   `json:"totalCreditCollected"`
	OpeningCash     float64        `json:"openingCash"`
	TotalNequi      float64        `json:"totalNequi"`
	TotalDaviplata  float64        `json:"totalDaviplata"`
	TotalBancolombia float64       `json:"totalBancolombia"`
	TotalOtherTransfer float64     `json:"totalOtherTransfer"`
	NetBalance      float64        `json:"netBalance"`
	CashBills       float64        `json:"cashBills"`
	Coins200        float64        `json:"coins200"`
	Coins100        float64        `json:"coins100"`
	Coins500_1000   float64        `json:"coins500_1000"`
	ClosedByDNI     string         `json:"closedByDni"`
	ClosedByName    string         `json:"closedByName"`
	PhysicalCash    float64        `json:"physicalCash"`
	Difference      float64        `json:"difference"`
	AuthorizedBy    string         `json:"authorizedBy"`
	SalariesDetail  string         `gorm:"type:text" json:"salariesDetail"`
	ExpensesDetail  string         `gorm:"type:text" json:"expensesDetail"`
	Expenses        []Expense      `gorm:"-" json:"expenses"`
	CreditsIssued   []Sale         `gorm:"-" json:"creditsIssued"`   // Listado de fiados realizados
	CreditPayments  []CreditPayment `gorm:"-" json:"creditPayments"` // Listado de abonos recibidos
	DeletedAt       gorm.DeletedAt `gorm:"index" json:"-"`
}

func (CashierClosure) TableName() string {
	return "cashier_closures"
}

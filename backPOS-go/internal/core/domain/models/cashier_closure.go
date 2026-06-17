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
	ExpectedCash    float64        `json:"expectedCash"`
	CashBreakdown   string         `gorm:"type:text" json:"cashBreakdown"`
	ActiveShiftName string         `gorm:"-" json:"activeShiftName"`
	ActiveShiftDNI  string         `gorm:"-" json:"activeShiftDni"`
	CashBills       float64        `json:"cashBills"`
	Coins200        float64        `json:"coins200"`
	Coins100        float64        `json:"coins100"`
	Coins500        float64        `json:"coins500"`
	Coins1000       float64        `json:"coins1000"`
	ClosedByDNI     string         `json:"closedByDni"`
	ClosedByName    string         `json:"closedByName"`
	PhysicalCash    float64        `gorm:"column:physical_cash" json:"physicalCash"`
	TotalCashReal   float64        `gorm:"column:total_cash_real" json:"totalCashReal"`
	TotalNequiReal  float64        `gorm:"column:total_nequi_real" json:"totalNequiReal"`
	TotalDaviplataReal float64     `gorm:"column:total_daviplata_real" json:"totalDaviplataReal"`
	Difference      float64        `json:"difference"`
	AuthorizedBy    string         `json:"authorizedBy"`
	SalariesDetail  string         `gorm:"type:text" json:"salariesDetail"`
	ExpensesDetail  string         `gorm:"type:text" json:"expensesDetail"`
	Expenses        []Expense      `gorm:"-" json:"expenses"`
	CreditsIssued   []Sale         `gorm:"-" json:"creditsIssued"`   // Listado de fiados realizados
	CreditPayments  []CreditPayment `gorm:"-" json:"creditPayments"` // Listado de abonos recibidos

	// Desglose dinámico por método de pago — se calcula en runtime desde
	// las ventas y abonos del rango del cierre (no se persiste en BD).
	// Cada item lleva el nombre EXACTO del método tal como se registró
	// en las ventas (TransferSource): EFECTIVO, NEQUI, DAVIPLATA, BANCOLOMBIA,
	// MASTERCARD, etc. — sin agruparse en un genérico "OTROS".
	PaymentMethodsBreakdown []PaymentMethodTotal `gorm:"-" json:"paymentMethodsBreakdown,omitempty"`

	DeletedAt       gorm.DeletedAt `gorm:"index" json:"-"`
}

func (CashierClosure) TableName() string {
	return "cashier_closures"
}

// PaymentMethodTotal representa el total acumulado de un método de pago
// específico durante un cierre de caja. Se usa para alimentar la sección
// "Distribución por Medios de Pago" del modal de auditoría sin necesidad
// de agruparse en un campo genérico "TARJETA/OTROS".
type PaymentMethodTotal struct {
	Method string  `json:"method"` // Nombre exacto: NEQUI, DAVIPLATA, BANCOLOMBIA, MASTERCARD, etc.
	Total  float64 `json:"total"`
}

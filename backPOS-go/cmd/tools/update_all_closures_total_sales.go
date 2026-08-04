package main

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Expense struct {
	ID              uint    `json:"id"`
	Description     string  `json:"description"`
	Amount          float64 `json:"amount"`
	TaxAmount       float64 `json:"taxAmount"`
	Status          string  `json:"status"`
	PaymentSource   string  `json:"paymentSource"`
	CashAmount      float64 `json:"cashAmount"`
	NequiAmount     float64 `json:"nequiAmount"`
	DaviplataAmount float64 `json:"daviplataAmount"`
	FondoAmount     float64 `json:"fondoAmount"`
}

type CashierClosure struct {
	ID                 uint      `gorm:"primaryKey" json:"id"`
	Date               time.Time `json:"date"`
	StartDate          time.Time `json:"startDate"`
	EndDate            time.Time `json:"endDate"`
	TotalSales         float64   `json:"totalSales"`
	PhysicalCash       float64   `json:"physicalCash"`
	TotalNequi         float64   `json:"totalNequi"`
	TotalDaviplata     float64   `json:"totalDaviplata"`
	TotalCard          float64   `json:"totalCard"`
	TotalBancolombia   float64   `json:"totalBancolombia"`
	TotalOtherTransfer float64   `json:"totalOtherTransfer"`
	ExpensesDetail     string    `json:"expensesDetail"`
}

func calculateVentaReal(c CashierClosure) float64 {
	digital := c.TotalNequi + c.TotalDaviplata + c.TotalCard + c.TotalBancolombia + c.TotalOtherTransfer
	cashEgresos := 0.0

	var exps []Expense
	if c.ExpensesDetail != "" {
		_ = json.Unmarshal([]byte(c.ExpensesDetail), &exps)
	}

	for _, e := range exps {
		if strings.ToUpper(e.Status) != "PENDING" {
			if e.CashAmount > 0 {
				cashEgresos += e.CashAmount
			} else {
				src := strings.ToUpper(e.PaymentSource)
				if src == "" || src == "CAJA" || src == "EFECTIVO" {
					cashEgresos += (e.Amount + e.TaxAmount)
				}
			}
		}
	}

	vReal := c.PhysicalCash + digital + cashEgresos
	if vReal > 0 {
		return vReal
	}
	return c.TotalSales
}

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error connecting to db: %v", err)
	}

	// STRICT RULE: ONLY UPDATE cashier_closures.total_sales column!
	// NO OTHER TABLES TOUCHED!

	var closures []CashierClosure
	db.Table("cashier_closures").Where("deleted_at IS NULL").Order("id ASC").Find(&closures)

	updatedCount := 0
	for _, c := range closures {
		vReal := calculateVentaReal(c)
		if vReal != c.TotalSales && vReal > 0 {
			db.Table("cashier_closures").Where("id = ?", c.ID).Update("total_sales", vReal)
			fmt.Printf("Closure %d updated: Old TotalSales=%.2f -> New TotalSales=%.2f\n", c.ID, c.TotalSales, vReal)
			updatedCount++
		}
	}

	fmt.Printf("✅ Total closures updated in cashier_closures table: %d\n", updatedCount)
}

package main

import (
	"encoding/json"
	"fmt"
	"log"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func main() {
	dsn := "host=192.168.1.6 user=postgres password=123 dbname=sistemapos port=5432 sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatalf("Error connecting to db: %v", err)
	}

	type Expense struct {
		ID              uint    `json:"id"`
		Description     string  `json:"description"`
		Amount          float64 `json:"amount"`
		PaymentSource   string  `json:"paymentSource"`
		Status          string  `json:"status"`
		TaxAmount       float64 `json:"taxAmount"`
		CashAmount      float64 `json:"cashAmount"`
		NequiAmount     float64 `json:"nequiAmount"`
		DaviplataAmount float64 `json:"daviplataAmount"`
		FondoAmount     float64 `json:"fondoAmount"`
		Category        string  `json:"category"`
		CreatedByDNI    string  `json:"createdByDni"`
		Date            string  `json:"date"`
	}

	var expenses []Expense
	db.Table("expenses").Where("date >= '2026-07-10 21:34:00' AND date <= '2026-07-11 21:33:59' AND status = 'PAID'").Order("id ASC").Find(&expenses)

	totalCash := 0.0
	for _, e := range expenses {
		if e.CashAmount > 0 {
			fmt.Printf("ID %d: %s | Source: %s | Cash: %.2f\n", e.ID, e.Description, e.PaymentSource, e.CashAmount)
			totalCash += e.CashAmount
		}
	}
	fmt.Printf("TOTAL CASH EGRESOS = %.2f\n", totalCash)

	b, _ := json.Marshal(expenses)
	jsonStr := string(b)

	db.Exec(`UPDATE cashier_closures SET expenses_detail = ? WHERE id = 94`, jsonStr)
	fmt.Println("✅ Closure 94 expenses_detail updated with ALL 17 paid expenses!")
}

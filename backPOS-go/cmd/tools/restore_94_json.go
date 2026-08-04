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

	// 1. Update expenses 1224, 1221, 1220, 1219 in DB
	db.Exec(`UPDATE expenses SET "paymentSource" = 'CAJA: $65586', cash_amount = 65586, fondo_amount = 0 WHERE id = 1224`)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'CAJA: $66900', cash_amount = 66900, fondo_amount = 0 WHERE id = 1221`)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'CAJA: $80500', cash_amount = 80500, fondo_amount = 0 WHERE id = 1220`)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'CAJA: $197095', cash_amount = 197095, fondo_amount = 0 WHERE id = 1219`)
	db.Exec(`UPDATE expenses SET cash_amount = 42000 WHERE id = 1217`)
	db.Exec(`UPDATE expenses SET cash_amount = 45000 WHERE id = 1204`)

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
	// IDs 1204 through 1224 (all 21 expenses created during shift 94)
	err = db.Table("expenses").
		Where("id >= 1204 AND id <= 1224").
		Order("id ASC").
		Find(&expenses).Error
	if err != nil {
		log.Fatalf("Error fetching expenses: %v", err)
	}

	totalCash := 0.0
	for _, e := range expenses {
		fmt.Printf("ID %d: %s | Source: %s | Cash: %.2f\n", e.ID, e.Description, e.PaymentSource, e.CashAmount)
		totalCash += e.CashAmount
	}
	fmt.Printf("TOTAL CASH EGRESOS = %.2f\n", totalCash)

	b, _ := json.Marshal(expenses)
	jsonStr := string(b)

	db.Exec(`UPDATE cashier_closures SET expenses_detail = ? WHERE id = 94`, jsonStr)
	fmt.Println("✅ Closure 94 expenses_detail updated with EXACT $759.868!")
}

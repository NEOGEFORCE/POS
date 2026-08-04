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

	// 1. Update expenses in expenses table
	db.Exec(`UPDATE expenses SET "paymentSource" = 'CAJA: $65586', cash_amount = 65586, fondo_amount = 0 WHERE id = 1224`)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'CAJA: $66900', cash_amount = 66900, fondo_amount = 0 WHERE id = 1221`)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'CAJA: $80500', cash_amount = 80500, fondo_amount = 0 WHERE id = 1220`)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'CAJA: $197095', cash_amount = 197095, fondo_amount = 0 WHERE id = 1219`)

	fmt.Println("✅ Expenses 1224, 1221, 1220, 1219 updated to CAJA!")

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
	err = db.Table("expenses").
		Where("id IN (1205, 1206, 1207, 1208, 1209, 1210, 1211, 1212, 1213, 1214, 1215, 1216, 1217, 1219, 1220, 1221, 1224)").
		Order("id ASC").
		Find(&expenses).Error
	if err != nil {
		log.Fatalf("Error fetching expenses for closure 94: %v", err)
	}

	totalCashExps := 0.0
	for _, e := range expenses {
		totalCashExps += e.CashAmount
	}
	fmt.Printf("Fetched %d expenses for Closure 94. Total Cash Egresos = %.2f\n", len(expenses), totalCashExps)

	b, _ := json.Marshal(expenses)
	jsonStr := string(b)

	// Update expenses_detail in cashier_closures for ID 94
	err = db.Exec(`UPDATE cashier_closures SET expenses_detail = ? WHERE id = 94`, jsonStr).Error
	if err != nil {
		log.Fatalf("Error updating cashier_closures for ID 94: %v", err)
	}
	fmt.Println("✅ Closure 94 expenses_detail JSON updated successfully!")
}

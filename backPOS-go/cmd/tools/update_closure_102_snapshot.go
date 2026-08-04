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

	// STRICT RULE: DO NOT TOUCH EXPENSES OR SALES TABLES!
	// ONLY update expenses_detail snapshot in cashier_closures table for ID 102!

	expensesSnapshot := []map[string]interface{}{
		// EFECTIVO ($427.300)
		{"id": 1335, "description": "PAGO DE NOMINA", "amount": 95000, "cashAmount": 95000, "paymentSource": "CAJA: $95000", "status": "PAID", "category": "Nomina"},
		{"id": 1334, "description": "PAGO DE NOMINA", "amount": 72000, "cashAmount": 72000, "paymentSource": "CAJA: $72000", "status": "PAID", "category": "Nomina"},
		{"id": 1333, "description": "CARNE - PAGO DE PROVEEDOR", "amount": 159000, "cashAmount": 159000, "paymentSource": "CAJA: $159000", "status": "PAID", "category": "Proveedores"},
		{"id": 1332, "description": "POLLO - PAGO DE PROVEEDOR", "amount": 101300, "cashAmount": 101300, "paymentSource": "CAJA: $101300", "status": "PAID", "category": "Proveedores"},
	}

	totalCash := 0.0
	for _, e := range expensesSnapshot {
		if c, ok := e["cashAmount"].(int); ok {
			totalCash += float64(c)
		}
	}
	fmt.Printf("Snapshot for Closure 102 ready. Total Cash Egresos = %.2f\n", totalCash)

	b, _ := json.Marshal(expensesSnapshot)
	jsonStr := string(b)

	err = db.Exec(`UPDATE cashier_closures SET expenses_detail = ? WHERE id = 102`, jsonStr).Error
	if err != nil {
		log.Fatalf("Error updating cashier_closures for ID 102: %v", err)
	}
	fmt.Println("✅ ONLY cashier_closures ID 102 snapshot updated. No live DB tables touched!")
}

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
	// ONLY update expenses_detail snapshot in cashier_closures table for ID 96!

	expensesSnapshot := []map[string]interface{}{
		// EFECTIVO ($1.444.026)
		{"id": 1261, "description": "PAGO DE NOMINA", "amount": 95000, "cashAmount": 95000, "paymentSource": "CAJA: $95000", "status": "PAID", "category": "Nomina"},
		{"id": 1260, "description": "PAGO DE NOMINA", "amount": 72000, "cashAmount": 72000, "paymentSource": "CAJA: $72000", "status": "PAID", "category": "Nomina"},
		{"id": 1259, "description": "GOMITAS/CHICHARRONES - PAGO DE PROVEEDOR", "amount": 56000, "cashAmount": 56000, "paymentSource": "CAJA: $56000", "status": "PAID", "category": "Proveedores"},
		{"id": 1257, "description": "RECEPCIÓN DE MERCANCÍA - SOFT & FRESH", "amount": 51878, "cashAmount": 51878, "paymentSource": "CAJA: $51878", "status": "PAID", "category": "Proveedores"},
		{"id": 1256, "description": "RECEPCIÓN DE MERCANCÍA - RAMO", "amount": 67699, "cashAmount": 67699, "paymentSource": "CAJA: $67699", "status": "PAID", "category": "Proveedores"},
		{"id": 1255, "description": "RECEPCIÓN DE MERCANCÍA - MARGARITA", "amount": 102394, "cashAmount": 102394, "paymentSource": "CAJA: $102394", "status": "PAID", "category": "Proveedores"},
		{"id": 1254, "description": "AGUA MIA - PAGO DE PROVEEDOR", "amount": 43000, "cashAmount": 43000, "paymentSource": "CAJA: $43000", "status": "PAID", "category": "Proveedores"},
		{"id": 1253, "description": "RECEPCIÓN DE MERCANCÍA - GELBRAN'S", "amount": 66723, "cashAmount": 66723, "paymentSource": "CAJA: $66723", "status": "PAID", "category": "Proveedores"},
		{"id": 1222, "description": "COCACOLA - PAGO DE PROVEEDOR", "amount": 568800, "cashAmount": 568800, "paymentSource": "CAJA: $568800", "status": "PAID", "category": "Proveedores"},
		{"id": 1218, "description": "HERMARLY - PAGO DE PROVEEDOR", "amount": 206832, "cashAmount": 206832, "paymentSource": "CAJA: $206832", "status": "PAID", "category": "Proveedores"},
		{"id": 1252, "description": "PICADOS - PAGO DE PROVEEDOR", "amount": 3900, "cashAmount": 3900, "paymentSource": "CAJA: $3900", "status": "PAID", "category": "Proveedores"},
		{"id": 1251, "description": "RECREO - PAGO DE PROVEEDOR", "amount": 109800, "cashAmount": 109800, "paymentSource": "CAJA: $109800", "status": "PAID", "category": "Proveedores"},

		// NEQUI ($375.507)
		{"id": 1250, "description": "RECEPCIÓN DE MERCANCÍA - COLOMBINA", "amount": 212932, "nequiAmount": 212932, "paymentSource": "NEQUI: $212932", "status": "PAID", "category": "Proveedores"},
		{"id": 1249, "description": "RECEPCIÓN DE MERCANCÍA - GRUPO TREBOL", "amount": 162575, "nequiAmount": 162575, "paymentSource": "NEQUI: $162575", "status": "PAID", "category": "Proveedores"},

		// FONDO ($473.854)
		{"id": 1248, "description": "RECEPCIÓN DE MERCANCÍA - RAMO", "amount": 140000, "fondoAmount": 140000, "paymentSource": "FONDO: $140000", "status": "PAID", "category": "Proveedores"},
		{"id": 1247, "description": "RECEPCIÓN DE MERCANCÍA - PLAZA", "amount": 189600, "fondoAmount": 189600, "paymentSource": "FONDO: $189600", "status": "PAID", "category": "Proveedores"},
		{"id": 1246, "description": "RECEPCIÓN DE MERCANCÍA - GELANOVA", "amount": 144254, "fondoAmount": 144254, "paymentSource": "FONDO: $144254", "status": "PAID", "category": "Proveedores"},
	}

	totalCash := 0.0
	for _, e := range expensesSnapshot {
		if c, ok := e["cashAmount"].(int); ok {
			totalCash += float64(c)
		}
	}
	fmt.Printf("Snapshot for Closure 96 ready. Total Cash Egresos = %.2f\n", totalCash)

	b, _ := json.Marshal(expensesSnapshot)
	jsonStr := string(b)

	err = db.Exec(`UPDATE cashier_closures SET expenses_detail = ? WHERE id = 96`, jsonStr).Error
	if err != nil {
		log.Fatalf("Error updating cashier_closures for ID 96: %v", err)
	}
	fmt.Println("✅ ONLY cashier_closures ID 96 snapshot updated. No live DB tables touched!")
}

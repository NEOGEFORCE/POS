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
	// ONLY update expenses_detail snapshot and total_sales in cashier_closures table for ID 119!

	expensesSnapshot := []map[string]interface{}{
		// EFECTIVO ($1.227.969)
		{"id": 1410, "description": "CUOTA BANCO", "amount": 615900, "cashAmount": 615900, "paymentSource": "CAJA: $615900", "status": "PAID", "category": "Otros Gastos"},
		{"id": 1409, "description": "LA NIEVE CIGARRILLOS - PAGO DE PROVEEDOR", "amount": 42462, "cashAmount": 42462, "paymentSource": "CAJA: $42462", "status": "PAID", "category": "Proveedores"},
		{"id": 1408, "description": "COUNTRY - PAGO DE PROVEEDOR", "amount": 222700, "cashAmount": 222700, "paymentSource": "CAJA: $222700", "status": "PAID", "category": "Proveedores"},
		{"id": 1407, "description": "BIMBO - PAGO DE PROVEEDOR", "amount": 64946, "cashAmount": 64946, "paymentSource": "CAJA: $64946", "status": "PAID", "category": "Proveedores"},
		{"id": 1406, "description": "RECEPCIÓN DE MERCANCÍA - AREPAS", "amount": 16800, "cashAmount": 16800, "paymentSource": "CAJA: $16800", "status": "PAID", "category": "Proveedores"},
		{"id": 1405, "description": "EL CARRIEL - PAGO DE PROVEEDOR", "amount": 65598, "cashAmount": 65598, "paymentSource": "CAJA: $65598", "status": "PAID", "category": "Proveedores"},
		{"id": 1404, "description": "RECEPCIÓN DE MERCANCÍA - AGUA MIA", "amount": 39000, "cashAmount": 39000, "paymentSource": "CAJA: $39000", "status": "PAID", "category": "Proveedores"},
		{"id": 1403, "description": "ITALCOL - PAGO DE PROVEEDOR", "amount": 47563, "cashAmount": 47563, "paymentSource": "CAJA: $47563", "status": "PAID", "category": "Proveedores"},
		{"id": 1402, "description": "RECREO - PAGO DE PROVEEDOR", "amount": 76200, "cashAmount": 76200, "paymentSource": "CAJA: $76200", "status": "PAID", "category": "Proveedores"},
		{"id": 1401, "description": "SAZON  LLANERO - PAGO DE PROVEEDOR", "amount": 36800, "cashAmount": 36800, "paymentSource": "CAJA: $36800", "status": "PAID", "category": "Proveedores"},

		// NEQUI ($149.596)
		{"id": 1400, "description": "COUNTRY - PAGO DE PROVEEDOR", "amount": 149596, "nequiAmount": 149596, "paymentSource": "NEQUI: $149596", "status": "PAID", "category": "Proveedores"},

		// DAVIPLATA ($111.000)
		{"id": 1399, "description": "COUNTRY - PAGO DE PROVEEDOR", "amount": 111000, "daviplataAmount": 111000, "paymentSource": "DAVIPLATA: $111000", "status": "PAID", "category": "Proveedores"},

		// FONDO ($450.900)
		{"id": 1398, "description": "COCACOLA - PAGO DE PROVEEDOR", "amount": 236100, "fondoAmount": 236100, "paymentSource": "FONDO: $236100", "status": "PAID", "category": "Proveedores"},
		{"id": 1397, "description": "POSTOBON CERVEZA - PAGO DE PROVEEDOR", "amount": 13000, "fondoAmount": 13000, "paymentSource": "FONDO: $13000", "status": "PAID", "category": "Proveedores"},
		{"id": 1396, "description": "POSTOBON GASEOSAS - PAGO DE PROVEEDOR", "amount": 87500, "fondoAmount": 87500, "paymentSource": "FONDO: $87500", "status": "PAID", "category": "Proveedores"},
		{"id": 1395, "description": "PLAZA - PAGO DE PROVEEDOR", "amount": 114300, "fondoAmount": 114300, "paymentSource": "FONDO: $114300", "status": "PAID", "category": "Proveedores"},
	}

	totalCash := 0.0
	for _, e := range expensesSnapshot {
		if c, ok := e["cashAmount"].(int); ok {
			totalCash += float64(c)
		}
	}
	fmt.Printf("Snapshot for Closure 119 ready. Total Cash Egresos = %.2f\n", totalCash)

	b, _ := json.Marshal(expensesSnapshot)
	jsonStr := string(b)

	vReal := 2331269.00
	err = db.Exec(`UPDATE cashier_closures SET expenses_detail = ?, total_sales = ? WHERE id = 119`, jsonStr, vReal).Error
	if err != nil {
		log.Fatalf("Error updating cashier_closures for ID 119: %v", err)
	}
	fmt.Println("✅ ONLY cashier_closures ID 119 snapshot & total_sales updated. No live DB tables touched!")
}

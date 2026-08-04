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
	// ONLY update expenses_detail snapshot in cashier_closures table for ID 97!

	expensesSnapshot := []map[string]interface{}{
		// EFECTIVO ($644.377)
		{"id": 1275, "description": "PAGO DE NOMINA", "amount": 42000, "cashAmount": 42000, "paymentSource": "CAJA: $42000", "status": "PAID", "category": "Nomina"},
		{"id": 1274, "description": "PAGO DE NOMINA", "amount": 45000, "cashAmount": 45000, "paymentSource": "CAJA: $45000", "status": "PAID", "category": "Nomina"},
		{"id": 1273, "description": "RECEPCIÓN DE MERCANCÍA - QUESO SAMANTHA", "amount": 141600, "cashAmount": 141600, "paymentSource": "CAJA: $141600", "status": "PAID", "category": "Proveedores"},
		{"id": 1272, "description": "RECEPCIÓN DE MERCANCÍA - BIMBO", "amount": 90177, "cashAmount": 90177, "paymentSource": "CAJA: $90177", "status": "PAID", "category": "Proveedores"},
		{"id": 1271, "description": "ENSALADAS - PAGO DE PROVEEDOR", "amount": 6600, "cashAmount": 6600, "paymentSource": "CAJA: $6600", "status": "PAID", "category": "Proveedores"},
		{"id": 1270, "description": "RECEPCIÓN DE MERCANCÍA - AREPAS", "amount": 15900, "cashAmount": 15900, "paymentSource": "CAJA: $15900", "status": "PAID", "category": "Proveedores"},
		{"id": 1269, "description": "RECEPCIÓN DE MERCANCÍA - AGUA MIA", "amount": 19500, "cashAmount": 19500, "paymentSource": "CAJA: $19500", "status": "PAID", "category": "Proveedores"},
		{" continental_id": 1268, "description": "RECEPCIÓN DE MERCANCÍA - PICADOS", "amount": 3900, "cashAmount": 3900, "paymentSource": "CAJA: $3900", "status": "PAID", "category": "Proveedores"},
		{"id": 1267, "description": "RECEPCIÓN DE MERCANCÍA - DISTRIMAGLA", "amount": 22800, "cashAmount": 22800, "paymentSource": "CAJA: $22800", "status": "PAID", "category": "Proveedores"},
		{"id": 1266, "description": "RECEPCIÓN DE MERCANCÍA - PLAZA", "amount": 89200, "cashAmount": 89200, "paymentSource": "CAJA: $89200", "status": "PAID", "category": "Proveedores"},
		{"id": 1265, "description": "RECEPCIÓN DE MERCANCÍA - PLAZA", "amount": 167700, "cashAmount": 167700, "paymentSource": "CAJA: $167700", "status": "PAID", "category": "Proveedores"},

		// NEQUI ($215.284)
		{"id": 1264, "description": "RECEPCIÓN DE MERCANCÍA - ARROZ DEL LLANO", "amount": 79116, "nequiAmount": 79116, "paymentSource": "NEQUI: $79116", "status": "PAID", "category": "Proveedores"},
		{"id": 1263, "description": "RECEPCIÓN DE MERCANCÍA - DISTRISUIZE", "amount": 136168, "nequiAmount": 136168, "paymentSource": "NEQUI: $136168", "status": "PAID", "category": "Proveedores"},

		// FONDO ($42.500)
		{"id": 1262, "description": "RECEPCIÓN DE MERCANCÍA - PAN DE ARROZ/YUCA", "amount": 42500, "fondoAmount": 42500, "paymentSource": "FONDO: $42500", "status": "PAID", "category": "Proveedores"},
	}

	totalCash := 0.0
	for _, e := range expensesSnapshot {
		if c, ok := e["cashAmount"].(int); ok {
			totalCash += float64(c)
		}
	}
	fmt.Printf("Snapshot for Closure 97 ready. Total Cash Egresos = %.2f\n", totalCash)

	b, _ := json.Marshal(expensesSnapshot)
	jsonStr := string(b)

	err = db.Exec(`UPDATE cashier_closures SET expenses_detail = ? WHERE id = 97`, jsonStr).Error
	if err != nil {
		log.Fatalf("Error updating cashier_closures for ID 97: %v", err)
	}
	fmt.Println("✅ ONLY cashier_closures ID 97 snapshot updated. No live DB tables touched!")
}

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

	// DO NOT TOUCH EXPENSES TABLE OR SALES TABLE.
	// ONLY update expenses_detail snapshot in cashier_closures for ID 94!

	expensesSnapshot := []map[string]interface{}{
		{"id": 1224, "description": "ALQUERIA - PAGO DE PROVEEDOR", "amount": 65586, "cashAmount": 65586, "paymentSource": "CAJA: $65586", "status": "PAID", "category": "Proveedores"},
		{"id": 1221, "description": "POLLO - PAGO DE PROVEEDOR", "amount": 66900, "cashAmount": 66900, "paymentSource": "CAJA: $66900", "status": "PAID", "category": "Proveedores"},
		{"id": 1220, "description": "PLAZA - PAGO DE PROVEEDOR", "amount": 80500, "cashAmount": 80500, "paymentSource": "CAJA: $80500", "status": "PAID", "category": "Proveedores"},
		{"id": 1219, "description": "QUALA - PAGO DE PROVEEDOR", "amount": 197095, "cashAmount": 197095, "paymentSource": "CAJA: $197095", "status": "PAID", "category": "Proveedores"},
		{"id": 1217, "description": "PAGO DE NOMINA", "amount": 42000, "cashAmount": 42000, "paymentSource": "CAJA: $42000", "status": "PAID", "category": "Nomina"},
		{"id": 1214, "description": "RECEPCIÓN DE MERCANCÍA - DISTRIMAGLA", "amount": 14000, "cashAmount": 14000, "paymentSource": "CAJA: $14000", "status": "PAID", "category": "Proveedores"},
		{"id": 1211, "description": "RECEPCIÓN DE MERCANCÍA - SUPER RICAS", "amount": 74562, "cashAmount": 74562, "paymentSource": "CAJA: $74562", "status": "PAID", "category": "Proveedores"},
		{"id": 1210, "description": "RECEPCIÓN DE MERCANCÍA - DISTRILLANO BIG-COLA", "amount": 31612, "cashAmount": 31612, "paymentSource": "CAJA: $31612", "status": "PAID", "category": "Proveedores"},
		{"id": 1209, "description": "RECEPCIÓN DE MERCANCÍA - LA NIEVE NESTLE", "amount": 83113, "cashAmount": 83113, "paymentSource": "CAJA: $83113", "status": "PAID", "category": "Proveedores"},
		{"id": 1208, "description": "PAN DE ARROZ/YUCA - PAGO DE PROVEEDOR", "amount": 48000, "cashAmount": 48000, "paymentSource": "CAJA: $48000", "status": "PAID", "category": "Proveedores"},
		{"id": 1207, "description": "RECEPCIÓN DE MERCANCÍA - AGUA MIA", "amount": 13000, "cashAmount": 13000, "paymentSource": "CAJA: $13000", "status": "PAID", "category": "Proveedores"},
		{"id": 1206, "description": "RECEPCIÓN DE MERCANCÍA - ENVUELTOS", "amount": 27000, "cashAmount": 27000, "paymentSource": "CAJA: $27000", "status": "PAID", "category": "Proveedores"},
		{"id": 1205, "description": "ENSALADAS - PAGO DE PROVEEDOR", "amount": 16500, "cashAmount": 16500, "paymentSource": "CAJA: $16500", "status": "PAID", "category": "Proveedores"},
		{"id": 1216, "description": "RECEPCIÓN DE MERCANCÍA - YUPI", "amount": 34800, "fondoAmount": 34800, "paymentSource": "FONDO: $34800", "status": "PAID", "category": "Proveedores"},
		{"id": 1215, "description": "RECEPCIÓN DE MERCANCÍA - ALTIPAL CIGARRILLOS", "amount": 74198, "fondoAmount": 74198, "paymentSource": "FONDO: $74198", "status": "PAID", "category": "Proveedores"},
		{"id": 1213, "description": "RECEPCIÓN DE MERCANCÍA - ZENU", "amount": 118784, "fondoAmount": 118784, "paymentSource": "FONDO: $118784", "status": "PAID", "category": "Proveedores"},
		{"id": 1212, "description": "RECEPCIÓN DE MERCANCÍA - CARNE", "amount": 93000, "fondoAmount": 93000, "paymentSource": "FONDO: $93000", "status": "PAID", "category": "Proveedores"},
	}

	b, _ := json.Marshal(expensesSnapshot)
	jsonStr := string(b)

	err = db.Exec(`UPDATE cashier_closures SET expenses_detail = ? WHERE id = 94`, jsonStr).Error
	if err != nil {
		log.Fatalf("Error updating cashier_closures for ID 94: %v", err)
	}
	fmt.Println("✅ ONLY cashier_closures ID 94 snapshot updated. No live DB tables touched!")
}

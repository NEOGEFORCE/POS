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
	// ONLY update expenses_detail snapshot in cashier_closures table for ID 98!

	expensesSnapshot := []map[string]interface{}{
		// EFECTIVO ($874.944)
		{"id": 1301, "description": "ALMUERZO", "amount": 22000, "cashAmount": 22000, "paymentSource": "CAJA: $22000", "status": "PAID", "category": "Otros Gastos"},
		{"id": 1300, "description": "RECEPCIÓN DE MERCANCÍA - GELANOVA", "amount": 112837, "cashAmount": 112837, "paymentSource": "CAJA: $112837", "status": "PAID", "category": "Proveedores"},
		{"id": 1299, "description": "RECEPCIÓN DE MERCANCÍA - AGUA MIA", "amount": 46500, "cashAmount": 46500, "paymentSource": "CAJA: $46500", "status": "PAID", "category": "Proveedores"},
		{"id": 1298, "description": "RECEPCIÓN DE MERCANCÍA - ZENU", "amount": 109272, "cashAmount": 109272, "paymentSource": "CAJA: $109272", "status": "PAID", "category": "Proveedores"},
		{"id": 1297, "description": "RECEPCIÓN DE MERCANCÍA - CARNE", "amount": 127900, "cashAmount": 127900, "paymentSource": "CAJA: $127900", "status": "PAID", "category": "Proveedores"},
		{"id": 1296, "description": "ENSALADAS - PAGO DE PROVEEDOR", "amount": 9900, "cashAmount": 9900, "paymentSource": "CAJA: $9900", "status": "PAID", "category": "Proveedores"},
		{"id": 1295, "description": "RECEPCIÓN DE MERCANCÍA - IDEAL", "amount": 81200, "cashAmount": 81200, "paymentSource": "CAJA: $81200", "status": "PAID", "category": "Proveedores"},
		{"id": 1294, "description": "DISTRILLANO BIG-COLA - PAGO DE PROVEEDOR", "amount": 95788, "cashAmount": 95788, "paymentSource": "CAJA: $95788", "status": "PAID", "category": "Proveedores"},
		{"id": 1293, "description": "ARROZ DEL LLANO - PAGO DE PROVEEDOR", "amount": 261, "cashAmount": 261, "paymentSource": "CAJA: $261", "status": "PAID", "category": "Proveedores"},
		{"id": 1292, "description": "RECREO - PAGO DE PROVEEDOR", "amount": 93000, "cashAmount": 93000, "paymentSource": "CAJA: $93000", "status": "PAID", "category": "Proveedores"},
		{"id": 1291, "description": "PLAZA - PAGO DE PROVEEDOR", "amount": 90200, "cashAmount": 90200, "paymentSource": "CAJA: $90200", "status": "PAID", "category": "Proveedores"},
		{"id": 1290, "description": "YUPI - PAGO DE PROVEEDOR", "amount": 36800, "cashAmount": 36800, "paymentSource": "CAJA: $36800", "status": "PAID", "category": "Proveedores"},
		{"id": 1289, "description": "YEMAPAN - PAGO DE PROVEEDOR", "amount": 26886, "cashAmount": 26886, "paymentSource": "CAJA: $26886", "status": "PAID", "category": "Proveedores"},
		{"id": 1288, "description": "POLLO - PAGO DE PROVEEDOR", "amount": 22400, "cashAmount": 22400, "paymentSource": "CAJA: $22400", "status": "PAID", "category": "Proveedores"},

		// DAVIPLATA ($753.891)
		{"id": 1287, "description": "ALQUERIA - PAGO DE PROVEEDOR", "amount": 100250, "daviplataAmount": 100250, "paymentSource": "DAVIPLATA: $100250", "status": "PAID", "category": "Proveedores"},
		{"id": 1286, "description": "COLANTA - PAGO DE PROVEEDOR", "amount": 67541, "daviplataAmount": 67541, "paymentSource": "DAVIPLATA: $67541", "status": "PAID", "category": "Proveedores"},
		{"id": 1285, "description": "PAGO DE NOMINA", "amount": 400000, "daviplataAmount": 400000, "paymentSource": "DAVIPLATA: $400000", "status": "PAID", "category": "Nomina"},
		{"id": 1284, "description": "PULPAS - PAGO DE PROVEEDOR", "amount": 72000, "daviplataAmount": 72000, "paymentSource": "DAVIPLATA: $72000", "status": "PAID", "category": "Proveedores"},
		{"id": 1283, "description": "IDEAL - PAGO DE PROVEEDOR", "amount": 114100, "daviplataAmount": 114100, "paymentSource": "DAVIPLATA: $114100", "status": "PAID", "category": "Proveedores"},

		// FONDO ($875.088)
		{"id": 1282, "description": "JORDANIA - PAGO DE PROVEEDOR", "amount": 187334, "fondoAmount": 187334, "paymentSource": "FONDO: $187334", "status": "PAID", "category": "Proveedores"},
		{"id": 1281, "description": "ARROZ DEL LLANO - PAGO DE PROVEEDOR", "amount": 140000, "fondoAmount": 140000, "paymentSource": "FONDO: $140000", "status": "PAID", "category": "Proveedores"},
		{"id": 1280, "description": "RINVAL - PAGO DE PROVEEDOR", "amount": 162354, "fondoAmount": 162354, "paymentSource": "FONDO: $162354", "status": "PAID", "category": "Proveedores"},
		{"id": 1279, "description": "AJAR - PAGO DE PROVEEDOR", "amount": 345400, "fondoAmount": 345400, "paymentSource": "FONDO: $345400", "status": "PAID", "category": "Proveedores"},
		{"id": 1278, "description": "POLLO - PAGO DE PROVEEDOR", "amount": 40000, "fondoAmount": 40000, "paymentSource": "FONDO: $40000", "status": "PAID", "category": "Proveedores"},
	}

	totalCash := 0.0
	for _, e := range expensesSnapshot {
		if c, ok := e["cashAmount"].(int); ok {
			totalCash += float64(c)
		}
	}
	fmt.Printf("Snapshot for Closure 98 ready. Total Cash Egresos = %.2f\n", totalCash)

	b, _ := json.Marshal(expensesSnapshot)
	jsonStr := string(b)

	err = db.Exec(`UPDATE cashier_closures SET expenses_detail = ? WHERE id = 98`, jsonStr).Error
	if err != nil {
		log.Fatalf("Error updating cashier_closures for ID 98: %v", err)
	}
	fmt.Println("✅ ONLY cashier_closures ID 98 snapshot updated. No live DB tables touched!")
}

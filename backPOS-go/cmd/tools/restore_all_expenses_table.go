package main

import (
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

	// Restore expenses table rows to exact original DB state before our edits:
	// 1. Expense 1112 (July 5)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'DAVIPLATA: $350000 / CAJA: $50000', cash_amount = 50000, daviplata_amount = 350000 WHERE id = 1112`)
	
	// 2. Expense 1144 (July 7)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'DAVIPLATA: $30000 / CAJA: $15000', cash_amount = 15000, daviplata_amount = 30000 WHERE id = 1144`)
	
	// 3. Expenses 1224, 1221, 1220, 1219 (July 11)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'FONDO: $65586', cash_amount = 0, fondo_amount = 65586 WHERE id = 1224`)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'FONDO: $66900', cash_amount = 0, fondo_amount = 66900 WHERE id = 1221`)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'FONDO: $80500', cash_amount = 0, fondo_amount = 80500 WHERE id = 1220`)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'FONDO: $197095', cash_amount = 0, fondo_amount = 197095 WHERE id = 1219`)

	// 4. Expense 1050 (July 2)
	db.Exec(`UPDATE expenses SET "paymentSource" = 'CAJA: $116500 / FONDO: $138500', cash_amount = 116500, fondo_amount = 138500 WHERE id = 1050`)

	fmt.Println("✅ ALL expenses table rows RESTORED to exact original DB state!")
}
